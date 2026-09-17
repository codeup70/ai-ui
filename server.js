import 'dotenv/config';
import express from 'express';
import { loadProvider, requestProvider } from './provider.js';
import { installCodexRoutes } from './codex-routes.js';
import { installClaudeRoutes } from './claude-routes.js';

import readExcelFile from 'read-excel-file/node';
import crypto from 'crypto';

import fsp from 'fs/promises';
import path from 'path';

const app = express();
const port = Number(process.env.PORT || 3000);

const provider = await loadProvider();
const MODEL = provider.model;
const SYSTEM_PROMPT = `شما یک دستیار هوش مصنوعی از OpenAI هستید. با کاربر به فارسی روان، خوانا و منظم پاسخ بده، مگر اینکه خودش زبان دیگری بخواهد.
متن فارسی را راست‌به‌چپ و مرتب نگه دار. اگر کد یا متن انگلیسی می‌نویسی، آن را واضح و قابل کپی ارائه کن.
اگر فایل Excel یا داده جدولی دریافت کردی، آن را با دقت بررسی کن و محاسبات/خلاصه‌ها را صریح توضیح بده.`;

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 1 * 1024 * 1024;
const MAX_SHEET_BYTES = 8 * 1024 * 1024;
const MAX_SHEET_ROWS_PER_SHEET = 200;
const MAX_SHEET_CELL_CHARS = 1200;

const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.js', '.ts', '.html', '.css', '.py']);
const SHEET_EXTENSIONS = new Set(['.xlsx', '.xls']);

app.use(express.json({ limit: '45mb' }));
app.use('/uploads', (_req, res) => res.sendStatus(404));
for (const file of ['index.html', 'script.js', 'voice.js', 'codex-ui.js', 'claude-ui.js', 'styles.css']) {
  app.get(file === 'index.html' ? '/' : '/' + file, (_req, res) => res.sendFile(path.resolve(file)));
}

