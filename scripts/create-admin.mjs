import { z } from 'zod';
import { prisma } from '../server/db.js';
import { hashPassword } from '../server/security/credentials.js';
import { seedRoles } from '../server/services/roles.js';

const input = z.object({
  email: z.string().email().max(254),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(14).max(128),
});
const parsed = input.safeParse({
  email: process.env.ADMIN_EMAIL,
  name: process.env.ADMIN_NAME || 'STS Administrator',
  password: process.env.ADMIN_PASSWORD,
});

if (!parsed.success) {
  console.error('Set ADMIN_EMAIL and a unique ADMIN_PASSWORD of at least 14 characters in the environment.');
  process.exitCode = 1;
} else {
  try {
    await seedRoles();
    const email = parsed.data.email.trim().toLowerCase();
    if (await prisma.user.findUnique({ where: { email } })) {
      throw new Error('An account already exists for that email address.');
    }
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'Admin' } });
    await prisma.user.create({
      data: {
        email,
        name: parsed.data.name,
        passwordHash: await hashPassword(parsed.data.password),
        roleId: adminRole.id,
      },
    });
    console.info(`Created administrator account for ${email}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
