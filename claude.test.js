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
    rename: async (key, title, cwd) => { client.calls.push(['rename', key, title, cwd]); info.customTitle = title; },
    fork: async (...args) => { client.calls.push(['fork', ...args]); return { sessionId: '22345678-1234-1234-1234-123456789abc' }; },
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
      { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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

test('Claude automatic mode reads files and shell output but keeps edits and questions pending', async t => {
  const { client, request } = await harness(t);
  assert.equal((await request('/threads/' + id + '/turns', { text: 'read', approvalMode: 'invalid' })).status, 400);
  assert.equal(client.calls.length, 0);
  await request('/threads/' + id + '/turns', { text: 'read', approvalMode: 'auto-accept' });
  await settle();
  const signal = client.options.abortController.signal;
  for (const [name, input] of [
    ['Read', { file_path: 'command-handler.js' }],
    ['Grep', { pattern: 'write' }],
    ['Bash', { command: 'cat README.md | head -n 20' }],
  ]) assert.equal((await client.options.canUseTool(name, input, { signal })).behavior, 'allow');
  const edit = client.options.canUseTool('Edit', { file_path: 'read.md' }, { signal });
  const question = client.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Continue?' }] }, { signal });
  const malformedQuestion = client.options.canUseTool('AskUserQuestion', { questions: [] }, { signal });
  assert.equal((await request('/threads/' + id)).data.requests.length, 3);
  await request('/threads/' + id + '/approval-mode', { mode: 'auto-decline' });
  assert.equal((await edit).behavior, 'deny');
  assert.equal((await request('/threads/' + id)).data.requests.length, 2);
  await request('/threads/' + id + '/interrupt', {});
  await Promise.all([question, malformedQuestion]);
});

test('changing Claude mode releases an already pending read without approving an edit', async t => {
  const { client, request } = await harness(t);
  await request('/threads/' + id + '/turns', { text: 'read', approvalMode: 'ask' });
  await settle();
  const signal = client.options.abortController.signal;
  const read = client.options.canUseTool('Bash', { command: 'git status; git diff --stat' }, { signal });
  const edit = client.options.canUseTool('Write', { file_path: 'read.txt', content: 'x' }, { signal });
  assert.equal((await request('/threads/' + id)).data.requests.length, 2);
  await request('/threads/' + id + '/approval-mode', { mode: 'auto-accept' });
  assert.equal((await read).behavior, 'allow');
  assert.equal((await request('/threads/' + id)).data.requests.length, 1);
  await request('/threads/' + id + '/interrupt', {});
  assert.equal((await edit).behavior, 'deny');
});

for (const mode of ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']) {
  test('Claude native mode is passed on start/resume and questions stay interactive: ' + mode, async t => {
    for (const fresh of [false, true]) {
      const { client, request, dir } = await harness(t);
      const threadId = fresh ? (await request('/threads', { cwd: dir })).data.thread.id : id;
      assert.equal((await request('/threads/' + threadId + '/turns', { text: 'test', approvalMode: mode })).status, 200);
      await settle();
      assert.equal(client.options.permissionMode, mode);
      assert.equal(client.options.allowDangerouslySkipPermissions, mode === 'bypassPermissions' ? true : undefined);
      assert.equal(client.options[fresh ? 'sessionId' : 'resume'], threadId);
      const hook = client.options.hooks.PreToolUse[0].hooks[0];
      const pending = hook({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which?' }] } }, 'tool-id', { signal: client.options.abortController.signal });
      const history = (await request('/threads/' + threadId)).data;
      assert.equal(history.requests[0].questions[0].question, 'Which?');
      await request('/threads/' + threadId + '/requests/' + history.requests[0].id, { answers: { 'Which?': 'A' } });
      const result = await pending;
      assert.equal(result.hookSpecificOutput.permissionDecision, 'allow');
      assert.equal(result.hookSpecificOutput.updatedInput.answers['Which?'], 'A');
      await request('/threads/' + threadId + '/approval-mode', { mode: 'default' });
      assert.equal(client.options.permissionMode, mode, 'selection applies to next turn');
    }
  });
}

test('Claude rename persists through SDK and draft title is passed to first turn', async t => {
  const { request, client, dir } = await harness(t);
  assert.equal((await request('/threads/' + id + '/title', { title: '  Renamed  ' })).status, 200);
  assert.deepEqual(client.calls[0], ['rename', id, 'Renamed', dir]);
  assert.equal((await request('/threads/' + id)).data.title, 'Renamed');
  assert.equal((await request('/threads/' + id + '/title', { title: '' })).status, 400);
  const draft = (await request('/threads', { cwd: dir })).data.thread;
  await request('/threads/' + draft.id + '/title', { title: 'Draft title' });
  assert.equal((await request('/threads/' + draft.id)).data.title, 'Draft title');
  await request('/threads/' + draft.id + '/turns', { text: 'hello' });
  assert.equal(client.options.title, 'Draft title');
});

test('Claude fork uses SDK full-history copy with original cwd and rejects running sessions', async t => {
  const { request, client, dir } = await harness(t);
  const result = await request('/threads/' + id + '/fork', { title: 'Branch' });
  assert.equal(result.status, 200);
  assert.notEqual(result.data.thread.id, id);
  assert.equal(result.data.thread.title, 'Branch');
  assert.deepEqual(client.calls[0], ['fork', id, dir, 'Branch']);
  assert.equal(client.calls.length, 1);
  assert.equal((await request('/threads/' + id + '/fork', { title: '' })).status, 400);
  await request('/threads/' + id + '/turns', { text: 'busy' });
  assert.equal((await request('/threads/' + id + '/fork', { title: 'Busy' })).status, 409);
});
test('Claude draft fork has an independent ID and leaves original draft intact', async t => {
  const { request, client, dir } = await harness(t);
  const source = (await request('/threads', { cwd: dir })).data.thread;
  const copy = (await request('/threads/' + source.id + '/fork', { title: 'Draft copy' })).data.thread;
  assert.notEqual(source.id, copy.id);
  assert.equal((await request('/threads/' + copy.id)).data.title, 'Draft copy');
  assert.equal((await request('/threads/' + source.id)).data.title, source.title);
  assert.equal(client.calls.length, 0);
});

test('Claude historical usage is available when idle and repeated polls do not accumulate it', async t => {
  const { request, client } = await harness(t);
  client.messages = async () => [
    { type: 'assistant', uuid: 'a', message: { id: 'api-a', content: 'one', usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 4 } } },
    { type: 'assistant', uuid: 'b', message: { id: 'api-b', content: 'two', usage: { input_tokens: 12, output_tokens: 6 } } },
  ];
  for (let i = 0; i < 2; i++) {
    const data = (await request('/threads/' + id)).data;
    assert.equal(data.running, false);
    assert.equal(data.usage.total.totalTokens, 52);
    assert.equal(data.usage.requestCount, 2);
  }
  assert.equal(client.calls.length, 0);
});
