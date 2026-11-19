import jwt from 'jsonwebtoken';
import { vaultSecrets } from './secrets.js';
import { currentTenant } from './tenant.js';

// Gemini for the business (its own key from the portal vault, else SmartEsek's env key), JSON out.
// Every call is reported to the CRM's AI usage log ("💸 הוצאות AI", app "marketing").
const KNOWN_GOOD = 'gemini-3.7-flash';
const modelCache = new Map<string, { at: number; models: string[] }>();

async function flashModels(key: string): Promise<string[]> {
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.models;
  let listed: string[] = [];
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) });
    const d: any = await r.json();
    listed = (d.models || [])
      .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m: any) => String(m.name || '').replace(/^models\//, ''))
      .filter((n: string) => /^gemini-.*flash/.test(n) && !/(image|tts|audio|live|embedding|lite|preview|exp)/.test(n));
  } catch { /* fall back to the known name */ }
  const ver = (n: string) => Number(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || 0);
  listed.sort((a, b) => ver(b) - ver(a) || a.length - b.length);
  const models = Array.from(new Set([process.env.GEMINI_MODEL, KNOWN_GOOD, ...listed].filter(Boolean) as string[])).slice(0, 3);
  modelCache.set(key, { at: Date.now(), models });
  return models;
}

async function reportUsage(call: Record<string, any>) {
  const secret = process.env.SSO_SHARED_SECRET;
  if (!secret) return;
  try {
    const token = jwt.sign({ typ: 'ai-usage', app: 'marketing', portalTenantId: Number(currentTenant()) || undefined }, secret, { expiresIn: '2m' });
    await fetch(`${process.env.CRM_URL || 'https://crm.smartesek.com'}/api/ai-usage/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-usage-token': token },
      body: JSON.stringify(call), signal: AbortSignal.timeout(5000),
    });
  } catch { /* the log is best effort */ }
}

export async function aiJson(system: string, user: string, feature: string, detail?: string): Promise<{ text: string | null; error?: string }> {
  const fromVault = (await vaultSecrets())['GEMINI_API_KEY'];
  const key = fromVault || process.env.GEMINI_API_KEY || '';
  if (!key) return { text: null, error: 'אין מפתח Gemini (בפורטל: "מזהים וחיבורים" ← בינה מלאכותית)' };
  let lastErr = '';
  for (const model of await flashModels(key)) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 12000, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(45000),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok) { lastErr = d?.error?.message || `Gemini ${r.status}`; continue; }
      const text = (d.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join('').trim();
      const u = d.usageMetadata || {};
      reportUsage({ feature, detail, model, inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount, thoughtTokens: u.thoughtsTokenCount, cachedTokens: u.cachedContentTokenCount, keySource: fromVault ? 'business' : 'platform', ok: !!text });
      if (text) return { text };
    } catch (e: any) {
      lastErr = e?.message || 'network';
    }
  }
  return { text: null, error: lastErr || 'ה-AI לא ענה' };
}
