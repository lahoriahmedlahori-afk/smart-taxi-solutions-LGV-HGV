import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { recordAudit } from '../services/audit.js';
import { consultationProgress, getNextQuestion, missingInformation, routeFromGoal, validateAnswer } from '../services/rule-engine.js';
import { coachNextQuestion } from '../services/consultation-ai.js';

const router = Router();
const text = max => z.string().trim().max(max).optional();
const profileSchema = z.object({
  first: text(100), last: text(100), phone: text(40),
  email: z.union([z.string().email().max(254), z.literal('')]).optional(),
  postcode: text(20), city: text(100),
  dob: z.union([z.string().date(), z.literal('')]).optional(),
  contact: text(40), source: text(80), location: text(150), dates: text(250),
  budget: text(100), payment: text(100),
}).strict();
const answerRecord = z.record(z.string().min(1).max(80), z.unknown())
  .refine(value => JSON.stringify(value).length <= 64_000, 'Answers are too large')
  .superRefine((answers, context) => {
    for (const [key, value] of Object.entries(answers)) {
      if (!validateAnswer(key, value)) context.addIssue({ code: 'custom', path: [key], message: 'Answer does not match the consultation question.' });
    }
  });
const draftSchema = z.object({
  clientDraftKey: z.string().uuid(),
  profile: profileSchema.default({}),
  answers: answerRecord.default({}),
  callNotes: z.string().max(10_000).optional(),
}).strict();
const answerSchema = z.object({
  questionKey: z.string().min(1).max(80),
  answer: z.union([z.string().max(800), z.array(z.string().max(80)).max(30), z.number().finite(), z.boolean()]),
  confirmed: z.boolean().default(true),
}).strict();
const extractionConfirmationSchema = z.object({
  fields: z.object({
    age: z.string().max(80).optional(),
    licence: z.enum(['Yes', 'No', 'Not sure']).optional(),
    goal: z.enum(['Articulated lorry', 'Rigid lorry', '7.5 tonne vehicle', 'C1+E vehicle with trailer', 'Bus or coach', 'Minibus', 'Get Driver CPC', 'Not sure']).optional(),
    medical: z.enum(['Completed', 'Booked', 'Not yet', 'Not sure']).optional(),
    theory: z.enum(['Both passed', 'Booked', 'Some passed', 'Not started', 'Not sure']).optional(),
    cpc: z.enum(['Yes, professionally', 'No, private use', 'Not sure']).optional(),
    experience: z.enum(['No experience', 'Some training', 'UK HGV experience', 'International experience', 'Need refresher', 'Not sure']).optional(),
    location: z.string().trim().max(150).optional(),
  }).strict().refine(fields => Object.keys(fields).length > 0, 'Confirm at least one extracted field'),
  replaceExisting: z.boolean().default(false),
}).strict();

function customerCreateData(profile, userId) {
  const budget = profile.budget && /^\d+(\.\d{1,2})?$/.test(profile.budget) ? Math.round(Number(profile.budget) * 100) : null;
  return {
    firstName: profile.first || null, lastName: profile.last || null, phone: profile.phone || null,
    email: profile.email?.trim().toLowerCase() || null, postcode: profile.postcode || null,
    city: profile.city || null, dateOfBirth: profile.dob ? new Date(`${profile.dob}T00:00:00.000Z`) : null,
    contactPreference: profile.contact || null, leadSource: profile.source || null,
    preferredLocation: profile.location || null, preferredDates: profile.dates || null,
    budgetPence: budget, paymentPreference: profile.payment || null, createdById: userId,
  };
}

function customerUpdateData(profile) {
  const sources = {
    first: 'firstName', last: 'lastName', phone: 'phone', email: 'email', postcode: 'postcode',
    city: 'city', dob: 'dateOfBirth', contact: 'contactPreference', source: 'leadSource',
    location: 'preferredLocation', dates: 'preferredDates', payment: 'paymentPreference',
  };
  const data = Object.fromEntries(Object.entries(sources)
    .filter(([source]) => Object.hasOwn(profile, source))
    .map(([source, target]) => [target, source === 'dob' ? profile[source] ? new Date(`${profile[source]}T00:00:00.000Z`) : null : profile[source] || null]));
  if (Object.hasOwn(profile, 'budget')) {
    data.budgetPence = profile.budget && /^\d+(\.\d{1,2})?$/.test(profile.budget) ? Math.round(Number(profile.budget) * 100) : null;
  }
  return data;
}

