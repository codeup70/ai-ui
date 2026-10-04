const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the production storage helpers without starting provider sessions.
const source = fs.readFileSync(require('node:path').join(__dirname, 'script.js'), 'utf8');
function fixture() {
  const values = new Map();
  const context = vm.createContext({
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    isProjectChat: chat => ['codex', 'claude'].includes(chat.source),
    saveChatStore() {},
  });
  vm.runInContext(source.slice(source.indexOf('function readProjectContext('), source.indexOf('function saveChatStore(')), context);
  return context;
}
test('project context survives reconstruction, stays separate, and can be cleared', () => {
  const ctx = fixture();
  for (const provider of ['codex', 'claude']) {
    const chat = { id: provider + '_test', source: provider, projectContext: '' };
    ctx.saveProjectContext(chat, provider + ' context');
    assert.equal(ctx.readProjectContext({ id: chat.id }), provider + ' context');
    assert.equal(ctx.readProjectContext({ id: chat.id + '_other' }), '');
    ctx.saveProjectContext(chat, '');
    assert.equal(ctx.readProjectContext({ id: chat.id, projectContext: 'stale' }), '');
  }
});
test('storage failure leaves the previous context intact for project and ordinary chats', () => {
  const ctx = fixture();
  ctx.localStorage.setItem = ctx.saveChatStore = () => { throw Error('storage full'); };
  for (const source of ['codex', 'claude', 'local']) {
    const chat = { id: source + '_test', source, projectContext: 'previous' };
    assert.throws(() => ctx.saveProjectContext(chat, 'new'), /storage full/);
    assert.equal(chat.projectContext, 'previous');
  }
});
test('unavailable storage preserves supplied context on read', () => {
  const ctx = fixture();
  ctx.localStorage.getItem = () => { throw Error('unavailable'); };
  assert.equal(ctx.readProjectContext({ id: 'codex_test', projectContext: 'fallback' }), 'fallback');
});
