import { prisma } from '../server/db.js';

try {
  await prisma.$connect();
  const roles = await prisma.role.count();
  console.log(`Connected to ${process.env.DATABASE_PROVIDER || 'sqlite'} development database; ${roles} roles seeded`);
} finally {
  await prisma.$disconnect();
}
