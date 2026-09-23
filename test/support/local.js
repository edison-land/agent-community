import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Reads the local FlareMo test-instance state written by scripts/local/flaremo.mjs. */
export function localState() {
  const file = join(process.env.AGENT_COMMUNITY_HOME ?? join(homedir(), '.agent-community'), 'local', 'flaremo.json');
  if (!existsSync(file)) throw new Error(`Live tests need a bootstrapped local FlareMo (${file} missing).`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export async function flaremo(state, path, { method = 'GET', body, cookie, token } = {}) {
  const response = await fetch(`${state.url}${path}`, {
    method, redirect: 'error',
    headers: { origin: state.url, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  return { status: response.status, json, cookies: response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ') };
}

export async function signIn(state, username, password) {
  const result = await flaremo(state, '/api/auth/sign-in/username', { method: 'POST', body: { username, password } });
  if (result.status !== 200) throw new Error(`sign-in ${result.status}`);
  return result.cookies;
}
