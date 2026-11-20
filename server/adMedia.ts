// Replacing / adding media in an ad - videos (Haim, 2026-11-19), pictures and carousel cards (2026-11-20)
// (first version: video only - Haim, 2026-11-19 - "update the video in an ad, and later any
// other media - replace or add"; he chose both ways):
//  - "new ad in the same ad set" (recommended): a copy of the ad's creative with the new video, as a
//    new ad in the same ad set, PAUSED (going live is a separate tap - the existing ▶️ button);
//  - "replace in this ad": Meta can't edit an ad's media, so a new creative is made and the ad is
//    pointed at it - the ad goes back to Meta's review and its learning / likes start over.
// Both are logged in mk_changes and undoable (a new ad → archived; a swap → the old creative back).
//
// Upload: Meta's ad-account video upload (`act_…/advideos`, upload_phase start / transfer / finish).
// Meta decides each piece's size (start_offset → end_offset) and it can be bigger than Vercel's 4.5MB
// body limit, so the browser sends 3MB pieces and the server keeps them in mk_video_uploads until
// Meta's piece is complete, then transfers it.
import { fixAssetRules } from './assetRules.js';
import express from 'express';
import { adsCredsForCurrentBusiness } from './metaAdsSnapshot.js';
import { db, ensureTables } from './db.js';
import { currentTenant, currentUser } from './tenant.js';
import { gget, metaErr } from './campaignOptimizer.js';

const GRAPH = process.env.META_GRAPH_URL || 'https://graph.facebook.com/v21.0';
const who = () => currentUser()?.email || 'unknown';

async function ensureUploadTable() {
  const p = await ensureTables();
  await p.query(`CREATE TABLE IF NOT EXISTS mk_video_uploads (
    session_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, video_id TEXT, total BIGINT NOT NULL,
    start_offset BIGINT NOT NULL DEFAULT 0, end_offset BIGINT NOT NULL DEFAULT 0, buf BYTEA NOT NULL DEFAULT ''::bytea,
    done BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  return p;
}

async function metaForm(path: string, token: string, fields: Record<string, string | Blob>): Promise<{ ok: boolean; data: any }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v as any);
  form.append('access_token', token);
  try {
    const r = await fetch(`${GRAPH}/${path}`, { method: 'POST', body: form, signal: AbortSignal.timeout(50000) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch (e: any) {
    return { ok: false, data: { error: { message: e?.message || 'network' } } };
  }
}

async function metaPost(path: string, token: string, body: Record<string, string>) {
  try {
    const r = await fetch(`${GRAPH}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...body, access_token: token }), signal: AbortSignal.timeout(30000),
    });
    return { ok: r.ok, data: await r.json().catch(() => ({})) as any };
  } catch (e: any) {
    return { ok: false, data: { error: { message: e?.message || 'network' } } };
  }
}

// ---------- building the new creative ----------

type CreativeSpec = { object_story_spec?: any; asset_feed_spec?: any; degrees_of_freedom_spec?: any; url_tags?: string };
// the new media: a processed ad-account video (+ its thumbnail) or an uploaded ad image (its hash)
export type Media = { type: 'video'; id: string; thumb: string } | { type: 'image'; hash: string };
// where it goes:
//  - single ad (one picture / video): replaces it (a picture ad can become a video ad and back);
//  - flexible ad: { kind: 'feed', action: 'add' | 'replace', replaceId } - next to / instead of one asset;
//  - carousel: { kind: 'card', action: 'replace' | 'add' | 'remove', index, name?, description? }.
export type Target = { kind?: 'feed' | 'card' | 'single'; action?: 'add' | 'replace' | 'remove'; replaceId?: string; index?: number; name?: string; description?: string };
const MAX_CARDS = 10;

const clone = (x: any) => (x == null ? x : JSON.parse(JSON.stringify(x)));

