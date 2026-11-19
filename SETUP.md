# SETUP — MarketingSystem

## Run locally

```bash
npm install
SSO_SHARED_SECRET=… npm run dev   # http://localhost:3000
```

Log in by minting a portal-style token (`{ email, name, tenant: { id, name }, role, aud: 'localhost:3000' }`, signed with the same secret) and opening `/?sso_token=<token>`.

## Deploy (Vercel)

1. Vercel → Add New → Project → import `Haimbar1/MarketingSystem`. Framework: Vite (build `npm run build`, output `dist`).
2. Environment variables: `SSO_SHARED_SECRET` (the same value as the portal and the other apps). Optional: `MK_APP_HOSTS` (extra hosts the portal's tokens may name, e.g. `marketingsystem.vercel.app`), `PORTAL_URL`.
3. Domain: `marketing.smartesek.com` (DNS CNAME to Vercel).
4. Portal → super-admin → modules → add: key `marketing`, name `שיווק`, base URL `https://marketing.smartesek.com`; enable it for the business and give users access.
