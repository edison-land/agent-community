import { MemoryObjectStore } from '../../../packages/store/memory-objects.js';

/**
 * Public-demo object store (no FlareMo): the in-memory store's rules, with
 * every committed delta written to the Durable Object's own storage under
 * `os:` keys, and reloaded when the object starts. Keeps the demo community
 * across evictions and deploys; `reset` wipes it.
 */
const PUT_BATCH = 128;

export async function durableDemoStore(storage) {
  const store = new MemoryObjectStore({ serviceId: 'public-demo' });
  store.kind = 'demo-durable';
  store.origin = 'https://demo.invalid';
  const state = { entities: [], versions: [], commands: [], events: [], blobs: [], partitions: [] };
  for (const [key, value] of await storage.list({ prefix: 'os:' })) {
    const kind = key.split(':')[1];
    if (kind === 'entity') state.entities.push(value);
    else if (kind === 'version') state.versions.push(value);
    else if (kind === 'command') state.commands.push(value);
    else if (kind === 'event') state.events.push(value);
    else if (kind === 'blob') state.blobs.push(value);
    else if (kind === 'partition') state.partitions.push(value);
  }
  store.load(state);
  store.onChange(async delta => {
    const puts = {};
    for (const entity of delta.entities ?? []) {
      puts[`os:entity:${entity.id}`] = entity;
      puts[`os:version:${entity.id}@${entity.revision}`] = entity;
    }
    for (const event of delta.events ?? []) puts[`os:event:${String(event.cursor).padStart(10, '0')}`] = event;
    if (delta.command) puts[`os:command:${delta.command.receipt.commandId}:${delta.command.receipt.cursor}`] = delta.command;
    if (delta.partition) puts[`os:partition:${delta.partition.communityId}`] = delta.partition;
    if (delta.blob) puts[`os:blob:${delta.blob.key}`] = delta.blob;
    const entries = Object.entries(puts);
    for (let index = 0; index < entries.length; index += PUT_BATCH) await storage.put(Object.fromEntries(entries.slice(index, index + PUT_BATCH)));
  });
  return store;
}
