import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Job } from 'bullmq';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { buildVideoKey } from '../storage/storage.util';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';
import type { VideoProcessJobData } from './video-processing.processor';
import { VideoStatus } from './videos.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FIXTURE = path.join(
  __dirname,
  '..',
  'test',
  'fixtures',
  'sample-video.mp4',
);

/**
 * Exercita o worker contra storage e banco reais do Compose, com FFmpeg de
 * verdade sobre uma fixture de vídeo real. Nada aqui é mockado — o valor do
 * teste está justamente nas bordas (ffprobe lendo via URL, thumbnail gravado
 * no bucket) que um mock reproduziria por construção.
 */
describe('VideoProcessingProcessor (integration)', () => {
  let processor: VideoProcessingProcessor;
  let storageService: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, User, Channel]),
        StorageModule,
      ],
      providers: [VideoProcessingProcessor],
    }).compile();

    processor = module.get(VideoProcessingProcessor);
    storageService = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = module.get<Repository<Video>>(getRepositoryToken(Video));

    await storageService.ensureBucket();
  }, 60000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const user = await userRepo.save(
      userRepo.create({
        email: `worker_${Date.now()}@example.com`,
        password: 'h',
      }),
    );
    channel = await channelRepo.save(
      channelRepo.create({
        name: 'workerchannel',
        nickname: `worker${Date.now()}`,
        user_id: user.id,
      }),
    );
  });

  function makeJob(
    videoId: string,
    attemptsMade = 0,
  ): Job<VideoProcessJobData> {
    return {
      data: { videoId },
      attemptsMade,
      opts: { attempts: 3 },
    } as Job<VideoProcessJobData>;
  }

  async function seedVideoWithFile(content: Buffer, filename: string) {
    const video = await videoRepository.save(
      videoRepository.create({
        slug: `wk${Date.now().toString(36)}`.slice(0, 12),
        title: 'Worker video',
        channel_id: channel.id,
        status: VideoStatus.PROCESSING,
      }),
    );
    const key = buildVideoKey(video.id, filename);
    await storageService.putObject(key, content, 'video/mp4');
    await videoRepository.update({ id: video.id }, { storage_key: key });
    return video;
  }

  it('processes a real video to ready with duration, metadata and thumbnail', async () => {
    const fixture = await fs.readFile(FIXTURE);
    const video = await seedVideoWithFile(fixture, 'sample-video.mp4');

    await processor.process(makeJob(video.id));

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).toBe(3);
    expect(processed.metadata).toMatchObject({
      codec: 'h264',
      width: 320,
      height: 240,
    });
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);

    const thumb = await storageService.headObject(processed.thumbnail_key!);
    expect(thumb.exists).toBe(true);
    expect(thumb.sizeBytes).toBeGreaterThan(0);
  }, 120000);

  it('marks the video failed with a reason once attempts are exhausted', async () => {
    const video = await seedVideoWithFile(
      Buffer.from('this is not a video'),
      'broken.mp4',
    );

    // Última tentativa: attemptsMade === attempts significa que não há retry
    // pela frente, então o handler deve marcar a falha como definitiva.
    await processor.onFailed(
      makeJob(video.id, 3),
      new Error('Invalid data found when processing input'),
    );

    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.failure_reason).toContain('Invalid data');
  });

  it('does not mark the video failed while retries remain', async () => {
    const video = await seedVideoWithFile(Buffer.from('broken'), 'broken.mp4');

    await processor.onFailed(makeJob(video.id, 1), new Error('transient'));

    const stillProcessing = await videoRepository.findOneByOrFail({
      id: video.id,
    });
    expect(stillProcessing.status).toBe(VideoStatus.PROCESSING);
    expect(stillProcessing.failure_reason).toBeNull();
  });

  it('rejects a corrupted file so the queue can retry it', async () => {
    const video = await seedVideoWithFile(
      Buffer.from('definitely not a video'),
      'corrupt.mp4',
    );

    await expect(processor.process(makeJob(video.id))).rejects.toThrow();

    // O vídeo continua em processing: marcar falha é responsabilidade do
    // handler de falha definitiva, não do process().
    const video2 = await videoRepository.findOneByOrFail({ id: video.id });
    expect(video2.status).toBe(VideoStatus.PROCESSING);
  }, 120000);

  it('skips silently when the video no longer exists', async () => {
    await expect(
      processor.process(makeJob('00000000-0000-0000-0000-000000000000')),
    ).resolves.toBeUndefined();
  });
});
