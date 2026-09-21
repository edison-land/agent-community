import { readFile } from 'node:fs/promises';
import { MemoryObjectContract } from '../../packages/protocol/objects.js';

const { objects } = JSON.parse(await readFile(new URL('../../examples/protocol/eight-objects.json', import.meta.url)));
const store = new MemoryObjectContract();
const command = { communityId: objects[0].communityId, commandId: 'synthetic-bootstrap', writes: objects.map(object => ({ expectedRevision: 0, object })) };
const receipt = store.transact(command);
store.transact(command);
console.log(JSON.stringify({ mode: 'synthetic-in-memory-contract', persistent: false, flaremoConnected: false, a2aConnected: false,
  kinds: [...new Set(store.list().map(object => object.kind))], records: store.list().length,
  atomicBootstrap: receipt.objects.length, eventsAfterReplay: store.eventsAfter().length,
  next: 'Review RFC 0005 storage extension and RFC 0006 A2A profile. No live objects or agents created.' }, null, 2));
