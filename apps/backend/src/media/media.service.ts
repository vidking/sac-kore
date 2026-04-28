import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { access, mkdir, rm } from 'fs/promises';
import { basename, extname, join, resolve } from 'path';
import { pipeline } from 'stream/promises';
import { AuthUser } from '../auth/current-user.decorator';
import { ConversationService } from '../conversations/conversation.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { WahaService } from '../waha/waha.service';

const richMediaSelect: any = {
  id: true,
  status: true,
  mediaType: true,
  caption: true,
  mime: true,
  fileName: true,
  pathOrUrl: true,
  thumbnailPathOrUrl: true,
  thumbnailBase64: true,
  providerMessageId: true,
  providerMediaId: true,
  mediaKey: true,
  fetchStatus: true,
  fetchError: true,
  sha256: true,
  size: true,
};

@Injectable()
export class MediaService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEventsService,
    private readonly waha: WahaService,
    private readonly conversations: ConversationService,
  ) {}

  async download(mediaId: string) {
    const media = await this.prisma.media.findUnique({
      where: { id: mediaId },
      include: { message: true },
    });

    if (!media) throw new NotFoundException('Media not found');
    if (!media.pathOrUrl) {
      return this.prisma.media.update({
        where: { id: media.id },
        data: { status: MediaStatus.failed },
      });
    }

    if (isLocalFile(media.pathOrUrl) && (await fileExists(media.pathOrUrl))) {
      return this.prisma.media.update({
        where: { id: media.id },
        data: {
          pathOrUrl: resolve(media.pathOrUrl),
          thumbnailPathOrUrl: media.thumbnailPathOrUrl ?? resolve(media.pathOrUrl),
          status: MediaStatus.downloaded,
        },
      });
    }

    const url = this.rewriteMediaUrl(media.pathOrUrl);
    this.assertAllowedMediaUrl(url);

    const extension =
      extname(new URL(url).pathname) ||
      extensionFromMime(media.mime ?? undefined) ||
      '.bin';
    const fileName = sanitizeFileName(
      media.fileName ?? `${media.message.externalMessageId}${extension}`,
    );
    const storagePath = this.config.get<string>('MEDIA_STORAGE_PATH') ?? './storage/media';
    await mkdir(storagePath, { recursive: true });

    const finalPath = join(storagePath, `${media.id}-${fileName}`);
    const streamed = await this.streamMediaToDisk(url, finalPath, media.mime ?? undefined);

    const updated = await this.prisma.media.update({
      where: { id: media.id },
      data: {
        pathOrUrl: finalPath,
        thumbnailPathOrUrl: media.thumbnailPathOrUrl ?? finalPath,
        sha256: streamed.sha256,
        size: streamed.size,
        mime: media.mime ?? streamed.contentType,
        status: MediaStatus.downloaded,
      },
    });

    await this.realtime.publish(
      'media.updated',
      {
        media: updated,
        messageId: media.messageId,
        conversationId: media.message.conversationId,
      },
      { rooms: [`conversation:${media.message.conversationId}`] },
    );

    return updated;
  }

  async resolveMessageMedia(
    messageId: string,
    actor: AuthUser,
    variant: 'media' | 'thumbnail' = 'media',
  ) {
    const message = (await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        media: { select: richMediaSelect },
      },
    })) as any;

    if (!message?.media) {
      throw new NotFoundException('Media not found');
    }

    await this.conversations.assertAccessById(message.conversationId, actor);

    const source =
      variant === 'thumbnail'
        ? message.media.thumbnailPathOrUrl ?? message.media.pathOrUrl
        : message.media.pathOrUrl;

    if (variant === 'thumbnail' && message.media.thumbnailBase64) {
      const inline = decodeInlineBase64(message.media.thumbnailBase64, message.media.mime ?? undefined);
      if (inline) {
        return {
          kind: 'buffer' as const,
          buffer: inline.buffer,
          mime: inline.mime ?? message.media.mime ?? undefined,
          fileName: message.media.fileName ?? undefined,
        };
      }
    }

    if (!source) {
      throw new NotFoundException('Media source not available');
    }

    if (isLocalFile(source) && (await fileExists(source))) {
      return {
        kind: 'file' as const,
        path: resolve(source),
        mime: message.media.mime ?? undefined,
        fileName: message.media.fileName ?? undefined,
      };
    }

    const url = this.rewriteMediaUrl(source);
    this.assertAllowedMediaUrl(url);

    return {
      kind: 'redirect' as const,
      url,
      mime: message.media.mime ?? undefined,
      fileName: message.media.fileName ?? undefined,
    };
  }

  private rewriteMediaUrl(url: string) {
    const wahaUrl = this.config.get<string>('WAHA_URL') ?? 'http://localhost:3000';
    if (/^data:/i.test(url)) {
      return url;
    }

    const parsed = new URL(url, wahaUrl);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const base = new URL(wahaUrl);
      parsed.protocol = base.protocol;
      parsed.host = base.host;
    }
    return parsed.toString();
  }

  private assertAllowedMediaUrl(url: string) {
    const mediaUrl = new URL(url);
    const wahaUrl = new URL(this.config.get<string>('WAHA_URL') ?? 'http://localhost:3000');

    if (!['http:', 'https:'].includes(mediaUrl.protocol)) {
      throw new BadRequestException('Unsupported media URL protocol');
    }

    if (mediaUrl.host !== wahaUrl.host) {
      throw new BadRequestException('Media URL host is not allowed');
    }
  }

  private async streamMediaToDisk(url: string, finalPath: string, fallbackMime?: string) {
    const maxBytes = Number(this.config.get<string>('MAX_MEDIA_DOWNLOAD_BYTES') ?? '26214400');
    const { stream, contentType, contentLength } = await this.waha.downloadMedia(url);

    if (contentLength && contentLength > maxBytes) {
      throw new BadRequestException('Media file exceeds maximum allowed size');
    }

    const hash = createHash('sha256');
    let size = 0;
    const writer = createWriteStream(finalPath, { flags: 'w' });

    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy(new Error('Media file exceeds maximum allowed size'));
        return;
      }
      hash.update(chunk);
    });

    try {
      await pipeline(stream, writer);
      return {
        sha256: hash.digest('hex'),
        contentType: fallbackMime ?? contentType,
        size,
      };
    } catch (error) {
      await rm(finalPath, { force: true });
      throw error;
    }
  }
}

function decodeInlineBase64(value: string, fallbackMime?: string) {
  const raw = value.trim();
  if (!raw) return null;

  const match = raw.match(/^data:(.+?);base64,(.+)$/i);
  if (match) {
    return {
      mime: match[1] || fallbackMime || null,
      buffer: Buffer.from(match[2], 'base64'),
    };
  }

  try {
    return {
      mime: fallbackMime ?? null,
      buffer: Buffer.from(raw, 'base64'),
    };
  } catch {
    return null;
  }
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isLocalFile(pathOrUrl: string) {
  return !/^https?:\/\//i.test(pathOrUrl);
}

function sanitizeFileName(fileName: string) {
  return basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function extensionFromMime(mime?: string) {
  if (!mime) return '.bin';
  if (mime.includes('jpeg')) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('mpeg')) return '.mp3';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('pdf')) return '.pdf';
  return '.bin';
}
