import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ConfigModule.forFeature(storageConfig),
    ChannelsModule,
    StorageModule,
    BullModule.registerQueueAsync({
      name: VIDEO_PROCESSING_QUEUE,
      imports: [ConfigModule.forFeature(queueConfig)],
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        defaultJobOptions: {
          attempts: cfg.attempts,
          backoff: { type: 'exponential', delay: cfg.backoffDelayMs },
          // Jobs concluídos e falhos ficam retidos para inspeção; sem isso o
          // BullMQ os remove e a observabilidade de falha se perde.
          removeOnComplete: false,
          removeOnFail: false,
        },
      }),
    }),
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [BullModule, VideosService],
})
export class VideosModule {}
