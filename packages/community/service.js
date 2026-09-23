import { validateObject, validateRecord, validateGraph } from '../protocol/objects.js';
import { StoreError } from '../store/flaremo-objects.js';
import { newId, uuidPart, sha256, sameDigest, claimCode, normalizeCode, issueCredential, parseCredential } from './secrets.js';

/**
 * Community business rules over the FlareMo object store (RFC 0005/0007).
 * Every authority decision re-reads structured records from the store; the
 * only in-memory state is connector presence and wake-up signals.
 */
export class CommunityError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'CommunityError'; this.code = code; this.status = status; }
}
const fail = (code, status = 400) => { throw new CommunityError(code, status); };

export const REGISTRATION_TTL_MS = 10 * 60 * 1000;
export const MAX_CLAIM_ATTEMPTS = 5;
const MAX_PENDING_REGISTRATIONS = 50;
export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'rejected']);
const DEFAULT_TIME_LIMIT = 900;
const text = (value, max = 4000) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : fail('INVALID_TEXT');

/**
 * Agent profile (RFC 0009): who the agent is, what it can do, what it is
 * looking for. The agent drafts it; its owner edits it before and after it is
 * published. "What it can do" becomes Capability objects; the rest lives on Agent.
 */
export const PROFILE_LIMITS = { name: 60, intro: 1000, items: 6, title: 80, description: 600, seeking: 300 };
export function cleanProfile(input, { requireCapabilities = true } = {}) {
  const L = PROFILE_LIMITS;
  if (!input || typeof input !== 'object') fail('INVALID_PROFILE');
  const list = value => Array.isArray(value) ? value : value === undefined ? [] : fail('INVALID_PROFILE');
  const capabilities = list(input.capabilities ?? input.canDo).map(item => ({
    ...(item?.id ? { id: /^urn:uuid:[0-9a-f-]{36}$/u.test(item.id) ? item.id : fail('INVALID_PROFILE') } : {}),
    title: text(item?.title, L.title), description: text(item?.description, L.description),
  }));
  const seeking = list(input.seeking).map(item => text(item, L.seeking));
  if (capabilities.length > L.items || seeking.length > L.items || (requireCapabilities && !capabilities.length)) fail('INVALID_PROFILE');
  return {
    name: input.name === undefined || input.name === '' ? '' : text(input.name, L.name),
    intro: text(input.intro, L.intro), seeking, capabilities,
  };
}
const sameProfile = (a, b) => JSON.stringify([a.intro, a.seeking, a.capabilities.map(c => [c.title, c.description])]) === JSON.stringify([b.intro, b.seeking, b.capabilities.map(c => [c.title, c.description])]);

export class CommunityService {
  #lastTime = 0;
  constructor({ store, kv, communityId = null, publicOrigin, materials, ownerSubject = null, openBootstrap = false, openJoin = false, now = () => Date.now() }) {
    this.kv = kv;
    this.ownerSubject = ownerSubject;
    this.openBootstrap = openBootstrap;
    this.openJoin = openJoin;
    this.store = store;
    this.communityId = communityId;
    this.publicOrigin = publicOrigin;
    this.materials = materials;
    this.clock = now;
    this.presence = new Map();
    this.waiters = new Map();
  }

