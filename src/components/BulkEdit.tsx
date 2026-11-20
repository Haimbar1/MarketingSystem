// Changing several ads / ad sets at once (Haim, 2026-11-20 - "so we don't go one after the other"):
// texts + the WhatsApp box for the ticked ads, location + gender for the ticked ad sets.
// Server: server/adEdits.ts. Empty fields = keep what each ad has.
import React, { useEffect, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';

type Place = { key: string; name: string; type: 'city' | 'region' | 'country'; region?: string; radiusKm?: number | null };
const TYPE_HE: Record<string, string> = { city: 'עיר', region: 'אזור', country: 'מדינה' };
const input = 'border border-gray-300 rounded px-2 py-1';

function Results({ results }: { results: any[] }) {
  return (
    <ul className="text-xs space-y-0.5">
      {results.map((r, i) => (
        <li key={i} className={r.ok ? 'text-green-800' : 'text-red-700'}>
          {r.ok ? '✓' : '✗'} {r.name}{r.ok ? (r.newAdId ? ' - נוצרה מודעה חדשה מושהית' : '') : ` - ${r.error}`}{r.note ? ` · ${r.note}` : ''}
        </li>
      ))}
    </ul>
  );
}

export function BulkAdsPanel({ campaignId, ads, onClose, onDone }: { campaignId: string; ads: { id: string; name: string }[]; onClose: () => void; onDone: (text: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [isWa, setIsWa] = useState(false);
  const [placementRules, setPlacementRules] = useState(false);
  const [bodies, setBodies] = useState<string[]>(['']);
  const [titles, setTitles] = useState<string[]>(['']);
  const [descs, setDescs] = useState<string[]>(['']);
  const [changeTexts, setChangeTexts] = useState(false);
  const [changeWa, setChangeWa] = useState(false);
  const [wa, setWa] = useState({ prefill: '', welcome: '', quick: ['', '', ''] });
  const [mode, setMode] = useState<'replace' | 'new_ad'>('replace');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);
  const [error, setError] = useState('');

  // start from what the first ticked ad has now
  useEffect(() => {
    setLoading(true);
    fetch(`/api/meta-ads/ads/${ads[0]?.id}/texts`).then(r => r.json()).then(d => {
      if (!d?.success) return;
      setIsWa(!!d.whatsapp);
      setPlacementRules(!!d.placementRules);
      setBodies(d.bodies?.length ? d.bodies : ['']);
      setTitles(d.titles?.length ? d.titles : ['']);
      setDescs(d.descriptions?.length ? d.descriptions : ['']);
      setWa({ prefill: d.wa?.prefill || 'היי, אשמח לקבוע תור 🙂', welcome: d.wa?.welcome || 'שלום! 👋 נשמח לקבוע לך תור. לחצו שלח ונמצא מועד שנוח לך', quick: [...(d.wa?.quick || ['📅 לקבוע תור', '💰 כמה זה עולה?']), '', '', ''].slice(0, 3) });
      setChangeWa(!!d.whatsapp);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [ads.map(a => a.id).join(',')]);

  const run = async () => {
    if (!changeTexts && !changeWa) { setError('סמנו מה לשנות'); return; }
    const what = [changeTexts ? 'הטקסטים' : '', changeWa ? 'הודעת הוואטסאפ' : ''].filter(Boolean).join(' ו');
    if (!window.confirm(`לשנות את ${what} ב-${ads.length} מודעות?\n\n${mode === 'replace' ? 'המודעות יחזרו לבדיקה של מטא, והלמידה שלהן תתחיל מחדש.' : 'לכל מודעה תיווצר מודעה חדשה מושהית באותו סט.'}`)) return;
    setBusy(true); setError(''); setResults(null);
    const body: any = { adIds: ads.map(a => a.id), mode };
    if (changeTexts) body.texts = { bodies, titles, descriptions: descs };
    if (changeWa) body.wa = { prefill: wa.prefill, welcome: wa.welcome, quick: wa.quick };
    const d = await fetch(`/api/meta-ads/campaigns/${campaignId}/edit-ads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()).catch(() => ({ success: false, error: 'שגיאת רשת' }));
    setBusy(false);
    if (d?.results) { setResults(d.results); const ok = d.results.filter((r: any) => r.ok).length; if (ok) onDone(`✏️ ${what} שונו ב-${ok} מתוך ${d.results.length} מודעות`); }
    else setError(d?.error || 'השינוי נכשל');
  };

  const many = (label: string, vals: string[], set: (v: string[]) => void, max: number, area = false) => (
    <div className="space-y-1">
      <span className="text-gray-600">{label}</span>
      {vals.map((v, i) => (
        <div key={i} className="flex gap-1">
          {area
            ? <textarea value={v} rows={2} onChange={e => set(vals.map((x, j) => (j === i ? e.target.value : x)))} className="flex-1 border border-gray-300 rounded p-1.5" />
            : <input value={v} onChange={e => set(vals.map((x, j) => (j === i ? e.target.value : x)))} className={`${input} flex-1`} />}
          {vals.length > 1 && <button onClick={() => set(vals.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600"><X className="w-3.5 h-3.5" /></button>}
        </div>
      ))}
      {vals.length < max && !placementRules && <button onClick={() => set([...vals, ''])} className="text-blue-700 inline-flex items-center gap-0.5"><Plus className="w-3 h-3" /> עוד</button>}
    </div>
  );

  return (
    <div className="bg-white border-2 border-blue-200 rounded-xl p-3 space-y-2 text-xs">
      <div className="flex items-start justify-between">
        <div className="font-bold text-sm text-gray-800">✏️ שינוי ב-{ads.length} מודעות</div>
        <button onClick={onClose} className="text-gray-500"><X className="w-4 h-4" /></button>
      </div>
      <p className="text-gray-500">{ads.map(a => a.name).join(' · ')}</p>
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : (
        <>
          <label className="flex items-center gap-1.5 font-bold text-gray-700"><input type="checkbox" checked={changeTexts} onChange={e => setChangeTexts(e.target.checked)} /> לשנות טקסטים</label>
          {changeTexts && (
            <div className="space-y-2 pr-5">
              {placementRules && <p className="text-amber-700">במודעה הזו יש התאמה לפי מיקום - הטקסטים מתחלפים במקום הקיימים, באותה כמות.</p>}
              {many('טקסט ראשי:', bodies, setBodies, 5, true)}
              {many('כותרות:', titles, setTitles, 5)}
              {many('תיאור:', descs, setDescs, 3)}
              <p className="text-gray-400">התחלנו מהטקסטים של "{ads[0]?.name}". שדה ריק נשאר כמו שהיה בכל מודעה.</p>
            </div>
          )}
          <label className="flex items-center gap-1.5 font-bold text-gray-700"><input type="checkbox" checked={changeWa} onChange={e => setChangeWa(e.target.checked)} /> לשנות מה הלקוח רואה בוואטסאפ {!isWa && <span className="font-normal text-gray-400">(רק במודעות וואטסאפ)</span>}</label>
          {changeWa && (
            <div className="space-y-1.5 pr-5">
              <label className="block space-y-0.5"><span className="text-gray-600">ההודעה שכבר כתובה ללקוח:</span><input value={wa.prefill} onChange={e => setWa({ ...wa, prefill: e.target.value })} className={`${input} w-full`} /></label>
              <label className="block space-y-0.5"><span className="text-gray-600">הודעת הפתיחה:</span><textarea value={wa.welcome} rows={2} onChange={e => setWa({ ...wa, welcome: e.target.value })} className="w-full border border-gray-300 rounded p-1.5" /></label>
              <div className="flex flex-wrap gap-1.5">{wa.quick.map((q, i) => <input key={i} value={q} placeholder={i === 2 ? '(לא חובה)' : ''} onChange={e => setWa({ ...wa, quick: wa.quick.map((x, j) => (j === i ? e.target.value : x)) })} className={`${input} w-40`} />)}</div>
            </div>
          )}
          <div className="space-y-1 pt-1 border-t border-gray-100">
            <label className="flex items-center gap-1.5"><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> להחליף בתוך המודעות (חוזרות לבדיקה של מטא, הלמידה מתחילה מחדש)</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={mode === 'new_ad'} onChange={() => setMode('new_ad')} /> מודעה חדשה מושהית ליד כל אחת (הקיימות לא משתנות)</label>
          </div>
          {error && <p className="text-red-700">{error}</p>}
          <button onClick={run} disabled={busy} className="bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg px-4 py-1.5 disabled:opacity-50">{busy ? `משנה ${ads.length} מודעות…` : 'לבצע'}</button>
          {results && <Results results={results} />}
        </>
      )}
    </div>
  );
}

export function BulkAdsetsPanel({ campaignId, adsets, onClose, onDone }: { campaignId: string; adsets: { id: string; name: string }[]; onClose: () => void; onDone: (text: string) => void }) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Place[]>([]);
  const [genders, setGenders] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);
  const [error, setError] = useState('');

  const search = async (v: string) => {
    setQ(v);
    if (v.trim().length < 2) { setHits([]); return; }
    const d = await fetch(`/api/meta-ads/geo-search?q=${encodeURIComponent(v)}`).then(r => r.json()).catch(() => null);
    setHits(d?.places || []);
  };
  const run = async () => {
    if (!places.length && !genders) { setError('בחרו מיקום או מגדר'); return; }
    const what = [places.length ? `מיקום: ${places.map(p => p.name + (p.radiusKm ? ` +${p.radiusKm}` : '')).join(', ')}` : '', genders ? `מגדר: ${({ all: 'כולם', female: 'נשים', male: 'גברים' } as any)[genders]}` : ''].filter(Boolean).join('\n');
    if (!window.confirm(`לשנות ב-${adsets.length} סטים?\n\n${what}${places.length ? '\n\nהמיקום החדש מחליף את המיקום שהיה בכל סט.' : ''}`)) return;
    setBusy(true); setError(''); setResults(null);
    const d = await fetch(`/api/meta-ads/campaigns/${campaignId}/edit-adsets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adsetIds: adsets.map(a => a.id), places: places.length ? places : null, genders: genders || null }) }).then(r => r.json()).catch(() => ({ success: false, error: 'שגיאת רשת' }));
    setBusy(false);
    if (d?.results) { setResults(d.results.map((r: any) => ({ ...r }))); const ok = d.results.filter((r: any) => r.ok).length; if (ok) onDone(`📍 שונה ב-${ok} מתוך ${d.results.length} סטים`); }
    else setError(d?.error || 'השינוי נכשל');
  };

  return (
    <div className="bg-white border-2 border-blue-200 rounded-xl p-3 space-y-2 text-xs">
      <div className="flex items-start justify-between">
        <div className="font-bold text-sm text-gray-800">📍 מיקום ומגדר ב-{adsets.length} סטים</div>
        <button onClick={onClose} className="text-gray-500"><X className="w-4 h-4" /></button>
      </div>
      <p className="text-gray-500">{adsets.map(a => a.name).join(' · ')}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-gray-600">מיקום חדש:</span>
        {places.map((p, i) => (
          <span key={p.key} className="inline-flex items-center gap-1 bg-gray-50 border border-gray-300 rounded-full px-2 py-0.5">
            {p.name} <span className="text-gray-400">({TYPE_HE[p.type]})</span>
            {p.type === 'city' && (
              <select value={p.radiusKm ?? ''} onChange={e => setPlaces(places.map((x, j) => (j === i ? { ...x, radiusKm: e.target.value ? Number(e.target.value) : null } : x)))} className="border-0 bg-transparent">
                <option value="">העיר בלבד</option>{[17, 25, 40, 60, 80].map(k => <option key={k} value={k}>+{k} ק"מ</option>)}
              </select>
            )}
            <button onClick={() => setPlaces(places.filter((_, j) => j !== i))}><X className="w-3 h-3" /></button>
          </span>
        ))}
        <input value={q} onChange={e => search(e.target.value)} placeholder="+ עיר / אזור" className={`${input} w-36`} />
        {!places.length && <span className="text-gray-400">(ריק = המיקום לא משתנה)</span>}
      </div>
      {hits.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {hits.map(h => <button key={h.key} onClick={() => { setPlaces([...places.filter(p => p.key !== h.key), { ...h, radiusKm: null }]); setQ(''); setHits([]); }} className="inline-flex items-center gap-1 border border-blue-300 text-blue-800 rounded-full px-2 py-0.5"><Plus className="w-3 h-3" />{h.name}{h.region ? `, ${h.region}` : ''} ({TYPE_HE[h.type]})</button>)}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-gray-600">מגדר:</span>
        <select value={genders} onChange={e => setGenders(e.target.value)} className={input}>
          <option value="">לא לשנות</option><option value="all">כולם</option><option value="female">נשים</option><option value="male">גברים</option>
        </select>
      </div>
      {error && <p className="text-red-700">{error}</p>}
      <button onClick={run} disabled={busy} className="bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg px-4 py-1.5 disabled:opacity-50">{busy ? 'משנה…' : 'לבצע'}</button>
      {results && <Results results={results} />}
    </div>
  );
}
