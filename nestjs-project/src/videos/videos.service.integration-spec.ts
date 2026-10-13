import { Test } from '@nestjs/testing';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsModule } from '../channels/channels.module';
import { User } from '../users/entities/user.entity';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';
import * as slugUtil from './slug.util';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
  VideoStatus,
} from './videos.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * Exercita banco, storage e fila reais do Compose. A retentativa de colisão de
 * slug só pode ser provada aqui: ela depende do comportamento do PostgreSQL de
 * abortar a transação inteira em violação de constraint.
 */
describe('VideosService (integration)', () => {
  let videosService: VideosService;
  let storageService: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let channel: Channel;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, queueConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, User, Channel]),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            connection: { host: cfg.host, port: cfg.port },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
        ChannelsModule,
        StorageModule,
      ],
      providers: [VideosService],
    }).compile();

    videosService = module.get(VideosService);
    storageService = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    await storageService.ensureBucket();
  }, 60000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain();

    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const user = await userRepo.save(
      userRepo.create({
        email: `vs_${Date.now()}@example.com`,
        password: 'hash',
      }),
    );
    channel = await channelRepo.save(
      channelRepo.create({
        name: 'vschannel',
        nickname: `vs${Date.now()}`,
        user_id: user.id,
      }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createDraft', () => {
    it('persists a draft with a unique slug', async () => {
      const video = await videosService.createDraft(channel.id, 'First video');

      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.slug).toHaveLength(12);

      const found = await videoRepository.findOneByOrFail({ id: video.id });
      expect(found.channel_id).toBe(channel.id);
    });

    it('retries with a new slug when the generated one collides', async () => {
      const taken = await videosService.createDraft(channel.id, 'Taken');

      // Primeira tentativa devolve um slug já usado: a violação de unicidade
      // aborta a transação no PostgreSQL, e só o SAVEPOINT permite seguir.
      const spy = jest
        .spyOn(slugUtil, 'generateVideoSlug')
        .mockReturnValueOnce(taken.slug);

      const video = await videosService.createDraft(channel.id, 'Colliding');

      expect(spy).toHaveBeenCalledTimes(2);
      expect(video.slug).not.toBe(taken.slug);

      const persisted = await videoRepository.findOneByOrFail({ id: video.id });
      expect(persisted.title).toBe('Colliding');
    });

    it('creates many videos without repeating a slug', async () => {
      const slugs = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const v = await videosService.createDraft(channel.id, `Video ${i}`);
        slugs.add(v.slug);
      }
      expect(slugs.size).toBe(10);
    });
  });

  describe('initiateUpload', () => {
    it('creates the draft before any byte is uploaded and opens a multipart', async () => {
      const result = await videosService.initiateUpload(channel.id, {
        title: 'Holiday',
        filename: 'holiday.mp4',
        size_bytes: 10 * 1024 * 1024,
        content_type: 'video/mp4',
      });

      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.parts.length).toBeGreaterThanOrEqual(1);
      expect(result.parts[0].url).toContain('http');

      // O rascunho já está no banco antes de qualquer envio de arquivo.
      const persisted = await videoRepository.findOneByOrFail({
        id: result.id,
      });
      expect(persisted.status).toBe(VideoStatus.DRAFT);
      expect(persisted.upload_id).toBe(result.upload_id);
      expect(persisted.storage_key).toBe(`videos/${result.id}/source.mp4`);
    }, 60000);
  });

  describe('completeUpload', () => {
    async function uploadAllParts(
      parts: { part_number: number; url: string }[],
      body: Buffer,
    ) {
      const completed: { part_number: number; etag: string }[] = [];
      for (const part of parts) {
        const res = await fetch(part.url, {
          method: 'PUT',
          body: body as never,
        });
        completed.push({
          part_number: part.part_number,
          etag: String(res.headers.get('etag')),
        });
      }
      return completed;
    }

    it('moves the video to processing and publishes the job', async () => {
      const started = await videosService.initiateUpload(channel.id, {
        title: 'To process',
        filename: 'clip.mp4',
        size_bytes: 1024,
        content_type: 'video/mp4',
      });

      const parts = await uploadAllParts(
        started.parts,
        Buffer.from('fake video bytes'),
      );
      const result = await videosService.completeUpload(
        channel.id,
        started.id,
        parts,
      );

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(result.upload_id).toBeNull();

      // Busca em todos os estados, não só 'waiting': se um worker real estiver
      // rodando contra o mesmo Redis, ele consome o job imediatamente e um
      // assert sobre 'waiting' viraria corrida. O que importa é que o job foi
      // publicado, não em que estado ele está neste instante.
      const jobs = await queue.getJobs([
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      ]);
      const published = jobs.filter(
        (j) => (j.data as { videoId: string }).videoId === started.id,
      );
      expect(published).toHaveLength(1);
      expect(published[0].name).toBe(VIDEO_PROCESS_JOB);
    }, 60000);

    it('leaves the file retrievable from storage after completion', async () => {
      const started = await videosService.initiateUpload(channel.id, {
        title: 'Retrievable',
        filename: 'clip.mp4',
        size_bytes: 1024,
        content_type: 'video/mp4',
      });

      const payload = Buffer.from('retrievable content');
      const parts = await uploadAllParts(started.parts, payload);
      await videosService.completeUpload(channel.id, started.id, parts);

      const persisted = await videoRepository.findOneByOrFail({
        id: started.id,
      });
      const head = await storageService.headObject(persisted.storage_key!);
      expect(head.exists).toBe(true);
      expect(head.sizeBytes).toBe(payload.length);
    }, 60000);
  });
});
