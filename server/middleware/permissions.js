const ROLE_PERMISSIONS = {
  Admin: ['*'],
  Manager: [
    'customers:read', 'customers:write', 'leads:read', 'leads:write',
    'consultations:read', 'consultations:write', 'quotes:read', 'quotes:write',
    'bookings:read', 'bookings:write', 'followups:read', 'followups:write',
    'reports:read', 'providers:read', 'providers:write', 'pricing:read',
    'knowledge:read', 'knowledge:write', 'ai:use',
  ],
  'Sales Adviser': [
    'customers:read', 'customers:write', 'leads:read', 'leads:write',
    'consultations:read', 'consultations:write', 'quotes:read', 'quotes:write',
    'followups:read', 'followups:write', 'pricing:read', 'knowledge:read', 'ai:use',
  ],
  Viewer: [
    'customers:read', 'leads:read', 'consultations:read', 'quotes:read',
    'bookings:read', 'followups:read', 'reports:read', 'providers:read',
    'pricing:read', 'knowledge:read',
  ],
};

export const permissionsForRole = role => ROLE_PERMISSIONS[role] || [];

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in.' } });
    const allowed = permissionsForRole(req.user.role).includes('*') || req.user.permissions?.has(permission);
    if (!allowed) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' } });
    return next();
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in.' } });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' } });
    return next();
  };
}

export function leadScope(user) {
  return user.role === 'Sales Adviser'
    ? { OR: [{ assignedToId: user.id }, { createdById: user.id }] }
    : {};
}

export function customerScope(user) {
  return user.role === 'Sales Adviser'
    ? { OR: [
      { leads: { some: { OR: [{ assignedToId: user.id }, { createdById: user.id }], deletedAt: null } } },
      { consultations: { some: { createdById: user.id, deletedAt: null } } },
    ] }
    : {};
}

export function canSeeProviderCosts(user) {
  return user.role === 'Admin';
}
