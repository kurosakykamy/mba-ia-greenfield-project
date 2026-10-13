import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { buildThumbnailKey } from '../storage/storage.util';
import { Video } from './entities/video.entity';
import type { VideoMetadata } from './entities/video.entity';
import { extractVideoInfo, generateThumbnail } from './video-processing.util';
import { VIDEO_PROCESSING_QUEUE, VideoStatus } from './videos.constants';

export interface VideoProcessJobData {
  videoId: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  /**
   * Extrai duração e metadados, gera o thumbnail e leva o vídeo a `ready`.
   *
   * Lançar aqui marca o job como falho e dispara a retentativa conforme
   * `attempts`/`backoff` da fila — é o mecanismo nativo do BullMQ que
   * `phase-03-videos/TD-07` adota em vez de reimplementar retry na aplicação.
   */
  async process(job: Job<VideoProcessJobData>): Promise<void> {
    const { videoId } = job.data;

    // Relê o estado atual do banco em vez de confiar no payload: o job carrega
    // só o identificador, justamente para não trabalhar sobre uma cópia que
    // pode ter divergido entre o enfileiramento e o processamento.
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      this.logger.warn(`Video ${videoId} no longer exists; skipping job`);
      return;
    }
    if (!video.storage_key) {
      throw new Error(`Video ${videoId} has no storage key`);
    }

    // FFmpeg lê direto da URL pré-assinada e busca apenas os bytes de que
    // precisa — é o que evita baixar até 10GB para o disco do worker a cada job
    // (per `phase-03-videos/TD-05`).
    const sourceUrl = await this.storageService.getPresignedReadUrl(
      video.storage_key,
    );

    const info = await extractVideoInfo(sourceUrl);
    const thumbnail = await generateThumbnail(sourceUrl);

    const thumbnailKey = buildThumbnailKey(video.id);
    await this.storageService.putObject(thumbnailKey, thumbnail, 'image/jpeg');

    const metadata: VideoMetadata = {
      codec: info.codec,
      width: info.width,
      height: info.height,
      bitrate: info.bitrate,
      framerate: info.framerate,
    };

    await this.videoRepository.update(
      { id: video.id },
      {
        status: VideoStatus.READY,
        duration_seconds: info.durationSeconds,
        metadata,
        thumbnail_key: thumbnailKey,
        failure_reason: null,
      },
    );

    this.logger.log(`Video ${videoId} processed successfully`);
  }

  /**
   * Falha definitiva: só marca `failed` quando as tentativas se esgotaram.
   * Uma falha transitória intermediária ainda tem retentativa pela frente e não
   * deve derrubar o vídeo (per `phase-03-videos/TD-07`).
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessJobData>, err: Error): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) {
      this.logger.warn(
        `Video ${job.data.videoId} attempt ${job.attemptsMade}/${attempts} failed: ${err.message}`,
      );
      return;
    }

    this.logger.error(
      `Video ${job.data.videoId} failed permanently: ${err.message}`,
    );
    await this.videoRepository.update(
      { id: job.data.videoId },
      { status: VideoStatus.FAILED, failure_reason: err.message },
    );
  }
}
