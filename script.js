const chatLog = document.getElementById('chatLog');
const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');
const counter = document.getElementById('counter');
const statusText = document.getElementById('statusText');
const toast = document.getElementById('toast');
const chatList = document.getElementById('chatList');
const newChatBtn = document.getElementById('newChatBtn');
const activeChatTitle = document.getElementById('activeChatTitle');
const usageSummary = document.getElementById('usageSummary');
const statusConsole = document.getElementById('statusConsole');
const clearConsoleBtn = document.getElementById('clearConsoleBtn');
const fileInput = document.getElementById('fileInput');
const attachBtn = document.getElementById('attachBtn');
const voiceBtn = document.getElementById('voiceBtn');
const attachmentTray = document.getElementById('attachmentTray');

const CHATS_STORAGE_KEY = 'persian-claude-chats-v1';
const LEGACY_MESSAGES_KEY = 'persian-claude-chat-messages';
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const persianDigits = new Intl.NumberFormat('fa-IR');

let chatStore = loadChatStore();
let activeChatId = chatStore.activeChatId;
let sendingChatIds = new Set();
const openAIControllers = new Map();
const messageQueues = new Map();
const pausedQueues = new Set();
const composerDrafts = new Map();
const QUEUE_STORAGE_KEY = 'persian-chat-message-queues-v1';
function persistMessageQueues() {
  try {
    const data = [...messageQueues].map(([chatId, jobs]) => [chatId, jobs.map(job => ({
      chatId: job.chatId, typedText: job.typedText || '', model: job.model || '', projectContext: job.projectContext || '', webSearch: Boolean(job.webSearch), failed: Boolean(job.failed), errorText: job.errorText || '',
      attachments: (job.attachments || []).map(({ id, originalName, mimeType, size }) => ({ id, originalName, mimeType, size })),
    }))]);
    sessionStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify({ data, paused: [...pausedQueues] }));
  } catch {}
}
function restoreMessageQueues() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(QUEUE_STORAGE_KEY) || '{}');
    for (const [chatId, jobs] of saved.data || []) if (Array.isArray(jobs) && jobs.length) messageQueues.set(chatId, jobs);
    for (const chatId of saved.paused || []) pausedQueues.add(chatId);
  } catch {}
}
function renderMessageQueue() {
  renderActiveChats();
  const panel = document.getElementById('messageQueue');
  panel.replaceChildren();
  const queue = messageQueues.get(activeChatId) || [];
  if (!queue.length) return;
  if (pausedQueues.has(activeChatId)) {
    const resume = document.createElement('button');
    resume.type = 'button'; resume.textContent = 'ادامهٔ صف';
    resume.onclick = () => { pausedQueues.delete(activeChatId); persistMessageQueues(); drainMessageQueue(activeChatId); };
    panel.append(resume);
  }
  queue.forEach((job, index) => {
    const row = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = `${index + 1}. ${job.typedText || job.voice?.transcript || 'فایل ضمیمه'}${job.failed ? ` — ${job.errorText || 'ارسال ناموفق؛ صف متوقف است'}` : ' — در صف'}`;
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'لغو';
    cancel.onclick = () => { queue.splice(queue.indexOf(job), 1); persistMessageQueues(); renderMessageQueue(); };
    row.append(label, cancel); panel.append(row);
  });
}
function drainMessageQueue(chatId) {
  if (sendingChatIds.has(chatId) || pausedQueues.has(chatId)) return;
  const chat = getChatById(chatId);
  if (!chat || chat.submitting || chat.archiving || chat.deleting) return;
  const job = messageQueues.get(chatId)?.shift();
  if (!job) return;
  persistMessageQueues();
  renderMessageQueue();
  if (isProjectChat(chat)) sendCodexMessage(job);
  else sendMessage(job);
}
function requeueMessage(job) {
  job.failed = true;
  const queue = messageQueues.get(job.chatId) || [];
  queue.unshift(job); messageQueues.set(job.chatId, queue);
  pausedQueues.add(job.chatId); persistMessageQueues(); renderMessageQueue();
}
function submitComposerMessage() {
  if (voiceSession) return;
  const chat = getActiveChat();
  if (chat.archiving || chat.deleting) return;
  const voice = voiceDrafts.get(chat.id);
  if (voice && (!voice.transcript || voice.error)) { showToast('متن ویس کامل نیست.'); return; }
  const typedText = messageInput.value.trim();
  if (!typedText && !voice && !pendingAttachments.length) return;
  const job = { chatId: chat.id, typedText, voice, attachments: [...pendingAttachments], model: chat.model || '', projectContext: chat.projectContext || '', webSearch: Boolean(document.getElementById('webSearchToggle')?.checked) };
  const queue = messageQueues.get(chat.id) || [];
  queue.push(job); messageQueues.set(chat.id, queue);
  persistMessageQueues();
  messageInput.value = ''; composerDrafts.delete(chat.id); pendingAttachments = []; voiceDrafts.delete(chat.id);
  renderAttachments(); renderVoiceDraft(); updateCounter(); renderMessageQueue();
  drainMessageQueue(chat.id);
}
let pendingAttachments = [];
function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatNumber(value) {
  return persianDigits.format(Number(value || 0));
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${formatNumber(value)} بایت`;
  if (value < 1024 * 1024) return `${formatNumber(Math.round(value / 1024))} کیلوبایت`;
  return `${formatNumber((value / 1024 / 1024).toFixed(1))} مگابایت`;
}

function formatTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

function createEmptyUsage() {
  return {
    request_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    last_usage: null,
  };
}

function createChat(title = 'گفتگوی تازه') {
  const createdAt = nowIso();
  return {
    id: makeId('chat'),
    title,
    createdAt,
    updatedAt: createdAt,
    messages: [],
    projectContext: '',
    usageSummary: createEmptyUsage(),
    statusLog: [{ at: createdAt, type: 'info', text: 'گفتگوی تازه ساخته شد.' }],
  };
}

function normalizeChat(chat) {
  return {
    id: chat.id || makeId('chat'),
    title: chat.title || 'گفتگوی تازه',
    customTitle: Boolean(chat.customTitle),
    createdAt: chat.createdAt || nowIso(),
    updatedAt: chat.updatedAt || chat.createdAt || nowIso(),
    messages: Array.isArray(chat.messages) ? chat.messages : [],
    projectContext: typeof chat.projectContext === 'string' ? chat.projectContext : '',
    usageSummary: { ...createEmptyUsage(), ...(chat.usageSummary || {}) },
    statusLog: Array.isArray(chat.statusLog) ? chat.statusLog : [],
  };
}

function loadChatStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHATS_STORAGE_KEY));
    if (raw && Array.isArray(raw.chats) && raw.chats.length) {
      const chats = raw.chats.map(normalizeChat);
      const active = chats.some((chat) => chat.id === raw.activeChatId) ? raw.activeChatId : chats[0].id;
      return { version: 1, activeChatId: active, chats };
    }
  } catch {
    // Fall back to legacy migration or a new chat.
  }

  try {
    const legacyMessages = JSON.parse(localStorage.getItem(LEGACY_MESSAGES_KEY));
    if (Array.isArray(legacyMessages) && legacyMessages.length) {
      const legacyChat = createChat('گفتگوی قبلی');
      legacyChat.messages = legacyMessages.map((message) => ({
        id: makeId('msg'),
        role: message.role,
        content: message.content || '',
        attachmentIds: [],
        attachments: [],
        createdAt: nowIso(),
      })).filter((message) => message.role === 'user' || message.role === 'assistant');
      legacyChat.updatedAt = nowIso();
      legacyChat.statusLog.push({ at: nowIso(), type: 'info', text: 'گفتگوی قبلی از نسخه قدیمی منتقل شد.' });
      return { version: 1, activeChatId: legacyChat.id, chats: [legacyChat] };
    }
  } catch {
    // Ignore invalid legacy data.
  }

  const chat = createChat();
  return { version: 1, activeChatId: chat.id, chats: [chat] };
}

function saveChatStore() {
  localStorage.setItem(CHATS_STORAGE_KEY, JSON.stringify({ ...chatStore, activeChatId }));
  localStorage.setItem('persian-chat-active-session', activeChatId);
}

function getChatById(chatId) {
  return chatStore.chats.find((chat) => chat.id === chatId) || codexChats.find(chat => chat.id === chatId);
}

function getActiveChat() {
  let chat = getChatById(activeChatId);
  if (!chat) {
    chat = chatStore.chats[0] || createChat();
    if (!chatStore.chats.length) chatStore.chats.push(chat);
    activeChatId = chat.id;
    chatStore.activeChatId = chat.id;
    saveChatStore();
  }
  return chat;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
}

function setStatus(message) {
  statusText.textContent = message;
}

function updateCounter() {
  counter.textContent = `${formatNumber(messageInput.value.length)} حرف`;
}

function addStatusLog(chatId, type, text) {
  const chat = getChatById(chatId);
  if (!chat) return;
  chat.statusLog.push({ at: nowIso(), type, text });
  chat.statusLog = chat.statusLog.slice(-80);
  chat.updatedAt = nowIso();
  saveChatStore();
  if (chatId === activeChatId) renderConsole();
  renderChatList();
}

function updateTitleFromFirstMessage(chat) {
  if (!chat || chat.customTitle || chat.title !== 'گفتگوی تازه') return;
  const firstUser = chat.messages.find((message) => message.role === 'user' && message.content);
  if (!firstUser) return;
  chat.title = firstUser.content.replace(/\s+/g, ' ').slice(0, 42) || 'گفتگوی تازه';
}

function applyUsage(chat, usage) {
  if (!usage) return;
  chat.usageSummary = { ...createEmptyUsage(), ...(chat.usageSummary || {}) };
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;

  chat.usageSummary.input_tokens += input;
  chat.usageSummary.output_tokens += output;
  chat.usageSummary.cache_creation_input_tokens += cacheCreate;
  chat.usageSummary.cache_read_input_tokens += cacheRead;
  chat.usageSummary.total_input_tokens += input + (usage.input_tokens_details ? 0 : cacheCreate + cacheRead);
  chat.usageSummary.total_output_tokens += output;
  chat.usageSummary.request_count += 1;
  chat.usageSummary.last_usage = usage;
}

function createAttachmentChip(attachment, removable = false) {
  const chip = document.createElement('span');
  chip.className = `attachment-chip ${attachment.mode || ''}`;
  chip.dir = 'auto';
  chip.textContent = `${attachment.originalName || attachment.safeName || 'فایل'} · ${formatBytes(attachment.sizeBytes)}`;

  if (removable) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'حذف ضمیمه';
    remove.addEventListener('click', () => {
      pendingAttachments = pendingAttachments.filter((item) => item.id !== attachment.id);
      renderAttachments();
    });
    chip.append(remove);
  }

  return chip;
}

function renderMessageContent(container, text) {
  // Render fences with DOM text nodes: model/user content is never interpreted as HTML.
  const lines = text.split('\n');
  let prose = [], code = null, fence = '', language = '';
  const flushProse = () => {
    if (!prose.length) return;
    const paragraph = document.createElement('div');
    paragraph.className = 'message-prose';
    paragraph.textContent = prose.join('\n');
    container.append(paragraph);
    prose = [];
  };
  const flushCode = () => {
    const source = code.join('\n');
    const block = document.createElement('section');
    block.className = 'code-block';
    const header = document.createElement('div');
    header.className = 'code-header';
    const label = document.createElement('span');
    label.textContent = language || 'code';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'code-copy';
    copy.textContent = 'کپی';
    copy.setAttribute('aria-label', 'کپی کد');
    const pre = document.createElement('pre');
    pre.tabIndex = 0;
    const content = document.createElement('code');
    content.textContent = source;
    pre.append(content);
    copy.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(source);
        copy.textContent = 'کپی شد ✓';
        showToast('کد کپی شد.');
        setTimeout(() => { copy.textContent = 'کپی'; }, 2000);
      } catch {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(content);
        selection.removeAllRanges();
        selection.addRange(range);
        showToast('کپی خودکار ممکن نشد؛ کد انتخاب شد، Ctrl+C بزن.');
      }
    });
    header.append(label, copy);
    block.append(header, pre);
    container.append(block);
    code = null;
  };
  for (const line of lines) {
    if (code === null) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\r]*)\r?$/);
      if (opening) {
        flushProse();
        fence = opening[1];
        language = opening[2].trim().split(/\s+/)[0];
        code = [];
      } else prose.push(line);
    } else {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) flushCode();
      else code.push(line);
    }
  }
  if (code !== null) flushCode(); // Streaming replies may not have their closing fence yet.
  flushProse();
}

function createMessageElement(message, options = {}) {
  const wrapper = document.createElement('article');
  wrapper.className = `message ${message.role}`;
  if (options.pending) wrapper.classList.add('pending');

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = message.role === 'user' ? 'شما' : isProjectChat(getActiveChat()) ? agentName(getActiveChat()) : 'OpenAI';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.dir = 'auto';
  renderMessageContent(bubble, message.content || (message.attachmentIds?.length ? 'فایل ضمیمه شد.' : ''));

  wrapper.append(label);

  if (message.attachments?.length) {
    const row = document.createElement('div');
    row.className = 'message-attachments';
    message.attachments.forEach((attachment) => row.append(createAttachmentChip(attachment)));
    wrapper.append(row);
  }

  if (message.voiceId) {
    voiceStorage('readonly', store => store.get(message.voiceId)).then(clip => {
      if (clip && Date.now() - clip.createdAt < 86400000 && wrapper.isConnected) wrapper.append(createVoicePlayer(clip));
    }).catch(() => {});
  }
  wrapper.append(bubble);
  return wrapper;
}

function renderMessages() {
  const chat = getActiveChat();
  releaseVoicePlayers(chatLog);
  chatLog.innerHTML = '';
  activeChatTitle.textContent = chat.title;
  document.getElementById('projectPath').textContent = isProjectChat(chat) && !chat.general ? chat.cwd : 'گفتگوی عادی';

  if (!chat.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <strong>گفتگوی تازه آماده است</strong>
      <span>پیامت را بنویس یا یک عکس/PDF/فایل متنی ضمیمه کن تا OpenAI تحلیل کند.</span>
    `;
    chatLog.append(empty);
  } else {
    const fragment = document.createDocumentFragment();
    for (const message of chat.messages) fragment.append(createMessageElement(message));
    if (sendingChatIds.has(chat.id)) {
      fragment.append(createMessageElement({ role: 'assistant', content: isProjectChat(chat) ? `${agentName(chat)} در حال کار روی پروژه…` : 'OpenAI در حال پاسخ است…' }, { pending: true }));
    }
    chatLog.append(fragment);
  }

  chatLog.scrollTop = chatLog.scrollHeight;
  setStatus(sendingChatIds.has(chat.id) ? 'OpenAI در حال پاسخ است…' : `${formatNumber(chat.messages.length)} پیام`);
}

