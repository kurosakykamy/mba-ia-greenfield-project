import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://storage:4566',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY || 'streamtube',
  secretAccessKey: process.env.STORAGE_SECRET_KEY || 'streamtube',
  bucket: process.env.STORAGE_BUCKET || 'streamtube',
  /** Tamanho de cada parte do multipart upload, em bytes. Mínimo do S3: 5 MiB. */
  partSizeBytes: parseInt(
    process.env.STORAGE_PART_SIZE_BYTES || `${100 * 1024 * 1024}`,
    10,
  ),
  /** TTL das URLs pré-assinadas de upload, em segundos. */
  uploadUrlTtlSeconds: parseInt(
    process.env.STORAGE_UPLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
  /** TTL das URLs pré-assinadas de leitura (streaming/download), em segundos. */
  readUrlTtlSeconds: parseInt(
    process.env.STORAGE_READ_URL_TTL_SECONDS || '900',
    10,
  ),
  /** Dias até expirar um multipart upload iniciado e nunca finalizado. */
  abortIncompleteUploadDays: parseInt(
    process.env.STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS || '1',
    10,
  ),
}));
