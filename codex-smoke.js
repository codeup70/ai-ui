// Read-only integration check: never resumes a thread or starts a model turn.
import { CodexClient } from './codex-client.js';
const client = new CodexClient({ args: process.argv.includes('--proxy') ? ['app-server', 'proxy'] : ['app-server'] });
try {
  await client.connect();
  const result = await client.request('thread/list', { limit: 100, sortKey: 'updated_at', modelProviders: [], sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'] });
  console.log(JSON.stringify({ count: result.data.length, hasMore: Boolean(result.nextCursor), projectCount: new Set(result.data.map(t => t.cwd)).size }));
  const thread = result.data.find(t => t.cwd?.replaceAll('\\', '/').toLowerCase() === process.cwd().replaceAll('\\', '/').toLowerCase()) || result.data[0];
  if (thread) {
    const read = await client.request('thread/read', { threadId: thread.id, includeTurns: true });
    console.log(JSON.stringify({ status: read.thread.status, turns: read.thread.turns?.length,
      itemTypes: [...new Set(read.thread.turns?.flatMap(t => t.items?.map(i => i.type) || []) || [])] }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client.close(); }
