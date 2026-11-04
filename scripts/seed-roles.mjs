import { prisma } from '../server/db.js';
import { seedRoles } from '../server/services/roles.js';

try {
  await seedRoles();
  console.info('Default roles and permissions are ready.');
} finally {
  await prisma.$disconnect();
}
