import { randomUUID } from 'node:crypto';
import { FlareMoClient, FlareMoError } from '../../packages/knowledge/flaremo.js';
import { startMock } from './mock-server.js';

export async function expectDenied(operation, statuses = [403, 404]) {
  try { await operation(); }
  catch (error) {
    if (error instanceof FlareMoError && statuses.includes(error.status)) return;
    throw error;
  }
  throw new Error('EXPECTED_ACCESS_DENIAL');
}

export async function runScenario({ writer, reader, allowTrash = false, revokeReader, mode }) {
  const report = { mode, runId: `community-demo-${randomUUID()}`, status: 'running', steps: [], memoName: null };
  const original = `# ${report.runId}\nSynthetic research brief. Version 1. No real participant data.`;
  const updated = `${original}\nVersion 2: revised synthetic scope.`;
  let currentStep = '';
  async function step(label, action) {
    currentStep = label;
    await action();
    report.steps.push({ label, status: 'passed' });
  }
  try {
    await step('成员 A 保存私密资料', async () => {
      const memo = await writer.create(original);
      report.memoName = memo.name;
      if (memo.visibility !== 'PRIVATE') throw new Error('PRIVATE_CREATE_FAILED');
    });
    await step('成员 B 的模拟 Agent 无权读取', () => expectDenied(() => reader.get(report.memoName)));
    await step('成员 A 发布到整个测试团队', () => writer.update(report.memoName, { visibility: 'PROTECTED' }));
    await step('成员 B 的模拟 Agent 读到共享资料', async () => {
      if ((await reader.get(report.memoName)).content !== original) throw new Error('CONTENT_MISMATCH');
    });
    await step('成员 A 更新资料，B 重新读取到新版', async () => {
      await writer.update(report.memoName, { content: updated });
      if ((await reader.get(report.memoName)).content !== updated) throw new Error('STALE_CONTENT');
    });
    await step('成员 A 撤回共享，B 再次被拒绝', async () => {
      await writer.update(report.memoName, { visibility: 'PRIVATE' });
      await expectDenied(() => reader.get(report.memoName));
    });
    if (revokeReader) {
      await step('模拟撤销 B 的凭证，即使共享也不能读取', async () => {
        await writer.update(report.memoName, { visibility: 'PROTECTED' });
        revokeReader();
        await expectDenied(() => reader.get(report.memoName), [401]);
        await writer.update(report.memoName, { visibility: 'PRIVATE' });
      });
    }
    if (allowTrash) {
      await step('仅将本次测试资料移入回收站', async () => {
        await writer.trash(report.memoName);
        try {
          if ((await writer.get(report.memoName)).state !== 'TRASHED') throw new Error('TRASH_NOT_CONFIRMED');
        } catch (error) {
          if (!(error instanceof FlareMoError && error.status === 404)) throw error;
        }
      });
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    const safeCodes = ['EXPECTED_ACCESS_DENIAL', 'PRIVATE_CREATE_FAILED', 'CONTENT_MISMATCH', 'STALE_CONTENT', 'TRASH_NOT_CONFIRMED'];
    report.steps.push({ label: currentStep, status: 'failed', error: error instanceof FlareMoError || safeCodes.includes(error.message) ? error.message : 'UNEXPECTED_ERROR' });
    if (report.memoName) {
      try {
        await writer.update(report.memoName, { visibility: 'PRIVATE' });
        report.recovery = 'Test memo restored to PRIVATE; inspect it manually.';
      } catch { report.recovery = 'Unable to confirm PRIVATE; writer/admin must inspect the test memo.'; }
    } else report.recovery = 'Creation outcome may be unknown; inspect the run marker before retrying.';
  }
  return report;
}

export async function runMockDemo() {
  const mock = await startMock();
  try {
    return await runScenario({
      writer: new FlareMoClient({ baseUrl: mock.baseUrl, token: mock.writerToken, allowLocal: true, allowWrite: true }),
      reader: new FlareMoClient({ baseUrl: mock.baseUrl, token: mock.readerToken, allowLocal: true }),
      allowTrash: true, revokeReader: mock.revokeReader, mode: 'local-http-mock',
    });
  } finally { await mock.close(); }
}
