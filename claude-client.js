import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as sdk from '@anthropic-ai/claude-agent-sdk';

const exec = promisify(execFile);
export async function findClaudeExecutable() {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [path.dirname(process.execPath), path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.claude', 'local'), process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
    ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
  const candidates = [process.env.CLAUDE_BIN, ...dirs.flatMap(dir => names.map(name => path.join(dir, name)))].filter(Boolean);
  for (let candidate of candidates) {
    if (/\.(cmd|ps1)$/i.test(candidate)) {
      const base = path.join(path.dirname(candidate), 'node_modules', '@anthropic-ai', 'claude-code');
      for (const relative of ['bin/claude.exe', 'cli.js']) {
        const executable = path.join(base, relative);
        try { await fs.access(executable); return executable; } catch { /* Try next entry. */ }
      }
      continue;
    }
    try { await fs.access(candidate, constants.F_OK); return candidate; } catch { /* Try next location. */ }
  }
  throw new Error('Claude Code پیدا نشد. مسیر فایل اجرایی را در CLAUDE_BIN تنظیم کن.');
}

export class ClaudeClient {
  constructor(api = sdk) { this.sdk = api; this.probes = new Set(); }
  async options() {
    this.executable ||= await findClaudeExecutable();
    return { pathToClaudeCodeExecutable: this.executable, settingSources: ['user', 'project', 'local'],
      permissionMode: 'default', systemPrompt: { type: 'preset', preset: 'claude_code' } };
  }
  async status() {
    const options = await this.options();
    const js = options.pathToClaudeCodeExecutable.endsWith('.js');
    const { stdout } = await exec(js ? process.execPath : options.pathToClaudeCodeExecutable,
      [...(js ? [options.pathToClaudeCodeExecutable] : []), 'auth', 'status'], { windowsHide: true, timeout: 15000 });
    const auth = JSON.parse(stdout);
    return { loggedIn: Boolean(auth.loggedIn), authMethod: auth.authMethod, apiProvider: auth.apiProvider,
      apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY), defaultCwd: process.cwd() };
  }
  async models() {
    if (this.modelCache) return this.modelCache;
    if (this.modelPromise) return this.modelPromise;
    this.modelPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      // Keep input open for the initialization RPC, without submitting a model turn.
      const prompt = (async function* () {
        await new Promise(resolve => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener('abort', resolve, { once: true });
        });
      })();
      let query;
      try {
        query = this.sdk.query({ prompt, options: { ...await this.options(), abortController: controller, persistSession: false } });
        this.probes.add(query);
        this.modelCache = (await query.supportedModels()).map(m => ({ value: m.value, displayName: m.displayName, description: m.description }));
        return this.modelCache;
      } finally { clearTimeout(timer); controller.abort(); query?.close(); this.probes.delete(query); }
    })().finally(() => { this.modelPromise = null; });
    return this.modelPromise;
  }
  list() { return this.sdk.listSessions(); }
  info(id) { return this.sdk.getSessionInfo(id); }
  messages(id, cwd) { return this.sdk.getSessionMessages(id, { dir: cwd }); }
  delete(id, cwd) { return this.sdk.deleteSession(id, { dir: cwd }); }
  async query(prompt, options) { return this.sdk.query({ prompt, options: { ...await this.options(), ...options } }); }
  close() { for (const query of this.probes) query.close(); }
}
