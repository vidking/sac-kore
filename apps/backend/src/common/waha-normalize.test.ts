import assert = require('node:assert/strict');
import { ConversationType } from '@prisma/client';
import {
  detectJidType,
  getBestDisplayName,
  getDedupeKey,
  isHiddenConversationType,
  normalizeWahaChat,
  normalizeWahaEvent,
  normalizeWahaMessage,
  pickParticipantJid,
} from './waha-normalize';

assert.equal(detectJidType('50685380882@c.us'), ConversationType.direct);
assert.equal(detectJidType('120363423551289078@g.us'), ConversationType.group);
assert.equal(detectJidType('120363310730660132@newsletter'), ConversationType.newsletter);
assert.equal(detectJidType('status@broadcast'), ConversationType.status);
assert.equal(detectJidType('foo@broadcast'), ConversationType.broadcast);
assert.equal(detectJidType('148395465421006@lid'), ConversationType.system);
assert.equal(isHiddenConversationType(ConversationType.status), true);
assert.equal(isHiddenConversationType(ConversationType.broadcast), true);

assert.equal(
  getBestDisplayName({
    id: '120363423551289078@g.us',
    subject: 'Guaro o se caga',
  }),
  'Guaro o se caga',
);

assert.equal(
  getBestDisplayName({
    id: '120363423551289078@g.us',
  }),
  'Grupo 9078',
);

assert.equal(
  normalizeWahaChat({
    id: '50685380882@c.us',
    pushName: 'David',
  }).displayName,
  'David',
);

assert.equal(
  normalizeWahaChat({
    id: '50685380882@c.us',
  }).displayName,
  '+506 8538 0882',
);

assert.equal(
  normalizeWahaChat({
    id: '120363310730660132@newsletter',
  }).displayName,
  'Canal 0132',
);

const groupMessage = normalizeWahaMessage({
  id: { _serialized: 'msg-1', remote: '120363423551289078@g.us' },
  chatId: '120363423551289078@g.us',
  from: '120363423551289078@g.us',
  participant: '24786390507712@lid',
  notifyName: 'Bryan',
  body: 'Que duro',
  timestamp: 1714168140,
});

assert.equal(groupMessage.chatJid, '120363423551289078@g.us');
assert.equal(groupMessage.participantJid, '24786390507712@lid');
assert.equal(groupMessage.senderName, 'Bryan');
assert.equal(pickParticipantJid(groupMessage), null);

const lidMessage = normalizeWahaMessage({
  id: { _serialized: 'msg-1b', remote: '120363423551289078@g.us' },
  chatId: '120363423551289078@g.us',
  from: '120363423551289078@g.us',
  participant: '148395465421006@lid',
  pushName: 'Jose Ramirez',
  body: 'Hola',
  timestamp: 1714168140,
});

assert.equal(lidMessage.senderName, 'Jose Ramirez');

const stickerMessage = normalizeWahaMessage({
  id: { _serialized: 'msg-2', remote: '50685380882@c.us' },
  chatId: '50685380882@c.us',
  type: 'sticker',
  hasMedia: true,
  media: {
    url: 'http://localhost:3000/media/sticker.webp',
    mimetype: 'image/webp',
  },
  timestamp: 1714168141,
});

assert.equal(stickerMessage.type, 'sticker');
assert.equal(stickerMessage.media?.url, 'http://localhost:3000/media/sticker.webp');

const mediaDescriptor = normalizeWahaMessage({
  id: { _serialized: 'msg-4', remote: '50685380882@c.us' },
  chatId: '50685380882@c.us',
  type: 'image',
  media: {
    url: '/media/image-1.jpg',
    mimetype: 'image/jpeg',
    thumbnailBase64: 'data:image/jpeg;base64,ZmFrZQ==',
    mediaKey: 'key-1',
    id: 'media-1',
  },
  timestamp: 1714168143,
});

assert.equal(mediaDescriptor.media?.providerMediaId, 'media-1');
assert.equal(mediaDescriptor.media?.thumbnailBase64, 'data:image/jpeg;base64,ZmFrZQ==');

const reactionMessage = normalizeWahaMessage({
  id: { _serialized: 'msg-3', remote: '50685380882@c.us' },
  chatId: '50685380882@c.us',
  type: 'reaction',
  reaction: {
    text: '🔥',
    messageId: { _serialized: 'target-1' },
  },
  timestamp: 1714168142,
});

assert.equal(reactionMessage.type, 'reaction');
assert.equal(reactionMessage.reaction.emoji, '🔥');
assert.equal(reactionMessage.reaction.targetExternalMessageId, 'target-1');

const dedupeKey = getDedupeKey({
  event: 'message.any',
  session: 'default',
  payload: { id: { _serialized: 'msg-3', remote: '50685380882@c.us' } },
});

assert.equal(dedupeKey, 'default:message:msg-3');
assert.equal(normalizeWahaEvent({
  event: 'message',
  session: 'default',
  payload: { id: { _serialized: 'msg-3', remote: '50685380882@c.us' } },
}).eventFamily, 'message');

console.log('waha-normalize tests passed');
