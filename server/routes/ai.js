import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, requireRole } from '../middleware/permissions.js';
import { encryptSecret } from '../security/credentials.js';
import { recordAudit } from '../services/audit.js';
import { coachNextQuestion, extractCustomerDetails } from '../services/consultation-ai.js';
import { testAiConnection } from '../services/ai-provider.js';
import { getNextQuestion } from '../services/rule-engine.js';

const router = Router();
const providers = ['ollama', 'openai-compatible', 'groq-compatible', 'openrouter-compatible', 'gemini'];
const extractSchema = z.object({ text: z.string().trim().min(1).max(8_000), consultationId: z.string().uuid().optional() }).strict();
const settingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(providers),
  model: z.string().trim().min(1).max(160),
  baseUrl: z.union([z.string().url().max(500), z.literal('')]).optional(),
  allowExternal: z.boolean().default(false),
  apiKey: z.string().max(500).optional(),
  clearApiKey: z.boolean().default(false),
}).strict();

async function getSetting(key) {
  return prisma.appSetting.findUnique({ where: { key } });
}

router.get('/settings', requireAuth, requireRole('Admin'), async (_req, res, next) => {
  try {
    const [enabled, provider, model, baseUrl, apiKey, allowExternal] = await Promise.all([
      getSetting('ai.enabled'), getSetting('ai.provider'), getSetting('ai.model'), getSetting('ai.baseUrl'),
      getSetting('ai.apiKey'), getSetting('ai.allowExternal'),
    ]);
    return res.json({
      settings: {
        enabled: enabled ? enabled.value === 'true' : config.ai.enabled,
        provider: provider?.value || config.ai.provider,
        model: model?.value || config.ai.model,
        baseUrl: baseUrl?.value || config.ai.baseUrl || config.ai.ollamaBaseUrl,
        allowExternal: allowExternal?.value === 'true',
        hasApiKey: Boolean(apiKey?.encryptedValue || config.ai.apiKey),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.put('/settings', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const input = settingsSchema.parse(req.body);
    if (input.provider !== 'ollama' && input.allowExternal && !input.apiKey && !await getSetting('ai.apiKey') && !config.ai.apiKey) {
      return res.status(400).json({ error: { code: 'API_KEY_REQUIRED', message: 'An API key is required before enabling an external provider.' } });
    }
    if (input.provider !== 'ollama' && input.allowExternal && !config.appEncryptionKey) {
      return res.status(400).json({ error: { code: 'ENCRYPTION_KEY_REQUIRED', message: 'APP_ENCRYPTION_KEY must be configured before storing external API credentials.' } });
    }
    const values = [
      ['ai.enabled', String(input.enabled)], ['ai.provider', input.provider], ['ai.model', input.model],
      ['ai.baseUrl', input.baseUrl || ''], ['ai.allowExternal', String(input.allowExternal)],
    ];
    await prisma.$transaction(async tx => {
      for (const [key, value] of values) {
        await tx.appSetting.upsert({ where: { key }, update: { value, updatedById: req.user.id }, create: { key, value, updatedById: req.user.id } });
      }
      if (input.clearApiKey) {
        await tx.appSetting.deleteMany({ where: { key: 'ai.apiKey' } });
      } else if (input.apiKey) {
        await tx.appSetting.upsert({
          where: { key: 'ai.apiKey' },
          update: { value: null, encryptedValue: encryptSecret(input.apiKey), isSecret: true, updatedById: req.user.id },
          create: { key: 'ai.apiKey', encryptedValue: encryptSecret(input.apiKey), isSecret: true, updatedById: req.user.id },
        });
      }
    });
    await recordAudit(req, 'AI_SETTINGS_UPDATED', 'AppSetting', null, { provider: input.provider, enabled: input.enabled, externalAllowed: input.allowExternal, keyChanged: Boolean(input.apiKey || input.clearApiKey) });
    return res.json({ settings: { enabled: input.enabled, provider: input.provider, model: input.model, baseUrl: input.baseUrl || '', allowExternal: input.allowExternal, hasApiKey: Boolean(input.apiKey) || (!input.clearApiKey && Boolean(await getSetting('ai.apiKey') || config.ai.apiKey)) } });
  } catch (error) {
    return next(error);
  }
});

router.post('/test', requireAuth, requireRole('Admin'), async (_req, res, next) => {
  try {
    return res.json(await testAiConnection());
  } catch (error) {
    return res.status(error.status || 503).json({ error: { code: 'AI_UNAVAILABLE', message: error.message || 'AI provider is unavailable.' } });
  }
});

router.post('/extract', requireAuth, requirePermission('ai:use'), async (req, res, next) => {
  try {
    const input = extractSchema.parse(req.body);
    if (input.consultationId) {
      const consultation = await prisma.consultation.findFirst({
        where: {
          id: input.consultationId, deletedAt: null,
          ...(req.user.role === 'Sales Adviser' ? { createdById: req.user.id } : {}),
        },
      });
      if (!consultation) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Consultation not found.' } });
    }
    const result = await extractCustomerDetails({ text: input.text, userId: req.user.id, consultationId: input.consultationId });
    return res.json({ ...result, message: 'Review and confirm each extracted field before it is saved.' });
  } catch (error) {
    return next(error);
  }
});

router.post('/coach', requireAuth, requirePermission('ai:use'), async (req, res, next) => {
  try {
    const input = z.object({ consultationId: z.string().uuid() }).strict().parse(req.body);
    const consultation = await prisma.consultation.findFirst({
      where: {
        id: input.consultationId, deletedAt: null,
        ...(req.user.role === 'Sales Adviser' ? { createdById: req.user.id } : {}),
      },
      include: { answers: true },
    });
    if (!consultation) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Consultation not found.' } });
    const answers = Object.fromEntries(consultation.answers.filter(answer => answer.confirmed).map(answer => [answer.questionKey, JSON.parse(answer.answerJson)]));
    const question = getNextQuestion({ answers });
    const result = await coachNextQuestion({ state: { answers }, userId: req.user.id, consultationId: consultation.id });
    return res.json({ ruleQuestion: question, coach: result });
  } catch (error) {
    return next(error);
  }
});

export default router;
