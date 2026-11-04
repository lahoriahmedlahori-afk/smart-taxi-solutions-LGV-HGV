import { z } from 'zod';
import { prisma } from '../db.js';
import { completeWithAi, AiProviderError } from './ai-provider.js';
import { getNextQuestion, routeFromGoal } from './rule-engine.js';

const extractionSchema = z.object({
  age: z.number().int().min(16).max(100).nullable(),
  licenceStatus: z.enum(['FULL_UK_B', 'PROVISIONAL_UK_B', 'NO_UK_LICENCE', 'UNSURE']).nullable(),
  goal: z.enum(['C_PLUS_E', 'C', 'C1', 'C1_PLUS_E', 'D', 'D1', 'DRIVER_CPC', 'UNSURE']).nullable(),
  medicalStatus: z.enum(['COMPLETED', 'BOOKED', 'NOT_COMPLETED', 'UNSURE']).nullable(),
  theoryStatus: z.enum(['PASSED', 'BOOKED', 'NOT_COMPLETED', 'PARTIAL', 'UNSURE']).nullable(),
  preferredLocation: z.string().max(120).nullable(),
  cpcRequired: z.boolean().nullable(),
  experience: z.enum(['NONE', 'SOME_TRAINING', 'UK_HGV', 'INTERNATIONAL', 'REFRESHER', 'UNSURE']).nullable(),
}).strict();

const coachSchema = z.object({
  question: z.string().min(1).max(500),
  suggestedExplanation: z.string().max(800),
  possibleObjection: z.string().max(500),
  suggestedResponse: z.string().max(800),
  salesOpportunity: z.string().max(500),
  closingOpportunity: z.string().max(500),
  complianceWarning: z.string().max(500),
}).strict();

const EMPTY_EXTRACTION = {
  age: null, licenceStatus: null, goal: null, medicalStatus: null, theoryStatus: null,
  preferredLocation: null, cpcRequired: null, experience: null,
};

function redact(text) {
  return String(text)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/\b(?:\+?44\s?\(?0?\)?\s?|0)(?:\d[\s().-]?){9,10}\b/g, '[PHONE]')
    .replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, '[POSTCODE]')
    .replace(/\b(?:NI|national insurance)(?:\s*(?:number|no\.?))?\s*(?:is|:)?\s*[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi, '[NI NUMBER]')
    .replace(/\b(?:i|they|he|she|customer)\s+(?:have|has|suffer(?:s)? from|was diagnosed with)\s+[^,.!?;]{1,100}(?:condition|disease|disorder|diabetes|epilepsy|heart|stroke|mental health)[^,.!?;]*/gi, '[MEDICAL DETAIL REDACTED]');
}

