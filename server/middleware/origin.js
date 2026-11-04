import { config } from '../config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function sameOriginForMutations(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(config.appOrigin).origin) {
        return res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: 'Request origin is not allowed.' } });
      }
    } catch {
      return res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: 'Request origin is not allowed.' } });
    }
  }
  return next();
}