function getLastPreview(chat) {
  const last = [...chat.messages].reverse().find((message) => message.content || message.attachments?.length);
  if (!last) return 'هنوز پیامی ندارد';
  return last.content ? last.content.replace(/\s+/g, ' ').slice(0, 70) : 'فایل ضمیمه شده است';
}

function isActiveConversation(chat) {
  return !chat.deleting && Boolean(sendingChatIds.has(chat.id) || chat.requests?.length || messageQueues.get(chat.id)?.length || chat.unreadReply || chat.id === activeChatId);
}
function chatLastMessageTime(chat) {
  const messages = chat.messages || [];
  const last = [...messages].reverse().find(message => message.createdAt);
  return Math.max(Date.parse(chat.lastMessageAt || '') || 0,
    isProjectChat(chat) ? Date.parse(chat.updatedAt || '') || 0 : Date.parse(last?.createdAt || chat.createdAt || '') || 0);
}
function renderActiveChats() { renderChatList(); }
function renderChatList() {
  chatList.innerHTML = '';
  const archived = document.getElementById('archivedSessions').checked;
  const activeOnly = document.getElementById('activeSessions').checked;
  const query = (document.getElementById('chatSearch')?.value || '').trim().toLowerCase();
  const providerFilter = document.getElementById('sessionProviderFilter')?.value || 'all';
  const sorted = [...chatStore.chats, ...codexChats]
    .filter(chat => Boolean(chat.archived) === Boolean(archived) && (!activeOnly || isActiveConversation(chat))
      && (providerFilter === 'all' || providerFilter === (isProjectChat(chat) ? chat.source : 'openai'))
      && (!query || `${chat.title} ${getLastPreview(chat)} ${chat.projectContext || ''}`.toLowerCase().includes(query)))
    .sort((a, b) => chatLastMessageTime(b) - chatLastMessageTime(a));
  for (const chat of sorted) {
    const row = document.createElement('div'); row.className = 'session-row';
    const item = document.createElement('button'); item.type = 'button';
    item.className = `chat-list-item ${chat.id === activeChatId ? 'active' : ''}`;
    item.onclick = () => switchChat(chat.id);
    const title = document.createElement('strong'); title.className = 'chat-title'; title.textContent = chat.title;
    const preview = document.createElement('span'); preview.className = 'chat-preview';
    const queued = messageQueues.get(chat.id)?.length || 0;
    preview.textContent = chat.requests?.length ? 'منتظر پاسخ تو' : sendingChatIds.has(chat.id) ? 'در حال کار…' :
      chat.unreadReply ? 'پاسخ آماده است' : getLastPreview(chat);
    if (queued) preview.textContent += ` · ${formatNumber(queued)} در صف${pausedQueues.has(chat.id) ? ' (متوقف)' : ''}`;
    const meta = document.createElement('span'); meta.className = 'chat-meta';
    const project = isProjectChat(chat) && !chat.general ? (chat.cwd || '').split(/[\\/]/).filter(Boolean).pop() : '';
    meta.textContent = [isProjectChat(chat) ? agentName(chat) : 'OpenAI', project, formatTime(new Date(chatLastMessageTime(chat)).toISOString())].filter(Boolean).join(' · ');
    item.append(title, preview, meta);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'ghost session-delete'; remove.textContent = 'حذف';
    remove.setAttribute('aria-label', `حذف گفتگوی ${chat.title}`);
    remove.disabled = Boolean(chat.deleting || chat.archiving || voiceSession || sendingChatIds.has(chat.id));
    remove.onclick = () => isProjectChat(chat) ? deleteCodexChat(chat.id) : deleteChat(chat.id);
    const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'ghost session-rename';
    rename.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg>';
    rename.title = 'ویرایش عنوان'; rename.setAttribute('aria-label', `ویرایش عنوان ${chat.title}`);
    rename.disabled = Boolean(chat.deleting || chat.archiving || chat.renaming);
    rename.onclick = () => openRenameChat(chat.id);
    row.append(item, rename, remove); chatList.append(row);
  }
  if (!sorted.length) {
    const empty = document.createElement('p'); empty.className = 'chat-meta';
    empty.textContent = activeOnly ? 'گفتگوی فعالی در این فهرست نیست.' : 'گفتگویی در این فهرست نیست.';
    chatList.append(empty);
  }
}
function renderConsole() {
  const chat = getActiveChat();
  document.getElementById('usageChatName').textContent = chat.title;
  const usage = { ...createEmptyUsage(), ...(chat.usageSummary || {}) };
  const last = usage.last_usage || {};
  const available = !isProjectChat(chat) || chat.usageAvailable === true;

  usageSummary.innerHTML = '';
  const pills = [
    ['مجموع توکن‌های گفتگو', usage.total_input_tokens + usage.total_output_tokens],
    ['درخواست‌های ثبت‌شده', isProjectChat(chat) && !available ? null : usage.request_count],
    ['ورودی کل', usage.total_input_tokens],
    ['خروجی کل', usage.total_output_tokens],
    ['آخرین ورودی', last.input_tokens || 0],
    ['آخرین خروجی', last.output_tokens || 0],
    ['کش خوانده‌شده', usage.cache_read_input_tokens],
    ['کش ساخته‌شده', usage.cache_creation_input_tokens],
  ];

  for (const [label, value] of pills) {
    const pill = document.createElement('div');
    pill.className = 'usage-pill';
    pill.innerHTML = `<span>${label}</span><strong>${available && value != null ? formatNumber(value) : 'ثبت نشده'}</strong>`;
    usageSummary.append(pill);
  }
  const usageNote = document.createElement('p'); usageNote.className = 'usage-note';
  usageNote.textContent = isProjectChat(chat) ? (available ? 'مجموع ثبت‌شده برای تاریخچهٔ این گفتگو، شامل ورودی کش‌شده است. در سشن کپی‌شده ممکن است تاریخچهٔ مبدأ هم لحاظ شود؛ این عدد هزینهٔ مالی یا اندازهٔ context نیست.' : 'اطلاعات مصرف برای این تاریخچه در دسترس نیست؛ پس از دریافت اطلاعات از دستیار نمایش داده می‌شود.') : 'مجموع مصرف ثبت‌شدهٔ این گفتگو، شامل ورودی کش‌شده.';
  usageSummary.append(usageNote);

  statusConsole.innerHTML = '';
  if (!chat.statusLog.length) {
    const empty = document.createElement('div');
    empty.className = 'status-line muted';
    empty.textContent = 'هنوز فعالیتی ثبت نشده است.';
    statusConsole.append(empty);
    return;
  }

  for (const item of chat.statusLog.slice(-50).reverse()) {
    const line = document.createElement('div');
    line.className = `status-line ${item.type}`;
    const time = document.createElement('time');
    time.textContent = formatTime(item.at);
    const text = document.createElement('span');
    text.textContent = item.text;
    line.append(time, text);
    statusConsole.append(line);
  }
}

