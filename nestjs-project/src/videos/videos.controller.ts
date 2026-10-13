import { Body, Controller, Get, Param, Post, Redirect } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { ChannelsService } from '../channels/channels.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
// O nome do scheme é obrigatório e precisa casar com o registrado em
// `swagger-document.ts` (`addBearerAuth(..., 'access-token')`). Sem ele o
// decorator emite `security: [{ bearer: [] }]`, apontando para um scheme
// inexistente no documento — e o botão Authorize do Swagger não se aplica.
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
  ) {}

  /** Canal do usuário autenticado. O canal nunca vem do corpo da requisição. */
  private async resolveChannelId(user: JwtPayload): Promise<string> {
    const channel = await this.channelsService.findByUserId(user.sub);
    if (!channel) throw new VideoNotFoundException();
    return channel.id;
  }

  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and opens a multipart upload, returning one presigned URL per part. The file goes straight from the client to object storage — it never passes through the API.',
  })
  @ApiResponse({ status: 201, description: 'Draft created; upload authorized' })
  @ApiResponse({
    status: 400,
    description: 'VIDEO_FILE_TOO_LARGE or validation error',
    type: ApiErrorEnvelope,
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ) {
    const channelId = await this.resolveChannelId(user);
    return this.videosService.initiateUpload(channelId, dto);
  }

  @Post(':id/complete')
  @ApiOperation({
    summary: 'Finish a video upload',
    description:
      'Completes the multipart upload, verifies the object is present in storage, moves the video to processing and enqueues the processing job.',
  })
  @ApiResponse({ status: 201, description: 'Upload completed; job enqueued' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_NOT_OWNED',
    type: ApiErrorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_INVALID_STATE',
    type: ApiErrorEnvelope,
  })
  @ApiResponse({
    status: 422,
    description: 'VIDEO_UPLOAD_INCOMPLETE',
    type: ApiErrorEnvelope,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ) {
    const channelId = await this.resolveChannelId(user);
    const video = await this.videosService.completeUpload(
      channelId,
      id,
      dto.parts,
    );
    return { id: video.id, slug: video.slug, status: video.status };
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get video metadata by its unique URL identifier' })
  @ApiResponse({ status: 200, description: 'Video metadata' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    type: ApiErrorEnvelope,
  })
  async findBySlug(@Param('slug') slug: string) {
    const video = await this.videosService.findBySlug(slug);
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnail_url: await this.videosService.getThumbnailUrl(video),
      created_at: video.created_at,
    };
  }

  @Get(':slug/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Play the video',
    description:
      'Redirects to a short-lived presigned URL. Object storage serves Range requests natively, so playback starts without downloading the whole file.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the playback URL' })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    type: ApiErrorEnvelope,
  })
  async stream(@Param('slug') slug: string) {
    const url = await this.videosService.getPlaybackUrl(slug);
    return { url, statusCode: 302 };
  }

  @Get(':slug/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download the video file',
    description:
      'Same mechanism as streaming, with response-content-disposition set to attachment so the browser saves the file instead of playing it.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the download URL' })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    type: ApiErrorEnvelope,
  })
  async download(@Param('slug') slug: string) {
    const url = await this.videosService.getPlaybackUrl(slug, {
      asAttachment: true,
    });
    return { url, statusCode: 302 };
  }
}
