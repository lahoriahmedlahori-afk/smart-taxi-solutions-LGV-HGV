import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { hashPassword } from '../security/credentials.js';
import { requireRole } from '../middleware/permissions.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
const roles = ['Admin', 'Manager', 'Sales Adviser', 'Viewer'];
const createSchema = z.object({ email: z.string().email().max(254), name: z.string().trim().min(2).max(120), password: z.string().min(14).max(128), role: z.enum(roles) }).strict();
const updateSchema = z.object({ name: z.string().trim().min(2).max(120).optional(), role: z.enum(roles).optional(), isActive: z.boolean().optional() }).strict();

router.get('/', requireAuth, requireRole('Admin', 'Manager'), async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({ where: { deletedAt: null }, select: { id: true, email: true, name: true, isActive: true, lastLoginAt: true, createdAt: true, updatedAt: true, role: { select: { name: true } } }, orderBy: { name: 'asc' } });
    return res.json({ users: users.map(user => ({ ...user, role: user.role.name })) });
  } catch (error) { return next(error); }
});

router.post('/', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const role = await prisma.role.findUniqueOrThrow({ where: { name: input.role } });
    const user = await prisma.user.create({ data: { email: input.email.trim().toLowerCase(), name: input.name, passwordHash: await hashPassword(input.password), roleId: role.id }, include: { role: true } });
    await recordAudit(req, 'USER_CREATED', 'User', user.id, { role: input.role });
    return res.status(201).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role.name, isActive: user.isActive } });
  } catch (error) { return next(error); }
});

router.patch('/:id', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = updateSchema.parse(req.body);
    if (id === req.user.id && input.isActive === false) return res.status(400).json({ error: { code: 'SELF_DEACTIVATION', message: 'You cannot deactivate your own account.' } });
    const data = { ...input };
    if (input.role) data.roleId = (await prisma.role.findUniqueOrThrow({ where: { name: input.role } })).id;
    delete data.role;
    const user = await prisma.user.update({ where: { id }, data, include: { role: true } });
    if (input.isActive === false || input.role) await prisma.authSession.deleteMany({ where: { userId: id } });
    await recordAudit(req, 'USER_UPDATED', 'User', id, { fields: Object.keys(input) });
    return res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role.name, isActive: user.isActive } });
  } catch (error) { return next(error); }
});

router.post('/:id/password', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = z.object({ password: z.string().min(14).max(128) }).strict().parse(req.body);
    await prisma.$transaction([
      prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(input.password), failedLoginAttempts: 0, lockedUntil: null } }),
      prisma.authSession.deleteMany({ where: { userId: id } }),
      prisma.auditLog.create({ data: { actorId: req.user.id, action: 'ADMIN_PASSWORD_RESET', resource: 'User', resourceId: id, ipAddress: req.ip || null } }),
    ]);
    return res.status(204).end();
  } catch (error) { return next(error); }
});

export default router;