  /** Strictly increasing canonical UTC timestamps across this process. */
  now() {
    this.#lastTime = Math.max(this.clock(), this.#lastTime + 1);
    return new Date(this.#lastTime).toISOString();
  }

  // ---------- entity helpers ----------
  create(kind, data, actor, visibility) {
    const record = !['Community', 'Human', 'Agent', 'Capability', 'Request', 'Workroom', 'Artifact', 'Attestation'].includes(kind);
    const at = this.now();
    const id = kind === 'Community' ? data.__id : newId();
    delete data.__id;
    return {
      protocol: record ? 'community-records' : 'community-objects', schemaVersion: '0.1.0', kind, id,
      communityId: kind === 'Community' ? id : this.communityId, revision: 1, createdAt: at, updatedAt: at,
      lifecycle: 'active', actor, ...(record ? {} : { visibility: visibility ?? { scope: 'community' } }), data,
    };
  }
  next(entity, change, actor) {
    const copy = structuredClone(entity);
    copy.revision += 1;
    // Strictly after the previous revision even if another instance's clock lags.
    const at = this.now();
    copy.updatedAt = at > entity.updatedAt ? at : new Date(Date.parse(entity.updatedAt) + 1).toISOString();
    if (actor) copy.actor = actor;
    Object.assign(copy.data, change);
    for (const [key, value] of Object.entries(change)) if (value === undefined) delete copy.data[key];
    return copy;
  }
  static actorOf(human) { return { kind: 'Human', id: human.id, principalId: human.id }; }
  static agentActor(agent) { return { kind: 'Agent', id: agent.id, principalId: agent.data.principalId }; }

  async commit(commandId, entities) {
    for (const entity of entities) (entity.protocol === 'community-records' ? validateRecord : validateObject)(entity);
    const writes = entities.map(entity => ({ expectedRevision: entity.revision - 1, entity }));
    return this.store.transact({ communityId: this.communityId, commandId, writes });
  }

  /** Optimistic read-modify-write; rebuilds from fresh records on conflict. */
  async retrying(build, attempts = 4) {
    for (let attempt = 1; ; attempt += 1) {
      try { return await build(); }
      catch (error) {
        if (!(error instanceof StoreError) || error.code !== 'REVISION_CONFLICT' || attempt >= attempts) throw error;
      }
    }
  }

  get(kind, id) { return this.store.find(this.communityId, this.#category(kind), id); }
  async must(kind, id) {
    if (typeof id !== 'string' || !/^urn:uuid:[0-9a-f-]{36}$/u.test(id)) fail('INVALID_ID');
    const entity = await this.get(kind, id);
    if (!entity || entity.kind !== kind || entity.lifecycle !== 'active') fail(`${kind.toUpperCase()}_NOT_FOUND`, 404);
    return entity;
  }
  list(kind) { return this.store.list(this.communityId, this.#category(kind), kind); }
  #category(kind) { return ['Membership', 'IdentityLink', 'AgentBinding', 'Grant', 'Execution', 'Invitation', 'Match', 'Suggestion', 'Preflight', 'Consent', 'AgentToken'].includes(kind) ? 'record' : 'object'; }

  // ---------- community, identity and membership ----------
  async bootstrap({ identity, displayName, communityName }) {
    if (this.communityId) fail('COMMUNITY_EXISTS', 409);
    if (!identity?.provider || !identity?.subject) fail('IDENTITY_REQUIRED', 401);
    // A public node must not let whoever signs in first become the owner.
    if (!this.openBootstrap) {
      if (!this.ownerSubject) fail('BOOTSTRAP_NOT_CONFIGURED', 403);
      if (identity.subject !== this.ownerSubject) fail('BOOTSTRAP_NOT_ALLOWED', 403);
    }
    const communityId = newId(), humanId = newId();
    this.communityId = communityId;
    const actor = { kind: 'Human', id: humanId, principalId: humanId };
    const community = this.create('Community', { __id: communityId, displayName: text(communityName, 200), ownerHumanId: humanId, status: 'active' }, actor);
    const human = this.create('Human', { personId: newId(), displayName: text(displayName, 200), status: 'active' }, actor);
    human.id = humanId;
    const membership = this.create('Membership', { humanId, role: 'owner', status: 'active' }, actor);
    const link = this.create('IdentityLink', { humanId, provider: identity.provider, subject: identity.subject, status: 'active' }, actor);
    try { await this.commit(`bootstrap:${uuidPart(communityId)}`, [community, human, membership, link]); }
    catch (error) { this.communityId = null; throw error; }
    return { communityId, humanId };
  }

  /** Resolves a verified external identity to this community's member record. */
  async memberFor(identity) {
    if (!this.communityId || !identity) return null;
    const link = (await this.list('IdentityLink')).find(item => item.lifecycle === 'active' && item.data.status === 'active' && item.data.provider === identity.provider && item.data.subject === identity.subject);
    if (!link) return null;
    const human = await this.get('Human', link.data.humanId);
    const membership = (await this.list('Membership')).find(item => item.data.humanId === link.data.humanId);
    return human && membership ? { human, membership, active: human.data.status === 'active' && membership.data.status === 'active' } : null;
  }

  async activeMember(humanId) {
    const human = await this.must('Human', humanId);
    const membership = (await this.list('Membership')).find(item => item.data.humanId === humanId);
    if (human.data.status !== 'active' || membership?.data.status !== 'active') fail('MEMBERSHIP_REQUIRED', 403);
    return { human, membership };
  }

  /** Joining requires an owner-issued invitation unless the node runs with openJoin. */
  async join({ identity, displayName, inviteCode }) {
    if (!this.communityId) fail('COMMUNITY_NOT_CREATED', 404);
    if (await this.memberFor(identity)) fail('ALREADY_MEMBER', 409);
    return this.retrying(async () => {
      const invitation = this.openJoin && !inviteCode ? null : await this.#invitationByCode(inviteCode);
      const humanId = newId(), actor = { kind: 'Human', id: humanId, principalId: humanId };
      const human = this.create('Human', { personId: newId(), displayName: text(displayName, 200), status: 'active' }, actor);
      human.id = humanId;
      const membership = this.create('Membership', { humanId, role: invitation?.data.role ?? 'member', status: 'active' }, actor);
      const link = this.create('IdentityLink', { humanId, provider: identity.provider, subject: identity.subject, status: 'active' }, actor);
      const writes = [human, membership, link];
      if (invitation) {
        const uses = invitation.data.uses + 1;
        // The revision check makes concurrent joins unable to exceed maxUses.
        writes.push(this.next(invitation, { uses, status: uses >= invitation.data.maxUses ? 'exhausted' : 'active' }, actor));
      }
      await this.commit(`join:${sha256(`${identity.provider}\n${identity.subject}`).slice(0, 32)}`, writes);
      return { humanId };
    });
  }

  // ---------- invitations (owner-issued, shown once, revocable) ----------
  async #owner(humanId) {
    const owner = await this.activeMember(humanId);
    if (owner.membership.data.role !== 'owner') fail('OWNER_REQUIRED', 403);
    return owner;
  }

  async #invitationByCode(code) {
    const normalized = normalizeCode(code);
    if (normalized.length !== 16) fail('INVITE_REQUIRED', 403);
    const hash = sha256(normalized);
    const invitation = (await this.list('Invitation')).find(item => sameDigest(item.data.codeHash, hash));
    if (!invitation) fail('INVITE_INVALID', 403);
    if (invitation.data.status !== 'active') fail(`INVITE_${invitation.data.status.toUpperCase()}`, 403);
    if (Date.parse(invitation.data.expiresAt) <= this.clock()) fail('INVITE_EXPIRED', 403);
    if (invitation.data.uses >= invitation.data.maxUses) fail('INVITE_EXHAUSTED', 403);
    return invitation;
  }

  async createInvitation({ humanId, maxUses = 1, ttlHours = 72, label }) {
    const { human } = await this.#owner(humanId);
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 100) fail('INVALID_MAX_USES');
    if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 30) fail('INVALID_TTL');
    const code = claimCode();
    const invitation = this.create('Invitation', {
      issuerHumanId: humanId, role: 'member', codeHash: sha256(normalizeCode(code)), maxUses, uses: 0,
      expiresAt: new Date(this.clock() + ttlHours * 3600 * 1000).toISOString(), status: 'active', ...(label ? { label: text(label, 200) } : {}),
    }, CommunityService.actorOf(human));
    await this.commit(`invite:${uuidPart(invitation.id)}`, [invitation]);
    // The code itself is returned once and never stored.
    return { invitationId: invitation.id, code, inviteUrl: `${this.publicOrigin}/invite/${code}`, expiresAt: invitation.data.expiresAt, maxUses };
  }

  async listInvitations({ humanId }) {
    await this.#owner(humanId);
    return (await this.list('Invitation')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => {
      const { codeHash, ...data } = item.data;
      void codeHash;
      return { id: item.id, ...data, status: data.status === 'active' && Date.parse(data.expiresAt) <= this.clock() ? 'expired' : data.status, createdAt: item.createdAt };
    });
  }

  async revokeInvitation({ humanId, invitationId }) {
    const { human } = await this.#owner(humanId);
    return this.retrying(async () => {
      const invitation = await this.must('Invitation', invitationId);
      if (invitation.data.status !== 'active') fail('INVITE_NOT_ACTIVE', 409);
      await this.commit(`invite-revoke:${newId()}`, [this.next(invitation, { status: 'revoked' }, CommunityService.actorOf(human))]);
      return { invitationId, status: 'revoked' };
    });
  }

  /** Owner-governed membership change; suspension cascades to the member's agents. */
  async setMembership({ ownerHumanId, humanId, status }) {
    const owner = await this.activeMember(ownerHumanId);
    if (owner.membership.data.role !== 'owner') fail('OWNER_REQUIRED', 403);
    if (!['active', 'suspended', 'removed'].includes(status)) fail('INVALID_STATUS');
    return this.retrying(async () => {
      const membership = (await this.list('Membership')).find(item => item.data.humanId === humanId) ?? fail('MEMBERSHIP_NOT_FOUND', 404);
      const human = await this.must('Human', humanId);
      const actor = CommunityService.actorOf(owner.human);
      const writes = [this.next(membership, { status }, actor), this.next(human, { status: status === 'active' ? 'active' : status === 'removed' ? 'left' : 'suspended' }, actor)];
      if (status !== 'active') {
        for (const agent of (await this.list('Agent')).filter(item => item.data.principalId === humanId && item.data.bindingStatus === 'verified')) {
          writes.push(...await this.#revokeAgentWrites(agent, actor, 'membership-changed'));
        }
      }
      await this.commit(`membership:${newId()}`, writes);
      return { humanId, status };
    });
  }

  // ---------- agents: connector registration and claim (RFC 0007 §4) ----------
  cardUrl(agentId) { return `${this.publicOrigin}/a2a/agents/${uuidPart(agentId)}/.well-known/agent-card.json`; }
  endpointUrl(agentId) { return `${this.publicOrigin}/a2a/agents/${uuidPart(agentId)}`; }

  /**
   * Step 1, connector side, unauthenticated: the connector announces itself
   * with the hash of a secret it generated locally. Nothing is written to
   * FlareMo; the pending registration lives in node-local storage and expires.
   */
  async register({ connector, credentialHash, deviceId, profile }) {
    if (!/^[0-9a-f]{64}$/u.test(credentialHash ?? '')) fail('INVALID_CREDENTIAL_HASH');
    // The network asks every agent to introduce itself; the owner reviews it at claim time.
    const profileDraft = cleanProfile(profile);
    // The fingerprint the member checks is derived from the credential hash itself.
    if (connector?.fingerprint !== sha256(credentialHash).slice(0, 16)) fail('FINGERPRINT_NOT_DERIVED');
    if (!/^urn:uuid:[0-9a-f-]{36}$/u.test(deviceId ?? '')) fail('INVALID_DEVICE_ID');
    const pending = [...(await this.kv.list('registration:')).values()].filter(item => this.#registrationStatus(item) === 'pending');
    if (pending.length >= MAX_PENDING_REGISTRATIONS) fail('TOO_MANY_PENDING_REGISTRATIONS', 429);
    const code = claimCode(), id = newId(), at = this.clock(), ttl = this.registrationTtlMs ?? REGISTRATION_TTL_MS;
    const registration = { id, codeHash: sha256(normalizeCode(code)), connector, credentialHash, deviceId, profileDraft, status: 'pending', attempts: 0, createdAt: at, expiresAt: at + ttl };
    // Kept a little past expiry so the connector can learn why its link stopped working.
    await this.kv.put(`registration:${id}`, registration, { ttlMs: ttl + REGISTRATION_TTL_MS });
    await this.kv.put(`registration-code:${registration.codeHash}`, id, { ttlMs: ttl + REGISTRATION_TTL_MS });
    return { registrationId: id, claimCode: code, claimUrl: `${this.publicOrigin}/claim/${code}`, expiresAt: new Date(registration.expiresAt).toISOString() };
  }

  #registrationStatus(item) {
    return item.status === 'pending' && item.expiresAt <= this.clock() ? 'expired' : item.status;
  }

  async #registrationByCode(code) {
    const id = await this.kv.get(`registration-code:${sha256(normalizeCode(code))}`);
    const found = id ? await this.kv.get(`registration:${id}`) : undefined;
    if (!found) fail('CLAIM_CODE_INVALID', 404);
    const status = this.#registrationStatus(found);
    if (status === 'expired') fail('REGISTRATION_EXPIRED', 410);
    if (status === 'invalidated') fail('REGISTRATION_INVALIDATED', 410);
    if (status === 'claimed') fail('REGISTRATION_ALREADY_CLAIMED', 409);
    return found;
  }

  async #saveRegistration(registration) {
    await this.kv.put(`registration:${registration.id}`, registration, { ttlMs: Math.max(1, registration.expiresAt + REGISTRATION_TTL_MS - this.clock()) });
  }