function renderAttachments() {
  attachmentTray.innerHTML = '';
  if (!pendingAttachments.length) return;
  pendingAttachments.forEach((attachment) => attachmentTray.append(createAttachmentChip(attachment, true)));
}

function syncComposerState() {
  const activeIsSending = sendingChatIds.has(activeChatId);
  const forkButton = document.getElementById('forkChatBtn');
  if (forkButton) forkButton.disabled = activeIsSending || Boolean(voiceSession || getActiveChat().forking || getActiveChat().deleting || getActiveChat().archiving);
  sendBtn.disabled = Boolean(voiceSession) || Boolean(getActiveChat().archiving || getActiveChat().deleting);
  messageInput.disabled = Boolean(getActiveChat().archiving || getActiveChat().deleting);
  sendBtn.textContent = activeIsSending ? 'افزودن به صف' : 'ارسال';
  renderMessageQueue();
  const codex = isProjectChat(getActiveChat());
  const webSearch = document.getElementById('webSearchLabel');
  if (webSearch) webSearch.hidden = codex;
  if (typeof syncClaudeModel === 'function') syncClaudeModel();
  if (typeof syncCodexApprovalMode === 'function') syncCodexApprovalMode();
  clearBtn.disabled = codex;
  clearBtn.hidden = codex;
  const archiveBtn = document.getElementById('archiveChatBtn');
  archiveBtn.hidden = !codex;
  archiveBtn.disabled = activeIsSending || Boolean(voiceSession) || Boolean(getActiveChat().archiving || getActiveChat().deleting);
  archiveBtn.textContent = getActiveChat().archived ? 'خارج کردن از آرشیو' : 'آرشیو گفتگو';
  document.getElementById('stopCodexBtn').hidden = !codex || !activeIsSending;
  document.getElementById('stopOpenAIBtn').hidden = codex || !activeIsSending;
}

