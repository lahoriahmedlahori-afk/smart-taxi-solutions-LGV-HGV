import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/permissions.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
const allowedSettings = new Set(['business.name', 'business.currency', 'quote.expiryDays', 'quote.defaultDepositPence', 'privacy.retentionDays', 'training.defaultAssessmentHours']);
const valueSchema = z.object({ value: z.string().max(2_000) }).strict();

router.get('/', requireAuth, requireRole('Admin', 'Manager'), async (_req, res, next) => {
  try {
    const settings = await prisma.appSetting.findMany({ where: { isSecret: false }, orderBy: { key: 'asc' } });
    return res.json({ settings: settings.map(({ key, value, updatedAt }) => ({ key, value, updatedAt })) });
  } catch (error) { return next(error); }
});

router.put('/:key', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const key = z.string().max(100).parse(req.params.key);
    if (!allowedSettings.has(key)) return res.status(400).json({ error: { code: 'SETTING_NOT_ALLOWED', message: 'This setting cannot be edited through the generic settings API.' } });
    const input = valueSchema.parse(req.body);
    if (key === 'quote.expiryDays' || key === 'quote.defaultDepositPence' || key === 'privacy.retentionDays' || key === 'training.defaultAssessmentHours') {
      if (!/^\d+$/.test(input.value)) return res.status(400).json({ error: { code: 'SETTING_INVALID', message: 'This setting must be a non-negative integer.' } });
    }
    const setting = await prisma.appSetting.upsert({ where: { key }, update: { value: input.value, updatedById: req.user.id }, create: { key, value: input.value, updatedById: req.user.id } });
    await recordAudit(req, 'APP_SETTING_UPDATED', 'AppSetting', setting.id, { key });
    return res.json({ setting: { key: setting.key, value: setting.value, updatedAt: setting.updatedAt } });
  } catch (error) { return next(error); }
});

export default router;
