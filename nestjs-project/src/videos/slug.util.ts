import { customAlphabet } from 'nanoid';
import { VIDEO_SLUG_LENGTH } from './videos.constants';

/**
 * Alfabeto URL-safe sem caracteres ambíguos visualmente (`0`/`O`, `1`/`l`/`I`):
 * o slug aparece em links compartilhados e eventualmente é digitado à mão.
 */
const SLUG_ALPHABET =
  '23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';

const generate = customAlphabet(SLUG_ALPHABET, VIDEO_SLUG_LENGTH);

/**
 * Identificador de URL única do vídeo (per `phase-03-videos/TD-06`).
 *
 * A unicidade real é garantida pela constraint `UNIQUE` da coluna `slug`; esta
 * função apenas torna a colisão improvável. O tratamento de colisão fica no
 * serviço, com retentativa por SAVEPOINT.
 */
export function generateVideoSlug(): string {
  return generate();
}
