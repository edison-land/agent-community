// SIMULATED (RFC 0010, revised): capability matching by meaning. The vocabulary
// grows from what members say they can do; a request only matches what is
// already there. Embedding happens on write, so ranking stays a tag lookup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startNode } from '../apps/node/server.js';
import { MemoryObjectStore } from '../packages/store/memory-objects.js';
import { createMockLogin } from '../packages/identity/mock.js';
import { Vocabulary } from '../packages/router/vocabulary.js';
import { LocalEmbedding, MemoryVectorIndex, CachedEmbedding } from '../packages/router/embedding.js';
import { fixtureEmbedding } from './support/embedding.js';
import { webUser, inviteAndJoin } from './support/harness.js';

const ROSTER = ['owner', 'ed', 'al', 'bo'].map(username => ({ username, displayName: username.toUpperCase() }));
const GROUPS = [['猎头', '招聘', 'hiring'], ['剪辑', '视频后期'], ['设计', 'Figma']];

async function community(t) {
  const embedding = fixtureEmbedding(GROUPS);
  const node = await startNode({
    port: 0, mode: 'simulated', store: new MemoryObjectStore(), login: createMockLogin({ members: ROSTER }),
    router: { vocabulary: new Vocabulary({ embedding }) },
  });
  t.after(node.close);
  const users = Object.fromEntries(ROSTER.map(({ username }) => [username, webUser(node)]));
  await users.owner.post('/login', { username: 'owner' });
  await users.owner.post('/community', { communityName: 'C', displayName: 'OWNER' });
  for (const { username, displayName } of ROSTER.slice(1)) { await users[username].post('/login', { username }); await inviteAndJoin(users.owner, users[username], displayName); }
  const ids = {};
  for (const [name, user] of Object.entries(users)) ids[name] = (await user.get('/state')).me.member.human.id;
  const says = (name, title) => users[name].post('/router/profile', { profile: { items: [{ kind: 'skill', title }], hoursPerWeek: 6, openTo: ['paid'], notDoing: [] } });
  return { node, users, ids, says, embedding };
}

test('two members describing one capability differently land on the same term, and a request finds them both', async t => {
  const { users, ids, says } = await community(t);
  await says('ed', '香港猎头');
  await says('al', '香港招聘市场');
  await says('bo', '视频剪辑');

  // Both tag systems live on an item: the grown vocabulary term and the keyword baseline.
  const termOf = async name => (await users[name].get('/router/state')).profile.items[0].tags.find(tag => tag.startsWith('t-'));
  const edTerm = await termOf('ed');
  assert.match(edTerm, /^t-[0-9a-f]{8}$/u, 'the term is grown, not a preset category');
  assert.equal(await termOf('al'), edTerm, '不同说法并入同一个能力条目');
  assert.notEqual(await termOf('bo'), edTerm, '不同能力不会被并到一起');
  assert.ok((await users.ed.get('/router/state')).profile.items[0].tags.includes('recruitment'), '关键词基线的标签仍然保留，作为对照');

  // The request never mints a term: it matches what members already claim.
  const request = await users.owner.post('/router/requests', { text: '有没有人懂招聘\n- 两周内' });
  assert.deepEqual(request.data.needs.map(need => need.tag), [edTerm]);
  assert.equal(request.data.needs[0].title, '香港猎头', '需求显示的是社区自己的说法');

  const view = await users.owner.get(`/router/requests/${request.id}`);
  const found = view.candidates.map(candidate => candidate.humanId);
  assert.ok(found.includes(ids.ed) && found.includes(ids.al), '两个人都被找到了');
  assert.ok(!found.includes(ids.bo), '做剪辑的人不会被找来做招聘');
  assert.ok(view.candidates[0].reasons.some(reason => reason.includes('香港猎头')), '理由引用的是档案原话，不是分数');
});

test('a request the community has no capability for falls back to the keyword baseline instead of silently matching nobody', async t => {
  const { users } = await community(t);
  const request = await users.owner.post('/router/requests', { text: '需要招聘经验和数据能力' });
  assert.ok(request.data.needs.length, '词汇表是空的，退回关键词基线');
  assert.ok(request.data.needs.every(need => !need.tag.startsWith('t-')));
});

test('the vocabulary survives a restart: terms are stored, the vector index is rebuilt from them', async t => {
  const { embedding } = await community(t);
  const terms = [{ tag: 't-deadbeef', title: '香港猎头', aliases: ['招聘'], createdAt: new Date().toISOString() }];
  const rebuilt = await new Vocabulary({ embedding }).load(terms);
  assert.equal(rebuilt.size, 1);
  const [hit] = await rebuilt.match('有没有人懂招聘');
  assert.equal(hit.term.tag, 't-deadbeef', '索引是从存下来的词条重建的');
});

test('the offline stub is lexical, not semantic: it is for plumbing, never for judging quality', async () => {
  const embedding = new CachedEmbedding(new LocalEmbedding());
  const [hunter, hiring, editing] = await embedding.embed(['香港猎头', '香港招聘', '视频剪辑']);
  const { cosine } = await import('../packages/router/embedding.js');
  assert.ok(cosine(hunter, hiring) > cosine(hunter, editing), 'shared characters still beat unrelated text');
  assert.ok(cosine(hunter, hiring) < 0.5, '猎头 and 招聘 share no character, so a lexical stub cannot connect them');
  assert.equal(embedding.calls, 1, 'one batch, not three round trips');
  await embedding.embed(['香港猎头']);
  assert.equal(embedding.calls, 1, 'cached');
  assert.ok(new MemoryVectorIndex());
});
