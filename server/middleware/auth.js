import { config } from '../config.js';
import { prisma } from '../db.js';
import { hashToken } from '../security/credentials.js';

export function clearSessionCookie(res) {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/',
  });
}

export async function attachUser(req, res, next) {
  try {
    const token = req.cookies?.[config.cookieName];
    if (!token) return next();

    const session = await prisma.authSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        user: {
          include: { role: { include: { permissions: { include: { permission: true } } } } },
        },
      },
    });
    if (!session || session.expiresAt <= new Date() || !session.user.isActive || session.user.deletedAt) {
      if (session) await prisma.authSession.delete({ where: { id: session.id } });
      clearSessionCookie(res);
      return next();
    }

    req.user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role.name,
      permissions: new Set(session.user.role.permissions.map(item => item.permission.key)),
    };
    req.authSession = session;
    if (Date.now() - session.lastSeenAt.getTime() > 5 * 60 * 1000) {
      void prisma.authSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in.' } });
  return next();
}
