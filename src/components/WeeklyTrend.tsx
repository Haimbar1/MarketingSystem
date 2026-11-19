// "המגמה ב-60 הימים האחרונים" in the campaign analysis (Haim, 2026-11-19): per week, the CRM
// dashboard's bottom line (all Meta leads that came in that week, the account's spend that week):
//  1. how many leads,
//  2. cost per lead / per booked exam / per buyer (one ₪ axis - the same unit),
//  3. the return (ROAS = revenue ÷ spend) - weeks whose leads are still buying are marked, the last
//     week is too early to judge.
// Three charts on one shared week axis (no dual axes); one hover highlights the week in all of them
// and shows its numbers. Plain SVG, no chart library.
import React, { useState } from 'react';

export type Week = {
  key: string; since: string; until: string; maturity: 'early' | 'partial' | 'mature';
  spendIls: number | null; leads: number; booked: number; buyers: number; revenue: number;
};

const C = { lead: '#2a78d6', booked: '#eb6834', buyer: '#1baf7a', grid: '#e7e5e4', axis: '#78716c', text: '#1c1917', muted: '#78716c' };
const W = 640, PAD_L = 44, PAD_R = 64, PAD_T = 14;
const dd = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const ils = (v: number | null) => (v == null || !isFinite(v) ? '—' : `₪${Math.round(v).toLocaleString('he-IL')}`);
const per = (spend: number | null, n: number) => (spend != null && n > 0 ? spend / n : null);

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v) || v;
}