function renderApp() {
  syncComposerState();
  renderChatList();
  renderMessages();
  renderConsole();
  renderAttachments();
  renderVoiceDraft();
  renderCodexRequests();
  updateCounter();
}

function switchChat(chatId) {
  if (voiceSession) { showToast('اول ضبط ویس را متوقف کن.'); return; }
  if (activeChatId) composerDrafts.set(activeChatId, messageInput.value);
  activeChatId = chatId;
  const opened = getChatById(chatId);
  if (opened) opened.unreadReply = false;
  chatStore.activeChatId = chatId;
  pendingAttachments = [];
  saveChatStore();
  messageInput.value = composerDrafts.get(chatId) || '';
  renderApp();
  messageInput.focus();
  if (isProjectChat(getActiveChat())) refreshCodexThread(chatId);
}

function deleteChat(chatId) {
  if (voiceSession) { showToast('اول ضبط ویس را متوقف کن.'); return; }
  const chat = chatStore.chats.find(c => c.id === chatId);
  if (!chat) return;
  if (sendingChatIds.has(chatId)) { showToast('اول صبر کن ارسال پیام تمام شود.'); return; }
  if (!window.confirm(`گفتگوی «${chat.title}» و تمام پیام‌هایش برای همیشه حذف شود؟ این کار قابل بازگشت نیست.`)) return;
  discardChatVoice(chatId);
  if (chatStore.chats.length === 1) {
    const replacement = createChat();
    chatStore.chats = [replacement];
    activeChatId = replacement.id;
  } else {
    chatStore.chats = chatStore.chats.filter((chat) => chat.id !== chatId);
    if (activeChatId === chatId) activeChatId = chatStore.chats[0].id;
  }
  chatStore.activeChatId = activeChatId;
  saveChatStore();
  renderApp();
  showToast('گفتگو حذف شد.');
}

function addNewChat() {
  if (voiceSession) { showToast('اول ضبط ویس را متوقف کن.'); return; }
  const chat = createChat();
  chatStore.chats.unshift(chat);
  activeChatId = chat.id;
  chatStore.activeChatId = chat.id;
  pendingAttachments = [];
  messageInput.value = '';
  saveChatStore();
  renderApp();
  messageInput.focus();
}

function setActiveSendingState(chatId, isSending) {
  if (isSending) sendingChatIds.add(chatId);
  else sendingChatIds.delete(chatId);

  if (chatId === activeChatId) {
    syncComposerState();
  }

  renderChatList();
  renderMessages();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',').pop());
    reader.onerror = () => reject(new Error('خواندن فایل ناموفق بود.'));
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  if (pendingAttachments.length + list.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    showToast(`حداکثر ${formatNumber(MAX_ATTACHMENTS_PER_MESSAGE)} فایل در هر پیام مجاز است.`);
    return;
  }

  for (const file of list) {
    try {
      setStatus('در حال آپلود فایل…');
      const base64 = await fileToBase64(file);
      const response = await fetch('/api/attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, type: file.type, size: file.size, data: base64 }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'آپلود فایل ناموفق بود.');
      pendingAttachments.push(data.attachment);
      addStatusLog(activeChatId, 'info', `فایل «${data.attachment.originalName}» آماده شد (${formatBytes(data.attachment.sizeBytes)}).`);
    } catch (error) {
      addStatusLog(activeChatId, 'error', `خطای فایل: ${error.message}`);
      showToast(error.message);
    }
  }

  renderAttachments();
  setStatus('Ready');
}

