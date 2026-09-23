import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, chmodSync, lstatSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';

export class UnsafeStateDirError extends Error {
  constructor(reason) { super(reason); this.code = reason; }
}

/** Nearest existing ancestor, resolved through symlinks. */
function existingReal(path) {
  let current = resolve(path);
  while (!existsSync(current)) current = dirname(current);
  return realpathSync(current);
}

/**
 * Connector secrets must not land in a git work tree, behind a symlink, or in
 * a cloud-synced folder (iCloud Drive, Desktop & Documents sync, Dropbox,
 * OneDrive, Google Drive). Returns the reason, or null when the path is safe.
 */
export function unsafeStateDir(dir, home = homedir()) {
  const target = resolve(dir), inHome = resolve(home) + sep;
  for (let current = target, depth = 0; ; current = dirname(current), depth += 1) {
    // Symlinks are checked for the state dir, its parent, and anything the user owns
    // inside $HOME; system aliases such as macOS /var -> /private/var are not the user's.
    const checked = depth <= 1 || current.startsWith(inHome);
    if (checked && existsSync(current) && lstatSync(current).isSymbolicLink()) return 'STATE_DIR_SYMLINK';
    if (existsSync(join(current, '.git'))) return 'STATE_DIR_IN_GIT_REPO';
    if (dirname(current) === current) break;
  }
  const real = existingReal(target);
  const synced = [
    join(home, 'Library', 'Mobile Documents'), join(home, 'Library', 'CloudStorage'),
    join(home, 'Dropbox'), join(home, 'OneDrive'), join(home, 'Google Drive'),
  ];
  // macOS "Desktop & Documents" sync moves these folders into iCloud Drive.
  const cloudDocs = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  for (const folder of ['Documents', 'Desktop']) if (existsSync(join(cloudDocs, folder))) synced.push(join(home, folder));
  const realSynced = synced.filter(existsSync).map(path => realpathSync(path));
  if (realSynced.some(folder => real === folder || real.startsWith(folder + sep))) return 'STATE_DIR_CLOUD_SYNCED';
  return null;
}

/**
 * Connector-local state: binding credential, device id and per-execution
 * receipts. The receipt is written BEFORE Codex starts, so a restarted
 * connector can tell "never started" from "may have run" and never blindly
 * re-runs work.
 */
export class ConnectorState {
  constructor(profile = 'default', root = process.env.AGENT_COMMUNITY_HOME ?? join(homedir(), '.agent-community')) {
    if (!/^[a-z0-9-]{1,40}$/u.test(profile)) throw new Error('INVALID_PROFILE');
    this.root = root;
    this.dir = join(root, 'connector', profile);
    this.file = join(this.dir, 'state.json');
  }
  assertSafe() {
    const reason = unsafeStateDir(this.dir);
    if (reason) throw new UnsafeStateDirError(reason);
  }
  #write(file, value) {
    this.assertSafe();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
    chmodSync(file, 0o600);
  }
  /** Stable, random per-machine id (not a secret, not proof of anything). */
  deviceId() {
    const file = join(this.root, 'device-id');
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    this.assertSafe();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const id = `urn:uuid:${randomUUID()}`;
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
    return id;
  }
  load() { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : null; }
  save(value) { this.#write(this.file, value); }
  executionDir(executionId) {
    const dir = join(this.dir, 'executions', executionId.replace(/^urn:uuid:/u, ''));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  receipt(executionId) {
    const file = join(this.executionDir(executionId), 'receipt.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }
  writeReceipt(executionId, value) { this.#write(join(this.executionDir(executionId), 'receipt.json'), { executionId, ...value, updatedAt: new Date().toISOString() }); }
  receipts() {
    const root = join(this.dir, 'executions');
    if (!existsSync(root)) return [];
    return readdirSync(root).map(id => this.receipt(`urn:uuid:${id}`)).filter(Boolean);
  }
}
