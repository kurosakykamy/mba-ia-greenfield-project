import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  VideoFileTooLargeException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
  VideoUploadIncompleteException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import type { CompletedPart, PresignedPart } from '../storage/storage.service';
import {
  buildVideoKey,
  calculatePartCount,
  extractExtension,
} from '../storage/storage.util';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './slug.util';
import {
  MAX_VIDEO_SIZE_BYTES,
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_SLUG_MAX_RETRIES,
  VideoStatus,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';

interface PgDriverError {
  code?: string;
  detail?: string;
}

function isSlugUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as QueryFailedError & PgDriverError;
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(SLUG_COLUMN)
  );
}

export interface InitiateUploadInput {
  title: string;
  filename: string;
  size_bytes: number;
  content_type: string;
}

export interface InitiateUploadResult {
  id: string;
  slug: string;
  status: VideoStatus;
  upload_id: string;
  parts: PresignedPart[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly dataSource: DataSource,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Cria o vídeo com um slug único, retentando em colisão.
   *
   * O PostgreSQL aborta a transação inteira em violação de constraint, então
   * cada tentativa roda dentro de um SAVEPOINT — o mesmo padrão já estabelecido
   * em `ChannelsService` para o nickname do canal (convenção herdada da Fase 02).
   */
  async createDraft(channelId: string, title: string): Promise<Video> {
    return this.dataSource.transaction(async (manager) => {
      for (let attempt = 0; attempt < VIDEO_SLUG_MAX_RETRIES; attempt++) {
        const savepoint = `video_slug_attempt_${attempt}`;
        await manager.query(`SAVEPOINT ${savepoint}`);
        try {
          const video = await manager.save(
            manager.create(Video, {
              slug: generateVideoSlug(),
              title,
              channel_id: channelId,
              status: VideoStatus.DRAFT,
            }),
          );
          await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
          return video;
        } catch (err) {
          await manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          if (!isSlugUniqueViolation(err)) throw err;
        }
      }
      throw new Error(
        'Video slug conflict could not be resolved after max retries',
      );
    });
  }

  /**
   * Pré-cadastra o vídeo como rascunho e abre o multipart upload, devolvendo as
   * URLs pré-assinadas por parte. O arquivo vai direto do cliente ao storage —
   * nenhum byte atravessa a API (per `phase-03-videos/TD-02`).
   */
  async initiateUpload(
    channelId: string,
    input: InitiateUploadInput,
  ): Promise<InitiateUploadResult> {
    if (input.size_bytes > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoFileTooLargeException();
    }

    const video = await this.createDraft(channelId, input.title);
    const storageKey = buildVideoKey(video.id, input.filename);

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      input.content_type,
    );

    const partCount = calculatePartCount(
      input.size_bytes,
      this.storageCfg.partSizeBytes,
    );
    const parts = await this.storageService.getPresignedPartUrls(
      storageKey,
      uploadId,
      partCount,
    );

    await this.videoRepository.update(
      { id: video.id },
      {
        storage_key: storageKey,
        upload_id: uploadId,
        size_bytes: String(input.size_bytes),
      },
    );

    return {
      id: video.id,
      slug: video.slug,
      status: VideoStatus.DRAFT,
      upload_id: uploadId,
      parts,
    };
  }

  /**
   * Finaliza o multipart, confirma a integridade do objeto no storage e enfileira
   * o processamento (per `phase-03-videos/TD-03`).
   */
  async completeUpload(
    channelId: string,
    videoId: string,
    parts: CompletedPart[],
  ): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) throw new VideoNotFoundException();
    if (video.channel_id !== channelId) throw new VideoNotOwnedException();
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoInvalidStateException(
        `Video is in "${video.status}"; only a draft upload can be completed`,
      );
    }
    if (!video.storage_key || !video.upload_id) {
      throw new VideoInvalidStateException('Video has no open upload');
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id,
        parts,
      );
    } catch {
      throw new VideoUploadIncompleteException();
    }

    const head = await this.storageService.headObject(video.storage_key);
    if (!head.exists) throw new VideoUploadIncompleteException();

    await this.videoRepository.update(
      { id: video.id },
      {
        status: VideoStatus.PROCESSING,
        upload_id: null,
        ...(head.sizeBytes !== undefined && {
          size_bytes: String(head.sizeBytes),
        }),
      },
    );

    await this.processingQueue.add(VIDEO_PROCESS_JOB, { videoId: video.id });

    return this.videoRepository.findOneByOrFail({ id: video.id });
  }

  async findBySlug(slug: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ slug });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  /**
   * URL pré-assinada de reprodução ou download. Um mecanismo, dois
   * comportamentos: `asAttachment` acrescenta `response-content-disposition`
   * (per `phase-03-videos/TD-04`).
   */
  async getPlaybackUrl(
    slug: string,
    options: { asAttachment?: boolean } = {},
  ): Promise<string> {
    const video = await this.findBySlug(slug);
    if (video.status !== VideoStatus.READY || !video.storage_key) {
      throw new VideoNotReadyException();
    }

    if (!options.asAttachment) {
      return this.storageService.getPresignedReadUrl(video.storage_key);
    }

    const ext = extractExtension(video.storage_key);
    return this.storageService.getPresignedReadUrl(video.storage_key, {
      attachmentFilename: `${video.title}.${ext}`,
    });
  }

  async getThumbnailUrl(video: Video): Promise<string | null> {
    if (!video.thumbnail_key) return null;
    return this.storageService.getPresignedReadUrl(video.thumbnail_key);
  }
}
