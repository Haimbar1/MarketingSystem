import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createApp } from '../server.js';

// The whole Express app (server.ts) as one Vercel function, cached across warm invocations.
// A new standalone api/*.ts file needs its own vercel.json rewrite BEFORE the catch-all.
let cached: ReturnType<typeof createApp> | null = null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!cached) cached = createApp({ serveFrontend: false });
  const app = await cached;
  return (app as any)(req, res);
}
