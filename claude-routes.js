import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ClaudeClient } from './claude-client.js';
import { resolveChatWorkspace, isGeneralChat } from './chat-workspace.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function presentClaudeMessages(records) {
  const messages = [], activity = [];
  for (const record of records) {
    if (!['user', 'assistant'].includes(record.type) || record.parent_tool_use_id) continue;
    const blocks = record.message?.content;
    const content = typeof blocks === 'string' ? blocks : (blocks || []).map(b => b.type === 'text' ? b.text : b.type === 'image' ? '[تصویر ضمیمه]' : '').filter(Boolean).join('\n');
    if (content) messages.push({ id: record.uuid, role: record.type, content });
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block.type === 'tool_use') activity.push({ id: block.id, text: block.name, output: JSON.stringify(block.input, null, 2).slice(0, 12000), status: 'completed' });
    }
  }
  return { messages, activity: activity.slice(-40) };
}
function summary(info) {
  return { id: info.sessionId, title: info.customTitle || info.summary || info.firstPrompt?.slice(0, 80) || 'گفتگوی Claude',
    cwd: info.cwd || '', general: isGeneralChat(info.cwd), createdAt: new Date(info.createdAt || info.lastModified || Date.now()).toISOString(),
    updatedAt: new Date(info.lastModified || Date.now()).toISOString(), source: 'claude' };
}
export function installClaudeRoutes(app, { client = new ClaudeClient(), attachmentInput = async () => [],
  stateFile = path.resolve('.claude-ui-state.json') } = {}) {
  const router = express.Router(), states = new Map(), drafts = new Map();
  let archiveIds = new Set();
  const archiveReady = fs.readFile(stateFile, 'utf8').then(raw => { archiveIds = new Set(JSON.parse(raw).archived || []); }).catch(error => {
    if (error.code !== 'ENOENT') throw new Error('خواندن وضعیت آرشیو Claude ناموفق بود.');
  });
  archiveReady.catch(() => {});
  let archiveWrite = Promise.resolve();
  const setArchived = (id, archived) => {
    const write = archiveWrite.catch(() => {}).then(async () => {
      const next = new Set(archiveIds);
      if (archived) next.add(id); else next.delete(id);
      await fs.writeFile(stateFile + '.tmp', JSON.stringify({ archived: [...next] }), 'utf8');
      await fs.rename(stateFile + '.tmp', stateFile); archiveIds = next;
    });
    archiveWrite = write; return write;
  };
  router.use((req, res, next) => {
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname) || req.get('sec-fetch-site') === 'cross-site' ||
      (req.get('origin') && req.get('origin') !== `${req.protocol}://${req.get('host')}`)) return res.sendStatus(403);
    if (req.method === 'POST' && !req.is('application/json')) return res.sendStatus(415);
    res.set('Cache-Control', 'no-store'); next();
  });
  const handle = fn => async (req, res) => {
    try { await archiveReady; await fn(req, res); }
    catch (error) { res.status(error.status || 400).json({ error: error.publicMessage || error.message }); }
  };
  const getInfo = async id => {
    if (!uuid.test(id)) throw new Error('شناسهٔ سشن نامعتبر است.');
    const info = drafts.get(id) || await client.info(id);
    if (!info) throw new Error('سشن Claude پیدا نشد.');
    return info;
  };
  router.get('/status', handle(async (_req, res) => {
    try { res.json(await client.status()); } catch { res.status(503).json({ error: 'Claude Code در دسترس نیست یا ورود آن فعال نیست.' }); }
  }));
  router.get('/models', handle(async (_req, res) => { res.json({ models: await client.models() }); }));
  router.get('/threads', handle(async (req, res) => {
    const all = new Map((await client.list()).map(info => [info.sessionId, info]));
    for (const [id, info] of drafts) if (!all.has(id)) all.set(id, info);
    res.json({ threads: [...all.values()].filter(info => archiveIds.has(info.sessionId) === (req.query.archived === 'true')).map(summary), nextCursor: null });
  }));
  router.post('/threads', handle(async (req, res) => {
    const cwd = await resolveChatWorkspace(req.body.cwd);
    const info = { sessionId: crypto.randomUUID(), cwd: path.resolve(cwd), summary: 'گفتگوی تازهٔ Claude', lastModified: Date.now() };
    drafts.set(info.sessionId, info);
    res.json({ thread: summary(info) });
  }));
  router.get('/threads/:id', handle(async (req, res) => {
    const info = await getInfo(req.params.id), state = states.get(req.params.id);
    const records = drafts.has(req.params.id) ? [] : await client.messages(req.params.id, info.cwd);
    const merged = new Map(records.map(record => [record.uuid, record]));
    for (const record of state?.records || []) merged.set(record.uuid, record);
    const data = presentClaudeMessages([...merged.values()]);
    if (state?.partial) data.messages.push({ id: 'streaming', role: 'assistant', content: state.partial });
    res.json({ ...summary(info), ...data, running: Boolean(state?.running), error: state?.error,
      model: state?.model, usage: state?.usage, requests: [...(state?.requests?.values() || [])].map(r => r.public) });
  }));
  router.post('/threads/:id/turns', handle(async (req, res) => {
    const id = req.params.id, info = await getInfo(id);
    if (states.get(id)?.running) return res.status(409).json({ error: 'این سشن هنوز در حال کار است.' });
    const text = req.body.text || '', ids = req.body.attachmentIds || [], model = req.body.model;
    if (typeof text !== 'string' || !Array.isArray(ids) || ids.length > 5 || (!text.trim() && !ids.length)) throw new Error('پیام نامعتبر است.');
    const state = { running: true, requests: new Map(), records: [], partial: '', model, controller: new AbortController() };
    states.set(id, state);
    try {
      if (model && (typeof model !== 'string' || !(await client.models()).some(m => m.value === model))) throw new Error('مدل Claude نامعتبر است.');
      if (archiveIds.has(id)) await setArchived(id, false);
      const content = [{ type: 'text', text: text || 'لطفاً فایل ضمیمه را تحلیل کن.' }, ...await attachmentInput(ids)];
      const record = { type: 'user', uuid: crypto.randomUUID(), session_id: id, parent_tool_use_id: null, message: { role: 'user', content } };
      const prompt = (async function* () { yield record; })();
      const query = await client.query(prompt, { cwd: info.cwd, ...(drafts.has(id) ? { sessionId: id } : { resume: id }),
        ...(model ? { model } : {}), includePartialMessages: true, abortController: state.controller,
        canUseTool: (name, input, options) => new Promise(resolve => {
          const requestId = crypto.randomUUID();
          const questions = name === 'AskUserQuestion' && Array.isArray(input.questions) ? input.questions.map(q => ({ id: q.question, question: q.question, options: q.options })) : [];
          const done = result => { options.signal.removeEventListener('abort', abort); state.requests.delete(requestId); resolve(result); };
          const abort = () => done({ behavior: 'deny', message: 'درخواست متوقف شد.' });
          if (options.signal.aborted || state.controller.signal.aborted) return abort();
          options.signal.addEventListener('abort', abort, { once: true });
          state.requests.set(requestId, { input, done, public: { id: requestId,
            method: questions.length ? 'item/tool/requestUserInput' : 'claude/tool/approval',
            reason: name, command: JSON.stringify(input, null, 2), cwd: info.cwd, questions } });
        }) });
      state.query = query; state.records.push(record);
      res.json({ started: true });
      void (async () => {
        try {
          for await (const message of query) {
            if (message.type === 'system' && message.subtype === 'init') state.model = message.model;
            if (message.type === 'stream_event' && message.event?.type === 'content_block_delta' && message.event.delta?.type === 'text_delta') state.partial += message.event.delta.text;
            if (message.type === 'assistant') { state.records.push(message); state.partial = ''; }
            if (message.type === 'result') {
              state.usage = { total: { inputTokens: (message.usage?.input_tokens || 0) + (message.usage?.cache_read_input_tokens || 0) + (message.usage?.cache_creation_input_tokens || 0), outputTokens: message.usage?.output_tokens || 0 } };
              if (message.is_error) state.error = (message.errors || ['اجرای Claude ناموفق بود.']).join('\n');
            }
          }
        } catch (error) { if (!state.controller.signal.aborted) state.error = error.message; }
        finally {
          if (state.partial) state.records.push({ type: 'assistant', uuid: crypto.randomUUID(), message: { content: state.partial } });
          state.partial = '';
          for (const request of state.requests.values()) request.done({ behavior: 'deny', message: 'اجرا پایان یافت.' });
          query.close();
          if (await client.info(id).catch(() => null)) drafts.delete(id);
          state.running = false;
        }
      })();
    } catch (error) { state.running = false; state.controller.abort(); state.query?.close(); throw error; }
  }));
  router.post('/threads/:id/requests/:requestId', handle(async (req, res) => {
    await getInfo(req.params.id);
    const request = states.get(req.params.id)?.requests.get(req.params.requestId);
    if (!request) throw new Error('این درخواست دیگر فعال نیست.');
    if (req.body.decision === 'decline') request.done({ behavior: 'deny', message: 'کاربر اجازه نداد.' });
    else if (req.body.decision === 'accept' && !request.public.questions.length) request.done({ behavior: 'allow', updatedInput: request.input });
    else if (request.public.questions.length && req.body.answers && request.public.questions.every(q => typeof req.body.answers[q.id] === 'string'))
      request.done({ behavior: 'allow', updatedInput: { ...request.input, answers: req.body.answers } });
    else throw new Error('پاسخ نامعتبر است.');
    res.json({ ok: true });
  }));
  router.post('/threads/:id/interrupt', handle(async (req, res) => {
    await getInfo(req.params.id);
    const state = states.get(req.params.id);
    if (state?.running) {
      state.controller.abort(); state.query?.close();
      for (const request of state.requests.values()) request.done({ behavior: 'deny', message: 'کاربر اجرا را متوقف کرد.' });
    }
    res.json({ ok: true });
  }));
  router.post('/threads/:id/archive', handle(async (req, res) => {
    await getInfo(req.params.id);
    if (states.get(req.params.id)?.running) throw new Error('ابتدا کار را متوقف کن.');
    if (typeof req.body.archived !== 'boolean') throw new Error('وضعیت نامعتبر است.');
    await setArchived(req.params.id, req.body.archived); res.json({ ok: true });
  }));
  router.post('/threads/:id/delete', handle(async (req, res) => {
    const info = await getInfo(req.params.id);
    if (req.body.confirmedThreadId !== req.params.id || states.get(req.params.id)?.running) throw new Error('تأیید حذف لازم است؛ سشن فعال قابل حذف نیست.');
    if (!drafts.has(req.params.id)) await client.delete(req.params.id, info.cwd);
    drafts.delete(req.params.id); states.delete(req.params.id); res.json({ ok: true });
  }));
  app.use('/api/claude', router);
  return { close() { for (const state of states.values()) { state.controller.abort(); state.query?.close(); } client.close(); } };
}
