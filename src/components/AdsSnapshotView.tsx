// "📣 ממומן — צילום מצב" (Haim, 2026-11-19; moved here from WhastAppSystem): paid campaigns, step 1 - a READ-ONLY look at the
// business's Meta ad account, so the coming campaign builder starts from how campaigns are set up
// today (audience, placements, bids and budgets, value rules, lookalikes, lead forms).
// Data: GET /api/meta-ads/snapshot (server/metaAdsSnapshot.ts). Nothing here changes anything at Meta.
import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Download, ChevronDown, ChevronLeft } from 'lucide-react';
import CampaignOptimizer from './CampaignOptimizer';
import NewCampaignBuilder from './NewCampaignBuilder';

type Part = { ok: boolean; data: any[]; error?: string; droppedFields?: string[] };
type Snapshot = {
  takenAt: string; accountId: string;
  account: { ok: boolean; data: any; error?: string };
  token: { permissions: string[]; canManageAds: boolean };
  campaigns: Part; adsets: Part; ads: Part; customAudiences: Part; savedAudiences: Part;
  valueRuleSets: Part; pixels: Part; leadForms: Part; insights: Part;
  counts: Record<string, number>;
};

type Tab = 'structure' | 'audiences' | 'rules' | 'forms' | 'account';

const STATUS_HE: Record<string, [string, string]> = {
  ACTIVE: ['פעיל', 'bg-green-100 text-green-800'],
  PAUSED: ['מושהה', 'bg-gray-100 text-gray-700'],
  CAMPAIGN_PAUSED: ['הקמפיין מושהה', 'bg-gray-100 text-gray-700'],
  ADSET_PAUSED: ['הסט מושהה', 'bg-gray-100 text-gray-700'],
  ARCHIVED: ['בארכיון', 'bg-gray-100 text-gray-500'],
  DELETED: ['נמחק', 'bg-red-50 text-red-600'],
  IN_PROCESS: ['בעיבוד', 'bg-sky-100 text-sky-800'],
  WITH_ISSUES: ['עם בעיות', 'bg-red-100 text-red-700'],
  DISAPPROVED: ['נדחה', 'bg-red-100 text-red-700'],
  PENDING_REVIEW: ['בבדיקה', 'bg-amber-100 text-amber-800'],
};
const OBJECTIVE_HE: Record<string, string> = {
  OUTCOME_LEADS: 'לידים', OUTCOME_SALES: 'מכירות', OUTCOME_TRAFFIC: 'תנועה', OUTCOME_ENGAGEMENT: 'מעורבות',
  OUTCOME_AWARENESS: 'מודעות', OUTCOME_APP_PROMOTION: 'אפליקציה', LEAD_GENERATION: 'לידים (ישן)', MESSAGES: 'הודעות (ישן)',
  CONVERSIONS: 'המרות (ישן)', LINK_CLICKS: 'קליקים (ישן)',
};
const GOAL_HE: Record<string, string> = {
  LEAD_GENERATION: 'לידים (טופס)', QUALITY_LEAD: 'לידים איכותיים', OFFSITE_CONVERSIONS: 'המרות באתר', CONVERSATIONS: 'שיחות',
  LINK_CLICKS: 'קליקים', LANDING_PAGE_VIEWS: 'צפיות בדף נחיתה', REACH: 'טווח הגעה', IMPRESSIONS: 'חשיפות', THRUPLAY: 'צפיות בסרטון',
  POST_ENGAGEMENT: 'מעורבות', VALUE: 'ערך', QUALITY_CALL: 'שיחות איכותיות', MESSAGING_PURCHASE_CONVERSION: 'רכישה בהודעות',
};
const BID_HE: Record<string, string> = {
  LOWEST_COST_WITHOUT_CAP: 'העלות הנמוכה ביותר (בלי תקרה)', LOWEST_COST_WITH_BID_CAP: 'תקרת הצעה (Bid cap)',
  COST_CAP: 'תקרת עלות (Cost cap)', LOWEST_COST_WITH_MIN_ROAS: 'ROAS מינימלי',
};
const POSITION_HE: Record<string, string> = {
  feed: 'פיד', story: 'סטורי', reels: 'רילס', facebook_reels: 'רילס', instream_video: 'וידאו בתוך תוכן', video_feeds: 'פיד וידאו',
  marketplace: 'מרקטפלייס', right_hand_column: 'עמודה ימנית', search: 'חיפוש', explore: 'אקספלור', explore_home: 'אקספלור (בית)',
  profile_feed: 'פיד פרופיל', profile_reels: 'רילס בפרופיל', ig_search: 'חיפוש', facebook_reels_overlay: 'שכבת רילס', notification: 'התראות',
};

