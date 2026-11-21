// Building a campaign as a conversation, and approving it through נועם on WhatsApp (Haim, 2026-11-20:
// "the build is a discussion - ask when something is unclear and first show what you understood until
// the client approves, because every build takes time"; "add approval through נועם on WhatsApp").
//
// 1. The brief (`mk_briefs`): every message of the business owner gets a cheap AI turn that answers
//    "this is what I understood" + up to 3 questions about what's unclear. Nothing is built yet.
//    Only when the previous turn was `ready` (everything clear, the summary shown) and the owner
//    confirms, the draft is built (`createDraft` with the agreed points) - the slow part, once.
// 2. The draft is reviewed (the app's screen, or its summary on WhatsApp with "✅ מאשר להעלות"),
//    changed in words ("תקציב 50", "להוסיף את נשר") without rebuilding, then uploaded PAUSED, and
//    "▶️ להפעיל" turns it on - each step only after the owner said so.
//
// WhatsApp: the business's approvers (`mk_wa_settings.approvers` - name + phone, set in the app) talk
// to the business's own WhatsApp number. BotApp (the bot נועם) asks GET /api/bot/approvers which
// numbers are approvers, and passes their messages to POST /api/bot/owner-message (`x-bot-token`, JWT
// with SSO_SHARED_SECRET, typ 'marketing-bot', portalTenantId). Here it's decided whether the message
// is about a campaign (`handled`) - if not, the bot answers it as usual. Answers go out through
// BotApp's POST /api/marketing/notify (the business's WhatsApp number, buttons). Outside Meta's 24h
// window (the approver hasn't written to the number in the last 23h) a free message can't be sent, so
// the business's alert template goes out ("השיבו כאן כדי לראות") and the full message waits for the
// reply (`prompt.kind = 'show'`).
import express from 'express';
import jwt from 'jsonwebtoken';
import { db, ensureTables } from './db.js';
import { aiJson } from './ai.js';
import { currentTenant, currentUser, runWithTenant, OPTICS_TENANT } from './tenant.js';
import { adsCredsForCurrentBusiness } from './metaAdsSnapshot.js';
import { listBases, createDraft, publishDraft, readBase, contextOf, cleanDraft, draftProblems, searchPlaces, KIND_HE, type Draft, type Kind } from './campaignBuilder.js';
import { manualChange, parseJson, crmOutcomes, israelToday, shiftDay } from './campaignOptimizer.js';

const BOTAPP_URL = (process.env.BOTAPP_URL || 'https://app.smartesek.com').replace(/\/$/, '');
const WA_URL = (process.env.WHATSAPP_URL || 'https://whatsapp.smartesek.com').replace(/\/$/, '');
const OPTICS_ALERT_TEMPLATE = 'optica_template_545_copy_3286'; // name / phone / content - the optics' WABA only
const FRESH_MS = 72 * 3600 * 1000; // a question / prompt older than this is forgotten
const WINDOW_MS = 23 * 3600 * 1000; // Meta's 24h window, with a margin
// a message that starts a campaign conversation on WhatsApp when nothing is open
const MARKETING_RE = /קמפיין|ממומן|מודע(?:ה|ות)\s|פרסו?ם\s?ב?(?:פייסבוק|אינסטגרם|מטא)|תקציב\s?(?:פרסום|יומי)/;
const YES_RE = /^\s*(?:✅\s*)?(?:כן|מאשר|מאשרת|אישור|מאושר|יאללה|סבבה|אוקיי|אוקי|ok|okay|בסדר|תעלה|תעלי|לבנות|תבנה|תבני|להפעיל|תפעיל|תפעילי|קדימה|נכון)(?=[\s!.,]|$)[\s!.,]*$/i;
const NO_RE = /^\s*(?:❌\s*)?(?:לא|ביטול|בטל|בטלי|לא עכשיו|עזוב|עזבי|תעצור|stop)(?=[\s!.,]|$)[\s!.,]*$/i;

const last9 = (p: unknown) => String(p || '').replace(/\D/g, '').slice(-9);
const intl = (p: unknown) => { const n = last9(p); return n.length === 9 ? `972${n}` : ''; };
const who = () => currentUser()?.email || 'unknown';

type Button = { id: string; title: string };
type ListRow = { id: string; title: string; description?: string };
type OutMsg = { text: string; buttons?: Button[]; list?: { button: string; rows: ListRow[] } };
type Approver = { name: string; phone: string };

let tablesReady = false;
async function ensureChatTables() {
  const p = await ensureTables();
  if (tablesReady) return p;
  await p.query(`CREATE TABLE IF NOT EXISTS mk_briefs (
    id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, channel TEXT NOT NULL, phone TEXT, created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'talking', messages JSONB NOT NULL DEFAULT '[]'::jsonb, understood JSONB,
    ready BOOLEAN NOT NULL DEFAULT false, base_campaign_id TEXT, draft_id BIGINT)`);
  await p.query(`CREATE TABLE IF NOT EXISTS mk_wa_settings (
    tenant_id TEXT PRIMARY KEY, approvers JSONB NOT NULL DEFAULT '[]'::jsonb, template TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT)`);
  await p.query(`CREATE TABLE IF NOT EXISTS mk_wa_threads (
    tenant_id TEXT NOT NULL, phone9 TEXT NOT NULL, last_inbound_at TIMESTAMPTZ, prompt JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, phone9))`);
  await p.query(`CREATE TABLE IF NOT EXISTS mk_stats_cache (
    tenant_id TEXT NOT NULL, key TEXT NOT NULL, data JSONB NOT NULL, computed_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, key))`);
  tablesReady = true;
  return p;
}

// ---------- settings ----------

async function getSettings(): Promise<{ approvers: Approver[]; template: string }> {
  const p = await ensureChatTables();
  const r = await p.query(`SELECT approvers, template FROM mk_wa_settings WHERE tenant_id = $1`, [currentTenant()]);
  const row = r.rows[0];
  return {
    approvers: Array.isArray(row?.approvers) ? row.approvers : [],
    template: row?.template || (currentTenant() === OPTICS_TENANT ? OPTICS_ALERT_TEMPLATE : ''),
  };
}

// ---------- the thread with one approver (the 24h window, the question waiting for an answer) ----------

async function thread(phone: string): Promise<{ last_inbound_at: Date | null; prompt: any }> {
  const p = await ensureChatTables();
  const r = await p.query(`SELECT last_inbound_at, prompt FROM mk_wa_threads WHERE tenant_id = $1 AND phone9 = $2`, [currentTenant(), last9(phone)]);
  return r.rows[0] || { last_inbound_at: null, prompt: null };
}
async function setPrompt(phone: string, prompt: any) {
  const p = await ensureChatTables();
  await p.query(
    `INSERT INTO mk_wa_threads (tenant_id, phone9, prompt) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (tenant_id, phone9) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = now()`,
    [currentTenant(), last9(phone), prompt ? JSON.stringify({ ...prompt, at: new Date().toISOString() }) : null],
  );
}
async function noteInbound(phone: string) {
  const p = await ensureChatTables();
  await p.query(
    `INSERT INTO mk_wa_threads (tenant_id, phone9, last_inbound_at) VALUES ($1, $2, now())
     ON CONFLICT (tenant_id, phone9) DO UPDATE SET last_inbound_at = now(), updated_at = now()`,
    [currentTenant(), last9(phone)],
  );
}
const fresh = (prompt: any) => prompt?.at && Date.now() - new Date(prompt.at).getTime() < FRESH_MS;

// ---------- sending to an approver ----------

async function viaBotApp(phone: string, messages: OutMsg[]): Promise<{ ok: boolean; error?: string }> {
  const secret = process.env.SSO_SHARED_SECRET;
  if (!secret) return { ok: false, error: 'חסר SSO_SHARED_SECRET' };
  const token = jwt.sign({ typ: 'marketing-notify', portalTenantId: currentTenant() }, secret, { expiresIn: '2m' });
  try {
    const r = await fetch(`${BOTAPP_URL}/api/marketing/notify`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-marketing-token': token },
      body: JSON.stringify({ phone: intl(phone), messages }), signal: AbortSignal.timeout(20000),
    });
    const d: any = await r.json().catch(() => ({}));
    return d?.success ? { ok: true } : { ok: false, error: d?.error || `BotApp ${r.status}` };
  } catch (e: any) {
    return { ok: false, error: `BotApp: ${e?.message || e}` };
  }
}

