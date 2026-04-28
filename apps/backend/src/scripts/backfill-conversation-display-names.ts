import { PrismaClient } from '@prisma/client';
import { getBestDisplayName } from '../common/waha-normalize';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const conversations = await prisma.conversation.findMany({
    include: {
      contact: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  let reviewed = 0;
  let changed = 0;

  for (const conversation of conversations) {
    reviewed += 1;

    const normalizedDisplayName = getBestDisplayName(
      {
        id: conversation.chatJid,
        subject: conversation.subject,
        name: conversation.displayName,
        pushName: conversation.pushName,
      },
      {
        displayName: conversation.contact.displayName,
        phone: conversation.contact.phone,
        whatsappJid: conversation.contact.whatsappJid,
      },
    );

    const nextConversationName = shouldReplaceDisplayName(
      conversation.displayName,
      conversation.chatJid,
    )
      ? normalizedDisplayName
      : conversation.displayName;

    const nextContactName = shouldReplaceDisplayName(
      conversation.contact.displayName,
      conversation.contact.whatsappJid,
    )
      ? normalizedDisplayName
      : conversation.contact.displayName;

    if (
      nextConversationName === conversation.displayName &&
      nextContactName === conversation.contact.displayName
    ) {
      continue;
    }

    changed += 1;

    console.log(
      JSON.stringify(
        {
          conversationId: conversation.id,
          chatJid: conversation.chatJid,
          current: conversation.displayName,
          next: nextConversationName,
          contactCurrent: conversation.contact.displayName,
          contactNext: nextContactName,
        },
        null,
        2,
      ),
    );

    if (!apply) {
      continue;
    }

    await prisma.$transaction([
      prisma.contact.update({
        where: { id: conversation.contactId },
        data: {
          displayName: nextContactName ?? undefined,
        },
      }),
      prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          displayName: nextConversationName ?? undefined,
        },
      }),
    ]);
  }

  console.log(
    JSON.stringify(
      {
        apply,
        reviewed,
        changed,
        note: apply
          ? 'Backfill applied.'
          : 'Dry run only. Re-run with --apply to persist changes.',
      },
      null,
      2,
    ),
  );
}

function shouldReplaceDisplayName(value?: string | null, jid?: string | null) {
  if (!value) return true;
  if (!jid) return false;

  const normalizedValue = value.trim().toLowerCase();
  const normalizedJid = jid.trim().toLowerCase();
  if (normalizedValue === normalizedJid) return true;
  return /@(?:c\.us|g\.us|newsletter|broadcast|lid)$/i.test(value);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