function getAnswerMap(consultation) {
  return Object.fromEntries(consultation.answers.filter(answer => answer.confirmed).map(answer => [answer.questionKey, JSON.parse(answer.answerJson)]));
}

function presentConsultation(consultation) {
  const customer = consultation.customer;
  return {
    id: consultation.id,
    customerId: consultation.customerId,
    clientDraftKey: consultation.clientDraftKey,
    route: consultation.route,
    status: consultation.status,
    currentStage: consultation.currentStage,
    progress: consultation.progress,
    callNotes: consultation.callNotes || '',
    profile: {
      first: customer.firstName || '', last: customer.lastName || '', phone: customer.phone || '',
      email: customer.email || '', postcode: customer.postcode || '', city: customer.city || '',
      dob: customer.dateOfBirth?.toISOString().slice(0, 10) || '', contact: customer.contactPreference || 'Phone',
      source: customer.leadSource || 'Inbound call', location: customer.preferredLocation || '',
      dates: customer.preferredDates || '', budget: customer.budgetPence === null ? '' : String(customer.budgetPence / 100),
      payment: customer.paymentPreference || '',
    },
    answers: getAnswerMap(consultation),
    updatedAt: consultation.updatedAt.toISOString(),
  };
}

function consultationScope(user) {
  return user.role === 'Sales Adviser'
    ? { OR: [{ createdById: user.id }, { lead: { is: { assignedToId: user.id } } }] }
    : {};
}

router.post('/draft', requireAuth, requirePermission('consultations:write'), async (req, res, next) => {
  try {
    const input = draftSchema.parse(req.body);
    const route = routeFromGoal(input.answers.goal || '');
    const ruleState = { answers: input.answers };
    const progress = consultationProgress(ruleState);
    const next = getNextQuestion(ruleState);
    const currentStage = next?.stage || 'Follow-up / booking';
    const result = await prisma.$transaction(async tx => {
      let existing = await tx.consultation.findUnique({
        where: { clientDraftKey: input.clientDraftKey },
        include: { customer: true },
      });
      if (existing && existing.createdById !== req.user.id && req.user.role === 'Sales Adviser') return null;
      if (existing?.leadId && req.user.role === 'Sales Adviser') return null;
      const customer = existing
        ? await tx.customer.update({ where: { id: existing.customerId }, data: customerUpdateData(input.profile) })
        : await tx.customer.create({ data: customerCreateData(input.profile, req.user.id) });
      const consultation = existing
        ? await tx.consultation.update({
          where: { id: existing.id },
          data: { route: route || null, progress, currentStage, callNotes: input.callNotes || null },
        })
        : await tx.consultation.create({
          data: {
            customerId: customer.id, clientDraftKey: input.clientDraftKey, route: route || null,
            progress, currentStage, callNotes: input.callNotes || null, createdById: req.user.id,
          },
        });
      for (const [questionKey, answer] of Object.entries(input.answers)) {
        await tx.consultationAnswer.upsert({
          where: { consultationId_questionKey: { consultationId: consultation.id, questionKey } },
          update: { answerJson: JSON.stringify(answer), confirmed: true, confirmedAt: new Date(), createdById: req.user.id },
          create: { consultationId: consultation.id, questionKey, answerJson: JSON.stringify(answer), confirmed: true, confirmedAt: new Date(), createdById: req.user.id },
        });
      }
      await tx.activity.create({ data: { customerId: customer.id, consultationId: consultation.id, actorId: req.user.id, type: 'CONSULTATION_SAVED', summary: 'Consultation draft updated.' } });
      await tx.auditLog.create({ data: { actorId: req.user.id, action: 'CONSULTATION_DRAFT_SAVED', resource: 'Consultation', resourceId: consultation.id, ipAddress: req.ip || null } });
      return tx.consultation.findUniqueOrThrow({ where: { id: consultation.id }, include: { customer: true, answers: true } });
    });
    if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Draft not found.' } });
    return res.json({ consultation: presentConsultation(result) });
  } catch (error) {
    return next(error);
  }
});