function StatusChip({ s }: { s?: string }) {
  if (!s) return null;
  const [label, cls] = STATUS_HE[s] || [s, 'bg-gray-100 text-gray-700'];
  return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${cls}`}>{label}</span>;
}

// Amounts in shekels (Haim, 2026-11-19 - "USD" in a Hebrew line read badly); the account's own
// currency in Hebrew words next to it. RATE = today's ILS per unit, set when the snapshot loads.
const CUR_HE: Record<string, string> = { USD: 'דולר', EUR: 'יורו', GBP: 'ליש"ט', ILS: 'ש"ח' };
let RATE: number | null = null;
const amount = (v: number, cur: string) => {
  const own = `${v.toLocaleString('he-IL', { maximumFractionDigits: 2 })} ${CUR_HE[cur] || cur}`;
  if (cur === 'ILS') return `₪${Math.round(v).toLocaleString('he-IL')}`;
  return RATE ? `₪${Math.round(v * RATE).toLocaleString('he-IL')} (${own})` : own;
};
const money = (minor: any, cur: string) => (minor == null || minor === '' ? '' : amount(Number(minor) / 100, cur));
const DEST_HE: Record<string, string> = {
  ON_AD: 'טופס לידים בתוך פייסבוק / אינסטגרם', WEBSITE: 'אתר', WHATSAPP: 'וואטסאפ', MESSENGER: "מסנג'ר",
  INSTAGRAM_DIRECT: 'הודעה באינסטגרם', PHONE_CALL: 'שיחת טלפון', ON_POST: 'הפוסט', ON_PAGE: 'הדף', UNDEFINED: '',
};
const PROMOTED_HE: Record<string, string> = { page_id: 'דף', pixel_id: 'פיקסל', custom_event_type: 'אירוע', lead_gen_form_id: 'טופס', application_id: 'אפליקציה', whatsapp_phone_number: 'מספר וואטסאפ' };
const promotedText = (o: any) =>
  Object.entries(o || {}).filter(([k]) => k in PROMOTED_HE).map(([k, v]) => `${PROMOTED_HE[k]}: ${v}`).join(' · ');
const fmtDate = (s?: string) => (s ? new Date(s).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '');

function budgetOf(o: any, cur: string): string {
  if (o?.daily_budget) return `${money(o.daily_budget, cur)} ליום`;
  if (o?.lifetime_budget) return `${money(o.lifetime_budget, cur)} לכל התקופה`;
  return '';
}

// The ad set's audience, in words.
function describeTargeting(t: any): [string, string][] {
  if (!t) return [];
  const rows: [string, string][] = [];
  const age = t.age_min || t.age_max ? `${t.age_min || 18}–${t.age_max || '65+'}` : '';
  const genders = Array.isArray(t.genders) && t.genders.length ? t.genders.map((g: number) => (g === 1 ? 'גברים' : g === 2 ? 'נשים' : g)).join(', ') : 'כולם';
  rows.push(['גיל ומגדר', `${age || 'כל הגילאים'} · ${genders}`]);
  const geo = t.geo_locations || {};
  const places: string[] = [];
  (geo.countries || []).forEach((c: string) => places.push(c === 'IL' ? 'ישראל' : c));
  (geo.regions || []).forEach((r: any) => places.push(r.name || r.key));
  (geo.cities || []).forEach((c: any) => places.push(`${c.name || c.key}${c.radius ? ` +${c.radius} ${c.distance_unit === 'mile' ? 'מייל' : 'ק"מ'}` : ''}`));
  (geo.custom_locations || []).forEach((c: any) => places.push(`${c.name || c.address_string || `${c.latitude},${c.longitude}`} ברדיוס ${c.radius} ${c.distance_unit === 'mile' ? 'מייל' : 'ק"מ'}`));
  (geo.zips || []).forEach((z: any) => places.push(z.name || z.key));
  if (places.length) rows.push(['מיקום', places.join(' · ') + (geo.location_types ? ` (${geo.location_types.map((x: string) => (x === 'home' ? 'גרים' : x === 'recent' ? 'נמצאים לאחרונה' : x)).join(' / ')})` : '')]);
  const ex = t.excluded_geo_locations;
  if (ex) rows.push(['מיקום מוחרג', [...(ex.cities || []).map((c: any) => c.name), ...(ex.regions || []).map((r: any) => r.name), ...(ex.custom_locations || []).map((c: any) => c.name || c.address_string)].filter(Boolean).join(' · ') || 'כן']);
  const ca = (t.custom_audiences || []).map((a: any) => a.name || a.id);
  if (ca.length) rows.push(['קהלים מותאמים / דומים', ca.join(' · ')]);
  const xca = (t.excluded_custom_audiences || []).map((a: any) => a.name || a.id);
  if (xca.length) rows.push(['קהלים מוחרגים', xca.join(' · ')]);
  const interests: string[] = [];
  (t.flexible_spec || []).forEach((spec: any) => Object.values(spec || {}).forEach((arr: any) => Array.isArray(arr) && arr.forEach((x: any) => interests.push(x?.name || x?.id))));
  if (interests.length) rows.push(['תחומי עניין / התנהגויות', interests.join(' · ')]);
  const exInt: string[] = [];
  Object.values(t.exclusions || {}).forEach((arr: any) => Array.isArray(arr) && arr.forEach((x: any) => exInt.push(x?.name || x?.id)));
  if (exInt.length) rows.push(['החרגות', exInt.join(' · ')]);
  const adv = t.targeting_automation?.advantage_audience;
  if (adv != null) rows.push(['Advantage+ קהל', adv === 1 ? 'פעיל (מטא יכולה להרחיב מעבר לקהל)' : 'כבוי']);
  if (Array.isArray(t.locales) && t.locales.length) rows.push(['שפות', t.locales.join(', ')]);
  // placements
  if (!t.publisher_platforms) rows.push(['מיקומי מודעה', 'Advantage+ (אוטומטי - כל המיקומים)']);
  else {
    const parts: string[] = [];
    const pos = (arr?: string[]) => (arr && arr.length ? `: ${arr.map(p => POSITION_HE[p] || p).join(', ')}` : '');
    t.publisher_platforms.forEach((p: string) => {
      if (p === 'facebook') parts.push(`פייסבוק${pos(t.facebook_positions)}`);
      else if (p === 'instagram') parts.push(`אינסטגרם${pos(t.instagram_positions)}`);
      else if (p === 'messenger') parts.push(`מסנג'ר${pos(t.messenger_positions)}`);
      else if (p === 'audience_network') parts.push(`Audience Network${pos(t.audience_network_positions)}`);
      else parts.push(p);
    });
    rows.push(['מיקומי מודעה (ידני)', parts.join(' · ')]);
  }
  if (Array.isArray(t.device_platforms) && t.device_platforms.length) rows.push(['מכשירים', t.device_platforms.map((d: string) => (d === 'mobile' ? 'נייד' : d === 'desktop' ? 'מחשב' : d)).join(', ')]);
  return rows;
}

