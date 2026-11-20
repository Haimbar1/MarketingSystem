// Changing several ads / ad sets at once (Haim, 2026-11-20 - "support changes to a campaign, like the WhatsApp
// message… for several ads at once, so we don't go one after the other"):
// - ads: the primary texts / titles / descriptions and, in WhatsApp ads, what the customer sees (pre-filled
//   message, welcome line, quick buttons). Meta can't edit a creative, so each ad gets a new creative with the
//   change, either swapped into the ad (it goes back to Meta's review, its learning starts over) or as a new
//   PAUSED ad in the same ad set. Same copying rules as the builder (placement rules kept in place, retired
//   standard enhancements out, the Instagram account in).
// - ad sets: location (cities / regions + radius) and gender, written into the ad set's targeting in place.
// Every change is logged in mk_changes (undoable: the old creative / the old targeting back).
import express from 'express';
import { db, ensureTables } from './db.js';
import { currentTenant, currentUser } from './tenant.js';
import { adsCredsForCurrentBusiness } from './metaAdsSnapshot.js';
import { gget, gpost, metaErr } from './campaignOptimizer.js';
import { applyTexts, kindOf, welcomeMessageJson, withWelcomeMessage, type Place } from './campaignBuilder.js';
import { cleanDof } from './assetRules.js';
import { instagramIdFor, withInstagram, postCreative } from './instagram.js';

const who = () => currentUser()?.email || 'unknown';
const AD_FIELDS = 'id,name,adset_id,campaign_id,account_id,status,creative{id,name,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,url_tags}';
const list = (v: any, max: number) => (Array.isArray(v) ? v : []).map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, max);

// the WhatsApp box an ad has now (to start the form from)
function welcomeOf(spec: any): { prefill: string; welcome: string; quick: string[] } | null {
  const raw = spec?.object_story_spec?.video_data?.page_welcome_message || spec?.object_story_spec?.link_data?.page_welcome_message || spec?.asset_feed_spec?.additional_data?.page_welcome_message;
  if (!raw) return null;
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const m = j?.text_format?.message || {};
    return { prefill: String(m.autofill_message?.content || ''), welcome: String(m.text || ''), quick: (m.ice_breakers || []).map((x: any) => String(x?.title || '')).filter(Boolean) };
  } catch { return null; }
}
function textsOf(c: any) {
  const afs = c?.asset_feed_spec;
  const oss = c?.object_story_spec || {};
  if (afs) return { bodies: (afs.bodies || []).map((b: any) => b.text), titles: (afs.titles || []).map((b: any) => b.text), descriptions: (afs.descriptions || []).map((b: any) => b.text), placementRules: !!afs.asset_customization_rules?.length };
  const d = oss.video_data || oss.link_data || {};
  return { bodies: [d.message].filter(Boolean), titles: [d.title || d.name].filter(Boolean), descriptions: [d.link_description || d.description].filter(Boolean), placementRules: false };
}

async function log(p: any, campaignId: string, type: string, id: string, name: string, action: string, title: string, before: any, after: any, ok: boolean, error: string | null) {
  await p.query(
    `INSERT INTO mk_changes (tenant_id, campaign_id, object_type, object_id, object_name, action, title, before, after, status, error, done_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)`,
    [currentTenant(), campaignId, type, id, name, action, title, JSON.stringify(before), JSON.stringify(after), ok ? 'done' : 'failed', error, who()],
  );
}

