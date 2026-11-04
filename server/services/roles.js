import { prisma } from '../db.js';
import { permissionsForRole } from '../middleware/permissions.js';

const ROLE_DESCRIPTIONS = {
  Admin: 'Full application access, including sensitive pricing and user administration.',
  Manager: 'Manage sales operations, providers, bookings, follow-ups, reports, and pricing.',
  'Sales Adviser': 'Manage assigned customers, consultations, quotes, and follow-ups.',
  Viewer: 'Read-only access to permitted operational areas.',
};

export async function seedRoles() {
  for (const [name, description] of Object.entries(ROLE_DESCRIPTIONS)) {
    const role = await prisma.role.upsert({
      where: { name },
      update: { description },
      create: { name, description },
    });
    for (const key of permissionsForRole(name)) {
      const permission = await prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key, description: key === '*' ? 'Administrative wildcard permission.' : `Allows ${key.replace(':', ' ')}.` },
      });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }
}
