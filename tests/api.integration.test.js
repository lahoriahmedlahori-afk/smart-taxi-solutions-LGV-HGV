import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { prisma } from '../server/db.js';
import { hashPassword } from '../server/security/credentials.js';

const baseUrl = 'http://127.0.0.1:3001/api/v1';
const origin = 'http://localhost:4173';
const suffix = randomBytes(8).toString('hex');
const email = `api-test-${suffix}@example.test`;
const password = `Test-${randomBytes(20).toString('base64url')}!`;
let userId;
let adminId;
let customerId;
let sessionCookie;
let adminCookie;
let previousAiEnabled;
let aiSettingChanged = false;
let leadId;
let quoteId;
let followUpId;
let providerId;

async function request(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      origin,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}

after(async () => {
  if (quoteId) await prisma.payment.deleteMany({ where: { quoteId } });
  if (customerId) {
    await prisma.booking.deleteMany({ where: { customerId } });
    await prisma.followUp.deleteMany({ where: { customerId } });
    await prisma.quote.deleteMany({ where: { customerId } });
    await prisma.consultation.deleteMany({ where: { customerId } });
    await prisma.lead.deleteMany({ where: { customerId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
  }
  if (followUpId) await prisma.followUp.deleteMany({ where: { id: followUpId } });
  if (leadId) await prisma.lead.deleteMany({ where: { id: leadId } });
  if (providerId) await prisma.provider.deleteMany({ where: { id: providerId } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  if (adminId) await prisma.user.deleteMany({ where: { id: adminId } });
  if (aiSettingChanged && previousAiEnabled) await prisma.appSetting.upsert({ where: { key: 'ai.enabled' }, update: { value: previousAiEnabled.value, encryptedValue: previousAiEnabled.encryptedValue, isSecret: previousAiEnabled.isSecret }, create: { key: 'ai.enabled', value: previousAiEnabled.value, encryptedValue: previousAiEnabled.encryptedValue, isSecret: previousAiEnabled.isSecret } });
  else if (aiSettingChanged) await prisma.appSetting.deleteMany({ where: { key: 'ai.enabled' } });
  await prisma.$disconnect();
});

test('authenticated adviser can persist a draft and lead while restricted admin APIs deny access', async () => {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'Sales Adviser' } });
  const user = await prisma.user.create({ data: { email, name: 'API Integration Adviser', passwordHash: await hashPassword(password), roleId: role.id } });
  userId = user.id;

  const login = await request('/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(login.response.status, 200);
  assert.equal(login.data.user.role, 'Sales Adviser');
  sessionCookie = login.response.headers.get('set-cookie')?.split(';')[0];
  assert.match(sessionCookie || '', /^sts_session=/);

  const session = await request('/auth/session', { cookie: sessionCookie });
  assert.equal(session.data.user.id, user.id);
  const forbidden = await request('/users', { cookie: sessionCookie });
  assert.equal(forbidden.response.status, 403);
  const forbiddenAiSettings = await request('/ai/settings', { cookie: sessionCookie });
  assert.equal(forbiddenAiSettings.response.status, 403);
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'Admin' } });
  const adminEmail = `api-admin-${suffix}@example.test`;
  const adminPassword = `Admin-${randomBytes(20).toString('base64url')}!`;
  const admin = await prisma.user.create({ data: { email: adminEmail, name: 'API Integration Admin', passwordHash: await hashPassword(adminPassword), roleId: adminRole.id } });
  adminId = admin.id;
  const adminLogin = await request('/auth/login', { method: 'POST', body: { email: adminEmail, password: adminPassword } });
  assert.equal(adminLogin.response.status, 200);
  adminCookie = adminLogin.response.headers.get('set-cookie')?.split(';')[0];

  const clientDraftKey = randomUUID();
  const draft = await request('/consultations/draft', {
    method: 'POST', cookie: sessionCookie,
    body: { clientDraftKey, profile: { first: 'Integration', last: suffix, email }, answers: {}, callNotes: '' },
  });
  assert.equal(draft.response.status, 200);
  customerId = (await prisma.customer.findFirst({ where: { email, createdById: userId }, select: { id: true } }))?.id;
  const consultationId = draft.data.consultation.id;

  previousAiEnabled = await prisma.appSetting.findUnique({ where: { key: 'ai.enabled' } });
  aiSettingChanged = true;
  await prisma.appSetting.upsert({ where: { key: 'ai.enabled' }, update: { value: 'false' }, create: { key: 'ai.enabled', value: 'false' } });
  const extraction = await request('/ai/extract', {
    method: 'POST', cookie: sessionCookie,
    body: { consultationId, text: "Customer is 32, has a full UK licence, wants Class 1, hasn't done medical or theory and wants training near Birmingham." },
  });
  assert.equal(extraction.response.status, 200);
  assert.equal(extraction.data.aiUsed, false);
  assert.equal(extraction.data.extraction.age, 32);
  assert.equal(extraction.data.extraction.goal, 'C_PLUS_E');
  assert.equal(extraction.data.extraction.preferredLocation, 'Birmingham');

  const initialQuestion = await request(`/consultations/${consultationId}/next-question`, { cookie: sessionCookie });
  assert.equal(initialQuestion.data.question.key, 'goal');
  const confirmed = await request(`/consultations/${consultationId}/confirm-extraction`, {
    method: 'POST', cookie: sessionCookie,
    body: { fields: { age: '32', licence: 'Yes', goal: 'Articulated lorry', medical: 'Not yet', theory: 'Not started', location: 'Birmingham' } },
  });
  assert.equal(confirmed.response.status, 200);
  const overwriteBlocked = await request(`/consultations/${consultationId}/confirm-extraction`, {
    method: 'POST', cookie: sessionCookie, body: { fields: { age: '33' } },
  });
  assert.equal(overwriteBlocked.response.status, 409);
  const correction = await request(`/consultations/${consultationId}/confirm-extraction`, {
    method: 'POST', cookie: sessionCookie, body: { fields: { age: '33' }, replaceExisting: true },
  });
  assert.equal(correction.response.status, 200);
  const nextAfterExtraction = await request(`/consultations/${consultationId}/next-question`, { cookie: sessionCookie });
  assert.equal(nextAfterExtraction.data.question.key, 'held');

  const saved = await request('/leads', {
    method: 'POST', cookie: sessionCookie,
    body: {
      clientDraftKey, profile: { first: 'Integration', last: suffix, email }, answers: { goal: 'Articulated lorry' },
      route: 'C+E', status: 'Consultation Started', estimatePence: 155000, notes: '', progress: 10, currentStage: 'Licence checked',
    },
  });
  assert.equal(saved.response.status, 201);
  leadId = saved.data.lead.id;
  const repeated = await request('/leads', {
    method: 'POST', cookie: sessionCookie,
    body: {
      clientDraftKey, profile: { first: 'Integration', last: suffix, email }, answers: { goal: 'Articulated lorry' },
      route: 'C+E', status: 'Consultation Started', estimatePence: 155000, notes: '', progress: 10, currentStage: 'Licence checked',
    },
  });
  assert.equal(repeated.response.status, 201);
  assert.equal(repeated.data.lead.id, saved.data.lead.id);

  const providerResult = await request('/providers', { method: 'POST', cookie: adminCookie, body: { name: `Integration provider ${suffix}`, email: '' } });
  assert.equal(providerResult.response.status, 201);
  providerId = providerResult.data.provider.id;
  const priceResult = await request('/providers/prices', {
    method: 'POST', cookie: adminCookie,
    body: { providerId: providerResult.data.provider.id, category: 'C+E', itemCode: `CPLUS-${suffix}`, description: 'C+E integration test course', tradeCostPence: 125000, vatBasisPoints: 2000, testFeePence: 15000, marginPence: 25000, retailPricePence: 185000, depositPence: 25000, isActive: true },
  });
  assert.equal(priceResult.response.status, 201);
  const retailPrices = await request('/pricing', { cookie: sessionCookie });
  assert.equal(retailPrices.response.status, 200);
  assert.equal(Object.hasOwn(retailPrices.data.prices.find(item => item.id === priceResult.data.price.id), 'tradeCostPence'), false);

  const quote = await request('/quotes', {
    method: 'POST', cookie: sessionCookie,
    body: { customerId, leadId: saved.data.lead.id, items: [{ priceItemId: priceResult.data.price.id, quantity: 1 }], discountPence: 0, depositPence: 25000 },
  });
  assert.equal(quote.response.status, 201);
  quoteId = quote.data.quote.id;
  assert.equal(quote.data.quote.totalPence, 222000);
  assert.equal(Object.hasOwn(quote.data.quote.items[0], 'providerCostPence'), false);
  assert.equal((await request(`/quotes/${quote.data.quote.id}/status`, { method: 'PATCH', cookie: sessionCookie, body: { status: 'SENT' } })).response.status, 200);

  const followUp = await request('/follow-ups', {
    method: 'POST', cookie: sessionCookie,
    body: { customerId, leadId: saved.data.lead.id, reason: 'Quote follow-up', dueAt: new Date(Date.now() + 86400000).toISOString() },
  });
  assert.equal(followUp.response.status, 201);
  followUpId = followUp.data.followUp.id;
  const followUps = await request('/follow-ups', { cookie: sessionCookie });
  assert.ok(followUps.data.followUps.some(item => item.id === followUp.data.followUp.id));
  const forbiddenBooking = await request('/bookings', { method: 'POST', cookie: sessionCookie, body: { customerId } });
  assert.equal(forbiddenBooking.response.status, 403);
  const booking = await request('/bookings', {
    method: 'POST', cookie: adminCookie,
    body: { customerId, leadId: saved.data.lead.id, quoteId: quote.data.quote.id, depositPence: quote.data.quote.depositPence },
  });
  assert.equal(booking.response.status, 201);
  assert.equal(booking.data.booking.status, 'PREPARING');
  const blockedConfirmation = await request(`/bookings/${booking.data.booking.id}`, { method: 'PATCH', cookie: adminCookie, body: { status: 'CONFIRMED' } });
  assert.equal(blockedConfirmation.response.status, 400);
  const confirmedBooking = await request(`/bookings/${booking.data.booking.id}`, {
    method: 'PATCH', cookie: adminCookie,
    body: { status: 'CONFIRMED', entitlementVerified: true, requirementsVerified: true, providerConfirmed: true },
  });
  assert.equal(confirmedBooking.response.status, 200);
  assert.equal(confirmedBooking.data.booking.status, 'CONFIRMED');

  const leads = await request('/leads', { cookie: sessionCookie });
  assert.ok(leads.data.leads.some(lead => lead.id === saved.data.lead.id));
  const logout = await request('/auth/logout', { method: 'POST', cookie: sessionCookie });
  assert.equal(logout.response.status, 204);
  await request('/auth/logout', { method: 'POST', cookie: adminCookie });
});