async function estimateTokens(chatId) {
  const chat = getChatById(chatId);
  if (!chat) return;
  try {
    const response = await fetch('/api/count-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chat.messages }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.inputTokens !== undefined) {
      addStatusLog(chatId, 'usage', `برآورد ورودی این درخواست: ${formatNumber(data.inputTokens)} توکن.`);
    }
  } catch {
    // Token estimate is helpful but not required for sending.
  }
}

async function sendMessage(job) {
  if (!job && isProjectChat(getActiveChat())) return sendCodexMessage();
  if (!job && voiceSession) { showToast('اول ضبط ویس را متوقف کن.'); return; }
  const voice = job ? job.voice : voiceDrafts.get(activeChatId);
  if (voice && (!voice.transcript || voice.error)) {
    showToast('متن ویس کامل نیست؛ ویس را حذف و دوباره ضبط کن.');
    return;
  }
  const typedText = job ? job.typedText : messageInput.value.trim();
  const text = [typedText, voice?.transcript].filter(Boolean).join('\n\n');
  if ((!text && !(job?.attachments || pendingAttachments).length) || sendingChatIds.has(job?.chatId || activeChatId)) {
    if (!text && !pendingAttachments.length) showToast('اول یک پیام بنویس یا فایل ضمیمه کن.');
    return;
  }

  const chatId = job?.chatId || activeChatId;
  const chat = getChatById(chatId);
  const attachments = job ? job.attachments : [...pendingAttachments];
  if (!job) pendingAttachments = [];

  const userMessage = {
    id: makeId('msg'),
    role: 'user',
    voiceId: voice?.id,
    content: text || 'لطفاً فایل ضمیمه‌شده را تحلیل کن.',
    attachmentIds: attachments.map((attachment) => attachment.id),
    attachments,
    createdAt: nowIso(),
  };

  if (voice && !job) voiceDrafts.delete(chatId);
  chat.messages.push(userMessage);
  updateTitleFromFirstMessage(chat);
  chat.updatedAt = nowIso();
  saveChatStore();

  if (!job) messageInput.value = '';
  renderApp();
  addStatusLog(chatId, 'info', 'پیام کاربر ثبت شد.');
  if (attachments.length) addStatusLog(chatId, 'info', `${formatNumber(attachments.length)} فایل به پیام اضافه شد.`);
  setActiveSendingState(chatId, true);
  const controller = new AbortController();
  openAIControllers.set(chatId, controller);
  addStatusLog(chatId, 'sending', 'درخواست به OpenAI ارسال شد.');

  if (chat.messages.length > 40) {
    addStatusLog(chatId, 'info', 'برای کنترل حجم، فقط ۴۰ پیام آخر به OpenAI ارسال می‌شود.');
  }
  estimateTokens(chatId);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, messages: chat.messages, projectContext: job?.projectContext || chat.projectContext || '', webSearch: Boolean(job?.webSearch || document.getElementById('webSearchToggle')?.checked) }),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'درخواست ناموفق بود.');

    const targetChat = getChatById(chatId);
    if (!targetChat) return;

    const assistantMessage = {
      id: makeId('msg'),
      role: 'assistant',
      content: data.reply || 'پاسخی دریافت نشد.',
      usage: data.usage || null,
      model: data.model || null,
      stopReason: data.stopReason || null,
      requestMs: data.requestMs || null,
      createdAt: nowIso(),
    };

    if (voice) {
      voice.sent = true;
      await voiceStorage('readwrite', store => store.put(voice)).catch(() => {});
    }
    targetChat.messages.push(assistantMessage);
    applyUsage(targetChat, data.usage);
    targetChat.updatedAt = nowIso();
    saveChatStore();

    addStatusLog(chatId, 'success', `پاسخ دریافت شد (${data.model || 'OpenAI'}، ${formatNumber(Math.round((data.requestMs || 0) / 1000))} ثانیه).`);
    if (data.usage) {
      addStatusLog(
        chatId,
        'usage',
        `مصرف آخرین پاسخ: ورودی ${formatNumber(data.usage.input_tokens || 0)}، خروجی ${formatNumber(data.usage.output_tokens || 0)}، کش ${formatNumber((data.usage.cache_read_input_tokens || 0) + (data.usage.cache_creation_input_tokens || 0))}.`,
      );
    }

    if (chatId !== activeChatId) { targetChat.unreadReply = true; showToast(`پاسخ «${targetChat.title}» آماده شد.`); }
  } catch (error) {
    const targetChat = getChatById(chatId);
    if (targetChat) {
      targetChat.messages = targetChat.messages.filter((message) => message.id !== userMessage.id);
      targetChat.updatedAt = nowIso();
      saveChatStore();
    }
    if (job && targetChat) requeueMessage(job);
    if (!job && voice && targetChat) voiceDrafts.set(chatId, voice);
    if (!job && chatId === activeChatId) {
      messageInput.value = typedText;
      pendingAttachments = attachments;
    }
    if (error.name === 'AbortError') addStatusLog(chatId, 'info', 'ارسال پاسخ متوقف شد.');
    else { addStatusLog(chatId, 'error', error.message || 'ارسال پیام ناموفق بود.'); showToast(error.message || 'ارسال پیام ناموفق بود.'); }
  } finally {
    openAIControllers.delete(chatId);
    setActiveSendingState(chatId, false);
    drainMessageQueue(chatId);
    renderApp();
    messageInput.focus();
  }
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitComposerMessage();
});

newChatBtn.addEventListener('click', () => openNewChatDialog());
document.getElementById('stopOpenAIBtn').addEventListener('click', () => openAIControllers.get(activeChatId)?.abort());
attachBtn.addEventListener('click', () => fileInput.click());
voiceBtn.addEventListener('click', toggleVoiceInput);
fileInput.addEventListener('change', () => {
  uploadFiles(fileInput.files);
  fileInput.value = '';
});

messageInput.addEventListener('input', () => {
  composerDrafts.set(activeChatId, messageInput.value);
  updateCounter();
});
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!event.repeat) submitComposerMessage();
  }
});

clearBtn.addEventListener('click', () => {
  if (voiceSession) { showToast('اول ضبط ویس را متوقف کن.'); return; }
  const chat = getActiveChat();
  if (isProjectChat(chat) || sendingChatIds.has(chat.id)) return;
  if (!window.confirm(`تمام پیام‌های گفتگوی «${chat.title}» پاک شوند؟ این کار قابل بازگشت نیست.`)) return;
  discardChatVoice(chat.id);
  chat.messages = [];
  chat.usageSummary = createEmptyUsage();
  chat.updatedAt = nowIso();
  addStatusLog(chat.id, 'info', 'پیام‌های این گفتگو پاک شد.');
  saveChatStore();
  renderApp();
});

clearConsoleBtn.addEventListener('click', () => {
  const chat = getActiveChat();
  chat.statusLog = [];
  chat.updatedAt = nowIso();
  saveChatStore();
  renderConsole();
});

