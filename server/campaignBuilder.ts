// A new campaign from an instruction (Haim, 2026-11-20 - step 3 of the plan):
//  1. POST /api/meta-ads/drafts { instruction, baseCampaignId } - the AI reads the base campaign (a
//     proven one: by default the one with the most leads in the last 30 days) and the instruction and
//     writes a draft: name, daily budget (₪), places, age, gender, 3 primary texts + 3 headlines.
//     Places are matched to Meta's own place list (`/search?type=adgeolocation`). Stored in mk_drafts.
//  2. The person reviews and edits it on the screen (PUT /api/meta-ads/drafts/:id), may add new
//     pictures / videos (uploaded with the media routes of adMedia.ts).
//  3. POST /api/meta-ads/drafts/:id/publish - creates a new campaign PAUSED (the base's objective,
//     budget level, bid strategy, special ad categories), ONE ad set copied from the base's best ad set
//     (most leads in 30 days: optimisation goal, lead form / promoted object, placements, value rules,
//     attribution, audiences, interests - only places / age / gender / budget changed as approved),
//     and its ads: each of the base ad set's live ads (≤6) as a new creative with the approved texts
//     (and the new media, when given). The ad set and ads are created ACTIVE inside the PAUSED campaign,
//     so going live is ONE tap ("▶️ להפעיל את הקמפיין" = activate_campaign). Logged in mk_changes as
//     `create_campaign` (undo = archive it).
import express from 'express';
import { adsCredsForCurrentBusiness } from './metaAdsSnapshot.js';
import { aiJson } from './ai.js';
import { db, ensureTables } from './db.js';
import { currentTenant, currentUser } from './tenant.js';
import { gget, metaErr, ilsPerUnit, targetingSummary, parseJson } from './campaignOptimizer.js';
import { creativeWithMedia, Media } from './adMedia.js';
import { fixAssetRules } from './assetRules.js';

const GRAPH = process.env.META_GRAPH_URL || 'https://graph.facebook.com/v21.0';
const who = () => currentUser()?.email || 'unknown';
const MAX_ADS = 6;
const LEAD_TYPES = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
const leadsOf = (row: any) => {
  for (const t of LEAD_TYPES) { const a = (row?.actions || []).find((x: any) => x.action_type === t); if (a) return Number(a.value) || 0; }
  return 0;
};

