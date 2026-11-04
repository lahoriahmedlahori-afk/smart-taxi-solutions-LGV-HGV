import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
const createSchema = z.object({
  customerId: z.string().uuid(), leadId: z.string().uuid().optional(), quoteId: z.string().uuid().optional(),
  courseId: z.string().uuid().optional(), startsAt: z.string().datetime().optional(),
  depositPence: z.number().int().min(0).max(100_000_000).default(0), notes: z.string().max(3_000).optional(),
}).strict();
const updateSchema = z.object({
  status: z.enum(['PREPARING', 'CONFIRMED', 'CANCELLED', 'STARTED', 'COMPLETED', 'TEST_SCHEDULED', 'PASSED', 'FAILED_RETEST']).optional(),
  startsAt: z.string().datetime().nullable().optional(), notes: z.string().max(3_000).nullable().optional(),
  entitlementVerified: z.boolean().optional(), requirementsVerified: z.boolean().optional(), providerConfirmed: z.boolean().optional(),
}).strict();

router.get('/', requireAuth, requirePermission('bookings:read'), async (_req, res, next) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: { deletedAt: null },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
        course: { include: { provider: { select: { id: true, name: true } }, trainingCentre: { select: { id: true, name: true, location: true } } } },
        quote: { select: { id: true, status: true, totalPence: true, balancePence: true } },
      },
      orderBy: [{ startsAt: 'asc' }, { createdAt: 'desc' }], take: 300,
    });
    return res.json({ bookings });
  } catch (error) { return next(error); }
});

router.post('/', requireAuth, requirePermission('bookings:write'), async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const customer = await prisma.customer.findFirst({ where: { id: input.customerId, deletedAt: null }, select: { id: true } });
    if (!customer) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Customer not found.' } });
    if (input.leadId) {
      const lead = await prisma.lead.findFirst({ where: { id: input.leadId, customerId: input.customerId, deletedAt: null }, select: { id: true } });
      if (!lead) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found.' } });
    }
    let quote;
    if (input.quoteId) {
      quote = await prisma.quote.findFirst({ where: { id: input.quoteId, customerId: input.customerId, deletedAt: null, status: { in: ['SENT', 'ACCEPTED'] } }, select: { id: true, totalPence: true, depositPence: true, balancePence: true } });
      if (!quote) return res.status(400).json({ error: { code: 'QUOTE_NOT_BOOKABLE', message: 'A sent or accepted quote for this customer is required.' } });
    }
    const course = input.courseId ? await prisma.course.findFirst({ where: { id: input.courseId, status: 'AVAILABLE' }, select: { id: true, placesAvailable: true } }) : null;
    if (input.courseId && (!course || course.placesAvailable !== null && course.placesAvailable < 1)) return res.status(409).json({ error: { code: 'COURSE_UNAVAILABLE', message: 'The selected course has no available places.' } });
    if (quote && input.depositPence > quote.totalPence) return res.status(400).json({ error: { code: 'DEPOSIT_TOO_HIGH', message: 'Deposit cannot exceed the accepted quote total.' } });
    const booking = await prisma.$transaction(async tx => {
      if (input.courseId && course.placesAvailable !== null) {
        const seat = await tx.course.updateMany({
          where: { id: input.courseId, status: 'AVAILABLE', placesAvailable: { gte: 1 } },
          data: { placesAvailable: { decrement: 1 } },
        });
        if (!seat.count) return null;
      }
      const created = await tx.booking.create({
        data: {
          customerId: input.customerId, leadId: input.leadId, quoteId: input.quoteId, courseId: input.courseId,
          createdById: req.user.id, status: 'PREPARING', startsAt: input.startsAt ? new Date(input.startsAt) : undefined,
          depositPence: input.depositPence, outstandingPence: quote ? quote.totalPence - input.depositPence : 0, notes: input.notes,
        },
        include: { customer: true, course: { include: { provider: true, trainingCentre: true } }, quote: true },
      });
      await tx.activity.create({ data: { customerId: input.customerId, leadId: input.leadId, actorId: req.user.id, type: 'BOOKING_PREPARED', summary: `Booking preparation ${created.id} created.` } });
      await tx.auditLog.create({ data: { actorId: req.user.id, action: 'BOOKING_PREPARED', resource: 'Booking', resourceId: created.id, ipAddress: req.ip || null } });
      return created;
    });
    if (!booking) return res.status(409).json({ error: { code: 'COURSE_UNAVAILABLE', message: 'The selected course has no places available.' } });
    return res.status(201).json({ booking });
  } catch (error) { return next(error); }
});

