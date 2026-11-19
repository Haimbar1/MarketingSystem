import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getSession, setSession } from './session';
import AdsSnapshotView from './components/AdsSnapshotView';

type User = { tenantId: string; tenantName?: string | null; email: string; name?: string | null; role?: string | null };
type Tab = 'paid' | 'organic';

const PORTAL_URL = 'https://portal.smartesek.com';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [state, setState] = useState<'loading' | 'in' | 'out'>('loading');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('paid');

  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(location.search);
      const sso = params.get('sso_token');
      if (sso) {
        params.delete('sso_token');
        history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`);
        try {
          const d = await fetch('/api/auth/sso', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: sso }) }).then(r => r.json());
          if (d?.success) { setSession(d.session); setUser(d.user); setState('in'); return; }
          setError(d?.error || 'הכניסה נכשלה');
        } catch { setError('הכניסה נכשלה - בדקו את החיבור לאינטרנט'); }
      }
      if (getSession()) {
        try {
          const r = await fetch('/api/auth/me');
          const d = await r.json();
          if (r.ok && d?.user) { setUser(d.user); setState('in'); return; }
        } catch { /* fall through */ }
        setSession(null);
      }
      setState('out');
    })();
  }, []);

  if (state === 'loading') {
    return <div className="min-h-screen flex items-center justify-center text-gray-500 gap-2"><Loader2 className="w-5 h-5 animate-spin" /> נכנס…</div>;
  }

  if (state === 'out') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" dir="rtl">
        <div className="bg-white rounded-2xl shadow p-6 max-w-sm w-full text-center space-y-3">
          <h1 className="text-xl font-bold text-gray-800">מערכת השיווק</h1>
          {error && <p className="text-sm text-red-700 bg-red-50 rounded-lg p-2">{error}</p>}
          <p className="text-sm text-gray-600">נכנסים דרך הפורטל - בוחרים את העסק ולוחצים על "שיווק".</p>
          <a href={PORTAL_URL} className="inline-block bg-[#075E54] text-white font-bold rounded-lg px-4 py-2">לפורטל</a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" dir="rtl">
      <header className="bg-[#075E54] text-white">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-bold">מערכת השיווק</div>
            <div className="text-xs text-white/80 truncate">{user?.tenantName || `עסק ${user?.tenantId}`} · {user?.name || user?.email}</div>
          </div>
          <a href={PORTAL_URL} className="text-xs text-white/80 hover:text-white shrink-0">לפורטל</a>
        </div>
        <nav className="max-w-6xl mx-auto px-4 flex gap-1">
          {([['paid', '📣 ממומן'], ['organic', '📝 אורגני']] as [Tab, string][]).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`px-4 py-2 text-sm font-bold rounded-t-lg ${tab === id ? 'bg-gray-50 text-[#075E54]' : 'text-white/80 hover:text-white'}`}>{label}</button>
          ))}
        </nav>
      </header>
      <main className="max-w-6xl mx-auto p-3 sm:p-4">
        {tab === 'paid' && <AdsSnapshotView />}
        {tab === 'organic' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 text-sm text-gray-600">
            הפוסטים האורגניים יעברו לכאן ממערכת הוואטסאפ בהדרגה. עד אז הם נשארים שם, במסך הפוסטים.
          </div>
        )}
      </main>
    </div>
  );
}
