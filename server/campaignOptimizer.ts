// Maintaining a running campaign (Haim, 2026-11-19 - "before a new campaign, let's maintain an
// existing one: analyse it, suggest changes, approve and execute"):
//
//  1. ANALYSE  POST /api/meta-ads/campaigns/:id/analyze - reads the campaign, its ad sets and ads,
//     their results (7 / 30 days, the last 14 days by day, placements, age & gender) and asks the AI
//     for findings and concrete suggestions. Each suggestion is checked here (`validate`) against a
//     fixed list of actions and hard limits; what the AI suggests outside that list is shown as advice
//     only ("manual"). The analysis + suggestions are stored (mk_optimizations) with every target's
//     value at the time ("before").
//  2. APPROVE + EXECUTE  POST /api/meta-ads/optimizations/:id/execute - only the suggestions the
//     person ticked (a budget can be edited). Each target is read again first: if it changed since
//     the analysis, it's skipped. Every change is written to mk_changes with before / after / who.
//  3. UNDO  POST /api/meta-ads/changes/:id/undo - writes "before" back (same re-read check).
//
// Nothing happens at Meta without a person's approval, and nothing at all without DATABASE_URL (a
// change to a live campaign must be recorded and undoable). Needs the token's ads_management.
import express from 'express';
import jwt from 'jsonwebtoken';
import { adsCredsForCurrentBusiness } from './metaAdsSnapshot.js';
import { aiJson } from './ai.js';
import { db, ensureTables } from './db.js';
import { currentUser } from './tenant.js';
import { currentTenant } from './tenant.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
type Creds = { token: string; accountId: string };

async function gget(path: string, token: string, params: Record<string, string> = {}): Promise<{ ok: boolean; data: any }> {
  const url = path.startsWith('http') ? path : `${GRAPH}/${path}?${new URLSearchParams({ ...params, access_token: token })}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch (e: any) {
    return { ok: false, data: { error: { message: e?.message || 'network' } } };
  }
}

async function gpost(path: string, token: string, body: Record<string, string>): Promise<{ ok: boolean; data: any }> {
  try {
    const r = await fetch(`${GRAPH}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...body, access_token: token }),
      signal: AbortSignal.timeout(25000),
    });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch (e: any) {
    return { ok: false, data: { error: { message: e?.message || 'network' } } };
  }
}

