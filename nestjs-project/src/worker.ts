import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Entrypoint do worker de vídeo (per `phase-03-videos/TD-05`).
 *
 * `createApplicationContext` sobe o container de DI sem servidor HTTP: o worker
 * consome a fila, não atende requisições.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('VideoWorker');
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  logger.log('Video worker started — consuming the processing queue');

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
