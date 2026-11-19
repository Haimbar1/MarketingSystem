import { AsyncLocalStorage } from 'node:async_hooks';

// Every request runs in one business (portal tenant id, as a string). There is NO default business:
// a request without a valid session is refused (unlike the older apps, where "no session = tenant 1").
const store = new AsyncLocalStorage<{ tenantId: string; email: string; role: string | null }>();

export const OPTICS_TENANT = '1'; // האופטיקה הטובה - the pilot

export function runWithTenant<T>(ctx: { tenantId: string; email: string; role: string | null }, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentTenant(): string {
  const t = store.getStore()?.tenantId;
  if (!t) throw new Error('no business for this request');
  return t;
}

export function currentUser() {
  return store.getStore() || null;
}