const metaErr = (d: any) => {
  const e = d?.error;
  if (!e) return 'שגיאה לא ידועה מ-Meta';
  return [e.error_user_title, e.error_user_msg || e.message, e.code ? `(#${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''].filter(Boolean).join(' · ');
};

async function allPages(path: string, token: string, params: Record<string, string>): Promise<{ ok: boolean; rows: any[]; error?: string }> {
  const first = await gget(path, token, { limit: '200', ...params });
  if (!first.ok) return { ok: false, rows: [], error: metaErr(first.data) };
  const rows = [...(first.data?.data || [])];
  let next = first.data?.paging?.next;
  for (let i = 0; next && i < 10; i++) {
    const p = await gget(next, token);
    if (!p.ok) break;
    rows.push(...(p.data?.data || []));
    next = p.data?.paging?.next;
  }
  return { ok: true, rows };
}

// ---------- reading the campaign ----------

const LEAD_TYPES = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'leadgen_grouped'];
const leadsOf = (row: any) => {
  for (const t of LEAD_TYPES) {
    const a = (row?.actions || []).find((x: any) => x.action_type === t);
    if (a) return Number(a.value) || 0;
  }
  return 0;
};
const num = (v: any) => (v == null || v === '' ? 0 : Number(v) || 0);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function metrics(row: any) {
  if (!row) return null;
  const spend = num(row.spend);
  const leads = leadsOf(row);
  return {
    spend: round(spend), impressions: num(row.impressions), reach: num(row.reach), frequency: round(num(row.frequency)),
    clicks: num(row.clicks), ctr: round(num(row.ctr)), cpm: round(num(row.cpm)), leads, cpl: leads ? round(spend / leads) : null,
  };
}

const INSIGHT_FIELDS = 'campaign_id,adset_id,ad_id,spend,impressions,reach,frequency,clicks,ctr,cpm,actions';
const ADSET_FIELDS = 'id,name,status,effective_status,optimization_goal,billing_event,bid_strategy,bid_amount,daily_budget,lifetime_budget,targeting,promoted_object,destination_type,learning_stage_info,value_rule_set_id,value_rules_applied,bid_adjustments,start_time';
const AD_FIELDS = 'id,name,adset_id,status,effective_status,created_time,creative{id,object_type,body,title,image_url,thumbnail_url,video_id,asset_feed_spec,object_story_spec}';

function targetingSummary(t: any) {
  if (!t) return null;
  const geo = t.geo_locations || {};
  return {
    age: `${t.age_min || 18}-${t.age_max || 65}`,
    genders: t.genders || 'all',
    places: [
      ...(geo.countries || []),
      ...(geo.regions || []).map((r: any) => r.name),
      ...(geo.cities || []).map((c: any) => `${c.name}${c.radius ? ` +${c.radius}${c.distance_unit === 'mile' ? 'mi' : 'km'}` : ''}`),
      ...(geo.custom_locations || []).map((c: any) => `${c.name || c.address_string || 'point'} r${c.radius}${c.distance_unit === 'mile' ? 'mi' : 'km'}`),
    ],
    customAudiences: (t.custom_audiences || []).map((a: any) => a.name || a.id),
    excludedAudiences: (t.excluded_custom_audiences || []).map((a: any) => a.name || a.id),
    interests: (t.flexible_spec || []).flatMap((s: any) => Object.values(s || {}).flat().map((x: any) => x?.name)).filter(Boolean),
    advantageAudience: t.targeting_automation?.advantage_audience ?? null,
    placements: t.publisher_platforms ? { platforms: t.publisher_platforms, fb: t.facebook_positions, ig: t.instagram_positions } : 'advantage+',
  };
}

function creativeKind(c: any) {
  if (!c) return '';
  if (c.asset_feed_spec) return `flexible (${c.asset_feed_spec.images?.length || 0} images, ${c.asset_feed_spec.videos?.length || 0} videos, ${c.asset_feed_spec.bodies?.length || 0} texts)`;
  if (c.object_story_spec?.link_data?.child_attachments) return 'carousel';
  if (c.video_id || c.object_story_spec?.video_data) return 'video';
  return 'image';
}

// What the campaign's leads did in the CRM (booked / bought / revenue in ILS, by ad set and ad) -
// the CRM's POST /api/marketing/campaign-outcomes (server/campaignOutcomes.ts there), same matching
// as its ROI table. null = no CRM for this business / not reachable (the analysis goes on without it).
async function crmOutcomes(body: any): Promise<any | null> {
  const secret = process.env.SSO_SHARED_SECRET;
  if (!secret) return null;
  try {
    const token = jwt.sign({ typ: 'marketing-outcomes', portalTenantId: Number(currentTenant()) }, secret, { expiresIn: '2m' });
    const r = await fetch(`${process.env.CRM_URL || 'https://crm.smartesek.com'}/api/marketing/campaign-outcomes`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-marketing-token': token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const d: any = await r.json().catch(() => null);
    return r.ok && d?.found ? d : null;
  } catch {
    return null;
  }
}

// ILS for one unit of the ad account's currency (the optics bills in USD), to compare spend with CRM
// revenue. null when it can't be read.
async function ilsPerUnit(currency: string): Promise<number | null> {
  if (!currency || currency === 'ILS') return 1;
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(currency)}&symbols=ILS`, { signal: AbortSignal.timeout(6000) });
    const d: any = await r.json();
    return Number(d?.rates?.ILS) || null;
  } catch {
    return null;
  }
}

