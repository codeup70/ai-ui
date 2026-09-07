import express from 'express';
import { CodexClient } from './codex-client.js';

export function summarizeThread(thread) {
  return {
    id: thread.id, title: thread.name || thread.preview?.slice(0, 80) || 'گفتگوی Codex',
    cwd: thread.cwd || '', preview: thread.preview || '',
    createdAt: new Date((thread.createdAt || 0) * 1000).toISOString(),
    updatedAt: new Date((thread.updatedAt || thread.createdAt || 0) * 1000).toISOString(),
    status: thread.status?.type || 'notLoaded',
  };
}

export function presentItems(turns = []) {
  const messages = [], activity = [];
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (item.type === 'userMessage' || item.type === 'agentMessage') {
        const content = item.type === 'agentMessage' ? item.text || '' : (item.content || []).map(part => {
          if (part.type === 'text') return part.text;
          if (part.type === 'image' || part.type === 'localImage') return '[تصویر ضمیمه]';
          if (part.type === 'audio' || part.type === 'localAudio') return '[ویس ضمیمه]';
          return '';
        }).filter(Boolean).join('\n');
        messages.push({ id: item.id, role: item.type === 'userMessage' ? 'user' : 'assistant', content });
      } else if (item.type === 'commandExecution') {
        activity.push({ id: item.id, text: item.command, status: item.status, output: item.aggregatedOutput?.slice(-12000) || '' });
      } else if (item.type === 'fileChange') {
        activity.push({ id: item.id, text: 'تغییر فایل: ' + (item.changes || []).map(c => c.path).join('، '), status: item.status });
      } else if (item.type === 'webSearch') activity.push({ id: item.id, text: 'جستجو: ' + (item.query || ''), status: 'completed' });
    }
  }
  return { messages, activity: activity.slice(-40) };
}

