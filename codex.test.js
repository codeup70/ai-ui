import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import { installCodexRoutes, isReadOnlyCommand, isReadOnlyPermissionRequest, presentItems } from './codex-routes.js';

class FakeClient extends EventEmitter {
  requests = new Map(); calls = []; responses = [];
  emptyHistory = false;
  async connect() {}
  async request(method, params) {
    this.calls.push({ method, params });
    const thread = { id: 'thread-original', cwd: 'D:\\Project\\original', name: 'Original', createdAt: 1, updatedAt: 2,
      status: { type: 'idle' }, turns: [{ items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: '<script>history</script>' }] }] }] };
    if (method === 'thread/list') return { data: [thread], nextCursor: 'page2' };
    if (method === 'thread/start') return { thread: { ...thread, id: 'thread-new', cwd: params.cwd, turns: [] } };
    if (method === 'thread/read' && this.emptyHistory && params.threadId === 'thread-new' && params.includeTurns) {
      throw new Error('list_turns is not supported yet');
    }
    if (method === 'thread/read' || method === 'thread/resume') return { thread };
    if (method === 'turn/start') {
      this.emit('notification', { method: 'turn/started', params: { threadId: thread.id, turn: { id: 'turn-1' } } });
      return { turn: { id: 'turn-1' } };
    }
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); this.requests.delete(id); }
}
async function server(t) {
  const app = express(); app.use(express.json());
  const client = new FakeClient();
  installCodexRoutes(app, { client });
  const http = app.listen(0, '127.0.0.1');
  await new Promise(resolve => http.once('listening', resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  const url = `http://127.0.0.1:${http.address().port}/api/codex`;
  const post = (route, body, headers = {}) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { client, url, post };
}
test('new Codex thread opens before history exists and sends without resuming an unpersisted thread', async t => {
  const { client, url, post } = await server(t);
  client.emptyHistory = true;
  const created = await post('/threads', { cwd: process.cwd() });
  assert.equal(created.status, 200);
  const { thread } = await created.json();
  const history = await fetch(url + '/threads/' + thread.id);
  assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).messages, []);
  assert.equal((await post('/threads/' + thread.id + '/turns', { text: 'hello' })).status, 200);
  assert.equal(client.calls.some(c => c.method === 'thread/resume'), false);
});