export async function readCampaign(creds: Creds, campaignId: string) {
  const { token, accountId } = creds;
  const [account, campaign, adsets, ads, ins7Adset, ins30Adset, ins7Ad, ins30Ad, daily, placements, ageGender, ruleSets] = await Promise.all([
    gget(accountId, token, { fields: 'currency,timezone_name,min_daily_budget,name' }),
    gget(campaignId, token, { fields: 'id,name,status,effective_status,objective,buying_type,bid_strategy,daily_budget,lifetime_budget,special_ad_categories,start_time,account_id' }),
    allPages(`${campaignId}/adsets`, token, { fields: ADSET_FIELDS }),
    allPages(`${campaignId}/ads`, token, { fields: AD_FIELDS }),
    allPages(`${campaignId}/insights`, token, { level: 'adset', date_preset: 'last_7d', fields: INSIGHT_FIELDS }),
    allPages(`${campaignId}/insights`, token, { level: 'adset', date_preset: 'last_30d', fields: INSIGHT_FIELDS }),
    allPages(`${campaignId}/insights`, token, { level: 'ad', date_preset: 'last_7d', fields: INSIGHT_FIELDS }),
    allPages(`${campaignId}/insights`, token, { level: 'ad', date_preset: 'last_30d', fields: INSIGHT_FIELDS }),
    allPages(`${campaignId}/insights`, token, { level: 'campaign', date_preset: 'last_14d', time_increment: '1', fields: 'spend,impressions,clicks,actions,date_start' }),
    allPages(`${campaignId}/insights`, token, { level: 'campaign', date_preset: 'last_30d', breakdowns: 'publisher_platform,platform_position', fields: 'spend,impressions,clicks,ctr,actions' }),
    allPages(`${campaignId}/insights`, token, { level: 'campaign', date_preset: 'last_30d', breakdowns: 'age,gender', fields: 'spend,impressions,clicks,actions' }),
    allPages(`${accountId}/value_rule_set`, token, { fields: 'id,name,status' }),
  ]);
  const allCampaigns = await allPages(`${accountId}/campaigns`, token, { fields: 'id,name' });
  const currency = account.data?.currency || '';
  const [crm, ilsRate] = await Promise.all([
    crmOutcomes({
      campaignId, campaignName: campaign.data?.name || '',
      allCampaigns: allCampaigns.rows.map((c: any) => ({ id: String(c.id), name: String(c.name || '') })),
      adsets: adsets.rows.map((x: any) => ({ id: String(x.id), name: String(x.name || '') })),
      ads: ads.rows.map((x: any) => ({ id: String(x.id), name: String(x.name || '') })),
    }),
    ilsPerUnit(currency),
  ]);
  if (!campaign.ok) throw new Error(metaErr(campaign.data));
  if (String(campaign.data?.account_id || '') && `act_${campaign.data.account_id}` !== accountId) throw new Error('הקמפיין לא שייך לחשבון המודעות של העסק');
  const by = (rows: any[], key: string) => new Map(rows.map(r => [String(r[key]), r]));
  const a7 = by(ins7Adset.rows, 'adset_id'), a30 = by(ins30Adset.rows, 'adset_id');
  const d7 = by(ins7Ad.rows, 'ad_id'), d30 = by(ins30Ad.rows, 'ad_id');
  return {
    currency,
    ilsRate,
    crm,
    timezone: account.data?.timezone_name || '',
    minDailyBudget: num(account.data?.min_daily_budget),
    campaign: campaign.data,
    adsets: adsets.rows.map(s => ({ ...s, m7: metrics(a7.get(String(s.id))), m30: metrics(a30.get(String(s.id))) })),
    ads: ads.rows.map(a => ({ ...a, m7: metrics(d7.get(String(a.id))), m30: metrics(d30.get(String(a.id))) })),
    daily: daily.rows.map(r => ({ date: r.date_start, spend: round(num(r.spend)), leads: leadsOf(r), clicks: num(r.clicks) })),
    placements: placements.rows.map(r => ({ platform: r.publisher_platform, position: r.platform_position, spend: round(num(r.spend)), impressions: num(r.impressions), ctr: round(num(r.ctr)), leads: leadsOf(r) })),
    ageGender: ageGender.rows.map(r => ({ age: r.age, gender: r.gender, spend: round(num(r.spend)), leads: leadsOf(r) })),
    valueRuleSets: ruleSets.rows,
    readErrors: [adsets, ads, ins7Adset, ins30Adset, daily, placements, ageGender].filter(x => !x.ok).map(x => x.error),
  };
}

type CampaignData = Awaited<ReturnType<typeof readCampaign>>;

// What the AI sees: compact, amounts in the account's currency (major units).
function forAi(d: CampaignData) {
  const minor = (v: any) => (v == null || v === '' ? null : round(num(v) / 100));
  const crm = d.crm;
  return {
    currency: d.currency,
    ilsPerCurrencyUnit: d.ilsRate,
    crm: crm
      ? { note: 'CRM outcomes of this campaign\'s leads, by lead arrival day; revenue in ILS. Purchases come days-weeks after the lead, so the last 7 days are incomplete.', last7: crm.last7, last30: crm.last30, leadsWithUnknownAdset30: crm.unattributedAdset30 }
      : 'no CRM data for this business',
    campaign: {
      id: d.campaign.id, name: d.campaign.name, status: d.campaign.effective_status, objective: d.campaign.objective,
      bidStrategy: d.campaign.bid_strategy, dailyBudget: minor(d.campaign.daily_budget), lifetimeBudget: minor(d.campaign.lifetime_budget),
      budgetLevel: d.campaign.daily_budget || d.campaign.lifetime_budget ? 'campaign (CBO)' : 'ad set',
    },
    adsets: d.adsets.map(s => ({
      id: s.id, name: s.name, status: s.effective_status, configuredStatus: s.status, optimizationGoal: s.optimization_goal, bidStrategy: s.bid_strategy,
      dailyBudget: minor(s.daily_budget), learning: s.learning_stage_info?.status || null, valueRuleSet: s.value_rule_set_id || null,
      targeting: targetingSummary(s.targeting), last7: s.m7, last30: s.m30,
      crm: crm?.byAdset?.[String(s.id)] || null,
    })),
    ads: d.ads.map(a => ({
      id: a.id, adsetId: a.adset_id, name: a.name, status: a.effective_status, configuredStatus: a.status, created: a.created_time,
      kind: creativeKind(a.creative), text: String(a.creative?.body || a.creative?.asset_feed_spec?.bodies?.[0]?.text || '').slice(0, 220),
      last7: a.m7, last30: a.m30,
      crm: crm?.byAd?.[String(a.id)] || null,
    })),
    last14DaysByDay: d.daily,
    placementsLast30: d.placements,
    ageGenderLast30: d.ageGender,
    valueRuleSetsInAccount: d.valueRuleSets.map((r: any) => ({ id: r.id, name: r.name })),
  };
}

