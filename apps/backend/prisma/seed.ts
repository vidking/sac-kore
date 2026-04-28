import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123456';
  const sessionName = process.env.WAHA_SESSION ?? 'default';

  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      name: 'Admin',
      email,
      role: UserRole.admin,
      passwordHash: await bcrypt.hash(password, 10),
    },
  });

  const tags = [
    { name: 'ventas', color: '#2563eb' },
    { name: 'soporte', color: '#059669' },
    { name: 'urgente', color: '#dc2626' },
    { name: 'seguimiento', color: '#d97706' },
  ];

  for (const tag of tags) {
    await prisma.tag.upsert({
      where: { name: tag.name },
      update: { color: tag.color },
      create: tag,
    });
  }

  await prisma.channel.upsert({
    where: { sessionName },
    update: {},
    create: {
      sessionName,
      status: 'unknown',
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
