import { identityFor, LoginError } from './flaremo.js';

// Explicitly synthetic, local-only identities. Never used as a live-login fallback.
export const demoMembers = [
  { username: 'demo-maker', displayName: '演示成员 · 创作者' },
  { username: 'demo-helper', displayName: '演示成员 · 协作者' },
];

export function createMockLogin() {
  const origin = 'urn:agent-community:local-demo';
  return {
    origin,
    async signIn(input) {
      if (input?.password) throw new LoginError('DEMO_NO_PASSWORD', 400);
      const member = demoMembers.find(value => value.username === input?.username);
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