const SYSTEM = `אתה מנהל קמפיינים בכיר של Meta (פייסבוק ואינסטגרם) שמתחזק קמפיין קיים של עסק קטן בישראל.
קיבלת את הגדרות הקמפיין, סטי המודעות והמודעות, והתוצאות שלהם (7 ו-30 יום, 14 ימים אחרונים לפי יום, מיקומים, גיל ומגדר). הסכומים במטבע החשבון.
המטרה: יותר לקוחות שקובעים תור וקונים, בעלות נמוכה יותר, בלי לשבור מה שעובד.

נתוני ה-CRM (שדה crm - בקמפיין, בכל סט ובכל מודעה): כמה מהלידים קבעו תור (booked), כמה קנו (buyers) וכמה הכניסו (revenue, בשקלים). ההוצאה במטא היא במטבע החשבון; ilsPerCurrencyUnit = כמה שקלים ביחידת מטבע (ROAS = revenue / (spend × ilsPerCurrencyUnit)).
- כשיש נתוני CRM - הם קובעים יותר מהעלות לליד: סט/מודעה עם לידים יקרים יותר אבל יותר תורים ורכישות עדיף על לידים זולים שלא קובעים.
- רכישות מגיעות ימים-שבועות אחרי הליד: ב-7 הימים האחרונים הן חלקיות - לשפוט רכישות לפי 30 יום, ותורים גם לפי 7.
- אם crm חסר בסט/מודעה - ייתכן שהלידים לא שויכו (leadsWithUnknownAdset30); לא להסיק מזה שאין תוצאות.
- לציין בממצאים את העלות לתור ואת ה-ROAS כשאפשר.

כללים מקצועיים:
- לא להסיק מסקנות ממעט נתונים: מודעה/סט עם פחות מ-3 לידים או הוצאה נמוכה מפי 2 מהעלות לליד הממוצעת - "אין מספיק נתונים", לא לעצור.
- סט בשלב למידה (LEARNING) - לא לשנות בו תקציב או קהל, אלא אם הוא באמת שורף כסף בלי תוצאות.
- שינוי תקציב: עד 30% בבת אחת (שינוי גדול מאפס את הלמידה).
- לא לעצור את המודעה הפעילה האחרונה בסט.
- להעדיף: לעצור מודעות חלשות בבירור, להעביר תקציב לסט שמביא לידים זולים, להתריע על תדירות גבוהה (מעל ~3 ב-7 ימים = שחיקה - להציע קריאייטיב חדש).
- אם הכל תקין - לומר את זה, ולא להמציא שינויים.

פעולות שאפשר לבצע אוטומטית (action):
- "pause_ad" / "activate_ad" - targetId = מזהה מודעה.
- "pause_adset" / "activate_adset" - targetId = מזהה סט.
- "set_adset_daily_budget" - targetId = סט, params: { "dailyBudget": מספר במטבע החשבון } (רק כשהתקציב ברמת הסט).
- "set_campaign_daily_budget" - targetId = הקמפיין, params: { "dailyBudget": מספר } (רק כשהתקציב ברמת הקמפיין).
- "set_adset_age" - targetId = סט, params: { "ageMin": 18-65, "ageMax": 18-65 }.
- "apply_value_rule_set" - targetId = סט, params: { "valueRuleSetId": מזהה מתוך valueRuleSetsInAccount }.
- כל המלצה אחרת (קריאייטיב חדש, טקסט חדש, קהל חדש, מבנה אחר) - action "manual", בלי targetId חובה.

החזר JSON בלבד, בעברית:
{
 "summary": "2-4 משפטים: איך הקמפיין עובד עכשיו",
 "health": "good" | "ok" | "bad",
 "findings": ["ממצא קצר עם מספרים", ...] (3-7),
 "suggestions": [
   { "action": "...", "targetId": "...", "params": {...}, "title": "מה לעשות, קצר", "why": "למה, עם המספרים", "expected": "מה צפוי לקרות", "risk": "low" | "medium" | "high" }
 ] (0-8, החשובות קודם)
}`;

