import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MediaService } from '../media/media.service';
import { Response } from 'express';

@UseGuards(JwtAuthGuard)
@Controller('messages')
export class MessagesController {
  constructor(private readonly media: MediaService) {}

  @Get(':id/media')
  async mediaByMessageId(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() response: Response,
  ) {
    const resolved = await this.media.resolveMessageMedia(id, user, 'media');
    return sendResolvedMedia(response, resolved, false);
  }

  @Get(':id/thumbnail')
  async thumbnailByMessageId(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() response: Response,
  ) {
    const resolved = await this.media.resolveMessageMedia(id, user, 'thumbnail');
    return sendResolvedMedia(response, resolved, true);
  }
}

function sendResolvedMedia(
  response: Response,
  resolved:
    | { kind: 'file'; path: string; mime?: string; fileName?: string }
    | { kind: 'redirect'; url: string; mime?: string; fileName?: string }
    | { kind: 'buffer'; buffer: Buffer; mime?: string; fileName?: string },
  inline: boolean,
) {
  if (resolved.mime) {
    response.type(resolved.mime);
  }

  if (resolved.fileName) {
    response.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${resolved.fileName}"`,
    );
  }

  if (resolved.kind === 'redirect') {
    return response.redirect(resolved.url);
  }

  if (resolved.kind === 'buffer') {
    return response.send(resolved.buffer);
  }

  return response.sendFile(resolved.path);
}
