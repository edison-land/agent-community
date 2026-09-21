import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runMockDemo } from './scenario.js';

export async function startUi(port = 4318) {
  const html = await readFile(new URL('./index.html', import.meta.url));
  let busy = false;
  const server = createServer(async (request, response) => {
    const host = `127.0.0.1:${server.address().port}`;
    const reply = (status, body, type = 'application/json') => {
      response.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (request.headers.host !== host) return reply(403, { error: 'INVALID_HOST' });
    if (request.method === 'GET' && request.url === '/') return reply(200, html, 'text/html');
    if (request.method === 'POST' && request.url === '/api/run') {
      if (request.headers.origin !== `http://${host}`) return reply(403, { error: 'INVALID_ORIGIN' });
      if (busy) return reply(409, { error: 'RUN_IN_PROGRESS' });
      busy = true;
      try { return reply(200, await runMockDemo()); }
      catch { return reply(500, { error: 'LOCAL_DEMO_FAILED' }); }
      finally { busy = false; }
    }
    return reply(404, { error: 'NOT_FOUND' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const ui = await startUi();
    console.log(`FlareMo local HTTP mock demo: ${ui.url}`);
    console.log('Synthetic data only. No real FlareMo, A2A, MCP or LLM calls.');
    process.on('SIGINT', async () => { await ui.close(); process.exit(0); });
    process.on('SIGTERM', async () => { await ui.close(); process.exit(0); });
  } catch { console.error('Unable to start local demo; check whether port 4318 is in use.'); process.exitCode = 1; }
}