// ---------- checking each suggestion ----------

export const EXEC_ACTIONS = ['pause_ad', 'activate_ad', 'pause_adset', 'activate_adset', 'set_adset_daily_budget', 'set_campaign_daily_budget', 'set_adset_age', 'apply_value_rule_set'] as const;
type ExecAction = typeof EXEC_ACTIONS[number];

export interface Suggestion {
  id: string;
  action: ExecAction | 'manual';
  targetType?: 'ad' | 'adset' | 'campaign';
  targetId?: string;
  targetName?: string;
  params?: Record<string, any>;
  title: string;
  why: string;
  expected?: string;
  risk: 'low' | 'medium' | 'high';
  executable: boolean;
  note?: string; // why it isn't executable / what was adjusted
  before?: Record<string, any>;
  after?: Record<string, any>;
}

function validate(raw: any, d: CampaignData, idx: number): Suggestion {
  const base: Suggestion = {
    id: `s${idx + 1}`,
    action: 'manual',
    title: String(raw?.title || '').slice(0, 200) || 'המלצה',
    why: String(raw?.why || '').slice(0, 800),
    expected: raw?.expected ? String(raw.expected).slice(0, 400) : undefined,
    risk: ['low', 'medium', 'high'].includes(raw?.risk) ? raw.risk : 'medium',
    executable: false,
  };
  const action = String(raw?.action || 'manual');
  if (!EXEC_ACTIONS.includes(action as ExecAction)) return base;
  const asAdvice = (note: string): Suggestion => ({ ...base, note });
  const targetId = String(raw?.targetId || '');
  const p = raw?.params || {};
  const adset = d.adsets.find(s => String(s.id) === targetId);
  const ad = d.ads.find(a => String(a.id) === targetId);
  const s: Suggestion = { ...base, action: action as ExecAction, targetId, params: p, executable: true };

  switch (action) {
    case 'pause_ad':
    case 'activate_ad': {
      if (!ad) return asAdvice('המודעה לא נמצאה בקמפיין');
      const to = action === 'pause_ad' ? 'PAUSED' : 'ACTIVE';
      if (ad.status === to) return asAdvice(to === 'PAUSED' ? 'המודעה כבר מושהית' : 'המודעה כבר פעילה');
      if (to === 'PAUSED') {
        const live = d.ads.filter(a => String(a.adset_id) === String(ad.adset_id) && a.status === 'ACTIVE');
        if (live.length <= 1) return asAdvice('זו המודעה הפעילה האחרונה בסט - עצירה שלה עוצרת את הסט כולו');
      }
      return { ...s, targetType: 'ad', targetName: ad.name, before: { status: ad.status }, after: { status: to } };
    }
    case 'pause_adset':
    case 'activate_adset': {
      if (!adset) return asAdvice('הסט לא נמצא בקמפיין');
      const to = action === 'pause_adset' ? 'PAUSED' : 'ACTIVE';
      if (adset.status === to) return asAdvice(to === 'PAUSED' ? 'הסט כבר מושהה' : 'הסט כבר פעיל');
      if (to === 'PAUSED' && d.adsets.filter(x => x.status === 'ACTIVE').length <= 1) return asAdvice('זה הסט הפעיל האחרון - עצירה שלו עוצרת את הקמפיין');
      return { ...s, targetType: 'adset', targetName: adset.name, before: { status: adset.status }, after: { status: to } };
    }
    case 'set_adset_daily_budget':
    case 'set_campaign_daily_budget': {
      const isCampaign = action === 'set_campaign_daily_budget';
      const obj: any = isCampaign ? (String(d.campaign.id) === targetId ? d.campaign : null) : adset;
      if (!obj) return asAdvice('היעד לא נמצא בקמפיין');
      if (!obj.daily_budget) return asAdvice(isCampaign ? 'לקמפיין אין תקציב יומי ברמת הקמפיין' : 'לסט אין תקציב יומי משלו (התקציב ברמת הקמפיין)');
      const cur = num(obj.daily_budget); // minor units
      let next = Math.round(num(p.dailyBudget) * 100);
      if (!next) return asAdvice('לא צוין תקציב חדש');
      // hard limits: at most +50% / -50% in one change, never under the account's minimum
      const capped = Math.min(Math.max(next, Math.round(cur * 0.5)), Math.round(cur * 1.5));
      const note = capped !== next ? `הוגבל ל-${round(capped / 100)} ${d.currency} (שינוי של עד 50% בבת אחת)` : undefined;
      next = Math.max(capped, d.minDailyBudget || 0);
      if (next === cur) return asAdvice('התקציב החדש זהה לקיים');
      return {
        ...s, note, targetType: isCampaign ? 'campaign' : 'adset', targetName: obj.name, params: { dailyBudget: round(next / 100) },
        before: { daily_budget: cur }, after: { daily_budget: next },
      };
    }
    case 'set_adset_age': {
      if (!adset) return asAdvice('הסט לא נמצא בקמפיין');
      const t = adset.targeting || {};
      const min = Math.round(num(p.ageMin) || num(t.age_min) || 18), max = Math.round(num(p.ageMax) || num(t.age_max) || 65);
      if (min < 18 || max > 65 || min > max) return asAdvice('טווח גילאים לא תקין');
      if (t.targeting_automation?.advantage_audience === 1 && min > 25) return asAdvice('עם Advantage+ קהל, מטא לא מאפשרת גיל מינימום מעל 25 - צריך לכבות את Advantage+ קודם');
      if (num(t.age_min || 18) === min && num(t.age_max || 65) === max) return asAdvice('טווח הגילאים זהה לקיים');
      return { ...s, targetType: 'adset', targetName: adset.name, params: { ageMin: min, ageMax: max }, before: { age_min: t.age_min || 18, age_max: t.age_max || 65 }, after: { age_min: min, age_max: max } };
    }
    case 'apply_value_rule_set': {
      if (!adset) return asAdvice('הסט לא נמצא בקמפיין');
      const rs = d.valueRuleSets.find((r: any) => String(r.id) === String(p.valueRuleSetId));
      if (!rs) return asAdvice('ערכת כללי הערך לא נמצאה בחשבון');
      if (adset.bid_adjustments) return asAdvice('לסט יש מכפילי הצעה (bid multipliers) - אי אפשר יחד עם כללי ערך');
      if (String(adset.value_rule_set_id || '') === String(rs.id)) return asAdvice('הסט כבר משתמש בערכה הזו');
      return { ...s, targetType: 'adset', targetName: adset.name, params: { valueRuleSetId: rs.id, valueRuleSetName: rs.name }, before: { value_rule_set_id: adset.value_rule_set_id || null }, after: { value_rule_set_id: String(rs.id) } };
    }
  }
  return base;
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { /* try the outermost braces */ }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* fall through */ } }
  return null;
}

