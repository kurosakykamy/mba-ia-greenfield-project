import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import {
  VideoFileTooLargeException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
  VideoUploadIncompleteException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';
import { MAX_VIDEO_SIZE_BYTES, VideoStatus } from './videos.constants';

const STORAGE_CFG = {
  endpoint: 'http://storage:4566',
  region: 'us-east-1',
  accessKeyId: 'k',
  secretAccessKey: 's',
  bucket: 'streamtube',
  partSizeBytes: 100 * 1024 * 1024,
  uploadUrlTtlSeconds: 3600,
  readUrlTtlSeconds: 900,
  abortIncompleteUploadDays: 1,
};

const CHANNEL_ID = 'channel-1';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    slug: 'abcdef123456',
    title: 'My video',
    channel_id: CHANNEL_ID,
    status: VideoStatus.DRAFT,
    storage_key: 'videos/video-1/source.mp4',
    thumbnail_key: null,
    upload_id: 'upload-1',
    duration_seconds: null,
    metadata: null,
    size_bytes: null,
    failure_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Video;
}

interface Mocks {
  repo: jest.Mocked<Repository<Video>>;
  storage: jest.Mocked<StorageService>;
  queue: jest.Mocked<Queue>;
  dataSource: DataSource;
}

function buildService(overrides: Partial<Mocks> = {}): {
  service: VideosService;
  mocks: Mocks;
} {
  const repo = {
    findOneBy: jest.fn(),
    findOneByOrFail: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Repository<Video>>;

  const storage = {
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    getPresignedPartUrls: jest
      .fn()
      .mockResolvedValue([{ part_number: 1, url: 'https://signed/1' }]),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    headObject: jest.fn().mockResolvedValue({ exists: true, sizeBytes: 42 }),
    getPresignedReadUrl: jest.fn().mockResolvedValue('https://signed/read'),
  } as unknown as jest.Mocked<StorageService>;

  const queue = {
    add: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Queue>;

  const dataSource = {
    transaction: jest.fn(),
  } as unknown as DataSource;

  const mocks: Mocks = { repo, storage, queue, dataSource, ...overrides };

  const service = new VideosService(
    mocks.repo,
    mocks.dataSource,
    mocks.storage,
    mocks.queue,
    STORAGE_CFG,
  );

  return { service, mocks };
}

describe('VideosService — initiateUpload', () => {
  it('rejects a file larger than the 10 GiB limit before touching storage', async () => {
    const { service, mocks } = buildService();

    await expect(
      service.initiateUpload(CHANNEL_ID, {
        title: 'Too big',
        filename: 'huge.mp4',
        size_bytes: MAX_VIDEO_SIZE_BYTES + 1,
        content_type: 'video/mp4',
      }),
    ).rejects.toThrow(VideoFileTooLargeException);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mocks.storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('accepts a file at exactly the limit', async () => {
    const { service, mocks } = buildService();
    const video = makeVideo();
    jest.spyOn(service, 'createDraft').mockResolvedValue(video);

    await service.initiateUpload(CHANNEL_ID, {
      title: 'At limit',
      filename: 'big.mp4',
      size_bytes: MAX_VIDEO_SIZE_BYTES,
      content_type: 'video/mp4',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mocks.storage.createMultipartUpload).toHaveBeenCalled();
  });

  it('requests one presigned URL per computed part', async () => {
    const { service, mocks } = buildService();
    jest.spyOn(service, 'createDraft').mockResolvedValue(makeVideo());

    await service.initiateUpload(CHANNEL_ID, {
      title: 'Multi part',
      filename: 'clip.mp4',
      // 250 MiB com partes de 100 MiB → 3 partes
      size_bytes: 250 * 1024 * 1024,
      content_type: 'video/mp4',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mocks.storage.getPresignedPartUrls).toHaveBeenCalledWith(
      'videos/video-1/source.mp4',
      'upload-1',
      3,
    );
  });

  it('persists the storage key and upload id on the draft', async () => {
    const { service, mocks } = buildService();
    jest.spyOn(service, 'createDraft').mockResolvedValue(makeVideo());

    const result = await service.initiateUpload(CHANNEL_ID, {
      title: 'Stored',
      filename: 'clip.mov',
      size_bytes: 1024,
      content_type: 'video/quicktime',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mocks.repo.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      expect.objectContaining({
        storage_key: 'videos/video-1/source.mov',
        upload_id: 'upload-1',
        size_bytes: '1024',
      }),
    );
    expect(result.status).toBe(VideoStatus.DRAFT);
  });
});

describe('VideosService — completeUpload', () => {
  it('throws when the video does not exist', async () => {
    const { service, mocks } = buildService();
    mocks.repo.findOneBy.mockResolvedValue(null);

    await expect(
      service.completeUpload(CHANNEL_ID, 'missing', []),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('refuses a video owned by another channel', async () => {
    const { service, mocks } = buildService();
    mocks.repo.findOneBy.mockResolvedValue(
      makeVideo({ channel_id: 'someone-else' }),
    );

    await expect(
      service.completeUpload(CHANNEL_ID, 'video-1', []),
    ).rejects.toThrow(VideoNotOwnedException);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mocks.storage.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('refuses a video that is not a draft', async () => {
    const { service, mocks } = buildService();
    mocks.repo.findOneBy.mockResolvedValue(
      makeVideo({ status: VideoStatus.READY }),
    );

    await expect(
      service.completeUpload(CHANNEL_ID, 'video-1', []),
    ).rejects.toThrow(VideoInvalidStateException);
  });

  it('reports an incomplete upload when the object is absent from storage', async () => {
    const { service, mocks } = buildService();
    mocks.repo.findOneBy.mockResolvedValue(makeVideo());
    mocks.storage.headObject.mockResolvedValue({ exists: false });

    await expect(
      service.completeUpload(CHANNEL_ID, 'video-1', [
        { part_number: 1, etag: 'e' },
      ]),
    ).rejects.toThrow(VideoUploadIncompleteException);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mocks.queue.add).not.toHaveBeenCalled();
  });

  it('moves the video to processing and enqueues the job', async () => {
    const { service, mocks } = buildService();
    mocks.repo.findOneBy.mockResolvedValue(makeVideo());
    mocks.repo.findOneByOrFail.mockResolvedValue(
      makeVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
    );

    const result = await service.completeUpload(CHANNEL_ID, 'video-1', [
      { part_number: 1, etag: 'etag-1' },
    ]);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mocks.repo.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      expect.objectContaining({
        status: VideoStatus.PROCESSING,
        upload_id: null,
      }),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mocks.queue.add).toHaveBeenCalledWith('video.process', {
      videoId: 'video-1',
    });
    expect(result.status).toBe(VideoStatus.PROCESSING);
  });
});

describe('VideosService — playback', () => {
  it('refuses playback for a video that is not ready', async () => {
    const { service, mocks } = buildService();
    mocks.repo.findOneBy.mockResolvedValue(
      makeVideo({ status: VideoStatus.PROCESSING }),
    );

    await expect(service.getPlaybackUrl('abcdef123456')).rejects.toThrow(
      VideoNotReadyException,
    );
  });

  it('returns a plain presigned URL for streaming', async () => {
    const { service, mocks } = buildService();
    mocks.repo.findOneBy.mockResolvedValue(
      makeVideo({ status: VideoStatus.READY }),
    );

    await service.getPlaybackUrl('abcdef123456');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mocks.storage.getPresignedReadUrl).toHaveBeenCalledWith(
      'videos/video-1/source.mp4',
    );
  });

  it('asks for an attachment disposition on download', async () => {
    const { service, mocks } = buildService();
    mocks.repo.findOneBy.mockResolvedValue(
      makeVideo({ status: VideoStatus.READY, title: 'My Trip' }),
    );

    await service.getPlaybackUrl('abcdef123456', { asAttachment: true });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mocks.storage.getPresignedReadUrl).toHaveBeenCalledWith(
      'videos/video-1/source.mp4',
      { attachmentFilename: 'My Trip.mp4' },
    );
  });

  it('throws when the slug does not resolve', async () => {
    const { service, mocks } = buildService();
    mocks.repo.findOneBy.mockResolvedValue(null);

    await expect(service.findBySlug('nope')).rejects.toThrow(
      VideoNotFoundException,
    );
  });

  it('returns null thumbnail url when no thumbnail exists', async () => {
    const { service } = buildService();
    const url = await service.getThumbnailUrl(makeVideo());
    expect(url).toBeNull();
  });
});
