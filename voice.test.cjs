const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness() {
  const clips = new Map();
  const elements = new Map();
  const element = () => ({ value: '', dataset: {}, listeners: {}, classList: { toggle() {}, add() {}, remove() {} },
    append() {}, replaceChildren() {}, querySelectorAll: () => [], setAttribute() {},
    addEventListener(type, listener) { this.listeners[type] = listener; }, focus() {}, pause() {}, innerHTML: '' });
  const indexedDB = { open() {
    const request = {};
    request.result = { transaction() {
      const tx = { objectStore: () => ({
        getAll: () => ({ result: [...clips.values()] }),
        get: id => ({ result: clips.get(id) }),
        put: clip => { clips.set(clip.id, clip); return {}; },
        delete: id => { clips.delete(id); return {}; },
      }) };
      setImmediate(() => tx.oncomplete());
      return tx;
    } };
    setImmediate(() => request.onsuccess());
    return request;
  } };
  let recognition, recorder, stopped = false;
  class Recognition {
    constructor() { recognition = this; }
    start() {}
    stop() { setImmediate(() => this.onend?.()); }
    abort() {}
  }
  class Recorder {
    constructor() { recorder = this; this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      setImmediate(() => {
        this.ondataavailable({ data: new Blob(['audio']) });
        this.onstop?.();
      });
    }
  }
  const ctx = vm.createContext({ indexedDB, Blob, URL, Intl, console, performance, AbortController, setTimeout, clearTimeout,
    window: { SpeechRecognition: Recognition, MediaRecorder: Recorder, setTimeout, clearTimeout },
    MediaRecorder: Recorder,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped = true; } }] }) } },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element, createDocumentFragment: element },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => { throw new Error('unexpected network call'); },
  });
  vm.runInContext(fs.readFileSync('voice.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('codex-ui.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('script.js', 'utf8').replace(/setupVoiceInput\(\);\s*renderApp\(\);\s*setupCodexSessions\(\);\s*$/, ''), ctx);
  vm.runInContext('renderChatList = renderMessages = renderConsole = () => {};', ctx);
  const run = code => vm.runInContext(code, ctx);
  return { ctx, run, clips, elements, get recognition() { return recognition; }, get recorder() { return recorder; }, get stopped() { return stopped; } };
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };

test('queued messages run FIFO with updated history and preserve the next draft', async () => {
  const h = harness(); await h.run('voiceReady');
  const requests = [], complete = [];
  h.ctx.fetch = async (url, options) => {
    if (url !== '/api/chat') return { ok: true, json: async () => ({}) };
    requests.push(JSON.parse(options.body));
    return new Promise(resolve => complete.push(() => resolve({ ok: true, json: async () => ({ reply: 'answer' }) })));
  };
  h.run("messageInput.value = 'first'; submitComposerMessage(); messageInput.value = 'second'; submitComposerMessage(); messageInput.value = 'third'; submitComposerMessage(); messageInput.value = 'draft';");
  assert.equal(requests.length, 1);
  assert.equal(h.run('messageQueues.get(activeChatId).length'), 2);
  assert.equal(h.run('messageInput.disabled'), false);
  complete[0](); await settle();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.map(m => m.content), ['first', 'answer', 'second']);
  assert.equal(h.run('messageInput.value'), 'draft');
  complete[1](); await settle();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].messages.at(-1).content, 'third');
  complete[2](); await settle();
  assert.equal(h.run('messageQueues.get(activeChatId).length'), 0);
});

test('queue failure retains failed job and pauses later jobs', async () => {
  const h = harness(); await h.run('voiceReady');
  h.run("messageInput.value = 'failed'; submitComposerMessage(); messageInput.value = 'later'; submitComposerMessage(); messageInput.value = 'draft';");
  await settle();
  assert.equal(h.run('pausedQueues.has(activeChatId)'), true);
  assert.equal(h.run('messageQueues.get(activeChatId).length'), 2);
  assert.equal(h.run('messageQueues.get(activeChatId)[0].typedText'), 'failed');
  assert.equal(h.run('messageInput.value'), 'draft');
});