// The ad's creative with the new media. Returns an error text when not possible.
export function creativeWithMedia(c: any, media: Media | null, target: Target = {}): CreativeSpec | { error: string } {
  if (!c) return { error: 'לא הצלחנו לקרוא את המודעה' };
  const out: CreativeSpec = {};
  if (c.url_tags) out.url_tags = c.url_tags;
  if (c.degrees_of_freedom_spec) out.degrees_of_freedom_spec = c.degrees_of_freedom_spec;
  const oss = clone(c.object_story_spec);

  // a flexible ad (several pictures / videos / texts)
  if (c.asset_feed_spec) {
    if (!media) return { error: 'לא נבחרה מדיה' };
    const afs = clone(c.asset_feed_spec);
    const key = media.type === 'video' ? 'videos' : 'images';
    const list: any[] = Array.isArray(afs[key]) ? afs[key] : [];
    const entry = media.type === 'video' ? { video_id: media.id, thumbnail_url: media.thumb } : { hash: media.hash };
    const idOf = (x: any) => String(media.type === 'video' ? x.video_id : x.hash);
    // per-placement customisation (each placement rule gets exactly one asset of a kind): only a same-kind replace keeps it valid
    if (Array.isArray(afs.asset_customization_rules) && afs.asset_customization_rules.length) {
      const sameKind = target.action === 'replace' && target.replaceId && list.some(x => idOf(x) === String(target.replaceId));
      if (!sameKind) return { error: `במודעה הזו יש התאמה לפי מיקום (תמונה / סרטון אחרים לכל מיקום), ומטא מרשה בה רק החלפה של ${media.type === 'video' ? 'סרטון בסרטון' : 'תמונה בתמונה'} - לא הוספה ולא החלפה בסוג אחר. אפשר ליצור מודעה חדשה במקום.` };
    }
    if (target.action === 'replace' && target.replaceId) {
      // replacing an asset of the other kind (a picture with a video) = remove it there, add here
      const sameKind = list.findIndex(x => idOf(x) === String(target.replaceId));
      if (sameKind >= 0) list[sameKind] = { ...entry, ...(list[sameKind]?.adlabels ? { adlabels: list[sameKind].adlabels } : {}) };
      else {
        const other = media.type === 'video' ? 'images' : 'videos';
        if (Array.isArray(afs[other])) afs[other] = afs[other].filter((x: any) => String(x.hash ?? x.video_id) !== String(target.replaceId));
        list.push(entry);
      }
    } else list.push(entry);
    afs[key] = list;
    for (const k of ['images', 'videos']) if (Array.isArray(afs[k]) && afs[k].length === 0) delete afs[k];
    const fmt = media.type === 'video' ? 'SINGLE_VIDEO' : 'SINGLE_IMAGE';
    if (Array.isArray(afs.ad_formats) && !afs.ad_formats.includes(fmt)) afs.ad_formats = [...afs.ad_formats, fmt];
    out.asset_feed_spec = afs;
    if (oss) out.object_story_spec = oss;
    return out;
  }
  if (!oss) return { error: 'המודעה מבוססת על פוסט קיים מהדף - אי אפשר להחליף בה מדיה. אפשר ליצור מודעה חדשה מהפוסט / מהמדיה.' };

  // a carousel: replace a card's picture / video, add a card, or remove one
  const cards: any[] | undefined = oss.link_data?.child_attachments;
  if (cards) {
    const ld = oss.link_data;
    const next = cards.map(clone);
    const putMedia = (card: any) => {
      delete card.image_hash; delete card.picture; delete card.image_url; delete card.video_id;
      if (media!.type === 'image') card.image_hash = media!.hash;
      else { card.video_id = media!.id; card.picture = media!.thumb; }
      return card;
    };
    if (target.action === 'remove') {
      const i = Number(target.index);
      if (!(i >= 0 && i < next.length)) return { error: 'הכרטיס לא נמצא' };
      if (next.length <= 2) return { error: 'בקרוסלה צריכים להישאר לפחות 2 כרטיסים' };
      next.splice(i, 1);
    } else if (target.action === 'add') {
      if (!media) return { error: 'לא נבחרה מדיה' };
      if (next.length >= MAX_CARDS) return { error: `בקרוסלה יש כבר ${MAX_CARDS} כרטיסים - המקסימום` };
      const first = next[0] || {};
      const card: any = { link: first.link || ld.link };
      if (first.call_to_action) card.call_to_action = clone(first.call_to_action);
      if (target.name) card.name = String(target.name).slice(0, 80);
      if (target.description) card.description = String(target.description).slice(0, 80);
      next.push(putMedia(card));
    } else {
      if (!media) return { error: 'לא נבחרה מדיה' };
      const i = Number(target.index);
      if (!(i >= 0 && i < next.length)) return { error: 'הכרטיס לא נמצא' };
      const card = putMedia(next[i]);
      if (target.name != null && target.name !== '') card.name = String(target.name).slice(0, 80);
      if (target.description != null && target.description !== '') card.description = String(target.description).slice(0, 80);
      next[i] = card;
    }
    out.object_story_spec = { ...oss, link_data: { ...ld, child_attachments: next } };
    return out;
  }

  // a single picture / video ad
  if (!media) return { error: 'לא נבחרה מדיה' };
  if (oss.video_data) {
    if (media.type === 'video') {
      const vd = { ...oss.video_data, video_id: media.id, image_url: media.thumb };
      delete vd.image_hash;
      out.object_story_spec = { ...oss, video_data: vd };
      return out;
    }
    // a video ad becomes a picture ad, with its text, title and button
    const vd = oss.video_data;
    const link = vd.call_to_action?.value?.link || 'http://fb.me/';
    const ld: any = { image_hash: media.hash, link };
    if (vd.message) ld.message = vd.message;
    if (vd.title) ld.name = vd.title;
    if (vd.link_description) ld.description = vd.link_description;
    if (vd.call_to_action) ld.call_to_action = vd.call_to_action;
    const next = { ...oss, link_data: ld };
    delete next.video_data;
    out.object_story_spec = next;
    return out;
  }
  if (oss.link_data) {
    const ld = oss.link_data;
    if (media.type === 'image') {
      const nld = { ...ld, image_hash: media.hash };
      delete nld.picture; delete nld.image_url;
      out.object_story_spec = { ...oss, link_data: nld };
      return out;
    }
    const vd: any = { video_id: media.id, image_url: media.thumb };
    if (ld.message) vd.message = ld.message;
    if (ld.name) vd.title = ld.name;
    if (ld.description) vd.link_description = ld.description;
    vd.call_to_action = ld.call_to_action || (ld.link ? { type: 'LEARN_MORE', value: { link: ld.link } } : undefined);
    if (!vd.call_to_action) delete vd.call_to_action;
    const next = { ...oss, video_data: vd };
    delete next.link_data;
    out.object_story_spec = next;
    return out;
  }
  return { error: 'סוג המודעה הזה עוד לא נתמך להחלפת מדיה' };
}