async function callOpenAI(endpoint, body) { return requestProvider(provider, endpoint, body); }
const codexClient = installCodexRoutes(app, { attachmentInput: async ids => {
  const input = [];
  for (const id of ids) {
    const meta = await readMeta(id);
    if (meta.mode === 'image') {
      const data = await fsp.readFile(path.join(UPLOADS_DIR, meta.id, 'original'), 'base64');
      input.push({ type: 'image', url: `data:${meta.mimeType};base64,${data}` });
    } else if (meta.mode === 'pdf') {
      input.push({ type: 'text', text: `فایل PDF ضمیمهٔ کاربر: ${meta.originalName}\nمسیر محلی برای خواندن فایل: ${path.join(UPLOADS_DIR, meta.id, 'original')}` });
    } else {
      const { block } = await attachmentToContentBlock(id);
      input.push({ type: 'text', text: block.text });
    }
  }
  return input;
} });
process.on('exit', () => codexClient.close());
const claudeClient = installClaudeRoutes(app, { attachmentInput: async ids => {
  const blocks = [];
  for (const id of ids) {
    const meta = await readMeta(id);
    if (meta.mode === 'image' || meta.mode === 'pdf') {
      const data = await fsp.readFile(path.join(UPLOADS_DIR, meta.id, 'original'), 'base64');
      blocks.push({ type: meta.mode === 'image' ? 'image' : 'document', source: { type: 'base64', media_type: meta.mimeType, data } });
    } else blocks.push((await attachmentToContentBlock(id)).block);
  }
  return blocks;
} });
process.on('exit', () => claudeClient.close());
if (process.env.CODEX_SMOKE_TEST === '1') process.stdin.on('end', () => { codexClient.close(); process.exit(0); }).resume();
async function ensureUploadsDir() {
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function sanitizeFileName(name) {
  const base = path.basename(name || 'file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return base || 'file';
}

function decodeBase64Data(data) {
  if (typeof data !== 'string' || !data) throw new Error('داده فایل نامعتبر است.');
  const clean = data.includes(',') ? data.split(',').pop() : data;
  return Buffer.from(clean, 'base64');
}

function detectAttachment({ originalName, mimeType, sizeBytes }) {
  const safeName = sanitizeFileName(originalName);
  const ext = path.extname(safeName).toLowerCase();

  if (IMAGE_TYPES.has(ext)) {
    if (sizeBytes > MAX_IMAGE_BYTES) throw new Error('حجم تصویر بیشتر از حد مجاز ۸ مگابایت است.');
    return { mode: 'image', mimeType: IMAGE_TYPES.get(ext), originalName: safeName, ext };
  }

  if (ext === '.pdf') {
    if (sizeBytes > MAX_PDF_BYTES) throw new Error('حجم PDF بیشتر از حد مجاز ۳۲ مگابایت است.');
    return { mode: 'pdf', mimeType: 'application/pdf', originalName: safeName, ext };
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    if (sizeBytes > MAX_TEXT_BYTES) throw new Error('حجم فایل متنی بیشتر از حد مجاز ۱ مگابایت است.');
    return { mode: 'text', mimeType: String(mimeType || '').startsWith('text/') ? mimeType : 'text/plain', originalName: safeName, ext };
  }

  if (SHEET_EXTENSIONS.has(ext)) {
    if (sizeBytes > MAX_SHEET_BYTES) throw new Error('حجم فایل Excel بیشتر از حد مجاز ۸ مگابایت است.');
    return {
      mode: 'sheet',
      mimeType: ext === '.xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/vnd.ms-excel',
      originalName: safeName,
      ext,
    };
  }

  throw new Error('این نوع فایل فعلاً پشتیبانی نمی‌شود. تصویر، PDF، Excel یا فایل متنی کوچک آپلود کن.');
}

async function readMeta(id) {
  if (!/^att_[a-z0-9_]+$/i.test(id || '')) throw new Error('شناسه فایل نامعتبر است.');
  const metaPath = path.join(UPLOADS_DIR, id, 'meta.json');
  const raw = await fsp.readFile(metaPath, 'utf8');
  return JSON.parse(raw);
}

async function writeMeta(meta) {
  const metaPath = path.join(UPLOADS_DIR, meta.id, 'meta.json');
  await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

function formatCellValue(value) {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return text.length > MAX_SHEET_CELL_CHARS ? `${text.slice(0, MAX_SHEET_CELL_CHARS)}…` : text;
}

function sheetToMarkdown(name, rows) {
  if (!rows.length) return `### ${name}\n\n(این شیت خالی است.)`;

  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: width }, (_, index) => formatCellValue(row[index]).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')));
  const header = normalized[0] || [];
  const body = normalized.slice(1);
  const separator = Array.from({ length: width }, () => '---');
  const tableRows = [header, separator, ...body].map((row) => `| ${row.join(' | ')} |`).join('\n');

  return `### ${name}\n\n${tableRows}`;
}

async function extractSheetText(filePath, originalName) {
  const sheets = await readExcelFile(filePath);
  const parts = [`فایل Excel «${originalName}» با ${sheets.length} شیت ضمیمه شده است.`];

  for (const sheet of sheets) {
    const rows = Array.isArray(sheet.data) ? sheet.data : [];
    const shownRows = rows.slice(0, MAX_SHEET_ROWS_PER_SHEET);
    const omitted = rows.length - shownRows.length;
    parts.push(sheetToMarkdown(sheet.sheet || 'Sheet', shownRows));
    if (omitted > 0) parts.push(`_${omitted} ردیف دیگر از شیت «${sheet.sheet || 'Sheet'}» در این خلاصه نیامده است._`);
  }

  parts.push('اگر برای پاسخ به محاسبات دقیق نیاز داری، از داده‌های جدول بالا استفاده کن و محدودیت ردیف‌های خلاصه‌شده را ذکر کن.');
  return parts.join('\n\n');
}

async function attachmentToContentBlock(attachmentId) {
  const meta = await readMeta(attachmentId);
  const filePath = path.join(UPLOADS_DIR, meta.id, 'original');

  if (meta.mode === 'image') {
    const data = await fsp.readFile(filePath, 'base64');
    return {
      block: { type: 'input_image', image_url: 'data:' + meta.mimeType + ';base64,' + data },
    };
  }

  if (meta.mode === 'pdf') {
    const data = await fsp.readFile(filePath, 'base64');
    return {
      block: { type: 'input_file', filename: meta.originalName, file_data: 'data:application/pdf;base64,' + data },
    };
  }

  if (meta.mode === 'sheet') {
    const text = await extractSheetText(filePath, meta.originalName);
    return {
      block: { type: 'input_text', text },
    };
  }

  if (meta.mode === 'text') {
    const text = await fsp.readFile(filePath, 'utf8');
    return {
      block: { type: 'input_text', text: `فایل «${meta.originalName}»:\n\n\`\`\`\n${text}\n\`\`\`` },
    };
  }

  throw new Error('نوع فایل پشتیبانی نمی‌شود.');
}

function normalizeMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) throw new Error('messages باید یک آرایه باشد.');

  return rawMessages
    .slice(-40)
    .map((message) => ({
      role: message?.role,
      content: typeof message?.content === 'string' ? message.content.trim() : '',
      attachmentIds: Array.isArray(message?.attachmentIds) ? message.attachmentIds.slice(0, MAX_ATTACHMENTS_PER_MESSAGE) : [],
    }))
    .filter((message) => message.content || message.attachmentIds.length)
    .map((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') throw new Error('نقش پیام نامعتبر است.');
      if (message.role === 'assistant') return { role: 'assistant', content: message.content };
      return message;
    });
}

