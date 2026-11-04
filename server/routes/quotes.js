import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { canSeeProviderCosts, leadScope, requirePermission } from '../middleware/permissions.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
const createSchema = z.object({
  customerId: z.string().uuid(), leadId: z.string().uuid().optional(), providerId: z.string().uuid().optional(),
  trainingCentreId: z.string().uuid().optional(),
  items: z.array(z.object({ priceItemId: z.string().uuid(), quantity: z.number().int().min(1).max(100) }).strict()).min(1).max(50),
  discountPence: z.number().int().min(0).max(100_000_000).default(0),
  depositPence: z.number().int().min(0).max(100_000_000).default(0),
  expiresAt: z.string().datetime().optional(),
}).strict();
const statusSchema = z.object({ status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED']) }).strict();

function scopeForQuote(user) {
  return user.role === 'Sales Adviser'
    ? { OR: [{ createdById: user.id }, { lead: { is: { OR: [{ assignedToId: user.id }, { createdById: user.id }], deletedAt: null } } }] }
    : {};
}

function presentQuote(quote, includeInternal = false) {
  return {
    id: quote.id, status: quote.status, currency: quote.currency,
    leadId: quote.leadId,
    subtotalPence: quote.subtotalPence, vatPence: quote.vatPence, discountPence: quote.discountPence,
    totalPence: quote.totalPence, depositPence: quote.depositPence, balancePence: quote.balancePence,
    expiresAt: quote.expiresAt?.toISOString() || null, createdAt: quote.createdAt.toISOString(), updatedAt: quote.updatedAt.toISOString(),
    customer: quote.customer ? { id: quote.customer.id, firstName: quote.customer.firstName, lastName: quote.customer.lastName, email: quote.customer.email } : undefined,
    items: quote.items?.map(item => ({
      id: item.id, description: item.description, quantity: item.quantity,
      unitPricePence: item.unitPricePence, vatBasisPoints: item.vatBasisPoints, lineTotalPence: item.lineTotalPence,
      ...(includeInternal ? { providerCostPence: item.providerCostPence } : {}),
    })) || [],
  };
}

const quoteInclude = { customer: { select: { id: true, firstName: true, lastName: true, email: true } }, items: { orderBy: { createdAt: 'asc' } } };

router.get('/', requireAuth, requirePermission('quotes:read'), async (req, res, next) => {
  try {
    const quotes = await prisma.quote.findMany({ where: { deletedAt: null, ...scopeForQuote(req.user) }, include: quoteInclude, orderBy: { createdAt: 'desc' }, take: 200 });
    return res.json({ quotes: quotes.map(quote => presentQuote(quote, canSeeProviderCosts(req.user))) });
  } catch (error) { return next(error); }
});

router.post('/', requireAuth, requirePermission('quotes:write'), async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const customer = await prisma.customer.findFirst({ where: { id: input.customerId, deletedAt: null, ...customerOwnership(req.user) }, select: { id: true } });
    if (!customer) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Customer not found.' } });
    if (input.leadId) {
      const lead = await prisma.lead.findFirst({ where: { id: input.leadId, deletedAt: null, ...leadScope(req.user) }, select: { id: true, customerId: true } });
      if (!lead || lead.customerId !== input.customerId) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found.' } });
    }
    const requestedIds = input.items.map(item => item.priceItemId);
    const priceItems = await prisma.priceItem.findMany({ where: { id: { in: requestedIds }, isActive: true } });
    if (priceItems.length !== requestedIds.length) return res.status(400).json({ error: { code: 'PRICE_ITEM_INVALID', message: 'One or more selected prices are unavailable.' } });
    if (new Set(priceItems.map(price => price.providerId)).size > 1) return res.status(400).json({ error: { code: 'PROVIDER_MISMATCH', message: 'A quote must use one provider. Create separate quotes to compare providers.' } });
    if (input.providerId && priceItems.some(price => price.providerId !== input.providerId)) return res.status(400).json({ error: { code: 'PROVIDER_MISMATCH', message: 'All quote items must belong to the selected provider.' } });
    const byId = new Map(priceItems.map(price => [price.id, price]));
    const items = input.items.map(line => {
      const price = byId.get(line.priceItemId);
      const lineTotalPence = price.retailPricePence * line.quantity;
      return { priceItemId: price.id, description: price.description, quantity: line.quantity, unitPricePence: price.retailPricePence, providerCostPence: price.tradeCostPence, vatBasisPoints: price.vatBasisPoints, lineTotalPence, vatPence: Math.round(lineTotalPence * price.vatBasisPoints / 10_000) };
    });
    const subtotalPence = items.reduce((sum, item) => sum + item.lineTotalPence, 0);
    const vatPence = items.reduce((sum, item) => sum + item.vatPence, 0);
    if (input.discountPence > subtotalPence + vatPence) return res.status(400).json({ error: { code: 'DISCOUNT_TOO_HIGH', message: 'Discount cannot exceed the quote amount.' } });
    const totalPence = Math.max(0, subtotalPence + vatPence - input.discountPence);
    if (input.depositPence > totalPence) return res.status(400).json({ error: { code: 'DEPOSIT_TOO_HIGH', message: 'Deposit cannot exceed the quote total.' } });
    const quote = await prisma.$transaction(async tx => {
      const created = await tx.quote.create({
        data: {
          customerId: input.customerId, leadId: input.leadId, providerId: input.providerId || priceItems[0].providerId,
          trainingCentreId: input.trainingCentreId, createdById: req.user.id, subtotalPence, vatPence,
          discountPence: input.discountPence, totalPence, depositPence: input.depositPence,
          balancePence: totalPence - input.depositPence, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          items: { create: items.map(({ vatPence: _vatPence, ...item }) => item) },
        }, include: quoteInclude,
      });
      if (input.leadId) await tx.lead.update({ where: { id: input.leadId }, data: { estimatedPence: totalPence } });
      await tx.activity.create({ data: { customerId: input.customerId, leadId: input.leadId, actorId: req.user.id, type: 'QUOTE_CREATED', summary: `Quote ${created.id} created.` } });
      await tx.auditLog.create({ data: { actorId: req.user.id, action: 'QUOTE_CREATED', resource: 'Quote', resourceId: created.id, ipAddress: req.ip || null } });
      return created;
    });
    return res.status(201).json({ quote: presentQuote(quote, canSeeProviderCosts(req.user)) });
  } catch (error) { return next(error); }
});

