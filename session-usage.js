import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
function codexBreakdown(value) {
  return { inputTokens: number(value.input_tokens), outputTokens: number(value.output_tokens),
    cachedInputTokens: number(value.cached_input_tokens), reasoningOutputTokens: number(value.reasoning_output_tokens),
    totalTokens: number(value.total_tokens ?? (number(value.input_tokens) + number(value.output_tokens))) };
}
export function parseCodexUsage(line) {
  try {
    const event = JSON.parse(line);
    const info = event.type === 'event_msg' && event.payload?.type === 'token_count' ? event.payload.info : null;
    if (!info?.total_token_usage) return null;
    return { total: codexBreakdown(info.total_token_usage), last: codexBreakdown(info.last_token_usage || {}), source: 'history' };
  } catch { return null; }
}
// Only paths supplied by the local app-server are read, never HTTP parameters.
export function createCodexUsageReader() {
  const cache = new Map();
  return async file => {
    if (typeof file !== 'string' || !file) return null;
    try {
      const stat = await fs.stat(file);
      const key = `${stat.size}:${stat.mtimeMs}`;
      if (cache.get(file)?.key === key) return cache.get(file).usage;
      let usage = null;
      const handle = await fs.open(file, 'r');
      try {
        const size = Math.min(stat.size, 256 * 1024), start = stat.size - size;
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, start);
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
        if (start) lines.shift();
        for (let i = lines.length - 1; i >= 0 && !usage; i--) usage = parseCodexUsage(lines[i]);
      } finally { await handle.close(); }
      if (!usage) {
        const stream = createReadStream(file, { encoding: 'utf8' });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try { for await (const line of lines) usage = parseCodexUsage(line) || usage; }
        finally { lines.close(); stream.destroy(); }
      }
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(file, { key, usage });
      return usage;
    } catch { return null; }
  };
}

export function summarizeClaudeUsage(records) {
  const requests = new Map();
  for (const record of records) {
    if (record.type !== 'assistant' || record.parent_tool_use_id || !record.message?.usage) continue;
    const message = record.message, usage = message.usage;
    if (message.model === '<synthetic>') continue;
    // Multiple content blocks/stream updates can share one API message ID.
    const key = message.id || record.uuid;
    if (!key) continue;
    const next = { inputTokens: number(usage.input_tokens) + number(usage.cache_read_input_tokens) + number(usage.cache_creation_input_tokens),
      outputTokens: number(usage.output_tokens), cachedInputTokens: number(usage.cache_read_input_tokens), cacheWriteInputTokens: number(usage.cache_creation_input_tokens) };
    const previous = requests.get(key);
    if (previous) for (const field of Object.keys(next)) next[field] = Math.max(next[field], previous[field]);
    requests.set(key, next);
  }
  if (!requests.size) return null;
  const total = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
  for (const usage of requests.values()) for (const field of Object.keys(total)) total[field] += usage[field];
  total.totalTokens = total.inputTokens + total.outputTokens;
  return { total, last: [...requests.values()].at(-1), requestCount: requests.size, source: 'history' };
}