const consoleDialog = document.getElementById('consoleDialog');
const appShell = document.getElementById('appShell');
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
function setSidebarCollapsed(collapsed) {
  appShell.classList.toggle('sidebar-collapsed', collapsed);
  toggleSidebarBtn.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'باز کردن لیست چت‌ها' : 'جمع کردن لیست چت‌ها';
  toggleSidebarBtn.setAttribute('aria-label', label);
  toggleSidebarBtn.title = label;
}
toggleSidebarBtn.addEventListener('click', () => {
  const collapsed = toggleSidebarBtn.getAttribute('aria-expanded') !== 'false';
  setSidebarCollapsed(collapsed);
  try { localStorage.setItem('persian-chat-sidebar-collapsed', String(collapsed)); } catch {}
});
try { setSidebarCollapsed(localStorage.getItem('persian-chat-sidebar-collapsed') === 'true'); } catch {}
document.getElementById('showConsoleBtn').addEventListener('click', () => {
  renderConsole();
  consoleDialog.showModal();
});
document.getElementById('closeConsoleBtn').addEventListener('click', () => consoleDialog.close());
consoleDialog.addEventListener('click', event => {
  if (event.target !== consoleDialog) return;
  const bounds = consoleDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) consoleDialog.close();
});
document.getElementById('chatSearch').addEventListener('input', renderChatList);
document.getElementById('sessionProviderFilter').addEventListener('change', renderChatList);
document.getElementById('projectContextBtn').onclick = () => {
  const chat = getActiveChat();
  document.getElementById('projectContextInput').value = chat.projectContext || '';
  document.getElementById('projectContextDialog').showModal();
};
document.getElementById('cancelProjectContextBtn').onclick = () => document.getElementById('projectContextDialog').close();
document.getElementById('projectContextForm').onsubmit = event => {
  event.preventDefault();
  const chat = getActiveChat();
  chat.projectContext = document.getElementById('projectContextInput').value.trim().slice(0, 12000);
  if (chatStore.chats.includes(chat)) saveChatStore();
  document.getElementById('projectContextDialog').close();
  renderChatList();
  showToast(chat.projectContext ? 'context پروژه ذخیره شد.' : 'context پروژه پاک شد.');
};
document.getElementById('showOutputBtn').onclick = () => {
  const chat = getActiveChat();
  const latest = [...(chat.messages || [])].reverse().find(message => message.role === 'assistant' && message.content);
  const content = latest?.content || '';
  const match = content.match(/```(?:[\w+-]+)?\s*([\s\S]*?)```/);
  document.getElementById('outputPreview').textContent = match?.[1]?.trim() || content.trim() || 'خروجی قابل نمایش وجود ندارد.';
  document.getElementById('outputDialog').showModal();
};
document.getElementById('closeOutputBtn').onclick = () => document.getElementById('outputDialog').close();

function setupComposerResize() {
  const handle = document.getElementById('composerResize');
  const card = document.querySelector('.chat-card');
  const toolbar = document.querySelector('.chat-toolbar');
  if (!handle || !card) return;
  const storageKey = 'persian-chat-composer-height-v1';
  const minimum = 40, maximum = 480;
  let preferred = minimum, drag = null;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= minimum) preferred = Math.min(maximum, saved);
  } catch { /* Resizing still works without storage. */ }
  const limit = () => {
    const chrome = chatForm.getBoundingClientRect().height - messageInput.getBoundingClientRect().height;
    return Math.max(minimum, Math.min(maximum, Math.floor(card.clientHeight * 0.6),
      card.clientHeight - (toolbar?.offsetHeight || 0) - chrome - 160));
  };
  const apply = () => {
    const max = limit();
    const height = Math.round(Math.min(max, Math.max(minimum, preferred)));
    const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 60;
    if (messageInput.style.height !== height + 'px') {
      messageInput.style.height = height + 'px';
      if (atBottom) requestAnimationFrame(() => { chatLog.scrollTop = chatLog.scrollHeight; });
    }
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(Math.floor(max)));
    handle.setAttribute('aria-valuenow', String(height));
    handle.setAttribute('aria-valuetext', height + ' پیکسل');
  };
  const save = () => {
    try { localStorage.setItem(storageKey, String(preferred)); } catch { /* Optional preference. */ }
  };
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    drag = { id: event.pointerId, y: event.clientY, height: messageInput.getBoundingClientRect().height, preferred };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('resizing');
    handle.focus();
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    preferred = Math.min(limit(), Math.max(minimum, drag.height + drag.y - event.clientY));
    apply();
  });
  const end = event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (event.type === 'pointercancel') { preferred = drag.preferred; apply(); }
    else save();
    const id = drag.id;
    drag = null;
    handle.classList.remove('resizing');
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('lostpointercapture', end);
  handle.addEventListener('keydown', event => {
    const current = messageInput.getBoundingClientRect().height;
    const values = { ArrowUp: current + 24, ArrowDown: current - 24, Home: minimum, End: limit() };
    if (!(event.key in values)) return;
    event.preventDefault();
    preferred = Math.min(limit(), Math.max(minimum, values[event.key]));
    apply(); save();
  });
  handle.addEventListener('dblclick', () => { preferred = minimum; apply(); save(); });
  window.addEventListener('resize', apply);
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(apply);
    observer.observe(card);
    observer.observe(chatForm);
  }
  apply();
}