router.get('/drafts', requireAuth, requirePermission('consultations:read'), async (req, res, next) => {
  try {
    const consultations = await prisma.consultation.findMany({
      where: {
        status: 'In Progress', deletedAt: null,
        ...(req.user.role === 'Sales Adviser' ? { createdById: req.user.id } : { createdById: req.user.id }),
      },
      include: { customer: true, answers: true },
      orderBy: { updatedAt: 'desc' }, take: 20,
    });
    return res.json({ consultations: consultations.map(presentConsultation) });
  } catch (error) {
    return next(error);
  }
});

router.get('/draft/:clientDraftKey', requireAuth, requirePermission('consultations:read'), async (req, res, next) => {
  try {
    const key = z.string().uuid().parse(req.params.clientDraftKey);
    const consultation = await prisma.consultation.findUnique({
      where: { clientDraftKey: key },
      include: { customer: true, answers: true },
    });
    if (!consultation || (req.user.role === 'Sales Adviser' && consultation.createdById !== req.user.id)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Draft not found.' } });
    }
    return res.json({ consultation: presentConsultation(consultation) });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/next-question', requireAuth, requirePermission('consultations:read'), async (req, res, next) => {
  try {
    const consultation = await prisma.consultation.findFirst({
      where: { id: req.params.id, deletedAt: null, ...consultationScope(req.user) },
      include: { customer: true, answers: true },
    });
    if (!consultation) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Consultation not found.' } });
    const answers = getAnswerMap(consultation);
    const ruleQuestion = getNextQuestion({ answers });
    const coach = await coachNextQuestion({ state: { answers }, userId: req.user.id, consultationId: consultation.id });
    return res.json({
      question: ruleQuestion ? {
        ...ruleQuestion,
        question: coach.question,
        suggestedExplanation: coach.suggestedExplanation,
        possibleObjection: coach.possibleObjection,
        suggestedResponse: coach.suggestedResponse,
        salesOpportunity: coach.salesOpportunity,
        closingOpportunity: coach.closingOpportunity,
        confidence: coach.confidence,
        aiUsed: coach.aiUsed,
      } : null,
      progress: consultation.progress,
      missing: missingInformation({ answers }),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/answers', requireAuth, requirePermission('consultations:write'), async (req, res, next) => {
  try {
    const input = answerSchema.parse(req.body);
    if (!validateAnswer(input.questionKey, input.answer)) return res.status(400).json({ error: { code: 'ANSWER_INVALID', message: 'Answer does not match the consultation question.' } });
    const existing = await prisma.consultation.findFirst({
      where: { id: req.params.id, deletedAt: null, ...consultationScope(req.user) },
      include: { answers: true },
    });
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Consultation not found.' } });
    const answerMap = getAnswerMap(existing);
    if (input.confirmed) answerMap[input.questionKey] = input.answer;
    else delete answerMap[input.questionKey];
    const ruleState = { answers: answerMap };
    const route = routeFromGoal(answerMap.goal || '');
    const progress = consultationProgress(ruleState);
    const next = getNextQuestion(ruleState);
    const updated = await prisma.$transaction(async tx => {
      await tx.consultationAnswer.upsert({
        where: { consultationId_questionKey: { consultationId: existing.id, questionKey: input.questionKey } },
        update: { answerJson: JSON.stringify(input.answer), confirmed: input.confirmed, confirmedAt: input.confirmed ? new Date() : null, createdById: req.user.id },
        create: { consultationId: existing.id, questionKey: input.questionKey, answerJson: JSON.stringify(input.answer), confirmed: input.confirmed, confirmedAt: input.confirmed ? new Date() : null, createdById: req.user.id },
      });
      const consultation = await tx.consultation.update({ where: { id: existing.id }, data: { route: route || null, progress, currentStage: next?.stage || 'Follow-up / booking' }, include: { customer: true, answers: true } });
      await tx.activity.create({ data: { customerId: consultation.customerId, consultationId: consultation.id, actorId: req.user.id, type: 'ANSWER_RECORDED', summary: `Consultation answer recorded: ${input.questionKey}.` } });
      await tx.auditLog.create({ data: { actorId: req.user.id, action: 'CONSULTATION_ANSWER_RECORDED', resource: 'Consultation', resourceId: consultation.id, metadata: JSON.stringify({ questionKey: input.questionKey }), ipAddress: req.ip || null } });
      return consultation;
    });
    return res.json({ consultation: presentConsultation(updated), nextQuestion: getNextQuestion({ answers: getAnswerMap(updated) }) });
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/confirm-extraction', requireAuth, requirePermission('consultations:write'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = extractionConfirmationSchema.parse(req.body);
    const existing = await prisma.consultation.findFirst({
      where: { id, deletedAt: null, ...consultationScope(req.user) },
      include: { answers: true, customer: true },
    });
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Consultation not found.' } });
    const confirmedExisting = existing.answers.filter(answer => answer.confirmed);
    const changedKeys = Object.entries(input.fields).filter(([key, value]) => {
      const previous = confirmedExisting.find(answer => answer.questionKey === key);
      if (previous && JSON.stringify(JSON.parse(previous.answerJson)) !== JSON.stringify(value)) return true;
      return key === 'location' && existing.customer.preferredLocation && existing.customer.preferredLocation !== value;
    }).map(([key]) => key);
    if (changedKeys.length && !input.replaceExisting) {
      return res.status(409).json({ error: { code: 'CONFIRMED_DATA_EXISTS', message: 'Some extracted values differ from confirmed customer data.', details: { fields: changedKeys } } });
    }
    const answers = getAnswerMap(existing);
    Object.assign(answers, input.fields);
    const route = routeFromGoal(answers.goal || '');
    const progress = consultationProgress({ answers });
    const next = getNextQuestion({ answers });
    const updated = await prisma.$transaction(async tx => {
      for (const [questionKey, answer] of Object.entries(input.fields)) {
        await tx.consultationAnswer.upsert({
          where: { consultationId_questionKey: { consultationId: existing.id, questionKey } },
          update: { answerJson: JSON.stringify(answer), confirmed: true, confirmedAt: new Date(), createdById: req.user.id, source: 'AI_CONFIRMED' },
          create: { consultationId: existing.id, questionKey, answerJson: JSON.stringify(answer), confirmed: true, confirmedAt: new Date(), createdById: req.user.id, source: 'AI_CONFIRMED' },
        });
      }
      if (input.fields.location !== undefined) {
        await tx.customer.update({ where: { id: existing.customerId }, data: { preferredLocation: input.fields.location || null } });
      }
      const consultation = await tx.consultation.update({ where: { id }, data: { route: route || null, progress, currentStage: next?.stage || 'Follow-up / booking' }, include: { customer: true, answers: true } });
      await tx.activity.create({ data: { customerId: consultation.customerId, consultationId: id, actorId: req.user.id, type: 'AI_EXTRACTION_CONFIRMED', summary: 'Adviser confirmed extracted consultation details.', metadata: JSON.stringify({ confirmedFields: Object.keys(input.fields) }) } });
      await tx.auditLog.create({ data: { actorId: req.user.id, action: 'AI_EXTRACTION_CONFIRMED', resource: 'Consultation', resourceId: id, metadata: JSON.stringify({ confirmedFields: Object.keys(input.fields), replacedFields: changedKeys }), ipAddress: req.ip || null } });
      return consultation;
    });
    return res.json({ consultation: presentConsultation(updated), nextQuestion: getNextQuestion({ answers: getAnswerMap(updated) }) });
  } catch (error) {
    return next(error);
  }
});

export default router;