router.patch('/:id', requireAuth, requirePermission('bookings:write'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = updateSchema.parse(req.body);
    if (input.status === 'CONFIRMED' && !(input.entitlementVerified && input.requirementsVerified && input.providerConfirmed)) {
      return res.status(400).json({ error: { code: 'BOOKING_CHECKS_REQUIRED', message: 'Confirm licence entitlement, applicable requirements, and provider availability before booking.' } });
    }
    const existing = await prisma.booking.findFirst({ where: { id, deletedAt: null }, select: { id: true, status: true } });
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Booking not found.' } });
    const { entitlementVerified, requirementsVerified, providerConfirmed, ...changes } = input;
    const data = { ...changes, ...(changes.startsAt ? { startsAt: new Date(changes.startsAt) } : {}) };
    const booking = await prisma.booking.update({ where: { id }, data, include: { customer: true, course: { include: { provider: true, trainingCentre: true } }, quote: true } });
    await recordAudit(req, 'BOOKING_UPDATED', 'Booking', id, { from: existing.status, to: input.status, verification: input.status === 'CONFIRMED' ? { entitlementVerified, requirementsVerified, providerConfirmed } : undefined });
    return res.json({ booking });
  } catch (error) { return next(error); }
});

router.post('/:id/payments', requireAuth, requirePermission('bookings:write'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = z.object({ amountPence: z.number().int().positive().max(100_000_000), paymentMethod: z.string().max(80).optional(), externalRef: z.string().max(160).optional(), receivedAt: z.string().datetime().optional() }).strict().parse(req.body);
    const booking = await prisma.booking.findFirst({ where: { id, deletedAt: null }, select: { id: true, quoteId: true, outstandingPence: true } });
    if (!booking) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Booking not found.' } });
    if (input.amountPence > booking.outstandingPence) return res.status(400).json({ error: { code: 'PAYMENT_TOO_HIGH', message: 'Payment cannot exceed the outstanding balance.' } });
    const payment = await prisma.$transaction(async tx => {
      const bookingBalance = await tx.booking.updateMany({ where: { id, deletedAt: null, outstandingPence: { gte: input.amountPence } }, data: { outstandingPence: { decrement: input.amountPence } } });
      if (!bookingBalance.count) throw Object.assign(new Error('PAYMENT_TOO_HIGH'), { code: 'PAYMENT_TOO_HIGH' });
      if (booking.quoteId) {
        const quoteBalance = await tx.quote.updateMany({ where: { id: booking.quoteId, balancePence: { gte: input.amountPence } }, data: { balancePence: { decrement: input.amountPence } } });
        if (!quoteBalance.count) throw Object.assign(new Error('PAYMENT_TOO_HIGH'), { code: 'PAYMENT_TOO_HIGH' });
      }
      const created = await tx.payment.create({ data: { bookingId: id, quoteId: booking.quoteId, amountPence: input.amountPence, paymentMethod: input.paymentMethod, externalRef: input.externalRef, receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(), status: 'RECEIVED' } });
      await tx.auditLog.create({ data: { actorId: req.user.id, action: 'BOOKING_PAYMENT_RECORDED', resource: 'Payment', resourceId: created.id, ipAddress: req.ip || null } });
      return created;
    });
    return res.status(201).json({ payment });
  } catch (error) {
    if (error.code === 'PAYMENT_TOO_HIGH') return res.status(409).json({ error: { code: 'PAYMENT_TOO_HIGH', message: 'The current outstanding balance is lower than this payment.' } });
    return next(error);
  }
});

export default router;