async function post(path: string, token: string, body: Record<string, any>) {
  const form: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) form[k] = typeof v === 'string' ? v : JSON.stringify(v);
  try {
    const r = await fetch(`${GRAPH}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...form, access_token: token }), signal: AbortSignal.timeout(30000),
    });
    return { ok: r.ok, data: (await r.json().catch(() => ({}))) as any };
  } catch (e: any) {
    return { ok: false, data: { error: { message: e?.message || 'network' } } };
  }
}

async function ensureDraftTable() {
  const p = await ensureTables();
  await p.query(`CREATE TABLE IF NOT EXISTS mk_drafts (
    id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    instruction TEXT, base_campaign_id TEXT, base_adset_id TEXT, draft JSONB NOT NULL, context JSONB,
    status TEXT NOT NULL DEFAULT 'draft', published JSONB, published_at TIMESTAMPTZ)`);
  return p;
}

// ---------- places ----------

export type Place = { key: string; name: string; type: 'city' | 'region' | 'country'; region?: string; radiusKm?: number | null };

export async function searchPlaces(token: string, q: string): Promise<Place[]> {
  const r = await gget('search', token, { type: 'adgeolocation', q, location_types: JSON.stringify(['city', 'region', 'country']), limit: '8', locale: 'he_IL' });
  if (!r.ok) return [];
  return (r.data?.data || [])
    .filter((x: any) => !x.country_code || x.country_code === 'IL' || x.type === 'country')
    .map((x: any) => ({ key: String(x.key), name: String(x.name), type: x.type, region: x.region || undefined }));
}

// the targeting of the base ad set with the approved places / age / gender
export function applyTargeting(base: any, d: Draft): any {
  const t = JSON.parse(JSON.stringify(base || {}));
  if (d.places && d.places.length) {
    const geo: any = {};
    const cities = d.places.filter(p => p.type === 'city');
    const regions = d.places.filter(p => p.type === 'region');
    const countries = d.places.filter(p => p.type === 'country');
    if (cities.length) geo.cities = cities.map(c => ({ key: c.key, ...(c.radiusKm ? { radius: Math.min(80, Math.max(17, Math.round(c.radiusKm))), distance_unit: 'kilometer' } : {}) }));
    if (regions.length) geo.regions = regions.map(r => ({ key: r.key }));
    if (countries.length) geo.countries = countries.map(c => c.key);
    geo.location_types = t.geo_locations?.location_types || ['home', 'recent'];
    t.geo_locations = geo;
    delete t.excluded_geo_locations;
  }
  if (d.ageMin) t.age_min = d.ageMin;
  if (d.ageMax) t.age_max = d.ageMax;
  if (d.genders === 'female') t.genders = [2];
  else if (d.genders === 'male') t.genders = [1];
  else if (d.genders === 'all') delete t.genders;
  if (d.advantageAudience != null) t.targeting_automation = { ...(t.targeting_automation || {}), advantage_audience: d.advantageAudience ? 1 : 0 };
  // `age_range` is Advantage+ audience's suggested age - Meta refuses it without Advantage+ ("The field
  // targeting_automation must be enabled to use the field age_range", #100/1487079 - Haim, 2026-11-20:
  // the campaign was created and its ad set refused). With Advantage+ on, the approved age is the suggestion.
  const advOn = Number(t.targeting_automation?.advantage_audience) === 1;
  if (!advOn) delete t.age_range;
  else if (d.ageMin || d.ageMax) t.age_range = [d.ageMin || t.age_range?.[0] || 18, d.ageMax || t.age_range?.[1] || 65];
  return t;
}

// the approved texts into a creative spec (single picture / video, carousel, flexible)
export function applyTexts(spec: any, texts: { bodies: string[]; titles: string[]; descriptions: string[] }) {
  const bodies = texts.bodies.map(s => s.trim()).filter(Boolean);
  const titles = texts.titles.map(s => s.trim()).filter(Boolean);
  const descs = texts.descriptions.map(s => s.trim()).filter(Boolean);
  if (spec.asset_feed_spec) {
    const afs = spec.asset_feed_spec;
    // the new texts take the old ones' places, labels included (placement rules point at them)
    const keep = (old: any[] | undefined, list: string[]) => list.map((text, i) => (old?.[i]?.adlabels ? { text, adlabels: old[i].adlabels } : { text }));
    if (bodies.length) afs.bodies = keep(afs.bodies, bodies);
    if (titles.length) afs.titles = keep(afs.titles, titles);
    if (descs.length) afs.descriptions = keep(afs.descriptions, descs);
    fixAssetRules(afs);
    return spec;
  }
  const oss = spec.object_story_spec;
  if (oss?.video_data) {
    if (bodies[0]) oss.video_data.message = bodies[0];
    if (titles[0]) oss.video_data.title = titles[0];
    if (descs[0]) oss.video_data.link_description = descs[0];
  } else if (oss?.link_data) {
    if (bodies[0]) oss.link_data.message = bodies[0];
    if (!oss.link_data.child_attachments) {
      if (titles[0]) oss.link_data.name = titles[0];
      if (descs[0]) oss.link_data.description = descs[0];
    }
  }
  return spec;
}

// ---------- the draft ----------

export type Draft = {
  name: string;
  dailyBudgetIls: number;
  places: Place[] | null; // null = the base ad set's places
  ageMin: number | null; ageMax: number | null;
  genders: 'all' | 'female' | 'male' | null; // null = as the base
  advantageAudience: boolean | null; // null = as the base
  texts: { bodies: string[]; titles: string[]; descriptions: string[] };
  media: { type: 'video' | 'image'; id?: string; hash?: string; thumb?: string }[]; // empty = the base ads' media
  explanation?: string;
};

export function cleanDraft(raw: any, ctx: any): Draft {
  const num = (v: any) => (v == null || v === '' ? null : Number(v));
  const age = (v: any) => { const n = num(v); return n == null || !isFinite(n) ? null : Math.min(65, Math.max(18, Math.round(n))); };
  const list = (v: any, max: number) => (Array.isArray(v) ? v : []).map((x: any) => String(x || '').slice(0, 2000)).filter((x: string) => x.trim()).slice(0, max);
  const d: Draft = {
    name: String(raw?.name || `${ctx.baseName} - חדש`).slice(0, 200),
    dailyBudgetIls: Math.max(1, Math.round(Number(raw?.dailyBudgetIls) || ctx.baseDailyIls || 50)),
    places: Array.isArray(raw?.places) && raw.places.length
      ? raw.places.filter((p: any) => p?.key && p?.name).slice(0, 25).map((p: any) => ({ key: String(p.key), name: String(p.name), type: ['city', 'region', 'country'].includes(p.type) ? p.type : 'city', region: p.region, radiusKm: num(p.radiusKm) }))
      : null,
    ageMin: age(raw?.ageMin), ageMax: age(raw?.ageMax),
    genders: ['all', 'female', 'male'].includes(raw?.genders) ? raw.genders : null,
    advantageAudience: typeof raw?.advantageAudience === 'boolean' ? raw.advantageAudience : null,
    texts: { bodies: list(raw?.texts?.bodies, 5), titles: list(raw?.texts?.titles, 5).map(s => s.slice(0, 120)), descriptions: list(raw?.texts?.descriptions, 3).map(s => s.slice(0, 200)) },
    media: (Array.isArray(raw?.media) ? raw.media : []).filter((m: any) => (m?.type === 'video' && m.id) || (m?.type === 'image' && m.hash)).slice(0, 10)
      .map((m: any) => ({ type: m.type, id: m.id ? String(m.id).replace(/\D/g, '') : undefined, hash: m.hash ? String(m.hash).replace(/[^\w]/g, '') : undefined, thumb: m.thumb ? String(m.thumb) : undefined })),
    explanation: raw?.explanation ? String(raw.explanation).slice(0, 1500) : undefined,
  };
  if (d.ageMin && d.ageMax && d.ageMin > d.ageMax) [d.ageMin, d.ageMax] = [d.ageMax, d.ageMin];
  return d;
}

// what's wrong with a draft before it can go to Meta (shown on the screen)
export function draftProblems(d: Draft, ctx: any): string[] {
  const out: string[] = [];
  const adv = d.advantageAudience ?? ctx.baseAdvantage;
  if (adv && d.ageMin && d.ageMin > 25) out.push('עם Advantage+ קהל מטא לא מאפשרת גיל מינימום מעל 25 - כבו את Advantage+ או הורידו את הגיל');
  if (adv && d.ageMax && d.ageMax < 65) out.push('עם Advantage+ קהל מטא לא מאפשרת גיל מקסימום מתחת ל-65 - כבו את Advantage+ או השאירו 65');
  if (!d.texts.bodies.length) out.push('חסר טקסט למודעה');
  if (ctx.minDailyIls && d.dailyBudgetIls < ctx.minDailyIls) out.push(`התקציב היומי נמוך מהמינימום של מטא (₪${ctx.minDailyIls})`);
  if (!ctx.baseAds?.length && !d.media.length) out.push('לסט הבסיס אין מודעות פעילות - צריך להעלות תמונה או סרטון');
  return out;
}

const SYSTEM = `אתה מנהל קמפיינים בכיר של Meta לעסק קטן בישראל. בונים קמפיין חדש על בסיס קמפיין מוכח של העסק, לפי ההוראה של בעל העסק.
קיבלת: ההוראה, את קמפיין הבסיס (מטרה, תקציב, הסט הכי טוב שלו: מיקומים, גיל, מגדר, קהלים, ואת הטקסטים של המודעות שלו ותוצאות 30 יום).
מה משנים: רק מה שההוראה מבקשת (מיקום / גיל / מגדר / תקציב / מסר). כל השאר נשאר כמו בבסיס.
- dailyBudgetIls: תקציב יומי בשקלים. אם לא נאמר - כמו הבסיס.
- places: רשימת מקומות לפי ההוראה, כל אחד { "name": שם יישוב/אזור בעברית כפי שמחפשים במפה, "radiusKm": רדיוס בק"מ (17-80) או null }. אם ההוראה לא מדברת על מיקום - null (נשאר כמו בבסיס).
- ageMin / ageMax / genders ("all" | "female" | "male"): רק אם נאמר, אחרת null.
- texts: 3 טקסטים ראשיים (bodies) ו-3 כותרות קצרות (titles) בעברית טבעית, ברוח הטקסטים שעבדו בבסיס ובהתאם להוראה (מבצע, עיר, קהל). אם יש מחיר/מבצע בטקסטים של הבסיס ולא נאמר אחרת - לשמור עליו מדויק. אפשר 0-2 descriptions. בלי הבטחות שלא נאמרו, בלי מחירים מומצאים.
- name: שם קצר לקמפיין בעברית (מה, איפה, תאריך).
- explanation: 2-4 משפטים: מה לקחת מהבסיס ומה שינית ולמה.
אם יש agreed - זה מה שסוכם עם בעל העסק בשיחה לפני הבנייה (מיקום, תקציב, גיל, מסר...): לבנות בדיוק לפיו ולא לשנות דבר שסוכם.
החזר JSON בלבד: { "name", "dailyBudgetIls", "places", "ageMin", "ageMax", "genders", "texts": { "bodies": [], "titles": [], "descriptions": [] }, "explanation" }`;

// ---------- reading the base ----------

export async function readBase(creds: { token: string; accountId: string }, campaignId: string) {
  const { token, accountId } = creds;
  const [account, campaign, adsets, ins] = await Promise.all([
    gget(accountId, token, { fields: 'currency,min_daily_budget' }),
    gget(campaignId, token, { fields: 'id,name,objective,status,effective_status,buying_type,bid_strategy,daily_budget,lifetime_budget,special_ad_categories,account_id' }),
    gget(`${campaignId}/adsets`, token, { fields: 'id,name,status,effective_status,optimization_goal,billing_event,bid_strategy,bid_amount,bid_constraints,daily_budget,lifetime_budget,targeting,promoted_object,destination_type,attribution_spec,pacing_type,value_rule_set_id,value_rules_applied,dsa_beneficiary,dsa_payor', limit: '50' }),
    gget(`${campaignId}/insights`, token, { level: 'adset', date_preset: 'last_30d', fields: 'adset_id,spend,actions', limit: '100' }),
  ]);
  if (!campaign.ok) throw new Error(metaErr(campaign.data));
  if (String(campaign.data?.account_id || '') && `act_${campaign.data.account_id}` !== accountId) throw new Error('הקמפיין לא שייך לחשבון המודעות של העסק');
  const leadsBy = new Map<string, number>((ins.ok ? ins.data?.data || [] : []).map((r: any) => [String(r.adset_id), leadsOf(r)]));
  const sets: any[] = adsets.ok ? adsets.data?.data || [] : [];
  if (!sets.length) throw new Error('לקמפיין הבסיס אין סטי מודעות');
  // the best ad set: most leads in 30 days, else an active one, else the first
  const best = [...sets].sort((a, b) => (leadsBy.get(String(b.id)) || 0) - (leadsBy.get(String(a.id)) || 0) || (b.effective_status === 'ACTIVE' ? 1 : 0) - (a.effective_status === 'ACTIVE' ? 1 : 0))[0];
  const adsRes = await gget(`${best.id}/ads`, token, { fields: 'id,name,status,effective_status,creative{id,name,body,title,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,url_tags}', limit: '25' });
  const allAds: any[] = adsRes.ok ? adsRes.data?.data || [] : [];
  const live = allAds.filter(a => a.status === 'ACTIVE');
  const baseAds = (live.length ? live : allAds).slice(0, MAX_ADS);
  const currency = account.data?.currency || '';
  const rate = await ilsPerUnit(currency);
  const toIls = (minor: any) => (minor == null || minor === '' ? null : Math.round((Number(minor) / 100) * (currency === 'ILS' || !rate ? 1 : rate)));
  const cbo = !!(campaign.data.daily_budget || campaign.data.lifetime_budget);
  return {
    campaign: campaign.data, adsets: sets, best, bestLeads30: leadsBy.get(String(best.id)) || 0, baseAds,
    currency, rate, cbo, minDailyMinor: Number(account.data?.min_daily_budget) || 0,
    baseDailyIls: cbo ? toIls(campaign.data.daily_budget) : toIls(best.daily_budget),
    minDailyIls: account.data?.min_daily_budget ? toIls(account.data.min_daily_budget) : null,
  };
}
type Base = Awaited<ReturnType<typeof readBase>>;

function adTexts(ad: any) {
  const c = ad.creative || {};
  const afs = c.asset_feed_spec;
  const oss = c.object_story_spec || {};
  return {
    bodies: afs?.bodies?.map((b: any) => b.text) || [oss.video_data?.message || oss.link_data?.message || c.body].filter(Boolean),
    titles: afs?.titles?.map((b: any) => b.text) || [oss.video_data?.title || oss.link_data?.name || c.title].filter(Boolean),
  };
}

export function contextOf(b: Base) {
  return {
    baseName: b.campaign.name, baseCampaignId: String(b.campaign.id), baseAdsetId: String(b.best.id), baseAdsetName: b.best.name,
    objective: b.campaign.objective, cbo: b.cbo, currency: b.currency, rate: b.rate,
    baseDailyIls: b.baseDailyIls, minDailyIls: b.minDailyIls, bestLeads30: b.bestLeads30,
    baseTargeting: targetingSummary(b.best.targeting), baseAdvantage: b.best.targeting?.targeting_automation?.advantage_audience === 1,
    baseAds: b.baseAds.map(a => ({ id: String(a.id), name: a.name, ...adTexts(a) })),
    optimizationGoal: b.best.optimization_goal, valueRuleSet: b.best.value_rule_set_id || null,
  };
}

// ---------- routes ----------

export function registerBuilderRoutes(app: express.Express) {
  // the campaigns to start from, the one with the most leads in 30 days first
  app.get('/api/meta-ads/builder/bases', async (_req, res) => res.json(await listBases()));

  app.get('/api/meta-ads/geo-search', async (req, res) => {
    const creds = await adsCredsForCurrentBusiness();
    if (!creds) return res.json({ success: false, places: [] });
    res.json({ success: true, places: await searchPlaces(creds.token, String(req.query.q || '').slice(0, 60)) });
  });

  // 1. the AI's draft
  app.post('/api/meta-ads/drafts', async (req, res) => res.json(await createDraft({ instruction: req.body?.instruction, baseCampaignId: req.body?.baseCampaignId })));

  // 2. the person's edits
  app.put('/api/meta-ads/drafts/:id', async (req, res) => {
    try {
      const p = await ensureDraftTable();
      const r = await p.query(`SELECT * FROM mk_drafts WHERE id = $1 AND tenant_id = $2`, [Number(req.params.id), currentTenant()]);
      const row = r.rows[0];
      if (!row) return res.status(404).json({ success: false, error: 'הטיוטה לא נמצאה' });
      if (row.status !== 'draft') return res.json({ success: false, error: 'הטיוטה כבר הועלתה' });
      const draft = cleanDraft(req.body?.draft, row.context);
      await p.query(`UPDATE mk_drafts SET draft = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(draft)]);
      res.json({ success: true, draft, problems: draftProblems(draft, row.context) });
    } catch (e: any) {
      res.json({ success: false, error: e?.message });
    }
  });

  // 3. to Meta: a new campaign (PAUSED) with one ad set and its ads
  app.post('/api/meta-ads/drafts/:id/retry-ads', async (req, res) => {
    try { res.json(await retryFailedAds(Number(req.params.id))); } catch (e: any) { res.json({ success: false, error: e?.message || 'שגיאה' }); }
  });
  app.post('/api/meta-ads/drafts/:id/publish', async (req, res) => {
    const out = await publishDraft(Number(req.params.id));
    res.status(out?.notFound ? 404 : 200).json(out);
  });
}