// Transcript search and portable exports. Keep fetched histories out of storage.
function transcriptSearchText(value) {
  return String(value || '').normalize('NFKC').replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[\u064B-\u065F\u0670]/g, '').replace(/[\s\u200c]+/g, ' ').trim().toLocaleLowerCase();
}
function transcriptMatches(messages, query) {
  const needle = transcriptSearchText(query);
  if (!needle) return [];
  return messages.flatMap((message, index) => {
    const text = transcriptSearchText(message.content);
    const at = text.indexOf(needle);
    return at < 0 ? [] : [{ message, index, snippet: (at > 55 ? '…' : '') + text.slice(Math.max(0, at - 55), at + needle.length + 110) + (text.length > at + needle.length + 110 ? '…' : '') }];
  });
}
function transcriptExport(chat, messages, format) {
  const data = { version: 1, title: String(chat.title || 'گفتگو'), provider: chat.source || 'openai', exportedAt: new Date().toISOString(),
    messages: messages.map(message => ({ role: message.role, content: String(message.content || ''),
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
      attachments: (message.attachments || []).map(file => ({ name: String(file.originalName || file.name || 'ضمیمه') })),
      ...(message.voiceId ? { voice: 'Audio not included' } : {}) })) };
  const escape = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const role = message => message.role === 'user' ? 'شما' : message.role === 'assistant' ? data.provider : message.role;
  const attachments = message => message.attachments.length ? '\n\nضمیمه‌ها: ' + message.attachments.map(file => file.name).join('، ') : '';
  if (format === 'json') return { text: JSON.stringify(data, null, 2), extension: 'json', type: 'application/json' };
  if (format === 'markdown') return { text: '# ' + data.title.replace(/[\r\n]/g, ' ') + '\n\n' + data.messages.map(message => '## ' + role(message) + '\n\n' + message.content + attachments(message)).join('\n\n---\n\n') + '\n', extension: 'md', type: 'text/markdown' };
  if (format !== 'html') throw new Error('فرمت خروجی نامعتبر است.');
  return { extension: 'html', type: 'text/html', text: '<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>' + escape(data.title) + '</title><style>body{font:16px/1.8 system-ui;max-width:900px;margin:32px auto;padding:16px}article{border:1px solid #ccc;border-radius:12px;padding:16px;margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}h2{font-size:16px}</style></head><body><h1>' + escape(data.title) + '</h1>' + data.messages.map(message => '<article><h2>' + escape(role(message)) + '</h2><pre dir="auto">' + escape(message.content + attachments(message)) + '</pre></article>').join('') + '</body></html>' };
}
async function readTranscript(chat) {
  if (!isProjectChat(chat)) return { ...chat, messages: structuredClone(chat.messages) };
  const data = await projectApi(chat, '/threads/' + encodeURIComponent(chat.threadId));
  if (!Array.isArray(data.messages)) throw new Error('تاریخچهٔ گفتگو دریافت نشد.');
  return { ...chat, title: data.title || chat.title, messages: data.messages };
}
function setupTranscriptTools() {
  const searchDialog = document.getElementById('messageSearchDialog');
  const exportDialog = document.getElementById('exportChatDialog');
  const status = document.getElementById('messageSearchStatus');
  const results = document.getElementById('messageSearchResults');
  let generation = 0, searchChat = null, exportChat = null;
  document.getElementById('searchMessagesBtn').onclick = () => {
    searchChat = getActiveChat(); results.replaceChildren(); status.textContent = '';
    searchDialog.showModal(); document.getElementById('messageSearchQuery').focus();
  };
  document.getElementById('closeMessageSearch').onclick = () => searchDialog.close();
  searchDialog.addEventListener('close', () => { generation++; });
  document.getElementById('messageSearchForm').onsubmit = async event => {
    event.preventDefault();
    const query = document.getElementById('messageSearchQuery').value;
    if (!transcriptSearchText(query)) return;
    const run = ++generation;
    results.replaceChildren(); status.textContent = 'در حال خواندن تاریخچه‌ها…';
    let failed = 0, scanned = 0, count = 0;
    const chats = [];
    const all = document.getElementById('messageSearchScope').value === 'all';
    const includeArchived = document.getElementById('messageSearchArchived').checked;
    if (!all) chats.push(searchChat);
    else {
      chats.push(...chatStore.chats.filter(chat => includeArchived || !chat.archived));
      await Promise.all(['codex', 'claude'].map(async source => {
        for (const archived of includeArchived ? [false, true] : [false]) {
          try {
            let cursor = null;
            do {
              if (run !== generation) return;
              const params = new URLSearchParams({ archived: String(archived) });
              if (cursor) params.set('cursor', cursor);
              const data = await codexApi('/threads?' + params, undefined, source);
              chats.push(...data.threads.map(thread => ({ ...thread, id: source + '_' + thread.id, threadId: thread.id, source, archived })));
              cursor = data.nextCursor;
            } while (cursor);
          } catch { failed++; }
        }
      }));
    }
    const pending = [...new Map(chats.filter(Boolean).map(chat => [chat.id, chat])).values()];
    const total = pending.length;
    const report = () => { status.textContent = `${formatNumber(count)} پیام پیدا شد · ${formatNumber(scanned)} از ${formatNumber(total)} گفتگو بررسی شد${failed ? ` · ${formatNumber(failed)} خطا؛ نتیجه‌ها ناقص‌اند، دوباره تلاش کن.` : ''}${count > 300 ? ' · فقط ۳۰۰ نتیجهٔ اول نمایش داده می‌شود؛ عبارت را دقیق‌تر کن.' : ''}`; };
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (pending.length && run === generation) {
        const chat = pending.shift();
        try {
          const transcript = await readTranscript(chat);
          if (run !== generation) return;
          for (const hit of transcriptMatches(transcript.messages, query)) {
            count++;
            if (count > 300) continue;
            const button = document.createElement('button'); button.type = 'button'; button.className = 'transcript-search-hit ghost';
            const title = document.createElement('strong'); title.textContent = `${transcript.title} · ${hit.message.role === 'user' ? 'شما' : transcript.source || 'OpenAI'} · پیام ${formatNumber(hit.index + 1)}`;
            const snippet = document.createElement('span'); snippet.dir = 'auto'; snippet.textContent = hit.snippet;
            button.append(title, snippet);
            button.onclick = () => {
              if (voiceSession) { showToast('اول ضبط ویس را متوقف کن.'); return; }
              let target = getChatById(chat.id);
              if (!target && isProjectChat(chat)) {
                target = Object.assign(normalizeChat(transcript), { source: chat.source, threadId: chat.threadId, archived: chat.archived, cwd: chat.cwd, general: chat.general }); codexChats.push(target);
              }
              if (!target) { showToast('این گفتگو دیگر در دسترس نیست.'); return; }
              if (isProjectChat(target)) { target.messages = transcript.messages; target.loaded = true; }
              searchDialog.close(); switchChat(target.id);
              const index = hit.message.id ? target.messages.findIndex(message => message.id === hit.message.id) : hit.index;
              const element = chatLog.querySelectorAll('.message:not(.pending)')[index];
              if (element) { element.classList.add('search-target'); element.tabIndex = -1; element.focus({ preventScroll: true }); element.scrollIntoView({ block: 'center', behavior: 'instant' }); }
              else showToast('پیام تغییر کرده است؛ دوباره جست‌وجو کن.');
            };
            results.append(button);
          }
        } catch { failed++; }
        if (run !== generation) return;
        scanned++; report();
      }
    }));
    if (run === generation) report();
  };
  document.getElementById('exportChatBtn').onclick = () => {
    exportChat = getActiveChat(); document.getElementById('exportChatName').textContent = exportChat.title;
    document.getElementById('exportChatStatus').textContent = ''; exportDialog.showModal();
  };
  document.getElementById('closeExportChat').onclick = () => exportDialog.close();
  document.getElementById('downloadChatBtn').onclick = async () => {
    const button = document.getElementById('downloadChatBtn'); const info = document.getElementById('exportChatStatus');
    const chat = exportChat, format = document.getElementById('exportChatFormat').value;
    button.disabled = true; info.textContent = 'در حال دریافت متن گفتگو…';
    try {
      const transcript = await readTranscript(chat);
      const output = transcriptExport(transcript, transcript.messages, format);
      const blob = new Blob([output.text], { type: output.type + ';charset=utf-8' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = 'chat-' + String(transcript.title || 'export').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 70) + '.' + output.extension;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      info.textContent = `${formatNumber(transcript.messages.length)} پیام برای دانلود آماده شد.`;
    } catch (error) { info.textContent = 'دانلود انجام نشد: ' + error.message; }
    finally { button.disabled = false; }
  };
}