export function installCodexRoutes(app, { client = new CodexClient(), attachmentInput = async () => [] } = {}) {
  const router = express.Router();
  const running = new Map();
  const starting = new Set();
  const live = new Map();
  const errors = new Map();
  const usage = new Map();
  const archived = new Set();
  client.on('notification', ({ method, params: p = {} }) => {
    if (method === 'turn/started') { running.set(p.threadId, p.turn.id); errors.delete(p.threadId); live.set(p.threadId, new Map()); }
    if (method === 'turn/completed') {
      running.delete(p.threadId);
      if (p.turn.error) errors.set(p.threadId, p.turn.error.message);
    }
    if (method === 'thread/tokenUsage/updated') usage.set(p.threadId, p.tokenUsage);
    if (method === 'item/started' || method === 'item/completed') {
      if (!live.has(p.threadId)) live.set(p.threadId, new Map());
      live.get(p.threadId).set(p.item.id, p.item);
    }
    if (method === 'item/agentMessage/delta') {
      if (!live.has(p.threadId)) live.set(p.threadId, new Map());
      const items = live.get(p.threadId);
      const item = items.get(p.itemId) || { id: p.itemId, type: 'agentMessage', text: '' };
      item.text += p.delta;
      items.set(p.itemId, item);
    }
  });
  client.on('disconnect', () => {
    for (const id of running.keys()) errors.set(id, 'اتصال قطع شد؛ تاریخچه را تازه کن و وضعیت درخواست را بررسی کن.');
    running.clear();
  });
  client.on('request', request => {
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (!supported.includes(request.method)) {
      // Never silently approve or leave an unsupported server tool waiting forever.
      client.write({ id: request.id, error: { code: -32601, message: 'This client does not support ' + request.method } });
      client.requests.delete(String(request.id));
      errors.set(request.params?.threadId, 'این ابزار در رابط وب پشتیبانی نمی‌شود: ' + request.method);
    }
  });
  router.use((req, res, next) => {
    const host = req.hostname;
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return res.sendStatus(403);
    if (req.get('sec-fetch-site') === 'cross-site') return res.sendStatus(403);
    if (req.get('origin') && req.get('origin') !== `${req.protocol}://${req.get('host')}`) return res.sendStatus(403);
    if (req.method === 'POST' && !req.is('application/json')) return res.sendStatus(415);
    res.set('Cache-Control', 'no-store');
    next();
  });
  const handle = fn => async (req, res) => {
    try { await client.connect(); await fn(req, res); }
    catch (error) { res.status(400).json({ error: error.message }); }
  };
  router.get('/threads', handle(async (req, res) => {
    const result = await client.request('thread/list', {
      limit: 100, sortKey: 'updated_at', modelProviders: [],
      sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'],
      cursor: req.query.cursor || null, archived: req.query.archived === 'true',
    });
    for (const thread of result.data) {
      if (req.query.archived === 'true') archived.add(thread.id);
      else archived.delete(thread.id);
    }
    res.json({ threads: result.data.map(summarizeThread), nextCursor: result.nextCursor });
  }));
  router.get('/threads/:id', handle(async (req, res) => {
    const { thread } = await client.request('thread/read', { threadId: req.params.id, includeTurns: true });
    const turns = thread.turns || [];
    const items = live.get(thread.id);
    if (items?.size) {
      const existingIds = new Set();
      for (const turn of turns) turn.items = (turn.items || []).map(item => { existingIds.add(item.id); return items.get(item.id) || item; });
      turns.push({ items: [...items.values()].filter(item => !existingIds.has(item.id)) });
    }
    const requests = [...client.requests.values()].filter(r => r.params?.threadId === thread.id).map(r => ({
      id: String(r.id), method: r.method,
      reason: r.params.reason || '', command: r.params.command || '', cwd: r.params.cwd || '',
      grantRoot: r.params.grantRoot || '', permissions: r.params.permissions || r.params.additionalPermissions,
      questions: r.params.questions || [],
      changes: live.get(thread.id)?.get(r.params.itemId)?.changes || [],
    }));
    res.json({ ...summarizeThread(thread), ...presentItems(turns), running: running.has(thread.id),
      turnId: running.get(thread.id), requests, error: errors.get(thread.id) || null, usage: usage.get(thread.id) || null });
  }));
  router.post('/threads/:id/turns', handle(async (req, res) => {
    const id = req.params.id;
    if (running.has(id) || starting.has(id)) return res.status(409).json({ error: 'این گفتگو هنوز در حال اجراست.' });
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    const ids = req.body.attachmentIds || [];
    if (!text && !ids.length) throw new Error('پیام خالی است.');
    if (text.length > 100000 || !Array.isArray(ids) || ids.length > 5) throw new Error('حجم پیام یا تعداد فایل‌ها بیش از حد مجاز است.');
    starting.add(id);
    try {
      const extra = await attachmentInput(ids);
      // Resume the original thread and inherit its cwd, model, instructions and permissions.
      // Never disable approvals or elevate its sandbox to make the integration work.
      if (archived.has(id)) {
        await client.request('thread/unarchive', { threadId: id });
        archived.delete(id);
      }
      const stored = await client.request('thread/read', { threadId: id, includeTurns: false });
      const { thread } = await client.request('thread/resume', { threadId: id, cwd: stored.thread.cwd });
      if (thread.status?.type === 'active') throw new Error('این سشن در حال اجراست؛ صبر کن تا کار فعلی تمام شود.');
      const input = [...(text ? [{ type: 'text', text }] : []), ...extra];
      const { turn } = await client.request('turn/start', { threadId: id, input });
      // turn/started is authoritative; completion may race this response.
      res.json({ turnId: turn.id });
    } finally { starting.delete(id); }
  }));
  router.post('/threads/:id/interrupt', handle(async (req, res) => {
    const turnId = running.get(req.params.id);
    if (turnId) await client.request('turn/interrupt', { threadId: req.params.id, turnId });
    res.json({ ok: true });
  }));
  router.post('/threads/:id/archive', handle(async (req, res) => {
    const id = req.params.id;
    if (typeof req.body.archived !== 'boolean') throw new Error('وضعیت آرشیو نامعتبر است.');
    if (running.has(id) || starting.has(id)) return res.status(409).json({ error: 'ابتدا صبر کن کار این گفتگو تمام شود.' });
    starting.add(id);
    try {
      const { thread } = await client.request('thread/read', { threadId: id, includeTurns: false });
      if (thread.status?.type === 'active') throw new Error('این سشن هنوز در حال اجراست.');
      await client.request(req.body.archived ? 'thread/archive' : 'thread/unarchive', { threadId: id });
      if (req.body.archived) {
        archived.add(id);
        live.delete(id);
      } else archived.delete(id);
      res.json({ ok: true, archived: req.body.archived });
    } finally { starting.delete(id); }
  }));
  router.post('/threads/:id/delete', handle(async (req, res) => {
    const id = req.params.id;
    if (req.body.confirmedThreadId !== id) return res.status(400).json({ error: 'حذف گفتگو نیاز به تأیید صریح همان سشن دارد.' });
    if (running.has(id) || starting.has(id)) return res.status(409).json({ error: 'ابتدا صبر کن کار این گفتگو تمام شود.' });
    starting.add(id);
    try {
      const { thread } = await client.request('thread/read', { threadId: id, includeTurns: false });
      if (thread.status?.type === 'active') throw new Error('سشن در حال اجرا را نمی‌توان حذف کرد.');
      await client.request('thread/delete', { threadId: id });
      archived.delete(id);
      live.delete(id);
      errors.delete(id);
      usage.delete(id);
      res.json({ ok: true });
    } finally { starting.delete(id); }
  }));
  router.post('/threads/:id/requests/:requestId', handle(async (req, res) => {
    const request = client.requests.get(req.params.requestId);
    if (!request || request.params?.threadId !== req.params.id) throw new Error('درخواست پیدا نشد یا منقضی شده است.');
    let result;
    if (request.method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const q of request.params.questions) {
        const value = req.body.answers?.[q.id];
        if (typeof value !== 'string' || value.length > 10000) throw new Error('پاسخ سؤال نامعتبر است.');
        answers[q.id] = { answers: [value] };
      }
      result = { answers };
    } else {
      if (!['accept', 'decline'].includes(req.body.decision)) throw new Error('تصمیم نامعتبر است.');
      if (request.method === 'item/permissions/requestApproval') {
        result = { permissions: req.body.decision === 'accept' ? request.params.permissions : {}, scope: 'turn' };
      } else result = { decision: req.body.decision };
    }
    client.respond(req.params.requestId, result);
    res.json({ ok: true });
  }));
  app.use('/api/codex', router);
  return client;
}
