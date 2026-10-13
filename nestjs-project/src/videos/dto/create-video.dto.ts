import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  Max,
  Min,
} from 'class-validator';
import { MAX_VIDEO_SIZE_BYTES } from '../videos.constants';

export class CreateVideoDto {
  @ApiProperty({ maxLength: 255, example: 'Minhas férias' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @ApiProperty({ maxLength: 255, example: 'holiday.mp4' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @ApiProperty({
    description: 'Tamanho do arquivo em bytes. Máximo: 10 GiB.',
    minimum: 1,
    maximum: MAX_VIDEO_SIZE_BYTES,
    example: 52428800,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  size_bytes: number;

  @ApiProperty({ example: 'video/mp4' })
  @IsString()
  @Matches(/^video\//, { message: 'content_type must be a video MIME type' })
  content_type: string;
}