let renamingChatId = null;
function openRenameChat(chatId) {
  const chat = getChatById(chatId);
  if (!chat || chat.deleting || chat.archiving) return;
  renamingChatId = chatId;
  const input = document.getElementById('renameChatInput'); input.value = chat.title;
  document.getElementById('renameChatError').textContent = '';
  document.getElementById('renameChatDialog').showModal(); input.focus(); input.select();
}
function setupRenameChat() {
  const dialog = document.getElementById('renameChatDialog');
  const save = document.getElementById('saveRenameChat');
  const close = () => { if (!save.disabled) dialog.close(); };
  document.getElementById('closeRenameChat').onclick = close;
  document.getElementById('cancelRenameChat').onclick = close;
  dialog.addEventListener('cancel', event => { if (save.disabled) event.preventDefault(); });
  document.getElementById('renameChatForm').onsubmit = async event => {
    event.preventDefault();
    const chat = getChatById(renamingChatId);
    const title = document.getElementById('renameChatInput').value.trim();
    const error = document.getElementById('renameChatError');
    if (!chat || save.disabled) return;
    if (!title || title.length > 120 || /[\r\n\x00-\x1f]/.test(title)) { error.textContent = 'عنوان باید بین ۱ تا ۱۲۰ نویسه و در یک خط باشد.'; return; }
    save.disabled = true; chat.renaming = true; error.textContent = ''; save.textContent = 'در حال ذخیره…';
    const oldTitle = chat.title, oldCustom = chat.customTitle;
    try {
      if (isProjectChat(chat)) await projectApi(chat, '/threads/' + encodeURIComponent(chat.threadId) + '/title', { title });
      chat.title = title; chat.customTitle = true;
      if (!isProjectChat(chat)) {
        try { saveChatStore(); } catch (failure) { chat.title = oldTitle; chat.customTitle = oldCustom; throw failure; }
      }
      renderChatList(); if (activeChatId === chat.id) activeChatTitle.textContent = title;
      dialog.close(); showToast('عنوان گفتگو ذخیره شد.');
    } catch (failure) { error.textContent = 'ذخیره نشد: ' + failure.message; }
    finally { save.disabled = false; chat.renaming = false; save.textContent = 'ذخیرهٔ عنوان'; renderChatList(); }
  };
}

function setupForkChat() {
  const dialog = document.getElementById('forkChatDialog'), submit = document.getElementById('createForkChat');
  let sourceId;
  document.getElementById('forkChatBtn').onclick = () => {
    const chat = getActiveChat();
    if (voiceSession || sendingChatIds.has(chat.id) || chat.forking) return;
    sourceId = chat.id;
    document.getElementById('forkChatName').value = ('کپی — ' + chat.title).slice(0, 120);
    document.getElementById('forkChatError').textContent = '';
    const model = document.getElementById('forkChatModel'); model.replaceChildren();
    document.getElementById('forkModelLabel').hidden = !isProjectChat(chat);
    for (const entry of [{ value: '', displayName: 'پیش‌فرض سشن' }, ...(providerModels[chat.source] || [])]) {
      const option = document.createElement('option'); option.value = entry.value; option.textContent = entry.displayName || entry.value; model.append(option);
    }
    model.value = chat.model || ''; if (model.selectedIndex < 0) model.value = '';
    dialog.showModal(); document.getElementById('forkChatName').focus();
  };
  const close = () => { if (!submit.disabled) dialog.close(); };
  document.getElementById('cancelForkChat').onclick = close; document.getElementById('closeForkChat').onclick = close;
  dialog.addEventListener('cancel', event => { if (submit.disabled) event.preventDefault(); });
  document.getElementById('forkChatForm').onsubmit = async event => {
    event.preventDefault();
    const original = getChatById(sourceId), error = document.getElementById('forkChatError');
    if (!original || submit.disabled) return;
    if (voiceSession || sendingChatIds.has(sourceId) || original.deleting || original.archiving) { error.textContent = 'ابتدا صبر کن کار این گفتگو تمام شود.'; return; }
    const title = document.getElementById('forkChatName').value.trim(), model = document.getElementById('forkChatModel').value;
    if (!title || title.length > 120 || /[\r\n\x00-\x1f]/.test(title)) { error.textContent = 'یک عنوان معتبر تا ۱۲۰ نویسه وارد کن.'; return; }
    submit.disabled = true; original.forking = true; error.textContent = ''; submit.textContent = 'در حال ساخت…';
    try {
      let copy, warning;
      if (isProjectChat(original)) {
        const result = await projectApi(original, '/threads/' + encodeURIComponent(original.threadId) + '/fork', { title, model });
        const thread = result.thread; warning = result.warning;
        copy = Object.assign(normalizeChat({ ...thread, id: original.source + '_' + thread.id }), { source: original.source, threadId: thread.id, cwd: thread.cwd, general: thread.general, model, projectContext: original.projectContext || '', archived: false });
        codexChats.push(copy);
        // Keep the selected policy scoped to the new session, without copying pending requests or jobs.
        codexApprovalModes[copy.source + ':' + copy.threadId] = desiredApprovalMode(original);
        try { localStorage.setItem(CODEX_APPROVAL_MODES_KEY, JSON.stringify(codexApprovalModes)); } catch { warning = 'کپی ساخته شد، اما ذخیرهٔ تنظیمات مرورگر ناموفق بود.'; }
      } else {
        copy = createChat(title); copy.customTitle = true; copy.projectContext = original.projectContext || '';
        copy.usageSummary = structuredClone(original.usageSummary);
        copy.messages = structuredClone(original.messages).map(message => ({ ...message, id: makeId('msg') }));
        chatStore.chats.unshift(copy);
        try { saveChatStore(); } catch (failure) { chatStore.chats.splice(chatStore.chats.indexOf(copy), 1); throw failure; }
      }
      dialog.close(); switchChat(copy.id); showToast(warning || 'کپی آماده است؛ پیام بعدی را در گفتگوی جدید بفرست.');
    } catch (failure) { error.textContent = 'ساخت کپی ناموفق بود: ' + failure.message; }
    finally { original.forking = false; submit.disabled = false; submit.textContent = 'ساخت کپی'; syncComposerState(); }
  };
}

restoreMessageQueues();
setupVoiceInput();
renderApp();
setupCodexSessions();
if (typeof setupClaudeSessions === 'function') setupClaudeSessions();

setupComposerResize();
setupTranscriptTools();
setupRenameChat();
setupForkChat();