function leadsOf(ins: any): number {
  const a = (ins?.actions || []).find((x: any) => ['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped', 'offsite_conversion.fb_pixel_lead'].includes(x.action_type));
  return a ? Number(a.value) : 0;
}

function creativeSummary(c: any): string {
  if (!c) return '';
  const afs = c.asset_feed_spec;
  if (afs) {
    const bits = [
      afs.images?.length ? `${afs.images.length} תמונות` : '',
      afs.videos?.length ? `${afs.videos.length} סרטונים` : '',
      afs.bodies?.length ? `${afs.bodies.length} טקסטים` : '',
      afs.titles?.length ? `${afs.titles.length} כותרות` : '',
      afs.ad_formats?.length ? `פורמטים: ${afs.ad_formats.join(', ')}` : '',
    ].filter(Boolean);
    return `מודעה גמישה (כמה נכסים) · ${bits.join(' · ')}`;
  }
  const oss = c.object_story_spec || {};
  if (oss.link_data?.child_attachments) return `קרוסלה · ${oss.link_data.child_attachments.length} כרטיסים`;
  if (oss.video_data || c.video_id) return 'סרטון';
  if (oss.link_data || c.image_url) return 'תמונה';
  if (c.effective_object_story_id || c.object_story_id) return 'פוסט קיים מהדף';
  return c.object_type || '';
}

