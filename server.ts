// MarketingSystem (marketing module of the SmartEsek portal): organic + paid Meta posts for each
// business. Started 2026-11-19 (Haim): the paid-campaigns module, and later the organic posts
// moved here from WhastAppSystem. Same Express-on-Vercel pattern as the other apps: locally
// `startServer()` runs a normal process; on Vercel api/index.ts wraps createApp({ serveFrontend: false }).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_HEADER, sessionFromPortalToken, verifySession } from './server/session.js';
import { runWithTenant } from './server/tenant.js';
import { registerAdsSnapshotRoutes } from './server/metaAdsSnapshot.js';
import { registerOptimizerRoutes } from './server/campaignOptimizer.js';
import { registerAdMediaRoutes } from './server/adMedia.js';

const requestHost = (req: express.Request) =>
  String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();

export async function createApp({ serveFrontend }: { serveFrontend: boolean }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // --- open routes (no business yet) ---
  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'marketing' }));

  // The portal's TenantHome sends the person to <base_url>?sso_token=…; the page posts it here.
  app.post('/api/auth/sso', (req, res) => {
    const token = String(req.body?.token || '');
    if (!token) return res.status(400).json({ success: false, error: 'חסר טוקן כניסה' });
    const r = sessionFromPortalToken(token, requestHost(req));
    if ('error' in r) return res.status(401).json({ success: false, error: r.error });
    res.json({ success: true, session: r.session, user: r.claims });
  });

  // --- everything else needs a signed-in business ---
  app.use('/api', (req, res, next) => {
    const claims = verifySession(String(req.headers[SESSION_HEADER] || '').trim());
    if (!claims) {
      res.setHeader('x-mk-session-expired', '1');
      return res.status(401).json({ success: false, error: 'session-expired', message: 'יש להיכנס מחדש דרך הפורטל' });
    }
    runWithTenant({ tenantId: claims.tenantId, email: claims.email, role: claims.role || null }, () => next());
  });

  app.get('/api/auth/me', (req, res) => {
    res.json({ success: true, user: verifySession(String(req.headers[SESSION_HEADER] || '').trim()) });
  });

  // Paid campaigns, step 1: read-only snapshot of the Meta ad account.
  registerAdsSnapshotRoutes(app);
  // Maintaining a running campaign: analyse → suggestions → approve → execute / undo.
  registerOptimizerRoutes(app);
  // Replace / add a video in an ad (new ad in the same ad set, or swap the creative).
  registerAdMediaRoutes(app);

  app.use('/api', (_req, res) => res.status(404).json({ success: false, error: 'not-found' }));

  if (serveFrontend) {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    if (process.env.NODE_ENV === 'production') {
      const dist = path.join(dir, 'dist');
      app.use(express.static(dist));
      app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
    } else {
      const { createServer } = await import('vite');
      const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
      app.use(vite.middlewares);
    }
  }
  return app;
}

export async function startServer() {
  const app = await createApp({ serveFrontend: true });
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`marketing system on http://localhost:${port}`));
}

if (!process.env.VERCEL && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer();
}
