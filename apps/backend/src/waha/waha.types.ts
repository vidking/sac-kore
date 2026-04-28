export type WahaWebhookEvent = {
  event: string;
  session: string;
  engine?: string;
  me?: {
    id?: string;
    pushName?: string;
  };
  payload?: Record<string, any>;
  environment?: Record<string, any>;
};

export type WahaMessagePayload = {
  id: string;
  timestamp?: number;
  from?: string;
  fromMe?: boolean;
  to?: string;
  chatId?: string;
  participant?: string;
  body?: string;
  hasMedia?: boolean;
  media?: {
    url?: string;
    mimetype?: string;
    filename?: string;
    error?: string | null;
  } | null;
  ack?: number;
  ackName?: string;
  _data?: Record<string, any>;
};
