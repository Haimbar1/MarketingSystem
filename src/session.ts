// The browser side of the login: the session from /api/auth/sso, kept per tab (sessionStorage) and
// seeded from localStorage for a new tab, and a fetch wrapper that adds it to every /api call.
const KEY = 'mk_session';
export const SESSION_HEADER = 'x-mk-session';

let current: string | null = null;
try { current = sessionStorage.getItem(KEY) || localStorage.getItem(KEY); } catch { /* storage blocked */ }

export function getSession() { return current; }

export function setSession(token: string | null) {
  current = token;
  try {
    if (token) { sessionStorage.setItem(KEY, token); localStorage.setItem(KEY, token); }
    else { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); }
  } catch { /* storage blocked */ }
}

const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const sameOriginApi = url.startsWith('/api/') || url.startsWith(`${location.origin}/api/`);
  if (sameOriginApi && current) {
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (!headers.has(SESSION_HEADER)) headers.set(SESSION_HEADER, current);
    init = { ...init, headers };
  }
  return realFetch(input, init);
};
