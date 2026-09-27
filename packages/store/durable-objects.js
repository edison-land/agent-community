import { MemoryObjectStore } from './memory-objects.js';
import { StoreError } from './flaremo-objects.js';

/**
 * The community's own store, kept in a Durable Object.
 *
 * What a community is doing — requests, matches, squads, deliveries,
 * acceptance — lives here rather than in FlareMo, because FlareMo has no
 * public interface that holds it. The shape these records need (compare and
 * swap, atomic batches, receipts, an event cursor) once existed as a patch to
 * FlareMo's schema; that patch is not something we are willing to carry, so
 * the records come home instead. FlareMo keeps what is genuinely its own: who
 * a member is, and that member's own agent memory.
 *
 * The rules are `MemoryObjectStore`'s, unchanged and well covered. This adds
 * the two things a store needs before real members depend on it: every
 * committed delta is written to the object's storage and read back when the
 * object next starts, and growth is bounded, so a community that outgrows its
 * node is told so instead of failing in some less legible way later.
 */

// Durable Object storage takes a batch at a time; this is well inside its limit.
const PUT_BATCH = 128;

export const DEFAULT_LIMITS = {
  // A pilot community, with room to be wrong about its size by an order of
  // magnitude. Each is checked before a write, and refuses rather than trims.
  entities: 50_000,
  blobBytes: 64 * 1024 * 1024,
  blobSize: 2 * 1024 * 1024,
};

/**
 * @param storage a Durable Object's `ctx.storage`
 * @param origin the node's public origin, so a stored blob URI names the node
 *   that actually holds it
 */
export async function createDurableStore(storage, { serviceId, origin, kind = 'community-durable', limits = {} } = {}) {
  if (!serviceId) throw new StoreError('MISSING_SERVICE_ID', 500);
  const bounds = { ...DEFAULT_LIMITS, ...limits };
  const store = new MemoryObjectStore({ serviceId });
  store.kind = kind;
  if (origin) store.origin = origin;

  const state = { entities: [], versions: [], commands: [], events: [], blobs: [], partitions: [] };
  const bucket = { entity: state.entities, version: state.versions, command: state.commands, event: state.events, blob: state.blobs, partition: state.partitions };
  for (const [key, value] of await storage.list({ prefix: 'os:' })) bucket[key.split(':')[1]]?.push(value);
  store.load(state);

  // Counted from what was restored, then kept up to date by the deltas below,
  // so a restart does not forget how full the node already is.
  const sizeOf = blob => blob?.bytes?.byteLength ?? blob?.bytes?.length ?? 0;
  let entities = state.entities.length;
  let blobBytes = state.blobs.reduce((total, blob) => total + sizeOf(blob), 0);

  store.onChange(async delta => {
    const puts = {};
    for (const entity of delta.entities ?? []) {
      puts[`os:entity:${entity.id}`] = entity;
      puts[`os:version:${entity.id}@${entity.revision}`] = entity;
    }
    for (const event of delta.events ?? []) {
      puts[`os:event:${String(event.cursor).padStart(10, '0')}`] = event;
      if (event.changeType === 'created') entities += 1;
    }
    if (delta.command) puts[`os:command:${delta.command.receipt.commandId}:${delta.command.receipt.cursor}`] = delta.command;
    if (delta.partition) puts[`os:partition:${delta.partition.communityId}`] = delta.partition;
    if (delta.blob) {
      puts[`os:blob:${delta.blob.key}`] = delta.blob;
      blobBytes += sizeOf(delta.blob);
    }
    const entries = Object.entries(puts);
    for (let index = 0; index < entries.length; index += PUT_BATCH) await storage.put(Object.fromEntries(entries.slice(index, index + PUT_BATCH)));
  });

  // The quota is checked ahead of the write, so a refusal leaves nothing
  // half-committed. New entities are the ones at revision 0; an update to
  // something that already exists is always allowed, so a full community can
  // still be wound down.
  const transact = store.transact.bind(store);
  store.transact = async request => {
    const fresh = (request.writes ?? []).filter(write => (write.expectedRevision ?? 0) === 0).length;
    if (entities + fresh > bounds.entities) throw new StoreError('COMMUNITY_FULL', 507);
    return transact(request);
  };

  const putBlob = store.putBlob.bind(store);
  store.putBlob = async (communityId, bytes, mediaType) => {
    if (bytes.length > bounds.blobSize) throw new StoreError('BLOB_TOO_LARGE', 413);
    if (blobBytes + bytes.length > bounds.blobBytes) throw new StoreError('COMMUNITY_STORAGE_FULL', 507);
    return putBlob(communityId, bytes, mediaType);
  };

  store.usage = () => ({ entities, entityLimit: bounds.entities, blobBytes, blobByteLimit: bounds.blobBytes });
  return store;
}
