// Read-only browser integration check. Does not send any prompt to Codex.
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const browserPath = process.env.CHROME_BIN || [
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(candidate => candidate && existsSync(candidate));
if (!browserPath) throw new Error('Set CHROME_BIN to a Chrome/Chromium executable for this optional test.');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const number = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return number;
}
async function waitFor(fn) {
  let error;
  for (let i = 0; i < 100; i++) {
    try { const value = await fn(); if (value) return value; } catch (e) { error = e; }
    await delay(200);
  }
  throw error || new Error('Timed out');
}
const appPort = await port(), browserPort = await port();
const profile = await mkdtemp(path.join(tmpdir(), 'persian-chat-browser-'));
const app = spawn(process.execPath, ['server.js'], { windowsHide: true, env: { ...process.env, PORT: String(appPort), CODEX_SMOKE_TEST: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
app.stdout.on('data', () => {}); app.stderr.on('data', () => {});
let browser, socket;
try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${appPort}`)).ok);
  browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${browserPort}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const targets = await waitFor(async () => (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json());
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map(); let seq = 0; const exceptions = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    if (message.id) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(message.error) : p.resolve(message.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}` });
  await waitFor(() => evaluate('typeof codexChats !== "undefined" && codexChats.length > 0'));
  await evaluate('switchChat(codexChats[0].id)');
  await waitFor(() => evaluate('getActiveChat().loaded && getActiveChat().messages.length > 0'));
  const result = await evaluate('({sessions: codexChats.length, messages: getActiveChat().messages.length, bodyHeight: document.documentElement.scrollHeight, viewport: innerHeight, composerHeight: chatForm.offsetHeight})');
  assert.ok(result.sessions > 0); assert.ok(result.messages > 0);
  assert.equal(result.bodyHeight, result.viewport);
  assert.equal(exceptions.length, 0, exceptions.join('\n'));
  console.log(JSON.stringify(result));
  // Close the browser through its protocol so no visible/background helper is left.
  socket.send(JSON.stringify({ id: ++seq, method: 'Browser.close' }));
} finally {
  socket?.close(); browser?.kill(); app.stdin.end();
}
