/**
 * A rate limit for the handful of endpoints that must answer before anyone has
 * proved who they are: signing in, and the two ways an agent joins.
 *
 * Those endpoints do real work for an anonymous caller — a sign-in asks the
 * identity provider about a token, and starting a device authorisation writes
 * records this node then has to hold for ten minutes. Without a limit, one
 * script can make this node hammer somebody else's service, or fill its own
 * storage. The limit is per caller and deliberately loose: a device
 * authorisation polls every three seconds for ten minutes, and that has to stay
 * comfortably inside it.
 *
 * Callers are counted by address, so a node that cannot tell its callers apart
 * counts nobody: it is better to leave a local development node unlimited than
 * to throttle every caller as one.
 */
const WINDOW_MS = 10 * 60 * 1000;

/** Requests allowed per caller per window, by method and path. */
export const OPEN_ENDPOINTS = new Map([
  ['POST /api/login', 30],
  ['POST /api/agent/v1/pair', 30],
  ['POST /api/agent/v1/device', 30],
  // Polled every three seconds for up to ten minutes, twice over.
  ['POST /api/agent/v1/device/token', 400],
]);

export function createThrottle({ windowMs = WINDOW_MS, limits = OPEN_ENDPOINTS, now = () => Date.now() } = {}) {
  const seen = new Map();
  return {
    /** @returns seconds to wait, or 0 when the request may proceed. */
    check(method, path, caller) {
      const limit = limits.get(`${method} ${path}`);
      if (!limit || !caller) return 0;
      const key = `${caller} ${method} ${path}`;
      const at = now();
      const recent = (seen.get(key) ?? []).filter(time => time > at - windowMs);
      if (recent.length >= limit) return Math.ceil((recent[0] + windowMs - at) / 1000);
      recent.push(at);
      seen.set(key, recent);
      return 0;
    },
    /** Called on the node's existing hourly sweep, so the map cannot grow for ever. */
    purge() {
      const at = now();
      for (const [key, times] of seen) {
        const recent = times.filter(time => time > at - windowMs);
        if (recent.length) seen.set(key, recent); else seen.delete(key);
      }
      return seen.size;
    },
  };
}
