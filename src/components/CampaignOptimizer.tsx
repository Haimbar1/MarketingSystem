// "🔧 ניתוח והצעות לשיפור" on a campaign (Haim, 2026-11-19): the AI analyses the running campaign,
// suggests changes, the person ticks what to do, confirms, and only then it's executed at Meta.
// Every change is listed below with "↩ בטל". Server: server/campaignOptimizer.ts.
import React, { useEffect, useState } from 'react';
import { X, Loader2, RefreshCw, CheckCircle2, AlertTriangle, Undo2 } from 'lucide-react';
import WeeklyTrend, { Week } from './WeeklyTrend';

type M = { spend: number; leads: number; cpl: number | null; ctr?: number | null; frequency?: number; impressions?: number } | null;
type Suggestion = {
  id: string; action: string; targetType?: string; targetId?: string; targetName?: string; params?: any;
  title: string; why: string; expected?: string; risk: 'low' | 'medium' | 'high'; executable: boolean; note?: string;
  before?: any; after?: any;
};
type Crm = { leads: number; booked: number; buyers: number; revenue: number };
type CrmWin = Record<string, Crm | null> | null; // by period key (last7 / last30 / prev30)
type CrmPeriod = Crm & {
  key: string; label: string; since: string; until: string; maturity: 'early' | 'partial' | 'mature'; spendIls: number | null; fbLeads: number | null;
  campaignSpendIls?: number | null; campaignsWithSpend?: number | null; // this campaign's own spend / how many campaigns ran
};
type Analysis = {
  summary: string; health: 'good' | 'ok' | 'bad'; findings: string[]; currency: string;
  totals: { last7: any; last30: any };
  crmPeriods?: CrmPeriod[] | null; ilsRate?: number | null; crmWeeks?: Week[] | null;
  adsets: { id: string; name: string; status: string; learning: string | null; dailyBudget: number | null; m7: M; m30: M; crm?: CrmWin }[];
  ads: { id: string; adsetId: string; name: string; status: string; thumb: string | null; m7: M; m30: M; crm?: CrmWin }[];
  readErrors?: string[];
};
type Change = { id: number; object_name: string; action: string; title: string; before: any; after: any; status: string; error: string | null; done_by: string; done_at: string; undone_at: string | null; undo_of: number | null };

const HEALTH: Record<string, [string, string]> = {
  good: ['הקמפיין עובד טוב', 'bg-green-100 text-green-800'],
  ok: ['יש מה לשפר', 'bg-amber-100 text-amber-800'],
  bad: ['דורש טיפול', 'bg-red-100 text-red-800'],
};
const RISK: Record<string, [string, string]> = {
  low: ['סיכון נמוך', 'bg-green-50 text-green-700'],
  medium: ['סיכון בינוני', 'bg-amber-50 text-amber-700'],
  high: ['סיכון גבוה', 'bg-red-50 text-red-700'],
};
const ACTION_HE: Record<string, string> = {
  pause_ad: 'עצירת מודעה', activate_ad: 'הפעלת מודעה', pause_adset: 'עצירת סט', activate_adset: 'הפעלת סט',
  set_adset_daily_budget: 'תקציב יומי לסט', set_campaign_daily_budget: 'תקציב יומי לקמפיין', set_adset_age: 'טווח גילאים',
  apply_value_rule_set: 'כללי ערך למיקום', manual: 'המלצה (ביצוע ידני)',
};

// The account's currency in Hebrew words (Haim, 2026-11-19 - "USD" in a Hebrew line read backwards).
const CUR_HE: Record<string, string> = { USD: 'דולר', EUR: 'יורו', GBP: 'ליש"ט', ILS: 'ש"ח' };
const curName = (cur: string) => CUR_HE[cur] || cur;
const STATUS_HE: Record<string, string> = { ACTIVE: 'פעיל', PAUSED: 'מושהה', CAMPAIGN_PAUSED: 'הקמפיין מושהה', ADSET_PAUSED: 'הסט מושהה', ARCHIVED: 'בארכיון', WITH_ISSUES: 'עם בעיות', DISAPPROVED: 'נדחה', PENDING_REVIEW: 'בבדיקה', IN_PROCESS: 'בעיבוד' };
const statusHe = (s: string) => STATUS_HE[s] || s;
const fmt = (v: number | null | undefined, cur = '') => (v == null ? '—' : `${Number(v).toLocaleString('he-IL', { maximumFractionDigits: 2 })}${cur ? ` ${curName(cur)}` : ''}`);

