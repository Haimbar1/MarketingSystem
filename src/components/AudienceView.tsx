// "👥 קהל: גיל, מגדר ומיקום" in the campaign analysis (Haim, 2026-11-19 - "show the leads' age,
// mainly the buyers'"; "by geographic location?"). The CRM doesn't keep a lead's age, so:
//  - age × gender and region come from Meta's insights for the last 60 days: spend, leads, and the
//    bookings / purchases Meta attributed to the ads (from the pixel and the CRM's Conversions API
//    events - partial: Meta attributes only part of them);
//  - the CRM's own Meta leads of the last 60 days by the lead's city (leads, booked, buyers, revenue) -
//    only leads whose city is known.
import React, { useMemo, useState } from 'react';

type Row = { spend: number; leads: number; booked?: number; purchases?: number };
export type Audience = {
  since: string; until: string;
  ageGender: (Row & { age: string; gender: string })[];
  regions: (Row & { region: string })[];
  crmCities: { city: string; leads: number; booked: number; buyers: number; revenue: number }[] | null;
};

const REGION_HE: Record<string, string> = {
  'Haifa District': 'מחוז חיפה', 'Northern District': 'מחוז הצפון', 'North District': 'מחוז הצפון', 'Central District': 'מחוז המרכז',
  'Center District': 'מחוז המרכז', 'Tel Aviv District': 'מחוז תל אביב', 'Jerusalem District': 'מחוז ירושלים', 'Southern District': 'מחוז הדרום',
  'South District': 'מחוז הדרום', 'Judea and Samaria Area': 'יהודה ושומרון', 'Judea and Samaria': 'יהודה ושומרון', Unknown: 'לא ידוע', unknown: 'לא ידוע',
};
const GENDER_HE: Record<string, string> = { female: 'נשים', male: 'גברים', unknown: 'לא ידוע' };
const dd = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export default function AudienceView({ audience, currency, rate }: { audience: Audience; currency: string; rate: number | null }) {
  const [tab, setTab] = useState<'age' | 'place'>('age');
  const ils = (v: number) => (currency === 'ILS' || !rate ? v : v * rate);
  const shekel = (v: number | null) => (v == null || !isFinite(v) ? '—' : `₪${Math.round(v).toLocaleString('he-IL')}`);

  const ages = useMemo(() => {
    const map = new Map<string, { age: string; spend: number; leads: number; booked: number; purchases: number; women: number; men: number }>();
    for (const r of audience.ageGender || []) {
      const x = map.get(r.age) || { age: r.age, spend: 0, leads: 0, booked: 0, purchases: 0, women: 0, men: 0 };
      x.spend += ils(r.spend); x.leads += r.leads; x.booked += r.booked || 0; x.purchases += r.purchases || 0;
      if (r.gender === 'female') x.women += r.leads; else if (r.gender === 'male') x.men += r.leads;
      map.set(r.age, x);
    }
    return Array.from(map.values()).sort((a, b) => a.age.localeCompare(b.age));
  }, [audience, rate]);
  const genders = useMemo(() => {
    const map = new Map<string, { gender: string; spend: number; leads: number; booked: number; purchases: number }>();
    for (const r of audience.ageGender || []) {
      const x = map.get(r.gender) || { gender: r.gender, spend: 0, leads: 0, booked: 0, purchases: 0 };
      x.spend += ils(r.spend); x.leads += r.leads; x.booked += r.booked || 0; x.purchases += r.purchases || 0;
      map.set(r.gender, x);
    }
    return Array.from(map.values()).sort((a, b) => b.leads - a.leads);
  }, [audience, rate]);
  const regions = useMemo(() => (audience.regions || []).map(r => ({ ...r, spend: ils(r.spend) })).sort((a, b) => b.spend - a.spend).slice(0, 12), [audience, rate]);
  const cities = (audience.crmCities || []).filter(c => c.city !== 'לא ידוע').slice(0, 12);
  const unknownCity = (audience.crmCities || []).find(c => c.city === 'לא ידוע');
  const totalLeads = ages.reduce((t, a) => t + a.leads, 0) || 1;
  const totalSpend = ages.reduce((t, a) => t + a.spend, 0) || 1;
  const anyMetaPurchases = ages.some(a => a.purchases > 0) || regions.some(r => (r.purchases || 0) > 0);

  const th = 'px-2 py-1.5 font-bold text-gray-600 text-right whitespace-nowrap';
  const td = 'px-2 py-1.5 text-gray-800 whitespace-nowrap';
  const share = (part: number, whole: number, color: string) => (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-2 bg-gray-100 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${Math.round((part / whole) * 100)}%`, background: color }} /></div>
      <span className="text-gray-500">{Math.round((part / whole) * 100)}%</span>
    </div>
  );

  return (
    <div className="border border-gray-200 rounded-xl p-3 space-y-2 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-bold text-sm text-gray-800">👥 קהל: גיל, מגדר ומיקום</h4>
          <p className="text-[11px] text-gray-500">60 הימים האחרונים ({dd(audience.since)} עד {dd(audience.until)})</p>
        </div>
        <div className="flex gap-1 text-xs">
          {([['age', 'גיל ומגדר'], ['place', 'מיקום']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`px-3 py-1 rounded-lg font-bold ${tab === k ? 'bg-[#075E54] text-white' : 'bg-gray-100 text-gray-700'}`}>{l}</button>
          ))}
        </div>
      </div>

      {tab === 'age' && (
        <>
          <div className="overflow-x-auto">
            <table className="text-xs w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className={th}>גיל</th><th className={th}>חלק מההוצאה</th><th className={th}>הוצאה</th><th className={th}>חלק מהלידים</th><th className={th}>לידים</th>
                  <th className={th}>עלות לליד</th><th className={th}>נשים / גברים</th><th className={th} title="תורים שמטא שייכה למודעות">תורים*</th><th className={th} title="רכישות שמטא שייכה למודעות">רכישות*</th>
                </tr>
              </thead>
              <tbody>
                {ages.map(a => (
                  <tr key={a.age} className="border-t border-gray-100">
                    <td className={`${td} font-bold`}>{a.age}</td>
                    <td className={td}>{share(a.spend, totalSpend, '#a8a29e')}</td>
                    <td className={td}>{shekel(a.spend)}</td>
                    <td className={td}>{share(a.leads, totalLeads, '#2a78d6')}</td>
                    <td className={td}>{a.leads}</td>
                    <td className={td}>{a.leads ? shekel(a.spend / a.leads) : '—'}</td>
                    <td className={td}>{a.women} / {a.men}</td>
                    <td className={td}>{a.booked || '—'}</td>
                    <td className={td}>{a.purchases || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {genders.length > 0 && (
            <p className="text-[11px] text-gray-600">
              {genders.map(g => `${GENDER_HE[g.gender] || g.gender}: ${g.leads} לידים, ${g.leads ? shekel(g.spend / g.leads) : '—'} לליד`).join(' · ')}
            </p>
          )}
          <p className="text-[10px] text-gray-400">
            * תורים ורכישות כפי שמטא שייכה אותם למודעות (מהאירועים שה-CRM שולח למטא) - רק חלק מהם, ולכן להשוואה בין הגילאים ולא כמספר מדויק.
            {!anyMetaPurchases ? ' עדיין אין רכישות משויכות - מטא משייכת רכישה רק כשהיא נעשתה בתוך חלון השיוך (בדרך כלל 7 ימים מהקליק).' : ''}
            {' '}ב-CRM לא נשמר הגיל של הליד, ולכן אין כאן גיל של הרוכשים מה-CRM.
          </p>
        </>
      )}

      {tab === 'place' && (
        <div className="grid md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <div className="text-[11px] font-bold text-gray-700">לפי אזור - נתוני מטא</div>
            <table className="text-xs w-full">
              <thead className="bg-gray-50"><tr><th className={th}>אזור</th><th className={th}>הוצאה</th><th className={th}>לידים</th><th className={th}>עלות לליד</th><th className={th}>רכישות*</th></tr></thead>
              <tbody>
                {regions.map(r => (
                  <tr key={r.region} className="border-t border-gray-100">
                    <td className={`${td} font-bold`}>{REGION_HE[r.region] || r.region}</td>
                    <td className={td}>{shekel(r.spend)}</td>
                    <td className={td}>{r.leads}</td>
                    <td className={td}>{r.leads ? shekel(r.spend / r.leads) : '—'}</td>
                    <td className={td}>{r.purchases || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-1">
            <div className="text-[11px] font-bold text-gray-700">לפי עיר - לידי Meta ב-CRM</div>
            {audience.crmCities ? (
              <table className="text-xs w-full">
                <thead className="bg-gray-50"><tr><th className={th}>עיר</th><th className={th}>לידים</th><th className={th}>קבעו תור</th><th className={th}>קנו</th><th className={th}>הכנסה</th></tr></thead>
                <tbody>
                  {cities.map(c => (
                    <tr key={c.city} className="border-t border-gray-100">
                      <td className={`${td} font-bold`}>{c.city}</td>
                      <td className={td}>{c.leads}</td>
                      <td className={td}>{c.booked}</td>
                      <td className={td}>{c.buyers}</td>
                      <td className={td}>{shekel(c.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-[11px] text-gray-500">אין נתוני CRM.</p>}
            {unknownCity ? <p className="text-[10px] text-gray-400">ל-{unknownCity.leads} לידים לא ידועה העיר (מתוך {(audience.crmCities || []).reduce((t, c) => t + c.leads, 0)}). העיר נשמרת כשהלקוח מספר לבוט או לנציג איפה הוא גר.</p> : null}
          </div>
        </div>
      )}
    </div>
  );
}
