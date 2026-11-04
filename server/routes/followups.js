import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { leadScope, requirePermission } from '../middleware/permissions.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
const reasons = ['Call back', 'Quote follow-up', 'Awaiting documents', 'Awaiting medical', 'Awaiting theory', 'Awaiting payment', 'Check training dates', 'Retest', 'General follow-up'];
const createSchema = z.object({
  customerId: z.string().uuid(), leadId: z.string().uuid().optional(),
  reason: z.enum(reasons), dueAt: z.string().datetime(), notes: z.string().max(2_000).optional(), assignedToId: z.string().uuid().optional(),
}).strict();
const updateSchema = z.object({
  reason: z.enum(reasons).optional(), dueAt: z.string().datetime().optional(),
  status: z.enum(['OPEN', 'COMPLETED', 'CANCELLED']).optional(), notes: z.string().max(2_000).nullable().optional(),
}).strict();

function scope(user) {
  return user.role === 'Sales Adviser'
    ? { OR: [{ createdById: user.id }, { assignedToId: user.id }, { lead: { is: { OR: [{ assignedToId: user.id }, { createdById: user.id }], deletedAt: null } } }] }
    : {};
}

router.get('/', requireAuth, requirePermission('followups:read'), async (req, res, next) => {
  try {
    const query = z.object({ status: z.enum(['OPEN', 'COMPLETED', 'CANCELLED']).optional(), overdue: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(300).default(100) }).parse(req.query);
    const followUps = await prisma.followUp.findMany({
      where: {
        deletedAt: null, ...scope(req.user), ...(query.status ? { status: query.status } : {}),
        ...(query.overdue ? { status: 'OPEN', dueAt: { lt: new Date() } } : {}),
      },
      include: { customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } }, lead: { select: { id: true, route: true, status: true } }, assignedTo: { select: { id: true, name: true } } },
      orderBy: { dueAt: 'asc' }, take: query.limit,
    });
    return res.json({ followUps });
  } catch (error) { return next(error); }
});

router.post('/', requireAuth, requirePermission('followups:write'), async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const customer = await prisma.customer.findFirst({ where: { id: input.customerId, deletedAt: null, ...customerScope(req.user) }, select: { id: true } });
    if (!customer) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Customer not found.' } });
    if (input.leadId) {
      const lead = await prisma.lead.findFirst({ where: { id: input.leadId, customerId: input.customerId, deletedAt: null, ...leadScope(req.user) }, select: { id: true } });
      if (!lead) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found.' } });
    }
    if (input.assignedToId && input.assignedToId !== req.user.id && !['Admin', 'Manager'].includes(req.user.role)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only managers can assign follow-ups to another user.' } });
    const followUp = await prisma.followUp.create({ data: { ...input, dueAt: new Date(input.dueAt), createdById: req.user.id, assignedToId: input.assignedToId || req.user.id }, include: { customer: true, lead: true } });
    await recordAudit(req, 'FOLLOWUP_CREATED', 'FollowUp', followUp.id, { dueAt: followUp.dueAt.toISOString(), reason: followUp.reason });
    return res.status(201).json({ followUp });
  } catch (error) { return next(error); }
});

router.patch('/:id', requireAuth, requirePermission('followups:write'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = updateSchema.parse(req.body);
    const existing = await prisma.followUp.findFirst({ where: { id, deletedAt: null, ...scope(req.user) }, select: { id: true, status: true } });
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Follow-up not found.' } });
    const data = { ...input, ...(input.dueAt ? { dueAt: new Date(input.dueAt) } : {}), ...(input.status === 'COMPLETED' ? { completedAt: new Date() } : {}) };
    delete data.dueAtString;
    const followUp = await prisma.followUp.update({ where: { id }, data, include: { customer: true, lead: true } });
    await recordAudit(req, 'FOLLOWUP_UPDATED', 'FollowUp', id, { fields: Object.keys(input) });
    return res.json({ followUp });
  } catch (error) { return next(error); }
});

function customerScope(user) {
  return user.role === 'Sales Adviser'
    ? { OR: [{ createdById: user.id }, { leads: { some: { OR: [{ assignedToId: user.id }, { createdById: user.id }], deletedAt: null } } }] }
    : {};
}

export default router;
