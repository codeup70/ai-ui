import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { installClaudeRoutes, presentClaudeMessages } from './claude-routes.js';

const id = '12345678-1234-1234-1234-123456789abc';
async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-route-test-'));
  const info = { sessionId: id, cwd: dir, summary: 'test', lastModified: Date.now() };
  const client = {
    calls: [], list: async () => [info], info: async key => key === id ? info : null,
    messages: async () => [{ type: 'user', uuid: 'old', message: { content: 'previous' } }],
    models: async () => [{ value: 'sonnet', displayName: 'Sonnet' }], close() {},
    delete: async (...args) => client.calls.push(['delete', ...args]),
    query: async (prompt, options) => {
      client.calls.push(['query', options]); client.options = options;
      const iterator = (async function* () {
        for await (const value of prompt) client.prompt = value;
        yield { type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'answer' }] } };
        await new Promise(resolve => { client.finish = resolve; options.abortController.signal.addEventListener('abort', resolve, { once: true }); });
        yield { type: 'result', usage: { input_tokens: 3, output_tokens: 2 }, is_error: false };
      })();
      iterator.close = () => client.finish?.();
      return iterator;
    },
  };
  const app = express(); app.use(express.json());
  const bridge = installClaudeRoutes(app, { client, stateFile: path.join(dir, 'archive.json') });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { bridge.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const request = async (url, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/claude${url}`,
      { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return { client, request, dir };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };

test('Claude history is read-only; model and original project used for exact-session resume', async t => {
  const { request, client, dir } = await harness(t);
  assert.equal((await request('/threads')).data.threads.length, 1);
  assert.equal((await request('/threads/' + id)).data.messages[0].content, 'previous');
  assert.equal(client.calls.length, 0);
  assert.equal((await request(`/threads/${id}/turns`, { text: 'next', model: 'sonnet' })).status, 200);
  await settle();
  assert.equal(client.options.resume, id); assert.equal(client.options.cwd, dir); assert.equal(client.options.model, 'sonnet');
  assert.equal(client.options.allowDangerouslySkipPermissions, undefined);
  assert.equal(client.prompt.message.content[0].text, 'next');
  assert.equal((await request(`/threads/${id}/turns`, { text: 'duplicate' })).status, 409);
  assert.equal((await request(`/threads/${id}/delete`, { confirmedThreadId: id })).status, 400);
  await request(`/threads/${id}/interrupt`, {}); await settle();
  assert.equal(client.options.abortController.signal.aborted, true);
  assert.equal((await request('/threads/' + id)).data.running, false);
});

test('Claude tool requests require an explicit scoped answer, including questions; stop denies pending permissions', async t => {
  const { request, client } = await harness(t);
  await request(`/threads/${id}/turns`, { text: 'edit' }); await settle();
  const signal = client.options.abortController.signal;
  const permission = client.options.canUseTool('Edit', { file_path: 'example.js', old_string: 'a', new_string: 'b' }, { signal });
  let result = await request('/threads/' + id);
  const requestId = result.data.requests[0].id;
  assert.equal((await request(`/threads/${id}/requests/${requestId}`, {})).status, 400);
  await request(`/threads/${id}/requests/${requestId}`, { decision: 'accept' });
  assert.equal((await permission).behavior, 'allow');
  const answer = client.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] }, { signal });
  result = await request('/threads/' + id);
  await request(`/threads/${id}/requests/${result.data.requests[0].id}`, { answers: { 'Which?': 'A' } });
  assert.equal((await answer).updatedInput.answers['Which?'], 'A');
  const pending = client.options.canUseTool('Bash', { command: 'test' }, { signal });
  await request(`/threads/${id}/interrupt`, {});
  assert.equal((await pending).behavior, 'deny');
});

test('Claude mutations block other origins; archive survives list refresh; deletion requires matching confirmation', async t => {
  const { request, client } = await harness(t);
  assert.equal((await request(`/threads/${id}/turns`, { text: 'bad' }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await request(`/threads/${id}/turns`, { text: 'bad', model: 'unknown' })).status, 400);
  assert.equal((await request(`/threads/${id}/delete`, {})).status, 400);
  assert.equal(client.calls.length, 0);
  await request(`/threads/${id}/archive`, { archived: true });
  assert.equal((await request('/threads')).data.threads.length, 0);
  assert.equal((await request('/threads?archived=true')).data.threads.length, 1);
  await request(`/threads/${id}/delete`, { confirmedThreadId: id });
  assert.equal(client.calls[0][0], 'delete');
});

test('Claude history excludes reasoning and nested tool messages', () => {
  const result = presentClaudeMessages([
    { type: 'assistant', uuid: 'one', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'visible' }, { type: 'tool_use', name: 'Read', id: 'r', input: { file_path: 'a' } }] } },
    { type: 'assistant', parent_tool_use_id: 'r', message: { content: 'nested' } },
  ]);
  assert.deepEqual(result.messages, [{ id: 'one', role: 'assistant', content: 'visible' }]);
  assert.equal(result.activity[0].text, 'Read');
});
