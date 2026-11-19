// Paid campaigns - step 1: a READ-ONLY snapshot of the business's Meta ad account (Haim, 2026-11-19).
//
// Before the AI builds campaigns, it has to know how the business sets them up today: every
// campaign / ad set / ad with its full settings (audience, placements, bid strategy and budget,
// optimisation goal, attribution, value rules - e.g. "+50% on feed FB / Instagram reel"), the
// custom / lookalike audiences, saved audiences, lead forms and pixels, plus the last 30 days'
// results per ad set. New campaigns will later start as a copy of a proven one ("like the 150
// campaign, but for Haifa") rather than from scratch.
//
// Nothing here writes to Meta - GET calls only. The token is the business's own
// FB_ADS_ACCESS_TOKEN from the portal vault ("מזהים וחיבורים" → פייסבוק, module `marketing`), the
// account FB_AD_ACCOUNT_ID (the optics: act_950741540610683 when unset). Moved here from
// WhastAppSystem's api/_metaAdsSnapshot.ts (2026-11-19).
//
// Meta keeps renaming / retiring fields, and one unknown field fails the whole request: a field
// Meta says doesn't exist is dropped and the request retried (`droppedFields` says which).
import express from 'express';
import { tenantSecret } from './secrets.js';
import { OPTICS_TENANT, currentTenant } from './tenant.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const OPTICS_ACCOUNT = 'act_950741540610683';
const MAX_PAGES = 10;

type Creds = { token: string; accountId: string };
type PageCreds = { pageId: string; accessToken: string } | null;

export type SnapshotPart<T = any> = { ok: boolean; data: T[]; error?: string; droppedFields?: string[] };

const normAccount = (id: string) => {
  const s = String(id || '').trim();
  if (!s) return '';
  return s.startsWith('act_') ? s : `act_${s.replace(/\D/g, '')}`;
};

