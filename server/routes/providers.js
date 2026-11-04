import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { canSeeProviderCosts, requirePermission, requireRole } from '../middleware/permissions.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
const providerSchema = z.object({
  name: z.string().trim().min(2).max(160), contactName: z.string().trim().max(120).optional(),
  email: z.union([z.string().email().max(254), z.literal('')]).optional(),
  phone: z.string().trim().max(40).optional(), agreementStatus: z.enum(['PENDING', 'ACTIVE', 'PAUSED', 'ENDED']).default('PENDING'),
  cancellationPolicy: z.string().max(4_000).optional(), paymentTerms: z.string().max(1_000).optional(),
  commissionBasisPoints: z.number().int().min(0).max(10_000).optional(), internalNotes: z.string().max(5_000).optional(),
}).strict();
const centreSchema = z.object({
  providerId: z.string().uuid(), name: z.string().trim().min(2).max(160),
  location: z.string().trim().min(2).max(160), postcode: z.string().trim().max(20).optional(),
  categories: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  testElements: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  contactDetails: z.string().max(2_000).optional(), internalNotes: z.string().max(5_000).optional(),
}).strict();
const priceSchema = z.object({
  providerId: z.string().uuid(), trainingCentreId: z.string().uuid().optional(), category: z.string().max(40).optional(),
  itemCode: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(250),
  tradeCostPence: z.number().int().min(0).max(100_000_000), vatBasisPoints: z.number().int().min(0).max(10_000),
  testFeePence: z.number().int().min(0).max(100_000_000).default(0), marginPence: z.number().int().min(0).max(100_000_000),
  retailPricePence: z.number().int().min(0).max(200_000_000), depositPence: z.number().int().min(0).max(200_000_000).default(0),
  isActive: z.boolean().default(true),
}).strict();

function providerResult(provider, includeCost) {
  return {
    id: provider.id, name: provider.name, contactName: provider.contactName, email: provider.email,
    phone: provider.phone, agreementStatus: provider.agreementStatus,
    cancellationPolicy: provider.cancellationPolicy, paymentTerms: provider.paymentTerms,
    centres: provider.centres?.map(centre => ({
      id: centre.id, name: centre.name, location: centre.location, postcode: centre.postcode,
      categories: JSON.parse(centre.categoriesJson), testElements: JSON.parse(centre.testElementsJson),
      contactDetails: centre.contactDetails,
    })) || [],
    prices: provider.prices?.map(price => ({
      id: price.id, itemCode: price.itemCode, description: price.description,
      retailPricePence: price.retailPricePence, category: price.category, isActive: price.isActive,
      ...(includeCost ? { tradeCostPence: price.tradeCostPence, marginPence: price.marginPence, vatBasisPoints: price.vatBasisPoints, testFeePence: price.testFeePence } : {}),
    })) || [],
  };
}

router.get('/', requireAuth, requirePermission('providers:read'), async (req, res, next) => {
  try {
    const providers = await prisma.provider.findMany({
      where: { deletedAt: null }, include: { centres: { where: { deletedAt: null }, orderBy: { name: 'asc' } }, prices: { where: { isActive: true } } },
      orderBy: { name: 'asc' }, take: 200,
    });
    return res.json({ providers: providers.map(provider => providerResult(provider, canSeeProviderCosts(req.user))) });
  } catch (error) { return next(error); }
});

router.post('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const input = providerSchema.parse(req.body);
    const provider = await prisma.provider.create({ data: input });
    await recordAudit(req, 'PROVIDER_CREATED', 'Provider', provider.id);
    return res.status(201).json({ provider: providerResult(provider, canSeeProviderCosts(req.user)) });
  } catch (error) { return next(error); }
});

router.patch('/:id', requireAuth, requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const input = providerSchema.partial().strict().parse(req.body);
    const provider = await prisma.provider.update({ where: { id: req.params.id }, data: input, include: { centres: true, prices: true } });
    await recordAudit(req, 'PROVIDER_UPDATED', 'Provider', provider.id, { fields: Object.keys(input) });
    return res.json({ provider: providerResult(provider, canSeeProviderCosts(req.user)) });
  } catch (error) { return next(error); }
});

router.post('/centres', requireAuth, requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const input = centreSchema.parse(req.body);
    const { categories, testElements, ...data } = input;
    const centre = await prisma.trainingCentre.create({ data: { ...data, categoriesJson: JSON.stringify(categories), testElementsJson: JSON.stringify(testElements) } });
    await recordAudit(req, 'TRAINING_CENTRE_CREATED', 'TrainingCentre', centre.id);
    return res.status(201).json({ centre: { ...centre, categories, testElements } });
  } catch (error) { return next(error); }
});

router.get('/courses', requireAuth, requirePermission('providers:read'), async (_req, res, next) => {
  try {
    const courses = await prisma.course.findMany({ where: { status: 'AVAILABLE' }, include: { provider: { select: { id: true, name: true } }, trainingCentre: { select: { id: true, name: true, location: true, postcode: true } } }, orderBy: { startsAt: 'asc' }, take: 300 });
    return res.json({ courses });
  } catch (error) { return next(error); }
});

router.post('/prices', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const input = priceSchema.parse(req.body);
    const price = await prisma.priceItem.create({ data: input });
    await recordAudit(req, 'PROVIDER_PRICE_CREATED', 'PriceItem', price.id, { itemCode: price.itemCode, retailPricePence: price.retailPricePence });
    return res.status(201).json({ price: priceItemResult(price, canSeeProviderCosts(req.user)) });
  } catch (error) { return next(error); }
});

router.patch('/prices/:id', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const input = priceSchema.partial().strict().omit({ providerId: true, itemCode: true }).parse(req.body);
    const price = await prisma.priceItem.update({ where: { id: req.params.id }, data: input });
    await recordAudit(req, 'PROVIDER_PRICE_UPDATED', 'PriceItem', price.id, { fields: Object.keys(input) });
    return res.json({ price: priceItemResult(price, canSeeProviderCosts(req.user)) });
  } catch (error) { return next(error); }
});

export function priceItemResult(price, includeCost = false) {
  return {
    id: price.id, itemCode: price.itemCode, description: price.description, category: price.category,
    retailPricePence: price.retailPricePence, depositPence: price.depositPence, isActive: price.isActive,
    ...(includeCost ? { tradeCostPence: price.tradeCostPence, vatBasisPoints: price.vatBasisPoints, testFeePence: price.testFeePence, marginPence: price.marginPence } : {}),
  };
}

export default router;
