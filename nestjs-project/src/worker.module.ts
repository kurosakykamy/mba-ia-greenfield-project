import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import { envValidationSchema } from './config/env.validation';
import { StorageModule } from './storage/storage.module';
import { Channel } from './channels/entities/channel.entity';
import { User } from './users/entities/user.entity';
import { Video } from './videos/entities/video.entity';
import { VideoProcessingProcessor } from './videos/video-processing.processor';
import { VIDEO_PROCESSING_QUEUE } from './videos/videos.constants';

/**
 * Módulo raiz do worker de vídeo.
 *
 * Reaproveita entidades, configuração e conexão de banco do mesmo codebase
 * (per `phase-03-videos/TD-05`), mas não registra controllers nem guards — o
 * worker não atende HTTP, apenas consome a fila.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // `Channel` e `User` entram junto de `Video` não porque o worker os use,
    // mas porque `autoLoadEntities` só carrega o que algum módulo registra via
    // `forFeature`. Sem eles o TypeORM falha ao resolver a relação
    // `Video#channel` e a conexão nem sobe.
    TypeOrmModule.forFeature([Video, Channel, User]),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.host, port: cfg.port },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
  ],
  providers: [VideoProcessingProcessor],
})
export class WorkerModule {}
