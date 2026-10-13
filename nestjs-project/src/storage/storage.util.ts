/**
 * Convenção de chaves de objeto (per `phase-03-videos/TD-08`).
 *
 * Tudo que pertence a um vídeo vive sob o prefixo `videos/{videoId}/`, de modo
 * que a remoção em cascata seja uma única operação por prefixo.
 */

const VIDEO_PREFIX = 'videos';

/** Extensão derivada do nome de arquivo original; `mp4` quando indeterminável. */
export function extractExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) return 'mp4';
  const ext = filename.slice(lastDot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'mp4';
}

export function buildVideoKey(videoId: string, filename: string): string {
  return `${VIDEO_PREFIX}/${videoId}/source.${extractExtension(filename)}`;
}

export function buildThumbnailKey(videoId: string): string {
  return `${VIDEO_PREFIX}/${videoId}/thumbnail.jpg`;
}

/**
 * Número de partes do multipart upload para um arquivo de `sizeBytes`.
 * Sempre ≥ 1: um arquivo menor que o tamanho de parte ainda é uma parte.
 */
export function calculatePartCount(
  sizeBytes: number,
  partSizeBytes: number,
): number {
  return Math.max(1, Math.ceil(sizeBytes / partSizeBytes));
}
