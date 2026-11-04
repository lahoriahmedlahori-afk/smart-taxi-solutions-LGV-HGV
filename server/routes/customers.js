import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { customerScope, requirePermission } from '../middleware/permissions.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
const dateValue = z.union([z.string().date(), z.literal('')]).optional();
const customerSchema = z.object({
  firstName: z.string().trim().max(100).optional(), lastName: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(40).optional(), email: z.union([z.string().email().max(254), z.literal('')]).optional(),
  postcode: z.string().trim().max(20).optional(), city: z.string().trim().max(100).optional(),
  dateOfBirth: dateValue, contactPreference: z.string().trim().max(40).optional(),
  leadSource: z.string().trim().max(80).optional(), preferredLocation: z.string().trim().max(150).optional(),
  preferredDates: z.string().trim().max(250).optional(), budgetPence: z.number().int().min(0).max(100_000_000).nullable().optional(),
  paymentPreference: z.string().trim().max(100).optional(),
}).strict();

function transform(input) {
  const data = { ...input };
  if (Object.hasOwn(data, 'email')) data.email = data.email?.trim().toLowerCase() || null;
  if (Object.hasOwn(data, 'dateOfBirth')) data.dateOfBirth = data.dateOfBirth ? new Date(`${data.dateOfBirth}T00:00:00.000Z`) : null;
  for (const key of ['firstName', 'lastName', 'phone', 'postcode', 'city', 'contactPreference', 'leadSource', 'preferredLocation', 'preferredDates', 'paymentPreference']) {
    if (Object.hasOwn(data, key) && !data[key]) data[key] = null;
  }
  return data;
}

const selectCustomer = {
  id: true, firstName: true, lastName: true, phone: true, email: true, postcode: true, city: true,
  dateOfBirth: true, contactPreference: true, leadSource: true, preferredLocation: true, preferredDates: true,
  budgetPence: true, paymentPreference: true, createdAt: true, updatedAt: true,
};

router.get('/', requireAuth, requirePermission('customers:read'), async (req, res, next) => {
  try {
    const query = z.object({ search: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(250).default(100) }).parse(req.query);
    const search = query.search?.trim();
    const where = {
      deletedAt: null,
      AND: [
        customerScope(req.user),
        ...(search ? [{ OR: [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        ] }] : []),
      ],
    };
    const customers = await prisma.customer.findMany({ where, select: selectCustomer, orderBy: { updatedAt: 'desc' }, take: query.limit });
    return res.json({ customers });
  } catch (error) { return next(error); }
});

router.get('/:id', requireAuth, requirePermission('customers:read'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const customer = await prisma.customer.findFirst({
      where: { id, deletedAt: null, ...customerScope(req.user) },
      select: {
        ...selectCustomer,
        leads: { where: { deletedAt: null }, orderBy: { updatedAt: 'desc' }, take: 30, select: { id: true, status: true, route: true, estimatedPence: true, updatedAt: true } },
        consultations: { where: { deletedAt: null }, orderBy: { updatedAt: 'desc' }, take: 20, select: { id: true, route: true, status: true, progress: true, currentStage: true, updatedAt: true } },
      },
    });
    if (!customer) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Customer not found.' } });
    return res.json({ customer });
  } catch (error) { return next(error); }
});

router.post('/', requireAuth, requirePermission('customers:write'), async (req, res, next) => {
  try {
    const input = customerSchema.parse(req.body);
    if (![input.firstName, input.lastName, input.phone, input.email].some(Boolean)) return res.status(400).json({ error: { code: 'CUSTOMER_REQUIRED', message: 'Provide a name, phone number or email address.' } });
    const customer = await prisma.customer.create({ data: { ...transform(input), createdById: req.user.id }, select: selectCustomer });
    await recordAudit(req, 'CUSTOMER_CREATED', 'Customer', customer.id);
    return res.status(201).json({ customer });
  } catch (error) { return next(error); }
});

router.patch('/:id', requireAuth, requirePermission('customers:write'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = customerSchema.partial().strict().parse(req.body);
    const existing = await prisma.customer.findFirst({ where: { id, deletedAt: null, ...customerScope(req.user) }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Customer not found.' } });
    const customer = await prisma.customer.update({ where: { id }, data: transform(input), select: selectCustomer });
    await recordAudit(req, 'CUSTOMER_UPDATED', 'Customer', customer.id, { fields: Object.keys(input) });
    return res.json({ customer });
  } catch (error) { return next(error); }
});

router.delete('/:id', requireAuth, requirePermission('customers:write'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const result = await prisma.customer.updateMany({ where: { id, deletedAt: null, ...customerScope(req.user) }, data: { deletedAt: new Date() } });
    if (!result.count) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Customer not found.' } });
    await recordAudit(req, 'CUSTOMER_SOFT_DELETED', 'Customer', id);
    return res.status(204).end();
  } catch (error) { return next(error); }
});

export default router;