let RATE: number | null = null; // today's ILS rate of the account currency, set when an analysis loads
const withIls = (v: number, cur: string) => (cur !== 'ILS' && RATE ? `${fmt(v, cur)} (≈₪${Math.round(v * RATE).toLocaleString('he-IL')})` : fmt(v, cur));

function describeChange(before: any, after: any, cur: string): string {
  if (!before || !after) return '';
  if ('status' in after) return `${before.status === 'ACTIVE' ? 'פעיל' : 'מושהה'} ← ${after.status === 'ACTIVE' ? 'פעיל' : 'מושהה'}`;
  if ('daily_budget' in after) return `${withIls(before.daily_budget / 100, cur)} ← ${withIls(after.daily_budget / 100, cur)} ליום`;
  if ('age_min' in after) return `גיל ${before.age_min}–${before.age_max} ← ${after.age_min}–${after.age_max}`;
  if ('value_rule_set_id' in after) return after.value_rule_set_id ? 'הפעלת ערכת כללי ערך' : 'הסרת כללי ערך';
  return '';
}

// What an ad set's / ad's leads did in the CRM, per period (counts only - Meta doesn't split the CRM's
// spend by ad set, so no ROAS here).
function CrmLine({ crm, periods }: { crm?: CrmWin; periods?: CrmPeriod[] | null }) {
  if (!crm || !periods) return null;
  const parts = periods.map(p => {
    const c = crm[p.key];
    if (!c) return null;
    return `${p.label}: ${c.leads} לידים · ${c.booked} תורים${p.maturity === 'early' ? '' : ` · ${c.buyers} קנו · ₪${Math.round(c.revenue).toLocaleString('he-IL')}`}`;
  }).filter(Boolean);
  if (!parts.length) return null;
  return <span className="text-emerald-800">CRM - {parts.join(' | ')}</span>;
}

// Money in shekels (the account may bill in USD - converted at today's rate), with the original amount
// on hover.
function ils(v: number | null | undefined, rate: number | null | undefined, cur: string): string {
  if (v == null) return '—';
  if (cur === 'ILS' || !rate) return cur === 'ILS' ? `₪${Math.round(v).toLocaleString('he-IL')}` : fmt(v, cur);
  return `₪${Math.round(v * rate).toLocaleString('he-IL')}`;
}

