import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const chatRoot = path.join(os.homedir(), '.ai-ui', 'conversations');
export async function resolveChatWorkspace(cwd) {
  if (cwd !== undefined && typeof cwd !== 'string') throw new Error('مسیر پروژه نامعتبر است.');
  if (!cwd?.trim()) {
    await fs.mkdir(chatRoot, { recursive: true });
    return fs.mkdtemp(path.join(chatRoot, 'chat-'));
  }
  if (!path.isAbsolute(cwd) || !(await fs.stat(cwd)).isDirectory()) throw new Error('مسیر کامل پوشهٔ پروژه را وارد کن.');
  return path.resolve(cwd);
}
export function isGeneralChat(cwd) {
  return Boolean(cwd) && path.dirname(path.resolve(cwd)) === chatRoot;
}
