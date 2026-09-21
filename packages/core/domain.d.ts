/** Proposed vocabulary, not a validated wire format or database schema. */
export type Id = string;
export type Actor = { kind: 'human' | 'agent'; id: Id };
export interface Community { id: Id; name: string; federation: 'private' }
export interface Human { id: Id; name: string }
export interface Membership { communityId: Id; humanId: Id; status: 'active' | 'revoked' }
export interface Agent { id: Id; principalId: Id; name: string; status: 'active' | 'revoked' }
export interface Capability { id: Id; communityId: Id; provider: Actor; name: string; description: string }
export interface Request { id: Id; communityId: Id; requester: Actor; acceptanceCriteria: string }
export interface Workroom { id: Id; communityId: Id; requestId: Id; participants: Actor[] }
export interface Artifact { id: Id; communityId: Id; workroomId: Id; producer: Actor; revision: string }
export interface Attestation { id: Id; communityId: Id; artifactId: Id; reviewer: Actor; statement: string }
export interface Catalog {
  communities: Community[];
  humans: Human[];
  memberships: Membership[];
  agents: Agent[];
  capabilities: Capability[];
}
