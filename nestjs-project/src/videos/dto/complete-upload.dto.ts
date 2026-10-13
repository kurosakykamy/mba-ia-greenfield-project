import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  @ApiProperty({
    description: 'Número da parte. O S3 numera partes a partir de 1.',
    minimum: 1,
    example: 1,
  })
  @IsInt()
  @Min(1)
  part_number: number;

  @ApiProperty({
    description: 'ETag devolvido pelo storage no envio daquela parte.',
    example: '"d41d8cd98f00b204e9800998ecf8427e"',
  })
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({ type: [CompletedPartDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
