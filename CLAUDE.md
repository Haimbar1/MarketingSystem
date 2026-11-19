# CLAUDE.md — MarketingSystem (the portal's "marketing" module)

Read automatically by Claude Code. See `SETUP.md` for running / deploying.

## What this system is

The SmartEsek portal's marketing module, started 2026-11-19 at Haim's request: **organic and paid Meta (Facebook / Instagram) posts for each business** in one place. A business owner (often from a phone, or through the WhatsApp bot נועם) gives an instruction in plain words; the system prepares the result (campaign, ad set, ads, media, texts) **for approval**, and only then uploads it to Meta. Built for SmartEsek's clients; the pilot is **האופטיקה הטובה** (portal tenant 1), lead campaigns.

Haim is non-technical and tests live — no staging. Push carefully.

## Decisions so far (Haim, 2026-11-19)

- Meta only for now (no Google / TikTok).
- Each business's own ad account, paid with its own card; the token comes from **the business's own Meta app** (a system user in its Business Manager) and is entered in the portal — so no App Review on SmartEsek's side for now. A later "connect Facebook" button through SmartEsek's own app would need business verification + Advanced Access for `ads_management`.
- Campaign kinds: lead form → CRM, click to WhatsApp (→ the bot נועם), traffic to a landing page, sales optimising for Purchase.
- Media: pictures, videos and carousels, like the organic posts; one ad gets every kind it can (flexible format / `asset_feed_spec`: pictures + videos + several texts and titles), a carousel is its own ad in the same ad set. Organic posts are sometimes promoted to paid.
- Approval: in this app (phone / web) or through נועם on WhatsApp. New campaigns are uploaded **PAUSED**; going live is a separate tap.
- Events back to Meta stay where they are: the landing page pixel, and the CRM's Conversions API (Schedule = booked exam, Purchase) — see the CRM's `server/metaCapi.ts`.
- Reports: like the CRM's FB ROI dashboard, plus what's needed.
- **Nothing changes in a running campaign without a person's approval** — the AI suggests, the person ticks and confirms each change (step 2). Nothing is done automatically until Haim decides what the AI may do alone.
- Ad set settings the builder must handle: audience (age, gender, places + radius, interests, custom / lookalike audiences included / excluded, Advantage+ audience), **placement value rules** (Haim's rule set "+50% on feed FB / Instagram reel": `act_…/value_rule_set`, attached with `value_rule_set_id` + `value_rules_applied`; an ad set can't have both value rules and bid multipliers), budgets / bid strategy, optimisation goal, attribution, frequency. New campaigns start as a copy of a proven one's settings ("like the 150 campaign, for Haifa").
- Lookalikes: the CRM already exports buyers / non-buyers (`GET /api/meta-audience`); here they'll be uploaded as a custom audience (hashed) and a lookalike made from it (needs the Custom Audience terms accepted on the ad account).

## Plan

