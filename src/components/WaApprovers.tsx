// "📲 מורשים בוואטסאפ" (Haim, 2026-11-20 - "where do I set the allowed phones?"): who may talk to נועם
// about campaigns on the business's WhatsApp number and approve them (server/campaignChat.ts,
// GET/PUT /api/meta-ads/wa-approval/settings). Opened from the top of "📣 ממומן".
import React, { useEffect, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';

type Approver = { name: string; phone: string };

export default function WaApprovers({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Approver[] | null>(null);
  const [add, setAdd] = useState({ name: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetch('/api/meta-ads/wa-approval/settings').then(r => r.json()).then(d => {
      if (d?.success) setList(d.approvers || []); else { setList([]); setMsg(d?.error || 'לא הצלחנו לקרוא את הרשימה'); }
    }).catch(() => { setList([]); setMsg('שגיאת רשת'); });
  }, []);

  const save = async (next: Approver[]) => {
    setBusy(true); setMsg('');
    const d = await fetch('/api/meta-ads/wa-approval/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvers: next }) }).then(r => r.json()).catch(() => null);
    setBusy(false);
    if (d?.success) { setList(d.approvers || []); setMsg('✓ נשמר'); } else setMsg(d?.error || 'השמירה נכשלה');
  };
  const valid = add.phone.replace(/\D/g, '').length >= 9;

  return (
    <div dir="rtl" className="bg-green-50 border border-green-200 rounded-xl p-3 space-y-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-bold text-gray-800">📲 מורשים בוואטסאפ</div>
          <p className="text-xs text-gray-600">רק המספרים האלה יכולים לבקש מנועם קמפיין חדש במספר הוואטסאפ של העסק, לאשר אותו ולהפעיל אותו. כל מי שלא ברשימה מקבל את הבוט הרגיל.</p>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-white text-gray-500" title="סגור"><X className="w-4 h-4" /></button>
      </div>
      {list === null ? <Loader2 className="w-4 h-4 animate-spin" /> : (
        <div className="space-y-1">
          {list.length === 0 && <p className="text-xs text-gray-500">אין עדיין מורשים.</p>}
          {list.map((a, i) => (
            <div key={a.phone} className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-2 py-1.5 text-xs">
              <span><b>{a.name || 'ללא שם'}</b> · <span dir="ltr">0{a.phone.slice(3)}</span></span>
              <button disabled={busy} onClick={() => { if (window.confirm(`להסיר את ${a.name || a.phone}?`)) save(list.filter((_, j) => j !== i)); }} className="text-red-600 hover:underline disabled:opacity-50">הסר</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <input value={add.name} onChange={e => setAdd({ ...add, name: e.target.value })} placeholder="שם" className="border border-gray-300 rounded px-2 py-1 w-28" />
        <input value={add.phone} onChange={e => setAdd({ ...add, phone: e.target.value })} placeholder="נייד, למשל 050-1234567" inputMode="tel" className="border border-gray-300 rounded px-2 py-1 w-44" />
        <button disabled={!valid || busy || list === null} onClick={() => { save([...(list || []), add]); setAdd({ name: '', phone: '' }); }}
          className="inline-flex items-center gap-1 bg-green-600 hover:bg-green-700 text-white font-bold rounded-lg px-3 py-1 disabled:opacity-50"><Plus className="w-3 h-3" /> הוסף</button>
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {msg && <span className={msg.startsWith('✓') ? 'text-green-700' : 'text-red-700'}>{msg}</span>}
      </div>
      <p className="text-[11px] text-gray-500">איך משתמשים: מהטלפון המורשה שולחים למספר הוואטסאפ של העסק הודעה עם המילה "קמפיין" (למשל "קמפיין חדש לחיפה"). נועם מסכם מה הבין, שואל מה שלא ברור, ובונה טיוטה רק אחרי אישור.</p>
    </div>
  );
}