test('Enter sends once; Shift+Enter and composing text do not send', async () => {
  const h = harness(); await h.run('voiceReady');
  let sent = 0, prevented = 0;
  h.ctx.countSend = () => sent++;
  h.run('submitComposerMessage = countSend;');
  const keydown = h.elements.get('messageInput').listeners.keydown;
  const event = { key: 'Enter', preventDefault() { prevented++; } };
  keydown(event);
  keydown({ ...event, shiftKey: true });
  keydown({ ...event, isComposing: true });
  keydown({ ...event, keyCode: 229 });
  keydown({ ...event, repeat: true });
  assert.equal(sent, 1);
  assert.equal(prevented, 2);
});
test('cancelling deletion preserves local and Codex chats; failed deletion preserves the session', async () => {
  const h = harness(); await h.run('voiceReady');
  const original = h.run('activeChatId');
  h.ctx.window.confirm = () => false;
  h.run('deleteChat(activeChatId)');
  assert.equal(h.run('activeChatId'), original);
  h.run("codexChats.push({ ...normalizeChat({id: 'codex_test', title: 'Test'}), source: 'codex', threadId: 'test', cwd: 'D:/project' });");
  let called = false;
  h.ctx.deleteRequest = async () => { called = true; throw new Error('delete failed'); };
  h.run('codexApi = deleteRequest;');
  await h.run("deleteCodexChat('codex_test')");
  assert.equal(called, false);
  assert.equal(h.run('codexChats.length'), 1);
  h.ctx.window.confirm = () => true;
  await h.run("deleteCodexChat('codex_test')");
  assert.equal(called, true);
  assert.equal(h.run('codexChats.length'), 1);
  assert.equal(h.run('codexChats[0].deleting'), false);
});

test('records without changing text; preview persists locally; send uses transcript and keeps audio', async () => {
  const h = harness();
  await h.run('voiceReady');
  h.run("messageInput.value = 'typed';");
  await h.run('toggleVoiceInput()');
  const result = [{ transcript: 'spoken prompt' }]; result.isFinal = true;
  h.recognition.onresult({ resultIndex: 0, results: [result] });
  assert.equal(h.run('messageInput.value'), 'typed');
  assert.equal(h.run('sendBtn.disabled'), true);
  const chatId = h.run('activeChatId');
  h.run("switchChat('another');");
  assert.equal(h.run('activeChatId'), chatId);
  h.run('stopVoiceRecording()'); await settle();
  assert.equal(h.stopped, true);
  assert.equal(h.clips.size, 1);
  assert.equal(h.run('voiceDrafts.get(activeChatId).blob.size'), 5);
  let sent;
  h.ctx.fetch = async (url, options) => {
    if (url === '/api/chat') sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ reply: 'done' }) };
  };
  await h.run('sendMessage()');
  assert.equal(sent.messages[0].content, 'typed\n\nspoken prompt');
  assert.equal(h.run('voiceDrafts.size'), 0);
  assert.equal([...h.clips.values()][0].sent, true);
});

test('failed send restores voice and typed text; missing transcript cannot be sent', async () => {
  const h = harness(); await h.run('voiceReady');
  h.run("voiceDrafts.set(activeChatId, { id: 'test', transcript: '', blob: new Blob(['audio']) });");
  await h.run('sendMessage()');
  assert.equal(h.run('getActiveChat().messages.length'), 0);
  h.run("voiceDrafts.get(activeChatId).transcript = 'retry me'; messageInput.value = 'context';");
  await h.run('sendMessage()');
  assert.equal(h.run('voiceDrafts.get(activeChatId).transcript'), 'retry me');
  assert.equal(h.run('messageInput.value'), 'context');
  assert.equal(h.run('getActiveChat().messages.length'), 0);
});
