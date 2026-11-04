import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { canSeeProviderCosts, requirePermission } from '../middleware/permissions.js';

const router = Router();

router.get('/', requireAuth, requirePermission('pricing:read'), async (req, res, next) => {
  try {
    const query = z.object({ category: z.string().max(40).optional(), centreId: z.string().uuid().optional() }).parse(req.query);
    const prices = await prisma.priceItem.findMany({
      where: {
        isActive: true,
        ...(query.category ? { category: query.category } : {}),
        ...(query.centreId ? { trainingCentreId: query.centreId } : {}),
      },
      include: { provider: { select: { id: true, name: true } }, trainingCentre: { select: { id: true, name: true, location: true, postcode: true } } },
      orderBy: [{ category: 'asc' }, { description: 'asc' }], take: 500,
    });
    return res.json({ prices: prices.map(price => ({
      id: price.id, category: price.category, itemCode: price.itemCode, description: price.description,
      retailPricePence: price.retailPricePence, depositPence: price.depositPence,
      provider: price.provider, trainingCentre: price.trainingCentre,
      ...(canSeeProviderCosts(req.user) ? { tradeCostPence: price.tradeCostPence, vatBasisPoints: price.vatBasisPoints, testFeePence: price.testFeePence, marginPence: price.marginPence } : {}),
    })) });
  } catch (error) { return next(error); }
});

export default router;
