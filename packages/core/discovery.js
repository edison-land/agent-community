/**
 * Offline projection over trusted synthetic fixtures. Not an auth boundary.
 * @param {import('./domain').Catalog} catalog
 * @param {{communityId: string, query?: string}} scope
 */
export function discoverCapabilities(catalog, { communityId, query = '' }) {
  if (!catalog.communities.some(community => community.id === communityId)) {
    throw new Error('UNKNOWN_COMMUNITY');
  }
  const activeHumans = new Set(catalog.memberships
    .filter(member => member.communityId === communityId && member.status === 'active')
    .map(member => member.humanId)
    .filter(id => catalog.humans.some(human => human.id === id)));
  const search = query.trim().toLowerCase();
  return catalog.capabilities.flatMap(capability => {
    if (capability.communityId !== communityId) return [];
    const { kind, id } = capability.provider;
    let principalId;
    if (kind === 'human' && activeHumans.has(id)) principalId = id;
    if (kind === 'agent') {
      const agent = catalog.agents.find(candidate => candidate.id === id);
      if (agent?.status === 'active' && activeHumans.has(agent.principalId)) {
        principalId = agent.principalId;
      }
    }
    if (!principalId) return [];
    if (!`${capability.name} ${capability.description}`.toLowerCase().includes(search)) return [];
    return [{
      id: capability.id,
      communityId,
      name: capability.name,
      description: capability.description,
      provider: { kind, id },
      principalId,
    }];
  });
}