export function registerAdEditRoutes(app: express.Express) {
  // what the first chosen ad has now - the form starts from it
  app.get('/api/meta-ads/ads/:adId/texts', async (req, res) => {
    try {
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const ad = await gget(String(req.params.adId).replace(/\D/g, ''), creds.token, { fields: AD_FIELDS });
      if (!ad.ok) return res.json({ success: false, error: metaErr(ad.data) });
      const c = ad.data.creative || {};
      res.json({ success: true, ...textsOf(c), whatsapp: kindOf(null, [ad.data]) === 'whatsapp', wa: welcomeOf(c) });
    } catch (e: any) { res.json({ success: false, error: e?.message }); }
  });

  // texts / WhatsApp box for several ads
  app.post('/api/meta-ads/campaigns/:id/edit-ads', async (req, res) => {
    if (!db()) return res.json({ success: false, error: 'צריך מסד נתונים' });
    try {
      const p = await ensureTables();
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const campaignId = String(req.params.id).replace(/\D/g, '');
      const b = req.body || {};
      const adIds: string[] = (Array.isArray(b.adIds) ? b.adIds : []).map((x: any) => String(x).replace(/\D/g, '')).filter(Boolean).slice(0, 30);
      const mode = b.mode === 'new_ad' ? 'new_ad' : 'replace';
      const texts = { bodies: list(b.texts?.bodies, 5), titles: list(b.texts?.titles, 5), descriptions: list(b.texts?.descriptions, 3) };
      const wa = b.wa ? { waPrefill: String(b.wa.prefill || '').slice(0, 300), waWelcome: String(b.wa.welcome || '').slice(0, 600), waQuickReplies: list(b.wa.quick, 3) } : null;
      if (!adIds.length) return res.json({ success: false, error: 'לא נבחרו מודעות' });
      if (!texts.bodies.length && !texts.titles.length && !texts.descriptions.length && !wa) return res.json({ success: false, error: 'אין מה לשנות' });
      const results: any[] = [];
      for (const adId of adIds) {
        const ad = await gget(adId, creds.token, { fields: AD_FIELDS });
        const name = String(ad.data?.name || adId);
        if (!ad.ok) { results.push({ adId, name, ok: false, error: metaErr(ad.data) }); continue; }
        if (String(ad.data.campaign_id) !== campaignId || (ad.data.account_id && `act_${ad.data.account_id}` !== creds.accountId)) { results.push({ adId, name, ok: false, error: 'לא שייכת לקמפיין' }); continue; }
        const c = ad.data.creative || {};
        if (!c.object_story_spec && !c.asset_feed_spec) { results.push({ adId, name, ok: false, error: 'המודעה מבוססת על פוסט קיים מהדף - את הטקסט שלה משנים בפוסט עצמו' }); continue; }
        let spec: any = JSON.parse(JSON.stringify({ object_story_spec: c.object_story_spec, asset_feed_spec: c.asset_feed_spec, degrees_of_freedom_spec: c.degrees_of_freedom_spec, url_tags: c.url_tags }));
        spec = applyTexts(spec, texts);
        if (spec.degrees_of_freedom_spec !== undefined) spec.degrees_of_freedom_spec = cleanDof(spec.degrees_of_freedom_spec);
        const oss = c.object_story_spec;
        spec = withInstagram(spec, await instagramIdFor(creds.token, { oss: [oss], creativeIds: [String(c.id || '')], pageId: String(oss?.page_id || '') }));
        const isWa = kindOf(null, [ad.data]) === 'whatsapp';
        let notes = '';
        if (wa && isWa) spec = withWelcomeMessage(spec, welcomeMessageJson(wa));
        else if (wa && !isWa && !texts.bodies.length && !texts.titles.length && !texts.descriptions.length) { results.push({ adId, name, ok: false, error: 'זו לא מודעת וואטסאפ' }); continue; }
        const body: Record<string, any> = { name: `${c.name || name} · ✏️ ${new Date().toLocaleDateString('he-IL')}`.slice(0, 200) };
        for (const [k, v] of Object.entries(spec)) if (v != null) body[k] = typeof v === 'string' ? v : JSON.stringify(v);
        let cr = await postCreative(gpost, `${creds.accountId}/adcreatives`, creds.token, body);
        if (!cr.ok && wa && isWa) {
          // the WhatsApp box is the least documented part - the texts go without it rather than not at all
          const strip = (k: string) => { if (!body[k]) return; const v = JSON.parse(body[k]); delete v.video_data?.page_welcome_message; delete v.link_data?.page_welcome_message; delete v.additional_data?.page_welcome_message; body[k] = JSON.stringify(v); };
          strip('object_story_spec'); strip('asset_feed_spec');
          const again = await postCreative(gpost, `${creds.accountId}/adcreatives`, creds.token, body);
          if (again.ok) { cr = again; notes = 'הודעת הוואטסאפ לא התקבלה אצל מטא - לשנות במנהל המודעות (Conversations ← Edit)'; }
        }
        if (!cr.ok || !cr.data?.id) { results.push({ adId, name, ok: false, error: metaErr(cr.data) }); continue; }
        const creativeId = String(cr.data.id);
        const what = [texts.bodies.length || texts.titles.length || texts.descriptions.length ? 'טקסטים' : '', wa && isWa && !notes ? 'הודעת וואטסאפ' : ''].filter(Boolean).join(' + ');
        if (mode === 'replace') {
          const sw = await gpost(adId, creds.token, { creative: JSON.stringify({ creative_id: creativeId }) });
          const ok = sw.ok && sw.data?.success !== false;
          await log(p, campaignId, 'ad', adId, name, 'replace_creative', `שינוי ${what} במודעה`, { creative_id: String(c.id || '') }, { creative_id: creativeId }, ok, ok ? null : metaErr(sw.data));
          results.push({ adId, name, ok, error: ok ? undefined : metaErr(sw.data), note: notes || undefined });
        } else {
          const na = await gpost(`${creds.accountId}/ads`, creds.token, { name: `${name} · ✏️`.slice(0, 200), adset_id: String(ad.data.adset_id), creative: JSON.stringify({ creative_id: creativeId }), status: 'PAUSED' });
          const ok = na.ok && !!na.data?.id;
          await log(p, campaignId, 'ad', ok ? String(na.data.id) : adId, `${name} · ✏️`, 'create_ad', `מודעה חדשה (${what})`, { status: 'ARCHIVED' }, { status: 'PAUSED' }, ok, ok ? null : metaErr(na.data));
          results.push({ adId, name, ok, newAdId: ok ? String(na.data.id) : undefined, error: ok ? undefined : metaErr(na.data), note: notes || undefined });
        }
      }
      res.json({ success: results.some(r => r.ok), results });
    } catch (e: any) {
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });

  // location / gender for several ad sets
  app.post('/api/meta-ads/campaigns/:id/edit-adsets', async (req, res) => {
    if (!db()) return res.json({ success: false, error: 'צריך מסד נתונים' });
    try {
      const p = await ensureTables();
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const campaignId = String(req.params.id).replace(/\D/g, '');
      const b = req.body || {};
      const ids: string[] = (Array.isArray(b.adsetIds) ? b.adsetIds : []).map((x: any) => String(x).replace(/\D/g, '')).filter(Boolean).slice(0, 30);
      const places: Place[] | null = Array.isArray(b.places) && b.places.length ? b.places.filter((x: any) => x?.key).slice(0, 25) : null;
      const genders = ['all', 'female', 'male'].includes(b.genders) ? b.genders : null;
      if (!ids.length) return res.json({ success: false, error: 'לא נבחרו סטים' });
      if (!places && !genders) return res.json({ success: false, error: 'אין מה לשנות' });
      const results: any[] = [];
      for (const id of ids) {
        const st = await gget(id, creds.token, { fields: 'id,name,campaign_id,account_id,targeting' });
        const name = String(st.data?.name || id);
        if (!st.ok) { results.push({ id, name, ok: false, error: metaErr(st.data) }); continue; }
        if (String(st.data.campaign_id) !== campaignId) { results.push({ id, name, ok: false, error: 'לא שייך לקמפיין' }); continue; }
        const before = st.data.targeting || {};
        const t = JSON.parse(JSON.stringify(before));
        if (places) {
          const geo: any = {};
          const cities = places.filter(x => x.type === 'city'), regions = places.filter(x => x.type === 'region'), countries = places.filter(x => x.type === 'country');
          if (cities.length) geo.cities = cities.map(x => ({ key: x.key, ...(x.radiusKm ? { radius: Math.min(80, Math.max(17, Math.round(x.radiusKm))), distance_unit: 'kilometer' } : {}) }));
          if (regions.length) geo.regions = regions.map(x => ({ key: x.key }));
          if (countries.length) geo.countries = countries.map(x => x.key);
          geo.location_types = t.geo_locations?.location_types || ['home', 'recent'];
          t.geo_locations = geo;
          delete t.excluded_geo_locations;
        }
        if (genders === 'female') t.genders = [2]; else if (genders === 'male') t.genders = [1]; else if (genders === 'all') delete t.genders;
        const w = await gpost(id, creds.token, { targeting: JSON.stringify(t) });
        const ok = w.ok && w.data?.success !== false;
        const what = [places ? 'מיקום' : '', genders ? 'מגדר' : ''].filter(Boolean).join(' ו');
        await log(p, campaignId, 'adset', id, name, 'set_targeting', `שינוי ${what} בסט`, { targeting: before }, { targeting: t }, ok, ok ? null : metaErr(w.data));
        results.push({ id, name, ok, error: ok ? undefined : metaErr(w.data) });
      }
      res.json({ success: results.some(r => r.ok), results });
    } catch (e: any) {
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });
}
