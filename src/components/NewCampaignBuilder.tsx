// "✨ קמפיין חדש מהוראה" (Haim, 2026-11-20 - step 3): a conversation first - write what you want, נועם
// answers what he understood and asks about what's unclear, until "✅ בנה טיוטה" (Haim: "first show what
// you understood until the client approves - every build takes time"; server/campaignChat.ts) → the
// draft (name, budget, places, age, gender, texts) → review / edit, optionally new pictures / videos, or
// send it to the approvers on WhatsApp → "אשר והעלה" creates it in Meta PAUSED → "▶️ להפעיל את הקמפיין".
// Server: server/campaignBuilder.ts. In the page, not a pop-up.
import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Loader2, X, Plus } from 'lucide-react';
import { uploadMedia, UploadedMedia } from '../utils/mediaUpload';

type Place = { key: string; name: string; type: 'city' | 'region' | 'country'; region?: string; radiusKm?: number | null };
type Draft = {
  name: string; dailyBudgetIls: number; places: Place[] | null; ageMin: number | null; ageMax: number | null;
  genders: 'all' | 'female' | 'male' | null; advantageAudience: boolean | null;
  texts: { bodies: string[]; titles: string[]; descriptions: string[] };
  media: { type: 'video' | 'image'; id?: string; hash?: string; thumb?: string; name?: string }[];
  kind?: 'whatsapp' | 'lead_form' | null;
  explanation?: string;
};
type Ctx = {
  baseName: string; baseAdsetName: string; objective: string; cbo: boolean; currency: string; rate: number | null;
  baseDailyIls: number | null; minDailyIls: number | null; bestLeads30: number; baseAdvantage: boolean;
  baseTargeting: any; kind?: string; baseAds: { id: string; name: string; bodies: string[]; titles: string[] }[]; optimizationGoal: string; valueRuleSet: string | null;
};
type Base = { id: string; name: string; status: string; spend30: number; leads30: number; kind?: string };

const TYPE_HE: Record<string, string> = { city: 'עיר', region: 'אזור', country: 'מדינה' };
const KIND_HE: Record<string, string> = { lead_form: '📋 טופס לידים', whatsapp: '💬 וואטסאפ', website: '🌐 אתר', messenger: '💬 מסנג׳ר', other: 'אחר' };
const OBJ_HE: Record<string, string> = { OUTCOME_LEADS: 'לידים', OUTCOME_SALES: 'מכירות', OUTCOME_TRAFFIC: 'תנועה', OUTCOME_ENGAGEMENT: 'מעורבות', OUTCOME_AWARENESS: 'מודעות' };

