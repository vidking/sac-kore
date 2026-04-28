import { OutboxStatus, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const failed = await prisma.outboxMessage.findMany({
    where: {
      status: OutboxStatus.failed,
    },
    include: {
      message: true,
      conversation: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });

  const summary = {
    total: failed.length,
    reconciled: 0,
    markedPermanent: 0,
    skipped: 0,
  };

  for (const outbox of failed) {
    const hasLegacyUniqueError = (outbox.lastError ?? '')
      .toLowerCase()
      .includes('unique constraint failed');

    const candidate =
      outbox.message.body
        ? await prisma.message.findFirst({
            where: {
              conversationId: outbox.conversationId,
              direction: 'outbound',
              body: outbox.message.body,
              externalMessageId: { not: { startsWith: 'local:' } },
              createdAt: {
                gte: new Date(outbox.createdAt.getTime() - 30 * 60_000),
                lte: new Date(outbox.createdAt.getTime() + 30 * 60_000),
              },
            },
            include: {
              outbox: true,
            },
            orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }],
          })
        : null;

    if (candidate && (!candidate.outbox || candidate.outbox.id === outbox.id)) {
      summary.reconciled += 1;
      if (apply) {
        await prisma.$transaction(async (tx) => {
          await tx.outboxMessage.update({
            where: { id: outbox.id },
            data: {
              messageId: candidate.id,
              status: OutboxStatus.reconciled,
              lastError: 'Reconciled legacy failed outbox with provider message',
              reconciledAt: new Date(),
              resolvedAt: new Date(),
              sentAt: candidate.providerTimestamp ?? outbox.sentAt ?? new Date(),
            },
          });

          if (candidate.id !== outbox.messageId) {
            await tx.message.delete({
              where: { id: outbox.messageId },
            });
          }
        });
      }
      continue;
    }

    if (hasLegacyUniqueError) {
      summary.markedPermanent += 1;
      if (apply) {
        await prisma.outboxMessage.update({
          where: { id: outbox.id },
          data: {
            status: OutboxStatus.permanently_failed,
            resolvedAt: new Date(),
            lastError:
              outbox.lastError ??
              'Marked permanently failed after legacy outbox reconciliation',
          },
        });
      }
      continue;
    }

    summary.skipped += 1;
  }

  console.log(
    JSON.stringify(
      {
        apply,
        ...summary,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