test('list/history do not resume; pagination and original project are retained', async t => {
  const { client, url } = await server(t);
  const list = await (await fetch(url + '/threads?cursor=page1&archived=true')).json();
  assert.equal(list.nextCursor, 'page2');
  assert.equal(client.calls[0].params.cursor, 'page1');
  assert.equal(client.calls[0].params.archived, true);
  const history = await (await fetch(url + '/threads/thread-original')).json();
  assert.equal(history.cwd, 'D:\\Project\\original');
  assert.equal(history.messages[0].content, '<script>history</script>');
  assert.equal(client.calls.some(c => c.method === 'thread/resume'), false);
});
test('send resumes the same thread/project and rejects duplicate turns without overriding permissions', async t => {
  const { client, post } = await server(t);
  assert.equal((await post('/threads/thread-original/turns', { text: 'edit the project' })).status, 200);
  assert.deepEqual(client.calls.find(c => c.method === 'thread/resume').params, { threadId: 'thread-original', cwd: 'D:\\Project\\original' });
  assert.deepEqual(client.calls.find(c => c.method === 'turn/start').params, { threadId: 'thread-original', input: [{ type: 'text', text: 'edit the project' }] });
  assert.equal((await post('/threads/thread-original/turns', { text: 'duplicate' })).status, 409);
});
test('approval requires an explicit scoped decision; cross-origin execution is blocked', async t => {
  const { client, post } = await server(t);
  client.requests.set('7', { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-original', command: 'git status' } });
  assert.equal((await post('/threads/wrong/requests/7', { decision: 'accept' })).status, 400);
  assert.equal(client.responses.length, 0);
  assert.equal((await post('/threads/thread-original/requests/7', { decision: 'decline' })).status, 200);
  assert.deepEqual(client.responses[0].result, { decision: 'decline' });
  assert.equal((await post('/threads/thread-original/turns', { text: 'run' }, { Origin: 'https://example.com' })).status, 403);
  assert.equal(client.calls.length, 0);
});
test('approval mode can auto-accept or auto-decline tool approvals while questions remain manual', async t => {
  const { client, post } = await server(t);
  assert.equal((await post('/threads/thread-original/approval-mode', { mode: 'auto-accept' })).status, 200);
  client.requests.set('8', { id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-original', command: 'git status' } });
  client.emit('request', client.requests.get('8'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.responses.at(-1).result, { decision: 'accept' });
  assert.equal((await post('/threads/thread-original/approval-mode', { mode: 'auto-decline' })).status, 200);
  client.requests.set('9', { id: 9, method: 'item/tool/requestUserInput', params: { threadId: 'thread-original', questions: [] } });
  client.emit('request', client.requests.get('9'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.responses.some(item => item.id === 9), false);
  assert.equal(isReadOnlyCommand('git status'), true);
  // Arbitrary SQL can call writing functions; it needs explicit permission.
  assert.equal(isReadOnlyCommand('psql -c "SELECT * FROM users"'), false);
  assert.equal(isReadOnlyCommand('psql -c "UPDATE users SET name = \'x\'"'), false);
  assert.equal(isReadOnlyPermissionRequest({ params: { permissions: { fileSystem: { read: ['report.xlsx'] } } } }), true);
  assert.equal(isReadOnlyPermissionRequest({ params: { permissions: { fileSystem: { write: ['report.xlsx'] } } } }), false);
  client.requests.set('10', { id: 10, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-original', command: 'git commit -am change' } });
  await post('/threads/thread-original/approval-mode', { mode: 'auto-accept' });
  client.emit('request', client.requests.get('10'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.responses.some(item => item.id === 10), false);
});
test('history presents user/assistant text and tool activity, without reasoning contents', () => {
  const data = presentItems([{ items: [
    { type: 'reasoning', content: ['private'], summary: ['summary'] },
    { id: 'a', type: 'agentMessage', text: 'done' },
    { id: 'c', type: 'commandExecution', command: 'git status', status: 'completed', aggregatedOutput: 'clean' },
  ] }]);
  assert.equal(data.messages.length, 1); assert.equal(data.messages[0].content, 'done');
  assert.equal(data.activity[0].output, 'clean');
  assert.equal(JSON.stringify(data).includes('private'), false);
});
test('archive and restore use the original thread; active turns cannot be archived', async t => {
  const { client, post } = await server(t);
  assert.equal((await post('/threads/thread-original/archive', { archived: true })).status, 200);
  assert.deepEqual(client.calls.at(-1), { method: 'thread/archive', params: { threadId: 'thread-original' } });
  assert.equal((await post('/threads/thread-original/archive', { archived: false })).status, 200);
  assert.equal(client.calls.at(-1).method, 'thread/unarchive');
  assert.equal((await post('/threads/thread-original/archive', { archived: 'true' })).status, 400);
  await post('/threads/thread-original/turns', { text: 'working' });
  const count = client.calls.length;
  assert.equal((await post('/threads/thread-original/archive', { archived: true })).status, 409);
  assert.equal(client.calls.length, count);
});
test('delete requires matching explicit confirmation and blocks running threads', async t => {
  const { client, post } = await server(t);
  assert.equal((await post('/threads/thread-original/delete', {})).status, 400);
  assert.equal((await post('/threads/thread-original/delete', { confirmedThreadId: 'wrong' })).status, 400);
  assert.equal(client.calls.length, 0);
  assert.equal((await post('/threads/thread-original/delete', { confirmedThreadId: 'thread-original' })).status, 200);
  assert.deepEqual(client.calls.at(-1), { method: 'thread/delete', params: { threadId: 'thread-original' } });
  await post('/threads/thread-original/turns', { text: 'working' });
  const count = client.calls.length;
  assert.equal((await post('/threads/thread-original/delete', { confirmedThreadId: 'thread-original' })).status, 409);
  assert.equal(client.calls.length, count);
});

test('manual Codex mode leaves actual emitted command, file and permission requests pending', async t => {
  const { client, post } = await server(t);
  const requests = [
    { id: 'manual-command', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-original', command: 'Get-Content README.md' } },
    { id: 'manual-file', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-original' } },
    { id: 'manual-permissions', method: 'item/permissions/requestApproval', params: { threadId: 'thread-original', permissions: { fileSystem: { read: ['x'] } } } },
  ];
  for (const request of requests) {
    client.requests.set(request.id, request); client.emit('request', request);
  }
  await new Promise(setImmediate);
  assert.equal(client.responses.length, 0);
  assert.equal(client.requests.size, 3);
  await post('/threads/thread-original/requests/manual-command', { decision: 'accept' });
  assert.equal(client.responses.length, 1);
});

test('changing Codex mode applies to pending reads but leaves edits and questions for the user', async t => {
  const { client, post } = await server(t);
  const requests = [
    { id: 'read', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-original', command: 'powershell.exe -Command "Get-ChildItem | Select-Object Name"' } },
    { id: 'edit', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-original' } },
    { id: 'question', method: 'item/tool/requestUserInput', params: { threadId: 'thread-original', questions: [] } },
    { id: 'other', method: 'item/commandExecution/requestApproval', params: { threadId: 'other-thread', command: 'git status' } },
  ];
  for (const request of requests) { client.requests.set(request.id, request); client.emit('request', request); }
  await new Promise(setImmediate);
  await post('/threads/thread-original/approval-mode', { mode: 'auto-accept' });
  await new Promise(setImmediate);
  assert.deepEqual(client.responses.map(r => r.id), ['read']);
  assert.equal(client.responses[0].result.decision, 'accept');
  await post('/threads/thread-original/approval-mode', { mode: 'auto-decline' });
  await new Promise(setImmediate);
  assert.equal(client.responses.at(-1).id, 'edit');
  assert.equal(client.responses.at(-1).result.decision, 'decline');
  assert.equal(client.requests.has('question'), true);
  assert.equal(client.requests.has('other'), true);
});

test('Codex accepts a validated approval mode with the turn after a server restart', async t => {
  const { client, post } = await server(t);
  assert.equal((await post('/threads/thread-original/turns', { text: 'read', approvalMode: 'invalid' })).status, 400);
  assert.equal(client.calls.length, 0);
  assert.equal((await post('/threads/thread-original/turns', { text: 'read', approvalMode: 'auto-accept' })).status, 200);
  const turn = client.calls.find(c => c.method === 'turn/start').params;
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turn.approvalPolicy, 'on-request');
  const request = { id: 'restart-read', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-original', command: 'Get-ChildItem' } };
  client.requests.set(request.id, request); client.emit('request', request);
  await new Promise(setImmediate);
  assert.equal(client.responses.at(-1).result.decision, 'accept');
});