// The campaign by period, every number labelled (Haim, 2026-11-19). With the CRM: what the leads that
// came in during each period did - computed by the CRM exactly like its dashboard's ROI table (same
// leads, same spend in shekels) - and the ROAS only where it can be known: last week's leads haven't
// bought yet, the last 30 days are still coming in, 30-60 days ago is the real one.
function SummaryTable({ a }: { a: Analysis }) {
  const cur = a.currency, rate = a.ilsRate;
  const shekel = (v: number | null | undefined) => (v == null ? '—' : `₪${Math.round(v).toLocaleString('he-IL')}`);
  const per = (spend: number | null, n: number) => (spend != null && n > 0 ? shekel(spend / n) : '—');
  const th = 'px-2 py-1.5 font-bold text-gray-600 text-right whitespace-nowrap';
  const td = 'px-2 py-1.5 text-gray-800 whitespace-nowrap';
  if (a.crmPeriods?.length) {
    const roasCell = (p: CrmPeriod) => {
      if (p.maturity === 'early') return <span className="text-gray-400" title="הלידים של השבוע האחרון עוד לא הספיקו לקנות">מוקדם מדי לדעת</span>;
      if (!p.spendIls) return '—';
      const r = `${(p.revenue / p.spendIls).toFixed(1)}x`;
      return p.maturity === 'partial' ? <span title="רכישות של הלידים האלה עוד מגיעות">{r} <span className="text-gray-400">(עוד מבשיל)</span></span> : <b>{r}</b>;
    };
    const dd = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
    return (
      <div className="overflow-x-auto">
        <table className="text-xs w-full border border-gray-200 rounded-lg">
          <thead className="bg-gray-50">
            <tr>
              <th className={th}>לידי Meta שנכנסו ב…</th>
              <th className={th} title="ההוצאה של כל הקמפיינים בחשבון בתקופה, בשקלים - כמו בדשבורד של ה-CRM">הוצאה</th>
              <th className={th} title="לידים שמטא ספרה (טפסים שמולאו)">לידים במטא</th>
              <th className={`${th} bg-emerald-50`} title="כל לידי Meta שנכנסו ל-CRM בתקופה">לידים ב-CRM</th>
              <th className={`${th} bg-emerald-50`}>עלות לליד</th>
              <th className={`${th} bg-emerald-50`}>קבעו תור</th>
              <th className={`${th} bg-emerald-50`}>עלות לתור</th>
              <th className={`${th} bg-emerald-50`}>קנו</th>
              <th className={`${th} bg-emerald-50`}>הכנסה</th>
              <th className={`${th} bg-emerald-50`} title="הכנסה חלקי הוצאה">החזר (ROAS)</th>
            </tr>
          </thead>
          <tbody>
            {a.crmPeriods.map(p => (<React.Fragment key={p.key}>
              <tr className={`border-t border-gray-100 ${p.maturity === 'mature' ? 'bg-emerald-50/40' : ''}`}>
                <td className={`${td} font-bold`}>{p.label} <span className="font-normal text-gray-400">({dd(p.since)} עד {dd(p.until)})</span></td>
                <td className={td}>{shekel(p.spendIls)}</td>
                <td className={td}>{p.fbLeads ?? '—'}</td>
                <td className={td}>{p.leads}</td>
                <td className={td}>{per(p.spendIls, p.leads)}</td>
                <td className={td}>{p.booked}</td>
                <td className={td}>{per(p.spendIls, p.booked)}</td>
                <td className={td}>{p.maturity === 'early' ? <span className="text-gray-400">{p.buyers}</span> : p.buyers}</td>
                <td className={td}>{p.maturity === 'early' ? <span className="text-gray-400">{shekel(p.revenue)}</span> : shekel(p.revenue)}</td>
                <td className={td}>{roasCell(p)}</td>
              </tr>
              {p.campaignsWithSpend != null && p.campaignsWithSpend > 1 && (
                <tr className="text-gray-500">
                  <td className="px-2 pb-1.5 text-[10px] whitespace-nowrap" colSpan={10}>
                    בתקופה הזו רצו {p.campaignsWithSpend} קמפיינים - ההוצאה של הקמפיין הזה: {shekel(p.campaignSpendIls)} מתוך {shekel(p.spendIls)}
                  </td>
                </tr>
              )}
            </React.Fragment>))}
          </tbody>
        </table>
        <p className="text-[10px] text-gray-400 mt-1">
          החישוב זהה לטבלת "החזר השקעה מפייסבוק" בדשבורד של ה-CRM לאותם ימים: הלידים לפי יום הכניסה שלהם, הרכישות שלהם מאז, וההוצאה בשקלים לפי שער כל יום.
          לידים של השבוע האחרון עוד לא הספיקו לקנות - לכן אין להם החזר; ההחזר האמיתי הוא של הלידים מלפני 30–60 יום.
          כל לידי Meta של התקופה (לפי המקור, בלי קשר לשם הקמפיין) מול ההוצאה של כל הקמפיינים בחשבון - בדיוק השורה התחתונה של הדשבורד.
        </p>
      </div>
    );
  }
  // no CRM: Meta's own numbers
  const rows = [
    { label: '7 ימים אחרונים', m: a.totals.last7 },
    { label: '30 ימים אחרונים', m: a.totals.last30 },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full border border-gray-200 rounded-lg">
        <thead className="bg-gray-50">
          <tr><th className={th}></th><th className={th}>הוצאה</th><th className={th}>לידים במטא</th><th className={th}>עלות לליד</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label} className="border-t border-gray-100">
              <td className={`${td} font-bold`}>{r.label}</td>
              <td className={td} title={cur !== 'ILS' ? fmt(r.m.spend, cur) : undefined}>{ils(r.m.spend, rate, cur)}</td>
              <td className={td}>{r.m.leads}</td>
              <td className={td}>{r.m.leads ? ils(r.m.spend / r.m.leads, rate, cur) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cur !== 'ILS' && rate ? <p className="text-[10px] text-gray-400 mt-1">ההוצאה במטא היא ב{curName(cur)}, הומרה לשקלים לפי שער היום ({rate.toFixed(2)}).</p> : null}
    </div>
  );
}

