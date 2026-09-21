import { FlareMoClient, FlareMoError } from '../../packages/knowledge/flaremo.js';
import { runScenario } from './scenario.js';

const args = process.argv.slice(2);
const write = args.includes('--allow-write');
const trash = args.includes('--allow-trash');
try {
  if (args.some(arg => !['--allow-write', '--allow-trash'].includes(arg)) || (trash && !write)) throw new Error('INVALID_FLAGS');
  const baseUrl = process.env.FLAREMO_URL;
  const token = process.env.FLAREMO_WRITER_PAT;
  if (!baseUrl || !token) throw new Error('CONFIGURE_FLAREMO_URL_AND_WRITER_PAT_LOCALLY');
  const access = { id: process.env.CF_ACCESS_CLIENT_ID, secret: process.env.CF_ACCESS_CLIENT_SECRET };
  const writer = new FlareMoClient({ baseUrl, token, access, allowWrite: write });
  if (!write) {
    if (!process.env.FLAREMO_TEST_MEMO) throw new Error('SET_A_SYNTHETIC_TEST_MEMO_FOR_READ_ONLY_PROBE');
    const memo = await writer.get(process.env.FLAREMO_TEST_MEMO);
    console.log(JSON.stringify({ mode: 'live-read-only', status: 'passed', name: memo.name, visibility: memo.visibility, state: memo.state, contentLength: memo.content.length, note: 'Read access only; cross-member isolation not tested.' }, null, 2));
  } else {
    const readerToken = process.env.FLAREMO_READER_PAT;
    if (!readerToken || readerToken === token) throw new Error('TWO_DISTINCT_ORDINARY_TEST_ACCOUNTS_REQUIRED');
    const reader = new FlareMoClient({ baseUrl, token: readerToken, access });
    const report = await runScenario({ writer, reader, allowTrash: trash, mode: 'live-rest-test' });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed') process.exitCode = 1;
  }
} catch (error) {
  const code = error instanceof FlareMoError || /^[A-Z_]+$/u.test(error.message) ? error.message : 'INVALID_CONFIGURATION_OR_UNEXPECTED_ERROR';
  console.error(JSON.stringify({ status: 'failed', error: code }));
  process.exitCode = 1;
}
