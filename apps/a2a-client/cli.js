#!/usr/bin/env node
/**
 * Independent requester-side A2A client (official @a2a-js/sdk 1.2.0).
 * Reads an execution credential handed to the requester and talks to the
 * community gateway over JSON-RPC/SSE. Prints one JSON line per result/event.
 *
 *   node apps/a2a-client/cli.js card   --credential-file f.json
 *   node apps/a2a-client/cli.js send   --credential-file f.json --dispatch-file d.json [--stream]
 *   node apps/a2a-client/cli.js get    --credential-file f.json --task <id>
 *   node apps/a2a-client/cli.js cancel --credential-file f.json --task <id>
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AgentCard, Task, StreamResponse } from '@a2a-js/sdk';
import { a2aClient, sendParams } from '../../packages/gateway/dispatcher.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  'credential-file': { type: 'string' }, 'dispatch-file': { type: 'string' }, task: { type: 'string' }, stream: { type: 'boolean', default: false },
} });
const print = value => console.log(JSON.stringify(value));
try {
  const handoff = JSON.parse(readFileSync(values['credential-file'], 'utf8'));
  const client = await a2aClient({ endpoint: handoff.endpoint, credential: handoff.credential });
  switch (positionals[0]) {
    case 'card': print({ card: AgentCard.toJSON(await client.getAgentCard()) }); break;
    case 'send': {
      const message = values['dispatch-file'] ? JSON.parse(readFileSync(values['dispatch-file'], 'utf8')) : handoff.message;
      if (values.stream) {
        for await (const event of client.sendMessageStream({ ...sendParams(message), configuration: { ...sendParams(message).configuration, returnImmediately: false } })) print({ event: StreamResponse.toJSON(event) });
      } else {
        const result = await client.sendMessage(sendParams(message));
        print({ result: 'status' in result ? { task: Task.toJSON(result) } : result });
      }
      break;
    }
    case 'get': print({ task: Task.toJSON(await client.getTask({ tenant: '', id: values.task })) }); break;
    case 'cancel': print({ task: Task.toJSON(await client.cancelTask({ tenant: '', id: values.task, metadata: {} })) }); break;
    default: console.error('Usage: cli.js card|send|get|cancel'); process.exitCode = 2;
  }
} catch (error) {
  print({ error: error.message.slice(0, 500) });
  process.exitCode = 1;
}