export async function listBases(): Promise<any> {
    try {
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return ({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const [camps, ins] = await Promise.all([
        gget(`${creds.accountId}/campaigns`, creds.token, { fields: 'id,name,objective,effective_status', limit: '100' }),
        gget(`${creds.accountId}/insights`, creds.token, { level: 'campaign', date_preset: 'last_30d', fields: 'campaign_id,spend,actions', limit: '200' }),
      ]);
      if (!camps.ok) return ({ success: false, error: metaErr(camps.data) });
      const by = new Map<string, any>((ins.ok ? ins.data?.data || [] : []).map((r: any) => [String(r.campaign_id), r]));
      const list = (camps.data?.data || []).map((c: any) => ({ id: String(c.id), name: c.name, objective: c.objective, status: c.effective_status, spend30: Number(by.get(String(c.id))?.spend) || 0, leads30: leadsOf(by.get(String(c.id))) }))
        .sort((a: any, b: any) => b.leads30 - a.leads30 || b.spend30 - a.spend30);
      return ({ success: true, campaigns: list });
    } catch (e: any) {
      return ({ success: false, error: e?.message });
    }
}

export async function createDraft(input: { instruction: string; baseCampaignId?: string; understood?: any }): Promise<any> {
    if (!db()) return ({ success: false, error: 'צריך מסד נתונים (DATABASE_URL)' });
    try {
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return ({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const instruction = String(input.instruction || '').trim().slice(0, 2000);
      const baseId = String(input.baseCampaignId || '').replace(/\D/g, '');
      if (!instruction) return ({ success: false, error: 'כתבו מה הקמפיין צריך להיות' });
      if (!baseId) return ({ success: false, error: 'בחרו קמפיין בסיס' });
      const base = await readBase(creds, baseId);
      const ctx = contextOf(base);
      const ai = await aiJson(SYSTEM, JSON.stringify({ instruction, ...(input.understood ? { agreed: input.understood } : {}), base: ctx }), 'קמפיין חדש מהוראה', instruction.slice(0, 80));
      if (!ai.text) return ({ success: false, error: `כתיבת הטיוטה נכשלה: ${ai.error}` });
      const raw = parseJson(ai.text);
      if (!raw) return ({ success: false, error: 'ה-AI החזיר תשובה לא קריאה - נסו שוב' });
      // match the AI's place names to Meta's place list
      const unmatched: string[] = [];
      if (Array.isArray(raw.places) && raw.places.length) {
        const found: Place[] = [];
        for (const p of raw.places.slice(0, 15)) {
          const hits = await searchPlaces(creds.token, String(p?.name || ''));
          const hit = hits.find(h => h.type === 'city') || hits[0];
          if (hit) found.push({ ...hit, radiusKm: hit.type === 'city' ? (p?.radiusKm ?? null) : null });
          else unmatched.push(String(p?.name || ''));
        }
        raw.places = found;
      }
      const draft = cleanDraft(raw, ctx);
      const p = await ensureDraftTable();
      const ins = await p.query(
        `INSERT INTO mk_drafts (tenant_id, created_by, instruction, base_campaign_id, base_adset_id, draft, context) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) RETURNING id`,
        [currentTenant(), who(), instruction, ctx.baseCampaignId, ctx.baseAdsetId, JSON.stringify(draft), JSON.stringify(ctx)],
      );
      return ({ success: true, id: Number(ins.rows[0].id), draft, context: ctx, unmatchedPlaces: unmatched, problems: draftProblems(draft, ctx) });
    } catch (e: any) {
      console.error('[builder draft]', e?.message);
      return ({ success: false, error: e?.message || 'שגיאה' });
    }
}

export async function publishDraft(draftId: number): Promise<any> {
    try {
      const p = await ensureDraftTable();
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return ({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const r = await p.query(`SELECT * FROM mk_drafts WHERE id = $1 AND tenant_id = $2`, [draftId, currentTenant()]);
      const row = r.rows[0];
      if (!row) return ({ success: false, error: 'הטיוטה לא נמצאה' });
      if (row.status !== 'draft') return ({ success: false, error: 'הטיוטה כבר הועלתה', published: row.published });
      const draft: Draft = cleanDraft(row.draft, row.context);
      const base = await readBase(creds, String(row.base_campaign_id));
      const ctx = contextOf(base);
      const problems = draftProblems(draft, ctx);
      if (problems.length) return ({ success: false, error: problems.join(' · ') });
      const { token, accountId } = creds;
      const minorFromIls = (ils: number) => Math.round((ils / (base.currency === 'ILS' || !base.rate ? 1 : base.rate)) * 100);
      const budgetMinor = Math.max(minorFromIls(draft.dailyBudgetIls), base.minDailyMinor || 0);
      const steps: string[] = [];

      // the campaign
      const campBody: Record<string, any> = {
        name: draft.name, objective: base.campaign.objective, status: 'PAUSED',
        special_ad_categories: base.campaign.special_ad_categories || [],
        buying_type: base.campaign.buying_type || 'AUCTION',
      };
      if (base.cbo) { campBody.daily_budget = String(budgetMinor); if (base.campaign.bid_strategy) campBody.bid_strategy = base.campaign.bid_strategy; }
      // an earlier try made the campaign and stopped at the ad set: go on with that campaign (name / budget
      // updated) instead of opening another empty one - unless it was archived / deleted since
      let campaignId = '';
      const earlier = row.published?.campaignId && !row.published?.adsetId ? String(row.published.campaignId) : '';
      if (earlier) {
        const ex = await gget(earlier, token, { fields: 'id,effective_status' });
        if (ex.ok && ex.data?.id && !['ARCHIVED', 'DELETED'].includes(String(ex.data.effective_status))) {
          const upd: Record<string, any> = { name: draft.name };
          if (base.cbo) upd.daily_budget = String(budgetMinor);
          await post(earlier, token, upd);
          campaignId = earlier;
        }
      }
      if (!campaignId) {
      let camp = await post(`${accountId}/campaigns`, token, campBody);
      if (!camp.ok && /is_adset_budget_sharing_enabled/.test(JSON.stringify(camp.data))) camp = await post(`${accountId}/campaigns`, token, { ...campBody, is_adset_budget_sharing_enabled: false });
      if (!camp.ok || !camp.data?.id) return ({ success: false, error: `יצירת הקמפיין נכשלה: ${metaErr(camp.data)}` });
      campaignId = String(camp.data.id);
      }
      steps.push('campaign');
      if (campaignId !== earlier) await p.query(
        `INSERT INTO mk_changes (tenant_id, campaign_id, object_type, object_id, object_name, action, title, before, after, status, done_by)
         VALUES ($1, $2, 'campaign', $2, $3, 'create_campaign', 'קמפיין חדש מהוראה', $4::jsonb, $5::jsonb, 'done', $6)`,
        [currentTenant(), campaignId, draft.name, JSON.stringify({ status: 'ARCHIVED' }), JSON.stringify({ status: 'PAUSED' }), who()],
      );
      const fail = async (error: string) => {
        await p.query(`UPDATE mk_drafts SET published = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify({ campaignId, steps, error })]);
        return ({ success: false, campaignId, error: `${error} (הקמפיין נוצר מושהה ואין בו עדיין סט. אפשר לתקן את הטיוטה וללחוץ שוב "אשר והעלה" - ההעלאה תמשיך באותו קמפיין, בלי לפתוח חדש)` });
      };

      // the ad set - a copy of the base's best one with the approved targeting / budget
      const b = base.best;
      const setBody: Record<string, any> = {
        name: `${draft.name} - סט`, campaign_id: campaignId, status: 'ACTIVE',
        optimization_goal: b.optimization_goal, billing_event: b.billing_event, targeting: applyTargeting(b.targeting, draft),
        promoted_object: b.promoted_object, destination_type: b.destination_type, attribution_spec: b.attribution_spec,
        start_time: new Date().toISOString(),
      };
      if (!base.cbo) { setBody.daily_budget = String(budgetMinor); if (b.bid_strategy) setBody.bid_strategy = b.bid_strategy; }
      if (b.bid_amount) setBody.bid_amount = b.bid_amount;
      if (b.bid_constraints) setBody.bid_constraints = b.bid_constraints;
      if (b.pacing_type) setBody.pacing_type = b.pacing_type;
      if (b.value_rule_set_id && b.value_rules_applied !== false) { setBody.value_rule_set_id = String(b.value_rule_set_id); setBody.value_rules_applied = true; }
      if (b.dsa_beneficiary) setBody.dsa_beneficiary = b.dsa_beneficiary;
      if (b.dsa_payor) setBody.dsa_payor = b.dsa_payor;
      const set = await post(`${accountId}/adsets`, token, setBody);
      if (!set.ok || !set.data?.id) return fail(`יצירת סט המודעות נכשלה: ${metaErr(set.data)}`);
      const adsetId = String(set.data.id);
      steps.push('adset');

      // the ads - each base ad with the approved texts (and the new media)
      const media = await draftMedia(draft, token);
      if (typeof media === 'string') return fail(media);
      const { created, errors } = await buildAds(draft, base, media, token, accountId, adsetId);
      if (!created.length) return fail(`לא נוצרה אף מודעה: ${errors.join(' · ') || 'אין מודעות בסט הבסיס'}`);
      steps.push('ads');
      const published = { campaignId, adsetId, ads: created, errors, at: new Date().toISOString() };
      await p.query(`UPDATE mk_drafts SET status = 'published', published = $2::jsonb, published_at = now() WHERE id = $1`, [row.id, JSON.stringify(published)]);
      return ({ success: true, ...published, name: draft.name });
    } catch (e: any) {
      console.error('[builder publish]', e?.message);
      return ({ success: false, error: e?.message || 'שגיאה' });
    }
}

// the ads of a new ad set: each base ad as a new creative with the approved texts (and the new media)
async function buildAds(draft: Draft, base: Base, media: Media[], token: string, accountId: string, adsetId: string, only?: (ad: any) => boolean) {
  const created: { id: string; name: string }[] = [];
  const errors: string[] = [];
  const sources = (base.baseAds.length ? base.baseAds : []).filter((a: any) => !only || only(a));
  for (const [i, ad] of sources.entries()) {
    let spec: any;
    if (media.length) {
      const c = ad.creative || {};
      if (c.asset_feed_spec) {
        // a flexible ad: the new pictures / videos instead of its own
        spec = { object_story_spec: c.object_story_spec, asset_feed_spec: JSON.parse(JSON.stringify(c.asset_feed_spec)) };
        const imgs = media.filter(m => m.type === 'image') as { type: 'image'; hash: string }[];
        const vids = media.filter(m => m.type === 'video') as { type: 'video'; id: string; thumb: string }[];
        if (imgs.length) spec.asset_feed_spec.images = imgs.map(m => ({ hash: m.hash })); else delete spec.asset_feed_spec.images;
        if (vids.length) spec.asset_feed_spec.videos = vids.map(m => ({ video_id: m.id, thumbnail_url: m.thumb })); else delete spec.asset_feed_spec.videos;
        const fmts = [...(imgs.length ? ['SINGLE_IMAGE'] : []), ...(vids.length ? ['SINGLE_VIDEO'] : [])];
        if (Array.isArray(spec.asset_feed_spec.ad_formats)) spec.asset_feed_spec.ad_formats = Array.from(new Set([...spec.asset_feed_spec.ad_formats.filter((f: string) => !/SINGLE_(IMAGE|VIDEO)/.test(f)), ...fmts]));
        if (c.degrees_of_freedom_spec) spec.degrees_of_freedom_spec = c.degrees_of_freedom_spec;
        if (c.url_tags) spec.url_tags = c.url_tags;
      } else if (c.object_story_spec?.link_data?.child_attachments) {
        spec = { object_story_spec: c.object_story_spec, url_tags: c.url_tags }; // a carousel keeps its own cards
      } else {
        const one = creativeWithMedia(c, media[i % media.length], { kind: 'single' });
        if ('error' in one) { errors.push(`${ad.name}: ${one.error}`); continue; }
        spec = one;
      }
    } else {
      const c = ad.creative || {};
      spec = { object_story_spec: c.object_story_spec, asset_feed_spec: c.asset_feed_spec, degrees_of_freedom_spec: c.degrees_of_freedom_spec, url_tags: c.url_tags };
    }
    spec = applyTexts(JSON.parse(JSON.stringify(spec)), draft.texts);
    if (!spec.object_story_spec && !spec.asset_feed_spec) { errors.push(`${ad.name}: המודעה מבוססת על פוסט קיים - דילגנו`); continue; }
    const crBody: Record<string, any> = { name: `${draft.name} - ${ad.name}`.slice(0, 200) };
    for (const [k, v] of Object.entries(spec)) if (v != null) crBody[k] = v;
    const cr = await post(`${accountId}/adcreatives`, token, crBody);
    if (!cr.ok || !cr.data?.id) { errors.push(`${ad.name}: ${metaErr(cr.data)}`); continue; }
    const na = await post(`${accountId}/ads`, token, { name: `${ad.name}`.slice(0, 200), adset_id: adsetId, creative: { creative_id: String(cr.data.id) }, status: 'ACTIVE' });
    if (!na.ok || !na.data?.id) { errors.push(`${ad.name}: ${metaErr(na.data)}`); continue; }
    created.push({ id: String(na.data.id), name: ad.name });
  }
  return { created, errors };
}

async function draftMedia(draft: Draft, token: string): Promise<Media[] | string> {
  const media: Media[] = [];
  for (const m of draft.media) {
    if (m.type === 'image' && m.hash) media.push({ type: 'image', hash: m.hash });
    if (m.type === 'video' && m.id) {
      const v = await gget(m.id, token, { fields: 'status,picture,thumbnails{uri,is_preferred}' });
      const thumbs: any[] = v.data?.thumbnails?.data || [];
      const thumb = (thumbs.find(t => t.is_preferred) || thumbs[0])?.uri || v.data?.picture || m.thumb || '';
      if (v.data?.status?.video_status !== 'ready' || !thumb) return 'סרטון עוד בעיבוד אצל מטא - נסו להעלות שוב בעוד דקה';
      media.push({ type: 'video', id: m.id, thumb });
    }
  }
  return media;
}

// "🔁 לנסות שוב את המודעות שנכשלו": the base ads that didn't become ads, into the same ad set
export async function retryFailedAds(draftId: number): Promise<any> {
  const p = await ensureDraftTable();
  const creds = await adsCredsForCurrentBusiness();
  if (!creds) return { success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' };
  const r = await p.query(`SELECT * FROM mk_drafts WHERE id = $1 AND tenant_id = $2`, [draftId, currentTenant()]);
  const row = r.rows[0];
  if (!row || row.status !== 'published' || !row.published?.adsetId) return { success: false, error: 'אין כאן סט מודעות להוסיף אליו' };
  const draft: Draft = cleanDraft(row.draft, row.context);
  const base = await readBase(creds, String(row.base_campaign_id));
  const media = await draftMedia(draft, creds.token);
  if (typeof media === 'string') return { success: false, error: media };
  const done = new Set((row.published.ads || []).map((a: any) => String(a.name)));
  const { created, errors } = await buildAds(draft, base, media, creds.token, creds.accountId, String(row.published.adsetId), (a: any) => !done.has(String(a.name)));
  const published = { ...row.published, ads: [...(row.published.ads || []), ...created], errors };
  await p.query(`UPDATE mk_drafts SET published = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(published)]);
  return { success: created.length > 0 || !errors.length, ...published, name: draft.name, added: created.length, error: !created.length && errors.length ? errors.join(' · ') : undefined };
}
