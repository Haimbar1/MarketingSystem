// Deleting what this system created (Haim, 2026-11-20 - "let me delete a new campaign I created, and
// ad sets and ads"): a campaign made by "✨ קמפיין חדש מהוראה" (`create_campaign` in mk_changes) with
// any of its ad sets / ads, and an ad made by "🖼️ מדיה" (`create_ad`) in any campaign. The business's
// own older campaigns (the 150 one…) can't be deleted from here - Meta's deletion is final.
// Meta: POST /{id} status=DELETED. Logged in mk_changes as `delete` (not undoable).
import express from 'express';
import { db, ensureTables } from './db.js';
import { currentTenant, currentUser } from './tenant.js';
import { adsCredsForCurrentBusiness } from './metaAdsSnapshot.js';
import { gget, gpost, metaErr } from './campaignOptimizer.js';

const who = () => currentUser()?.email || 'unknown';
const NAMES: Record<string, string> = { campaign: 'הקמפיין', adset: 'סט המודעות', ad: 'המודעה' };

async function ours(): Promise<{ campaigns: Set<string>; ads: Set<string> }> {
  const p = await ensureTables();
  const r = await p.query(
    `SELECT action, object_id FROM mk_changes WHERE tenant_id = $1 AND status = 'done' AND action IN ('create_campaign', 'create_ad')`, [currentTenant()],
  );
  const campaigns = new Set<string>(), ads = new Set<string>();
  for (const row of r.rows) (row.action === 'create_campaign' ? campaigns : ads).add(String(row.object_id));
  return { campaigns, ads };
}

export function registerDeleteRoutes(app: express.Express) {
  // which campaigns / ads the screens may offer "🗑️" on
  app.get('/api/meta-ads/deletable', async (_req, res) => {
    if (!db()) return res.json({ success: true, campaigns: [], ads: [] });
    try {
      const o = await ours();
      res.json({ success: true, campaigns: Array.from(o.campaigns), ads: Array.from(o.ads) });
    } catch (e: any) {
      res.json({ success: false, error: e?.message, campaigns: [], ads: [] });
    }
  });

  app.post('/api/meta-ads/delete', async (req, res) => {
    if (!db()) return res.json({ success: false, error: 'צריך מסד נתונים' });
    try {
      const type = String(req.body?.type || '');
      const id = String(req.body?.id || '').replace(/\D/g, '');
      if (!['campaign', 'adset', 'ad'].includes(type) || !id) return res.json({ success: false, error: 'בקשה לא תקינה' });
      const creds = await adsCredsForCurrentBusiness();
      if (!creds) return res.json({ success: false, error: 'חסר טוקן פרסום של פייסבוק בפורטל' });
      const fields = type === 'campaign' ? 'id,name,status,account_id' : type === 'adset' ? 'id,name,status,campaign_id,account_id' : 'id,name,status,campaign_id,adset_id,account_id';
      const now = await gget(id, creds.token, { fields });
      if (!now.ok) return res.json({ success: false, error: metaErr(now.data) });
      if (String(now.data?.account_id || '') && `act_${now.data.account_id}` !== creds.accountId) return res.json({ success: false, error: 'לא שייך לחשבון המודעות של העסק' });
      const campaignId = type === 'campaign' ? id : String(now.data?.campaign_id || '');
      const o = await ours();
      if (!o.campaigns.has(campaignId) && !(type === 'ad' && o.ads.has(id))) {
        return res.json({ success: false, error: 'אפשר למחוק מכאן רק קמפיינים, סטים ומודעות שנוצרו במערכת השיווק. קמפיינים ישנים מוחקים במנהל המודעות של מטא.' });
      }
      const w = await gpost(id, creds.token, { status: 'DELETED' });
      const ok = w.ok && w.data?.success !== false;
      const p = await ensureTables();
      await p.query(
        `INSERT INTO mk_changes (tenant_id, campaign_id, object_type, object_id, object_name, action, title, before, after, status, error, done_by)
         VALUES ($1, $2, $3, $4, $5, 'delete', $6, $7::jsonb, $8::jsonb, $9, $10, $11)`,
        [currentTenant(), campaignId, type, id, now.data?.name || null, `מחיקת ${NAMES[type]}`, JSON.stringify({ status: now.data?.status }), JSON.stringify({ status: 'DELETED' }), ok ? 'done' : 'failed', ok ? null : metaErr(w.data), who()],
      );
      // the draft it came from leaves "📂 שמורות" at once (Meta may still report the old status for a while)
      if (ok && type === 'campaign') {
        await p.query(`UPDATE mk_drafts SET status = 'deleted' WHERE tenant_id = $1 AND published->>'campaignId' = $2`, [currentTenant(), id]).catch(() => {});
      }
      res.json({ success: ok, error: ok ? undefined : metaErr(w.data), name: now.data?.name });
    } catch (e: any) {
      res.json({ success: false, error: e?.message || 'שגיאה' });
    }
  });
}