// ---------- applying one change ----------

async function readTarget(token: string, type: string, id: string) {
  const fields = type === 'ad' ? 'id,status' : type === 'campaign' ? 'id,status,daily_budget' : 'id,status,daily_budget,targeting,value_rule_set_id,bid_adjustments';
  return gget(id, token, { fields });
}

// Is the object still as it was ("before")? Compares only the fields the change touches.
function stillAsBefore(obj: any, before: Record<string, any>): boolean {
  return Object.entries(before).every(([k, v]) => {
    if (k === 'age_min' || k === 'age_max') return num(obj?.targeting?.[k] || (k === 'age_min' ? 18 : 65)) === num(v);
    if (k === 'daily_budget') return num(obj?.[k]) === num(v);
    return String(obj?.[k] ?? '') === String(v ?? '');
  });
}

async function writeTarget(token: string, type: string, id: string, current: any, values: Record<string, any>) {
  const body: Record<string, string> = {};
  if ('status' in values) body.status = String(values.status);
  if ('daily_budget' in values) body.daily_budget = String(values.daily_budget);
  if ('age_min' in values || 'age_max' in values) {
    const t = { ...(current?.targeting || {}) };
    if ('age_min' in values) t.age_min = values.age_min;
    if ('age_max' in values) t.age_max = values.age_max;
    body.targeting = JSON.stringify(t);
  }
  if ('value_rule_set_id' in values) {
    if (values.value_rule_set_id) { body.value_rule_set_id = String(values.value_rule_set_id); body.value_rules_applied = 'true'; }
    else body.value_rules_applied = 'false';
  }
  return gpost(id, token, body);
}

// ---------- routes ----------

const who = () => currentUser()?.email || 'unknown';

