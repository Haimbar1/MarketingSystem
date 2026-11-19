import jwt from 'jsonwebtoken';

// The browser's session after a portal login: a JWT naming the business, signed with
// MK_SESSION_SECRET (else SSO_SHARED_SECRET). Sent on every /api call in this header.
export const SESSION_HEADER = 'x-mk-session';
const TYPE = 'mk_session';
const TTL = '30d';

export interface SessionClaims {
  tenantId: string;
  tenantName?: string | null;
  email: string;
  name?: string | null;
  role?: string | null;
  isSuperAdmin?: boolean;
}

const secret = () => process.env.MK_SESSION_SECRET || process.env.SSO_SHARED_SECRET || '';

export function signSession(c: SessionClaims): string | null {
  const s = secret();
  if (!s) return null;
  return jwt.sign({ ...c, tenantId: String(c.tenantId), typ: TYPE }, s, { expiresIn: TTL });
}

export function verifySession(token: string): SessionClaims | null {
  const s = secret();
  if (!s || !token) return null;
  try {
    const p = jwt.verify(token, s) as any;
    if (p?.typ !== TYPE || !p.tenantId || !p.email) return null;
    return {
      tenantId: String(p.tenantId), tenantName: p.tenantName ?? null, email: String(p.email),
      name: p.name ?? null, role: p.role ?? null, isSuperAdmin: !!p.isSuperAdmin,
    };
  } catch {
    return null;
  }
}

// A token the portal minted (TenantHome → ?sso_token=…, 60s). It counts only if it was minted for
// THIS app: every module shares SSO_SHARED_SECRET, so `aud` (the module's host in the portal's
// base_url) is what stops a CRM token being replayed here. MK_APP_HOSTS (comma separated) can list
// extra hosts, e.g. the *.vercel.app address while the domain isn't set up yet.
export function sessionFromPortalToken(token: string, requestHost: string): { session: string; claims: SessionClaims } | { error: string } {
  const shared = process.env.SSO_SHARED_SECRET;
  if (!shared) return { error: 'SSO אינו מוגדר בשרת (חסר SSO_SHARED_SECRET)' };
  let p: any;
  try {
    p = jwt.verify(token, shared);
  } catch {
    return { error: 'קישור הכניסה לא תקין או שפג תוקפו - היכנסו שוב מהפורטל' };
  }
  const hosts = new Set([requestHost, ...String(process.env.MK_APP_HOSTS || '').split(',')].map(h => h.trim().toLowerCase()).filter(Boolean));
  const aud = (Array.isArray(p.aud) ? p.aud : [p.aud]).map((a: any) => String(a || '').toLowerCase());
  if (!aud.some((a: string) => hosts.has(a))) return { error: 'קישור הכניסה נוצר למערכת אחרת - היכנסו מהכפתור של מערכת השיווק בפורטל' };
  const tenantId = String(p.tenant?.id ?? '').replace(/\D/g, '');
  const email = String(p.email || '').toLowerCase().trim();
  if (!tenantId || !email) return { error: 'הפורטל לא ציין עסק או משתמש' };
  const claims: SessionClaims = {
    tenantId, tenantName: p.tenant?.name || null, email, name: p.name || null,
    role: p.isSuperAdmin ? 'owner' : p.role || null, isSuperAdmin: !!p.isSuperAdmin,
  };
  const session = signSession(claims);
  return session ? { session, claims } : { error: 'לא ניתן ליצור כניסה' };
}
