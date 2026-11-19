// "🎬 סרטון" on an ad in the campaign analysis (Haim, 2026-11-19 - replace / add a video; both ways):
// pick the file → upload to the ad account in 3MB pieces → wait for Meta to process it → choose:
//  - new ad in the same ad set (recommended - created PAUSED, then ▶️), or
//  - replace in this ad (goes back to Meta's review; its learning and likes start over);
// for a flexible ad (several assets) the video can replace one of its videos or be added next to them.
// Server: server/adMedia.ts. Logged in "שינויים שבוצעו" and undoable.
import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';

const PIECE = 3 * 1024 * 1024;
type VideoInfo = { id: string; title: string | null; thumb: string | null; length: number | null; source: string | null; created: string | null; perf: { spend: number; impressions: number; leads: number } | null };
type AdInfo = { kind: string; videos: VideoInfo[]; images: number };

const mmss = (sec: number | null) => (sec == null ? '' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);

// One of the ad's videos as a card: picture (plays when Meta gives the file), title, length, and its
// last 30 days in a flexible ad - so it's clear what each video is (Haim, 2026-11-19).
function VideoCard({ v, i, selected, onPick, rate, currency }: { v: VideoInfo; i: number; selected?: boolean; onPick?: () => void; rate: number | null; currency: string }) {
  const [play, setPlay] = useState(false);
  const spend = v.perf ? (currency === 'ILS' || !rate ? v.perf.spend : v.perf.spend * rate) : 0;
  return (
    <div onClick={onPick} className={`flex gap-2 items-start rounded-lg border p-2 ${onPick ? 'cursor-pointer' : ''} ${selected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'}`}>
      <div className="w-24 shrink-0" onClick={e => e.stopPropagation()}>
        {play && v.source ? (
          <video src={v.source} poster={v.thumb || undefined} controls autoPlay className="w-24 h-24 rounded object-cover bg-black" />
        ) : (
          <button type="button" onClick={() => v.source && setPlay(true)} className="relative block w-24 h-24 rounded overflow-hidden bg-gray-100" title={v.source ? 'הפעלה' : ''}>
            {v.thumb ? <img src={v.thumb} alt="" className="w-full h-full object-cover" /> : <span className="text-2xl">🎬</span>}
            {v.source && <span className="absolute inset-0 flex items-center justify-center text-white text-2xl drop-shadow">▶</span>}
          </button>
        )}
      </div>
      <div className="min-w-0 space-y-0.5">
        <div className="font-bold text-gray-800">סרטון {i + 1}{v.length ? ` · ${mmss(v.length)}` : ''}</div>
        {v.title && <div className="text-gray-600 truncate" title={v.title}>{v.title}</div>}
        {v.created && <div className="text-gray-400">הועלה {new Date(v.created).toLocaleDateString('he-IL')}</div>}
        {v.perf ? (
          <div className="text-gray-700">30 יום: ₪{Math.round(spend).toLocaleString('he-IL')} · {v.perf.leads} לידים{v.perf.leads ? ` · ₪${Math.round(spend / v.perf.leads)} לליד` : ''}</div>
        ) : null}
      </div>
    </div>
  );
}

