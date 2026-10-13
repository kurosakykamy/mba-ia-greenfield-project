import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { buildVideoKey } from '../src/storage/storage.util';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoProcessingProcessor } from '../src/videos/video-processing.processor';
import {
  MAX_VIDEO_SIZE_BYTES,
  VIDEO_PROCESSING_QUEUE,
  VideoStatus,
} from '../src/videos/videos.constants';
import type { MailService } from '../src/mail/mail.service';

interface VideoResponseBody {
  id?: string;
  slug?: string;
  status?: string;
  upload_id?: string;
  parts?: { part_number: number; url: string }[];
  title?: string;
  duration_seconds?: number | null;
  metadata?: Record<string, unknown> | null;
  thumbnail_url?: string | null;
  error?: string;
}

const FIXTURE = path.join(
  __dirname,
  '..',
  'src',
  'test',
  'fixtures',
  'sample-video.mp4',
);

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let queue: Queue;
  let processor: VideoProcessingProcessor;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storageService = moduleFixture.get(StorageService);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    // O processor vive no WorkerModule (container separado), não no AppModule.
    // Aqui ele é construído com as dependências já resolvidas pelo app, para
    // que o e2e possa levar um vídeo até `ready` e exercitar a entrega.
    processor = new VideoProcessingProcessor(videoRepository, storageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    await storageService.ensureBucket();
  }, 120000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain();
    throttlerStorage.storage.clear();
  });

  /** Registra, confirma e autentica um usuário; devolve o access token. */
  let userCounter = 0;
  async function createAuthenticatedUser(): Promise<string> {
    userCounter++;
    const email = `video_e2e_${Date.now()}_${userCounter}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailService = (authService as unknown as { mailService: MailService })
      .mailService;

    let confirmToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        confirmToken = t;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmToken });

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return (login.body as { access_token: string }).access_token;
  }

  function initiateUpload(
    token: string,
    overrides: Record<string, unknown> = {},
  ) {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'My holiday',
        filename: 'holiday.mp4',
        size_bytes: 1024,
        content_type: 'video/mp4',
        ...overrides,
      });
  }

  async function uploadParts(
    parts: { part_number: number; url: string }[],
    body: Buffer,
  ) {
    const completed: { part_number: number; etag: string }[] = [];
    for (const part of parts) {
      const res = await fetch(part.url, { method: 'PUT', body: body as never });
      completed.push({
        part_number: part.part_number,
        etag: String(res.headers.get('etag')),
      });
    }
    return completed;
  }

  describe('POST /videos', () => {
    it('returns 201 with the draft and one presigned URL per part', async () => {
      const token = await createAuthenticatedUser();

      const res = await initiateUpload(token).expect(201);
      const body = res.body as VideoResponseBody;

      expect(body.id).toBeDefined();
      expect(body.slug).toHaveLength(12);
      expect(body.status).toBe(VideoStatus.DRAFT);
      expect(body.upload_id).toBeDefined();
      expect(body.parts).toHaveLength(1);
      expect(body.parts![0].part_number).toBe(1);
    }, 60000);

    it('persists the video as a draft before the file is uploaded', async () => {
      const token = await createAuthenticatedUser();
      const res = await initiateUpload(token).expect(201);

      const persisted = await videoRepository.findOneByOrFail({
        id: (res.body as VideoResponseBody).id!,
      });
      expect(persisted.status).toBe(VideoStatus.DRAFT);
    }, 60000);

    it('returns 400 VIDEO_FILE_TOO_LARGE above the 10 GiB limit', async () => {
      const token = await createAuthenticatedUser();

      const res = await initiateUpload(token, {
        size_bytes: MAX_VIDEO_SIZE_BYTES + 1,
      }).expect(400);

      expect((res.body as VideoResponseBody).error).toBeDefined();
    }, 60000);

    it('returns 400 on a non-video content type', async () => {
      const token = await createAuthenticatedUser();
      await initiateUpload(token, { content_type: 'image/png' }).expect(400);
    }, 60000);

    it('returns 401 without a token and creates no video', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          title: 'Anon',
          filename: 'a.mp4',
          size_bytes: 10,
          content_type: 'video/mp4',
        })
        .expect(401);

      expect(await videoRepository.count()).toBe(0);
    });
  });

  describe('POST /videos/:id/complete', () => {
    it('returns 201 with processing status and enqueues the job', async () => {
      const token = await createAuthenticatedUser();
      const started = (await initiateUpload(token)).body as VideoResponseBody;

      const parts = await uploadParts(started.parts!, Buffer.from('bytes'));

      const res = await request(app.getHttpServer())
        .post(`/videos/${started.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(201);

      expect((res.body as VideoResponseBody).status).toBe(
        VideoStatus.PROCESSING,
      );

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
    }, 60000);

    it('returns 403 VIDEO_NOT_OWNED for another user video', async () => {
      const owner = await createAuthenticatedUser();
      const intruder = await createAuthenticatedUser();
      const started = (await initiateUpload(owner)).body as VideoResponseBody;
      const parts = await uploadParts(started.parts!, Buffer.from('bytes'));

      const res = await request(app.getHttpServer())
        .post(`/videos/${started.id}/complete`)
        .set('Authorization', `Bearer ${intruder}`)
        .send({ parts })
        .expect(403);

      expect((res.body as VideoResponseBody).error).toBe('VIDEO_NOT_OWNED');

      const untouched = await videoRepository.findOneByOrFail({
        id: started.id!,
      });
      expect(untouched.status).toBe(VideoStatus.DRAFT);
    }, 60000);

    it('returns 409 VIDEO_INVALID_STATE when the video is not a draft', async () => {
      const token = await createAuthenticatedUser();
      const started = (await initiateUpload(token)).body as VideoResponseBody;
      const parts = await uploadParts(started.parts!, Buffer.from('bytes'));

      await request(app.getHttpServer())
        .post(`/videos/${started.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/videos/${started.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(409);

      expect((res.body as VideoResponseBody).error).toBe('VIDEO_INVALID_STATE');
    }, 60000);

    it('returns 422 VIDEO_UPLOAD_INCOMPLETE when no part was uploaded', async () => {
      const token = await createAuthenticatedUser();
      const started = (await initiateUpload(token)).body as VideoResponseBody;

      const res = await request(app.getHttpServer())
        .post(`/videos/${started.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag: '"deadbeef"' }] })
        .expect(422);

      expect((res.body as VideoResponseBody).error).toBe(
        'VIDEO_UPLOAD_INCOMPLETE',
      );

      const stillDraft = await videoRepository.findOneByOrFail({
        id: started.id!,
      });
      expect(stillDraft.status).toBe(VideoStatus.DRAFT);
      expect(await queue.getJobs(['waiting'])).toHaveLength(0);
    }, 60000);

    it('returns 400 on an invalid parts payload', async () => {
      const token = await createAuthenticatedUser();
      const started = (await initiateUpload(token)).body as VideoResponseBody;

      await request(app.getHttpServer())
        .post(`/videos/${started.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 0, etag: '' }] })
        .expect(400);
    }, 60000);
  });

  describe('GET /videos/:slug', () => {
    it('returns the video metadata', async () => {
      const token = await createAuthenticatedUser();
      const started = (await initiateUpload(token)).body as VideoResponseBody;

      const res = await request(app.getHttpServer())
        .get(`/videos/${started.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = res.body as VideoResponseBody;
      expect(body.id).toBe(started.id);
      expect(body.title).toBe('My holiday');
      expect(body.status).toBe(VideoStatus.DRAFT);
      expect(body.thumbnail_url).toBeNull();
    }, 60000);

    it('returns 404 VIDEO_NOT_FOUND for an unknown slug', async () => {
      const token = await createAuthenticatedUser();

      const res = await request(app.getHttpServer())
        .get('/videos/doesnotexist')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      expect((res.body as VideoResponseBody).error).toBe('VIDEO_NOT_FOUND');
    }, 60000);

    it('reflects the status as the video advances through the lifecycle', async () => {
      const token = await createAuthenticatedUser();
      const started = (await initiateUpload(token)).body as VideoResponseBody;
      const parts = await uploadParts(started.parts!, Buffer.from('bytes'));

      const draft = await request(app.getHttpServer())
        .get(`/videos/${started.slug}`)
        .set('Authorization', `Bearer ${token}`);
      expect((draft.body as VideoResponseBody).status).toBe(VideoStatus.DRAFT);

      await request(app.getHttpServer())
        .post(`/videos/${started.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts });

      const processing = await request(app.getHttpServer())
        .get(`/videos/${started.slug}`)
        .set('Authorization', `Bearer ${token}`);
      expect((processing.body as VideoResponseBody).status).toBe(
        VideoStatus.PROCESSING,
      );
    }, 60000);
  });

  describe('GET /videos/:slug/stream and /download', () => {
    /** Leva um vídeo até `ready` processando a fixture real com o worker. */
    async function createReadyVideo(token: string) {
      const started = (
        await initiateUpload(token, {
          filename: 'sample-video.mp4',
        })
      ).body as VideoResponseBody;

      const fixture = await fs.readFile(FIXTURE);
      const key = buildVideoKey(started.id!, 'sample-video.mp4');
      await storageService.putObject(key, fixture, 'video/mp4');
      await videoRepository.update(
        { id: started.id! },
        { status: VideoStatus.PROCESSING },
      );

      await processor.process({
        data: { videoId: started.id! },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as never);

      return started;
    }

    it('redirects to a presigned URL that serves Range requests with 206', async () => {
      const token = await createAuthenticatedUser();
      const video = await createReadyVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .expect(302);

      const location = res.headers['location'];
      expect(location).toContain('http');

      const ranged = await fetch(location, {
        headers: { Range: 'bytes=0-99' },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-99\/\d+$/);

      const total = Number(ranged.headers.get('content-range')!.split('/')[1]);
      const body = Buffer.from(await ranged.arrayBuffer());
      // Só o trecho pedido veio, não o arquivo inteiro.
      expect(body.length).toBe(100);
      expect(total).toBeGreaterThan(100);
    }, 120000);

    it('serves a slice from the middle without transferring the beginning', async () => {
      const token = await createAuthenticatedUser();
      const video = await createReadyVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .expect(302);

      const ranged = await fetch(res.headers['location'], {
        headers: { Range: 'bytes=5000-5099' },
      });
      expect(ranged.status).toBe(206);
      expect(Buffer.from(await ranged.arrayBuffer()).length).toBe(100);
    }, 120000);

    it('serves the download with an attachment disposition', async () => {
      const token = await createAuthenticatedUser();
      const video = await createReadyVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/download`)
        .set('Authorization', `Bearer ${token}`)
        .expect(302);

      const download = await fetch(res.headers['location']);
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toContain(
        'attachment',
      );

      const fixture = await fs.readFile(FIXTURE);
      expect(Buffer.from(await download.arrayBuffer()).length).toBe(
        fixture.length,
      );
    }, 120000);

    it('exposes a usable thumbnail url once the video is ready', async () => {
      const token = await createAuthenticatedUser();
      const video = await createReadyVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = res.body as VideoResponseBody;
      expect(body.status).toBe(VideoStatus.READY);
      expect(body.duration_seconds).toBe(3);
      expect(body.metadata).toMatchObject({ codec: 'h264' });
      expect(body.thumbnail_url).toContain('http');

      const thumb = await fetch(body.thumbnail_url!);
      expect(thumb.status).toBe(200);
    }, 120000);

    it('returns 409 VIDEO_NOT_READY while the video is still processing', async () => {
      const token = await createAuthenticatedUser();
      const started = (await initiateUpload(token)).body as VideoResponseBody;

      const stream = await request(app.getHttpServer())
        .get(`/videos/${started.slug}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((stream.body as VideoResponseBody).error).toBe('VIDEO_NOT_READY');

      const download = await request(app.getHttpServer())
        .get(`/videos/${started.slug}/download`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((download.body as VideoResponseBody).error).toBe(
        'VIDEO_NOT_READY',
      );
    }, 60000);

    it('returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .get('/videos/anything/stream')
        .expect(401);
      await request(app.getHttpServer())
        .get('/videos/anything/download')
        .expect(401);
    });
  });
});