export function registerOptimizerRoutes(app: express.Express) {
  app.post('/api/meta-ads/campaigns/:id/analyze', async (req, res) => {
    try {
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const campaignId = String(req.params.id).replace(/\D/g, '');
      const data = await readCampaign(creds, campaignId);
      const ai = await aiJson(SYSTEM, JSON.stringify(forAi(data)), 'ניתוח קמפיין ממומן', data.campaign.name);
      if (!ai.text) return res.json({ success: false, error: `הניתוח נכשל: ${ai.error}` });
      const parsed = parseJson(ai.text);
      if (!parsed) return res.json({ success: false, error: 'ה-AI החזיר תשובה לא קריאה - נסו שוב' });
      const suggestions: Suggestion[] = (Array.isArray(parsed.suggestions) ? parsed.suggestions : []).slice(0, 8).map((x: any, i: number) => validate(x, data, i));
      const analysis = {
        summary: String(parsed.summary || ''), health: ['good', 'ok', 'bad'].includes(parsed.health) ? parsed.health : 'ok',
        findings: (Array.isArray(parsed.findings) ? parsed.findings : []).map(String).slice(0, 8),
        currency: data.currency,
        totals: { last7: sumMetrics(data.adsets.map(s => s.m7)), last30: sumMetrics(data.adsets.map(s => s.m30)) },
        crm: data.crm ? { last7: data.crm.last7, last30: data.crm.last30 } : null,
        ilsRate: data.ilsRate,
        adsets: data.adsets.map(s => ({ id: s.id, name: s.name, status: s.effective_status, learning: s.learning_stage_info?.status || null, dailyBudget: s.daily_budget ? round(num(s.daily_budget) / 100) : null, m7: s.m7, m30: s.m30, crm: data.crm?.byAdset?.[String(s.id)] || null })),
        ads: data.ads.map(a => ({ id: a.id, adsetId: a.adset_id, name: a.name, status: a.effective_status, thumb: a.creative?.thumbnail_url || a.creative?.image_url || null, m7: a.m7, m30: a.m30, crm: data.crm?.byAd?.[String(a.id)] || null })),
        daily: data.daily,
        readErrors: data.readErrors,
      };
      let optimizationId: number | null = null;
      if (db()) {
        const p = await ensureTables();
        const r = await p.query(
          `INSERT INTO mk_optimizations (tenant_id, campaign_id, campaign_name, created_by, analysis, suggestions) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb) RETURNING id`,
          [currentTenant(), campaignId, data.campaign.name || null, who(), JSON.stringify(analysis), JSON.stringify(suggestions)],
        );
        optimizationId = Number(r.rows[0].id);
      }
      res.json({ success: true, optimizationId, campaign: { id: campaignId, name: data.campaign.name, objective: data.campaign.objective }, analysis, suggestions, canExecute: !!db() });
    } catch (e: any) {
      console.error('[optimizer analyze]', e?.message);
      res.json({ success: false, error: e?.message || 'שגיאה בניתוח' });
    }
  });

  // body: { items: [{ suggestionId, dailyBudget? }] }
  app.post('/api/meta-ads/optimizations/:id/execute', async (req, res) => {
    if (!db()) return res.json({ success: false, error: 'כדי לבצע שינויים צריך מסד נתונים (DATABASE_URL ב-Vercel) - כל שינוי נשמר עם אפשרות ביטול' });
    try {
      const p = await ensureTables();
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const r = await p.query('SELECT * FROM mk_optimizations WHERE id = $1 AND tenant_id = $2', [Number(req.params.id), currentTenant()]);
      const opt = r.rows[0];
      if (!opt) return res.status(404).json({ success: false, error: 'הניתוח לא נמצא' });
      if (Date.now() - new Date(opt.created_at).getTime() > 24 * 3600_000) return res.json({ success: false, error: 'הניתוח ישן מיותר מיום - נתחו שוב לפני ביצוע' });
      const items: any[] = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [];
      const results: any[] = [];
      for (const item of items) {
        const sug: Suggestion | undefined = (opt.suggestions || []).find((x: Suggestion) => x.id === item?.suggestionId);
        if (!sug || !sug.executable || !sug.targetId || !sug.targetType || !sug.before || !sug.after) {
          results.push({ suggestionId: item?.suggestionId, ok: false, error: 'ההמלצה לא ניתנת לביצוע אוטומטי' });
          continue;
        }
        let after = { ...sug.after };
        // a budget the person changed before approving - same ±50% limit from the value at analysis
        if ('daily_budget' in after && item.dailyBudget != null) {
          const cur = num(sug.before.daily_budget);
          const wanted = Math.round(num(item.dailyBudget) * 100);
          if (!wanted || wanted < cur * 0.5 || wanted > cur * 1.5) {
            results.push({ suggestionId: sug.id, ok: false, error: `תקציב מחוץ לטווח המותר (${round(cur * 0.5 / 100)}–${round(cur * 1.5 / 100)})` });
            continue;
          }
          after = { daily_budget: wanted };
        }
        const now = await readTarget(creds.token, sug.targetType, sug.targetId);
        if (!now.ok) { results.push({ suggestionId: sug.id, ok: false, error: metaErr(now.data) }); continue; }
        if (!stillAsBefore(now.data, sug.before)) {
          results.push({ suggestionId: sug.id, ok: false, error: 'השתנה במטא מאז הניתוח - לא בוצע. נתחו שוב.' });
          continue;
        }
        const w = await writeTarget(creds.token, sug.targetType, sug.targetId, now.data, after);
        const ok = w.ok && w.data?.success !== false;
        await p.query(
          `INSERT INTO mk_changes (tenant_id, optimization_id, suggestion_id, campaign_id, object_type, object_id, object_name, action, title, before, after, status, error, done_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14)`,
          [currentTenant(), opt.id, sug.id, opt.campaign_id, sug.targetType, sug.targetId, sug.targetName || null, sug.action, sug.title,
            JSON.stringify(sug.before), JSON.stringify(after), ok ? 'done' : 'failed', ok ? null : metaErr(w.data), who()],
        );
        results.push({ suggestionId: sug.id, ok, error: ok ? undefined : metaErr(w.data) });
      }
      res.json({ success: true, results });
    } catch (e: any) {
      console.error('[optimizer execute]', e?.message);
      res.json({ success: false, error: e?.message || 'שגיאה בביצוע' });
    }
  });

  app.get('/api/meta-ads/campaigns/:id/changes', async (req, res) => {
    if (!db()) return res.json({ success: true, changes: [], noDatabase: true });
    try {
      const p = await ensureTables();
      const r = await p.query(
        `SELECT id, object_type, object_id, object_name, action, title, before, after, status, error, done_by, done_at, undone_at, undone_by, undo_of
           FROM mk_changes WHERE tenant_id = $1 AND campaign_id = $2 ORDER BY done_at DESC LIMIT 100`,
        [currentTenant(), String(req.params.id).replace(/\D/g, '')],
      );
      res.json({ success: true, changes: r.rows });
    } catch (e: any) {
      res.json({ success: false, error: e?.message });
    }
  });

  app.post('/api/meta-ads/changes/:id/undo', async (req, res) => {
    if (!db()) return res.json({ success: false, error: 'אין מסד נתונים' });
    try {
      const p = await ensureTables();
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const r = await p.query(`SELECT * FROM mk_changes WHERE id = $1 AND tenant_id = $2`, [Number(req.params.id), currentTenant()]);
      const ch = r.rows[0];
      if (!ch) return res.status(404).json({ success: false, error: 'השינוי לא נמצא' });
      if (ch.status !== 'done' || ch.undone_at || ch.undo_of) return res.json({ success: false, error: 'אי אפשר לבטל את השינוי הזה' });
      const now = await readTarget(creds.token, ch.object_type, ch.object_id);
      if (!now.ok) return res.json({ success: false, error: metaErr(now.data) });
      if (!stillAsBefore(now.data, ch.after)) return res.json({ success: false, error: 'הערך השתנה שוב במטא מאז - לא בוטל' });
      const w = await writeTarget(creds.token, ch.object_type, ch.object_id, now.data, ch.before);
      const ok = w.ok && w.data?.success !== false;
      await p.query(
        `INSERT INTO mk_changes (tenant_id, optimization_id, suggestion_id, campaign_id, object_type, object_id, object_name, action, title, before, after, status, error, done_by, undo_of)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15)`,
        [currentTenant(), ch.optimization_id, ch.suggestion_id, ch.campaign_id, ch.object_type, ch.object_id, ch.object_name, `undo:${ch.action}`,
          `ביטול: ${ch.title || ch.action}`, JSON.stringify(ch.after), JSON.stringify(ch.before), ok ? 'done' : 'failed', ok ? null : metaErr(w.data), who(), ch.id],
      );
      if (ok) await p.query(`UPDATE mk_changes SET undone_at = now(), undone_by = $2 WHERE id = $1`, [ch.id, who()]);
      res.json({ success: ok, error: ok ? undefined : metaErr(w.data) });
    } catch (e: any) {
      res.json({ success: false, error: e?.message });
    }
  });
}

function sumMetrics(list: any[]) {
  const t = list.filter(Boolean).reduce((a, m) => ({ spend: a.spend + m.spend, leads: a.leads + m.leads, clicks: a.clicks + m.clicks, impressions: a.impressions + m.impressions }), { spend: 0, leads: 0, clicks: 0, impressions: 0 });
  return { ...t, spend: round(t.spend), cpl: t.leads ? round(t.spend / t.leads) : null, ctr: t.impressions ? round((t.clicks / t.impressions) * 100) : null };
}
