import { Test } from '@nestjs/testing';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESS_JOB, VIDEO_PROCESSING_QUEUE } from './videos.constants';

/**
 * Exercita a fila real do Compose (serviço `redis`). Confirma que a política de
 * retentativa de `phase-03-videos/TD-07` chega de fato ao job enfileirado — um
 * mock de `Queue` provaria apenas que o método foi chamado.
 */
describe('Video processing queue (integration)', () => {
  let queue: Queue;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            connection: { host: cfg.host, port: cfg.port },
          }),
        }),
        BullModule.registerQueueAsync({
          name: VIDEO_PROCESSING_QUEUE,
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            defaultJobOptions: {
              attempts: cfg.attempts,
              backoff: { type: 'exponential', delay: cfg.backoffDelayMs },
              removeOnComplete: false,
              removeOnFail: false,
            },
          }),
        }),
      ],
    }).compile();

    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
  });

  beforeEach(async () => {
    await queue.drain();
    await queue.clean(0, 1000, 'completed');
    await queue.clean(0, 1000, 'failed');
  });

  /**
   * Busca em todos os estados, não só `waiting`: se um worker real estiver
   * rodando contra o mesmo Redis, ele consome o job imediatamente e um assert
   * sobre `waiting` viraria corrida. O que o teste prova é que o job foi
   * publicado com o payload e a política corretos, não em que estado está.
   */
  async function findPublished(videoId: string) {
    const jobs = await queue.getJobs([
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    ]);
    return jobs.filter(
      (j) => (j.data as { videoId: string }).videoId === videoId,
    );
  }

  it('enqueues a job carrying only the videoId', async () => {
    const videoId = '550e8400-e29b-41d4-a716-446655440000';

    await queue.add(VIDEO_PROCESS_JOB, { videoId });

    const published = await findPublished(videoId);
    expect(published).toHaveLength(1);
    expect(published[0].name).toBe(VIDEO_PROCESS_JOB);
    expect(published[0].data).toEqual({ videoId });
  });

  it('applies the configured retry policy to enqueued jobs', async () => {
    await queue.add(VIDEO_PROCESS_JOB, { videoId: 'retry-check' });

    const [job] = await findPublished('retry-check');
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('reports a reachable queue connection', async () => {
    const counts = await queue.getJobCounts();
    expect(counts).toHaveProperty('waiting');
    expect(counts).toHaveProperty('failed');
  });
});
