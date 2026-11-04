import { ZodError } from 'zod';

export function notFound(_req, res) {
  return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' } });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'One or more fields are invalid.',
        details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
      },
    });
  }
  if (error?.code === 'P2002') return res.status(409).json({ error: { code: 'CONFLICT', message: 'A record with these details already exists.' } });
  if (error?.code === 'P2025') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' } });
  console.error('Request failed', { method: req.method, path: req.path, error: error?.name || 'Error' });
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
}
