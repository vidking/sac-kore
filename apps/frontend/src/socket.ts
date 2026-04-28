import { io, Socket } from 'socket.io-client';

export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:3001';

export function connectSocket(token?: string): Socket {
  return io(SOCKET_URL, {
    auth: token ? { token } : undefined,
    transports: ['websocket'],
    withCredentials: true,
  });
}