export default function NewCampaignBuilder({ onBack }: { onBack: () => void }) {
  const [bases, setBases] = useState<Base[] | null>(null);
  const [baseId, setBaseId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [briefId, setBriefId] = useState<number | null>(null);
  const [chat, setChat] = useState<{ role: 'owner' | 'bot'; text: string }[]>([]);
  const [ready, setReady] = useState(false);
  const chatBox = useRef<HTMLDivElement>(null);
  const [approvers, setApprovers] = useState<{ name: string; phone: string }[]>([]);
  const [newApprover, setNewApprover] = useState({ name: '', phone: '' });
  const [waResult, setWaResult] = useState('');
  const [busy, setBusy] = useState<'' | 'talk' | 'draft' | 'save' | 'publish' | 'upload' | 'activate' | 'wa'>('');
  useEffect(() => { const el = chatBox.current; if (el) el.scrollTop = el.scrollHeight; }, [chat.length, busy]);
  const [error, setError] = useState('');
  const [draftId, setDraftId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [placeQ, setPlaceQ] = useState('');
  const [placeHits, setPlaceHits] = useState<Place[]>([]);
  const [uploadPct, setUploadPct] = useState('');
  const [result, setResult] = useState<any>(null);
  const [activated, setActivated] = useState(false);
  const [saved, setSaved] = useState<{ briefs: any[]; drafts: any[]; published: any[] } | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    fetch('/api/meta-ads/builder/bases').then(r => r.json()).then(d => {
      if (d?.success) { setBases(d.campaigns); if (d.campaigns[0]) setBaseId(d.campaigns[0].id); }
      else setError(d?.error || 'לא הצלחנו לקרוא את הקמפיינים');
    }).catch(() => setError('שגיאת רשת'));
  }, []);

  useEffect(() => {
    fetch('/api/meta-ads/wa-approval/settings').then(r => r.json()).then(d => { if (d?.success) setApprovers(d.approvers || []); }).catch(() => {});
  }, []);

  // one turn of the conversation - nothing is built yet
  const talk = async () => {
    const text = instruction.trim();
    if (!text) return;
    setBusy('talk'); setError('');
    setChat(c => [...c, { role: 'owner', text }]);
    setInstruction('');
    try {
      const d = await fetch('/api/meta-ads/briefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ briefId, text, baseCampaignId: briefId ? undefined : baseId }) }).then(r => r.json());
      if (!d?.success) { setError(d?.error || 'נועם לא ענה'); setChat(c => c.slice(0, -1)); setInstruction(text); return; }
      setBriefId(d.briefId);
      if (d.cancel) { setChat([]); setBriefId(null); setReady(false); return; }
      if (d.build && d.ready !== false) { setReady(true); setBusy(''); await makeDraft(d.briefId); return; }
      setChat(c => [...c, { role: 'bot', text: d.reply || '' }]);
      setReady(!!d.ready);
    } catch (e: any) { setError(e?.message || 'שגיאת רשת'); } finally { setBusy(b => (b === 'talk' ? '' : b)); }
  };
  const restart = () => { setChat([]); setBriefId(null); setReady(false); setDraft(null); setDraftId(null); setCtx(null); setResult(null); setActivated(false); setError(''); setWaResult(''); };

  // "📂 שמורות" - everything is kept as it goes; this is what isn't finished (Haim, 2026-11-20)
  const loadSaved = () => fetch('/api/meta-ads/saved').then(r => r.json()).then(d => { if (d?.success) setSaved(d); }).catch(() => {});
  useEffect(() => { loadSaved(); }, []);
  const saveForLater = () => { restart(); setNotice('💾 נשמר. אפשר לחזור לזה מתי שתרצו מ"📂 שמורות" כאן למטה.'); loadSaved(); };
  const resumeDraft = async (id: number) => {
    setError(''); setNotice('');
    const d = await fetch(`/api/meta-ads/drafts/${id}`).then(r => r.json()).catch(() => null);
    if (!d?.success) { setError(d?.error || 'לא הצלחנו לפתוח את הטיוטה'); return; }
    setDraftId(d.id); setDraft(d.draft); setCtx(d.context); setProblems(d.problems || []); setUnmatched([]);
    if (d.status === 'published' && d.published) setResult({ ...d.published, name: d.draft?.name, ads: d.published.ads || [] });
  };
  const resumeBrief = async (id: number) => {
    setError(''); setNotice('');
    const d = await fetch(`/api/meta-ads/briefs/${id}`).then(r => r.json()).catch(() => null);
    if (!d?.success) { setError(d?.error || 'לא הצלחנו לפתוח את השיחה'); return; }
    setBriefId(d.id); setChat((d.messages || []).map((m: any) => ({ role: m.role, text: m.text }))); setReady(!!d.ready);
    if (d.baseCampaignId) setBaseId(String(d.baseCampaignId));
    if (d.draftId) await resumeDraft(d.draftId);
  };
  const removeSaved = async (kind: 'briefs' | 'drafts', id: number) => {
    if (!window.confirm(kind === 'briefs' ? 'למחוק את השיחה הזו?' : 'למחוק את הטיוטה הזו? (שום דבר במטא לא משתנה)')) return;
    await fetch(`/api/meta-ads/${kind}/${id}`, { method: 'DELETE' }).catch(() => {});
    loadSaved();
  };
  const retryAds = async () => {
    if (!draftId) return;
    setBusy('publish'); setError('');
    const d = await fetch(`/api/meta-ads/drafts/${draftId}/retry-ads`, { method: 'POST' }).then(r => r.json()).catch(() => ({ success: false, error: 'שגיאת רשת' }));
    setBusy('');
    if (d?.ads) setResult((r: any) => ({ ...(r || {}), ...d }));
    if (!d?.success) setError(d?.error || 'הניסיון נכשל');
  };
  const deletePublished = async (p: any) => {
    if (!window.confirm(`למחוק את הקמפיין "${p.name}" במטא, כולל הסטים והמודעות שבו?\n\nהמחיקה סופית - אי אפשר לשחזר.`)) return;
    const d = await fetch('/api/meta-ads/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'campaign', id: p.campaignId }) }).then(r => r.json()).catch(() => ({ success: false, error: 'שגיאת רשת' }));
    if (d?.success) { setNotice(`🗑️ הקמפיין "${p.name}" נמחק.`); setSaved(sv => (sv ? { ...sv, published: sv.published.filter((x: any) => x.campaignId !== p.campaignId) } : sv)); loadSaved(); } else setError(d?.error || 'המחיקה נכשלה');
  };
  const activateSaved = async (p: any) => {
    if (!window.confirm(`להפעיל עכשיו את הקמפיין "${p.name}"? מרגע זה מטא תתחיל להוציא את התקציב${p.dailyBudgetIls ? ` (₪${p.dailyBudgetIls} ליום)` : ''}.`)) return;
    setBusy('activate'); setError('');
    const d = await fetch(`/api/meta-ads/campaigns/${p.campaignId}/manual-change`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'activate_campaign', targetId: p.campaignId, params: {}, title: 'הפעלת קמפיין חדש' }) }).then(r => r.json()).catch(() => ({ success: false, error: 'שגיאת רשת' }));
    setBusy('');
    if (d?.success) { setNotice(`▶️ הקמפיין "${p.name}" הופעל.`); loadSaved(); } else setError(d?.error || 'ההפעלה נכשלה');
  };

  const saveApprovers = async (list: { name: string; phone: string }[]) => {
    const d = await fetch('/api/meta-ads/wa-approval/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvers: list }) }).then(r => r.json()).catch(() => null);
    if (d?.success) setApprovers(d.approvers || []); else setError(d?.error || 'השמירה נכשלה');
  };
  const sendApproval = async () => {
    if (!draftId) return;
    setBusy('wa'); setWaResult(''); setError('');
    const d = await fetch(`/api/meta-ads/drafts/${draftId}/send-approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json()).catch(() => ({ success: false, error: 'שגיאת רשת' }));
    setBusy('');
    if (d?.results) setWaResult(d.results.map((r: any) => `${r.name || r.phone}: ${r.ok ? (r.via === 'template' ? '✓ נשלחה התראה (יראה את הטיוטה כשיענה)' : '✓ נשלח') : `✗ ${r.error}`}`).join(' · '));
    else setError(d?.error || 'השליחה נכשלה');
  };

  const makeDraft = async (fromBrief?: number) => {
    const bid = fromBrief || briefId;
    if (!bid) return;
    setBusy('draft'); setError(''); setResult(null);
    try {
      const d = await fetch(`/api/meta-ads/briefs/${bid}/build`, { method: 'POST' }).then(r => r.json());
      if (!d?.success) { setError(d?.error || 'כתיבת הטיוטה נכשלה'); return; }
      setDraftId(d.id); setDraft(d.draft); setCtx(d.context); setProblems(d.problems || []); setUnmatched(d.unmatchedPlaces || []);
    } catch (e: any) { setError(e?.message || 'שגיאת רשת'); } finally { setBusy(''); }
  };

  const save = async (next: Draft) => {
    setDraft(next);
    if (!draftId) return;
    const d = await fetch(`/api/meta-ads/drafts/${draftId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: next }) }).then(r => r.json()).catch(() => null);
    if (d?.success) setProblems(d.problems || []);
  };
  const patch = (p: Partial<Draft>) => draft && save({ ...draft, ...p });
  const setText = (kind: 'bodies' | 'titles' | 'descriptions', i: number, v: string) => {
    if (!draft) return;
    const list = [...draft.texts[kind]]; list[i] = v;
    setDraft({ ...draft, texts: { ...draft.texts, [kind]: list } });
  };
  const commitTexts = () => draft && save({ ...draft, texts: { bodies: draft.texts.bodies.filter(s => s.trim()), titles: draft.texts.titles.filter(s => s.trim()), descriptions: draft.texts.descriptions.filter(s => s.trim()) } });

  const searchPlace = async (q: string) => {
    setPlaceQ(q);
    if (q.trim().length < 2) { setPlaceHits([]); return; }
    const d = await fetch(`/api/meta-ads/geo-search?q=${encodeURIComponent(q)}`).then(r => r.json()).catch(() => null);
    setPlaceHits(d?.places || []);
  };

  const addMedia = async (file: File | null) => {
    if (!file || !draft) return;
    setBusy('upload'); setError('');
    try {
      const m: UploadedMedia = await uploadMedia(file, (pct, st) => setUploadPct(st === 'processing' ? 'מטא מעבדת את הסרטון…' : `מעלה… ${pct}%`));
      await save({ ...draft, media: [...draft.media, m.type === 'image' ? { type: 'image', hash: m.hash, thumb: m.thumb, name: m.name } : { type: 'video', id: m.id, thumb: m.thumb, name: m.name }] });
    } catch (e: any) { setError(e?.message || 'ההעלאה נכשלה'); } finally { setBusy(''); setUploadPct(''); }
  };

  const publish = async () => {
    if (!draft || !draftId) return;
    if (!window.confirm(`להעלות למטא את הקמפיין "${draft.name}"?\n\nהוא ייווצר מושהה - שום כסף לא יוצא עד שתלחצו "▶️ להפעיל את הקמפיין".`)) return;
    setBusy('publish'); setError('');
    try {
      const d = await fetch(`/api/meta-ads/drafts/${draftId}/publish`, { method: 'POST' }).then(r => r.json());
      if (!d?.success) { setError(d?.error || 'ההעלאה נכשלה'); return; }
      setResult(d);
    } catch (e: any) { setError(e?.message || 'שגיאת רשת'); } finally { setBusy(''); }
  };

  const activate = async () => {
    if (!result?.campaignId) return;
    if (!window.confirm(`להפעיל עכשיו את הקמפיין "${result.name}"? מרגע זה מטא תתחיל להוציא את התקציב (₪${draft?.dailyBudgetIls} ליום).`)) return;
    setBusy('activate'); setError('');
    const d = await fetch(`/api/meta-ads/campaigns/${result.campaignId}/manual-change`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'activate_campaign', targetId: result.campaignId, params: {}, title: 'הפעלת קמפיין חדש' }) }).then(r => r.json()).catch(() => ({ success: false, error: 'שגיאת רשת' }));
    setBusy('');
    if (d?.success) setActivated(true); else setError(d?.error || 'ההפעלה נכשלה');
  };

  const btn = 'inline-flex items-center gap-1 border border-gray-300 rounded-lg px-2 py-1 hover:bg-white disabled:opacity-50';
  const input = 'border border-gray-300 rounded px-2 py-1';
  const bt = ctx?.baseTargeting || {};

  return (
    <div dir="rtl" className="space-y-3">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-gray-700 hover:text-gray-900"><ArrowRight className="w-4 h-4" /> כל הקמפיינים</button>
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4 text-sm">
        <div>
          <h3 className="font-bold text-gray-800">✨ קמפיין חדש מהוראה</h3>
          <p className="text-xs text-gray-500">כותבים מה רוצים - נועם מסכם מה הבין ושואל מה שלא ברור, ורק אחרי שתאשרו בונה טיוטה על בסיס קמפיין שעבד. אפשר לאשר גם בוואטסאפ. הקמפיין עולה למטא מושהה.</p>
        </div>

        {/* 1. the conversation - what was understood, questions, and only then the build */}
        {!result && !draft && (
          <div className="space-y-2">
            {chat.length === 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-gray-600">על בסיס הקמפיין:</span>
                {bases ? (
                  <select value={baseId} onChange={e => setBaseId(e.target.value)} disabled={!!busy} className={`${input} max-w-full`}>
                    {bases.map(b => <option key={b.id} value={b.id}>{b.name} · {KIND_HE[b.kind || ''] || ''} · {b.leads30} לידים ב-30 יום</option>)}
                  </select>
                ) : <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              </div>
            )}
            {chat.length > 0 && (
              <div ref={chatBox} className="space-y-2 bg-gray-50 rounded-xl p-2 max-h-[28rem] overflow-y-auto">
                {chat.map((m, i) => (
                  <div key={i} className={`flex ${m.role === 'owner' ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${m.role === 'owner' ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-800'}`}>
                      {m.role === 'bot' && <div className="text-[10px] text-gray-400 mb-0.5">נועם</div>}
                      {richText(m.text)}
                    </div>
                  </div>
                ))}
                {busy === 'talk' && <div className="flex justify-end"><div className="bg-white border border-gray-200 rounded-xl px-3 py-2 text-xs text-gray-500 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> נועם חושב…</div></div>}
              </div>
            )}
            {ready && busy !== 'draft' && (
              <button onClick={() => makeDraft()} disabled={!!busy} className="w-full bg-[#075E54] text-white font-bold rounded-xl py-2.5 disabled:opacity-50">✅ כן, זה מה שאני רוצה — בנה טיוטה</button>
            )}
            <textarea value={instruction} onChange={e => setInstruction(e.target.value)} rows={chat.length ? 2 : 3} disabled={!!busy}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) talk(); }}
              placeholder={chat.length ? (ready ? 'או כתבו מה לתקן…' : 'התשובה שלכם…') : 'למשל: "קמפיין לידים לחיפה והקריות, 60 ש"ח ליום, גילאי 35+, להדגיש בדיקת ראייה חינם"'}
              className="w-full border border-gray-300 rounded-lg p-2" />
            <div className="flex items-center gap-2 text-xs">
              <button onClick={talk} disabled={!instruction.trim() || !baseId || !!busy} className="bg-blue-600 text-white font-bold rounded-lg px-4 py-1.5 disabled:opacity-50">{chat.length ? 'שלח' : 'התחל'}</button>
              {chat.length > 0 && <button onClick={saveForLater} disabled={!!busy} className={btn}>💾 שמור והמשך אחר כך</button>}
              {chat.length > 0 && <button onClick={restart} disabled={!!busy} className="text-gray-500 underline">להתחיל מחדש</button>}
              <span className="text-gray-400">נועם יסכם מה הבין וישאל מה שלא ברור - שום דבר לא נבנה עד שתאשרו.</span>
            </div>
            {busy === 'draft' && <p className="text-xs text-gray-500 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> בונה את הטיוטה לפי מה שסיכמנו… (עד דקה)</p>}
            {notice && <p className="text-xs text-green-800 bg-green-50 rounded-lg p-2">{notice}</p>}
            {chat.length === 0 && saved && (saved.briefs.length + saved.drafts.length + saved.published.length > 0) && (
              <div className="space-y-1.5 border-t border-gray-100 pt-3 text-xs">
                <div className="font-bold text-gray-700">📂 שמורות - להמשיך מאיפה שהפסקתם</div>
                {saved.published.map(p => (
                  <div key={`p${p.draftId}`} className="flex flex-wrap items-center justify-between gap-2 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                    <span>⏸️ <b>{p.name}</b> · הועלה למטא ומושהה{p.dailyBudgetIls ? ` · ₪${p.dailyBudgetIls} ליום` : ''}</span>
                    <span className="flex gap-1">
                      <button onClick={() => resumeDraft(p.draftId)} disabled={!!busy} className={btn}>פתח</button>
                      <button onClick={() => activateSaved(p)} disabled={!!busy} className="bg-green-600 hover:bg-green-700 text-white font-bold rounded-lg px-2 py-1 disabled:opacity-50">▶️ להפעיל</button>
                      <button onClick={() => deletePublished(p)} disabled={!!busy} className={btn} title="מחק את הקמפיין במטא">🗑️</button>
                    </span>
                  </div>
                ))}
                {saved.drafts.map(d => (
                  <div key={`d${d.id}`} className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5">
                    <span>📝 <b>{d.name}</b> · טיוטה שלא הועלתה{d.dailyBudgetIls ? ` · ₪${d.dailyBudgetIls} ליום` : ''} · {fmtWhen(d.createdAt)}</span>
                    <span className="flex gap-1"><button onClick={() => resumeDraft(d.id)} className={btn}>פתח</button><button onClick={() => removeSaved('drafts', d.id)} className={btn} title="מחק">🗑️</button></span>
                  </div>
                ))}
                {saved.briefs.map(b => (
                  <div key={`b${b.id}`} className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5">
                    <span className="min-w-0">💬 {b.channel === 'whatsapp' ? '(וואטסאפ) ' : ''}"{b.title}"{b.ready ? ' · מוכן לבנייה' : ' · באמצע שיחה'} · {fmtWhen(b.updatedAt)}</span>
                    <span className="flex gap-1"><button onClick={() => resumeBrief(b.id)} className={btn}>המשך</button><button onClick={() => removeSaved('briefs', b.id)} className={btn} title="מחק">🗑️</button></span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {error && <p className="text-xs text-red-700 bg-red-50 rounded-lg p-2">{error}</p>}

        {/* 2. the draft */}
        {draft && ctx && !result && (
          <div className="space-y-3 border-t border-gray-100 pt-3">
            {draft.explanation && <p className="text-xs text-gray-700 bg-gray-50 rounded-lg p-2">🤖 {draft.explanation}</p>}
            <p className="text-[11px] text-gray-500">
              מבוסס על "{ctx.baseName}" ← הסט "{ctx.baseAdsetName}" ({ctx.bestLeads30} לידים ב-30 יום): מטרה {OBJ_HE[ctx.objective] || ctx.objective}, אותו טופס / אופטימיזציה, אותם מיקומי מודעה{ctx.valueRuleSet ? ', אותם כללי ערך למיקום' : ''}, אותם קהלים ותחומי עניין. משתנה רק מה שמופיע כאן.
            </p>

            <div className="flex flex-wrap items-center gap-2 text-xs bg-blue-50 border border-blue-200 rounded-lg p-2">
              <span className="font-bold text-gray-700">לאן המודעה מובילה:</span>
              <select value={draft.kind && draft.kind !== ctx.kind ? draft.kind : ''} onChange={e => patch({ kind: (e.target.value || null) as any })} className={input}>
                <option value="">{KIND_HE[ctx.kind || ''] || 'כמו בבסיס'} (כמו בקמפיין הבסיס)</option>
                {ctx.kind !== 'whatsapp' && <option value="whatsapp">💬 וואטסאפ - שיחה עם הבוט במספר של העסק</option>}
              </select>
              {draft.kind === 'whatsapp' && ctx.kind !== 'whatsapp' && <span className="text-amber-700">המודעות יובילו לשיחה בוואטסאפ במקום ל{KIND_HE[ctx.kind || ''] || 'מה שבבסיס'}. זה הקמפיין הראשון שנבנה כך - נבדוק אותו בהעלאה.</span>}
            </div>
            <div className="grid sm:grid-cols-2 gap-2 text-xs">
              <label className="space-y-0.5"><span className="text-gray-600">שם הקמפיין</span>
                <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} onBlur={() => save(draft)} className={`${input} w-full`} /></label>
              <label className="space-y-0.5"><span className="text-gray-600">תקציב יומי (₪){ctx.cbo ? ' - לקמפיין' : ' - לסט'}{ctx.baseDailyIls ? ` · בבסיס ₪${ctx.baseDailyIls}` : ''}</span>
                <input type="number" min={1} value={draft.dailyBudgetIls} onChange={e => setDraft({ ...draft, dailyBudgetIls: Number(e.target.value) })} onBlur={() => save(draft)} className={`${input} w-full`} />
                {ctx.currency !== 'ILS' && ctx.rate ? <span className="text-gray-400">≈ {(draft.dailyBudgetIls / ctx.rate).toFixed(2)} {ctx.currency === 'USD' ? 'דולר' : ctx.currency}</span> : null}</label>
            </div>

            {/* audience */}
            <div className="space-y-1.5 text-xs bg-gray-50 rounded-lg p-2">
              <div className="font-bold text-gray-700">קהל</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-gray-600">מיקום:</span>
                {draft.places ? draft.places.map((p, i) => (
                  <span key={p.key} className="inline-flex items-center gap-1 bg-white border border-gray-300 rounded-full px-2 py-0.5">
                    {p.name}{p.region ? `, ${p.region}` : ''} <span className="text-gray-400">({TYPE_HE[p.type]})</span>
                    {p.type === 'city' && (
                      <select value={p.radiusKm ?? ''} onChange={e => { const places = [...draft.places!]; places[i] = { ...p, radiusKm: e.target.value ? Number(e.target.value) : null }; patch({ places }); }} className="border-0 bg-transparent">
                        <option value="">העיר בלבד</option>{[17, 25, 40, 60, 80].map(k => <option key={k} value={k}>+{k} ק"מ</option>)}
                      </select>
                    )}
                    <button onClick={() => { const places = draft.places!.filter((_, j) => j !== i); patch({ places: places.length ? places : null }); }}><X className="w-3 h-3" /></button>
                  </span>
                )) : <span className="text-gray-700">כמו בבסיס ({(bt.places || []).join(' · ') || '—'})</span>}
                <input value={placeQ} onChange={e => searchPlace(e.target.value)} placeholder="+ הוספת עיר / אזור" className={`${input} w-36`} />
              </div>
              {placeHits.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {placeHits.map(h => (
                    <button key={h.key} onClick={() => { patch({ places: [...(draft.places || []).filter(p => p.key !== h.key), { ...h, radiusKm: null }] }); setPlaceQ(''); setPlaceHits([]); }}
                      className="inline-flex items-center gap-1 border border-blue-300 text-blue-800 rounded-full px-2 py-0.5 bg-white"><Plus className="w-3 h-3" />{h.name}{h.region ? `, ${h.region}` : ''} ({TYPE_HE[h.type]})</button>
                  ))}
                </div>
              )}
              {unmatched.length > 0 && <p className="text-amber-700">לא נמצאו במטא: {unmatched.join(', ')} - הוסיפו ידנית.</p>}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-gray-600">גיל:</span>
                <input type="number" min={18} max={65} value={draft.ageMin ?? ''} placeholder={String(bt.age?.split('-')[0] || 18)} onChange={e => setDraft({ ...draft, ageMin: e.target.value ? Number(e.target.value) : null })} onBlur={() => save(draft)} className={`${input} w-16`} />
                <span>עד</span>
                <input type="number" min={18} max={65} value={draft.ageMax ?? ''} placeholder={String(bt.age?.split('-')[1] || 65)} onChange={e => setDraft({ ...draft, ageMax: e.target.value ? Number(e.target.value) : null })} onBlur={() => save(draft)} className={`${input} w-16`} />
                <span className="text-gray-600 mr-2">מגדר:</span>
                <select value={draft.genders ?? ''} onChange={e => patch({ genders: (e.target.value || null) as any })} className={input}>
                  <option value="">כמו בבסיס</option><option value="all">כולם</option><option value="female">נשים</option><option value="male">גברים</option>
                </select>
                <label className="flex items-center gap-1 mr-2"><input type="checkbox" checked={draft.advantageAudience ?? ctx.baseAdvantage} onChange={e => patch({ advantageAudience: e.target.checked })} /> Advantage+ קהל</label>
              </div>
            </div>

            {/* texts */}
            <div className="space-y-1.5 text-xs">
              <div className="font-bold text-gray-700">טקסטים {ctx.baseAds.some(a => a.bodies.length > 1) ? '(מודעה גמישה - מטא תבחר את הטוב)' : '(במודעה רגילה נכנס הראשון)'}</div>
              {draft.texts.bodies.map((t, i) => (
                <textarea key={`b${i}`} value={t} rows={3} onChange={e => setText('bodies', i, e.target.value)} onBlur={commitTexts} className="w-full border border-gray-300 rounded p-1.5" placeholder={`טקסט ${i + 1}`} />
              ))}
              <div className="grid sm:grid-cols-3 gap-1.5">
                {draft.texts.titles.map((t, i) => (
                  <input key={`t${i}`} value={t} onChange={e => setText('titles', i, e.target.value)} onBlur={commitTexts} className={input} placeholder={`כותרת ${i + 1}`} />
                ))}
              </div>
            </div>

            {/* media */}
            <div className="space-y-1.5 text-xs bg-gray-50 rounded-lg p-2">
              <div className="font-bold text-gray-700">מדיה</div>
              {draft.media.length === 0 ? (
                <p className="text-gray-600">המודעות ייווצרו עם התמונות / הסרטונים של המודעות בקמפיין הבסיס ({ctx.baseAds.map(a => a.name).join(', ') || '—'}). אפשר להעלות חדשים במקומם:</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {draft.media.map((m, i) => (
                    <div key={i} className="relative">
                      {m.thumb ? <img src={m.thumb} alt="" className="w-16 h-16 rounded object-cover" /> : <div className="w-16 h-16 rounded bg-gray-200 flex items-center justify-center">{m.type === 'video' ? '🎬' : '🖼️'}</div>}
                      <span className="absolute bottom-0 right-0 text-[10px] bg-black/60 text-white px-1 rounded">{m.type === 'video' ? '🎬' : '🖼️'}</span>
                      <button onClick={() => patch({ media: draft.media.filter((_, j) => j !== i) })} className="absolute -top-1 -left-1 bg-white rounded-full border border-gray-300"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              )}
              <label className={`inline-flex items-center gap-1 bg-white border-2 border-dashed border-blue-300 text-blue-800 font-bold rounded-lg px-3 py-1 cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                📁 {draft.media.length ? 'עוד תמונה / סרטון' : 'העלאת תמונה / סרטון'}
                <input type="file" accept="image/*,video/*" className="hidden" onChange={e => { addMedia(e.target.files?.[0] || null); e.target.value = ''; }} />
              </label>
              {busy === 'upload' && <span className="text-gray-500 mr-2 inline-flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> {uploadPct}</span>}
            </div>

            {/* send to the approvers on WhatsApp (נועם asks them, they answer with a tap) */}
            <div className="space-y-1.5 text-xs bg-green-50 border border-green-200 rounded-lg p-2">
              <div className="font-bold text-gray-700">📲 אישור בוואטסאפ דרך נועם</div>
              <div className="flex flex-wrap items-center gap-1.5">
                {approvers.map((a, i) => (
                  <span key={a.phone} className="inline-flex items-center gap-1 bg-white border border-gray-300 rounded-full px-2 py-0.5">
                    {a.name || 'מאשר'} · 0{a.phone.slice(3)}
                    <button onClick={() => saveApprovers(approvers.filter((_, j) => j !== i))}><X className="w-3 h-3" /></button>
                  </span>
                ))}
                <input value={newApprover.name} onChange={e => setNewApprover({ ...newApprover, name: e.target.value })} placeholder="שם" className={`${input} w-20`} />
                <input value={newApprover.phone} onChange={e => setNewApprover({ ...newApprover, phone: e.target.value })} placeholder="נייד" inputMode="tel" className={`${input} w-28`} />
                <button disabled={newApprover.phone.replace(/\D/g, '').length < 9} onClick={() => { saveApprovers([...approvers, newApprover]); setNewApprover({ name: '', phone: '' }); }} className={btn}><Plus className="w-3 h-3" /> הוסף</button>
              </div>
              <button onClick={sendApproval} disabled={!approvers.length || !!busy || problems.length > 0} className="bg-green-600 hover:bg-green-700 text-white font-bold rounded-lg px-3 py-1.5 disabled:opacity-50">
                {busy === 'wa' ? 'שולח…' : '📲 שלח לאישור בוואטסאפ'}
              </button>
              {waResult && <p className="text-gray-700">{waResult}</p>}
              <p className="text-[11px] text-gray-500">המאשר יקבל את הסיכום מהמספר של העסק, ויוכל לכתוב לנועם מה לשנות או ללחוץ "✅ מאשר להעלות" ואחר כך "▶️ להפעיל". אפשר גם להתחיל קמפיין ישר משם: לכתוב לנועם "קמפיין חדש…".</p>
            </div>

            {problems.length > 0 && <ul className="text-xs text-amber-800 bg-amber-50 rounded-lg p-2 list-disc pr-5">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
            <button onClick={publish} disabled={!!busy || problems.length > 0} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl py-2.5 disabled:opacity-50">
              {busy === 'publish' ? 'מעלה למטא…' : '✅ אשר והעלה למטא (מושהה)'}
            </button>
            <button onClick={saveForLater} disabled={!!busy} className={`${btn} w-full justify-center`}>💾 שמור כטיוטה והמשך אחר כך</button>
          </div>
        )}

        {/* 3. done */}
        {result && (
          <div className="space-y-2 border-t border-gray-100 pt-3">
            <p className="text-green-800 bg-green-50 rounded-lg p-3 text-sm">
              ✓ הקמפיין "{result.name}" נוצר במטא {activated ? 'ופועל עכשיו' : 'מושהה'}, עם סט אחד ו-{result.ads.length} מודעות.
            </p>
            {result.errors?.length ? (
              <div className="text-xs text-amber-800 bg-amber-50 rounded-lg p-2 space-y-1.5">
                <p>חלק מהמודעות לא נוצרו: {result.errors.join(' · ')}</p>
                <button onClick={retryAds} disabled={!!busy} className="bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg px-3 py-1 disabled:opacity-50">{busy === 'publish' ? 'מנסה…' : '🔁 לנסות שוב את המודעות שנכשלו'}</button>
              </div>
            ) : null}
            {!activated ? (
              <button onClick={activate} disabled={busy === 'activate'} className="bg-green-600 hover:bg-green-700 text-white font-bold rounded-xl px-4 py-2 disabled:opacity-50">
                {busy === 'activate' ? 'מפעיל…' : `▶️ להפעיל את הקמפיין (₪${draft?.dailyBudgetIls} ליום)`}
              </button>
            ) : <p className="text-xs text-gray-600">אפשר להשהות אותו בכל רגע ממנהל המודעות, ולבטל אותו ב"שינויים שבוצעו" בניתוח של הקמפיין.</p>}
            <p className="text-[11px] text-gray-500">מטא בודקת כל מודעה חדשה לפני שהיא מתחילה לרוץ - זה לוקח בדרך כלל עד כמה שעות. הקמפיין יופיע ברשימה אחרי רענון.</p>
            <button onClick={onBack} className={btn}>← חזרה לכל הקמפיינים</button>
          </div>
        )}
      </div>
    </div>
  );
}

// the bot's *bold* (WhatsApp style) as bold
function richText(t: string) {
  return t.split(/(\*[^*\n]+\*)/g).map((part, i) => (part.length > 2 && part.startsWith('*') && part.endsWith('*') ? <b key={i}>{part.slice(1, -1)}</b> : <React.Fragment key={i}>{part}</React.Fragment>));
}

function fmtWhen(iso: string) {
  try { return new Date(iso).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}
