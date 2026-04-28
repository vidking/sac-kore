import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEventsService } from './realtime-events.service';
import { RedisService } from './redis.service';

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_ORIGIN?.split(',') ?? ['http://localhost:5173'],
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEventsService,
    private readonly redis: RedisService,
  ) {}

  async afterInit() {
    await this.redis.subscriber.subscribe(this.realtime.getChannel());
    this.redis.subscriber.on('message', (_channel, message) => {
      const event = JSON.parse(message) as {
        type: string;
        payload: unknown;
        audience?: { rooms?: string[]; userIds?: string[] };
      };
      const rooms = event.audience?.rooms ?? [];
      const userIds = event.audience?.userIds ?? [];

      if (!rooms.length && !userIds.length) {
        return;
      }

      for (const room of rooms) {
        this.server.to(room).emit(event.type, event.payload);
      }

      for (const userId of userIds) {
        this.server.to(`user:${userId}`).emit(event.type, event.payload);
      }
    });
  }

  async handleConnection(client: Socket) {
    const token = extractToken(
      client.handshake.auth?.token,
      client.handshake.headers.cookie,
    );
    if (!token) {
      client.disconnect(true);
      return;
    }

    try {
      const user = await this.jwt.verifyAsync(token);
      client.data.user = user;
      client.join(`user:${user.sub}`);
    } catch {
      client.disconnect(true);
    }
  }

  @SubscribeMessage('conversation.join')
  async joinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: payload.conversationId },
      select: { id: true, assignedTo: true },
    });

    if (!conversation) {
      client.emit('conversation.access.denied', {
        conversationId: payload.conversationId,
        reason: 'not_found',
      });
      return;
    }

    const user = client.data.user as { sub: string; role?: string } | undefined;
    const canAccess =
      user?.role === 'admin' ||
      !conversation.assignedTo ||
      conversation.assignedTo === user?.sub;

    if (!canAccess) {
      client.emit('conversation.access.denied', {
        conversationId: payload.conversationId,
        reason: 'forbidden',
      });
      return;
    }

    client.join(`conversation:${payload.conversationId}`);
  }

  @SubscribeMessage('conversation.leave')
  leaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ) {
    client.leave(`conversation:${payload.conversationId}`);
  }
}

function extractToken(authToken?: string, cookieHeader?: string) {
  if (authToken) {
    return authToken;
  }

  if (!cookieHeader) {
    return null;
  }

  const cookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('crm_session='));

  if (!cookie) {
    return null;
  }

  const encoded = cookie.slice('crm_session='.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