  /** Step 2, member side: what the claim page shows. The fingerprint tail is withheld. */
  async claimView({ humanId, code }) {
    await this.activeMember(humanId);
    const registration = await this.#registrationByCode(code);
    const [agents, bindings] = await Promise.all([this.list('Agent'), this.list('AgentBinding')]);
    const mine = agents.filter(agent => agent.data.principalId === humanId && agent.lifecycle === 'active');
    const sameDevice = bindings.filter(binding => binding.data.deviceId === registration.deviceId && mine.some(agent => agent.id === binding.data.agentId))
      .map(binding => ({ agentId: binding.data.agentId, agentName: mine.find(agent => agent.id === binding.data.agentId).data.displayName, status: binding.data.status }));
    const { fingerprint, ...connector } = registration.connector;
    return {
      connector, fingerprintPrefix: fingerprint.slice(0, 12), expiresAt: new Date(registration.expiresAt).toISOString(),
      attemptsLeft: MAX_CLAIM_ATTEMPTS - registration.attempts, deviceId: registration.deviceId, sameDevice,
      profileDraft: registration.profileDraft,
      agents: mine.map(agent => ({ id: agent.id, displayName: agent.data.displayName, bindingStatus: agent.data.bindingStatus, profile: agent.data.profile ?? null })),
    };
  }

