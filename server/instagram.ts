// The Instagram account a new ad runs on (Haim's fifth try, 2026-11-20: "Instagram Account Is Missing ·
// Select an Instagram account or a Facebook Page to represent your business on Instagram", #100/1772103).
// A creative read from an older ad keeps its Instagram account in the retired `instagram_actor_id` (or not
// in object_story_spec at all), and a copy without `instagram_user_id` is refused for its Instagram
// placements. Found from: the base creatives' own spec / fields, the Page's connected Instagram account,
// the portal vault's INSTAGRAM_BUSINESS_ACCOUNT_ID.
import { gget, metaErr } from './campaignOptimizer.js';
import { tenantSecret } from './secrets.js';

export async function instagramIdFor(token: string, opts: { oss?: any[]; creativeIds?: string[]; pageId?: string }): Promise<string> {
  for (const o of opts.oss || []) {
    const v = o?.instagram_user_id || o?.instagram_actor_id;
    if (v) return String(v);
  }
  for (const id of (opts.creativeIds || []).filter(Boolean).slice(0, 3)) {
    for (const f of ['instagram_user_id', 'instagram_actor_id']) {
      const r = await gget(id, token, { fields: f });
      if (r.ok && r.data?.[f]) return String(r.data[f]);
    }
  }
  if (opts.pageId) {
    // the ads token may not see the Page's fields - the Page's own token (vault) next
    const pageToken = (await tenantSecret('FB_PAGE_ACCESS_TOKEN').catch(() => '')).trim();
    for (const t of [token, pageToken].filter(Boolean)) {
      const r = await gget(opts.pageId, t, { fields: 'instagram_business_account,connected_instagram_account' });
      const id = r.data?.instagram_business_account?.id || r.data?.connected_instagram_account?.id;
      if (id) return String(id);
    }
    const pb = await gget(`${opts.pageId}/page_backed_instagram_accounts`, token, { fields: 'id' });
    if (pb.data?.data?.[0]?.id) return String(pb.data.data[0].id);
  }
  return (await tenantSecret('INSTAGRAM_BUSINESS_ACCOUNT_ID').catch(() => '')).trim();
}

// the spec with the Instagram account (the retired field out)
export function withInstagram(spec: any, igId: string): any {
  const oss = spec?.object_story_spec;
  if (!oss || typeof oss !== 'object') return spec;
  const id = oss.instagram_user_id || igId || oss.instagram_actor_id;
  delete oss.instagram_actor_id;
  if (id) oss.instagram_user_id = String(id);
  return spec;
}

// Posts a creative; if Meta doesn't know `instagram_user_id` on this API version, once more with the old name
export async function postCreative(poster: (path: string, token: string, body: any) => Promise<{ ok: boolean; data: any }>, path: string, token: string, body: Record<string, any>) {
  const r = await poster(path, token, body);
  if (r.ok || !/instagram_user_id/i.test(metaErr(r.data) + JSON.stringify(r.data || {}))) return r;
  const raw = body.object_story_spec;
  const oss = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!oss?.instagram_user_id) return r;
  oss.instagram_actor_id = oss.instagram_user_id;
  delete oss.instagram_user_id;
  return poster(path, token, { ...body, object_story_spec: typeof raw === 'string' ? JSON.stringify(oss) : oss });
}
