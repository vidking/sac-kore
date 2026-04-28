import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { Readable } from 'stream';

@Injectable()
export class WahaService {
  private readonly client: AxiosInstance;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('WAHA_API_KEY_PLAIN') ?? config.get<string>('WAHA_API_KEY');

    this.client = axios.create({
      baseURL: config.get<string>('WAHA_URL') ?? 'http://localhost:3000',
      timeout: 30_000,
      headers: apiKey ? { 'X-Api-Key': apiKey } : undefined,
    });
  }

  async getJson<T>(path: string, params?: Record<string, unknown>) {
    const { data } = await this.client.get(path, { params });
    return data as T;
  }

  async postJson<T>(path: string, body?: Record<string, unknown>) {
    const { data } = await this.client.post(path, body);
    return data as T;
  }

  async sendText(session: string, chatId: string, text: string) {
    const { data } = await this.client.post('/api/sendText', {
      session,
      chatId,
      text,
    });
    return data;
  }

  async getChats(
    session: string,
    params: { limit?: number; offset?: number; sortBy?: string; sortOrder?: 'asc' | 'desc' },
  ) {
    const { data } = await this.client.get(`/api/${encodeURIComponent(session)}/chats`, {
      params,
    });
    return data as Record<string, any>[];
  }

  async getChatMessages(
    session: string,
    chatId: string,
    params: {
      limit?: number;
      offset?: number;
      downloadMedia?: boolean;
      'filter.timestamp.gte'?: number;
    },
  ) {
    const { data } = await this.client.get(
      `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages`,
      { params },
    );
    return data as Record<string, any>[];
  }

  async downloadMedia(urlOrPath: string) {
    const resolvedUrl = this.resolveUrl(urlOrPath);
    const { data, headers } = await this.client.get<Readable>(resolvedUrl, {
      responseType: 'stream',
    });
    return {
      stream: data,
      contentType: headers['content-type'] as string | undefined,
      contentLength: headers['content-length']
        ? Number(headers['content-length'])
        : undefined,
    };
  }

  private resolveUrl(urlOrPath: string) {
    if (/^https?:\/\//i.test(urlOrPath)) {
      return urlOrPath;
    }

    const base = this.client.defaults.baseURL ?? 'http://localhost:3000';
    return new URL(urlOrPath, base).toString();
  }
}
