// "🖼️ מדיה" on an ad in the campaign analysis - replace / add a video (Haim, 2026-11-19), pictures
// and carousel cards (2026-11-20):
//  - a single picture / video ad: replace it with a picture or a video;
//  - a flexible ad (several assets): add a picture / video next to the others, or replace one;
//  - a carousel: replace a card's picture / video, add a card (with its title / line), remove a card.
// Then either a new ad in the same ad set (recommended - created PAUSED, then ▶️) or the change inside
// this ad (it goes back to Meta's review; its learning and likes start over).
// Pictures go to the ad account's image library (shrunk in the browser to fit the 4.5MB request
// limit); videos are uploaded in 3MB pieces. Server: server/adMedia.ts. Logged and undoable.
import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';

const PIECE = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3.3 * 1024 * 1024;

type Asset = {
  type: 'video' | 'image'; id: string; title: string | null; thumb: string | null; length?: number | null; size?: string | null;
  source?: string | null; created: string | null; perf: { spend: number; impressions: number; leads: number } | null;
};
type Card = { index: number; name: string; description: string; link: string; media: Asset };
type AdInfo = { kind: 'video' | 'image' | 'flexible' | 'carousel' | 'other' | 'post'; assets: Asset[]; cards: Card[] | null; maxCards: number };
type Action = 'replace' | 'add' | 'remove';

const mmss = (sec?: number | null) => (sec == null ? '' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);

// One picture / video as a card: what it is, and its last 30 days in a flexible ad.
function AssetCard({ a, label, selected, onPick, rate, currency, extra }: {
  a: Asset; label: string; selected?: boolean; onPick?: () => void; rate: number | null; currency: string; extra?: React.ReactNode;
}) {
  const [play, setPlay] = useState(false);
  const spend = a.perf ? (currency === 'ILS' || !rate ? a.perf.spend : a.perf.spend * rate) : 0;
  return (
    <div onClick={onPick} className={`flex gap-2 items-start rounded-lg border p-2 ${onPick ? 'cursor-pointer' : ''} ${selected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'}`}>
      <div className="w-20 shrink-0" onClick={e => e.stopPropagation()}>
        {play && a.source ? (
          <video src={a.source} poster={a.thumb || undefined} controls autoPlay className="w-20 h-20 rounded object-cover bg-black" />
        ) : (
          <button type="button" onClick={() => (a.source ? setPlay(true) : onPick?.())} className="relative block w-20 h-20 rounded overflow-hidden bg-gray-100">
            {a.thumb ? <img src={a.thumb} alt="" className="w-full h-full object-cover" /> : <span className="text-2xl">{a.type === 'video' ? '🎬' : '🖼️'}</span>}
            {a.source && <span className="absolute inset-0 flex items-center justify-center text-white text-2xl drop-shadow">▶</span>}
          </button>
        )}
      </div>
      <div className="min-w-0 space-y-0.5">
        <div className="font-bold text-gray-800">{a.type === 'video' ? '🎬' : '🖼️'} {label}{a.length ? ` · ${mmss(a.length)}` : ''}</div>
        {a.title && <div className="text-gray-600 truncate" title={a.title}>{a.title}</div>}
        {a.size && <div className="text-gray-400">{a.size}</div>}
        {a.created && <div className="text-gray-400">הועלה {new Date(a.created).toLocaleDateString('he-IL')}</div>}
        {a.perf ? <div className="text-gray-700">30 יום: ₪{Math.round(spend).toLocaleString('he-IL')} · {a.perf.leads} לידים{a.perf.leads ? ` · ₪${Math.round(spend / a.perf.leads)} לליד` : ''}</div> : null}
        {extra}
      </div>
    </div>
  );
}

// A picture small enough for one request (≤3.3MB, ≤2048px), as JPEG unless it already fits.
async function fitImage(file: File): Promise<Blob> {
  if (file.size <= MAX_IMAGE_BYTES && /jpe?g|png/i.test(file.type)) return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (const q of [0.92, 0.85, 0.75, 0.65, 0.55]) {
    const blob: Blob | null = await new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= MAX_IMAGE_BYTES) return blob;
  }
  throw new Error('התמונה גדולה מדי גם אחרי הקטנה');
}

