import { identityFor, LoginError } from './flaremo.js';

// Explicitly synthetic, local-only identities. Never used as a live-login fallback.
export const demoMembers = [
  { username: 'demo-maker', displayName: '演示成员 · 创作者' },
  { username: 'demo-helper', displayName: '演示成员 · 协作者' },
];

/**
 * `members` replaces the two demo identities, e.g. with a scenario's synthetic
 * roster. `allowGuests` (public demo) also admits `guest-<name>` identities
 * with a visitor-chosen display name; they are just as fictional.
 */
export function createMockLogin({ members = demoMembers, allowGuests = false } = {}) {
  const origin = 'urn:agent-community:local-demo';
  return {
    origin, members, allowGuests,
    async signIn(input) {
      if (input?.password) throw new LoginError('DEMO_NO_PASSWORD', 400);
      const guest = allowGuests && /^guest-[a-z0-9-]{2,24}$/u.test(input?.username ?? '');
      const member = guest
        ? { username: input.username, displayName: typeof input.displayName === 'string' && input.displayName.trim() && input.displayName.trim().length <= 40 ? `${input.displayName.trim()}（访客）` : `${input.username}（访客）` }
        : members.find(value => value.username === input?.username);
      if (!member) throw new LoginError('UNKNOWN_DEMO_MEMBER', 400);
      return {
        identity: { ...identityFor(origin, { name: `users/${member.username}`, displayName: member.displayName }), synthetic: true },
        expiresAt: Date.now() + 3600000,
      };
    },
    async verify(session) {
      if (session.expiresAt <= Date.now()) throw new LoginError('SESSION_EXPIRED', 401);
      return session.identity;
    },
    async signOut() {},
  };
}