function MetricsCell({ m, cur, rate }: { m: M; cur: string; rate?: number | null }) {
  if (!m) return <span className="text-gray-400">—</span>;
  return <span>הוצאה {ils(m.spend, rate, cur)} · {m.leads} לידים · {m.cpl == null ? '—' : ils(m.cpl, rate, cur)} לליד</span>;
}

export default function CampaignOptimizer({ campaign, onClose }: { campaign: { id: string; name: string }; onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [optId, setOptId] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [canExecute, setCanExecute] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [budgets, setBudgets] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [results, setResults] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [changes, setChanges] = useState<Change[]>([]);
  const [undoing, setUndoing] = useState<number | null>(null);

  const cur = analysis?.currency || '';

  const loadChanges = async () => {
    try {
      const d = await fetch(`/api/meta-ads/campaigns/${campaign.id}/changes`).then(r => r.json());
      if (d?.success) setChanges(d.changes || []);
    } catch { /* the list is secondary */ }
  };

  const analyze = async () => {
    setLoading(true); setError(''); setResults({}); setPicked({}); setConfirming(false);
    try {
      const d = await fetch(`/api/meta-ads/campaigns/${campaign.id}/analyze`, { method: 'POST' }).then(r => r.json());
      if (!d?.success) { setError(d?.error || 'הניתוח נכשל'); return; }
      RATE = d.analysis?.ilsRate || null;
      setOptId(d.optimizationId); setAnalysis(d.analysis); setSuggestions(d.suggestions || []); setCanExecute(!!d.canExecute);
      const b: Record<string, string> = {};
      (d.suggestions || []).forEach((s: Suggestion) => { if (s.params?.dailyBudget != null) b[s.id] = String(s.params.dailyBudget); });
      setBudgets(b);
    } catch (e: any) {
      setError(e?.message || 'שגיאת רשת');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { analyze(); loadChanges(); }, [campaign.id]);

  const chosen = suggestions.filter(s => s.executable && picked[s.id]);

  const execute = async () => {
    if (!optId || chosen.length === 0) return;
    setExecuting(true); setError('');
    try {
      const items = chosen.map(s => ({ suggestionId: s.id, ...(budgets[s.id] != null && s.params?.dailyBudget != null ? { dailyBudget: Number(budgets[s.id]) } : {}) }));
      const d = await fetch(`/api/meta-ads/optimizations/${optId}/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }).then(r => r.json());
      if (!d?.success) { setError(d?.error || 'הביצוע נכשל'); return; }
      const map: Record<string, any> = {};
      (d.results || []).forEach((r: any) => { map[r.suggestionId] = r; });
      setResults(map); setPicked({}); setConfirming(false);
      loadChanges();
    } catch (e: any) {
      setError(e?.message || 'שגיאת רשת');
    } finally {
      setExecuting(false);
    }
  };

  const undo = async (c: Change) => {
    if (!window.confirm(`לבטל את השינוי "${c.title}"?`)) return;
    setUndoing(c.id);
    try {
      const d = await fetch(`/api/meta-ads/changes/${c.id}/undo`, { method: 'POST' }).then(r => r.json());
      if (!d?.success) alert(d?.error || 'הביטול נכשל');
      loadChanges();
    } finally {
      setUndoing(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-2 sm:p-4" onClick={onClose} dir="rtl">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[94vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2 p-4 border-b border-gray-100">
          <div className="min-w-0">
            <h3 className="font-bold text-gray-800">🔧 ניתוח והצעות לשיפור</h3>
            <p className="text-xs text-gray-500 truncate">{campaign.name} · שום דבר לא משתנה במטא בלי האישור שלך</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={analyze} disabled={loading} title="נתח שוב" className="p-2 rounded-lg hover:bg-gray-100 text-gray-600 disabled:opacity-50">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </button>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-600"><X className="w-4 h-4" /></button>
          </div>
        </div>

        <div className="p-4 overflow-y-auto space-y-4">
          {loading && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> קורא את הקמפיין מ-Meta ומנתח… (עד דקה)</p>}
          {error && <p className="text-sm text-red-700 bg-red-50 rounded-lg p-3">{error}</p>}

          {analysis && !loading && (
            <>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded ${HEALTH[analysis.health]?.[1]}`}>{HEALTH[analysis.health]?.[0]}</span>

                </div>
                <p className="text-sm text-gray-800">{analysis.summary}</p>
                <SummaryTable a={analysis} />
                {analysis.crmWeeks?.length ? <WeeklyTrend weeks={analysis.crmWeeks} /> : null}
                {!analysis.crmPeriods && (
                  <p className="text-[11px] text-gray-500">אין נתוני CRM לקמפיין הזה (אין CRM לעסק, או שהלידים לא שויכו לקמפיין) - הניתוח לפי נתוני מטא בלבד.</p>
                )}
                {analysis.findings.length > 0 && (
                  <ul className="list-disc pr-5 text-sm text-gray-700 space-y-0.5">{analysis.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>
                )}
                {analysis.readErrors?.length ? <p className="text-[11px] text-amber-700">חלק מהנתונים לא נקראו: {analysis.readErrors.join(' · ')}</p> : null}
              </div>

              <details className="text-xs">
                <summary className="cursor-pointer text-gray-600 font-bold">הנתונים לפי סט ומודעה</summary>
                <div className="mt-2 space-y-2">
                  {analysis.adsets.map(s => (
                    <div key={s.id} className="bg-gray-50 rounded-lg p-2">
                      <div className="font-bold text-gray-800">{s.name} <span className="font-normal text-gray-500">· {statusHe(s.status)}{s.learning ? ` · למידה: ${s.learning}` : ''}{s.dailyBudget != null ? ` · ${withIls(s.dailyBudget, cur)} ליום` : ''}</span></div>
                      <div className="text-gray-600">7 ימים אחרונים: <MetricsCell m={s.m7} cur={cur} rate={analysis.ilsRate} /> · 30 ימים אחרונים: <MetricsCell m={s.m30} cur={cur} rate={analysis.ilsRate} /></div>
                      {s.crm && <div><CrmLine crm={s.crm} periods={analysis.crmPeriods} /></div>}
                      {analysis.ads.filter(a => a.adsetId === s.id).map(a => (
                        <div key={a.id} className="flex items-center gap-2 mt-1 pr-3">
                          {a.thumb && <img src={a.thumb} alt="" className="w-7 h-7 rounded object-cover" loading="lazy" />}
                          <span className="text-gray-700 truncate">{a.name}</span>
                          <span className="text-gray-500 shrink-0">· 7 ימים אחרונים: <MetricsCell m={a.m7} cur={cur} rate={analysis.ilsRate} /></span>
                          {a.crm && <span className="shrink-0">· <CrmLine crm={a.crm} periods={analysis.crmPeriods} /></span>}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </details>

              <div className="space-y-2">
                <h4 className="font-bold text-sm text-gray-800">ההצעות ({suggestions.length})</h4>
                {suggestions.length === 0 && <p className="text-sm text-gray-500">אין הצעות לשינוי כרגע.</p>}
                {suggestions.map(s => {
                  const res = results[s.id];
                  return (
                    <label key={s.id} className={`block border rounded-xl p-3 ${picked[s.id] ? 'border-blue-400 bg-blue-50/40' : 'border-gray-200'} ${s.executable ? 'cursor-pointer' : ''}`}>
                      <div className="flex items-start gap-2">
                        {s.executable && canExecute && !res?.ok ? (
                          <input type="checkbox" className="mt-1" checked={!!picked[s.id]} onChange={e => setPicked(p => ({ ...p, [s.id]: e.target.checked }))} />
                        ) : <span className="w-4" />}
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-bold text-sm text-gray-800">{s.title}</span>
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">{ACTION_HE[s.action] || s.action}</span>
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${RISK[s.risk]?.[1]}`}>{RISK[s.risk]?.[0]}</span>
                          </div>
                          {s.targetName && <p className="text-xs text-gray-600">על: {s.targetName}{s.executable ? ` · ${describeChange(s.before, s.after, cur)}` : ''}</p>}
                          <p className="text-xs text-gray-700">{s.why}</p>
                          {s.expected && <p className="text-xs text-gray-500">צפוי: {s.expected}</p>}
                          {s.note && <p className="text-[11px] text-amber-700">{s.note}</p>}
                          {s.executable && s.params?.dailyBudget != null && picked[s.id] && (
                            <div className="flex items-center gap-2 text-xs" onClick={e => e.preventDefault()}>
                              <span>תקציב יומי חדש:</span>
                              <input type="number" min={0} step="0.5" value={budgets[s.id] ?? ''} onChange={e => setBudgets(b => ({ ...b, [s.id]: e.target.value }))}
                                className="w-24 border border-gray-300 rounded px-2 py-1" />
                              <span>{curName(cur)}{cur !== 'ILS' && analysis.ilsRate && budgets[s.id] ? ` (≈₪${Math.round(Number(budgets[s.id]) * analysis.ilsRate).toLocaleString('he-IL')})` : ''}</span>
                            </div>
                          )}
                          {res && (
                            <p className={`text-xs font-bold flex items-center gap-1 ${res.ok ? 'text-green-700' : 'text-red-700'}`}>
                              {res.ok ? <><CheckCircle2 className="w-3.5 h-3.5" /> בוצע במטא</> : <><AlertTriangle className="w-3.5 h-3.5" /> {res.error}</>}
                            </p>
                          )}
                        </div>
                      </div>
                    </label>
                  );
                })}
                {!canExecute && suggestions.some(s => s.executable) && (
                  <p className="text-xs text-amber-800 bg-amber-50 rounded-lg p-2">כדי לבצע שינויים מכאן צריך מסד נתונים (DATABASE_URL ב-Vercel של מערכת השיווק) - כל שינוי נשמר עם אפשרות ביטול.</p>
                )}
              </div>

              {canExecute && chosen.length > 0 && !confirming && (
                <button onClick={() => setConfirming(true)} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl py-2.5">
                  ✅ לאשר ולבצע {chosen.length} שינויים
                </button>
              )}
              {confirming && (
                <div className="border-2 border-blue-400 rounded-xl p-3 space-y-2 bg-blue-50">
                  <p className="font-bold text-sm text-gray-800">לבצע עכשיו בקמפיין החי?</p>
                  <ul className="text-xs text-gray-700 list-disc pr-5 space-y-0.5">
                    {chosen.map(s => (
                      <li key={s.id}>{s.title} - {s.targetName}{s.params?.dailyBudget != null ? ` (${withIls(Number(budgets[s.id]), cur)} ליום)` : ` (${describeChange(s.before, s.after, cur)})`}</li>
                    ))}
                  </ul>
                  <div className="flex gap-2">
                    <button onClick={execute} disabled={executing} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg py-2 disabled:opacity-60">
                      {executing ? 'מבצע…' : 'כן, לבצע'}
                    </button>
                    <button onClick={() => setConfirming(false)} disabled={executing} className="flex-1 bg-white border border-gray-300 rounded-lg py-2 font-bold text-gray-700">ביטול</button>
                  </div>
                </div>
              )}
            </>
          )}

          {changes.length > 0 && (
            <div className="space-y-1.5 pt-2 border-t border-gray-100">
              <h4 className="font-bold text-sm text-gray-800">שינויים שבוצעו בקמפיין</h4>
              {changes.map(c => (
                <div key={c.id} className="flex items-start gap-2 text-xs bg-gray-50 rounded-lg p-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-gray-800">{c.title} <span className="font-normal text-gray-500">· {c.object_name}</span></div>
                    <div className="text-gray-600">
                      {describeChange(c.before, c.after, cur)} · {new Date(c.done_at).toLocaleString('he-IL')} · {c.done_by}
                      {c.status === 'failed' && <span className="text-red-700"> · נכשל: {c.error}</span>}
                      {c.undone_at && <span className="text-gray-500"> · בוטל</span>}
                    </div>
                  </div>
                  {c.status === 'done' && !c.undone_at && !c.undo_of && (
                    <button onClick={() => undo(c)} disabled={undoing === c.id} className="shrink-0 flex items-center gap-1 text-gray-700 border border-gray-300 rounded-lg px-2 py-1 hover:bg-white disabled:opacity-50">
                      <Undo2 className="w-3.5 h-3.5" /> בטל
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
