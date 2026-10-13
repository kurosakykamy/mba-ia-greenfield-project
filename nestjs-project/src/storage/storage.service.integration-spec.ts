import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import type { CompletedPart } from './storage.service';

/**
 * Exercita o object storage real do Compose (serviço `storage`). Nada aqui é
 * mockado: o enunciado da fase proíbe simular o que a infra oferece de verdade.
 */
describe('StorageService (integration)', () => {
  let storageService: StorageService;

  // 5 MiB é o tamanho mínimo de parte do S3 para qualquer parte que não seja a
  // última — abaixo disso o CompleteMultipartUpload é recusado.
  const PART_SIZE = 5 * 1024 * 1024;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
    await storageService.ensureBucket();
  });

  function uniqueKey(suffix: string): string {
    return `test/${Date.now()}-${Math.random().toString(36).slice(2)}/${suffix}`;
  }

  async function uploadPart(url: string, body: Buffer): Promise<string> {
    const response = await fetch(url, { method: 'PUT', body: body as never });
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag!;
  }

  it('completes a multipart upload and makes the object retrievable intact', async () => {
    const key = uniqueKey('source.mp4');
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );

    const partUrls = await storageService.getPresignedPartUrls(
      key,
      uploadId,
      2,
    );
    expect(partUrls).toHaveLength(2);
    expect(partUrls[0].part_number).toBe(1);

    const firstChunk = Buffer.alloc(PART_SIZE, 'a');
    const secondChunk = Buffer.from('tail');

    const parts: CompletedPart[] = [
      { part_number: 1, etag: await uploadPart(partUrls[0].url, firstChunk) },
      { part_number: 2, etag: await uploadPart(partUrls[1].url, secondChunk) },
    ];

    await storageService.completeMultipartUpload(key, uploadId, parts);

    const head = await storageService.headObject(key);
    expect(head.exists).toBe(true);
    expect(head.sizeBytes).toBe(firstChunk.length + secondChunk.length);
  }, 60000);

  it('reports absence for a key that does not exist without throwing', async () => {
    const head = await storageService.headObject(uniqueKey('missing.mp4'));
    expect(head.exists).toBe(false);
    expect(head.sizeBytes).toBeUndefined();
  });

  it('abandons an open multipart upload without leaving the object behind', async () => {
    const key = uniqueKey('aborted.mp4');
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );

    await storageService.abortMultipartUpload(key, uploadId);

    const head = await storageService.headObject(key);
    expect(head.exists).toBe(false);
  });

  it('serves an object through a presigned read URL without extra credentials', async () => {
    const key = uniqueKey('readable.txt');
    await storageService.putObject(key, Buffer.from('hello'), 'text/plain');

    const url = await storageService.getPresignedReadUrl(key);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
  });

  it('forces a download through response-content-disposition', async () => {
    const key = uniqueKey('download.txt');
    await storageService.putObject(key, Buffer.from('payload'), 'text/plain');

    const url = await storageService.getPresignedReadUrl(key, {
      attachmentFilename: 'My Video.mp4',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain(
      'My Video.mp4',
    );
  });

  it('answers a Range request with 206 and only the requested slice', async () => {
    const key = uniqueKey('ranged.bin');
    await storageService.putObject(
      key,
      Buffer.from('0123456789'),
      'application/octet-stream',
    );

    const url = await storageService.getPresignedReadUrl(key);
    const response = await fetch(url, { headers: { Range: 'bytes=2-5' } });

    expect(response.status).toBe(206);
    expect(await response.text()).toBe('2345');
    // Content-Range informa o trecho entregue e o tamanho total do arquivo —
    // é o que permite ao player posicionar a barra de progresso sem baixar tudo.
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
  });

  it('serves a slice from the middle of the object without transferring the start', async () => {
    const key = uniqueKey('seek.bin');
    await storageService.putObject(
      key,
      Buffer.from('abcdefghij'),
      'application/octet-stream',
    );

    const url = await storageService.getPresignedReadUrl(key);
    const response = await fetch(url, { headers: { Range: 'bytes=7-' } });

    expect(response.status).toBe(206);
    expect(await response.text()).toBe('hij');
  });
});