router.get('/:id', requireAuth, requirePermission('quotes:read'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const quote = await prisma.quote.findFirst({ where: { id, deletedAt: null, ...scopeForQuote(req.user) }, include: quoteInclude });
    if (!quote) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Quote not found.' } });
    return res.json({ quote: presentQuote(quote, canSeeProviderCosts(req.user)) });
  } catch (error) { return next(error); }
});

router.patch('/:id/status', requireAuth, requirePermission('quotes:write'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = statusSchema.parse(req.body);
    const existing = await prisma.quote.findFirst({ where: { id, deletedAt: null, ...scopeForQuote(req.user) }, select: { id: true, status: true } });
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Quote not found.' } });
    const quote = await prisma.quote.update({ where: { id }, data: { status: input.status }, include: quoteInclude });
    await recordAudit(req, 'QUOTE_STATUS_UPDATED', 'Quote', quote.id, { from: existing.status, to: input.status });
    return res.json({ quote: presentQuote(quote, canSeeProviderCosts(req.user)) });
  } catch (error) { return next(error); }
});

function customerOwnership(user) {
  return user.role === 'Sales Adviser'
    ? { OR: [{ createdById: user.id }, { leads: { some: { OR: [{ assignedToId: user.id }, { createdById: user.id }], deletedAt: null } } }] }
    : {};
}

export default router;
