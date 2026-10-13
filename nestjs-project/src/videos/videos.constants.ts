/**
 * Ciclo de vida do vídeo (per `phase-03-videos/TD-07`).
 *
 * `draft`      — pré-cadastrado ao iniciar o upload; arquivo ainda não finalizado.
 * `processing` — upload finalizado e job publicado na fila.
 * `ready`      — processado com sucesso; reproduzível e baixável.
 * `failed`     — processamento falhou em definitivo; `failure_reason` persistido.
 */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;
export const VIDEO_PROCESS_JOB = 'video.process' as const;

/** Teto de tamanho de arquivo aceito no upload: 10 GiB. */
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

/** Comprimento do identificador de URL única gerado por nanoid (per `TD-06`). */
export const VIDEO_SLUG_LENGTH = 12;

/** Tentativas de geração de slug antes de desistir, em caso de colisão. */
export const VIDEO_SLUG_MAX_RETRIES = 5;
