import { readFile } from 'node:fs/promises';
import { discoverCapabilities } from '../../packages/core/discovery.js';
import { MockGateway } from '../../packages/gateway/mock.js';

const file = process.argv[2] ?? new URL('../../examples/communities/generic.json', import.meta.url);
try {
  const catalog = JSON.parse(await readFile(file, 'utf8'));
  const community = catalog.communities[0];
  if (!community) throw new Error('Fixture must contain a community');
  const matches = discoverCapabilities(catalog, {
    communityId: community.id,
    query: process.argv[3] ?? '',
  });
  console.log(JSON.stringify({
    mode: 'offline-synthetic-demo',
    community: community.name,
    gateway: new MockGateway().describe(),
    matches,
    next: 'Execution is not implemented. Review the RFCs to shape the first real experiment.',
  }, null, 2));
} catch (error) {
  console.error(`Demo could not run: ${error.message}`);
  process.exitCode = 1;
}