async function buildOpenAIInput(rawMessages) {
  const normalized = normalizeMessages(rawMessages);
  const messages = [];

  for (const message of normalized) {
    if (message.role === 'assistant') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    const content = [];
    for (const attachmentId of message.attachmentIds) {
      const result = await attachmentToContentBlock(attachmentId);
      content.push(result.block);
    }

    if (message.content) content.push({ type: 'input_text', text: message.content });
    messages.push({ role: 'user', content });
  }

  return messages;
}

function getErrorMessage(error) {
  return error?.message || 'یک خطای ناشناخته رخ داد.';
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasApiKey: provider.hasAuth, model: MODEL });
});

app.post('/api/attachments', async (req, res) => {
  try {
    const { name, type, size, data } = req.body || {};
    const buffer = decodeBase64Data(data);
    const sizeBytes = Number(size || buffer.length);
    if (buffer.length !== sizeBytes && Math.abs(buffer.length - sizeBytes) > 2) throw new Error('اندازه فایل با داده ارسالی هم‌خوانی ندارد.');

    await ensureUploadsDir();
    const detected = detectAttachment({ originalName: name, mimeType: type, sizeBytes: buffer.length });
    const id = makeId('att');
    const dir = path.join(UPLOADS_DIR, id);
    await fsp.mkdir(dir, { recursive: true });

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    await fsp.writeFile(path.join(dir, 'original'), buffer);

    const meta = {
      id,
      originalName: detected.originalName,
      safeName: detected.originalName,
      mimeType: detected.mimeType,
      sizeBytes: buffer.length,
      sha256,
      mode: detected.mode,
      status: 'ready',
      createdAt: new Date().toISOString(),
    };
    await writeMeta(meta);

    res.json({ attachment: meta });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.delete('/api/attachments/:id', async (req, res) => {
  try {
    const meta = await readMeta(req.params.id);
    await fsp.rm(path.join(UPLOADS_DIR, meta.id), { recursive: true, force: true });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'فایل پیدا نشد.' });
  }
});

app.post('/api/count-tokens', async (req, res) => {
  try {
    if (provider.codexBackend) return res.json({ supported: false, model: MODEL });
    if (!provider.hasAuth) return res.status(400).json({ error: 'اطلاعات احراز هویت در config.toml تنظیم نشده است.' });
    const input = await buildOpenAIInput(req.body?.messages);
    const result = await callOpenAI('responses/input_tokens', {
      model: MODEL, instructions: SYSTEM_PROMPT, input,
    });
    res.json({ inputTokens: result.input_tokens, model: MODEL });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.post('/api/chat', async (req, res) => {
  const startedAt = Date.now();
  try {
    if (!provider.hasAuth) return res.status(400).json({ error: 'اطلاعات احراز هویت ارائه‌دهنده را در config.toml بررسی کن.' });
    const input = await buildOpenAIInput(req.body?.messages);
    if (!input.length || input.at(-1).role !== 'user') return res.status(400).json({ error: 'یک پیام جدید از طرف کاربر لازم است.' });
    const response = await callOpenAI('responses', {
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      input,
      reasoning: { effort: provider.effort },
      ...(provider.codexBackend ? {} : { max_output_tokens: 16000 }),
      stream: true,
      store: false,
    });
    if (response.error) throw new Error(response.error.message);
    const reply = (response.output || [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content || [])
      .map((block) => block.type === 'output_text' ? block.text : block.type === 'refusal' ? block.refusal : '')
      .filter(Boolean).join('\n').trim();
    res.json({
      reply: reply || 'پاسخی دریافت نشد. لطفاً دوباره تلاش کن.',
      usage: response.usage,
      model: response.model,
      stopReason: response.incomplete_details?.reason || response.status,
      requestMs: Date.now() - startedAt,
    });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error), requestMs: Date.now() - startedAt });
  }
});

app.listen(port, '127.0.0.1', () => {
  console.log('Persian OpenAI Chat is running at http://localhost:' + port);
});