async function viaTemplate(phone: string, template: string, content: string): Promise<{ ok: boolean; error?: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (currentTenant() !== OPTICS_TENANT) {
    const secret = process.env.SSO_SHARED_SECRET;
    if (!secret) return { ok: false, error: 'חסר SSO_SHARED_SECRET' };
    headers['x-wa-session'] = jwt.sign({ tenantId: currentTenant(), email: 'marketing@smartesek.com', role: 'crm', typ: 'wa_session' }, secret, { expiresIn: '5m' });
  }
  const param = (t: string) => t.replace(/[\n\r\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  try {
    const r = await fetch(`${WA_URL}/api/meta/send-template`, {
      method: 'POST', headers,
      body: JSON.stringify({ to: intl(phone), templateName: template, languageCode: 'he', parameters: ['נועם · מערכת השיווק', '-', param(content).slice(0, 900)] }),
      signal: AbortSignal.timeout(20000),
    });
    const d: any = await r.json().catch(() => ({}));
    return d?.success ? { ok: true } : { ok: false, error: typeof d?.error === 'string' ? d.error : `WhatsApp ${r.status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// To an approver: a free message inside the 24h window, else the template + the message waits for the reply
// "📈 מצב הקמפיינים" on every message נועם sends an approver (Haim, 2026-11-21 - "a button to ask what's
// my campaign's state - also in the other conversations"): a row in a list, else a third / added button
const STATUS_ROW = { id: 'mk_q_status', title: '📈 מצב הקמפיינים', description: 'מה רץ עכשיו ואיך הולך ב-7 הימים האחרונים' };
function withStatusButton(messages: OutMsg[]): OutMsg[] {
  if (!messages.length) return messages;
  const out = messages.map(m => ({ ...m }));
  const last = out[out.length - 1];
  const has = (id: string) => last.list?.rows.some(r => r.id === id) || last.buttons?.some(b => b.id === id);
  if (has(STATUS_ROW.id)) return out;
  if (last.list) { if (last.list.rows.length < 10) last.list = { ...last.list, rows: [STATUS_ROW, ...last.list.rows] }; }
  else if (last.buttons?.length) { if (last.buttons.length < 3) last.buttons = [...last.buttons, { id: STATUS_ROW.id, title: STATUS_ROW.title }]; }
  else last.buttons = [{ id: STATUS_ROW.id, title: STATUS_ROW.title }, { id: 'mk_menu', title: '📋 עוד שאלות' }];
  return out;
}

export async function sendToOwner(phone: string, messagesIn: OutMsg[], shortLine: string, prompt?: any): Promise<{ ok: boolean; via?: string; error?: string }> {
  const messages = withStatusButton(messagesIn);
  const th = await thread(phone);
  const inWindow = th.last_inbound_at && Date.now() - new Date(th.last_inbound_at).getTime() < WINDOW_MS;
  if (inWindow) {
    const r = await viaBotApp(phone, messages);
    if (r.ok && prompt !== undefined) await setPrompt(phone, prompt);
    return { ...r, via: 'message' };
  }
  const { template } = await getSettings();
  if (!template) return { ok: false, error: 'לא כתב/ה למספר של הבוט ב-24 השעות האחרונות, ולעסק אין תבנית התראה - שיכתוב/תכתוב "קמפיין" למספר הוואטסאפ של העסק, ואז לשלוח שוב' };
  const r = await viaTemplate(phone, template, `${shortLine} - השיבו כאן כל הודעה כדי לראות ולאשר`);
  if (r.ok) await setPrompt(phone, { kind: 'show', pending: messages, then: prompt || null });
  return { ...r, via: 'template' };
}

// ---------- texts ----------

const GENDER_HE: Record<string, string> = { female: 'נשים', male: 'גברים', all: 'כולם' };

export function draftSummary(id: number, d: Draft, ctx: any, problems: string[]): OutMsg {
  const places = d.places?.length
    ? d.places.map(p => `${p.name}${p.radiusKm ? ` +${p.radiusKm} ק"מ` : ''}`).join(', ')
    : `כמו בבסיס (${(ctx.baseTargeting?.places || []).join(', ') || '—'})`;
  const age = d.ageMin || d.ageMax ? `${d.ageMin || 18}–${d.ageMax || 65}` : `כמו בבסיס (${ctx.baseTargeting?.age || '—'})`;
  const lines = [
    `✨ *טיוטת קמפיין: ${d.name}*`,
    `• מבוסס על: "${ctx.baseName}" (${ctx.bestLeads30} לידים ב-30 יום)`,
    `• סוג: *${d.kind && d.kind !== ctx.kind ? `${KIND_HE[d.kind as Kind]}* (במקום ${KIND_HE[ctx.kind as Kind] || 'הבסיס'})` : `${KIND_HE[ctx.kind as Kind] || 'כמו בבסיס'}*`}`,
    `• תקציב: *₪${d.dailyBudgetIls} ליום*`,
    `• מיקום: ${places}`,
    `• גיל: ${age}${d.genders ? ` · ${GENDER_HE[d.genders]}` : ''}`,
    `• מודעות: ${ctx.baseAds?.length || 0}${d.media.length ? ` עם ${d.media.length} תמונות / סרטונים חדשים` : ' עם התמונות / הסרטונים של הבסיס'}`,
    '',
    `*טקסט ראשי:* ${d.texts.bodies[0] || '—'}`,
    d.texts.titles.length ? `*כותרות:* ${d.texts.titles.join(' · ')}` : '',
    d.waPrefill ? `*בוואטסאפ הלקוח שולח:* ${d.waPrefill}` : '',
    d.waWelcome ? `*הודעת פתיחה:* ${d.waWelcome}` : '',
  ].filter(l => l !== '');
  if (problems.length) {
    lines.push('', '⚠️ *צריך לתקן לפני העלאה:*', ...problems.map(p => `• ${p}`), '', 'כתבו לי מה לשנות.');
    return { text: lines.join('\n') };
  }
  lines.push('', 'אפשר לכתוב לי מה לשנות (למשל "תקציב 50", "להוסיף את נשר"), או לאשר. הקמפיין יעלה *מושהה* - שום כסף לא יוצא עד שתפעילו.');
  return { text: lines.join('\n'), buttons: [{ id: `mk_pub_${id}`, title: '✅ מאשר להעלות' }, { id: `mk_no_${id}`, title: '❌ לא עכשיו' }] };
}

// ---------- the brief: what was understood, questions, and building only after a yes ----------

const BRIEF_SYSTEM = `אתה נועם, העוזר השיווקי של העסק. בעל העסק מתאר קמפיין חדש במטא (פייסבוק / אינסטגרם). עדיין לא בונים - קודם מבינים.
בכל תשובה: מסכמים בקצרה מה הבנת עד עכשיו, ושואלים רק על מה שבאמת לא ברור או סותר (עד 3 שאלות, החשובה ראשונה).
מה צריך להיות ברור לפני בנייה:
- על בסיס איזה קמפיין (מהרשימה bases; אם לא נאמר - הקמפיין עם הכי הרבה לידים, ותגיד את זה).
- סוג הקמפיין = לאן המודעה מובילה (kind): lead_form = טופס לידים בפייסבוק, whatsapp = שיחה בוואטסאפ של העסק (הבוט עונה), website = אתר. תמיד לכתוב בסיכום את הסוג. אם בעל העסק מבקש סוג אחר מ-base.kind (למשל "וואטסאפ" כשהבסיס טופס לידים) - להגיד את זה במפורש: אם יש ב-bases קמפיין מהסוג שביקש - להציע אותו כבסיס (understood.baseCampaignId); אחרת - להגיד שנבנה כמו הבסיס אבל המודעות יובילו לוואטסאפ (understood.kind = "whatsapp"), ושזה הקמפיין הראשון כזה ונבדוק אותו בהעלאה. מעבר לטופס לידים אפשר רק מבסיס של טופס לידים. השם של הקמפיין לא קובע את הסוג.
- איפה (ערים / אזורים, רדיוס אם נאמר). אם לא נאמר - כמו בבסיס, ותגיד מה זה.
- תקציב יומי בשקלים. אם לא נאמר - כמו בבסיס (base.baseDailyIls), ותגיד.
- גיל / מגדר - רק אם נאמר משהו או שזה חשוב להצעה.
- מה המסר / ההצעה (מחיר, מבצע, מה להדגיש). אם לא נאמר - כמו בטקסטים של הבסיס.
- מדיה: התמונות / הסרטונים של הבסיס, או חדשים (חדשים מעלים באפליקציה, במסך הטיוטה).
אל תשאל על דברים שיש להם ברירת מחדל סבירה - פשוט תכתוב "כמו בבסיס: ...". אל תמציא מחירים או הבטחות.
ready = true רק כשאין שאלה פתוחה. אז הסיכום מסתיים ב"לבנות את הטיוטה?".
build = true רק כשבעל העסק מאשר עכשיו לבנות (כן / מאשר / תבנה) ואין שום שינוי בהודעה שלו.
cancel = true כשהוא מבקש לעזוב / לבטל את הקמפיין.
offTopic = true כשההודעה בכלל לא קשורה לקמפיין (למשל שאלה של לקוח, בדיקה של הבוט).
reply: קצר, עברית טבעית, בלי מגדר, מתאים לוואטסאפ: *מודגש* לכותרות, "•" לרשימות.
החזר JSON בלבד: { "reply", "understood": { "baseCampaignId", "baseCampaignName", "kind" ("whatsapp"|"lead_form"|null = כמו בבסיס), "places": [{ "name", "radiusKm" }] או null, "dailyBudgetIls" או null, "ageMin", "ageMax", "genders" ("all"|"female"|"male"|null), "offer", "emphasis", "media", "other" }, "questions": [], "ready", "build", "cancel", "offTopic" }`;

type Brief = { id: number; status: string; messages: { role: 'owner' | 'bot'; text: string; at: string }[]; understood: any; ready: boolean; base_campaign_id: string | null; draft_id: number | null; channel: string; phone: string | null };

async function loadBrief(id: number): Promise<Brief | null> {
  const p = await ensureChatTables();
  const r = await p.query(`SELECT * FROM mk_briefs WHERE id = $1 AND tenant_id = $2`, [id, currentTenant()]);
  return r.rows[0] ? { ...r.rows[0], id: Number(r.rows[0].id), draft_id: r.rows[0].draft_id ? Number(r.rows[0].draft_id) : null } : null;
}

async function openWaBrief(phone: string): Promise<Brief | null> {
  const p = await ensureChatTables();
  const r = await p.query(
    `SELECT id FROM mk_briefs WHERE tenant_id = $1 AND channel = 'whatsapp' AND phone = $2 AND status = 'talking' AND updated_at > now() - interval '72 hours' ORDER BY id DESC LIMIT 1`,
    [currentTenant(), last9(phone)],
  );
  return r.rows[0] ? loadBrief(Number(r.rows[0].id)) : null;
}

export type BriefTurn = { success: boolean; error?: string; briefId?: number; reply?: string; understood?: any; questions?: string[]; ready?: boolean; build?: boolean; cancel?: boolean; offTopic?: boolean; messages?: Brief['messages'] };

// One turn of the conversation. Nothing is built here.
export async function briefTurn(input: { briefId?: number | null; text: string; channel: 'app' | 'whatsapp'; phone?: string; baseCampaignId?: string }): Promise<BriefTurn> {
  if (!db()) return { success: false, error: 'צריך מסד נתונים (DATABASE_URL)' };
  const text = String(input.text || '').trim().slice(0, 2000);
  if (!text) return { success: false, error: 'כתבו מה הקמפיין צריך להיות' };
  const creds = await adsCredsForCurrentBusiness();
  if (!creds) return { success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' };
  const p = await ensureChatTables();
  let brief = input.briefId ? await loadBrief(Number(input.briefId)) : null;
  if (brief && brief.status !== 'talking') brief = null; // a built / closed one isn't continued
  const bases = await listBases();
  if (!bases?.success) return { success: false, error: bases?.error || 'לא הצלחנו לקרוא את הקמפיינים' };
  const baseId = String(input.baseCampaignId || brief?.understood?.baseCampaignId || brief?.base_campaign_id || bases.campaigns[0]?.id || '').replace(/\D/g, '');
  let base: any = null;
  if (baseId) {
    try { base = contextOf(await readBase(creds, baseId)); } catch (e: any) { base = { error: e?.message }; }
  }
  const history = brief?.messages || [];
  const ai = await aiJson(BRIEF_SYSTEM, JSON.stringify({
    today: new Date().toISOString().slice(0, 10),
    bases: bases.campaigns.slice(0, 10).map((c: any) => ({ id: c.id, name: c.name, kind: c.kind, leads30: c.leads30, spend30: c.spend30, status: c.status })),
    base: base && !base.error ? { id: baseId, name: base.baseName, kind: base.kind, adset: base.baseAdsetName, dailyIls: base.baseDailyIls, targeting: base.baseTargeting, texts: base.baseAds?.map((a: any) => a.bodies?.[0]).filter(Boolean).slice(0, 3) } : null,
    understoodSoFar: brief?.understood || null,
    lastSummaryWasReady: !!brief?.ready,
    conversation: history.slice(-16),
    newMessage: text,
  }), 'שיחה על קמפיין חדש', text.slice(0, 80));
  if (!ai.text) return { success: false, error: `ה-AI לא ענה: ${ai.error}` };
  const out = parseJson(ai.text);
  if (!out || typeof out.reply !== 'string') return { success: false, error: 'ה-AI החזיר תשובה לא קריאה - נסו שוב' };
  if (out.offTopic && !brief) return { success: true, offTopic: true };
  const now = new Date().toISOString();
  // build only after the summary was shown as ready AND the owner says yes now
  const build = !!out.build && !!brief?.ready;
  const ready = !!out.ready && !(out.questions || []).length;
  const understood = out.understood && typeof out.understood === 'object' ? out.understood : brief?.understood || null;
  if (understood && !understood.baseCampaignId && baseId) understood.baseCampaignId = baseId;
  const messages = [...history, { role: 'owner' as const, text, at: now }, ...(build || out.offTopic ? [] : [{ role: 'bot' as const, text: out.reply, at: now }])];
  const status = out.cancel ? 'closed' : 'talking';
  let id = brief?.id;
  if (brief) {
    await p.query(`UPDATE mk_briefs SET messages = $2::jsonb, understood = $3::jsonb, ready = $4, status = $5, base_campaign_id = $6, updated_at = now() WHERE id = $1`,
      [brief.id, JSON.stringify(messages), JSON.stringify(understood), build ? true : ready, status, String(understood?.baseCampaignId || baseId || '') || null]);
  } else {
    const ins = await p.query(
      `INSERT INTO mk_briefs (tenant_id, channel, phone, created_by, messages, understood, ready, base_campaign_id, status) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9) RETURNING id`,
      [currentTenant(), input.channel, input.phone ? last9(input.phone) : null, who(), JSON.stringify(messages), JSON.stringify(understood), ready, String(understood?.baseCampaignId || baseId || '') || null, status],
    );
    id = Number(ins.rows[0].id);
  }
  return { success: true, briefId: id, reply: out.reply, understood, questions: Array.isArray(out.questions) ? out.questions.slice(0, 3) : [], ready, build, cancel: !!out.cancel, offTopic: !!out.offTopic, messages };
}

// The slow part, once: the draft from the agreed points
export async function buildFromBrief(briefId: number): Promise<any> {
  const brief = await loadBrief(briefId);
  if (!brief) return { success: false, error: 'השיחה לא נמצאה' };
  if (brief.draft_id) return { success: false, error: 'הטיוטה כבר נבנתה', draftId: brief.draft_id };
  const instruction = brief.messages.map(m => `${m.role === 'owner' ? 'בעל העסק' : 'נועם'}: ${m.text}`).join('\n').slice(-6000);
  const out = await createDraft({ instruction, baseCampaignId: brief.understood?.baseCampaignId || brief.base_campaign_id || undefined, understood: brief.understood });
  if (out?.success) {
    const p = await ensureChatTables();
    await p.query(`UPDATE mk_briefs SET status = 'built', draft_id = $2, updated_at = now() WHERE id = $1`, [briefId, out.id]);
  }
  return out;
}

// ---------- changing a draft in words (WhatsApp) - no rebuild ----------

const EDIT_SYSTEM = `בעל העסק ענה על סיכום טיוטת קמפיין או על שאלת "להפעיל?". סווג את ההודעה.
intent: "confirm" (מאשר את מה שנשאל), "decline" (לא עכשיו / לא לאשר), "edit" (רוצה לשנות משהו בטיוטה), "new" (רוצה קמפיין אחר / חדש), "other" (לא קשור לקמפיין).
edits (רק ב-edit, רק מה שנאמר): { "kind" ("whatsapp" | "lead_form"), "waPrefill" (מה הלקוח שולח בוואטסאפ), "waWelcome" (הודעת הפתיחה), "waQuickReplies": [כפתורים], "dailyBudgetIls", "ageMin", "ageMax", "genders" ("all"|"female"|"male"), "advantageAudience" (true/false), "addPlaces": [{ "name", "radiusKm" }], "removePlaces": [שמות], "name", "bodies": [טקסטים חדשים], "titles": [כותרות חדשות] }.
החזר JSON בלבד: { "intent", "edits" }`;

async function classifyAnswer(text: string, prompt: any, draft: Draft | null): Promise<{ intent: string; edits?: any }> {
  if (YES_RE.test(text)) return { intent: 'confirm' };
  if (NO_RE.test(text)) return { intent: 'decline' };
  const ai = await aiJson(EDIT_SYSTEM, JSON.stringify({ asked: prompt?.kind === 'act' ? 'להפעיל את הקמפיין?' : 'לאשר ולהעלות את הטיוטה?', draft, message: text }), 'אישור קמפיין בוואטסאפ', text.slice(0, 80));
  const out = ai.text ? parseJson(ai.text) : null;
  return out?.intent ? out : { intent: 'other' };
}

async function applyEdits(draftId: number, edits: any): Promise<{ ok: boolean; msg: OutMsg; unmatched: string[] }> {
  const p = await ensureChatTables();
  const r = await p.query(`SELECT * FROM mk_drafts WHERE id = $1 AND tenant_id = $2`, [draftId, currentTenant()]);
  const row = r.rows[0];
  if (!row || row.status !== 'draft') return { ok: false, msg: { text: 'הטיוטה הזו כבר הועלתה - אי אפשר לשנות אותה מכאן.' }, unmatched: [] };
  const d: any = JSON.parse(JSON.stringify(row.draft));
  const e = edits || {};
  for (const k of ['dailyBudgetIls', 'ageMin', 'ageMax', 'genders', 'advantageAudience', 'name', 'kind', 'waPrefill', 'waWelcome', 'waQuickReplies']) if (e[k] != null && e[k] !== '') d[k] = e[k];
  if (Array.isArray(e.bodies) && e.bodies.length) d.texts.bodies = e.bodies;
  if (Array.isArray(e.titles) && e.titles.length) d.texts.titles = e.titles;
  const unmatched: string[] = [];
  if (Array.isArray(e.removePlaces) && e.removePlaces.length && d.places) {
    d.places = d.places.filter((pl: any) => !e.removePlaces.some((n: string) => String(pl.name).includes(n) || String(n).includes(pl.name)));
    if (!d.places.length) d.places = null;
  }
  if (Array.isArray(e.addPlaces) && e.addPlaces.length) {
    const creds = await adsCredsForCurrentBusiness();
    for (const pl of e.addPlaces.slice(0, 10)) {
      const hits = creds ? await searchPlaces(creds.token, String(pl?.name || '')) : [];
      const hit = hits.find(h => h.type === 'city') || hits[0];
      if (hit) d.places = [...(d.places || []).filter((x: any) => x.key !== hit.key), { ...hit, radiusKm: hit.type === 'city' ? pl?.radiusKm ?? null : null }];
      else unmatched.push(String(pl?.name || ''));
    }
  }
  const draft = cleanDraft(d, row.context);
  await p.query(`UPDATE mk_drafts SET draft = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(draft)]);
  const msg = draftSummary(draftId, draft, row.context, draftProblems(draft, row.context));
  if (unmatched.length) msg.text = `לא מצאתי במטא: ${unmatched.join(', ')} - נסו שם אחר.\n\n${msg.text}`;
  return { ok: true, msg, unmatched };
}

async function draftRow(id: number) {
  const p = await ensureChatTables();
  const r = await p.query(`SELECT * FROM mk_drafts WHERE id = $1 AND tenant_id = $2`, [id, currentTenant()]);
  return r.rows[0] || null;
}

// ---------- the owner's WhatsApp message ----------

// ---------- the approvers' questions on WhatsApp (Haim, 2026-11-21) ----------
// "When an approved number asks something, give it options (the question + an emoji): the campaigns' data -
// all campaigns by default, or one of them - for the last 7, 30, 60 days: spend, leads, booked exams,
// purchases, the cost of each." The numbers are the CRM dashboard's ROI table for those days (the CRM's
// campaign-outcomes: `total` = every campaign with spend + every Meta lead; one campaign = its own row).
const STATS_RE = /נתונ|דוח|דו"ח|סטטיסטיק|ביצוע|תוצא|כמה (?:לידים|תורים|רכישות|עלה|עולה|הוצא)|עלות ל|הוצאה|לידים|רכישות|תורים|החזר|roas/i;
const NEW_RE = /חדש|לבנות|תבנה|תבני|ליצור|צור|תכין/;
const BOT_PREFIX_RE = /^\s*(?:בוט|🤖)[\s:,-]/;

const menuRows = (): ListRow[] => [
  STATUS_ROW,
  { id: 'mk_q_all_7', title: '📊 7 ימים אחרונים', description: 'כל הקמפיינים: הוצאה, לידים, תורים, רכישות' },
  { id: 'mk_q_all_30', title: '📊 30 ימים אחרונים', description: 'כל הקמפיינים: הוצאה, לידים, תורים, רכישות' },
  { id: 'mk_q_all_60', title: '📊 60 ימים אחרונים', description: 'כל הקמפיינים: הוצאה, לידים, תורים, רכישות' },
  { id: 'mk_q_cost', title: '💰 עלות לליד/תור/רוכש', description: '7 / 30 / 60 ימים זה מול זה' },
  { id: 'mk_q_camps', title: '📣 לפי קמפיין', description: 'לבחור קמפיין ולראות את הנתונים שלו' },
  { id: 'mk_q_new', title: '✨ קמפיין חדש', description: 'לבנות קמפיין בשיחה עם נועם' },
  { id: 'mk_q_saved', title: '📂 טיוטות ומושהים', description: 'מה מחכה לאישור או להפעלה' },
];
const withMenu = (text: string, refreshId?: string): OutMsg => ({
  text,
  list: { button: '📋 מה עוד לבדוק?', rows: [...(refreshId ? [{ id: refreshId, title: '🔄 לרענן עכשיו', description: 'לחשב מחדש מה-CRM (עד חצי דקה)' }] : []), ...menuRows()].slice(0, 10) },
});

const nf = (n: number) => Math.round(n).toLocaleString('he-IL');
const ilsF = (n: number | null | undefined) => (n == null || !isFinite(n) ? '—' : `₪${nf(n)}`);
const perF = (spend: number | null | undefined, n: number) => (spend != null && n > 0 ? ilsF(spend / n) : '—');
const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const periodOf = (days: number) => { const until = israelToday(); return { key: `d${days}`, since: shiftDay(until, -(days - 1)), until }; };

// One CRM call for 7 / 30 / 60 days at once (campaign = null → every campaign's bottom line). It can take a
// while (the CRM reads each period's spend from Meta) - Haim, 2026-11-21: "maybe it times out; prepare the
// results every day in a cache": answers come from `mk_stats_cache` (made every morning by the cron
// `/api/cron/warm-stats`, and after every live read), "🔄 לרענן עכשיו" reads live (up to 45s).
type Num = { key: string; since: string; until: string; days: number; spend: number | null; leads: number; booked: number; buyers: number; revenue: number; fbLeads?: number; accountSpend: number | null };
type Nums = Num[] & { at?: string };
const ALL_DAYS = [7, 30, 60];
async function crmLive(campaign: { id: string; name: string } | null): Promise<Num[] | null> {
  const periods = ALL_DAYS.map(periodOf);
  // the CRM requires a campaign id + name (its own row); for "all campaigns" only its bottom line (`total`) is read,
  // which doesn't depend on them - a placeholder (an empty name was refused with 400 → "couldn't read the CRM")
  const r = await crmOutcomes({ campaignId: campaign?.id || '0', campaignName: campaign?.name || campaign?.id || 'כל הקמפיינים', adsets: [], ads: [], periods: periods.map(p => ({ key: p.key, since: p.since, until: p.until })) }, 45000);
  if (!r?.periods) return null;
  return periods.map(p => {
    const x: any = r.periods.find((y: any) => y.key === p.key) || {};
    const t = campaign ? { spendIls: x.spendIls, leads: x.leads || 0, booked: x.booked || 0, buyers: x.buyers || 0, revenue: x.revenue || 0, fbLeads: x.fbLeads } : (x.total || {});
    return { ...p, days: Number(p.key.slice(1)), spend: t.spendIls ?? null, leads: Number(t.leads) || 0, booked: Number(t.booked) || 0, buyers: Number(t.buyers) || 0, revenue: Number(t.revenue) || 0, fbLeads: t.fbLeads, accountSpend: x.total?.spendIls ?? null };
  });
}
const cacheKey = (campaign: { id: string } | null) => `crm:${campaign?.id || 'all'}`;
async function cached(campaign: { id: string } | null): Promise<{ n: Num[]; at: string } | null> {
  const p = await ensureChatTables();
  const r = await p.query(`SELECT data, computed_at FROM mk_stats_cache WHERE tenant_id = $1 AND key = $2`, [currentTenant(), cacheKey(campaign)]);
  const row = r.rows[0];
  // only today's (Israel) numbers - the periods end today
  if (!row || row.data?.day !== israelToday()) return null;
  return { n: row.data.n, at: new Date(row.computed_at).toISOString() };
}
async function refresh(campaign: { id: string; name: string } | null): Promise<{ n: Num[]; at: string } | null> {
  const n = await crmLive(campaign);
  if (!n) return null;
  const p = await ensureChatTables();
  await p.query(
    `INSERT INTO mk_stats_cache (tenant_id, key, data, computed_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET data = EXCLUDED.data, computed_at = now()`,
    [currentTenant(), cacheKey(campaign), JSON.stringify({ day: israelToday(), n })],
  );
  return { n, at: new Date().toISOString() };
}
// the asked days of a campaign / all campaigns: from the cache unless `force`; `wait` says "⏳" before a live read
async function crmNumbers(campaign: { id: string; name: string } | null, days: number[], opts: { force?: boolean; wait?: () => Promise<unknown> } = {}): Promise<Nums | null> {
  let got = opts.force ? null : await cached(campaign).catch(() => null);
  if (!got) { await opts.wait?.(); got = await refresh(campaign).catch(() => null); }
  if (!got) return null;
  return Object.assign(got.n.filter(x => days.includes(x.days)), { at: got.at });
}
const asOf = (n: Nums | null) => (n?.at ? `\n_נכון ל-${new Date(n.at).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' })}_` : '');

function statsText(title: string, n: Nums | null): string {
  if (!n) return 'לא הצלחתי לקרוא כרגע את הנתונים מה-CRM. נסו שוב בעוד דקה.';
  const p = n[0];
  const roas = p.spend ? p.revenue / p.spend : null;
  const ripe = p.days <= 7 ? ' (מוקדם לדעת - הלידים עוד לא הספיקו לקנות)' : p.days <= 30 ? ' (עוד מבשיל - רכישות עוד מגיעות)' : '';
  return [
    `📊 *${title} · ${p.days} ימים אחרונים* (${dm(p.since)}–${dm(p.until)})`,
    `• 💸 הוצאה: *${ilsF(p.spend)}*`,
    `• 👥 לידים: *${nf(p.leads)}* · ${perF(p.spend, p.leads)} לליד`,
    `• 📅 קבעו תור: *${nf(p.booked)}* · ${perF(p.spend, p.booked)} לתור`,
    `• 🛍️ קנו: *${nf(p.buyers)}* · ${perF(p.spend, p.buyers)} לרוכש`,
    `• 💰 הכנסה: ${ilsF(p.revenue)}${roas != null ? ` · החזר ${roas.toFixed(1)}x` : ''}${ripe}`,
  ].join('\n') + asOf(n);
}

function costsText(title: string, n: Nums | null): string {
  if (!n) return 'לא הצלחתי לקרוא כרגע את הנתונים מה-CRM. נסו שוב בעוד דקה.';
  return [`💰 *${title} - עלות לכל סוג*`, ...n.map(p => `\n*${p.days} ימים* (${dm(p.since)}–${dm(p.until)}) · הוצאה ${ilsF(p.spend)}\n• לליד: ${perF(p.spend, p.leads)} (${nf(p.leads)})\n• לתור: ${perF(p.spend, p.booked)} (${nf(p.booked)})\n• לרוכש: ${perF(p.spend, p.buyers)} (${nf(p.buyers)})`)].join('\n') + asOf(n);
}

// "📈 מצב הקמפיינים": what runs now (Meta's state) and each one's last 7 days from the CRM, plus the campaigns
// made here that are still paused, plus all campaigns together
const STATE_HE: Record<string, string> = { ACTIVE: '🟢 פעיל', IN_PROCESS: '⏳ בבדיקה של מטא', WITH_ISSUES: '⚠️ יש בעיה', PAUSED: '⏸️ מושהה', CAMPAIGN_PAUSED: '⏸️ מושהה' };
async function statusText(opts: { force?: boolean; wait?: () => Promise<unknown> } = {}): Promise<string> {
  const b = await listBases();
  if (!b?.success) return `לא הצלחתי לקרוא את הקמפיינים: ${b?.error || 'שגיאה'}`;
  const running = b.campaigns.filter((c: any) => ['ACTIVE', 'IN_PROCESS', 'WITH_ISSUES'].includes(c.status)).slice(0, 6);
  // campaigns made in this system that wait to be turned on
  let waiting: any[] = [];
  try {
    const p = await ensureChatTables();
    const own = (await p.query(`SELECT object_id FROM mk_changes WHERE tenant_id = $1 AND action = 'create_campaign' AND status = 'done' AND done_at > now() - interval '30 days'`, [currentTenant()])).rows.map((r: any) => String(r.object_id));
    waiting = b.campaigns.filter((c: any) => own.includes(String(c.id)) && ['PAUSED', 'CAMPAIGN_PAUSED'].includes(c.status));
  } catch { /* no table yet */ }
  // one "⏳" for all of them when anything has to be read live
  let waited = false;
  const wait = async () => { if (!waited) { waited = true; await opts.wait?.(); } };
  const [each, all] = await Promise.all([
    Promise.all(running.map((c: any) => crmNumbers({ id: String(c.id), name: c.name }, [7], { force: opts.force, wait }).catch(() => null))),
    crmNumbers(null, [7], { force: opts.force, wait }).catch(() => null),
  ]);
  const lines = [`📈 *מצב הקמפיינים · 7 ימים אחרונים*`];
  if (!running.length) lines.push('', 'אין כרגע קמפיין שרץ.');
  running.forEach((c: any, i: number) => {
    const n = each[i]?.[0];
    lines.push('', `*${c.name}* · ${STATE_HE[c.status] || c.status}${c.kind && c.kind !== 'other' ? ` · ${KIND_HE[c.kind as Kind]}` : ''}`);
    if (n) lines.push(`💸 ${ilsF(n.spend)} · 👥 ${nf(n.leads)} לידים (${perF(n.spend, n.leads)} לליד) · 📅 ${nf(n.booked)} תורים (${perF(n.spend, n.booked)} לתור)`);
    else lines.push('(אין נתונים מה-CRM)');
  });
  if (waiting.length) lines.push('', `⏸️ *מחכים להפעלה:* ${waiting.map((c: any) => c.name).join(' · ')}`);
  const t = all?.[0];
  if (t) lines.push('', `*כל הקמפיינים יחד:* 💸 ${ilsF(t.spend)} · 👥 ${nf(t.leads)} לידים (${perF(t.spend, t.leads)}) · 📅 ${nf(t.booked)} תורים (${perF(t.spend, t.booked)}) · 🛍️ ${nf(t.buyers)} קנו`);
  else lines.push('', 'לא הצלחתי לקרוא כרגע את הנתונים מה-CRM - אפשר ללחוץ "🔄 לרענן עכשיו" בעוד דקה.');
  return lines.join('\n') + asOf(all);
}

// what the approver asked, in words → days (7 / 30 / 60)
const daysOf = (t: string) => (/60|חודשיים/.test(t) ? 60 : /\b7\b|שבוע|השבוע/.test(t) ? 7 : 30);

async function answerQuestion(idIn: string, send: (m: OutMsg[], prompt?: any) => Promise<any>, phone: string) {
  let m: RegExpExecArray | null;
  // "🔄 לרענן עכשיו" = the same question read live from the CRM
  const force = idIn.startsWith('mk_q_r_');
  const id = force ? `mk_q_${idIn.slice('mk_q_r_'.length)}` : idIn;
  const refreshId = `mk_q_r_${id.slice('mk_q_'.length)}`;
  const opts = { force, wait: () => viaBotApp(phone, [{ text: '⏳ אוסף את הנתונים מה-CRM... רגע' }]) };
  if ((m = /^mk_q_all_(7|30|60)$/.exec(id))) return send([withMenu(statsText('כל הקמפיינים', await crmNumbers(null, [Number(m[1])], opts)), refreshId)]);
  if (id === 'mk_q_status') return send([withMenu(await statusText(opts), refreshId)]);
  if (id === 'mk_q_cost') return send([withMenu(costsText('כל הקמפיינים', await crmNumbers(null, [7, 30, 60], opts)), refreshId)]);
  if (id === 'mk_q_camps') {
    const b = await listBases();
    if (!b?.success || !b.campaigns.length) return send([withMenu('לא מצאתי קמפיינים בחשבון המודעות.')]);
    const active = b.campaigns.filter((c: any) => c.status === 'ACTIVE');
    const rows = (active.length ? active : b.campaigns).slice(0, 9).map((c: any) => ({ id: `mk_q_c_${c.id}`, title: String(c.name).slice(0, 24), description: `${KIND_HE[c.kind as Kind] || ''} · ${c.leads30} לידים ב-30 יום`.slice(0, 72) }));
    return send([{ text: `📣 על איזה קמפיין? (${active.length ? 'הפעילים' : 'האחרונים'})`, list: { button: 'לבחור קמפיין', rows: [...rows, { id: 'mk_menu', title: '↩️ חזרה לתפריט' }] } }]);
  }
  if ((m = /^mk_q_c_(\d+)$/.exec(id))) {
    return send([{ text: 'לאיזו תקופה?', buttons: [{ id: `mk_q_c_${m[1]}_7`, title: '7 ימים' }, { id: `mk_q_c_${m[1]}_30`, title: '30 ימים' }, { id: `mk_q_c_${m[1]}_60`, title: '60 ימים' }] }]);
  }
  if ((m = /^mk_q_c_(\d+)_(7|30|60)$/.exec(id))) {
    const b = await listBases();
    const c = (b?.campaigns || []).find((x: any) => String(x.id) === m![1]);
    const n = await crmNumbers({ id: m[1], name: c?.name || '' }, [Number(m[2])], opts);
    const extra = n?.[0]?.accountSpend != null && n[0].spend != null && n[0].accountSpend !== n[0].spend ? `\n_(כל הקמפיינים יחד באותם ימים: הוצאה ${ilsF(n[0].accountSpend)})_` : '';
    return send([withMenu(statsText(c?.name || 'הקמפיין', n) + extra + '\n_הלידים משויכים לקמפיין לפי השם שלו ב-CRM - כמו בטבלה בדשבורד._', refreshId)]);
  }
  if (id === 'mk_q_new') return send([{ text: '✨ ספרו לי על הקמפיין: איפה, כמה ליום, למי, ומה להדגיש. אסכם מה הבנתי ואשאל מה שלא ברור - שום דבר לא נבנה בלי האישור שלכם.' }], { kind: 'newbrief' });
  if (id === 'mk_q_saved') {
    const p = await ensureChatTables();
    const t = currentTenant();
    const drafts = (await p.query(`SELECT draft FROM mk_drafts WHERE tenant_id = $1 AND status = 'draft' AND created_at > now() - interval '60 days' ORDER BY id DESC LIMIT 5`, [t]).catch(() => ({ rows: [] as any[] }))).rows;
    const pub = (await p.query(`SELECT draft FROM mk_drafts WHERE tenant_id = $1 AND status = 'published' AND published_at > now() - interval '30 days' ORDER BY published_at DESC LIMIT 5`, [t]).catch(() => ({ rows: [] as any[] }))).rows;
    const lines = [
      ...drafts.map((r: any) => `📝 ${r.draft?.name} · טיוטה · ₪${r.draft?.dailyBudgetIls} ליום`),
      ...pub.map((r: any) => `⬆️ ${r.draft?.name} · הועלה למטא`),
    ];
    return send([withMenu(lines.length ? `📂 *מה מחכה:*\n${lines.join('\n')}\n\nאת הטיוטות פותחים במערכת השיווק ← "✨ קמפיין חדש מהוראה" ← "📂 שמורות".` : '📂 אין כרגע טיוטות או קמפיינים שמחכים.')]);
  }
  return send([withMenu('מה תרצו לדעת?')]);
}

// Every answer is pushed through BotApp (notify), so a slow step (building / uploading) still reaches
// the owner when BotApp stopped waiting. The return value only says whether the message was ours.
async function ownerMessage(input: { phone: string; text: string; buttonId?: string; approver: Approver }): Promise<{ handled: boolean }> {
  const phone = input.phone;
  const text = String(input.text || '').trim();
  const send = (msgs: OutMsg[], prompt?: any) => sendToOwner(phone, msgs, 'הודעה מנועם על הקמפיין', prompt);
  await noteInbound(phone);
  // "בוט: …" / "🤖 …" from an approver = talk to the regular bot (testing it from the owner's phone)
  if (!input.buttonId && BOT_PREFIX_RE.test(text)) return { handled: false };
  const th = await thread(phone);
  const qid = String(input.buttonId || '');
  if (/^mk_(q_|menu$)/.test(qid)) { await answerQuestion(qid, send, phone); return { handled: true }; }
  const btn = /^mk_(pub|no|act|later|build|cancel)_(\d+)$/.exec(String(input.buttonId || ''));

  // a message that was waiting for the 24h window (a template went out) - shown now
  if (!btn && th.prompt?.kind === 'show' && fresh(th.prompt) && Array.isArray(th.prompt.pending)) {
    await send(th.prompt.pending, th.prompt.then || null);
    return { handled: true };
  }

  const act = async (kind: string, id: number) => {
    if (kind === 'build') {
      const brief = await loadBrief(id);
      if (!brief || brief.status !== 'talking' || !brief.ready) { await send([{ text: 'אין כרגע סיכום שמחכה לבנייה. כתבו לי מה הקמפיין צריך להיות.' }], null); return; }
      await viaBotApp(phone, [{ text: '⏳ בונה את הטיוטה על בסיס מה שסיכמנו... זה לוקח עד דקה.' }]);
      const out = await buildFromBrief(id);
      if (!out?.success) { await send([{ text: `לא הצלחתי לבנות את הטיוטה: ${out?.error || 'שגיאה'}` }], null); return; }
      await send([draftSummary(out.id, out.draft, out.context, out.problems || [])], out.problems?.length ? { kind: 'edit', draftId: out.id } : { kind: 'pub', draftId: out.id });
      return;
    }
    if (kind === 'cancel') {
      const p = await ensureChatTables();
      await p.query(`UPDATE mk_briefs SET status = 'closed', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'talking'`, [id, currentTenant()]);
      await send([{ text: 'בסדר, עזבתי את הקמפיין הזה. כשתרצו - כתבו לי "קמפיין חדש".' }], null);
      return;
    }
    const row = await draftRow(id);
    if (!row) { await send([{ text: 'לא מצאתי את הטיוטה הזו.' }], null); return; }
    if (kind === 'no') { await send([{ text: 'בסדר, לא העליתי. הטיוטה שמורה במערכת השיווק ← "📣 ממומן".' }], null); return; }
    if (kind === 'pub') {
      if (row.status !== 'draft') { await send([{ text: `הקמפיין "${row.draft?.name}" כבר הועלה.` }], null); return; }
      await viaBotApp(phone, [{ text: '⏳ מעלה למטא...' }]);
      const out = await publishDraft(id);
      if (!out?.success) { await send([{ text: `ההעלאה נכשלה: ${out?.error || 'שגיאה'}` }], null); return; }
      await send([{
        text: `✓ הקמפיין *"${out.name}"* נוצר במטא *מושהה*, עם ${out.ads.length} מודעות${out.errors?.length ? ` (חלק לא נוצרו: ${out.errors.join(' · ')})` : ''}${out.notes?.length ? `\n\n${out.notes.map((n: string) => `ℹ️ ${n}`).join('\n')}` : ''}.\n\nלהפעיל אותו עכשיו? מרגע ההפעלה מטא מתחילה להוציא *₪${row.draft?.dailyBudgetIls} ליום*.`,
        buttons: [{ id: `mk_act_${id}`, title: '▶️ להפעיל' }, { id: `mk_later_${id}`, title: '⏸️ להשאיר מושהה' }],
      }], { kind: 'act', draftId: id, campaignId: out.campaignId });
      return;
    }
    const campaignId = row.published?.campaignId;
    if (kind === 'later') { await send([{ text: 'נשאר מושהה. אפשר להפעיל מתי שתרצו במערכת השיווק או במנהל המודעות.' }], null); return; }
    if (kind === 'act') {
      if (!campaignId) { await send([{ text: 'הקמפיין עוד לא הועלה.' }], null); return; }
      const out = await manualChange(String(campaignId), { action: 'activate_campaign', targetId: String(campaignId), params: {}, title: 'הפעלת קמפיין חדש (וואטסאפ)' });
      await send([{ text: out?.success ? `▶️ הקמפיין *"${row.draft?.name}"* פועל. מטא בודקת מודעות חדשות לפני שהן רצות - בדרך כלל עד כמה שעות.` : `ההפעלה נכשלה: ${out?.error || 'שגיאה'}` }], null);
    }
  };

  if (btn) { await act(btn[1], Number(btn[2])); return { handled: true }; }

  // an answer to "approve / upload?" or "activate?"
  if (fresh(th.prompt) && ['pub', 'act', 'edit'].includes(th.prompt.kind) && th.prompt.draftId) {
    const row = await draftRow(Number(th.prompt.draftId));
    const c = await classifyAnswer(text, th.prompt, row?.draft || null);
    if (c.intent === 'confirm' && th.prompt.kind !== 'edit') { await act(th.prompt.kind, Number(th.prompt.draftId)); return { handled: true }; }
    if (c.intent === 'decline') { await act(th.prompt.kind === 'act' ? 'later' : 'no', Number(th.prompt.draftId)); return { handled: true }; }
    if (c.intent === 'edit' && th.prompt.kind !== 'act') {
      const r = await applyEdits(Number(th.prompt.draftId), c.edits);
      const okToPublish = r.ok && r.msg.buttons?.length;
      await send([r.msg], r.ok ? { kind: okToPublish ? 'pub' : 'edit', draftId: Number(th.prompt.draftId) } : null);
      return { handled: true };
    }
    if (c.intent === 'new') await setPrompt(phone, null);
    else if (c.intent !== 'other') { await send([{ text: 'לא הבנתי - אפשר ללחוץ על אחד הכפתורים, או לכתוב מה לשנות.' }]); return { handled: true }; }
    // not about the campaign: questions / the menu (below)
  }

  // the conversation before building
  // "what's the state?" - in any conversation (the open one stays where it was)
  if (/מה המצב|מצב ה?קמפיינ|איך הולך|איך הקמפיינ/.test(text)) { await answerQuestion('mk_q_status', send, phone); return { handled: true }; }
  const open = await openWaBrief(phone);
  const startNew = fresh(th.prompt) && th.prompt.kind === 'newbrief';
  if (!open && !startNew) {
    // a question about the numbers → answered at once (all campaigns), with the menu; a new campaign → the
    // conversation; anything else → the menu of questions
    if (STATS_RE.test(text) && !NEW_RE.test(text)) {
      const days = daysOf(text);
      const cost = /עלות ל|כמה עול|כמה עלה/.test(text) && !/הוצאה/.test(text);
      await answerQuestion(cost ? 'mk_q_cost' : `mk_q_all_${days}`, send, phone);
      return { handled: true };
    }
    if (!MARKETING_RE.test(text)) {
      await send([withMenu(`שלום${input.approver.name ? ` ${input.approver.name}` : ''}! 👋 אני נועם. מה תרצו לדעת על הקמפיינים?\n\n_(כדי לדבר עם הבוט הרגיל של העסק - להתחיל את ההודעה ב"בוט:")_`)]);
      return { handled: true };
    }
  }
  if (startNew) await setPrompt(phone, null);
  const turn = await briefTurn({ briefId: open?.id || null, text, channel: 'whatsapp', phone });
  if (!turn.success) { await send([{ text: `⚠️ ${turn.error}` }]); return { handled: true }; }
  if (turn.offTopic) { await send([withMenu('מה תרצו לדעת?')]); return { handled: true }; }
  if (turn.build && turn.briefId) { await act('build', turn.briefId); return { handled: true }; }
  if (turn.cancel) { await send([{ text: turn.reply || 'בסדר, עזבתי את הקמפיין הזה.' }], null); return { handled: true }; }
  const buttons = turn.ready ? [{ id: `mk_build_${turn.briefId}`, title: '✅ כן, לבנות' }, { id: `mk_cancel_${turn.briefId}`, title: '❌ לעזוב' }] : undefined;
  await send([{ text: turn.reply || '', buttons }], null);
  return { handled: true };
}

// ---------- routes ----------

export function registerChatRoutes(app: express.Express) {
  // the conversation in the app
  app.post('/api/meta-ads/briefs', async (req, res) => {
    try {
      res.json(await briefTurn({ briefId: req.body?.briefId ? Number(req.body.briefId) : null, text: req.body?.text, channel: 'app', baseCampaignId: req.body?.baseCampaignId }));
    } catch (e: any) {
      console.error('[brief]', e?.message);
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });
  app.post('/api/meta-ads/briefs/:id/build', async (req, res) => {
    try {
      const brief = await loadBrief(Number(req.params.id));
      if (!brief) return res.json({ success: false, error: 'השיחה לא נמצאה' });
      if (!brief.ready) return res.json({ success: false, error: 'יש עוד שאלות פתוחות - ענו עליהן קודם' });
      res.json(await buildFromBrief(brief.id));
    } catch (e: any) {
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });

  // "📂 שמורות" (Haim, 2026-11-20 - "save a draft here and start from it next time"): everything is
  // already kept as it goes (the conversation in mk_briefs, the draft in mk_drafts) - this lists what
  // isn't finished: open conversations, drafts not uploaded, and campaigns uploaded but still paused
  // (with Meta's status, so "▶️ להפעיל" can be pressed later). Conversations / drafts from WhatsApp too.
  app.get('/api/meta-ads/saved', async (_req, res) => {
    if (!db()) return res.json({ success: true, briefs: [], drafts: [], published: [] });
    try {
      const p = await ensureChatTables();
      const t = currentTenant();
      const briefs = (await p.query(
        `SELECT id, channel, phone, created_by, updated_at, ready, messages FROM mk_briefs WHERE tenant_id = $1 AND status = 'talking' AND updated_at > now() - interval '60 days' ORDER BY updated_at DESC LIMIT 20`, [t],
      )).rows.map((b: any) => {
        const msgs: any[] = Array.isArray(b.messages) ? b.messages : [];
        return { id: Number(b.id), channel: b.channel, by: b.created_by, updatedAt: b.updated_at, ready: !!b.ready, title: String(msgs.find(m => m.role === 'owner')?.text || '').slice(0, 120), turns: msgs.length };
      });
      let drafts: any[] = [];
      let published: any[] = [];
      try {
        drafts = (await p.query(
          `SELECT id, created_by, created_at, draft FROM mk_drafts WHERE tenant_id = $1 AND status = 'draft' AND created_at > now() - interval '60 days' ORDER BY id DESC LIMIT 20`, [t],
        )).rows.map((d: any) => ({ id: Number(d.id), by: d.created_by, createdAt: d.created_at, name: d.draft?.name, dailyBudgetIls: d.draft?.dailyBudgetIls }));
        const pub = (await p.query(
          `SELECT id, draft, published, published_at FROM mk_drafts WHERE tenant_id = $1 AND status = 'published' AND published_at > now() - interval '30 days' ORDER BY published_at DESC LIMIT 20`, [t],
        )).rows;
        const ids = pub.map((r: any) => String(r.published?.campaignId || '')).filter(Boolean);
        const statuses: Record<string, string> = {};
        const creds = ids.length ? await adsCredsForCurrentBusiness() : null;
        if (creds) {
          // one read per campaign: a campaign gone from Meta fails a combined ?ids= read for all of them
          const GRAPH = process.env.META_GRAPH_URL || 'https://graph.facebook.com/v21.0';
          await Promise.all(ids.map(async id => {
            try {
              const r = await fetch(`${GRAPH}/${id}?fields=effective_status&access_token=${encodeURIComponent(creds.token)}`, { signal: AbortSignal.timeout(10000) });
              const d: any = await r.json().catch(() => ({}));
              if (d?.effective_status) statuses[id] = d.effective_status;
              else if (d?.error && (d.error.code === 100 || /does not exist|Unsupported get request/i.test(String(d.error.message || '')))) statuses[id] = 'DELETED';
            } catch { /* shown without a status */ }
          }));
          const gone = ids.filter(id => ['DELETED', 'ARCHIVED'].includes(statuses[id]));
          if (gone.length) await p.query(`UPDATE mk_drafts SET status = 'deleted' WHERE tenant_id = $1 AND status = 'published' AND published->>'campaignId' = ANY($2::text[])`, [t, gone]).catch(() => {});
        }
        published = pub
          .map((r: any) => ({ draftId: Number(r.id), name: r.draft?.name, dailyBudgetIls: r.draft?.dailyBudgetIls, campaignId: String(r.published?.campaignId || ''), publishedAt: r.published_at, status: statuses[String(r.published?.campaignId || '')] || '' }))
          .filter((x: any) => x.campaignId && (x.status === 'PAUSED' || x.status === 'CAMPAIGN_PAUSED' || !x.status));
      } catch { /* no draft table yet */ }
      res.json({ success: true, briefs, drafts, published });
    } catch (e: any) {
      res.json({ success: false, error: e?.message });
    }
  });
  app.get('/api/meta-ads/briefs/:id', async (req, res) => {
    try {
      const b = await loadBrief(Number(req.params.id));
      if (!b) return res.json({ success: false, error: 'השיחה לא נמצאה' });
      res.json({ success: true, id: b.id, status: b.status, ready: b.ready, messages: b.messages, understood: b.understood, draftId: b.draft_id, baseCampaignId: b.base_campaign_id });
    } catch (e: any) { res.json({ success: false, error: e?.message }); }
  });
  app.get('/api/meta-ads/drafts/:id', async (req, res) => {
    try {
      const row = await draftRow(Number(req.params.id));
      if (!row) return res.json({ success: false, error: 'הטיוטה לא נמצאה' });
      const draft = cleanDraft(row.draft, row.context);
      res.json({ success: true, id: Number(row.id), status: row.status, draft, context: row.context, problems: draftProblems(draft, row.context), published: row.published });
    } catch (e: any) { res.json({ success: false, error: e?.message }); }
  });
  // "🗑️" on a saved conversation / draft (nothing in Meta is touched)
  app.delete('/api/meta-ads/briefs/:id', async (req, res) => {
    try {
      const p = await ensureChatTables();
      await p.query(`UPDATE mk_briefs SET status = 'closed', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'talking'`, [Number(req.params.id), currentTenant()]);
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e?.message }); }
  });
  app.delete('/api/meta-ads/drafts/:id', async (req, res) => {
    try {
      const p = await ensureChatTables();
      await p.query(`UPDATE mk_drafts SET status = 'deleted' WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`, [Number(req.params.id), currentTenant()]);
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e?.message }); }
  });

  // who approves on WhatsApp
  app.get('/api/meta-ads/wa-approval/settings', async (_req, res) => {
    if (!db()) return res.json({ success: false, error: 'צריך מסד נתונים' });
    try { res.json({ success: true, ...(await getSettings()) }); } catch (e: any) { res.json({ success: false, error: e?.message }); }
  });
  app.put('/api/meta-ads/wa-approval/settings', async (req, res) => {
    if (!db()) return res.json({ success: false, error: 'צריך מסד נתונים' });
    try {
      const approvers: Approver[] = (Array.isArray(req.body?.approvers) ? req.body.approvers : [])
        .map((a: any) => ({ name: String(a?.name || '').trim().slice(0, 60), phone: intl(a?.phone) }))
        .filter((a: Approver) => a.phone).slice(0, 10);
      const template = req.body?.template != null ? String(req.body.template).trim().slice(0, 100) || null : undefined;
      const p = await ensureChatTables();
      await p.query(
        `INSERT INTO mk_wa_settings (tenant_id, approvers, template, updated_by) VALUES ($1, $2::jsonb, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE SET approvers = EXCLUDED.approvers, template = COALESCE($3, mk_wa_settings.template), updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [currentTenant(), JSON.stringify(approvers), template ?? null, who()],
      );
      res.json({ success: true, ...(await getSettings()) });
    } catch (e: any) {
      res.json({ success: false, error: e?.message });
    }
  });

  // a draft built in the app → its summary + "✅ מאשר להעלות" to the approvers on WhatsApp
  app.post('/api/meta-ads/drafts/:id/send-approval', async (req, res) => {
    try {
      const row = await draftRow(Number(req.params.id));
      if (!row) return res.json({ success: false, error: 'הטיוטה לא נמצאה' });
      if (row.status !== 'draft') return res.json({ success: false, error: 'הטיוטה כבר הועלתה' });
      const { approvers } = await getSettings();
      const to = req.body?.phone ? approvers.filter(a => last9(a.phone) === last9(req.body.phone)) : approvers;
      if (!to.length) return res.json({ success: false, error: 'אין מאשרים - הוסיפו שם וטלפון' });
      const draft = cleanDraft(row.draft, row.context);
      const problems = draftProblems(draft, row.context);
      if (problems.length) return res.json({ success: false, error: problems.join(' · ') });
      const msg = draftSummary(Number(row.id), draft, row.context, problems);
      const results = [];
      for (const a of to) {
        const r = await sendToOwner(a.phone, [msg], `קמפיין "${draft.name}" (₪${draft.dailyBudgetIls} ליום) מחכה לאישור`, { kind: 'pub', draftId: Number(row.id) });
        results.push({ name: a.name, phone: a.phone, ...r });
      }
      res.json({ success: results.some(r => r.ok), results });
    } catch (e: any) {
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });
}

// BotApp's calls (before the session middleware - their own token says which business)
function botTenant(req: express.Request): string | null {
  const secret = process.env.SSO_SHARED_SECRET;
  if (!secret) return null;
  try {
    const c: any = jwt.verify(String(req.headers['x-bot-token'] || ''), secret);
    return c?.typ === 'marketing-bot' && c.portalTenantId ? String(c.portalTenantId) : null;
  } catch {
    return null;
  }
}

// Every morning (vercel.json cron): the numbers נועם answers with, ready in the cache for every business that
// has approvers - all campaigns + each running one, 7 / 30 / 60 days (Haim, 2026-11-21)
export async function warmStats(): Promise<any[]> {
  if (!db()) return [];
  const p = await ensureChatTables();
  const tenants = (await p.query(`SELECT tenant_id FROM mk_wa_settings WHERE jsonb_array_length(approvers) > 0`)).rows.map((r: any) => String(r.tenant_id));
  const out: any[] = [];
  await Promise.all(tenants.map(tenantId => runWithTenant({ tenantId, email: 'מערכת (הכנת נתונים)', role: 'system' }, async () => {
    try {
      const b = await listBases();
      const running = (b?.campaigns || []).filter((c: any) => ['ACTIVE', 'IN_PROCESS', 'WITH_ISSUES'].includes(c.status)).slice(0, 6);
      const res = await Promise.all([refresh(null), ...running.map((c: any) => refresh({ id: String(c.id), name: c.name }))].map(x => x.catch(() => null)));
      out.push({ tenantId, campaigns: running.length, ok: res.filter(Boolean).length, of: res.length });
    } catch (e: any) { out.push({ tenantId, error: e?.message }); }
  })));
  return out;
}

export function registerBotRoutes(app: express.Express) {
  // Vercel's cron (with CRON_SECRET set, only it may call)
  app.get('/api/cron/warm-stats', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret ? req.headers.authorization !== `Bearer ${secret}` : !String(req.headers['user-agent'] || '').includes('vercel-cron')) return res.status(401).json({ success: false });
    try { res.json({ success: true, results: await warmStats() }); } catch (e: any) { res.json({ success: false, error: e?.message }); }
  });

  app.get('/api/bot/approvers', async (req, res) => {
    const tenantId = botTenant(req);
    if (!tenantId) return res.status(401).json({ success: false, error: 'invalid-token' });
    if (!db()) return res.json({ success: true, phones: [] });
    await runWithTenant({ tenantId, email: 'נועם', role: 'bot' }, async () => {
      try { res.json({ success: true, phones: (await getSettings()).approvers.map(a => last9(a.phone)) }); }
      catch (e: any) { res.json({ success: false, error: e?.message, phones: [] }); }
    });
  });

  app.post('/api/bot/owner-message', async (req, res) => {
    const tenantId = botTenant(req);
    if (!tenantId) return res.status(401).json({ success: false, error: 'invalid-token' });
    if (!db()) return res.json({ success: true, handled: false });
    const phone = intl(req.body?.phone);
    await runWithTenant({ tenantId, email: 'נועם', role: 'bot' }, async () => {
      try {
        const approver = (await getSettings()).approvers.find(a => last9(a.phone) === last9(phone));
        if (!approver) return res.json({ success: true, handled: false });
        // the changes are signed by the approver, through נועם
        await runWithTenant({ tenantId, email: `${approver.name || phone} (וואטסאפ, דרך נועם)`, role: 'owner' }, async () => {
          const out = await ownerMessage({ phone, text: String(req.body?.text || ''), buttonId: req.body?.buttonId, approver });
          res.json({ success: true, ...out });
        });
      } catch (e: any) {
        console.error('[owner message]', e?.message);
        res.json({ success: false, handled: false, error: e?.message });
      }
    });
  });
}
