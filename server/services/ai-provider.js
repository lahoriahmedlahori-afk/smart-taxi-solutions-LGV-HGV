import { config } from '../config.js';
import { prisma } from '../db.js';
import { decryptSecret } from '../security/credentials.js';

const PROVIDERS = new Set(['ollama', 'openai-compatible', 'groq-compatible', 'openrouter-compatible', 'gemini']);
const BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

export class AiProviderError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = 'AiProviderError';
    this.status = status;
  }
}

async function getSetting(key) {
  return prisma.appSetting.findUnique({ where: { key } });
}

async function providerConfig() {
  const [enabledSetting, providerSetting, modelSetting, baseSetting, keySetting, externalSetting] = await Promise.all([
    getSetting('ai.enabled'), getSetting('ai.provider'), getSetting('ai.model'), getSetting('ai.baseUrl'),
    getSetting('ai.apiKey'), getSetting('ai.allowExternal'),
  ]);
  const enabled = enabledSetting?.value === undefined ? config.ai.enabled : enabledSetting.value === 'true';
  const provider = providerSetting?.value || config.ai.provider;
  const model = modelSetting?.value || config.ai.model;
  const baseUrl = baseSetting?.value || config.ai.baseUrl || (provider === 'ollama' ? config.ai.ollamaBaseUrl : BASE_URLS[provider.replace('-compatible', '')] || '');
  const apiKey = keySetting?.encryptedValue ? decryptSecret(keySetting.encryptedValue) : config.ai.apiKey;
  const allowExternal = externalSetting?.value === 'true';
  if (!PROVIDERS.has(provider)) throw new AiProviderError('AI provider is not supported.', 400);
  if (!enabled) throw new AiProviderError('AI assistance is disabled.', 503);
  if (provider !== 'ollama' && !allowExternal) throw new AiProviderError('External AI providers are disabled by the administrator.', 503);
  if (provider !== 'ollama' && !apiKey) throw new AiProviderError('An API key must be configured by an administrator.', 503);
  if (!model) throw new AiProviderError('An AI model must be configured.', 503);
  return { provider, model, baseUrl: baseUrl.replace(/\/$/, ''), apiKey };
}

async function readJson(response) {
  let body;
  try { body = await response.json(); } catch { throw new AiProviderError('AI provider returned an unreadable response.'); }
  if (!response.ok) throw new AiProviderError(`AI provider request failed (${response.status}).`);
  return body;
}

async function requestJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return await readJson(response);
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError(error.name === 'AbortError' ? 'AI provider timed out.' : 'AI provider is unavailable.');
  } finally {
    clearTimeout(timeout);
  }
}

export async function completeWithAi({ system, user, json = true, configOverride }) {
  const settings = configOverride || await providerConfig();
  if (settings.provider === 'ollama') {
    const body = await requestJson(`${settings.baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: settings.model, stream: false, format: json ? 'json' : undefined, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    return body.message?.content || '';
  }
  if (settings.provider === 'gemini') {
    const body = await requestJson(`${settings.baseUrl || 'https://generativelanguage.googleapis.com/v1beta'}/models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: json ? 'application/json' : 'text/plain' } }),
    });
    return body.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
  }
  const body = await requestJson(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.model, temperature: 0.2, response_format: json ? { type: 'json_object' } : undefined, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  return body.choices?.[0]?.message?.content || '';
}

export async function testAiConnection() {
  const settings = await providerConfig();
  await completeWithAi({ system: 'Return a JSON object with one field named ok set to true.', user: 'Connection test.', configOverride: settings });
  return { provider: settings.provider, model: settings.model, connected: true };
}

export function publicAiSettings(settings = config.ai) {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    hasApiKey: Boolean(settings.apiKey),
    allowExternal: false,
  };
}
