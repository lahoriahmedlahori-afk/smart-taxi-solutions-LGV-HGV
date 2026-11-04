import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { createOpaqueToken, hashPassword, hashToken, verifyPassword } from '../security/credentials.js';

const router = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }).strict();
const resetRequestSchema = z.object({ email: z.string().email().max(254) }).strict();
const resetSchema = z.object({ token: z.string().min(32).max(128), password: z.string().min(14).max(128) }).strict();
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

function setSessionCookie(res, token, expiresAt) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email address and password.' } });

    const email = parsed.data.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email }, include: { role: true } });
    const passwordMatches = await verifyPassword(parsed.data.password, user?.passwordHash || DUMMY_HASH);
    const locked = user?.lockedUntil && user.lockedUntil > new Date();
    if (!user || !passwordMatches || !user.isActive || user.deletedAt || locked) {
      if (user && !locked) {
        const attempts = user.failedLoginAttempts + 1;
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: attempts >= config.loginMaxAttempts ? 0 : attempts,
            lockedUntil: attempts >= config.loginMaxAttempts ? new Date(Date.now() + config.loginLockMs) : null,
          },
        });
      }
      await prisma.auditLog.create({
        data: { actorId: user?.id || null, action: 'AUTH_LOGIN_FAILED', resource: 'User', resourceId: user?.id || null, ipAddress: req.ip || null },
      });
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect, or the account is unavailable.' } });
    }

    const rawToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlMs);
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() } }),
      prisma.authSession.create({ data: { userId: user.id, tokenHash: hashToken(rawToken), expiresAt } }),
      prisma.auditLog.create({ data: { actorId: user.id, action: 'AUTH_LOGIN', resource: 'User', resourceId: user.id, ipAddress: req.ip || null } }),
    ]);
    setSessionCookie(res, rawToken, expiresAt);
    return res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role.name }, expiresAt });
  } catch (error) {
    return next(error);
  }
});

router.get('/session', (req, res) => {
  if (!req.user) return res.json({ user: null });
  return res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role }, expiresAt: req.authSession.expiresAt });
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await prisma.authSession.deleteMany({ where: { id: req.authSession.id } });
    await recordAudit(req, 'AUTH_LOGOUT', 'User', req.user.id);
    res.clearCookie(config.cookieName, { httpOnly: true, secure: config.isProduction, sameSite: 'strict', path: '/' });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

router.post('/password-reset/request', async (req, res, next) => {
  try {
    const parsed = resetRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email address.' } });
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email.trim().toLowerCase() } });
    if (user?.isActive && !user.deletedAt) {
      const token = createOpaqueToken();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt } });
      if (!config.isProduction) console.info(`Development password reset link: http://localhost:4173/reset-password?token=${token}`);
    }
    return res.json({ message: 'If the account is eligible, password-reset instructions will be sent.' });
  } catch (error) {
    return next(error);
  }
});

router.post('/password-reset/complete', async (req, res, next) => {
  try {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'The reset link or password is invalid.' } });
    const reset = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(parsed.data.token) }, include: { user: true } });
    if (!reset || reset.usedAt || reset.expiresAt <= new Date() || !reset.user.isActive || reset.user.deletedAt) {
      return res.status(400).json({ error: { code: 'INVALID_RESET', message: 'The reset link is invalid or expired.' } });
    }
    const passwordHash = await hashPassword(parsed.data.password);
    await prisma.$transaction([
      prisma.user.update({ where: { id: reset.userId }, data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null } }),
      prisma.passwordResetToken.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      prisma.authSession.deleteMany({ where: { userId: reset.userId } }),
      prisma.auditLog.create({ data: { actorId: reset.userId, action: 'AUTH_PASSWORD_RESET', resource: 'User', resourceId: reset.userId } }),
    ]);
    return res.json({ message: 'Password updated. Sign in with your new password.' });
  } catch (error) {
    return next(error);
  }
});

export default router;
