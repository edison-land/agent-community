/**
 * Community-activity sources for profile drafting (RFC 0010 §6). A source
 * returns topic-level signals for one member: which topics they took part in,
 * how often, and a short excerpt. Raw chat never enters the network.
 *
 * The fixture source serves synthetic signals keyed by username (the part
 * after `users/` in the member's identity). A production source would call the
 * community brain, and only for members who signed the agreement.
 */
export class FixtureActivitySource {
  constructor({ service, signals }) { this.service = service; this.signals = signals ?? {}; }

  async signalsFor(human) {
    const link = (await this.service.list('IdentityLink')).find(item => item.data.humanId === human.id && item.data.status === 'active');
    const username = link?.data.subject?.replace(/^users\//u, '');
    return (this.signals[username] ?? []).map(signal => ({ topicId: String(signal.topicId), title: String(signal.title), messages: Number(signal.messages) || 0, tags: signal.tags ?? [], excerpt: signal.excerpt ? String(signal.excerpt).slice(0, 120) : '' }));
  }
}
