import { randomBytes, createHash } from 'node:crypto';
import { hostname, platform, release } from 'node:os';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { preflight, runCodex, readResult, renderReport, generateProfile, normalizeProfile, MEMORY_MODES } from './codex.js';

export class ConnectorError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Member-side connector: dials out to the community node; no inbound port. */
export class Connector {
  // Heartbeats every `heartbeatMs` while a task runs (prompt cancellation), every
  // `idleHeartbeatMs` otherwise; the node shows a connector online for 30 s after a beat.
  constructor({ state, codexBin = 'codex', log = () => {}, heartbeatMs = 3000, idleHeartbeatMs = heartbeatMs * 5, pollWait = 25 }) {
    this.state = state; this.codexBin = codexBin; this.log = log; this.heartbeatMs = heartbeatMs; this.idleHeartbeatMs = idleHeartbeatMs; this.pollWait = pollWait;
    this.running = new Map();
  }

  async #call(method, path, body, { auth = true, node } = {}) {
    const config = this.state.load();
    const base = node ?? config?.node;
    if (!base) throw new ConnectorError('NOT_PAIRED');
    let response;
    try {
      response = await fetch(`${base}/connector/v1${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout((this.pollWait + 15) * 1000),
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: `Bearer ${config.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new ConnectorError('NODE_UNREACHABLE'); }
    if (response.status === 204) return null;
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new ConnectorError(json.error ?? `HTTP_${response.status}`, response.status);
    return json;
  }

  /**
   * Registers this connector with a community node. The secret is generated
   * here and never leaves this machine; only its hash does. The node answers
   * with a claim link that the owning member opens while signed in.
   */
  async register({ node, name, codexHome, model, models = [], memory = 'without-memory', profile, onProgress = () => {} }) {
    const url = new URL(node);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') throw new ConnectorError('INSECURE_NODE_URL');
    if (!model) throw new ConnectorError('MODEL_REQUIRED');
    if (!MEMORY_MODES[memory]) throw new ConnectorError('INVALID_MEMORY_MODE');
    this.state.assertSafe();
    const check = preflight({ codexBin: this.codexBin, codexHome, memory });
    if (!check.ok) throw new ConnectorError(check.reason);
    // The agent describes itself; the owner reviews and edits it on the claim page.
    let draft;
    if (profile) { try { draft = normalizeProfile(profile); } catch { throw new ConnectorError('INVALID_PROFILE'); } }
    else {
      onProgress('正在请 Agent 撰写自我介绍（你是谁、能做什么、在找什么）…');
      const generated = await generateProfile({ codexBin: this.codexBin, codexHome, isolation: check.isolation, model, memory });
      if (!generated.ok) throw Object.assign(new ConnectorError(`PROFILE_${generated.reason}`), { detail: generated.message });
      draft = generated.profile;
    }
    const secret = randomBytes(32).toString('base64url');
    const credentialHash = sha256(secret);
    const fingerprint = sha256(credentialHash).slice(0, 16);
    const allowed = [...new Set([model, ...models])];
    const deviceId = this.state.deviceId();
    const connector = { name: name ?? `${hostname()}`.slice(0, 200), platform: `${platform()} ${release()}`.slice(0, 200), runtime: 'codex-cli', runtimeVersion: check.runtimeVersion, model, models: allowed, instructionIsolation: check.isolation, fingerprint };
    const registered = await this.#call('POST', '/registrations', { connector, credentialHash, deviceId, profile: draft }, { auth: false, node: url.origin });
    this.state.save({ node: url.origin, registrationId: registered.registrationId, bindingId: registered.registrationId, deviceId, token: `acc_${registered.registrationId.slice(9)}_${secret}`, codexHome, memory, model, models: allowed, isolation: check.isolation, runtimeVersion: check.runtimeVersion, fingerprint, claimUrl: registered.claimUrl, registeredAt: new Date().toISOString() });
    return { ...registered, fingerprint, isolation: check.isolation, runtimeVersion: check.runtimeVersion, deviceId, profile: draft };
  }

  async binding() { return this.#call('GET', '/binding'); }

  /** Waits until the member claims the registration (or it expires). */
  async waitForClaim({ timeoutMs = 11 * 60 * 1000, intervalMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let status;
      try { status = await this.binding(); } catch (error) { if (error.status === 410) return { status: error.code === 'REGISTRATION_INVALIDATED' ? 'invalidated' : 'expired' }; throw error; }
      if (status.status !== 'awaiting-claim') return status;
      if (Date.now() > deadline) throw new ConnectorError('CLAIM_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  /**
   * Replaces the connector secret. The new secret is saved locally as
   * "pending" first, so a crash between the server update and the local
   * update never locks the connector out.
   */
  async rotate() {
    const config = this.state.load();
    if (!config?.token) throw new ConnectorError('NOT_REGISTERED');
    const secret = randomBytes(32).toString('base64url');
    const next = `acc_${config.bindingId.slice(9)}_${secret}`;
    this.state.save({ ...config, pendingToken: next });
    const result = await this.#call('POST', '/credential/rotate', { credentialHash: sha256(secret) });
    this.state.save({ ...this.state.load(), token: next, pendingToken: undefined, rotatedAt: result.rotatedAt });
    return result;
  }

  /** If a rotation was interrupted, adopt whichever token the node accepts. */
  async recoverRotation() {
    const config = this.state.load();
    if (!config?.pendingToken) return false;
    try { await this.binding(); this.state.save({ ...config, pendingToken: undefined }); return false; }
    catch (error) {
      if (error.code !== 'CONNECTOR_CREDENTIAL_INVALID') throw error;
      this.state.save({ ...config, token: config.pendingToken, pendingToken: undefined });
      return true;
    }
  }

  async unbind() {
    const result = await this.#call('POST', '/unbind', {});
    const config = this.state.load();
    this.state.save({ ...config, token: null, unboundAt: new Date().toISOString() });
    return result;
  }

  async #report(executionId, type, message, code) {
    return this.#call('POST', `/executions/${executionId.slice(9)}/events`, { type, message, code });
  }

  async #deliver(task, outcome) {
    const id = task.executionId;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        if (outcome.outcome === 'succeeded') await this.#call('POST', `/executions/${id.slice(9)}/artifact`, { report: outcome.report, usage: outcome.usage ?? undefined });
        else await this.#report(id, outcome.outcome, outcome.message, outcome.code);
        this.state.writeReceipt(id, { ...this.state.receipt(id), state: 'reported', outcome: outcome.outcome, code: outcome.code });
        this.log({ event: 'reported', executionId: id, outcome: outcome.outcome, code: outcome.code });
        return true;
      } catch (error) {
        if (error.status === 401) { this.log({ event: 'report-denied', executionId: id, code: error.code }); return false; }
        if (error.status && error.status !== 0 && error.code !== 'NODE_UNREACHABLE') { this.log({ event: 'report-rejected', executionId: id, code: error.code }); this.state.writeReceipt(id, { ...this.state.receipt(id), state: 'rejected', code: error.code }); return false; }
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    this.log({ event: 'report-pending', executionId: id });
    return false;
  }

  async execute(task) {
    const id = task.executionId, config = this.state.load();
    const dir = this.state.executionDir(id);
    // The owner chose the model per order; the connector only runs models it declared.
    const model = task.grant.model;
    if (!(config.models ?? [config.model]).includes(model)) {
      this.state.writeReceipt(id, { state: 'starting' });
      return this.#deliver(task, { outcome: 'failed', code: 'MODEL_NOT_ALLOWED', message: `连接器未允许模型 ${model}，未启动 Codex CLI` });
    }
    this.state.writeReceipt(id, { state: 'starting', claimedTaskId: task.taskId, model });
    try { await this.#report(id, 'started', `Codex CLI ${config.runtimeVersion} 启动（模型 ${model}，时限 ${task.grant.timeLimitSeconds}s${task.revision ? `，第 ${task.revision.round} 轮修改` : ''}）`); }
    catch (error) {
      this.log({ event: 'start-refused', executionId: id, code: error.code });
      if (error.code === 'CANCEL_REQUESTED') await this.#deliver(task, { outcome: 'cancelled', code: 'CANCELLED_BEFORE_START', message: '开始前收到停止请求，未启动 Codex CLI' });
      else this.state.writeReceipt(id, { state: 'not-started', code: error.code });
      return;
    }
    this.state.writeReceipt(id, { state: 'spawning' });
    let lastProgress = 0, handle;
    try {
      handle = runCodex({ codexBin: this.codexBin, codexHome: config.codexHome, isolation: config.isolation, model, task, dir, onProgress: text => {
        if (Date.now() - lastProgress < 1500) return;
        lastProgress = Date.now();
        this.#report(id, 'progress', text).catch(() => {});
      } });
    } catch (error) {
      // With memory: the tool lockdown could not be verified, so Codex never starts.
      this.state.writeReceipt(id, { state: 'finished', outcome: 'failed', code: error.code ?? 'SPAWN_FAILED' });
      return this.#deliver(task, { outcome: 'failed', code: error.code ?? 'SPAWN_FAILED', message: '无法确认已关闭 MCP 工具与插件，未启动 Codex CLI' });
    }
    this.state.writeReceipt(id, { state: 'started', pid: handle.pid, startedAt: new Date().toISOString() });
    this.running.set(id, handle);
    this.log({ event: 'codex-started', executionId: id, pid: handle.pid });
    const outcome = await handle.done;
    this.running.delete(id);
    if (outcome.report) writeFileSync(join(dir, 'report.md'), outcome.report);
    this.state.writeReceipt(id, { state: 'finished', pid: handle.pid, outcome: outcome.outcome, code: outcome.code, message: outcome.message, usage: outcome.usage });
    this.log({ event: 'codex-finished', executionId: id, outcome: outcome.outcome, code: outcome.code });
    await this.#deliver(task, outcome);
  }

  /** After a restart or reconnect: never re-run work that may already have happened. */
  async reconcile(task) {
    const id = task.executionId, receipt = this.state.receipt(id), dir = this.state.executionDir(id);
    this.log({ event: 'reconcile', executionId: id, nodeStatus: task.status, receipt: receipt?.state ?? 'none' });
    if (this.running.has(id)) return;
    if (!receipt || receipt.state === 'starting' || receipt.state === 'not-started') {
      if (task.status === 'cancel-requested') return this.#deliver(task, { outcome: 'cancelled', code: 'CANCELLED_BEFORE_START', message: '未启动 Codex CLI，确认停止' });
      if (task.status === 'claimed' || receipt?.state === 'starting') return this.execute(task);
      return this.#deliver(task, { outcome: 'unknown', code: 'RECEIPT_MISSING', message: '连接器没有本地执行回执，无法确认是否执行过，状态待确认' });
    }
    if (receipt.state === 'finished') {
      const report = existsSync(join(dir, 'report.md')) ? readFileSync(join(dir, 'report.md'), 'utf8') : undefined;
      return this.#deliver(task, { outcome: receipt.outcome, code: receipt.code, message: receipt.message, report, usage: receipt.usage });
    }
    if (receipt.state === 'spawning' || receipt.state === 'started') {
      const result = readResult(join(dir, 'result.json'));
      const alive = receipt.pid && pidAlive(receipt.pid);
      if (alive) { try { process.kill(-receipt.pid, 'SIGTERM'); } catch { /* gone */ } }
      if (result && !alive && task.status !== 'cancel-requested') {
        const report = renderReport(task, result);
        writeFileSync(join(dir, 'report.md'), report);
        this.state.writeReceipt(id, { ...receipt, state: 'finished', outcome: 'succeeded', recovered: true });
        return this.#deliver(task, { outcome: 'succeeded', report });
      }
      if (task.status === 'cancel-requested') return this.#deliver(task, { outcome: 'cancelled', code: 'STOPPED_AFTER_RESTART', message: alive ? '连接器重启后终止了遗留的 Codex 进程' : 'Codex 进程已不在运行，确认停止' });
      return this.#deliver(task, { outcome: 'unknown', code: 'CONNECTOR_RESTARTED', message: alive ? '连接器重启，已终止无法继续跟踪的 Codex 进程；结果待确认，不会自动重跑' : '连接器重启时执行被中断，结果待确认，不会自动重跑' });
    }
    if (receipt.state === 'reported' || receipt.state === 'rejected') return this.#deliver(task, { outcome: 'unknown', code: 'REPORT_UNCONFIRMED', message: '本地已回报但平台仍未更新，状态待确认' });
  }

  /** Main loop: sequential task handling plus an independent heartbeat. */
  async run({ signal } = {}) {
    if (await this.recoverRotation()) this.log({ event: 'rotation-recovered' });
    let stopped = null;
    const stopAll = reason => { for (const handle of this.running.values()) handle.stop(reason); };
    const beat = async () => {
      try {
        const result = await this.#call('POST', '/heartbeat', { running: [...this.running.keys()] });
        for (const id of result.stop ?? []) if (this.running.has(id)) { this.log({ event: 'stop-requested', executionId: id }); this.running.get(id).stop('CANCELLED'); }
        this.connected !== true && this.log({ event: 'connected' });
        this.connected = true;
      } catch (error) {
        if (error.status === 401) { stopped = error.code; stopAll('BINDING_REVOKED'); this.log({ event: 'binding-revoked', code: error.code }); }
        else if (this.connected !== false) { this.connected = false; this.log({ event: 'disconnected', code: error.code }); }
      }
    };
    await beat();
    let lastBeat = Date.now();
    const timer = setInterval(() => {
      if (!this.running.size && Date.now() - lastBeat < this.idleHeartbeatMs - this.heartbeatMs / 2) return;
      lastBeat = Date.now(); beat();
    }, this.heartbeatMs);
    try {
      while (!stopped && !signal?.aborted) {
        let task;
        try { task = (await this.#call('GET', `/tasks/next?wait=${this.pollWait}`))?.task; }
        catch (error) {
          if (error.status === 401) { stopped = error.code; break; }
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        if (!task) continue;
        if (task.resume) await this.reconcile(task); else await this.execute(task);
      }
    } finally { clearInterval(timer); stopAll('CONNECTOR_STOPPED'); }
    return { stopped: stopped ?? 'signal' };
  }
}
