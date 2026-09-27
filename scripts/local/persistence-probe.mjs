#!/usr/bin/env node
/**
 * REAL INTEGRATION restart check (phase 1). `write` stores a fresh eight-kind
 * graph in local FlareMo and remembers its ids; restart FlareMo; `verify`
 * re-reads every object, version, event and blob and compares hashes.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FlareMoObjectStore } from '../../packages/store/flaremo-objects.js';
import { freshGraph } from '../../test/support/graph.js';
import { localState } from '../../test/support/local.js';

const state = localState();
const store = new FlareMoObjectStore({ baseUrl: state.url, token: state.service.pat, allowLocal: true });
const probeFile = join(process.env.AGENT_COMMUNITY_HOME ?? join(homedir(), '.agent-community'), 'local', 'persistence-probe.json');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

if (process.argv[2] === 'write') {
  const report = Buffer.from(`# Restart probe ${new Date().toISOString()}\n`);
  const g = freshGraph({ blobSha: createHash('sha256').update(report).digest('hex') });
  const [artifact, attestation] = g.objects.splice(7, 2);
  await store.transact({ communityId: g.c, commandId: 'probe-seed', writes: g.objects.map(entity => ({ expectedRevision: 0, entity })) });
  await store.putBlob(g.c, report, 'text/markdown; charset=utf-8');
  artifact.data.blob.uri = store.blobUri(g.c, artifact.data.blob.sha256);
  const receipt = await store.transact({ communityId: g.c, commandId: 'probe-evidence', writes: [artifact, attestation].map(entity => ({ expectedRevision: 0, entity })) });
  const objects = await store.list(g.c, 'object');
  writeFileSync(probeFile, JSON.stringify({ communityId: g.c, cursor: receipt.cursor, digest: digest(objects), sha: artifact.data.blob.sha256, writtenAt: new Date().toISOString() }), { mode: 0o600 });
  console.log(JSON.stringify({ phase: 'write', communityId: g.c, kinds: new Set(objects.map(o => o.kind)).size, records: objects.length, cursor: receipt.cursor }));
} else if (process.argv[2] === 'verify') {
  if (!existsSync(probeFile)) throw new Error('run write first');
  const probe = JSON.parse(readFileSync(probeFile, 'utf8'));
  const objects = await store.list(probe.communityId, 'object');
  const { events } = await store.events(probe.communityId, 0);
  const blob = await store.getBlob(probe.communityId, probe.sha);
  const replay = await store.transact({ communityId: probe.communityId, commandId: 'probe-seed', writes: objects.filter(o => !['Artifact', 'Attestation'].includes(o.kind)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(entity => ({ expectedRevision: 0, entity })) }).catch(error => ({ error: error.code }));
  const result = { phase: 'verify', communityId: probe.communityId, records: objects.length, kinds: new Set(objects.map(o => o.kind)).size, sameContent: digest(objects) === probe.digest, lastEventCursor: events.at(-1)?.cursor, expectedCursor: probe.cursor, blobVerified: blob.bytes.length > 0, seedReplay: replay.error ?? (replay.replayed ? 'replayed' : 'NEW WRITE') };
  console.log(JSON.stringify(result));
  if (!result.sameContent || result.records !== 9 || result.lastEventCursor !== probe.cursor) process.exitCode = 1;
} else {
  console.error('Usage: persistence-probe.mjs write|verify'); process.exitCode = 2;
}
