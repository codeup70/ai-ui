import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

export async function loadProvider(env = process.env) {
  const configPath = env.CODEX_CONFIG_PATH || path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml');
  const config = parse(await readFile(configPath, 'utf8'));
  const selected = config.profile ? config.profiles?.[config.profile] : {};
  const settings = { ...config, ...selected };
  const name = settings.model_provider || 'openai';
  const provider = config.model_providers?.[name] || (name === 'openai' ? {} : null);
  if (!provider) throw new Error('Unknown model_provider in config.toml');
  if (provider.wire_api && provider.wire_api !== 'responses') throw new Error('This app requires wire_api = "responses".');
  const token = provider.env_key ? env[provider.env_key] : provider.experimental_bearer_token || env.OPENAI_API_KEY;
  const headers = { ...provider.http_headers };
  for (const [key, variable] of Object.entries(provider.env_http_headers || {})) {
    if (env[variable]) headers[key] = env[variable];
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  headers['Content-Type'] = 'application/json';
  const baseUrl = provider.base_url || 'https://api.openai.com/v1';
  return {
    model: settings.model || 'gpt-6-astra',
    effort: settings.model_reasoning_effort || 'low',
    baseUrl: baseUrl.replace(/\/+$/, ''),
    headers,
    hasAuth: Boolean(token || Object.keys(headers).some(key => key.toLowerCase() === 'authorization')),
    codexBackend: new URL(baseUrl).pathname.includes('/backend-api/codex'),
  };
}

export async function requestProvider(provider, endpoint, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${provider.baseUrl}/${endpoint}`, {
    method: 'POST', headers: provider.headers,
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}: request failed.`);
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  let buffer = '';
  let completed;
  const decoder = new TextDecoder();
  const consume = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data);
    if (event.type === 'error' || event.type === 'response.failed') throw new Error('Provider could not complete the response.');
    if (event.type === 'response.completed' || event.type === 'response.incomplete') completed = event.response;
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) consume(line);
  }
  consume(buffer + decoder.decode());
  if (!completed) throw new Error('Provider stream ended without a completed response.');
  return completed;
}
