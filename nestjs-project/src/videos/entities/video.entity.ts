import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoStatus } from '../videos.constants';

export interface VideoMetadata {
  codec?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  framerate?: string;
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Identificador de URL única, curto e URL-safe (per `phase-03-videos/TD-06`). */
  @Column({ type: 'varchar', length: 16, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoStatus,
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  /** Chave do objeto de vídeo: `videos/{videoId}/source.{ext}` (per `TD-08`). */
  @Column({ type: 'varchar', length: 512, nullable: true })
  storage_key: string | null;

  /** Chave do thumbnail: `videos/{videoId}/thumbnail.jpg` (per `TD-08`). */
  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  /** `UploadId` do multipart em aberto; limpo após a finalização (per `TD-02`). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'int', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  /**
   * Tamanho do arquivo em bytes. `bigint` e não `int`: 10 GiB (≈1,07e10) estoura
   * o teto de `int` do PostgreSQL (2.147.483.647), que é justamente o caso de uso
   * central desta fase. O driver devolve `bigint` como string — daí o tipo.
   */
  @Column({ type: 'bigint', nullable: true })
  size_bytes: string | null;

  /** Causa persistida quando `status = failed` (per `TD-07`). */
  @Column({ type: 'text', nullable: true })
  failure_reason: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
