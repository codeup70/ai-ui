import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexUsageReader, parseCodexUsage, summarizeClaudeUsage } from './session-usage.js';
const event = (input, output) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 5, total_tokens: input + output }, last_token_usage: { input_tokens: 3, output_tokens: 2 } } } });
test('Codex totals restore after restart, use latest snapshot, and tolerate partial writes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-usage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  await fs.writeFile(file, event(10, 2) + '\n' + event(20, 4) + '\n{"partial":');
  const read = createCodexUsageReader();
  assert.equal((await read(file)).total.totalTokens, 24);
  assert.equal((await read(file)).total.totalTokens, 24);
  assert.equal((await createCodexUsageReader()(file)).total.totalTokens, 24);
  await fs.appendFile(file, '\n' + event(40, 8) + '\n');
  assert.equal((await read(file)).total.totalTokens, 48);
  assert.equal((await read(file)).total.cachedInputTokens, 5);
  // Latest usage may be far behind a long tool output.
  await fs.appendFile(file, JSON.stringify({ output: 'x'.repeat(300000) }) + '\n');
  assert.equal((await read(file)).total.totalTokens, 48);
  assert.equal(await read(path.join(dir, 'missing')), null);
});
test('missing usage is unknown, not a made-up zero', () => {
  assert.equal(parseCodexUsage('{}'), null);
  assert.equal(parseCodexUsage('{'), null);
  assert.equal(summarizeClaudeUsage([{ type: 'assistant', message: { content: 'hello' } }]), null);
});
test('Claude sums API messages across turns and deduplicates blocks and live/history overlap', () => {
  const message = (uuid, id, output) => ({ type: 'assistant', uuid, message: { id, usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: output } } });
  const a = message('1', 'api-1', 2), b = message('2', 'api-1', 4), c = message('3', 'api-2', 6);
  const usage = summarizeClaudeUsage([a, b, c, a, b, { ...c, parent_tool_use_id: 'child' }]);
  assert.equal(usage.requestCount, 2);
  assert.equal(usage.total.inputTokens, 70);
  assert.equal(usage.total.outputTokens, 10);
  assert.equal(usage.total.cachedInputTokens, 40);
  assert.equal(usage.total.totalTokens, 80);
});
