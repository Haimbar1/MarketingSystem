// Replacing / adding a video in an ad (Haim, 2026-11-19 - "update the video in an ad, and later any
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

// The ad's creative with the new video. `feed` (flexible ads with several assets): replace one video
// (`replaceVideoId`) or add the new one next to the others. Returns an error text when not possible.
export function creativeWithVideo(c: any, videoId: string, thumbUrl: string, feed: 'replace' | 'add', replaceVideoId?: string): CreativeSpec | { error: string } {
  if (!c) return { error: 'לא הצלחנו לקרוא את המודעה' };
  const out: CreativeSpec = {};
  if (c.url_tags) out.url_tags = c.url_tags;
  if (c.degrees_of_freedom_spec) out.degrees_of_freedom_spec = c.degrees_of_freedom_spec;
  const oss = c.object_story_spec ? JSON.parse(JSON.stringify(c.object_story_spec)) : null;

  if (c.asset_feed_spec) {
    const afs = JSON.parse(JSON.stringify(c.asset_feed_spec));
    const videos: any[] = Array.isArray(afs.videos) ? afs.videos : [];
    const entry = { video_id: videoId, thumbnail_url: thumbUrl };
    if (feed === 'replace' && videos.length) {
      const i = Math.max(0, videos.findIndex(v => String(v.video_id) === String(replaceVideoId)));
      videos[i] = { ...entry, ...(videos[i]?.adlabels ? { adlabels: videos[i].adlabels } : {}) };
    } else videos.push(entry);
    afs.videos = videos;
    if (Array.isArray(afs.ad_formats) && !afs.ad_formats.includes('SINGLE_VIDEO')) afs.ad_formats = [...afs.ad_formats, 'SINGLE_VIDEO'];
    out.asset_feed_spec = afs;
    if (oss) out.object_story_spec = oss;
    return out;
  }
  if (!oss) return { error: 'המודעה מבוססת על פוסט קיים מהדף - אי אפשר להחליף בה מדיה. אפשר ליצור מודעה חדשה מהפוסט / מהסרטון.' };
  if (oss.link_data?.child_attachments) return { error: 'זו מודעת קרוסלה - החלפת סרטון בקרוסלה עוד לא נתמכת' };
  if (oss.video_data) {
    const vd = { ...oss.video_data, video_id: videoId, image_url: thumbUrl };
    delete vd.image_hash;
    out.object_story_spec = { ...oss, video_data: vd };
    return out;
  }
  if (oss.link_data) {
    const ld = oss.link_data;
    const vd: any = { video_id: videoId, image_url: thumbUrl };
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
  return { error: 'סוג המודעה הזה עוד לא נתמך להחלפת סרטון' };
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

  // 5. what the ad holds (so the screen can offer "replace which video" for a flexible ad)
  app.get('/api/meta-ads/ads/:adId/media', async (req, res) => {
    try {
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן' });
      const r = await gget(String(req.params.adId).replace(/\D/g, ''), creds.token, { fields: 'id,name,creative{object_type,object_story_spec,asset_feed_spec,effective_object_story_id}' });
      if (!r.ok) return res.json({ success: false, error: metaErr(r.data) });
      const c = r.data?.creative || {};
      const afs = c.asset_feed_spec;
      const kind = afs ? 'flexible' : c.object_story_spec?.link_data?.child_attachments ? 'carousel' : c.object_story_spec?.video_data ? 'video' : c.object_story_spec?.link_data ? 'image' : c.object_story_spec ? 'other' : 'post';
      const ids: string[] = afs ? (afs.videos || []).map((v: any) => String(v.video_id)) : c.object_story_spec?.video_data?.video_id ? [String(c.object_story_spec.video_data.video_id)] : [];
      // what each video is (Haim, 2026-11-19 - "I don't understand what's in each video, only an id"):
      // its picture, title, length and a playable link when Meta gives one ...
      const details: Record<string, any> = {};
      if (ids.length) {
        const d = await gget('', creds.token, { ids: ids.join(','), fields: 'title,picture,length,source,created_time' });
        if (d.ok) Object.assign(details, d.data || {});
        else {
          const d2 = await gget('', creds.token, { ids: ids.join(','), fields: 'title,picture,length,created_time' });
          if (d2.ok) Object.assign(details, d2.data || {});
        }
      }
      // ... and, for a flexible ad, how each one did in the last 30 days (Meta's per-asset breakdown)
      const perf: Record<string, any> = {};
      if (afs && ids.length > 1) {
        const ins = await gget(`${String(req.params.adId).replace(/\D/g, '')}/insights`, creds.token, { breakdowns: 'video_asset', date_preset: 'last_30d', fields: 'spend,impressions,clicks,actions' });
        for (const row of ins.ok ? ins.data?.data || [] : []) {
          const vid = String(row.video_asset?.video_id || row.video_asset?.id || '');
          if (!vid) continue;
          const lead = (row.actions || []).find((a: any) => ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'].includes(a.action_type));
          perf[vid] = { spend: Number(row.spend) || 0, impressions: Number(row.impressions) || 0, leads: lead ? Number(lead.value) || 0 : 0 };
        }
      }
      const thumbOf = (id: string) => (afs?.videos || []).find((v: any) => String(v.video_id) === id)?.thumbnail_url || null;
      res.json({
        success: true, kind, images: (afs?.images || []).length,
        videos: ids.map(id => ({
          id, title: details[id]?.title || null, thumb: details[id]?.picture || thumbOf(id), length: details[id]?.length ? Math.round(Number(details[id].length)) : null,
          source: details[id]?.source || null, created: details[id]?.created_time || null, perf: perf[id] || null,
        })),
      });
    } catch (e: any) {
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });

  // 6. apply: { videoId, mode: 'new_ad' | 'replace', feed?: 'replace' | 'add', replaceVideoId?, newAdName? }
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
      const videoId = String(b.videoId || '').replace(/\D/g, '');
      const v = await gget(videoId, creds.token, { fields: 'status,picture,thumbnails{uri,is_preferred}' });
      const thumbs: any[] = v.data?.thumbnails?.data || [];
      const thumb = (thumbs.find(t => t.is_preferred) || thumbs[0])?.uri || v.data?.picture || '';
      if (!v.ok || v.data?.status?.video_status !== 'ready' || !thumb) return res.json({ success: false, error: 'הסרטון עוד בעיבוד אצל מטא - נסו שוב בעוד דקה' });

      const spec = creativeWithVideo(ad.data.creative, videoId, thumb, b.feed === 'replace' ? 'replace' : 'add', b.replaceVideoId ? String(b.replaceVideoId) : undefined);
      if ('error' in spec) return res.json({ success: false, error: spec.error });
      const body: Record<string, string> = { name: `${ad.data.creative?.name || ad.data.name} · סרטון ${new Date().toLocaleDateString('he-IL')}`.slice(0, 200) };
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
        const name = String(b.newAdName || `${ad.data.name} · סרטון חדש`).slice(0, 200);
        const na = await metaPost(`${creds.accountId}/ads`, creds.token, { name, adset_id: String(ad.data.adset_id), creative: JSON.stringify({ creative_id: creativeId }), status: 'PAUSED' });
        const ok = na.ok && !!na.data?.id;
        await log(ok ? String(na.data.id) : adId, name, 'create_ad', 'מודעה חדשה עם סרטון', { status: 'ARCHIVED' }, { status: 'PAUSED' }, ok, ok ? null : metaErr(na.data));
        return res.json(ok ? { success: true, adId: String(na.data.id), name } : { success: false, error: metaErr(na.data) });
      }
      const oldCreative = String(ad.data.creative?.id || '');
      const sw = await metaPost(adId, creds.token, { creative: JSON.stringify({ creative_id: creativeId }) });
      const ok = sw.ok && sw.data?.success !== false;
      await log(adId, String(ad.data.name), 'replace_creative', 'החלפת סרטון במודעה', { creative_id: oldCreative }, { creative_id: creativeId }, ok, ok ? null : metaErr(sw.data));
      res.json(ok ? { success: true, adId } : { success: false, error: metaErr(sw.data) });
    } catch (e: any) {
      console.error('[ad media]', e?.message);
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });
}