1. ✅ Read-only snapshot of the ad account — "📣 ממומן" (`server/metaAdsSnapshot.ts`, `src/components/AdsSnapshotView.tsx`, `GET /api/meta-ads/snapshot`). Also in WhastAppSystem's posts screen until this app is live.
2. ✅ **Maintaining a running campaign** (Haim, 2026-11-19 — "before a new campaign, maintain an existing one: analyse, suggest changes, approve and execute"; `server/campaignOptimizer.ts`, `src/components/CampaignOptimizer.tsx`, "🔧 ניתוח והצעות לשיפור" on each campaign in "📣 ממומן"). `POST /api/meta-ads/campaigns/:id/analyze` reads the campaign, ad sets, ads, their 7 / 30-day results, 14 days by day, placements and age × gender, and Gemini (`server/ai.ts`, the business's key else the platform's; every call reported to the CRM's `/api/ai-usage/ingest` as app `marketing`) returns a summary, findings and suggestions. **Each suggestion is checked in code** (`validate`): only `pause_ad` / `activate_ad` / `pause_adset` / `activate_adset` / `set_adset_daily_budget` / `set_campaign_daily_budget` / `set_adset_age` / `apply_value_rule_set` can be executed — anything else is advice ("manual"); a budget change is capped at ±50% of the current one and never under the account's minimum; the last active ad of an ad set / the last active ad set is never paused; age 18–65 (≤25 minimum with Advantage+ audience); value rules not on an ad set with bid multipliers. Stored with each target's value at the time (`mk_optimizations`). `POST /api/meta-ads/optimizations/:id/execute` runs only what the person ticked and confirmed (a budget can be edited, same ±50% limit), within 24h of the analysis; **each target is read again and skipped if it changed in Meta since**; every change goes to `mk_changes` (before / after / who / Meta's error). `POST /api/meta-ads/changes/:id/undo` writes "before" back (only if the value is still what we set; once). Executing needs DATABASE_URL — without it the analysis works and execution is refused. Tested end to end with a mocked Graph / Gemini on PGlite.
   **With the CRM's outcomes** (same day; Haim: "must equal the CRM's own calculation" and "we want to know what a period's leads did — last week's leads haven't bought yet, so no ROAS for them"): `readCampaign` asks the CRM's `POST /api/marketing/campaign-outcomes` (`x-marketing-token`, typ `marketing-outcomes`, portal tenant id) for three periods in Israel days (`outcomePeriods`): **last7** (maturity `early` — leads / bookings only, ROAS "מוקדם מדי לדעת"), **last30** (`partial` — ROAS "עוד מבשיל") and **prev30** = 30–60 days ago (`mature` — the real ROAS). The CRM computes each exactly like its dashboard's ROI table (leads by arrival day, their purchases since, spend in ILS at each day's rate) — so the spend and the CRM numbers shown here come from the CRM, not from Meta's insights. The AI gets `crmByPeriod` with the maturity and is told not to judge purchases on `early`. Shown as one table row per period (`SummaryTable`); per ad set / ad a green line of counts per period (no ROAS — the CRM's spend isn't split by ad set). No CRM / not reachable → Meta's own 7 / 30-day numbers at today's rate.
3. AI campaign draft from an instruction (copying a proven campaign's settings) → approval → uploaded PAUSED.
4. CRM buyers → custom audience → lookalike, refreshed.
5. Organic posts move here from WhastAppSystem (its `facebook-posts` routes, `FacebookPostView.tsx`, the video maker…), gradually; the old screen stays there until the new one works.

## How it's built

- React 19 + Vite + Tailwind 4, no router; Express, run as one Vercel function (`api/index.ts` wraps `createApp({ serveFrontend: false })` from `server.ts`; `vercel.json` sends `/api/:path*` there — a new standalone `api/*.ts` needs its own rewrite before it). Locally `npm run dev` (Vite in middleware mode).
- **Login only through the portal**: the portal's module button sends `<base_url>?sso_token=…` (60s JWT, `SSO_SHARED_SECRET`); `POST /api/auth/sso` accepts it only when its `aud` is this app's host (or one in `MK_APP_HOSTS`) and it names a business, and returns the session (`x-mk-session`, 30 days, `server/session.ts`). **Every other `/api` call needs that session — there is no default business** (unlike the older apps' "no session = tenant 1").
- Per request business: `server/tenant.ts` (AsyncLocalStorage). Portal tenant id = this app's business id.
- Keys: the portal vault as module `marketing` (`server/secrets.ts`, `tenantSecret`); the catalog (`portal/server/src/secrets/catalog.js`) lists which keys go to `marketing` (today FB_ADS_ACCESS_TOKEN, FB_AD_ACCOUNT_ID, FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN, GEMINI_API_KEY). The optics may fall back to this app's Vercel env. Add new per-business keys to that catalog, not as Vercel env vars.
- Meta Graph v21.0. Meta keeps retiring fields and one unknown field fails a whole request — `readEdge` drops a field Meta says doesn't exist and retries.
- Database: `DATABASE_URL` (Postgres, `pg`, `server/db.ts`), tables `mk_*` created lazily, per business (`tenant_id`). Without it, reading works and anything that changes Meta is refused.
- Never point local tests at real Meta write endpoints — a create call spends the business's money once the campaign is active.
