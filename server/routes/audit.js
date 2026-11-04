import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/permissions.js';

const router = Router();

router.get('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const query = z.object({ resource: z.string().max(80).optional(), actorId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), before: z.string().datetime().optional() }).parse(req.query);
    const logs = await prisma.auditLog.findMany({
      where: {
        ...(query.resource ? { resource: query.resource } : {}), ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}),
      },
      include: { actor: { select: { id: true, name: true, email: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit,
    });
    return res.json({ logs: logs.map(log => ({ ...log, metadata: log.metadata ? JSON.parse(log.metadata) : null })) });
  } catch (error) { return next(error); }
});

export default router;
