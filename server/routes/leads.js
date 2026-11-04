import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { leadScope, requirePermission } from '../middleware/permissions.js';
import { recordAudit } from '../services/audit.js';
import { validateAnswer } from '../services/rule-engine.js';

const router = Router();
const statuses = ['New Lead', 'Contacted', 'Consultation Started', 'Qualified', 'Awaiting Documents', 'Awaiting Medical', 'Awaiting Theory', 'Quote Sent', 'Considering', 'Follow-up Required', 'Deposit Pending', 'Booked', 'Training Started', 'Test Scheduled', 'Completed', 'Passed', 'Failed / Retest', 'Lost'];
const optionalText = max => z.string().trim().max(max).optional();
const profileSchema = z.object({
  first: optionalText(100),
  last: optionalText(100),
  phone: optionalText(40),
  email: z.union([z.string().email().max(254), z.literal('')]).optional(),
  postcode: optionalText(20),
  city: optionalText(100),
  dob: z.union([z.string().date(), z.literal('')]).optional(),
  contact: optionalText(40),
  source: optionalText(80),
  location: optionalText(150),
  dates: optionalText(250),
  budget: optionalText(100),
  payment: optionalText(100),
}).strict();
const answersSchema = z.record(z.string().min(1).max(80), z.unknown())
  .refine(value => JSON.stringify(value).length <= 64_000, 'Answers are too large')
  .superRefine((answers, context) => {
    for (const [key, value] of Object.entries(answers)) {
      if (!validateAnswer(key, value)) context.addIssue({ code: 'custom', path: [key], message: 'Answer does not match the consultation question.' });
    }
  });
const createSchema = z.object({
  profile: profileSchema.default({}),
  answers: answersSchema.default({}),
  route: z.string().trim().max(40).optional(),
  status: z.enum(statuses).default('Consultation Started'),
  estimatePence: z.number().int().min(0).max(100_000_000).optional(),
  notes: z.string().max(10_000).optional(),
  clientDraftKey: z.string().uuid().optional(),
  progress: z.number().int().min(0).max(100).default(0),
  currentStage: z.string().max(80).default('Customer details'),
}).strict();
const updateSchema = z.object({
  status: z.enum(statuses).optional(),
  route: z.string().trim().max(40).nullable().optional(),
  estimatePence: z.number().int().min(0).max(100_000_000).optional(),
  assignedToId: z.string().uuid().optional(),
}).strict();

function customerData(profile, createdById) {
  return {
    firstName: profile.first || null,
    lastName: profile.last || null,
    phone: profile.phone || null,
    email: profile.email?.trim().toLowerCase() || null,
    postcode: profile.postcode || null,
    city: profile.city || null,
    dateOfBirth: profile.dob ? new Date(`${profile.dob}T00:00:00.000Z`) : null,
    contactPreference: profile.contact || null,
    leadSource: profile.source || null,
    preferredLocation: profile.location || null,
    preferredDates: profile.dates || null,
    paymentPreference: profile.payment || null,
    createdById,
  };
}

function customerUpdateData(profile) {
  const fields = {
    first: 'firstName', last: 'lastName', phone: 'phone', email: 'email', postcode: 'postcode',
    city: 'city', dob: 'dateOfBirth', contact: 'contactPreference', source: 'leadSource',
    location: 'preferredLocation', dates: 'preferredDates', payment: 'paymentPreference',
  };
  return Object.fromEntries(Object.entries(fields)
    .filter(([source]) => Object.hasOwn(profile, source))
    .map(([source, target]) => [target, source === 'dob' ? profile[source] ? new Date(`${profile[source]}T00:00:00.000Z`) : null : profile[source] || null]));
}

