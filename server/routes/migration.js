import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';

const router = Router();
const legacyLead = z.object({
  id: z.string().max(120).optional(), name: z.string().max(240).optional(), phone: z.string().max(40).optional(),
  email: z.string().max(254).optional(), route: z.string().max(40).optional(), status: z.string().max(60).optional(),
  quote: z.number().finite().min(0).max(10_000_000).optional(), created: z.string().datetime().optional(), updated: z.string().datetime().optional(),
  followup: z.string().datetime().optional(), followupReason: z.string().max(120).optional(),
  profile: z.record(z.string(), z.unknown()).optional(), answers: z.record(z.string(), z.unknown()).optional(), notes: z.string().max(10_000).optional(),
}).passthrough();
const importSchema = z.object({ demo: z.object({ leads: z.array(legacyLead).max(250) }).passthrough() }).strict();
const validStatuses = new Set(['New Lead', 'Contacted', 'Consultation Started', 'Qualified', 'Awaiting Documents', 'Awaiting Medical', 'Awaiting Theory', 'Quote Sent', 'Considering', 'Follow-up Required', 'Deposit Pending', 'Booked', 'Training Started', 'Test Scheduled', 'Completed', 'Passed', 'Failed / Retest', 'Lost']);

function splitName(name = '') {
  const [first = '', ...rest] = String(name).trim().split(/\s+/);
  return { firstName: first || null, lastName: rest.join(' ') || null };
}

function legacyProfile(lead) {
  const profile = lead.profile || {};
  const name = splitName(lead.name || `${profile.first || ''} ${profile.last || ''}`);
  const dob = typeof profile.dob === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(profile.dob) ? new Date(`${profile.dob}T00:00:00.000Z`) : null;
  const budget = typeof profile.budget === 'string' && /^\d+(\.\d{1,2})?$/.test(profile.budget) ? Math.round(Number(profile.budget) * 100) : null;
  return {
    firstName: String(profile.first || name.firstName || '').slice(0, 100) || null,
    lastName: String(profile.last || name.lastName || '').slice(0, 100) || null,
    phone: String(lead.phone || profile.phone || '').slice(0, 40) || null,
    email: String(lead.email || profile.email || '').trim().toLowerCase().slice(0, 254) || null,
    postcode: String(profile.postcode || '').slice(0, 20) || null,
    city: String(profile.city || '').slice(0, 100) || null,
    dateOfBirth: dob,
    contactPreference: String(profile.contact || 'Phone').slice(0, 40),
    leadSource: String(profile.source || 'Imported demo').slice(0, 80),
    preferredLocation: String(profile.location || '').slice(0, 150) || null,
    preferredDates: String(profile.dates || '').slice(0, 250) || null,
    paymentPreference: String(profile.payment || '').slice(0, 100) || null,
    budgetPence: budget,
  };
}

router.post('/import-demo', requireAuth, requirePermission('leads:write'), async (req, res, next) => {
  if (config.isProduction) return res.status(403).json({ error: { code: 'DEVELOPMENT_ONLY', message: 'Demo data import is disabled in production.' } });
  try {
    const input = importSchema.parse(req.body);
    const digest = createHash('sha256').update(JSON.stringify(input.demo)).digest('hex');
    const markerKey = `legacy-import:${req.user.id}:${digest}`;
    if (await prisma.appSetting.findUnique({ where: { key: markerKey } })) return res.status(409).json({ error: { code: 'ALREADY_IMPORTED', message: 'This demo dataset has already been imported.' } });
    const imported = await prisma.$transaction(async tx => {
      let count = 0;
      for (const legacy of input.demo.leads) {
        const customerData = legacyProfile(legacy);
        if (![customerData.firstName, customerData.lastName, customerData.phone, customerData.email].some(Boolean)) continue;
        const customer = await tx.customer.create({ data: { ...customerData, createdById: req.user.id } });
        const status = validStatuses.has(legacy.status) ? legacy.status : 'New Lead';
        const estimate = Math.round(Number(legacy.quote || 0) * 100);
        const lead = await tx.lead.create({
          data: {
            customerId: customer.id, status, route: legacy.route?.slice(0, 40) || null,
            source: customerData.leadSource, estimatedPence: estimate,
            assignedToId: req.user.role === 'Sales Adviser' ? req.user.id : undefined,
            createdById: req.user.id,
            ...(legacy.created ? { createdAt: new Date(legacy.created) } : {}),
          },
        });
        const answers = legacy.answers || {};
        const consultation = await tx.consultation.create({
          data: {
            customerId: customer.id, leadId: lead.id, createdById: req.user.id,
            route: legacy.route?.slice(0, 40) || null, status: 'SAVED', callNotes: legacy.notes || null,
            progress: Math.max(0, Math.min(100, Object.keys(answers).length * 8)), currentStage: 'Follow-up / booking',
            answers: { create: Object.entries(answers).slice(0, 80).map(([questionKey, answer]) => ({ questionKey: questionKey.slice(0, 80), answerJson: JSON.stringify(answer), confirmed: true, confirmedAt: new Date(), createdById: req.user.id, source: 'LEGACY_IMPORT' })) },
          },
        });
        await tx.activity.create({ data: { customerId: customer.id, leadId: lead.id, consultationId: consultation.id, actorId: req.user.id, type: 'LEGACY_IMPORT', summary: 'Lead imported from browser demo data.' } });
        if (legacy.followup && legacy.followupReason) {
          await tx.followUp.create({ data: { customerId: customer.id, leadId: lead.id, assignedToId: req.user.id, createdById: req.user.id, reason: legacy.followupReason.slice(0, 120), dueAt: new Date(legacy.followup), status: 'OPEN' } });
        }
        count += 1;
      }
      await tx.appSetting.create({ data: { key: markerKey, value: String(count), updatedById: req.user.id } });
      await tx.auditLog.create({ data: { actorId: req.user.id, action: 'LEGACY_DEMO_IMPORTED', resource: 'Lead', metadata: JSON.stringify({ count }), ipAddress: req.ip || null } });
      return count;
    });
    const leads = await prisma.lead.findMany({ where: { createdById: req.user.id, deletedAt: null }, include: { customer: true, followUps: { where: { status: 'OPEN', deletedAt: null }, orderBy: { dueAt: 'asc' }, take: 1 }, consultations: { include: { answers: true }, orderBy: { updatedAt: 'desc' }, take: 1 } }, orderBy: { createdAt: 'desc' }, take: 250 });
    return res.status(201).json({ imported, leads: leads.map(lead => ({ id: lead.id, name: [lead.customer.firstName, lead.customer.lastName].filter(Boolean).join(' '), phone: lead.customer.phone || '', email: lead.customer.email || '', route: lead.route || 'To be confirmed', status: lead.status, quote: (lead.estimatedPence || 0) / 100, followup: lead.followUps[0]?.dueAt?.toISOString() || '', followupReason: lead.followUps[0]?.reason || '', created: lead.createdAt.toISOString(), updated: lead.updatedAt.toISOString(), profile: legacyProfile({ ...lead, profile: {} }), answers: Object.fromEntries(lead.consultations[0]?.answers.filter(answer => answer.confirmed).map(answer => [answer.questionKey, JSON.parse(answer.answerJson)]) || []), notes: lead.consultations[0]?.callNotes || '' })) });
  } catch (error) {
    return next(error);
  }
});

export default router;
