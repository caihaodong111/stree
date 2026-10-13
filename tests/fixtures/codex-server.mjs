#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let initialized = false;
let generation;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (method === 'initialize') return send({ id, result: { userAgent: 'test-codex' } });
  if (method === 'initialized') {
    initialized = true;
    return;
  }
  if (!initialized) return send({ id, error: { code: -1, message: 'Missing initialized' } });
  if (method === 'account/read') return send({ id, result: { account: { type: 'chatgpt' } } });
  if (method === 'model/list')
    return send({ id, result: { data: [{ model: 'test-model', isDefault: true }] } });
  if (method === 'thread/start') return send({ id, result: { thread: { id: 'test-thread' } } });
  if (method === 'turn/start') {
    send({ id, result: { turn: { id: 'test-turn' } } });
    send({
      method: 'turn/started',
      params: { threadId: 'test-thread', turn: { id: 'test-turn' } },
    });
    const prompt = params.input[0].text;
    if (prompt === 'disconnect') return process.exit(1);
    if (prompt === 'wait')
      return send({
        method: 'item/started',
        params: {
          threadId: 'test-thread',
          item: { type: 'dynamicToolCall', tool: 'search_places' },
        },
      });
    generation = true;
    return send({
      id: 1000,
      method: 'item/tool/call',
      params: { threadId: 'test-thread', tool: 'search_places', arguments: { keyword: '西湖' } },
    });
  }
  if (id === 1000 && generation) {
    send({
      method: 'item/completed',
      params: {
        threadId: 'test-thread',
        item: { type: 'agentMessage', phase: 'commentary', text: 'commentary' },
      },
    });
    send({
      method: 'item/agentMessage/delta',
      params: { threadId: 'test-thread', delta: 'partial' },
    });
    send({
      method: 'item/completed',
      params: {
        threadId: 'test-thread',
        item: {
          type: 'agentMessage',
          phase: 'final_answer',
          text: JSON.stringify({ toolResult: message.result }),
        },
      },
    });
    return send({
      method: 'turn/completed',
      params: { threadId: 'test-thread', turn: { status: 'completed' } },
    });
  }
  if (method === 'turn/interrupt' || method === 'thread/unsubscribe')
    return send({ id, result: {} });
});