// The video-only form kept for older callers.
export function creativeWithVideo(c: any, videoId: string, thumbUrl: string, feed: 'replace' | 'add', replaceVideoId?: string) {
  return creativeWithMedia(c, { type: 'video', id: videoId, thumb: thumbUrl }, { action: feed, replaceId: replaceVideoId });
}

// ---------- routes ----------

export function registerAdMediaRoutes(app: express.Express) {
  // 1. start: { fileSize } → { sessionId, videoId, startOffset, endOffset }
  app.post('/api/meta-ads/videos/start', async (req, res) => {
    if (!db()) return res.json({ success: false, error: 'צריך מסד נתונים (DATABASE_URL)' });
    try {
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const size = Math.round(Number(req.body?.fileSize) || 0);
      if (!size || size > 4 * 1024 ** 3) return res.json({ success: false, error: 'גודל קובץ לא תקין' });
      const r = await metaPost(`${creds.accountId}/advideos`, creds.token, { upload_phase: 'start', file_size: String(size) });
      if (!r.ok || !r.data?.upload_session_id) return res.json({ success: false, error: metaErr(r.data) });
      const p = await ensureUploadTable();
      await p.query(`INSERT INTO mk_video_uploads (session_id, tenant_id, video_id, total, start_offset, end_offset) VALUES ($1, $2, $3, $4, $5, $6)`,
        [String(r.data.upload_session_id), currentTenant(), String(r.data.video_id || ''), size, Number(r.data.start_offset) || 0, Number(r.data.end_offset) || 0]);
      res.json({ success: true, sessionId: String(r.data.upload_session_id), videoId: String(r.data.video_id || ''), position: Number(r.data.start_offset) || 0 });
    } catch (e: any) {
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });

  // 2. a piece of ≤3MB at `pos` (raw bytes). Kept until Meta's piece is complete, then transferred.
  app.post('/api/meta-ads/videos/chunk', express.raw({ type: 'application/octet-stream', limit: '4mb' }), async (req, res) => {
    try {
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const sessionId = String(req.query.session || ''), pos = Number(req.query.pos);
      const piece = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const p = await ensureUploadTable();
      const r = await p.query(`SELECT * FROM mk_video_uploads WHERE session_id = $1 AND tenant_id = $2`, [sessionId, currentTenant()]);
      const u = r.rows[0];
      if (!u) return res.json({ success: false, error: 'ההעלאה לא נמצאה - התחילו מחדש' });
      const start = Number(u.start_offset), end = Number(u.end_offset), have: Buffer = u.buf || Buffer.alloc(0);
      if (pos !== start + have.length) return res.json({ success: false, error: 'חתיכה לא במקום', position: start + have.length });
      let buf = Buffer.concat([have, piece]);
      let nextStart = start, nextEnd = end;
      // transfer every complete Meta piece we hold
      while (nextEnd > nextStart && buf.length >= nextEnd - nextStart) {
        const part = buf.subarray(0, nextEnd - nextStart);
        const t = await metaForm(`${creds.accountId}/advideos`, creds.token, {
          upload_phase: 'transfer', upload_session_id: sessionId, start_offset: String(nextStart), video_file_chunk: new Blob([part]),
        });
        if (!t.ok) return res.json({ success: false, error: metaErr(t.data) });
        buf = buf.subarray(part.length);
        nextStart = Number(t.data.start_offset); nextEnd = Number(t.data.end_offset);
      }
      await p.query(`UPDATE mk_video_uploads SET start_offset = $2, end_offset = $3, buf = $4 WHERE session_id = $1`, [sessionId, nextStart, nextEnd, buf]);
      res.json({ success: true, position: nextStart + buf.length, complete: nextStart >= nextEnd || nextStart >= Number(u.total) });
    } catch (e: any) {
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });

  // 3. finish: { sessionId, title } → { videoId }
  app.post('/api/meta-ads/videos/finish', async (req, res) => {
    try {
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const p = await ensureUploadTable();
      const r = await p.query(`SELECT * FROM mk_video_uploads WHERE session_id = $1 AND tenant_id = $2`, [String(req.body?.sessionId || ''), currentTenant()]);
      const u = r.rows[0];
      if (!u) return res.json({ success: false, error: 'ההעלאה לא נמצאה' });
      const f = await metaPost(`${creds.accountId}/advideos`, creds.token, { upload_phase: 'finish', upload_session_id: u.session_id, title: String(req.body?.title || 'סרטון').slice(0, 200) });
      if (!f.ok || f.data?.success === false) return res.json({ success: false, error: metaErr(f.data) });
      await p.query(`UPDATE mk_video_uploads SET done = true, buf = ''::bytea WHERE session_id = $1`, [u.session_id]);
      res.json({ success: true, videoId: String(u.video_id) });
    } catch (e: any) {
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });

  // 4. is Meta done processing it? → { ready, thumb }
  app.get('/api/meta-ads/videos/:id/status', async (req, res) => {
    try {
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן' });
      const r = await gget(String(req.params.id).replace(/\D/g, ''), creds.token, { fields: 'status,picture,thumbnails{uri,is_preferred}' });
      if (!r.ok) return res.json({ success: false, error: metaErr(r.data) });
      const thumbs: any[] = r.data?.thumbnails?.data || [];
      const thumb = (thumbs.find(t => t.is_preferred) || thumbs[0])?.uri || r.data?.picture || '';
      const st = r.data?.status?.video_status;
      res.json({ success: true, ready: st === 'ready' && !!thumb, status: st || '', thumb, error: st === 'error' ? 'מטא לא הצליחה לעבד את הסרטון' : undefined });
    } catch (e: any) {
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });

  // 0. a picture (raw bytes, ≤3.5MB - the browser shrinks bigger ones) → the ad account's image library
  app.post('/api/meta-ads/images', express.raw({ type: 'application/octet-stream', limit: '4mb' }), async (req, res) => {
    try {
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!bytes.length) return res.json({ success: false, error: 'לא התקבלה תמונה' });
      const name = String(req.query.name || 'image.jpg').replace(/[^\w.\-]/g, '_').slice(0, 80) || 'image.jpg';
      const type = /\.png$/i.test(name) ? 'image/png' : 'image/jpeg';
      const r = await metaForm(`${creds.accountId}/adimages`, creds.token, { filename: new File([bytes], name, { type }) as any });
      const img: any = r.ok ? Object.values(r.data?.images || {})[0] : null;
      if (!img?.hash) return res.json({ success: false, error: metaErr(r.data) });
      res.json({ success: true, hash: String(img.hash), url: img.url || null });
    } catch (e: any) {
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });

  // 5. what the ad holds: its videos / pictures / carousel cards, each with what it is (picture,
  // title, length) and - in a flexible ad - its last 30 days (Haim, 2026-11-19 - "I don't understand
  // what's in each video, only an id"; 2026-11-20 - pictures and carousels too)
  app.get('/api/meta-ads/ads/:adId/media', async (req, res) => {
    try {
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן' });
      const adId = String(req.params.adId).replace(/\D/g, '');
      const r = await gget(adId, creds.token, { fields: 'id,name,creative{object_type,object_story_spec,asset_feed_spec,effective_object_story_id,image_url,thumbnail_url}' });
      if (!r.ok) return res.json({ success: false, error: metaErr(r.data) });
      const c = r.data?.creative || {};
      const afs = c.asset_feed_spec;
      const oss = c.object_story_spec || {};
      const cardsRaw: any[] | null = oss.link_data?.child_attachments || null;
      const kind = afs ? 'flexible' : cardsRaw ? 'carousel' : oss.video_data ? 'video' : oss.link_data ? 'image' : c.object_story_spec ? 'other' : 'post';

      const videoIds: string[] = afs ? (afs.videos || []).map((v: any) => String(v.video_id))
        : cardsRaw ? cardsRaw.filter(x => x.video_id).map(x => String(x.video_id))
        : oss.video_data?.video_id ? [String(oss.video_data.video_id)] : [];
      const hashes: string[] = afs ? (afs.images || []).map((x: any) => String(x.hash)).filter(Boolean)
        : cardsRaw ? cardsRaw.filter(x => x.image_hash).map(x => String(x.image_hash))
        : oss.link_data?.image_hash ? [String(oss.link_data.image_hash)] : [];

      const vDetails: Record<string, any> = {};
      if (videoIds.length) {
        const d = await gget('', creds.token, { ids: videoIds.join(','), fields: 'title,picture,length,source,created_time' });
        if (d.ok) Object.assign(vDetails, d.data || {});
        else {
          const d2 = await gget('', creds.token, { ids: videoIds.join(','), fields: 'title,picture,length,created_time' });
          if (d2.ok) Object.assign(vDetails, d2.data || {});
        }
      }
      const iDetails: Record<string, any> = {};
      if (hashes.length) {
        const d = await gget(`${creds.accountId}/adimages`, creds.token, { hashes: JSON.stringify(hashes), fields: 'hash,url,name,width,height,created_time' });
        for (const img of d.ok ? d.data?.data || [] : []) iDetails[String(img.hash)] = img;
      }
      // per asset in a flexible ad, the last 30 days
      const perf: Record<string, any> = {};
      const leadsOf = (row: any) => {
        const lead = (row.actions || []).find((a: any) => ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'].includes(a.action_type));
        return lead ? Number(lead.value) || 0 : 0;
      };
      if (afs) {
        const [vi, ii] = await Promise.all([
          videoIds.length > 1 || (videoIds.length && hashes.length) ? gget(`${adId}/insights`, creds.token, { breakdowns: 'video_asset', date_preset: 'last_30d', fields: 'spend,impressions,actions' }) : Promise.resolve({ ok: false, data: null }),
          hashes.length > 1 || (videoIds.length && hashes.length) ? gget(`${adId}/insights`, creds.token, { breakdowns: 'image_asset', date_preset: 'last_30d', fields: 'spend,impressions,actions' }) : Promise.resolve({ ok: false, data: null }),
        ]);
        for (const row of vi.ok ? vi.data?.data || [] : []) {
          const id = String(row.video_asset?.video_id || row.video_asset?.id || '');
          if (id) perf[id] = { spend: Number(row.spend) || 0, impressions: Number(row.impressions) || 0, leads: leadsOf(row) };
        }
        for (const row of ii.ok ? ii.data?.data || [] : []) {
          const id = String(row.image_asset?.hash || '');
          if (id) perf[id] = { spend: Number(row.spend) || 0, impressions: Number(row.impressions) || 0, leads: leadsOf(row) };
        }
      }
      const videoOut = (id: string, thumbFallback?: string | null) => ({
        type: 'video' as const, id, title: vDetails[id]?.title || null, thumb: vDetails[id]?.picture || thumbFallback || null,
        length: vDetails[id]?.length ? Math.round(Number(vDetails[id].length)) : null, source: vDetails[id]?.source || null,
        created: vDetails[id]?.created_time || null, perf: perf[id] || null,
      });
      const imageOut = (hash: string, urlFallback?: string | null) => ({
        type: 'image' as const, id: hash, title: iDetails[hash]?.name || null, thumb: iDetails[hash]?.url || urlFallback || null,
        size: iDetails[hash]?.width ? `${iDetails[hash].width}×${iDetails[hash].height}` : null,
        created: iDetails[hash]?.created_time || null, perf: perf[hash] || null,
      });

      let assets: any[] = [];
      if (afs) {
        assets = [
          ...(afs.videos || []).map((v: any) => videoOut(String(v.video_id), v.thumbnail_url)),
          ...(afs.images || []).filter((x: any) => x.hash).map((x: any) => imageOut(String(x.hash), x.url)),
        ];
      } else if (oss.video_data?.video_id) assets = [videoOut(String(oss.video_data.video_id), oss.video_data.image_url || c.thumbnail_url)];
      else if (oss.link_data && !cardsRaw) assets = [oss.link_data.image_hash ? imageOut(String(oss.link_data.image_hash), oss.link_data.picture || c.image_url) : { type: 'image', id: '', title: null, thumb: oss.link_data.picture || c.image_url || null, perf: null }];
      const cards = cardsRaw
        ? cardsRaw.map((x: any, i: number) => ({
            index: i, name: x.name || '', description: x.description || '', link: x.link || '',
            media: x.video_id ? videoOut(String(x.video_id), x.picture) : x.image_hash ? imageOut(String(x.image_hash), x.picture) : { type: 'image', id: '', title: null, thumb: x.picture || null, perf: null },
          }))
        : null;
      res.json({
        success: true, kind, assets, cards, maxCards: MAX_CARDS,
        // older screens read these
        videos: assets.filter(a => a.type === 'video'), images: assets.filter(a => a.type === 'image').length,
      });
    } catch (e: any) {
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });

  // 6. apply: { media: { type: 'video', id } | { type: 'image', hash } (none to remove a card),
  //   target: { kind, action, replaceId?, index?, name?, description? }, mode: 'new_ad' | 'replace', newAdName? }
  //   (the video-only body { videoId, feed, replaceVideoId } of the first version still works)
  app.post('/api/meta-ads/ads/:adId/media', async (req, res) => {
    if (!db()) return res.json({ success: false, error: 'צריך מסד נתונים (DATABASE_URL)' });
    try {
      const p = await ensureTables();
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const adId = String(req.params.adId).replace(/\D/g, '');
      const b = req.body || {};
      const mode = b.mode === 'replace' ? 'replace' : 'new_ad';
      const ad = await gget(adId, creds.token, { fields: 'id,name,adset_id,campaign_id,account_id,status,creative{id,name,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,url_tags}' });
      if (!ad.ok) return res.json({ success: false, error: metaErr(ad.data) });
      if (String(ad.data?.account_id || '') && `act_${ad.data.account_id}` !== creds.accountId) return res.json({ success: false, error: 'המודעה לא שייכת לחשבון המודעות של העסק' });

      const m = b.media || (b.videoId ? { type: 'video', id: b.videoId } : null);
      const target: Target = b.target || (b.videoId ? { action: b.feed === 'replace' ? 'replace' : 'add', replaceId: b.replaceVideoId } : {});
      let media: Media | null = null;
      if (m?.type === 'video') {
        const videoId = String(m.id || '').replace(/\D/g, '');
        const v = await gget(videoId, creds.token, { fields: 'status,picture,thumbnails{uri,is_preferred}' });
        const thumbs: any[] = v.data?.thumbnails?.data || [];
        const thumb = (thumbs.find(t => t.is_preferred) || thumbs[0])?.uri || v.data?.picture || '';
        if (!v.ok || v.data?.status?.video_status !== 'ready' || !thumb) return res.json({ success: false, error: 'הסרטון עוד בעיבוד אצל מטא - נסו שוב בעוד דקה' });
        media = { type: 'video', id: videoId, thumb };
      } else if (m?.type === 'image') {
        const hash = String(m.hash || '').replace(/[^\w]/g, '');
        if (!hash) return res.json({ success: false, error: 'התמונה לא הועלתה' });
        media = { type: 'image', hash };
      } else if (target.action !== 'remove') return res.json({ success: false, error: 'לא נבחרה מדיה' });

      const spec = creativeWithMedia(ad.data.creative, media, target);
      if ('error' in spec) return res.json({ success: false, error: spec.error });
      if ((spec as any).asset_feed_spec) fixAssetRules((spec as any).asset_feed_spec);
      const what = target.action === 'remove' ? 'הסרת כרטיס' : media?.type === 'image' ? 'תמונה' : 'סרטון';
      const body: Record<string, string> = { name: `${ad.data.creative?.name || ad.data.name} · ${what} ${new Date().toLocaleDateString('he-IL')}`.slice(0, 200) };
      for (const [k, val] of Object.entries(spec)) if (val != null) body[k] = typeof val === 'string' ? val : JSON.stringify(val);
      const cr = await metaPost(`${creds.accountId}/adcreatives`, creds.token, body);
      if (!cr.ok || !cr.data?.id) return res.json({ success: false, error: `יצירת המודעה נכשלה: ${metaErr(cr.data)}` });
      const creativeId = String(cr.data.id);
      const log = (objectId: string, objectName: string, action: string, title: string, before: any, after: any, ok: boolean, error: string | null) =>
        p.query(
          `INSERT INTO mk_changes (tenant_id, campaign_id, object_type, object_id, object_name, action, title, before, after, status, error, done_by)
           VALUES ($1, $2, 'ad', $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)`,
          [currentTenant(), String(ad.data.campaign_id), objectId, objectName, action, title, JSON.stringify(before), JSON.stringify(after), ok ? 'done' : 'failed', error, who()],
        );

      if (mode === 'new_ad') {
        const name = String(b.newAdName || `${ad.data.name} · ${what} חדש`).slice(0, 200);
        const na = await metaPost(`${creds.accountId}/ads`, creds.token, { name, adset_id: String(ad.data.adset_id), creative: JSON.stringify({ creative_id: creativeId }), status: 'PAUSED' });
        const ok = na.ok && !!na.data?.id;
        await log(ok ? String(na.data.id) : adId, name, 'create_ad', `מודעה חדשה (${what})`, { status: 'ARCHIVED' }, { status: 'PAUSED' }, ok, ok ? null : metaErr(na.data));
        return res.json(ok ? { success: true, adId: String(na.data.id), name } : { success: false, error: metaErr(na.data) });
      }
      const oldCreative = String(ad.data.creative?.id || '');
      const sw = await metaPost(adId, creds.token, { creative: JSON.stringify({ creative_id: creativeId }) });
      const ok = sw.ok && sw.data?.success !== false;
      await log(adId, String(ad.data.name), 'replace_creative', `${what === 'הסרת כרטיס' ? 'הסרת כרטיס מהקרוסלה' : `החלפת ${what} במודעה`}`, { creative_id: oldCreative }, { creative_id: creativeId }, ok, ok ? null : metaErr(sw.data));
      res.json(ok ? { success: true, adId } : { success: false, error: metaErr(sw.data) });
    } catch (e: any) {
      console.error('[ad media]', e?.message);
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });
}
