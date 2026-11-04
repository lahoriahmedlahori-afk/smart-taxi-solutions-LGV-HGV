import { prisma } from '../db.js';

export async function recordAudit(req, action, resource, resourceId = null, metadata = undefined) {
  const safeMetadata = metadata === undefined ? null : JSON.stringify(metadata);
  return prisma.auditLog.create({
    data: {
      actorId: req.user?.id || null,
      action,
      resource,
      resourceId,
      metadata: safeMetadata,
      ipAddress: req.ip || null,
      userAgent: req.get('user-agent')?.slice(0, 500) || null,
    },
  });
}

export async function recordActivity({ actorId, customerId, leadId, consultationId, type, summary, metadata }) {
  return prisma.activity.create({
    data: {
      actorId: actorId || null,
      customerId: customerId || null,
      leadId: leadId || null,
      consultationId: consultationId || null,
      type,
      summary,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });
}