function Kv({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.filter(([, v]) => v !== '' && v != null).map(([k, v]) => (
        <React.Fragment key={k}><span className="text-gray-500">{k}</span><span className="text-gray-800 break-words">{v}</span></React.Fragment>
      ))}
    </div>
  );
}

function PartError({ part, what }: { part?: Part; what: string }) {
  if (!part) return null;
  return (
    <>
      {!part.ok && <p className="text-xs text-red-600 bg-red-50 rounded p-2">לא הצלחנו לקרוא {what}: {part.error}</p>}
      {part.droppedFields?.length ? <p className="text-[11px] text-gray-400">שדות שמטא לא מכירה (דילגנו): {part.droppedFields.join(', ')}</p> : null}
    </>
  );
}

export default function AdsSnapshotView() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>('structure');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [optimizeFor, setOptimizeFor] = useState<{ id: string; name: string } | null>(null);
  const [building, setBuilding] = useState(false);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const d = await fetch('/api/meta-ads/snapshot').then(r => r.json());
      if (!d?.success) setError(d?.error || 'לא הצלחנו לקרוא את חשבון המודעות');
      else { RATE = d.snapshot?.ilsRate || null; setSnap(d.snapshot); }
    } catch (e: any) {
      setError(e?.message || 'שגיאת רשת');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const cur = snap?.account?.data?.currency || '';
  const insightsByAdset = useMemo(() => {
    const m = new Map<string, any>();
    (snap?.insights.data || []).forEach(i => m.set(String(i.adset_id), i));
    return m;
  }, [snap]);
  const ruleSetName = useMemo(() => {
    const m = new Map<string, string>();
    (snap?.valueRuleSets.data || []).forEach(r => m.set(String(r.id), r.name || r.id));
    return m;
  }, [snap]);

  const campaigns = useMemo(() => {
    const list = snap?.campaigns.data || [];
    const shown = showAll ? list : list.filter(c => c.effective_status === 'ACTIVE');
    return [...shown].sort((a, b) => String(b.updated_time || '').localeCompare(String(a.updated_time || '')));
  }, [snap, showAll]);

  const download = () => {
    if (!snap) return;
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `meta-ads-snapshot-${snap.accountId}-${snap.takenAt.slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const toggle = (id: string) => setOpen(o => ({ ...o, [id]: !o[id] }));

  // the campaign's analysis opens in the page, in place of the list (Haim, 2026-11-19 - not a pop-up)
  if (optimizeFor) return <CampaignOptimizer campaign={optimizeFor} onBack={() => setOptimizeFor(null)} />;
  if (building) return <NewCampaignBuilder onBack={() => { setBuilding(false); load(); }} />;

  return (
    <div dir="rtl">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 w-full flex flex-col">
        <div className="flex items-start justify-between gap-2 p-4 border-b border-gray-100">
          <div className="min-w-0">
            <h3 className="font-bold text-gray-800">📣 ממומן — צילום מצב של חשבון המודעות</h3>
            <p className="text-xs text-gray-500">
              קריאה בלבד - שום דבר לא משתנה במטא.
              {snap && <> · {snap.account?.data?.name || snap.accountId} · נקרא {new Date(snap.takenAt).toLocaleString('he-IL')}</>}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => setBuilding(true)} className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg px-3 py-2 whitespace-nowrap">✨ קמפיין חדש מהוראה</button>
            <button onClick={load} disabled={loading} title="קרא שוב" className="p-2 rounded-lg hover:bg-gray-100 text-gray-600 disabled:opacity-50">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </button>
            {snap && <button onClick={download} title="הורד את כל הנתונים (JSON)" className="p-2 rounded-lg hover:bg-gray-100 text-gray-600"><Download className="w-4 h-4" /></button>}
          </div>
        </div>

        {snap && (
          <div className="flex gap-1 px-4 pt-3 overflow-x-auto text-sm">
            {([
              ['structure', `קמפיינים (${snap.counts.activeCampaigns} פעילים מתוך ${snap.counts.campaigns})`],
              ['audiences', `קהלים (${snap.counts.customAudiences})`],
              ['rules', `כללי ערך למיקום (${snap.counts.valueRuleSets})`],
              ['forms', `טפסי לידים (${snap.counts.leadForms})`],
              ['account', 'חשבון והרשאות'],
            ] as [Tab, string][]).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`whitespace-nowrap px-3 py-1.5 rounded-lg font-bold ${tab === id ? 'bg-[#075E54] text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>{label}</button>
            ))}
          </div>
        )}

        <div className="p-4 space-y-3">
          {loading && !snap && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> קורא את כל הקמפיינים מחשבון המודעות…</p>}
          {error && <p className="text-sm text-red-700 bg-red-50 rounded-lg p-3">{error}</p>}

          {snap && tab === 'structure' && (
            <>
              <PartError part={snap.campaigns} what="את הקמפיינים" />
              <PartError part={snap.adsets} what="את סטי המודעות" />
              <PartError part={snap.ads} what="את המודעות" />
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> להציג גם קמפיינים מושהים / ישנים
              </label>
              {campaigns.length === 0 && <p className="text-sm text-gray-500">אין קמפיינים {showAll ? '' : 'פעילים '}בחשבון.</p>}
              {campaigns.map(c => {
                const sets = snap.adsets.data.filter(a => String(a.campaign_id) === String(c.id));
                const isOpen = open[c.id] ?? campaigns.length <= 3;
                return (
                  <div key={c.id} className="border border-gray-200 rounded-xl">
                    <button onClick={() => toggle(c.id)} className="w-full text-right p-3 flex items-start gap-2 hover:bg-gray-50 rounded-xl">
                      {isOpen ? <ChevronDown className="w-4 h-4 mt-0.5 shrink-0" /> : <ChevronLeft className="w-4 h-4 mt-0.5 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-gray-800">{c.name}</span>
                          <StatusChip s={c.effective_status} />
                          <span className="text-[11px] text-gray-500">{OBJECTIVE_HE[c.objective] || c.objective}</span>
                        </div>
                        <div className="text-[11px] text-gray-500 mt-0.5">
                          {[budgetOf(c, cur) && `תקציב קמפיין (CBO): ${budgetOf(c, cur)}`, c.bid_strategy && (BID_HE[c.bid_strategy] || c.bid_strategy),
                            `${sets.length} סטים`, c.start_time && `מ-${fmtDate(c.start_time)}`].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </button>
                    <div className="px-3 pb-2 -mt-1">
                      <button onClick={() => setOptimizeFor({ id: String(c.id), name: c.name })}
                        className="text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg px-3 py-1.5">
                        🔧 ניתוח והצעות לשיפור
                      </button>
                    </div>
                    {isOpen && (
                      <div className="px-3 pb-3 space-y-2">
                        {sets.map(s => {
                          const ins = insightsByAdset.get(String(s.id));
                          const leads = leadsOf(ins);
                          const ads = snap.ads.data.filter(a => String(a.adset_id) === String(s.id));
                          return (
                            <div key={s.id} className="bg-gray-50 rounded-lg p-3 space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-bold text-sm text-gray-800">סט: {s.name}</span>
                                <StatusChip s={s.effective_status} />
                                {s.learning_stage_info?.status && <span className="text-[10px] text-gray-500">למידה: {s.learning_stage_info.status}</span>}
                              </div>
                              {ins && (
                                <p className="text-[11px] text-indigo-800 bg-indigo-50 rounded px-2 py-1">
                                  30 ימים אחרונים: הוצאה {amount(Number(ins.spend || 0), cur)} · {Number(ins.impressions || 0).toLocaleString('he-IL')} חשיפות · {leads} לידים
                                  {leads ? ` · ${amount(Number(ins.spend) / leads, cur)} לליד` : ''}
                                </p>
                              )}
                              <Kv rows={[
                                ['מטרת אופטימיזציה', GOAL_HE[s.optimization_goal] || s.optimization_goal],
                                ['תקציב', budgetOf(s, cur) || (budgetOf(c, cur) ? 'לפי הקמפיין (CBO)' : '')],
                                ['אסטרטגיית הצעה', s.bid_strategy ? `${BID_HE[s.bid_strategy] || s.bid_strategy}${s.bid_amount ? ` · ${money(s.bid_amount, cur)}` : ''}` : ''],
                                ['כללי ערך למיקום', s.value_rule_set_id ? `${ruleSetName.get(String(s.value_rule_set_id)) || s.value_rule_set_id}${s.value_rules_applied === false ? ' (לא מופעל)' : ''}` : ''],
                                ['יעד', s.destination_type ? (DEST_HE[s.destination_type] ?? s.destination_type) : ''],
                                ['אירוע / טופס', promotedText(s.promoted_object)],
                                ['שיוך', (s.attribution_spec || []).map((a: any) => `${a.event_type === 'CLICK_THROUGH' ? 'קליק' : a.event_type === 'VIEW_THROUGH' ? 'צפייה' : a.event_type} ${a.window_days} ימים`).join(' · ')],
                                ['תדירות', (s.frequency_control_specs || []).map((f: any) => `${f.max_frequency} פעמים ב-${f.interval_days} ימים`).join(' · ')],
                                ...describeTargeting(s.targeting),
                              ]} />
                              {ads.length > 0 && (
                                <div className="space-y-1.5 pt-1">
                                  {ads.map(ad => (
                                    <div key={ad.id} className="flex gap-2 items-start bg-white rounded-lg border border-gray-100 p-2">
                                      {(ad.creative?.thumbnail_url || ad.creative?.image_url) && (
                                        <img src={ad.creative.thumbnail_url || ad.creative.image_url} alt="" className="w-12 h-12 rounded object-cover shrink-0" loading="lazy" />
                                      )}
                                      <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className="text-xs font-bold text-gray-800">{ad.name}</span>
                                          <StatusChip s={ad.effective_status} />
                                        </div>
                                        <p className="text-[11px] text-gray-500">{creativeSummary(ad.creative)}{ad.creative?.call_to_action_type ? ` · כפתור: ${ad.creative.call_to_action_type}` : ''}</p>
                                        {(ad.creative?.body || ad.creative?.asset_feed_spec?.bodies?.[0]?.text) && (
                                          <p className="text-[11px] text-gray-700 line-clamp-2">{ad.creative.body || ad.creative.asset_feed_spec.bodies[0].text}</p>
                                        )}
                                        {ad.preview_shareable_link && <a href={ad.preview_shareable_link} target="_blank" rel="noreferrer" className="text-[11px] text-sky-700 underline">תצוגה מקדימה</a>}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {snap && tab === 'audiences' && (
            <>
              <PartError part={snap.customAudiences} what="את הקהלים המותאמים" />
              {snap.customAudiences.data.map(a => (
                <div key={a.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-sm">{a.name}</span>
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-100 text-violet-800">{a.subtype === 'LOOKALIKE' ? 'קהל דומה (Lookalike)' : a.subtype === 'CUSTOM' ? 'רשימת לקוחות' : a.subtype === 'WEBSITE' ? 'מבקרי אתר' : a.subtype === 'ENGAGEMENT' ? 'מעורבות' : a.subtype}</span>
                  </div>
                  <Kv rows={[
                    ['גודל משוער', a.approximate_count_lower_bound ? `${Number(a.approximate_count_lower_bound).toLocaleString('he-IL')}–${Number(a.approximate_count_upper_bound).toLocaleString('he-IL')}` : ''],
                    ['דומה ל', a.lookalike_spec ? `${(a.lookalike_spec.origin || []).map((o: any) => o.name || o.id).join(', ')} · ${a.lookalike_spec.country || ''} · ${a.lookalike_spec.ratio != null ? `${Math.round(a.lookalike_spec.ratio * 100)}%` : ''}` : ''],
                    ['מצב', a.delivery_status?.description || a.operation_status?.description || ''],
                    ['נוצר', a.time_created ? new Date(Number(a.time_created) * 1000).toLocaleDateString('he-IL') : ''],
                    ['תיאור', a.description],
                  ]} />
                </div>
              ))}
              {snap.savedAudiences.data.length > 0 && <h4 className="font-bold text-sm text-gray-700 pt-2">קהלים שמורים</h4>}
              {snap.savedAudiences.data.map(a => (
                <div key={a.id} className="border border-gray-200 rounded-lg p-3">
                  <span className="font-bold text-sm">{a.name}</span>
                  <Kv rows={describeTargeting(a.targeting)} />
                </div>
              ))}
            </>
          )}

          {snap && tab === 'rules' && (
            <>
              <PartError part={snap.valueRuleSets} what="את כללי הערך" />
              {snap.valueRuleSets.ok && snap.valueRuleSets.data.length === 0 && <p className="text-sm text-gray-500">אין כללי ערך בחשבון (או שמטא לא מחזירה אותם לטוקן הזה).</p>}
              {snap.valueRuleSets.data.map(r => {
                const usedBy = snap.adsets.data.filter(s => String(s.value_rule_set_id) === String(r.id));
                return (
                  <div key={r.id} className="border border-gray-200 rounded-lg p-3 space-y-1">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-bold text-sm">{r.name || r.id}</span><StatusChip s={r.status} /></div>
                    <p className="text-[11px] text-gray-500">בשימוש ב-{usedBy.length} סטים{usedBy.length ? `: ${usedBy.map(s => s.name).join(', ')}` : ''}</p>
                    <pre className="text-[11px] bg-gray-50 rounded p-2 overflow-x-auto" dir="ltr">{JSON.stringify(r.rules ?? r, null, 2)}</pre>
                  </div>
                );
              })}
            </>
          )}

          {snap && tab === 'forms' && (
            <>
              <PartError part={snap.leadForms} what="את טפסי הלידים" />
              {snap.leadForms.data.map(f => (
                <div key={f.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-bold text-sm">{f.name}</span><StatusChip s={f.status} /></div>
                  <Kv rows={[
                    ['שאלות', (f.questions || []).map((q: any) => q.label || q.key || q.type).join(' · ')],
                    ['לידים', f.leads_count != null ? String(f.leads_count) : ''],
                    ['מותאם לאיכות', f.is_optimized_for_quality ? 'כן (שלב אישור נוסף)' : ''],
                    ['נוצר', fmtDate(f.created_time)],
                  ]} />
                </div>
              ))}
            </>
          )}

          {snap && tab === 'account' && (
            <div className="space-y-3">
              {snap.account.ok ? (
                <Kv rows={[
                  ['חשבון', `${snap.account.data?.name || ''} (${snap.accountId})`],
                  ['עסק', snap.account.data?.business?.name || ''],
                  ['מטבע / אזור זמן', `${CUR_HE[cur] || cur}${cur !== 'ILS' && RATE ? ` (שער היום ${RATE.toFixed(2)} ₪)` : ''} · ${snap.account.data?.timezone_name || ''}`],
                  ['הוצאה מצטברת', snap.account.data?.amount_spent != null ? money(snap.account.data.amount_spent, cur) : ''],
                  ['תקרת הוצאה', snap.account.data?.spend_cap && snap.account.data.spend_cap !== '0' ? money(snap.account.data.spend_cap, cur) : 'אין'],
                ]} />
              ) : <p className="text-xs text-red-600">{snap.account.error}</p>}
              <div className={`rounded-lg p-3 text-xs ${snap.token.canManageAds ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-900'}`}>
                {snap.token.canManageAds
                  ? '✓ לטוקן יש הרשאת ads_management - יהיה אפשר ליצור ולשנות קמפיינים בשלב הבא.'
                  : 'לטוקן אין הרשאת ads_management (רק קריאה). לשלב יצירת הקמפיינים צריך טוקן חדש עם ads_management, pages_manage_ads, leads_retrieval ו-business_management.'}
                <div className="mt-1 text-[11px] opacity-80" dir="ltr">{snap.token.permissions.join(', ') || '—'}</div>
              </div>
              <PartError part={snap.pixels} what="את הפיקסלים" />
              {snap.pixels.data.length > 0 && (
                <Kv rows={snap.pixels.data.map(p => [`פיקסל ${p.name || ''}`, `${p.id}${p.last_fired_time ? ` · אירוע אחרון ${new Date(p.last_fired_time).toLocaleString('he-IL')}` : ''}`] as [string, string])} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