export default function AdMediaPanel({ ad, onDone, onClose, rate = null, currency = '' }: {
  ad: { id: string; name: string }; onDone: (text: string) => void; onClose: () => void; rate?: number | null; currency?: string;
}) {
  const [info, setInfo] = useState<AdInfo | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'new_ad' | 'replace'>('new_ad');
  const [action, setAction] = useState<Action>('add');
  const [pickedId, setPickedId] = useState(''); // flexible: the asset replaced
  const [cardIndex, setCardIndex] = useState<number | null>(null); // carousel: the card replaced / removed
  const [cardName, setCardName] = useState('');
  const [cardDesc, setCardDesc] = useState('');
  const [newAdName, setNewAdName] = useState(`${ad.name} · חדש`);
  const [stage, setStage] = useState<'pick' | 'uploading' | 'processing' | 'ready' | 'applying'>('pick');
  const [progress, setProgress] = useState(0);
  const [uploaded, setUploaded] = useState<{ type: 'video'; id: string; thumb: string } | { type: 'image'; hash: string; thumb: string } | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    fetch(`/api/meta-ads/ads/${ad.id}/media`).then(r => r.json()).then(d => {
      if (!d?.success) { setError(d?.error || 'לא הצלחנו לקרוא את המודעה'); return; }
      const assets: Asset[] = d.assets || (d.videos || []).map((v: any) => ({ ...v, type: 'video' }));
      setInfo({ kind: d.kind, assets, cards: d.cards || null, maxCards: d.maxCards || 10 });
      setAction(d.kind === 'flexible' ? 'add' : d.kind === 'carousel' ? 'replace' : 'replace');
    }).catch(() => setError('שגיאת רשת'));
  }, [ad.id]);

  const blocked = info && (info.kind === 'post' || info.kind === 'other');
  const needsFile = action !== 'remove';
  const busy = stage === 'uploading' || stage === 'processing' || stage === 'applying';

  // ---- uploads ----
  const uploadImage = async (f: File) => {
    setStage('uploading'); setProgress(30);
    const blob = await fitImage(f);
    const name = /png$/i.test(blob.type) ? f.name.replace(/\.\w+$/, '') + '.png' : f.name.replace(/\.\w+$/, '') + '.jpg';
    const d = await fetch(`/api/meta-ads/images?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob }).then(r => r.json());
    if (!d?.success) throw new Error(d?.error || 'העלאת התמונה נכשלה');
    setProgress(100);
    setUploaded({ type: 'image', hash: d.hash, thumb: d.url || URL.createObjectURL(blob) });
    setStage('ready');
  };
  const uploadVideo = async (f: File) => {
    setStage('uploading'); setProgress(0);
    const st = await fetch('/api/meta-ads/videos/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileSize: f.size }) }).then(r => r.json());
    if (!st?.success) throw new Error(st?.error || 'ההעלאה לא התחילה');
    let pos = Number(st.position) || 0;
    while (pos < f.size) {
      if (!alive.current) return;
      const piece = f.slice(pos, Math.min(pos + PIECE, f.size));
      const r = await fetch(`/api/meta-ads/videos/chunk?session=${encodeURIComponent(st.sessionId)}&pos=${pos}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: piece }).then(x => x.json());
      if (!r?.success && r?.position == null) throw new Error(r?.error || 'ההעלאה נכשלה');
      pos = Number(r.position);
      setProgress(Math.round((pos / f.size) * 100));
    }
    const fin = await fetch('/api/meta-ads/videos/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: st.sessionId, title: f.name }) }).then(r => r.json());
    if (!fin?.success) throw new Error(fin?.error || 'סיום ההעלאה נכשל');
    setStage('processing');
    for (let i = 0; i < 90 && alive.current; i++) {
      await new Promise(res => setTimeout(res, 5000));
      const s = await fetch(`/api/meta-ads/videos/${fin.videoId}/status`).then(r => r.json()).catch(() => null);
      if (s?.error) throw new Error(s.error);
      if (s?.ready) { setUploaded({ type: 'video', id: fin.videoId, thumb: s.thumb }); setStage('ready'); return; }
    }
    throw new Error('מטא עדיין מעבדת את הסרטון - נסו שוב בעוד כמה דקות');
  };
  const upload = async () => {
    if (!file) return;
    setError('');
    try {
      if (file.type.startsWith('image/')) await uploadImage(file);
      else if (file.type.startsWith('video/')) await uploadVideo(file);
      else throw new Error('אפשר להעלות תמונה או סרטון');
    } catch (e: any) {
      setError(e?.message || 'שגיאה'); setStage('pick');
    }
  };

  // ---- what goes where ----
  const target = () => {
    if (!info) return {};
    if (info.kind === 'flexible') return { kind: 'feed', action, replaceId: action === 'replace' ? pickedId : undefined };
    if (info.kind === 'carousel') return { kind: 'card', action, index: cardIndex ?? undefined, name: cardName || undefined, description: cardDesc || undefined };
    return { kind: 'single', action: 'replace' };
  };
  const targetReady = !info ? false
    : info.kind === 'flexible' ? action === 'add' || !!pickedId
    : info.kind === 'carousel' ? action === 'add' || cardIndex != null
    : true;
  const describe = () => {
    if (!info) return '';
    const m = uploaded?.type === 'image' ? 'התמונה החדשה' : 'הסרטון החדש';
    if (info.kind === 'carousel') {
      if (action === 'remove') return `להסיר את כרטיס ${(cardIndex ?? 0) + 1} מהקרוסלה`;
      if (action === 'add') return `להוסיף לקרוסלה כרטיס חדש עם ${m}`;
      return `להחליף את המדיה בכרטיס ${(cardIndex ?? 0) + 1} ב${m}`;
    }
    if (info.kind === 'flexible') return action === 'add' ? `להוסיף את ${m} לצד הקיימים` : `להחליף את אחד הנכסים ב${m}`;
    return `להחליף את המדיה במודעה ב${m}`;
  };

  const apply = async () => {
    const where = mode === 'new_ad'
      ? `ליצור מודעה חדשה "${newAdName}" באותו סט (${describe()})? היא תיווצר מושהית - מפעילים אותה בכפתור ▶️.`
      : `${describe()} בתוך המודעה "${ad.name}"? המודעה תחזור לבדיקה של מטא, והלמידה והלייקים שלה יתחילו מחדש.`;
    if (!window.confirm(where)) return;
    setStage('applying'); setError('');
    const media = !needsFile ? null : uploaded?.type === 'image' ? { type: 'image', hash: uploaded.hash } : uploaded ? { type: 'video', id: uploaded.id } : null;
    const d = await fetch(`/api/meta-ads/ads/${ad.id}/media`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media, target: target(), mode, newAdName }),
    }).then(r => r.json()).catch(() => ({ success: false, error: 'שגיאת רשת' }));
    if (d?.success) onDone(mode === 'new_ad' ? `✓ נוצרה מודעה חדשה "${d.name}" (מושהית) - כדי להפעיל: רענן ניתוח ואז ▶️` : '✓ המודעה עודכנה - היא חוזרת לבדיקה של מטא');
    else { setError(d?.error || 'נכשל'); setStage(needsFile ? 'ready' : 'pick'); }
  };

  const radio = (value: Action, label: React.ReactNode) => (
    <label className="flex items-center gap-2"><input type="radio" checked={action === value} disabled={busy} onChange={() => { setAction(value); if (value === 'add') { setPickedId(''); setCardIndex(null); } }} /> {label}</label>
  );

  return (
    <div className="bg-white border border-blue-200 rounded-lg p-3 space-y-2 mt-1 text-xs">
      <div className="flex items-center justify-between">
        <b className="text-gray-800">🖼️ מדיה למודעה "{ad.name}"</b>
        {!busy && <button onClick={onClose} className="text-gray-500 hover:text-gray-800">סגירה</button>}
      </div>
      {!info && !error && <p className="text-gray-500 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> קורא את המודעה…</p>}
      {blocked && <p className="text-amber-800 bg-amber-50 rounded p-2">המודעה מבוססת על פוסט קיים מהדף - אי אפשר להחליף בה מדיה.</p>}

      {info && !blocked && (
        <>
          {/* where the new picture / video goes */}
          {(info.kind === 'video' || info.kind === 'image') && info.assets[0] && (
            <div className="space-y-1">
              <div className="text-gray-600">מה שיש במודעה עכשיו (יוחלף בתמונה או בסרטון שתבחרו):</div>
              <AssetCard a={info.assets[0]} label={info.kind === 'video' ? 'הסרטון' : 'התמונה'} rate={rate} currency={currency} />
            </div>
          )}
          {info.kind === 'flexible' && (
            <div className="space-y-1.5 bg-gray-50 rounded p-2">
              <div className="text-gray-600">מודעה גמישה - מטא מציגה לכל אחד את מה שמתאים לו ({info.assets.filter(a => a.type === 'video').length} סרטונים, {info.assets.filter(a => a.type === 'image').length} תמונות):</div>
              {radio('add', 'להוסיף תמונה / סרטון לצד הקיימים')}
              {info.assets.length > 0 && radio('replace', 'להחליף אחד מהם - לחצו על מה שמחליפים:')}
              <div className="grid sm:grid-cols-2 gap-1.5">
                {info.assets.map((a, i) => (
                  <AssetCard key={a.id || i} a={a} label={`${a.type === 'video' ? 'סרטון' : 'תמונה'} ${info.assets.filter((x, j) => x.type === a.type && j <= i).length}`} rate={rate} currency={currency}
                    selected={action === 'replace' && pickedId === a.id}
                    onPick={busy ? undefined : () => { setAction('replace'); setPickedId(a.id); }} />
                ))}
              </div>
              {info.assets.some(a => a.perf) ? <p className="text-[10px] text-gray-400">הנתונים לפי מטא, לכל נכס במודעה (30 הימים האחרונים).</p> : null}
            </div>
          )}
          {info.kind === 'carousel' && info.cards && (
            <div className="space-y-1.5 bg-gray-50 rounded p-2">
              <div className="text-gray-600">קרוסלה עם {info.cards.length} כרטיסים:</div>
              {radio('replace', 'להחליף את התמונה / הסרטון בכרטיס - לחצו על הכרטיס:')}
              {info.cards.length < info.maxCards && radio('add', 'להוסיף כרטיס חדש בסוף')}
              {info.cards.length > 2 && radio('remove', 'להסיר כרטיס - לחצו על הכרטיס:')}
              <div className="grid sm:grid-cols-2 gap-1.5">
                {info.cards.map(c => (
                  <AssetCard key={c.index} a={c.media} label={`כרטיס ${c.index + 1}`} rate={rate} currency={currency}
                    selected={action !== 'add' && cardIndex === c.index}
                    onPick={busy || action === 'add' ? undefined : () => { setCardIndex(c.index); setCardName(''); setCardDesc(''); }}
                    extra={<>{c.name && <div className="text-gray-800">"{c.name}"</div>}{c.description && <div className="text-gray-500 truncate">{c.description}</div>}</>} />
                ))}
              </div>
              {action !== 'remove' && (action === 'add' || cardIndex != null) && (
                <div className="grid sm:grid-cols-2 gap-1.5">
                  <input value={cardName} onChange={e => setCardName(e.target.value)} disabled={busy} maxLength={80}
                    placeholder={action === 'add' ? 'כותרת הכרטיס החדש' : 'כותרת חדשה (ריק = להשאיר)'} className="border border-gray-300 rounded px-2 py-1" />
                  <input value={cardDesc} onChange={e => setCardDesc(e.target.value)} disabled={busy} maxLength={80}
                    placeholder={action === 'add' ? 'שורה מתחת לכותרת (לא חובה)' : 'שורה חדשה (ריק = להשאיר)'} className="border border-gray-300 rounded px-2 py-1" />
                </div>
              )}
            </div>
          )}

          {/* new ad or inside this ad */}
          <div className="space-y-1">
            <label className="flex items-start gap-2"><input type="radio" checked={mode === 'new_ad'} onChange={() => setMode('new_ad')} disabled={busy} className="mt-0.5" />
              <span><b>מודעה חדשה באותו סט</b> (מומלץ) - הישנה ממשיכה לרוץ; אחרי כמה ימים משהים את החלשה.</span></label>
            <label className="flex items-start gap-2"><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} disabled={busy} className="mt-0.5" />
              <span><b>לשנות בתוך המודעה הזו</b> - המודעה חוזרת לבדיקה של מטא, הלמידה והלייקים שלה מתחילים מחדש.</span></label>
          </div>
          {mode === 'new_ad' && (
            <div className="flex items-center gap-2"><span>שם המודעה החדשה:</span>
              <input value={newAdName} onChange={e => setNewAdName(e.target.value)} disabled={busy} className="flex-1 border border-gray-300 rounded px-2 py-1" /></div>
          )}

          {/* the file */}
          {needsFile && stage === 'pick' && (
            <div className="flex items-center gap-2 flex-wrap">
              <label className="inline-flex items-center gap-1 bg-white border-2 border-dashed border-blue-300 text-blue-800 font-bold rounded-lg px-3 py-1.5 cursor-pointer hover:bg-blue-50">
                📁 {file ? 'החלפת קובץ' : 'בחירת תמונה או סרטון'}
                <input type="file" accept="image/*,video/*" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
              </label>
              {file ? <span className="text-gray-700">{file.type.startsWith('video/') ? '🎬' : '🖼️'} {file.name} · {(file.size / 1024 / 1024).toFixed(1)}MB</span> : <span className="text-gray-400">קודם בוחרים קובץ, אחר כך "העלאה למטא"</span>}
              <button onClick={upload} disabled={!file || !targetReady} className="inline-flex items-center gap-1 bg-blue-600 text-white font-bold rounded px-3 py-1.5 disabled:opacity-40"><Upload className="w-3.5 h-3.5" /> העלאה למטא</button>
              {file && !targetReady && <span className="text-amber-700">בחרו קודם על מה (לחיצה על {info.kind === 'carousel' ? 'כרטיס' : 'נכס'})</span>}
            </div>
          )}
          {stage === 'uploading' && (
            <div className="space-y-1">
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-blue-600" style={{ width: `${progress}%` }} /></div>
              <p className="text-gray-500">מעלה למטא… {progress}% (לא לסגור את הדף)</p>
            </div>
          )}
          {stage === 'processing' && <p className="text-gray-500 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> הסרטון עלה - מטא מעבדת אותו (בדרך כלל דקה-שתיים)…</p>}
          {((needsFile && (stage === 'ready' || stage === 'applying')) || (!needsFile && cardIndex != null)) && (
            <div className="flex items-center gap-2 flex-wrap">
              {needsFile && uploaded?.thumb && <img src={uploaded.thumb} alt="" className="w-16 h-16 rounded object-cover" />}
              {needsFile && <span className="text-green-700 font-bold">{uploaded?.type === 'image' ? 'התמונה מוכנה' : 'הסרטון מוכן'}</span>}
              <button onClick={apply} disabled={stage === 'applying' || !targetReady} className="bg-blue-600 text-white font-bold rounded px-3 py-1 disabled:opacity-50">
                {stage === 'applying' ? 'מבצע…' : mode === 'new_ad' ? 'ליצור את המודעה החדשה' : action === 'remove' ? 'להסיר את הכרטיס' : 'לעדכן את המודעה'}
              </button>
            </div>
          )}
        </>
      )}
      {error && <p className="text-red-700 bg-red-50 rounded p-2">{error}</p>}
    </div>
  );
}