export default function WeeklyTrend({ weeks }: { weeks: Week[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const n = weeks.length;
  const plotW = W - PAD_L - PAD_R;
  const band = plotW / n;
  const xc = (i: number) => PAD_L + band * i + band / 2;
  const sel = hover ?? n - 1;
  const w = weeks[sel];

  const yAxis = (max: number, h: number, fmt: (v: number) => string) =>
    [0, 0.5, 1].map(f => {
      const y = PAD_T + h - f * h;
      return (
        <g key={f}>
          <line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} stroke={C.grid} strokeWidth={1} />
          <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize={10} fill={C.muted}>{fmt(max * f)}</text>
        </g>
      );
    });
  const hoverBands = (h: number) =>
    weeks.map((_, i) => (
      <rect key={i} x={PAD_L + band * i} y={PAD_T} width={band} height={h} fill={i === hover ? 'rgba(0,0,0,0.04)' : 'transparent'}
        onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} style={{ cursor: 'pointer' }} />
    ));
  const xLabels = (h: number) =>
    weeks.map((wk, i) => (i % 2 === (n - 1) % 2 || n <= 6 ? (
      <text key={i} x={xc(i)} y={PAD_T + h + 14} textAnchor="middle" fontSize={10} fill={i === sel ? C.text : C.muted}>{dd(wk.since)}</text>
    ) : null));

  // 1. leads
  const H1 = 110;
  const leadMax = niceMax(Math.max(...weeks.map(x => x.leads)));
  // 2. costs
  const H2 = 150;
  const costs = weeks.map(x => ({ lead: per(x.spendIls, x.leads), booked: per(x.spendIls, x.booked), buyer: per(x.spendIls, x.buyers) }));
  const costMax = niceMax(Math.max(1, ...costs.flatMap(c => [c.lead, c.booked, c.buyer]).filter((v): v is number => v != null)));
  const yCost = (v: number) => PAD_T + H2 - (v / costMax) * H2;
  const path = (key: 'lead' | 'booked' | 'buyer') => {
    let d = '';
    costs.forEach((c, i) => {
      const v = c[key];
      if (v == null) return;
      d += `${d && costs[i - 1]?.[key] != null ? 'L' : 'M'}${xc(i).toFixed(1)},${yCost(v).toFixed(1)}`;
    });
    return d;
  };
  const SERIES = [
    { key: 'lead' as const, label: 'עלות לליד', color: C.lead },
    { key: 'booked' as const, label: 'עלות לתור', color: C.booked },
    { key: 'buyer' as const, label: 'עלות לרוכש', color: C.buyer },
  ];
  // 3. ROAS
  const H3 = 110;
  const roas = weeks.map(x => (x.spendIls ? x.revenue / x.spendIls : null));
  const roasMax = niceMax(Math.max(1.5, ...roas.filter((v): v is number => v != null)));
  const yRoas = (v: number) => PAD_T + H3 - (v / roasMax) * H3;
  const barW = Math.min(28, band * 0.55);

  const lastVal = (key: 'lead' | 'booked' | 'buyer') => {
    for (let i = n - 1; i >= 0; i--) if (costs[i][key] != null) return { i, v: costs[i][key]! };
    return null;
  };
  // direct end labels, nudged apart so they never overlap
  const ends = SERIES.map(s => ({ ...s, end: lastVal(s.key) })).filter(s => s.end) as (typeof SERIES[number] & { end: { i: number; v: number } })[];
  const placed = ends.map(s => ({ ...s, y: yCost(s.end.v) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < placed.length; k++) if (placed[k].y - placed[k - 1].y < 12) placed[k].y = placed[k - 1].y + 12;

  const maturityNote = (m: Week['maturity']) => (m === 'early' ? 'מוקדם מדי לדעת' : m === 'partial' ? 'רכישות עוד מגיעות' : '');

  return (
    <div className="border border-gray-200 rounded-xl p-3 space-y-2 bg-white">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="font-bold text-sm text-gray-800">המגמה ב-60 הימים האחרונים (לפי שבוע)</h4>
          <p className="text-[11px] text-gray-500">כל לידי Meta שנכנסו בכל שבוע וההוצאה של כל הקמפיינים - כמו בדשבורד של ה-CRM</p>
        </div>
        <button onClick={() => setAsTable(t => !t)} className="text-[11px] text-gray-600 border border-gray-300 rounded-lg px-2 py-1 hover:bg-gray-50 shrink-0">
          {asTable ? 'הצג כגרף' : 'הצג כטבלה'}
        </button>
      </div>

      {/* the hovered (else the latest) week's numbers */}
      <div className="text-[11px] bg-gray-50 rounded-lg px-2 py-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-gray-700">
        <b className="text-gray-900">שבוע {dd(w.since)}–{dd(w.until)}</b>
        <span>{w.leads} לידים</span>
        <span>הוצאה {ils(w.spendIls)}</span>
        <span><span style={{ color: C.lead }}>●</span> {ils(per(w.spendIls, w.leads))} לליד</span>
        <span><span style={{ color: C.booked }}>●</span> {w.booked} קבעו · {ils(per(w.spendIls, w.booked))} לתור</span>
        <span><span style={{ color: C.buyer }}>●</span> {w.buyers} קנו · {ils(per(w.spendIls, w.buyers))} לרוכש</span>
        <span>הכנסה {ils(w.revenue)} · החזר {w.spendIls ? `${(w.revenue / w.spendIls).toFixed(1)}x` : '—'}{maturityNote(w.maturity) ? ` (${maturityNote(w.maturity)})` : ''}</span>
      </div>

      {asTable ? (
        <div className="overflow-x-auto">
          <table className="text-xs w-full">
            <thead className="bg-gray-50 text-gray-600">
              <tr>{['שבוע', 'לידים', 'הוצאה', 'עלות לליד', 'קבעו תור', 'עלות לתור', 'קנו', 'עלות לרוכש', 'הכנסה', 'החזר'].map(h => <th key={h} className="px-2 py-1 text-right font-bold whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {weeks.map(x => (
                <tr key={x.key} className="border-t border-gray-100">
                  <td className="px-2 py-1 whitespace-nowrap">{dd(x.since)}–{dd(x.until)}</td>
                  <td className="px-2 py-1">{x.leads}</td>
                  <td className="px-2 py-1">{ils(x.spendIls)}</td>
                  <td className="px-2 py-1">{ils(per(x.spendIls, x.leads))}</td>
                  <td className="px-2 py-1">{x.booked}</td>
                  <td className="px-2 py-1">{ils(per(x.spendIls, x.booked))}</td>
                  <td className="px-2 py-1">{x.buyers}</td>
                  <td className="px-2 py-1">{ils(per(x.spendIls, x.buyers))}</td>
                  <td className="px-2 py-1">{ils(x.revenue)}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{x.spendIls ? `${(x.revenue / x.spendIls).toFixed(1)}x` : '—'} <span className="text-gray-400">{maturityNote(x.maturity)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div dir="ltr" onMouseLeave={() => setHover(null)}>
          {/* 1. leads per week */}
          <div className="text-[11px] font-bold text-gray-700 text-right" dir="rtl">כמות לידים</div>
          <svg viewBox={`0 0 ${W} ${PAD_T + H1 + 20}`} className="w-full" role="img" aria-label="כמות לידים לשבוע">
            {yAxis(leadMax, H1, v => String(Math.round(v)))}
            {weeks.map((x, i) => {
              const h = (x.leads / leadMax) * H1;
              return <rect key={i} x={xc(i) - barW / 2} y={PAD_T + H1 - h} width={barW} height={Math.max(h, 0)} rx={4} fill={C.lead} opacity={hover == null || i === hover ? 1 : 0.45} />;
            })}
            {weeks.map((x, i) => (i === sel ? <text key={i} x={xc(i)} y={PAD_T + H1 - (x.leads / leadMax) * H1 - 4} textAnchor="middle" fontSize={10} fill={C.text}>{x.leads}</text> : null))}
            {xLabels(H1)}
            {hoverBands(H1)}
          </svg>

          {/* 2. cost per lead / booked / buyer */}
          <div className="flex flex-wrap items-center justify-end gap-3 text-[11px] text-gray-700" dir="rtl">
            <b>עלות לליד / לתור / לרוכש</b>
            {SERIES.map(s => <span key={s.key} className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 rounded" style={{ background: s.color, height: 2 }} />{s.label}</span>)}
          </div>
          <svg viewBox={`0 0 ${W} ${PAD_T + H2 + 20}`} className="w-full" role="img" aria-label="עלות לליד, לתור ולרוכש לשבוע">
            {yAxis(costMax, H2, v => `₪${Math.round(v)}`)}
            {SERIES.map(s => <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
            {SERIES.map(s => costs.map((c, i) => (c[s.key] != null ? (
              <circle key={`${s.key}${i}`} cx={xc(i)} cy={yCost(c[s.key]!)} r={i === sel ? 4.5 : 3} fill={s.color} stroke="#fff" strokeWidth={2} />
            ) : null)))}
            {placed.map(s => <text key={s.key} x={xc(s.end.i) + 8} y={s.y + 3} fontSize={10} fill={C.text}>{ils(s.end.v)}</text>)}
            {xLabels(H2)}
            {hoverBands(H2)}
          </svg>

          {/* 3. ROAS */}
          <div className="flex flex-wrap items-center justify-end gap-3 text-[11px] text-gray-700" dir="rtl">
            <b>החזר על ההוצאה (הכנסה ÷ הוצאה)</b>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: C.buyer }} />הבשיל</span>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: C.buyer, opacity: 0.35 }} />רכישות עוד מגיעות</span>
          </div>
          <svg viewBox={`0 0 ${W} ${PAD_T + H3 + 20}`} className="w-full" role="img" aria-label="החזר על ההוצאה לשבוע">
            {yAxis(roasMax, H3, v => `${v.toFixed(v < 10 ? 1 : 0)}x`)}
            <line x1={PAD_L} x2={W - PAD_R} y1={yRoas(1)} y2={yRoas(1)} stroke={C.axis} strokeWidth={1} strokeDasharray="4 3" />
            <text x={PAD_L + 4} y={yRoas(1) - 4} fontSize={10} fill={C.muted}>1x</text>
            {weeks.map((x, i) => {
              const v = roas[i];
              if (x.maturity === 'early') return <text key={i} x={xc(i)} y={Math.min(yRoas(1), PAD_T + H3) - 10} textAnchor="middle" fontSize={10} fill={C.muted}>מוקדם</text>;
              if (v == null) return null;
              const h = (v / roasMax) * H3;
              return <rect key={i} x={xc(i) - barW / 2} y={PAD_T + H3 - h} width={barW} height={Math.max(h, 0)} rx={4} fill={C.buyer} opacity={x.maturity === 'partial' ? 0.35 : hover == null || i === hover ? 1 : 0.55} />;
            })}
            {weeks.map((x, i) => (i === sel && roas[i] != null && x.maturity !== 'early' ? <text key={i} x={xc(i)} y={yRoas(roas[i]!) - 4} textAnchor="middle" fontSize={10} fill={C.text}>{roas[i]!.toFixed(1)}x</text> : null))}
            {xLabels(H3)}
            {hoverBands(H3)}
          </svg>
          <p className="text-[10px] text-gray-400 text-right" dir="rtl">התאריך מתחת לכל עמודה = תחילת השבוע. הקו המקווקו = 1x (ההכנסה שווה להוצאה). לידים מהשבועות האחרונים עוד קונים, לכן ההחזר שלהם עוד יעלה.</p>
        </div>
      )}
    </div>
  );
}
