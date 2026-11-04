import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, requireRole } from '../middleware/permissions.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
const articleSchema = z.object({
  slug: z.string().trim().min(2).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().trim().min(3).max(200), category: z.string().trim().min(2).max(80),
  body: z.string().trim().min(10).max(30_000), sourceUrl: z.union([z.string().url().max(1000), z.literal('')]).optional(),
  isPublished: z.boolean().default(false),
}).strict();

router.get('/', requireAuth, requirePermission('knowledge:read'), async (req, res, next) => {
  try {
    const query = z.object({ q: z.string().max(160).optional(), category: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
    const search = query.q?.trim();
    const manager = ['Admin', 'Manager'].includes(req.user.role);
    const articles = await prisma.knowledgeArticle.findMany({
      where: {
        deletedAt: null, ...(manager ? {} : { isPublished: true }), ...(query.category ? { category: query.category } : {}),
        ...(search ? { AND: [{ OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { category: { contains: search, mode: 'insensitive' } },
          { body: { contains: search, mode: 'insensitive' } },
        ] }] } : {}),
      },
      select: { id: true, slug: true, title: true, category: true, body: true, sourceUrl: true, isPublished: true, updatedAt: true },
      orderBy: [{ category: 'asc' }, { title: 'asc' }], take: query.limit,
    });
    return res.json({ articles });
  } catch (error) { return next(error); }
});

router.post('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const input = articleSchema.parse(req.body);
    const article = await prisma.knowledgeArticle.create({ data: { ...input, sourceUrl: input.sourceUrl || null, createdById: req.user.id } });
    await recordAudit(req, 'KNOWLEDGE_ARTICLE_CREATED', 'KnowledgeArticle', article.id);
    return res.status(201).json({ article });
  } catch (error) { return next(error); }
});

router.patch('/:id', requireAuth, requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = articleSchema.partial().strict().parse(req.body);
    const article = await prisma.knowledgeArticle.update({ where: { id }, data: { ...input, ...(Object.hasOwn(input, 'sourceUrl') ? { sourceUrl: input.sourceUrl || null } : {}) } });
    await recordAudit(req, 'KNOWLEDGE_ARTICLE_UPDATED', 'KnowledgeArticle', id, { fields: Object.keys(input) });
    return res.json({ article });
  } catch (error) { return next(error); }
});

router.delete('/:id', requireAuth, requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const article = await prisma.knowledgeArticle.update({ where: { id }, data: { deletedAt: new Date(), isPublished: false } });
    await recordAudit(req, 'KNOWLEDGE_ARTICLE_DELETED', 'KnowledgeArticle', id);
    return res.status(204).end();
  } catch (error) { return next(error); }
});

export default router;
