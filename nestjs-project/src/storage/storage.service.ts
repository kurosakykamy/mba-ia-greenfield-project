import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

export interface PresignedPart {
  part_number: number;
  url: string;
}

export interface CompletedPart {
  part_number: number;
  etag: string;
}

export interface ObjectHead {
  exists: boolean;
  sizeBytes?: number;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
      // Obrigatório contra storage S3-compatível: sem isso o SDK usa
      // virtual-host style (`bucket.host`), que não resolve localmente.
      forcePathStyle: true,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  /**
   * Cria o bucket se ausente e aplica a regra de expiração de multipart uploads
   * incompletos, evitando que partes órfãs ocupem espaço indefinidamente
   * (per `phase-03-videos/TD-08`).
   */
  async ensureBucket(): Promise<void> {
    const Bucket = this.config.bucket;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket }));
      this.logger.log(`Created storage bucket "${Bucket}"`);
    }

    await this.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'abort-incomplete-multipart-uploads',
              Status: 'Enabled',
              Filter: { Prefix: '' },
              AbortIncompleteMultipartUpload: {
                DaysAfterInitiation: this.config.abortIncompleteUploadDays,
              },
            },
          ],
        },
      }),
    );
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error(`Storage did not return an UploadId for key "${key}"`);
    }
    return result.UploadId;
  }

  /**
   * Uma URL pré-assinada por parte. O cliente envia cada parte diretamente ao
   * storage — o arquivo nunca atravessa a API (per `phase-03-videos/TD-02`).
   */
  async getPresignedPartUrls(
    key: string,
    uploadId: string,
    partCount: number,
  ): Promise<PresignedPart[]> {
    const parts: PresignedPart[] = [];
    // Partes do S3 são 1-indexadas.
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: this.config.uploadUrlTtlSeconds },
      );
      parts.push({ part_number: partNumber, url });
    }
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .slice()
            .sort((a, b) => a.part_number - b.part_number)
            .map((p) => ({ PartNumber: p.part_number, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** Confirma presença e tamanho do objeto; ausência não lança. */
  async headObject(key: string): Promise<ObjectHead> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return { exists: true, sizeBytes: result.ContentLength };
    } catch {
      return { exists: false };
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * URL pré-assinada de leitura. Com `attachmentFilename`, acrescenta
   * `response-content-disposition=attachment`, que é o único ponto em que o
   * download difere do streaming (per `phase-03-videos/TD-04`).
   */
  async getPresignedReadUrl(
    key: string,
    options: { attachmentFilename?: string } = {},
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ...(options.attachmentFilename && {
          ResponseContentDisposition: `attachment; filename="${options.attachmentFilename}"`,
        }),
      }),
      { expiresIn: this.config.readUrlTtlSeconds },
    );
  }
}
