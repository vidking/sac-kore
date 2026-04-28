export const QUEUE_NAMES = {
  inbound: 'waha-inbound',
  outbox: 'waha-outbox',
  resync: 'waha-resync',
  media: 'waha-media',
} as const;

export const JOB_NAMES = {
  processWahaEvent: 'process-event',
  sendText: 'send-text',
  resyncSession: 'session',
  downloadMedia: 'download',
} as const;
