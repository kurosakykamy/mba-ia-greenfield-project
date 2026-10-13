import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  /** Tentativas por job antes de marcar falha definitiva. */
  attempts: parseInt(process.env.QUEUE_JOB_ATTEMPTS || '3', 10),
  /** Delay inicial do backoff exponencial entre tentativas, em ms. */
  backoffDelayMs: parseInt(process.env.QUEUE_BACKOFF_DELAY_MS || '5000', 10),
}));
