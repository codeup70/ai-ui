const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('script.js', 'utf8').split('// Transcript search and portable exports.')[1].split('\nrestoreMessageQueues();')[0];
function harness() {
  const elements = new Map();
  const element = () => ({ children: [], value: '', checked: false, textContent: '',
    append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; },
    listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, showModal() {}, close() { this.listeners.close?.(); }, focus() {} });
  const current = { id: 'local', title: 'Local', messages: [{ role: 'user', content: 'old needle' }, { role: 'assistant', content: 'new reply' }] };
  const ctx = vm.createContext({ structuredClone, URLSearchParams, console, setTimeout,
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    getActiveChat: () => current, chatStore: { chats: [current] },
    isProjectChat: chat => ['claude', 'codex'].includes(chat.source), formatNumber: String });
  vm.runInContext('// ' + source, ctx);
  return { ctx, elements, current, run: code => vm.runInContext(code, ctx) };
}
test('full message search matches old messages, Persian variants and literal punctuation', () => {
  const h = harness();
  assert.equal(h.run("transcriptMatches(chatStore.chats[0].messages, 'needle')[0].index"), 0);
  h.ctx.messages = [{ content: 'كِتاب و يادداشت [a+b]' }];
  assert.equal(h.run("transcriptMatches(messages, 'کتاب')[0].index"), 0);
  assert.equal(h.run("transcriptMatches(messages, '[a+b]').length"), 1);
  assert.equal(h.run("transcriptMatches(messages, '  ').length"), 0);
});
test('exports retain all messages and code but omit internal settings and attachment paths', () => {
  const h = harness();
  h.ctx.chat = { title: 'Test', source: 'codex', cwd: 'PRIVATE_PATH', projectContext: 'PRIVATE_CONTEXT' };
  h.ctx.messages = [{ role: 'user', content: 'hello', attachments: [{ name: 'a.txt', path: 'PRIVATE_PATH' }] }, { role: 'assistant', content: '```js\nconst a = 1;\n```' }];
  const json = h.run("transcriptExport(chat, messages, 'json').text");
  assert.equal(JSON.parse(json).messages.length, 2);
  assert.equal(json.includes('PRIVATE'), false);
  assert.match(h.run("transcriptExport(chat, messages, 'markdown').text"), /```js\nconst a = 1;\n```/);
  assert.throws(() => h.run("transcriptExport(chat, messages, 'bad')"));
});
test('HTML exports cannot execute content from messages, titles or attachments', () => {
  const h = harness(); h.ctx.chat = { title: '<script>alert(1)</script>' };
  h.ctx.messages = [{ role: 'user', content: '</pre><img src=x onerror=alert(1)>', attachments: [{ name: '<svg onload=alert(1)>' }] }];
  const html = h.run("transcriptExport(chat, messages, 'html').text");
  assert.equal(html.includes('<script>'), false); assert.equal(html.includes('<img'), false); assert.equal(html.includes('<svg'), false);
  assert.match(html, /&lt;img/); assert.match(html, /Content-Security-Policy/);
});
test('project export reads complete current history and propagates errors instead of exporting stale data', async () => {
  const h = harness(); h.ctx.chat = { source: 'codex', threadId: 't', messages: [] };
  h.ctx.projectApi = async () => ({ messages: [{ content: 'full history' }] });
  assert.equal((await h.run('readTranscript(chat)')).messages[0].content, 'full history');
  h.ctx.projectApi = async () => { throw Error('offline'); };
  await assert.rejects(h.run('readTranscript(chat)'), /offline/);
});
test('global search paginates, reads unopened histories, includes archives and reports partial failure', async () => {
  const h = harness(); const calls = [];
  h.ctx.codexApi = async (url, _body, provider) => {
    calls.push([provider, url]);
    if (provider === 'claude') throw Error('offline');
    return { threads: [{ id: url.includes('cursor=next') ? 'second' : url.includes('archived=true') ? 'archived' : 'first', title: 'Project' }], nextCursor: !url.includes('cursor') && url.includes('archived=false') ? 'next' : null };
  };
  h.ctx.projectApi = async () => ({ messages: [{ role: 'assistant', content: 'needle in unopened history' }] });
  h.run('setupTranscriptTools()');
  h.elements.get('searchMessagesBtn').onclick();
  h.ctx.document.getElementById('messageSearchQuery').value = 'needle'; h.ctx.document.getElementById('messageSearchScope').value = 'all'; h.ctx.document.getElementById('messageSearchArchived').checked = true;
  await h.elements.get('messageSearchForm').onsubmit({ preventDefault() {} });
  assert.equal(h.elements.get('messageSearchResults').children.length, 4);
  assert.ok(calls.some(([, url]) => url.includes('cursor=next')));
  assert.match(h.elements.get('messageSearchStatus').textContent, /ناقص/);
});
test('closing search prevents an in-flight response from adding stale results', async () => {
  const h = harness(); Object.assign(h.current, { source: 'codex', threadId: 'test' });
  let release;
  h.ctx.projectApi = () => new Promise(resolve => { release = resolve; });
  h.run('setupTranscriptTools()'); h.elements.get('searchMessagesBtn').onclick();
  h.ctx.document.getElementById('messageSearchQuery').value = 'needle';
  const search = h.elements.get('messageSearchForm').onsubmit({ preventDefault() {} });
  h.elements.get('closeMessageSearch').onclick();
  release({ messages: [{ content: 'needle' }] }); await search;
  assert.equal(h.elements.get('messageSearchResults').children.length, 0);
});
