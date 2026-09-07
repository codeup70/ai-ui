import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export function codexExecutable(env = process.env) {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  const installed = path.join(env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  return process.platform === 'win32' && existsSync(installed) ? installed : 'codex';
}

export class CodexClient extends EventEmitter {
  constructor({ executable = codexExecutable(), args = ['app-server'], spawnImpl = spawn } = {}) {
    super();
    this.executable = executable;
    this.args = args;
    this.spawnImpl = spawnImpl;
    this.pending = new Map();
    this.requests = new Map();
    this.sequence = 0;
  }
  async connect() {
    if (!this.connecting) this.connecting = this.open().catch(error => { this.connecting = null; throw error; });
    return this.connecting;
  }
  async open() {
    const proc = this.spawnImpl(this.executable, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this.lines = createInterface({ input: proc.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        if (message.id !== undefined) {
          this.requests.set(String(message.id), message);
          this.emit('request', message);
        } else {
          if (message.method === 'serverRequest/resolved') this.requests.delete(String(message.params?.requestId));
          this.emit('notification', message);
        }
      } else {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || 'Codex request failed'));
        else entry.resolve(message.result);
      }
    });
    // Drain diagnostic output without exposing authentication/configuration in the UI.
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {});
    const disconnected = error => {
      if (this.proc !== proc) return;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      this.pending.clear();
      this.requests.clear();
      this.connecting = null;
      this.proc = null;
      this.emit('disconnect', error);
    };
    proc.on('error', error => disconnected(error));
    proc.on('exit', () => disconnected(new Error('اتصال Codex قطع شد؛ دوباره تلاش کن.')));
    try {
      await this.request('initialize', { clientInfo: { name: 'persian_project_chat', title: 'Persian Project Chat', version: '1.0.0' } });
      this.write({ method: 'initialized', params: {} });
    } catch (error) { this.close(); throw error; }
  }
  write(message) {
    if (!this.proc || this.proc.stdin.destroyed) throw new Error('Codex در دسترس نیست.');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex timeout: ${method}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id, result) {
    const request = this.requests.get(String(id));
    if (!request) throw new Error('این درخواست دیگر منتظر پاسخ نیست.');
    this.write({ id: request.id, result });
    this.requests.delete(String(id));
  }
  close() {
    this.lines?.close();
    this.proc?.kill();
  }
}
