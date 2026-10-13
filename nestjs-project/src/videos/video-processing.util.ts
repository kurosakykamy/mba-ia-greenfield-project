import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
// `fluent-ffmpeg` exporta a própria função via `module.exports` (CommonJS puro,
// sem `.default`). Com `esModuleInterop` ligado no tsconfig, o import default é
// a forma que preserva a chamabilidade de `ffmpeg(source)` — `import * as` traz
// o objeto do módulo, que não é chamável sob `nodenext`.
import ffmpeg from 'fluent-ffmpeg';

export interface VideoInfo {
  durationSeconds: number;
  codec?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  framerate?: string;
}

/**
 * Extrai duração e metadados técnicos via `ffprobe`.
 *
 * `source` é uma URL pré-assinada: o FFmpeg abre a conexão HTTP por conta
 * própria e lê apenas os bytes de cabeçalho de que precisa, sem baixar o
 * arquivo inteiro (per `phase-03-videos/TD-05`).
 */
export function extractVideoInfo(source: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(source, (err, metadata) => {
      if (err) {
        reject(
          err instanceof Error
            ? err
            : new Error(`ffprobe failed: ${String(err)}`),
        );
        return;
      }

      const videoStream = metadata.streams?.find(
        (s) => s.codec_type === 'video',
      );
      if (!videoStream) {
        reject(new Error('No video stream found in the uploaded file'));
        return;
      }

      const rawDuration = metadata.format?.duration;
      const durationSeconds = Math.round(Number(rawDuration ?? 0));

      resolve({
        durationSeconds,
        codec: videoStream.codec_name,
        width: videoStream.width,
        height: videoStream.height,
        bitrate: metadata.format?.bit_rate
          ? Number(metadata.format.bit_rate)
          : undefined,
        framerate: videoStream.r_frame_rate,
      });
    });
  });
}

/**
 * Gera o thumbnail a partir de um frame do vídeo.
 *
 * `screenshots()` só escreve em arquivo — não aceita stream de saída — então o
 * frame é gravado num diretório temporário, lido como Buffer e o temporário é
 * removido. O que não é baixado é o **vídeo**: a entrada continua sendo a URL.
 */
export async function generateThumbnail(
  source: string,
  timestampPercent = '15%',
): Promise<Buffer> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamtube-thumb-'));
  const filename = `${randomUUID()}.jpg`;

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(source)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          timestamps: [timestampPercent],
          filename,
          folder: workDir,
          size: '640x?',
        });
    });

    return await fs.readFile(path.join(workDir, filename));
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
