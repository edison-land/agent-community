import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// Independently written test double, not a FlareMo deployment or full emulator.
export async function startMock() {
  const tokens = new Map([['synthetic-writer', 'member-a'], ['synthetic-reader', 'member-b']]);
  const memos = new Map();
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(value === undefined ? '' : JSON.stringify(value));
    };
    const actor = tokens.get(request.headers.authorization?.replace(/^Bearer /u, ''));
    if (!actor) return send(401, { error: 'unauthenticated' });
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      const body = text ? JSON.parse(text) : {};
      if (request.method === 'POST' && url.pathname === '/api/v1/memos') {
        if (typeof body.content !== 'string' || !body.content.trim()) return send(400);
        const name = `memos/${randomUUID()}`;
        const memo = { name, content: body.content, visibility: body.visibility, state: 'NORMAL', creator: actor, updateTime: new Date().toISOString() };
        memos.set(name, memo);
        return send(200, memo);
      }
      const name = url.pathname.replace(/^\/api\/v1\//u, '');
      const memo = memos.get(name);
      if (!memo) return send(404);
      const owner = actor === memo.creator;
      if (!owner && (memo.visibility === 'PRIVATE' || memo.state === 'TRASHED')) return send(404);
      if (request.method === 'GET') return send(200, memo);
      if (!owner) return send(403);
      if (request.method === 'PATCH') {
        for (const key of (url.searchParams.get('updateMask') ?? '').split(',')) {
          if (!['content', 'visibility'].includes(key)) return send(400);
          memo[key] = body[key];
        }
        memo.updateTime = new Date().toISOString();
        return send(200, memo);
      }
      if (request.method === 'DELETE') { memo.state = 'TRASHED'; return send(200); }
      return send(405);
    } catch { return send(400); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    writerToken: 'synthetic-writer', readerToken: 'synthetic-reader',
    revokeReader: () => tokens.delete('synthetic-reader'),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}