async function graph(path: string, token: string, params: Record<string, string>): Promise<{ ok: boolean; data: any }> {
  const url = path.startsWith('http') ? path : `${GRAPH}/${path}?${new URLSearchParams({ ...params, access_token: token })}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch (e: any) {
    return { ok: false, data: { error: { message: e?.message || 'network' } } };
  }
}

const errText = (d: any) => {
  const e = d?.error;
  if (!e) return 'שגיאה לא ידועה מ-Meta';
  return [e.error_user_title, e.error_user_msg || e.message, e.code ? `(#${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : '']
    .filter(Boolean).join(' · ');
};

// "(#100) Tried accessing nonexisting field (value_rule_set_id) on node type (AdSet)" → the field.
function missingField(d: any, fields: string[]): string | null {
  const msg = String(d?.error?.message || '');
  const m = msg.match(/nonexisting field \(([^)]+)\)/i) || msg.match(/field[s]? (?:\(|')?([a-z_]+)(?:\)|')? (?:is|are) (?:not valid|deprecated)/i);
  if (!m) return null;
  const name = m[1];
  // the top-level field holding it (e.g. "creative{...asset_feed_spec...}" holds asset_feed_spec)
  return fields.find(f => f === name) || fields.find(f => f.startsWith(`${name}{`)) || fields.find(f => f.includes(name)) || null;
}

// A list edge, every page (up to MAX_PAGES), retrying without fields Meta doesn't know.
export async function readEdge(path: string, token: string, fields: string[], extra: Record<string, string> = {}): Promise<SnapshotPart> {
  let use = [...fields];
  const dropped: string[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const first = await graph(path, token, { ...extra, fields: use.join(','), limit: extra.limit || '100' });
    if (!first.ok) {
      const bad = missingField(first.data, use);
      if (bad) { use = use.filter(f => f !== bad); dropped.push(bad); continue; }
      return { ok: false, data: [], error: errText(first.data), droppedFields: dropped.length ? dropped : undefined };
    }
    const rows: any[] = Array.isArray(first.data?.data) ? [...first.data.data] : [];
    let next: string | undefined = first.data?.paging?.next;
    for (let p = 1; next && p < MAX_PAGES; p++) {
      const page = await graph(next, token, {});
      if (!page.ok) break;
      if (Array.isArray(page.data?.data)) rows.push(...page.data.data);
      next = page.data?.paging?.next;
    }
    return { ok: true, data: rows, droppedFields: dropped.length ? dropped : undefined };
  }
  return { ok: false, data: [], error: 'Meta דחתה יותר מדי שדות', droppedFields: dropped };
}

// One object (the account itself), same field retry.
async function readNode(path: string, token: string, fields: string[]): Promise<{ ok: boolean; data: any; error?: string; droppedFields?: string[] }> {
  let use = [...fields];
  const dropped: string[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await graph(path, token, { fields: use.join(',') });
    if (r.ok) return { ok: true, data: r.data, droppedFields: dropped.length ? dropped : undefined };
    const bad = missingField(r.data, use);
    if (bad) { use = use.filter(f => f !== bad); dropped.push(bad); continue; }
    return { ok: false, data: null, error: errText(r.data) };
  }
  return { ok: false, data: null, error: 'Meta דחתה יותר מדי שדות', droppedFields: dropped };
}

const ACCOUNT_FIELDS = ['id', 'name', 'account_status', 'currency', 'timezone_name', 'amount_spent', 'spend_cap', 'business{id,name}', 'disable_reason', 'min_daily_budget'];
const CAMPAIGN_FIELDS = ['id', 'name', 'status', 'effective_status', 'objective', 'buying_type', 'bid_strategy', 'daily_budget', 'lifetime_budget',
  'budget_remaining', 'special_ad_categories', 'start_time', 'stop_time', 'created_time', 'updated_time', 'smart_promotion_type', 'is_budget_schedule_enabled', 'pacing_type'];
const ADSET_FIELDS = ['id', 'name', 'campaign_id', 'status', 'effective_status', 'optimization_goal', 'billing_event', 'bid_strategy', 'bid_amount', 'bid_constraints',
  'daily_budget', 'lifetime_budget', 'targeting', 'promoted_object', 'destination_type', 'attribution_spec', 'frequency_control_specs', 'start_time', 'end_time',
  'created_time', 'updated_time', 'pacing_type', 'is_dynamic_creative', 'learning_stage_info', 'value_rule_set_id', 'value_rules_applied', 'bid_adjustments',
  'targeting_optimization_types', 'dsa_beneficiary', 'dsa_payor', 'multi_optimization_goal_weight', 'placement_soft_opt_out'];
const AD_FIELDS = ['id', 'name', 'campaign_id', 'adset_id', 'status', 'effective_status', 'created_time', 'updated_time', 'preview_shareable_link',
  'creative{id,name,object_type,title,body,call_to_action_type,image_url,thumbnail_url,video_id,object_story_id,effective_object_story_id,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,instagram_permalink_url,url_tags,link_url}'];
const CUSTOM_AUDIENCE_FIELDS = ['id', 'name', 'subtype', 'description', 'approximate_count_lower_bound', 'approximate_count_upper_bound', 'lookalike_spec',
  'lookalike_audience_ids', 'data_source', 'delivery_status', 'operation_status', 'time_created', 'time_updated', 'retention_days', 'rule'];
const SAVED_AUDIENCE_FIELDS = ['id', 'name', 'targeting', 'approximate_count_lower_bound', 'approximate_count_upper_bound', 'time_created', 'time_updated'];
const VALUE_RULE_FIELDS = ['id', 'name', 'status', 'rules', 'product_type', 'scope'];
const PIXEL_FIELDS = ['id', 'name', 'last_fired_time', 'is_unavailable', 'creation_time'];
const LEAD_FORM_FIELDS = ['id', 'name', 'status', 'locale', 'questions', 'privacy_policy_url', 'thank_you_page', 'context_card', 'created_time', 'leads_count', 'is_optimized_for_quality'];
const INSIGHT_FIELDS = ['campaign_id', 'adset_id', 'spend', 'impressions', 'reach', 'frequency', 'clicks', 'ctr', 'cpm', 'actions', 'cost_per_action_type'];

export async function adsCredsForCurrentBusiness(): Promise<Creds | null> {
  const token = (await tenantSecret('FB_ADS_ACCESS_TOKEN')).trim();
  let accountId = normAccount(await tenantSecret('FB_AD_ACCOUNT_ID'));
  if (!accountId && currentTenant() === OPTICS_TENANT) accountId = OPTICS_ACCOUNT;
  if (!token || !accountId) return null;
  return { token, accountId };
}

export async function buildAdsSnapshot(creds: Creds, page: PageCreds) {
  const { token, accountId } = creds;
  const [account, campaigns, adsets, ads, customAudiences, savedAudiences, valueRuleSets, pixels, insights, permissions] = await Promise.all([
    readNode(accountId, token, ACCOUNT_FIELDS),
    readEdge(`${accountId}/campaigns`, token, CAMPAIGN_FIELDS),
    readEdge(`${accountId}/adsets`, token, ADSET_FIELDS),
    readEdge(`${accountId}/ads`, token, AD_FIELDS, { limit: '50' }),
    readEdge(`${accountId}/customaudiences`, token, CUSTOM_AUDIENCE_FIELDS),
    readEdge(`${accountId}/saved_audiences`, token, SAVED_AUDIENCE_FIELDS),
    readEdge(`${accountId}/value_rule_set`, token, VALUE_RULE_FIELDS),
    readEdge(`${accountId}/adspixels`, token, PIXEL_FIELDS),
    readEdge(`${accountId}/insights`, token, INSIGHT_FIELDS, { level: 'adset', date_preset: 'last_30d' }),
    readEdge('me/permissions', token, ['permission', 'status']),
  ]);
  // Lead forms belong to the Page - read with the Page token the posts screen already uses.
  const leadForms: SnapshotPart = page
    ? await readEdge(`${page.pageId}/leadgen_forms`, page.accessToken, LEAD_FORM_FIELDS, { limit: '50' })
    : { ok: false, data: [], error: 'אין חיבור לדף הפייסבוק (מזהה דף + טוקן) - הטפסים לא נקראו' };

  const granted = permissions.data.filter((p: any) => p?.status === 'granted').map((p: any) => String(p.permission));
  return {
    takenAt: new Date().toISOString(),
    accountId,
    account,
    token: { permissions: granted, canManageAds: granted.includes('ads_management') },
    campaigns, adsets, ads, customAudiences, savedAudiences, valueRuleSets, pixels, leadForms, insights,
    counts: {
      campaigns: campaigns.data.length, adsets: adsets.data.length, ads: ads.data.length,
      activeCampaigns: campaigns.data.filter((c: any) => c.effective_status === 'ACTIVE').length,
      activeAdsets: adsets.data.filter((a: any) => a.effective_status === 'ACTIVE').length,
      customAudiences: customAudiences.data.length, valueRuleSets: valueRuleSets.data.length, leadForms: leadForms.data.length,
    },
  };
}

// The business's Facebook Page (for its lead forms): FB_PAGE_ID + FB_PAGE_ACCESS_TOKEN from the
// vault. The saved token may be a user / system-user token - turned into the Page's own token.
export async function pageCredsForCurrentBusiness(): Promise<PageCreds> {
  const pageId = (await tenantSecret('FB_PAGE_ID')).trim();
  const token = (await tenantSecret('FB_PAGE_ACCESS_TOKEN')).trim();
  if (!pageId || !token) return null;
  const r = await graph(pageId, token, { fields: 'access_token' });
  return { pageId, accessToken: r.ok && typeof r.data?.access_token === 'string' && r.data.access_token ? r.data.access_token : token };
}

export function registerAdsSnapshotRoutes(app: express.Express) {
  // GET /api/meta-ads/snapshot - the whole account, read only (the session middleware already
  // refused a request without a signed-in business).
  app.get('/api/meta-ads/snapshot', async (_req, res) => {
    try {
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) {
        return res.json({
          success: false,
          error: 'חסר טוקן פרסום של פייסבוק. בפורטל: "מזהים וחיבורים" ← פייסבוק ← "טוקן גישה לפרסום בפייסבוק" (ומזהה חשבון המודעות).',
        });
      }
      const page = await pageCredsForCurrentBusiness().catch(() => null);
      const snapshot = await buildAdsSnapshot(creds, page);
      if (!snapshot.account.ok && !snapshot.campaigns.ok) {
        return res.json({ success: false, error: snapshot.account.error || snapshot.campaigns.error || 'לא הצלחנו לקרוא את חשבון המודעות' });
      }
      return res.json({ success: true, snapshot });
    } catch (err: any) {
      console.error('[meta-ads snapshot]', err?.message);
      return res.status(500).json({ success: false, error: err?.message || 'שגיאה בקריאת חשבון המודעות' });
    }
  });
}