export default function AdMediaPanel({ ad, onDone, onClose, rate = null, currency = '' }: { ad: { id: string; name: string }; onDone: (text: string) => void; onClose: () => void; rate?: number | null; currency?: string }) {
  const [info, setInfo] = useState<AdInfo | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'new_ad' | 'replace'>('new_ad');
  const [feed, setFeed] = useState<'replace' | 'add'>('add');
  const [replaceVideoId, setReplaceVideoId] = useState('');
  const [newAdName, setNewAdName] = useState(`${ad.name} · סרטון חדש`);
  const [stage, setStage] = useState<'pick' | 'uploading' | 'processing' | 'ready' | 'applying'>('pick');
  const [progress, setProgress] = useState(0);
  const [videoId, setVideoId] = useState('');
  const [thumb, setThumb] = useState('');
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    fetch(`/api/meta-ads/ads/${ad.id}/media`).then(r => r.json()).then(d => {
      if (d?.success) { setInfo(d); if (d.videos?.[0]) setReplaceVideoId(d.videos[0].id); }
      else setError(d?.error || 'לא הצלחנו לקרוא את המודעה');
    }).catch(() => setError('שגיאת רשת'));
  }, [ad.id]);

  const blocked = info && (info.kind === 'carousel' || info.kind === 'post' || info.kind === 'other');

  const upload = async () => {
    if (!file) return;
    setError(''); setStage('uploading'); setProgress(0);
    try {
      const st = await fetch('/api/meta-ads/videos/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileSize: file.size }) }).then(r => r.json());
      if (!st?.success) throw new Error(st?.error || 'ההעלאה לא התחילה');
      let pos = Number(st.position) || 0;
      while (pos < file.size) {
        if (!alive.current) return;
        const piece = file.slice(pos, Math.min(pos + PIECE, file.size));
        const r = await fetch(`/api/meta-ads/videos/chunk?session=${encodeURIComponent(st.sessionId)}&pos=${pos}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: piece,
        }).then(x => x.json());
        if (!r?.success && r?.position == null) throw new Error(r?.error || 'ההעלאה נכשלה');
        pos = Number(r.position);
        setProgress(Math.round((pos / file.size) * 100));
      }
      const fin = await fetch('/api/meta-ads/videos/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: st.sessionId, title: file.name }) }).then(r => r.json());
      if (!fin?.success) throw new Error(fin?.error || 'סיום ההעלאה נכשל');
      setVideoId(fin.videoId); setStage('processing');
      // Meta processes the video - usually a minute or two
      for (let i = 0; i < 90 && alive.current; i++) {
        await new Promise(res => setTimeout(res, 5000));
        const s = await fetch(`/api/meta-ads/videos/${fin.videoId}/status`).then(r => r.json()).catch(() => null);
        if (s?.error) throw new Error(s.error);
        if (s?.ready) { setThumb(s.thumb); setStage('ready'); return; }
      }
      throw new Error('מטא עדיין מעבדת את הסרטון - נסו שוב בעוד כמה דקות');
    } catch (e: any) {
      setError(e?.message || 'שגיאה'); setStage('pick');
    }
  };

  const apply = async () => {
    const what = mode === 'new_ad'
      ? `ליצור מודעה חדשה "${newAdName}" באותו סט, עם הסרטון החדש? היא תיווצר מושהית - מפעילים אותה בכפתור ▶️.`
      : `להחליף את הסרטון במודעה "${ad.name}"? המודעה תחזור לבדיקה של מטא, והלמידה והלייקים שלה יתחילו מחדש.`;
    if (!window.confirm(what)) return;
    setStage('applying'); setError('');
    const d = await fetch(`/api/meta-ads/ads/${ad.id}/media`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, mode, feed, replaceVideoId, newAdName }),
    }).then(r => r.json()).catch(() => ({ success: false, error: 'שגיאת רשת' }));
    if (d?.success) onDone(mode === 'new_ad' ? `✓ נוצרה מודעה חדשה "${d.name}" (מושהית) - כדי להפעיל: רענן ניתוח ואז ▶️` : '✓ הסרטון הוחלף במודעה - היא חוזרת לבדיקה של מטא');
    else { setError(d?.error || 'נכשל'); setStage('ready'); }
  };

  const busy = stage === 'uploading' || stage === 'processing' || stage === 'applying';
  return (
    <div className="bg-white border border-blue-200 rounded-lg p-3 space-y-2 mt-1 text-xs">
      <div className="flex items-center justify-between">
        <b className="text-gray-800">🎬 סרטון חדש למודעה "{ad.name}"</b>
        {!busy && <button onClick={onClose} className="text-gray-500 hover:text-gray-800">סגירה</button>}
      </div>
      {!info && !error && <p className="text-gray-500 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> קורא את המודעה…</p>}
      {blocked && <p className="text-amber-800 bg-amber-50 rounded p-2">{info!.kind === 'carousel' ? 'זו מודעת קרוסלה - החלפת סרטון בקרוסלה עוד לא נתמכת.' : 'המודעה מבוססת על פוסט קיים מהדף - אי אפשר להחליף בה מדיה.'}</p>}

      {info && !blocked && (
        <>
          <div className="space-y-1">
            <label className="flex items-start gap-2"><input type="radio" checked={mode === 'new_ad'} onChange={() => setMode('new_ad')} disabled={busy} className="mt-0.5" />
              <span><b>מודעה חדשה באותו סט</b> (מומלץ) - הישנה ממשיכה לרוץ; אחרי כמה ימים משהים את החלשה.</span></label>
            <label className="flex items-start gap-2"><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} disabled={busy} className="mt-0.5" />
              <span><b>להחליף בתוך המודעה הזו</b> - המודעה חוזרת לבדיקה של מטא, הלמידה והלייקים שלה מתחילים מחדש.</span></label>
          </div>
          {mode === 'new_ad' && (
            <div className="flex items-center gap-2"><span>שם המודעה החדשה:</span>
              <input value={newAdName} onChange={e => setNewAdName(e.target.value)} disabled={busy} className="flex-1 border border-gray-300 rounded px-2 py-1" /></div>
          )}
          {info.kind === 'video' && info.videos[0] && (
            <div className="space-y-1">
              <div className="text-gray-600">הסרטון שבמודעה עכשיו:</div>
              <VideoCard v={info.videos[0]} i={0} rate={rate} currency={currency} />
            </div>
          )}
          {info.kind === 'flexible' && (
            <div className="space-y-1.5 bg-gray-50 rounded p-2">
              <div className="text-gray-600">זו מודעה גמישה ({info.videos.length} סרטונים, {info.images} תמונות) - מטא מציגה לכל אחד את מה שמתאים לו:</div>
              <label className="flex items-center gap-2"><input type="radio" checked={feed === 'add'} onChange={() => setFeed('add')} disabled={busy} /> להוסיף את הסרטון החדש לצד הקיימים</label>
              {info.videos.length > 0 && (
                <label className="flex items-center gap-2"><input type="radio" checked={feed === 'replace'} onChange={() => setFeed('replace')} disabled={busy} /> להחליף אחד מהם - לחצו על הסרטון שמחליפים:</label>
              )}
              <div className="grid sm:grid-cols-2 gap-1.5">
                {info.videos.map((v, i) => (
                  <VideoCard key={v.id} v={v} i={i} rate={rate} currency={currency}
                    selected={feed === 'replace' && replaceVideoId === v.id}
                    onPick={busy ? undefined : () => { setFeed('replace'); setReplaceVideoId(v.id); }} />
                ))}
              </div>
              {info.videos.some(v => v.perf) ? <p className="text-[10px] text-gray-400">הנתונים לפי מטא, לכל סרטון במודעה (30 הימים האחרונים).</p> : null}
            </div>
          )}

          {stage === 'pick' && (
            <div className="flex items-center gap-2 flex-wrap">
              <label className="inline-flex items-center gap-1 bg-white border-2 border-dashed border-blue-300 text-blue-800 font-bold rounded-lg px-3 py-1.5 cursor-pointer hover:bg-blue-50">
                📁 {file ? 'החלפת קובץ' : 'בחירת סרטון מהמחשב / מהטלפון'}
                <input type="file" accept="video/*" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
              </label>
              {file ? <span className="text-gray-700">{file.name} · {(file.size / 1024 / 1024).toFixed(1)}MB</span> : <span className="text-gray-400">קודם בוחרים קובץ, אחר כך "העלאה למטא"</span>}
              <button onClick={upload} disabled={!file} className="inline-flex items-center gap-1 bg-blue-600 text-white font-bold rounded px-3 py-1.5 disabled:opacity-40"><Upload className="w-3.5 h-3.5" /> העלאה למטא</button>
            </div>
          )}
          {stage === 'uploading' && (
            <div className="space-y-1">
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-blue-600" style={{ width: `${progress}%` }} /></div>
              <p className="text-gray-500">מעלה למטא… {progress}% (לא לסגור את הדף)</p>
            </div>
          )}
          {stage === 'processing' && <p className="text-gray-500 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> הסרטון עלה - מטא מעבדת אותו (בדרך כלל דקה-שתיים)…</p>}
          {(stage === 'ready' || stage === 'applying') && (
            <div className="flex items-center gap-2 flex-wrap">
              {thumb && <img src={thumb} alt="" className="w-16 h-16 rounded object-cover" />}
              <span className="text-green-700 font-bold">הסרטון מוכן</span>
              <button onClick={apply} disabled={stage === 'applying'} className="bg-blue-600 text-white font-bold rounded px-3 py-1 disabled:opacity-50">
                {stage === 'applying' ? 'מבצע…' : mode === 'new_ad' ? 'ליצור את המודעה החדשה' : 'להחליף במודעה'}
              </button>
            </div>
          )}
        </>
      )}
      {error && <p className="text-red-700 bg-red-50 rounded p-2">{error}</p>}
    </div>
  );
}
