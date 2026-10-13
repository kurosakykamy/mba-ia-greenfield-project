import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { MAX_VIDEO_SIZE_BYTES, VideoStatus } from '../videos.constants';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter++;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `channel${counter}`,
        nickname: `channel${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should default status to draft when not provided', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        slug: 'abc123def456',
        title: 'My video',
        channel_id: channel.id,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('should reject a video whose channel does not exist', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          slug: 'orphan12345a',
          title: 'Orphan',
          channel_id: '00000000-0000-0000-0000-000000000000',
        }),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should reject two videos with the same slug', async () => {
    const channel = await createChannel();
    const slug = 'duplicate123';

    await videoRepository.save(
      videoRepository.create({ slug, title: 'First', channel_id: channel.id }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          slug,
          title: 'Second',
          channel_id: channel.id,
        }),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should persist a 10 GiB size_bytes without truncation', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        slug: 'bigfile1234a',
        title: 'Big file',
        channel_id: channel.id,
        size_bytes: String(MAX_VIDEO_SIZE_BYTES),
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.size_bytes).toBe(String(MAX_VIDEO_SIZE_BYTES));
    expect(Number(found.size_bytes)).toBe(10737418240);
  });

  it('should persist metadata as a structured jsonb object', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        slug: 'withmeta1234',
        title: 'With metadata',
        channel_id: channel.id,
        duration_seconds: 125,
        metadata: { codec: 'h264', width: 1920, height: 1080 },
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.duration_seconds).toBe(125);
    expect(found.metadata).toEqual({
      codec: 'h264',
      width: 1920,
      height: 1080,
    });
  });

  it('should load the owning channel through the relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        slug: 'withrel12345',
        title: 'Related',
        channel_id: channel.id,
      }),
    );

    const found = await videoRepository.findOneOrFail({
      where: { slug: 'withrel12345' },
      relations: ['channel'],
    });
    expect(found.channel.id).toBe(channel.id);
  });

  it('should accept the full status lifecycle values', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        slug: 'lifecycle123',
        title: 'Lifecycle',
        channel_id: channel.id,
      }),
    );

    for (const status of [
      VideoStatus.PROCESSING,
      VideoStatus.READY,
      VideoStatus.FAILED,
    ]) {
      await videoRepository.update({ id: video.id }, { status });
      const found = await videoRepository.findOneByOrFail({ id: video.id });
      expect(found.status).toBe(status);
    }
  });
});