function extractDeterministically(text) {
  const normalized = text.toLowerCase();
  const result = { ...EMPTY_EXTRACTION };
  const age = normalized.match(/\b(?:aged?\s*)?(\d{2})\s*(?:years? old)?\b/);
  if (age) result.age = Number(age[1]);
  if (/full (?:uk )?(?:car|category b|b) licence|full uk licence/.test(normalized)) result.licenceStatus = 'FULL_UK_B';
  else if (/provisional (?:uk )?(?:car|category b|b) licence/.test(normalized)) result.licenceStatus = 'PROVISIONAL_UK_B';
  else if (/no (?:uk )?(?:driving )?licence/.test(normalized)) result.licenceStatus = 'NO_UK_LICENCE';
  if (/class\s*1|artic|articulated|c\s*\+\s*e|c\+e/.test(normalized)) result.goal = 'C_PLUS_E';
  else if (/class\s*2|rigid|category c\b/.test(normalized)) result.goal = 'C';
  else if (/7[.,]?5\s*(?:tonne|ton|t)|\bc1\b/.test(normalized)) result.goal = 'C1';
  else if (/coach|bus|category d\b/.test(normalized)) result.goal = 'D';
  else if (/minibus|\bd1\b/.test(normalized)) result.goal = 'D1';
  else if (/driver cpc|module\s*[24]|\bcpc\b/.test(normalized)) result.goal = 'DRIVER_CPC';
  if (/medical (?:is )?(?:completed|done|passed)|d4 (?:is )?(?:completed|done)/.test(normalized)) result.medicalStatus = 'COMPLETED';
  else if (/medical (?:is )?booked|d4 (?:is )?booked/.test(normalized)) result.medicalStatus = 'BOOKED';
  else if (/haven't done (?:the )?medical|hasn't done (?:the )?medical|medical not done|medical not completed|not done (?:the )?medical/.test(normalized)) result.medicalStatus = 'NOT_COMPLETED';
  if (/theory (?:and|&) hazard .*passed|theory tests? (?:are )?passed|both theory .*passed/.test(normalized)) result.theoryStatus = 'PASSED';
  else if (/theory .*booked/.test(normalized)) result.theoryStatus = 'BOOKED';
  else if (/haven't done .*theory|hasn't done .*theory|theory not done|theory not started/.test(normalized)) result.theoryStatus = 'NOT_COMPLETED';
  if (/professional|for work|commercially/.test(normalized)) result.cpcRequired = true;
  else if (/private use|not for work|non-commercial/.test(normalized)) result.cpcRequired = false;
  const location = normalized.match(/(?:near|around|in|by)\s+([a-z][a-z -]{1,50}?)(?=\s+(?:and|but|with|for|where|because)|[,.;]|$)/i);
  if (location) result.preferredLocation = location[1].trim().replace(/\s+/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  return result;
}

async function logAiExchange({ userId, consultationId, provider, model, input, output, redactionApplied }) {
  const conversation = await prisma.aiConversation.create({
    data: { userId, consultationId: consultationId || null, provider, model },
  });
  await prisma.aiMessage.createMany({
    data: [
      { conversationId: conversation.id, role: 'user', content: input.slice(0, 12_000), redactionApplied },
      { conversationId: conversation.id, role: 'assistant', content: output.slice(0, 12_000), redactionApplied: false },
    ],
  });
}

export async function extractCustomerDetails({ text, userId, consultationId }) {
  const safeText = redact(text).slice(0, 8_000);
  const deterministic = extractionSchema.parse(extractDeterministically(safeText));
  try {
    const response = await completeWithAi({
      system: 'Extract only explicit customer facts from the supplied call note. Return one JSON object with fields age, licenceStatus, goal, medicalStatus, theoryStatus, preferredLocation, cpcRequired, experience. Use null when absent. Never infer legal entitlement, medical fitness, or requirements. Use exact enum values from the schema: licenceStatus FULL_UK_B|PROVISIONAL_UK_B|NO_UK_LICENCE|UNSURE; goal C_PLUS_E|C|C1|C1_PLUS_E|D|D1|DRIVER_CPC|UNSURE; medicalStatus COMPLETED|BOOKED|NOT_COMPLETED|UNSURE; theoryStatus PASSED|BOOKED|NOT_COMPLETED|PARTIAL|UNSURE; experience NONE|SOME_TRAINING|UK_HGV|INTERNATIONAL|REFRESHER|UNSURE.',
      user: safeText,
    });
    const extraction = extractionSchema.parse(JSON.parse(response));
    await logAiExchange({ userId, consultationId, provider: process.env.AI_PROVIDER || 'ollama', model: process.env.AI_MODEL || 'llama3.2:3b', input: safeText, output: JSON.stringify(extraction), redactionApplied: safeText !== text });
    return { extraction, aiUsed: true, needsConfirmation: true };
  } catch (error) {
    if (!(error instanceof AiProviderError) && !(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error;
    return { extraction: deterministic, aiUsed: false, fallbackReason: 'AI is unavailable or returned invalid data; rule-based extraction is shown for adviser review.', needsConfirmation: true };
  }
}

export async function coachNextQuestion({ state, userId, consultationId }) {
  const ruleQuestion = getNextQuestion(state);
  if (!ruleQuestion) return { ...ruleQuestion, aiUsed: false };
  const fallback = {
    question: ruleQuestion.question,
    whyAsked: ruleQuestion.whyAsked,
    answerOptions: ruleQuestion.answerOptions,
    stage: ruleQuestion.stage,
    priority: ruleQuestion.priority,
    regulatoryWarning: ruleQuestion.regulatoryWarning,
    suggestedExplanation: ruleQuestion.suggestedExplanation,
    possibleObjection: 'If a concern comes up, ask what needs clarifying and respond with accurate written details.',
    suggestedResponse: 'I can explain the package inclusions and terms, and give you time to consider them.',
    salesOpportunity: ruleQuestion.salesOpportunity,
    closingOpportunity: 'Offer a quote, availability check, document checklist or a no-pressure follow-up.',
    confidence: ruleQuestion.confidence,
    aiUsed: false,
  };
  try {
    const response = await completeWithAi({
      system: 'You are a supportive internal sales-call coach for a UK commercial driver training adviser. The rule engine has already selected the required subject and answer options. You may only rephrase the question without changing its subject or meaning, suggest clear non-pressuring wording, identify a possible objection, and give a compliant response. Never invent legal, medical, eligibility, course-hour, price or pass-guarantee claims. Return JSON with question, suggestedExplanation, possibleObjection, suggestedResponse, salesOpportunity, closingOpportunity, complianceWarning.',
      user: JSON.stringify({ question: ruleQuestion.question, whyAsked: ruleQuestion.whyAsked, route: ruleQuestion.route, options: ruleQuestion.answerOptions, warning: ruleQuestion.regulatoryWarning }),
    });
    const coached = coachSchema.parse(JSON.parse(response));
    await logAiExchange({ userId, consultationId, provider: process.env.AI_PROVIDER || 'ollama', model: process.env.AI_MODEL || 'llama3.2:3b', input: JSON.stringify({ key: ruleQuestion.key, route: ruleQuestion.route }), output: JSON.stringify(coached), redactionApplied: true });
    return {
      ...fallback,
      question: coached.question,
      suggestedExplanation: coached.suggestedExplanation,
      possibleObjection: coached.possibleObjection,
      suggestedResponse: coached.suggestedResponse,
      salesOpportunity: coached.salesOpportunity,
      closingOpportunity: coached.closingOpportunity,
      regulatoryWarning: ruleQuestion.regulatoryWarning || coached.complianceWarning,
      aiUsed: true,
    };
  } catch {
    return fallback;
  }
}

export function extractionToAnswers(extraction) {
  const answers = {};
  if (extraction.age !== null) answers.age = String(extraction.age);
  if (extraction.licenceStatus) answers.licence = ({ FULL_UK_B: 'Yes', PROVISIONAL_UK_B: 'No', NO_UK_LICENCE: 'No', UNSURE: 'Not sure' })[extraction.licenceStatus];
  if (extraction.goal) answers.goal = ({ C_PLUS_E: 'Articulated lorry', C: 'Rigid lorry', C1: '7.5 tonne vehicle', C1_PLUS_E: 'C1+E vehicle with trailer', D: 'Bus or coach', D1: 'Minibus', DRIVER_CPC: 'Get Driver CPC', UNSURE: 'Not sure' })[extraction.goal];
  if (extraction.medicalStatus) answers.medical = ({ COMPLETED: 'Completed', BOOKED: 'Booked', NOT_COMPLETED: 'Not yet', UNSURE: 'Not sure' })[extraction.medicalStatus];
  if (extraction.theoryStatus) answers.theory = ({ PASSED: 'Both passed', BOOKED: 'Booked', NOT_COMPLETED: 'Not started', PARTIAL: 'Some passed', UNSURE: 'Not sure' })[extraction.theoryStatus];
  if (extraction.cpcRequired !== null) answers.cpc = extraction.cpcRequired ? 'Yes, professionally' : 'No, private use';
  if (extraction.experience) answers.experience = ({ NONE: 'No experience', SOME_TRAINING: 'Some training', UK_HGV: 'UK HGV experience', INTERNATIONAL: 'International experience', REFRESHER: 'Need refresher', UNSURE: 'Not sure' })[extraction.experience];
  return answers;
}

export function likelyRouteForExtraction(extraction) {
  return routeFromGoal(extraction.goal || '') || null;
}