function presentLead(lead) {
  const customer = lead.customer;
  const followUp = lead.followUps?.[0];
  const consultation = lead.consultations?.[0];
  return {
    id: lead.id,
    customerId: lead.customerId,
    name: [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'New customer',
    phone: customer.phone || '',
    email: customer.email || '',
    route: lead.route || 'To be confirmed',
    status: lead.status,
    quote: (lead.estimatedPence || 0) / 100,
    followup: followUp?.dueAt?.toISOString() || '',
    followupReason: followUp?.reason || '',
    created: lead.createdAt.toISOString(),
    updated: lead.updatedAt.toISOString(),
    profile: {
      first: customer.firstName || '', last: customer.lastName || '', phone: customer.phone || '',
      email: customer.email || '', postcode: customer.postcode || '', city: customer.city || '',
      dob: customer.dateOfBirth?.toISOString().slice(0, 10) || '', contact: customer.contactPreference || 'Phone',
      source: customer.leadSource || 'Inbound call', location: customer.preferredLocation || '',
      dates: customer.preferredDates || '', payment: customer.paymentPreference || '',
    },
    answers: consultation?.answers?.filter(answer => answer.confirmed).reduce((result, answer) => ({ ...result, [answer.questionKey]: JSON.parse(answer.answerJson) }), {}) || {},
    notes: consultation?.callNotes || '',
  };
}

router.get('/', requireAuth, requirePermission('leads:read'), async (req, res, next) => {
  try {
    const leads = await prisma.lead.findMany({
      where: { ...leadScope(req.user), deletedAt: null },
      include: {
        customer: true,
        followUps: { where: { status: 'OPEN', deletedAt: null }, orderBy: { dueAt: 'asc' }, take: 1 },
        consultations: { where: { deletedAt: null }, include: { answers: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
      take: 250,
    });
    return res.json({ leads: leads.map(presentLead) });
  } catch (error) {
    return next(error);
  }
});

router.post('/', requireAuth, requirePermission('leads:write'), async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    if (![input.profile.first, input.profile.last, input.profile.phone, input.profile.email].some(Boolean)) {
      return res.status(400).json({ error: { code: 'CUSTOMER_REQUIRED', message: 'Provide a customer name, telephone number or email address.' } });
    }

    const result = await prisma.$transaction(async tx => {
      let draft = input.clientDraftKey
        ? await tx.consultation.findUnique({ where: { clientDraftKey: input.clientDraftKey }, include: { customer: true, lead: { include: { customer: true, followUps: true } } } })
        : null;
      if (draft && draft.createdById !== req.user.id && req.user.role === 'Sales Adviser') {
        return null;
      }
      const customer = draft
        ? await tx.customer.update({ where: { id: draft.customerId }, data: customerUpdateData(input.profile) })
        : await tx.customer.create({ data: customerData(input.profile, req.user.id) });
      const leadData = {
        customerId: customer.id,
        status: input.status,
        source: input.profile.source || null,
        route: input.route || null,
        estimatedPence: input.estimatePence || 0,
        assignedToId: req.user.role === 'Sales Adviser' ? req.user.id : undefined,
      };
      const lead = draft?.leadId
        ? await tx.lead.update({ where: { id: draft.leadId }, data: leadData, include: { customer: true, followUps: true, consultations: { include: { answers: true }, take: 1 } } })
        : await tx.lead.create({ data: { ...leadData, createdById: req.user.id }, include: { customer: true, followUps: true, consultations: { include: { answers: true }, take: 1 } } });
      const consultation = draft
        ? await tx.consultation.update({ where: { id: draft.id }, data: { leadId: lead.id, status: 'SAVED', route: input.route || null, progress: input.progress, currentStage: input.currentStage, callNotes: input.notes || null } })
        : await tx.consultation.create({ data: { customerId: customer.id, leadId: lead.id, route: input.route || null, status: 'SAVED', progress: input.progress, currentStage: input.currentStage, callNotes: input.notes || null, createdById: req.user.id } });
      for (const [questionKey, answer] of Object.entries(input.answers)) {
        await tx.consultationAnswer.upsert({
          where: { consultationId_questionKey: { consultationId: consultation.id, questionKey } },
          update: { answerJson: JSON.stringify(answer), confirmed: true, confirmedAt: new Date(), createdById: req.user.id },
          create: { consultationId: consultation.id, questionKey, answerJson: JSON.stringify(answer), confirmed: true, confirmedAt: new Date(), createdById: req.user.id },
        });
      }
      if (input.notes) await tx.note.create({ data: { customerId: customer.id, createdById: req.user.id, body: input.notes } });
      await tx.activity.create({ data: { customerId: customer.id, leadId: lead.id, consultationId: consultation.id, actorId: req.user.id, type: draft?.leadId ? 'LEAD_UPDATED' : 'LEAD_CREATED', summary: draft?.leadId ? 'Lead updated from consultation.' : 'Lead created from consultation.' } });
      await tx.auditLog.create({ data: { actorId: req.user.id, action: draft?.leadId ? 'LEAD_UPDATED' : 'LEAD_CREATED', resource: 'Lead', resourceId: lead.id, ipAddress: req.ip || null } });
      return lead;
    });
    if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'The consultation was not found.' } });
    return res.status(201).json({ lead: presentLead(result) });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:id', requireAuth, requirePermission('leads:write'), async (req, res, next) => {
  try {
    const input = updateSchema.parse(req.body);
    const where = { id: req.params.id, deletedAt: null, ...leadScope(req.user) };
    const existing = await prisma.lead.findFirst({ where, include: { customer: true, followUps: { where: { status: 'OPEN', deletedAt: null }, orderBy: { dueAt: 'asc' }, take: 1 } } });
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found.' } });
    if (input.assignedToId && !['Admin', 'Manager'].includes(req.user.role)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only managers can reassign leads.' } });
    }
    const updated = await prisma.lead.update({
      where: { id: existing.id },
      data: {
        ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'estimatePence')),
        ...(input.estimatePence === undefined ? {} : { estimatedPence: input.estimatePence }),
      },
      include: { customer: true, followUps: { where: { status: 'OPEN', deletedAt: null }, orderBy: { dueAt: 'asc' }, take: 1 } },
    });
    await recordAudit(req, 'LEAD_UPDATED', 'Lead', updated.id, { changedFields: Object.keys(input) });
    return res.json({ lead: presentLead(updated) });
  } catch (error) {
    return next(error);
  }
});

export default router;