  /**
   * Step 3, member side: binding happens only when the member types the last
   * four fingerprint characters that exist solely in their own terminal. A
   * link sent by someone else cannot be claimed without that terminal.
   */
  async claimRegistration({ humanId, code, fingerprintSuffix, agentId, agentName, profile, replaceProfile = false }) {
    const { human } = await this.activeMember(humanId);
    const registration = await this.#registrationByCode(code);
    const expected = registration.connector.fingerprint.slice(-4);
    const given = String(fingerprintSuffix ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{4}$/u.test(given) || !sameDigest(given, expected)) {
      registration.attempts += 1;
      if (registration.attempts >= MAX_CLAIM_ATTEMPTS) registration.status = 'invalidated';
      await this.#saveRegistration(registration);
      fail(registration.status === 'invalidated' ? 'REGISTRATION_INVALIDATED' : 'FINGERPRINT_SUFFIX_MISMATCH', 409);
    }
    const actor = CommunityService.actorOf(human);
    // What the owner publishes: the agent's draft as edited on the claim page.
    const draft = registration.profileDraft;
    const edited = profile === undefined ? null : cleanProfile(profile);
    const published = edited ?? draft;
    return this.retrying(async () => {
      const writes = [];
      let agent;
      const agentProfile = { intro: published.intro, seeking: published.seeking, draftedBy: 'agent', editedByPrincipal: Boolean(edited && !sameProfile(edited, draft)) };
      if (agentId) {
        agent = await this.must('Agent', agentId);
        if (agent.data.principalId !== humanId) fail('NOT_AGENT_PRINCIPAL', 403);
        if (agent.data.status !== 'active') fail('AGENT_DISABLED', 403);
        // An agent that already has a profile keeps it unless the owner chose to replace it.
        const replace = replaceProfile || !agent.data.profile;
        const updated = this.next(agent, { bindingStatus: 'verified', ...(replace ? { profile: agentProfile } : {}) }, actor);
        writes.push(updated);
        if (replace) writes.push(...await this.#capabilityWrites(updated, published.capabilities.map(({ id, ...rest }) => rest), actor));
        for (const other of (await this.list('AgentBinding')).filter(item => item.data.agentId === agent.id && item.data.status === 'active')) {
          writes.push(this.next(other, { status: 'revoked', revokedAt: this.now(), revokedReason: 'replaced' }, actor));
        }
      } else {
        agent = this.create('Agent', {
          principalId: humanId, displayName: text(agentName || published.name || registration.connector.name, 200), bindingStatus: 'verified', status: 'active',
          interface: { protocol: 'a2a', version: '1.0', cardUrl: 'https://placeholder.invalid/' }, profile: agentProfile,
        }, actor);
        agent.data.interface.cardUrl = this.cardUrl(agent.id);
        writes.push(agent, ...await this.#capabilityWrites(agent, published.capabilities, actor));
      }
      // The binding reuses the registration id, so the connector's credential stays valid.
      const binding = this.create('AgentBinding', {
        agentId: agent.id, principalId: humanId, status: 'active', connector: registration.connector,
        credentialHash: registration.credentialHash, deviceId: registration.deviceId, claimedAt: this.now(),
      }, actor);
      binding.id = registration.id;
      writes.push(binding);
      await this.commit(`claim:${uuidPart(registration.id)}`, writes);
      registration.status = 'claimed';
      await this.#saveRegistration(registration);
      return { bindingId: binding.id, agentId: agent.id, agentName: agent.data.displayName, status: 'active' };
    });
  }

  /** Connector polling while its registration is unclaimed. */
  async pendingRegistration(token) {
    const parsed = parseCredential('acc', token);
    if (!parsed) return null;
    const registration = await this.kv.get(`registration:${parsed.recordId}`);
    if (!registration || !sameDigest(registration.credentialHash, parsed.secretHash)) return null;
    return { ...registration, status: this.#registrationStatus(registration) };
  }

  /** Replaces the connector secret; the old bearer stops working in the same transaction. */
  async rotateCredential({ binding, agent, credentialHash }) {
    if (!/^[0-9a-f]{64}$/u.test(credentialHash ?? '') || credentialHash === binding.data.credentialHash) fail('INVALID_CREDENTIAL_HASH');
    const updated = this.next(binding, { credentialHash, rotatedAt: this.now() }, CommunityService.agentActor(agent));
    await this.commit(`rotate:${newId()}`, [updated]);
    return { bindingId: binding.id, rotatedAt: updated.data.rotatedAt };
  }

  async #revokeAgentWrites(agent, actor, reason) {
    const at = this.now();
    const writes = [this.next(agent, { bindingStatus: 'revoked' }, actor)];
    for (const binding of (await this.list('AgentBinding')).filter(item => item.data.agentId === agent.id && item.data.status === 'active')) {
      writes.push(this.next(binding, { status: 'revoked', revokedAt: at, revokedReason: reason }, actor));
    }
    writes.push(...await this.#revokeGrantWrites(grant => grant.data.agentId === agent.id, actor));
    return writes;
  }

  async #revokeGrantWrites(match, actor) {
    const writes = [], at = this.now();
    const grants = (await this.list('Grant')).filter(grant => grant.data.status === 'active' && match(grant));
    const executions = await this.list('Execution');
    for (const grant of grants) {
      writes.push(this.next(grant, { status: 'revoked', revokedAt: at }, actor));
      for (const execution of executions.filter(item => item.data.grantId === grant.id && !TERMINAL.has(item.data.status))) {
        const started = ['claimed', 'running', 'unknown', 'cancel-requested'].includes(execution.data.status);
        writes.push(this.next(execution, started
          ? { status: 'cancel-requested', cancelRequestedAt: at, cancelConfirmed: false }
          : { status: 'cancelled', finishedAt: at, cancelConfirmed: true, a2a: execution.data.a2a ? { ...execution.data.a2a, state: 'TASK_STATE_CANCELED' } : undefined }, actor));
      }
    }
    return writes;
  }

  /** Unbinding by the principal (web) or by the connector itself. */
  async revokeAgent({ humanId, agentId, reason = 'unbound-by-principal' }) {
    const human = await this.must('Human', humanId);
    return this.retrying(async () => {
      const agent = await this.must('Agent', agentId);
      if (agent.data.principalId !== humanId) fail('NOT_AGENT_PRINCIPAL', 403);
      const writes = await this.#revokeAgentWrites(agent, CommunityService.actorOf(human), reason);
      await this.commit(`agent-revoke:${newId()}`, writes);
      this.wake(agentId);
      return { agentId, bindingStatus: 'revoked' };
    });
  }

  /** Authenticates a connector bearer against an active binding in FlareMo. */
  async connectorAuth(token) {
    const parsed = parseCredential('acc', token);
    if (!parsed) fail('CONNECTOR_UNAUTHENTICATED', 401);
    const binding = await this.get('AgentBinding', parsed.recordId);
    if (!binding) {
      const pending = await this.pendingRegistration(token);
      if (pending) fail(pending.status === 'pending' ? 'REGISTRATION_NOT_CLAIMED' : `REGISTRATION_${pending.status.toUpperCase()}`, pending.status === 'pending' ? 403 : 410);
      fail('CONNECTOR_UNAUTHENTICATED', 401);
    }
    if (!sameDigest(binding.data.credentialHash, parsed.secretHash)) fail('CONNECTOR_CREDENTIAL_INVALID', 401);
    if (binding.data.status !== 'active') fail(`BINDING_${binding.data.status.toUpperCase()}`, 401);
    const agent = await this.must('Agent', binding.data.agentId);
    if (agent.data.bindingStatus !== 'verified' || agent.data.status !== 'active') fail('AGENT_NOT_VERIFIED', 401);
    await this.activeMember(agent.data.principalId).catch(() => fail('PRINCIPAL_NOT_ACTIVE', 401));
    return { binding, agent };
  }

  // ---------- capabilities and discovery ----------
  /**
   * Makes the agent's published capabilities match `wanted`: items with an id
   * are updated, items without one are created, published ones left out are
   * withdrawn. Returns the writes for one atomic commit.
   */
  async #capabilityWrites(agent, wanted, actor) {
    const current = (await this.list('Capability')).filter(item => item.data.providerKind === 'Agent' && item.data.providerId === agent.id && item.lifecycle === 'active');
    const writes = [];
    for (const item of wanted) {
      if (item.id) {
        const existing = current.find(capability => capability.id === item.id);
        if (!existing) fail('NOT_AGENT_CAPABILITY', 403);
        if (existing.data.title !== item.title || existing.data.description !== item.description || existing.data.status !== 'published') {
          writes.push(this.next(existing, { title: item.title, description: item.description, status: 'published' }, actor));
        }
      } else {
        writes.push(this.create('Capability', {
          providerKind: 'Agent', providerId: agent.id, title: item.title, description: item.description,
          inputMediaTypes: ['text/plain', 'text/markdown'], outputMediaTypes: ['text/markdown'], status: 'published',
        }, actor));
      }
    }
    const keep = new Set(wanted.filter(item => item.id).map(item => item.id));
    for (const capability of current) if (capability.data.status === 'published' && !keep.has(capability.id)) writes.push(this.next(capability, { status: 'withdrawn' }, actor));
    return writes;
  }

  /** The owner edits the agent's name, introduction, capabilities and what it is looking for. */
  async updateAgentProfile({ humanId, agentId, displayName, profile }) {
    const { human } = await this.activeMember(humanId);
    const cleaned = cleanProfile(profile, { requireCapabilities: false });
    const actor = CommunityService.actorOf(human);
    return this.retrying(async () => {
      const agent = await this.must('Agent', agentId);
      if (agent.data.principalId !== humanId) fail('NOT_AGENT_PRINCIPAL', 403);
      const updated = this.next(agent, {
        ...(displayName !== undefined ? { displayName: text(displayName, 200) } : {}),
        profile: { intro: cleaned.intro, seeking: cleaned.seeking, draftedBy: agent.data.profile?.draftedBy ?? 'principal', editedByPrincipal: true },
      }, actor);
      await this.commit(`agent-profile:${newId()}`, [updated, ...await this.#capabilityWrites(updated, cleaned.capabilities, actor)]);
      return { agentId, displayName: updated.data.displayName, profile: updated.data.profile };
    });
  }

  async publishCapability({ humanId, agentId, title, description }) {
    const { human } = await this.activeMember(humanId);
    const agent = await this.must('Agent', agentId);
    if (agent.data.principalId !== humanId) fail('NOT_AGENT_PRINCIPAL', 403);
    if (agent.data.bindingStatus !== 'verified') fail('AGENT_NOT_VERIFIED', 409);
    const capability = this.create('Capability', {
      providerKind: 'Agent', providerId: agentId, title: text(title, 200), description: text(description, 2000),
      inputMediaTypes: ['text/plain', 'text/markdown'], outputMediaTypes: ['text/markdown'], status: 'published',
    }, CommunityService.actorOf(human));
    await this.commit(`capability:${uuidPart(capability.id)}`, [capability]);
    return capability;
  }

  async withdrawCapability({ humanId, capabilityId }) {
    const { human } = await this.activeMember(humanId);
    return this.retrying(async () => {
      const capability = await this.must('Capability', capabilityId);
      const agent = capability.data.providerKind === 'Agent' ? await this.must('Agent', capability.data.providerId) : null;
      if ((agent ? agent.data.principalId : capability.data.providerId) !== humanId) fail('NOT_CAPABILITY_PROVIDER', 403);
      await this.commit(`capability-withdraw:${newId()}`, [this.next(capability, { status: 'withdrawn' }, CommunityService.actorOf(human))]);
      return { capabilityId, status: 'withdrawn' };
    });
  }

  /** Discovery is filtered by current membership and binding; it grants nothing. */
  async discover({ humanId, query = '' }) {
    await this.activeMember(humanId);
    const [capabilities, agents, humans, memberships, bindings] = await Promise.all([this.list('Capability'), this.list('Agent'), this.list('Human'), this.list('Membership'), this.list('AgentBinding')]);
    const activeHumans = new Set(humans.filter(h => h.data.status === 'active' && memberships.some(m => m.data.humanId === h.id && m.data.status === 'active')).map(h => h.id));
    const search = String(query).trim().toLowerCase();
    return capabilities.flatMap(capability => {
      if (capability.lifecycle !== 'active' || capability.data.status !== 'published' || capability.visibility.scope !== 'community') return [];
      const agent = capability.data.providerKind === 'Agent' ? agents.find(item => item.id === capability.data.providerId) : null;
      const principalId = agent ? agent.data.principalId : capability.data.providerId;
      if (agent && (agent.data.bindingStatus !== 'verified' || agent.data.status !== 'active')) return [];
      if (!activeHumans.has(principalId)) return [];
      if (search && !`${capability.data.title} ${capability.data.description}`.toLowerCase().includes(search)) return [];
      const lastSeen = agent ? this.presence.get(agent.id)?.at ?? 0 : 0;
      return [{
        capabilityId: capability.id, title: capability.data.title, description: capability.data.description,
        provider: agent ? {
          kind: 'Agent', id: agent.id, displayName: agent.data.displayName, profile: agent.data.profile ?? null,
          memory: bindings.find(item => item.data.agentId === agent.id && item.data.status === 'active')?.data.connector.instructionIsolation === 'personal-codex-home' ? 'with-memory' : 'without-memory',
        } : { kind: 'Human', id: principalId },
        principal: { id: principalId, displayName: humans.find(h => h.id === principalId)?.data.displayName },
        online: Boolean(agent) && this.clock() - lastSeen < 30000,
        model: agent ? this.presence.get(agent.id)?.model : undefined,
      }];
    });
  }

  // ---------- requests and per-order confirmation ----------
  async createRequest({ humanId, title, description, capabilityIds, acceptanceCriteria, materialPaths = [] }) {
    const { human } = await this.activeMember(humanId);
    if (!Array.isArray(capabilityIds) || capabilityIds.length !== 1) fail('ONE_CAPABILITY_REQUIRED');
    const capability = await this.must('Capability', capabilityIds[0]);
    if (capability.data.status !== 'published') fail('CAPABILITY_NOT_PUBLISHED', 409);
    const criteria = (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map(item => text(item, 500));
    if (!criteria.length) fail('ACCEPTANCE_CRITERIA_REQUIRED');
    const materials = [];
    for (const path of materialPaths) {
      const item = this.materials.get(path) ?? fail('UNKNOWN_MATERIAL', 404);
      await this.store.putBlob(this.communityId, item.bytes, item.mediaType);
      materials.push({ title: item.title, path, sha256: item.sha256, mediaType: item.mediaType, bytes: item.bytes.length });
    }
    const request = this.create('Request', {
      requesterHumanId: humanId, title: text(title, 200), description: text(description, 3000),
      capabilityIds: [capability.id], acceptanceCriteria: [...new Set(criteria)], status: 'open',
      ...(materials.length ? { materials } : {}),
    }, CommunityService.actorOf(human));
    await this.commit(`request:${uuidPart(request.id)}`, [request]);
    return request;
  }

  /** What the agent owner sees before approving one execution. */
  async confirmationCard({ humanId, requestId }) {
    await this.activeMember(humanId);
    const request = await this.must('Request', requestId);
    const capability = await this.must('Capability', request.data.capabilityIds[0]);
    const agent = capability.data.providerKind === 'Agent' ? await this.must('Agent', capability.data.providerId) : fail('HUMAN_CAPABILITY_NOT_EXECUTABLE');
    if (agent.data.principalId !== humanId) fail('NOT_AGENT_PRINCIPAL', 403);
    const binding = (await this.list('AgentBinding')).find(item => item.data.agentId === agent.id && item.data.status === 'active');
    if (!binding) fail('AGENT_NOT_CONNECTED', 409);
    const requester = await this.must('Human', request.data.requesterHumanId);
    const revision = await this.#revisionContext(request);
    const card = {
      requestId, requestRevision: request.revision, title: request.data.title, description: request.data.description,
      acceptanceCriteria: request.data.acceptanceCriteria, requester: requester.data.displayName,
      materials: request.data.materials ?? [], agent: { id: agent.id, displayName: agent.data.displayName },
      runtime: binding.data.connector.runtime, runtimeVersion: binding.data.connector.runtimeVersion,
      model: binding.data.connector.model, models: binding.data.connector.models ?? [binding.data.connector.model],
      instructionIsolation: binding.data.connector.instructionIsolation, revision,
      connector: binding.data.connector.name, timeLimitSeconds: DEFAULT_TIME_LIMIT,
      costBearer: 'grantor-model-account', usageNote: '本次执行使用你本机 Codex CLI 登录的模型账号，用量由你的账号承担。',
      uploads: '只回传报告、来源列表和执行状态；不上传本地文件、完整会话或私人记忆。',
    };
    return { ...card, cardHash: sha256(JSON.stringify(card)) };
  }

  /**
   * Follow-up round context: the requester's latest "changes requested"
   * statement on the most recent artifact. Shared with the agent only after the
   * owner approves the next round, and pinned by hash in the Grant.
   */
  async #revisionContext(request) {
    if (request.data.status !== 'assigned') return null;
    const attestations = (await this.list('Attestation')).filter(item => item.data.requestId === request.id && item.data.status === 'issued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = attestations.at(-1);
    if (latest?.data.outcome !== 'changes-requested') return null;
    const rounds = (await this.list('Execution')).filter(item => item.data.requestId === request.id && item.data.artifactId).length;
    return { round: rounds + 1, artifactId: latest.data.artifactId, artifactRevision: latest.data.artifactRevision, artifactSha256: latest.data.artifactSha256, attestationId: latest.id, feedback: latest.data.statement };
  }

  async confirmOrder({ humanId, requestId, cardHash, timeLimitSeconds = DEFAULT_TIME_LIMIT, model }) {
    const card = await this.confirmationCard({ humanId, requestId });
    if (!Number.isSafeInteger(timeLimitSeconds) || timeLimitSeconds < 30 || timeLimitSeconds > 3600) fail('INVALID_TIME_LIMIT');
    const chosenModel = model ?? card.model;
    if (!card.models.includes(chosenModel)) fail('MODEL_NOT_OFFERED_BY_CONNECTOR', 400);
    if (card.cardHash !== cardHash) fail('CONFIRMATION_CARD_CHANGED', 409);
    const request = await this.must('Request', requestId);
    if (request.revision !== card.requestRevision) fail('CONFIRMATION_CARD_CHANGED', 409);
    if (!['open', 'assigned'].includes(request.data.status)) fail('REQUEST_NOT_OPEN', 409);
    const executions = (await this.list('Execution')).filter(item => item.data.requestId === requestId);
    if (executions.some(item => !TERMINAL.has(item.data.status))) fail('EXECUTION_ALREADY_ACTIVE', 409);
    await this.activeMember(request.data.requesterHumanId);
    const { human } = await this.activeMember(humanId);
    const actor = CommunityService.actorOf(human);
    const agentId = card.agent.id;
    const writes = [];
    let workroom = (await this.list('Workroom')).find(item => item.data.requestId === requestId && item.data.status !== 'closed');
    if (!workroom) {
      workroom = this.create('Workroom', { requestId, participantHumanIds: [...new Set([request.data.requesterHumanId, humanId])], participantAgentIds: [agentId], status: 'active' }, actor);
      workroom.visibility = { scope: 'workroom', workroomId: workroom.id };
      writes.push(workroom);
    }
    const expiresAt = new Date(this.clock() + (timeLimitSeconds + 1800) * 1000).toISOString();
    const grant = this.create('Grant', {
      requestId, workroomId: workroom.id, agentId, capabilityId: request.data.capabilityIds[0], grantorHumanId: humanId,
      requesterHumanId: request.data.requesterHumanId, actions: ['execute-research-report'], materials: card.materials,
      runtime: card.runtime, model: chosenModel, instructionIsolation: card.instructionIsolation, timeLimitSeconds,
      costBearer: 'grantor-model-account', expiresAt, status: 'active', ...(card.revision ? { revision: card.revision } : {}),
    }, actor);
    const executionId = newId();
    const credential = issueCredential('aex', executionId);
    const execution = this.create('Execution', {
      requestId, workroomId: workroom.id, grantId: grant.id, agentId, status: 'authorized', idempotencyKey: `dispatch:${uuidPart(executionId)}`,
      callerCredentialHash: credential.hash, callerCredentialExpiresAt: expiresAt, claimCount: 0, progress: [],
    }, actor);
    execution.id = executionId;
    writes.push(grant, execution, this.next(request, { status: 'assigned' }, actor));
    await this.commit(`confirm:${uuidPart(executionId)}`, writes);
    return { workroomId: workroom.id, grantId: grant.id, executionId, callerCredential: credential.token, agentId };
  }

  async revokeGrant({ humanId, grantId }) {
    const { human } = await this.activeMember(humanId);
    return this.retrying(async () => {
      const grant = await this.must('Grant', grantId);
      if (![grant.data.grantorHumanId, grant.data.requesterHumanId].includes(humanId)) fail('NOT_GRANT_PARTY', 403);
      if (grant.data.status !== 'active') fail('GRANT_NOT_ACTIVE', 409);
      const writes = await this.#revokeGrantWrites(item => item.id === grantId, CommunityService.actorOf(human));
      await this.commit(`grant-revoke:${newId()}`, writes);
      this.wake(grant.data.agentId);
      return { grantId, status: 'revoked' };
    });
  }

  // ---------- A2A caller authority ----------
  /** Validates an execution bearer for one agent endpoint; returns fresh records. */
  async callerAuth(token, agentUuid) {
    const parsed = parseCredential('aex', token);
    if (!parsed) fail('CALLER_UNAUTHENTICATED', 401);
    const execution = await this.get('Execution', parsed.recordId);
    if (!execution || !sameDigest(execution.data.callerCredentialHash, parsed.secretHash)) fail('CALLER_UNAUTHENTICATED', 401);
    if (Date.parse(execution.data.callerCredentialExpiresAt) <= this.clock()) fail('CALLER_CREDENTIAL_EXPIRED', 401);
    if (uuidPart(execution.data.agentId) !== agentUuid) fail('WRONG_AUDIENCE', 403);
    const grant = await this.must('Grant', execution.data.grantId);
    return { execution, grant };
  }

  /** Checks the community extension metadata against the authenticated grant. */
  static checkDispatchMetadata(metadata, { execution, grant, communityId }) {
    const expected = {
      communityId, requestId: grant.data.requestId, workroomId: grant.data.workroomId, executionId: execution.id,
      grantId: grant.id, recipientAgentId: grant.data.agentId, capabilityId: grant.data.capabilityId, idempotencyKey: execution.data.idempotencyKey,
    };
    if (!metadata || metadata.profileVersion !== '0.1.0') fail('EXTENSION_METADATA_REQUIRED', 400);
    for (const [key, value] of Object.entries(expected)) if (metadata[key] !== value) fail(`METADATA_MISMATCH:${key}`, 403);
    const actor = metadata.actor;
    if (actor?.kind !== 'Human' || actor.id !== grant.data.requesterHumanId || actor.principalId !== grant.data.requesterHumanId) fail('FORGED_PRINCIPAL', 403);
  }

  // ---------- execution state (single writer path: the gateway) ----------
  /** Read-modify-write of one Execution; `change` may return null for "no change". */
  async updateExecution(executionId, change, actor = 'agent', extraWrites = () => []) {
    return this.retrying(async () => {
      const execution = await this.must('Execution', executionId);
      const patch = typeof change === 'function' ? change(execution) : change;
      if (!patch) return execution;
      const agent = await this.must('Agent', execution.data.agentId);
      const updated = this.next(execution, patch, actor === 'agent' ? CommunityService.agentActor(agent) : actor);
      await this.commit(`execution:${newId()}`, [updated, ...await extraWrites(updated)]);
      return updated;
    });
  }

  /** Connector long-poll: next queued execution for this agent, or one to reconcile. */
  async claimNext({ agent }) {
    const [executions, grants] = await Promise.all([this.list('Execution'), this.list('Grant')]);
    const mine = executions.filter(item => item.data.agentId === agent.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const reconcile = mine.find(item => ['claimed', 'running', 'cancel-requested'].includes(item.data.status));
    if (reconcile) return this.taskPackage(reconcile, { resume: true });
    for (const candidate of mine.filter(item => item.data.status === 'queued')) {
      const grant = grants.find(item => item.id === candidate.data.grantId);
      if (grant?.data.status !== 'active' || Date.parse(grant.data.expiresAt) <= this.clock()) continue;
      const claimed = await this.updateExecution(candidate.id, current => current.data.status === 'queued'
        ? { status: 'claimed', claimCount: current.data.claimCount + 1, claimedAt: this.now(), progress: this.progressEntry(current, '成员连接器已领取任务') }
        : null);
      if (claimed.data.status === 'claimed') return this.taskPackage(claimed, { resume: false });
    }
    return null;
  }

  async taskPackage(execution, { resume }) {
    const grant = await this.must('Grant', execution.data.grantId);
    const request = await this.must('Request', execution.data.requestId);
    const materials = [];
    for (const item of grant.data.materials) {
      const { bytes } = await this.store.getBlob(this.communityId, item.sha256);
      materials.push({ ...item, content: bytes.toString('utf8') });
    }
    let revision = null;
    if (grant.data.revision) {
      // Only the hash-pinned previous report and the requester's feedback are shared.
      const { bytes } = await this.store.getBlob(this.communityId, grant.data.revision.artifactSha256);
      revision = { round: grant.data.revision.round, feedback: grant.data.revision.feedback, previousReport: bytes.toString('utf8'), previousSha256: grant.data.revision.artifactSha256 };
    }
    return {
      resume, executionId: execution.id, status: execution.data.status, taskId: execution.data.a2a?.taskId ?? null,
      request: { title: request.data.title, description: request.data.description, acceptanceCriteria: request.data.acceptanceCriteria },
      grant: { id: grant.id, model: grant.data.model, timeLimitSeconds: grant.data.timeLimitSeconds, instructionIsolation: grant.data.instructionIsolation, actions: grant.data.actions, expiresAt: grant.data.expiresAt },
      materials, revision,
    };
  }

  /** Status reports from the connector. Revoked grants only accept terminal reports. */
  async connectorEvent({ agent, executionId, type, message = '', code, persistProgress = true }) {
    if (!['started', 'progress', 'failed', 'cancelled', 'unknown'].includes(type)) fail('INVALID_EVENT');
    let grantAtDecision;
    const updated = await this.updateExecution(executionId, current => {
      if (current.data.agentId !== agent.id) fail('WRONG_AGENT', 403);
      if (TERMINAL.has(current.data.status)) fail('EXECUTION_TERMINAL', 409);
      const at = this.now(), note = String(message || type).slice(0, 500);
      switch (type) {
        case 'started':
          if (current.data.status === 'cancel-requested') fail('CANCEL_REQUESTED', 409);
          if (current.data.status === 'running') return { progress: this.progressEntry(current, note || 'Codex CLI 已启动') };
          if (current.data.status !== 'claimed') fail('EXECUTION_NOT_CLAIMED', 409);
          return { status: 'running', startedAt: at, progress: this.progressEntry(current, note || 'Codex CLI 已启动'), a2a: { ...current.data.a2a, state: 'TASK_STATE_WORKING' } };
        case 'progress':
          if (!['claimed', 'running'].includes(current.data.status)) fail('EXECUTION_NOT_RUNNING', 409);
          return persistProgress ? { progress: this.progressEntry(current, note) } : null;
        case 'failed':
          return { status: 'failed', finishedAt: at, failureCode: String(code || 'RUNTIME_FAILED').slice(0, 200), progress: this.progressEntry(current, note), a2a: { ...current.data.a2a, state: 'TASK_STATE_FAILED' } };
        case 'cancelled':
          return { status: 'cancelled', finishedAt: at, cancelConfirmed: true, progress: this.progressEntry(current, note || '成员连接器确认已停止'), a2a: { ...current.data.a2a, state: 'TASK_STATE_CANCELED' } };
        case 'unknown':
          return { status: 'unknown', failureCode: String(code || 'RESULT_UNKNOWN').slice(0, 200), progress: this.progressEntry(current, note || '状态待确认') };
      }
      return null;
    }, 'agent', async execution => {
      const grant = await this.must('Grant', execution.data.grantId);
      grantAtDecision = grant;
      if (grant.data.status !== 'active' && ['started', 'progress'].includes(type)) fail('GRANT_NOT_ACTIVE', 403);
      return TERMINAL.has(execution.data.status) && grant.data.status === 'active' ? [this.next(grant, { status: 'consumed' }, CommunityService.agentActor(agent))] : [];
    });
    return { execution: updated, grantStatus: grantAtDecision?.data.status };
  }

  /** Executions the connector must stop now (cancel requested or grant no longer active). */
  async stopList({ agent }) {
    const [executions, grants] = await Promise.all([this.list('Execution'), this.list('Grant')]);
    return executions.filter(item => item.data.agentId === agent.id && !TERMINAL.has(item.data.status) &&
      (item.data.status === 'cancel-requested' || grants.find(grant => grant.id === item.data.grantId)?.data.status !== 'active')).map(item => item.id);
  }

  progressEntry(execution, message) {
    return [...execution.data.progress, { at: this.now(), message: String(message).slice(0, 500) || '…' }].slice(-20);
  }

  /** Stores the report, then atomically records Artifact + Execution + Request state. */
  async submitArtifact({ executionId, agent, report, usage }) {
    const bytes = Buffer.from(report, 'utf8');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) fail('INVALID_REPORT');
    const blob = await this.store.putBlob(this.communityId, bytes, 'text/markdown; charset=utf-8');
    return this.retrying(async () => {
      const execution = await this.must('Execution', executionId);
      if (execution.data.agentId !== agent.id) fail('WRONG_AGENT', 403);
      const grant = await this.must('Grant', execution.data.grantId);
      if (grant.data.status !== 'active') fail('GRANT_NOT_ACTIVE', 403);
      if (!['claimed', 'running'].includes(execution.data.status)) fail('EXECUTION_NOT_RUNNING', 409);
      const request = await this.must('Request', execution.data.requestId);
      const actor = CommunityService.agentActor(agent);
      const artifact = this.create('Artifact', {
        workroomId: execution.data.workroomId, producerKind: 'Agent', producerId: agent.id, principalId: agent.data.principalId,
        title: `调研报告${grant.data.revision ? `（第 ${grant.data.revision.round} 轮）` : ''} · ${request.data.title}`.slice(0, 200), mediaType: 'text/markdown',
        blob: { uri: this.store.blobUri(this.communityId, blob.sha256), sha256: blob.sha256 }, status: 'submitted',
      }, actor, { scope: 'workroom', workroomId: execution.data.workroomId });
      const at = this.now();
      const writes = [artifact,
        this.next(execution, { status: 'succeeded', finishedAt: at, artifactId: artifact.id, usage, progress: this.progressEntry(execution, '报告已提交，等待需求方验收'), a2a: execution.data.a2a ? { ...execution.data.a2a, state: 'TASK_STATE_COMPLETED' } : undefined }, actor),
        this.next(grant, { status: 'consumed' }, actor),
        this.next(request, { status: 'review' }, actor)];
      await this.commit(`artifact:${uuidPart(artifact.id)}`, writes);
      return { artifact, sha256: blob.sha256 };
    });
  }

  // ---------- review ----------
  async review({ humanId, artifactId, outcome, statement }) {
    const { human } = await this.activeMember(humanId);
    if (!['accepted', 'changes-requested', 'rejected'].includes(outcome)) fail('INVALID_OUTCOME');
    return this.retrying(async () => {
      const artifact = await this.must('Artifact', artifactId);
      const workroom = await this.must('Workroom', artifact.data.workroomId);
      const request = await this.must('Request', workroom.data.requestId);
      if (request.data.requesterHumanId !== humanId) fail('REQUESTER_ONLY', 403);
      if (artifact.data.status !== 'submitted' || request.data.status !== 'review') fail('NOT_UNDER_REVIEW', 409);
      const { bytes } = await this.store.getBlob(this.communityId, artifact.data.blob.sha256);
      if (sha256(bytes) !== artifact.data.blob.sha256) fail('ARTIFACT_HASH_MISMATCH', 409);
      const actor = CommunityService.actorOf(human);
      const attestation = this.create('Attestation', {
        issuerHumanId: humanId, subjectKind: artifact.data.producerKind, subjectId: artifact.data.producerId, requestId: request.id,
        artifactId, artifactRevision: artifact.revision, artifactSha256: artifact.data.blob.sha256, outcome,
        statement: text(statement, 2000), status: 'issued',
      }, actor, { scope: 'workroom', workroomId: workroom.id });
      const writes = [attestation];
      if (outcome === 'accepted') {
        writes.push(this.next(request, { status: 'accepted' }, actor), this.next(artifact, { status: 'finalized' }, actor), this.next(workroom, { status: 'closed' }, actor));
      } else {
        writes.push(this.next(request, { status: 'assigned' }, actor), this.next(artifact, { status: 'withdrawn' }, actor));
      }
      await this.commit(`review:${uuidPart(attestation.id)}`, writes);
      return attestation;
    });
  }

  // ---------- visibility-filtered reads ----------
  async canRead(humanId, entity) {
    const { membership } = await this.activeMember(humanId);
    if (entity.visibility?.scope === 'community') return true;
    if (entity.visibility?.scope === 'workroom') {
      const room = await this.get('Workroom', entity.visibility.workroomId);
      return Boolean(room?.data.participantHumanIds.includes(humanId));
    }
    return membership.data.role === 'owner' && entity.kind === 'Community';
  }

  /** Request detail for one member: only what their visibility allows. */
  async requestView({ humanId, requestId }) {
    const request = await this.must('Request', requestId);
    if (!await this.canRead(humanId, request)) fail('NOT_VISIBLE', 404);
    const workrooms = (await this.list('Workroom')).filter(item => item.data.requestId === requestId);
    const visibleRooms = [];
    for (const room of workrooms) if (await this.canRead(humanId, room)) visibleRooms.push(room);
    const roomIds = new Set(visibleRooms.map(room => room.id));
    const [executions, grants, artifacts, attestations, humans, agents] = await Promise.all([
      this.list('Execution'), this.list('Grant'), this.list('Artifact'), this.list('Attestation'), this.list('Human'), this.list('Agent')]);
    const name = id => humans.find(h => h.id === id)?.data.displayName ?? agents.find(a => a.id === id)?.data.displayName ?? id;
    return {
      request, requester: name(request.data.requesterHumanId), workrooms: visibleRooms,
      grants: grants.filter(item => roomIds.has(item.data.workroomId)),
      executions: executions.filter(item => roomIds.has(item.data.workroomId)).map(item => ({ ...item, presence: this.presence.get(item.data.agentId) ?? null })),
      artifacts: artifacts.filter(item => roomIds.has(item.data.workroomId)),
      attestations: attestations.filter(item => roomIds.has(item.visibility.workroomId)),
      names: Object.fromEntries([...humans, ...agents].map(item => [item.id, item.data.displayName])),
    };
  }

  async readArtifact({ humanId, artifactId }) {
    const artifact = await this.must('Artifact', artifactId);
    if (!await this.canRead(humanId, artifact)) fail('NOT_VISIBLE', 404);
    const { bytes } = await this.store.getBlob(this.communityId, artifact.data.blob.sha256);
    return { artifact, content: bytes.toString('utf8') };
  }

  /** Full trace: all eight kinds, graph invariants re-checked against history. */
  /**
   * The change feed, filtered to what this member may see: objects by their
   * visibility, records by whom they concern (RFC 0008 fix). The cursor still
   * advances past hidden events so paging never stalls.
   */
  async visibleChanges({ humanId, cursor = 0, limit = 200 }) {
    const { membership } = await this.activeMember(humanId);
    const page = await this.store.events(this.communityId, Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0, limit);
    const events = [];
    for (const event of page.events) {
      const entity = await this.store.find(this.communityId, event.category, event.entityId).catch(() => null);
      if (entity && await this.canSee(humanId, membership, entity)) events.push(event);
    }
    return { events, cursor: page.cursor };
  }

  async canSee(humanId, membership, entity) {
    if (entity.protocol !== 'community-records') return this.canRead(humanId, entity);
    const d = entity.data;
    const inRoom = async workroomId => Boolean((await this.get('Workroom', workroomId))?.data.participantHumanIds.includes(humanId));
    switch (entity.kind) {
      case 'Membership': return d.humanId === humanId || membership.data.role === 'owner';
      case 'IdentityLink': return d.humanId === humanId;
      case 'AgentBinding': return d.principalId === humanId;
      case 'Invitation': return d.issuerHumanId === humanId;
      case 'Grant': case 'Execution': return inRoom(d.workroomId);
      default: return false;
    }
  }

  async trace({ humanId }) {
    await this.activeMember(humanId);
    const objects = await this.store.list(this.communityId, 'object');
    const versions = new Map();
    for (const item of objects.filter(o => o.kind === 'Attestation')) {
      const version = await this.store.version(this.communityId, 'object', item.data.artifactId, item.data.artifactRevision);
      versions.set(`${version.id}@${version.revision}`, version);
    }
    let graph = 'valid';
    try { validateGraph(objects, (id, revision) => versions.get(`${id}@${revision}`)); } catch (error) { graph = `invalid: ${error.message}`; }
    const events = await this.store.events(this.communityId, 0, 500);
    const visible = [];
    for (const item of objects) if (await this.canRead(humanId, item)) visible.push({ kind: item.kind, id: item.id, revision: item.revision, status: item.data.status ?? item.data.bindingStatus, updatedAt: item.updatedAt, actor: item.actor });
    // Counts cover only what this member can see, like the object list.
    return { communityId: this.communityId, graph, counts: Object.fromEntries(['Community', 'Human', 'Agent', 'Capability', 'Request', 'Workroom', 'Artifact', 'Attestation'].map(kind => [kind, visible.filter(o => o.kind === kind).length])), objects: visible, lastCursor: events.cursor, store: this.store.kind };
  }

  // ---------- connector presence and wake-ups (derived, in memory) ----------
  heartbeat(agentId, info = {}) { this.presence.set(agentId, { at: this.clock(), ...info }); }
  wake(agentId) { for (const resolve of this.waiters.get(agentId) ?? []) resolve(); this.waiters.delete(agentId); }
  waitFor(agentId, ms) {
    return new Promise(resolve => {
      const timer = setTimeout(done, ms);
      function done() { clearTimeout(timer); resolve(); }
      this.waiters.set(agentId, [...this.waiters.get(agentId) ?? [], done]);
    });
  }
}
