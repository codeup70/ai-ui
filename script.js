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
function renderMessageQueue() {
  renderActiveChats();
  const panel = document.getElementById('messageQueue');
  panel.replaceChildren();
  const queue = messageQueues.get(activeChatId) || [];
  if (!queue.length) return;
  if (pausedQueues.has(activeChatId)) {
    const resume = document.createElement('button');
    resume.type = 'button'; resume.textContent = 'ادامهٔ صف';
    resume.onclick = () => { pausedQueues.delete(activeChatId); drainMessageQueue(activeChatId); };
    panel.append(resume);
  }
  queue.forEach((job, index) => {
    const row = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = `${index + 1}. ${job.typedText || job.voice?.transcript || 'فایل ضمیمه'}${job.failed ? ' — ارسال ناموفق؛ صف متوقف است' : ' — در صف'}`;
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'لغو';
    cancel.onclick = () => { queue.splice(queue.indexOf(job), 1); renderMessageQueue(); };
    row.append(label, cancel); panel.append(row);
  });
}
function drainMessageQueue(chatId) {
  if (sendingChatIds.has(chatId) || pausedQueues.has(chatId)) return;
  const chat = getChatById(chatId);
  if (!chat || chat.submitting || chat.archiving || chat.deleting) return;
  const job = messageQueues.get(chatId)?.shift();
  if (!job) return;
  renderMessageQueue();
  if (isProjectChat(chat)) sendCodexMessage(job);
  else sendMessage(job);
}
function requeueMessage(job) {
  job.failed = true;
  const queue = messageQueues.get(job.chatId) || [];
  queue.unshift(job); messageQueues.set(job.chatId, queue);
  pausedQueues.add(job.chatId); renderMessageQueue();
}
function submitComposerMessage() {
  if (voiceSession) return;
  const chat = getActiveChat();
  if (chat.archiving || chat.deleting) return;
  const voice = voiceDrafts.get(chat.id);
  if (voice && (!voice.transcript || voice.error)) { showToast('متن ویس کامل نیست.'); return; }
  const typedText = messageInput.value.trim();
  if (!typedText && !voice && !pendingAttachments.length) return;
  const job = { chatId: chat.id, typedText, voice, attachments: [...pendingAttachments], model: chat.model || '' };
  const queue = messageQueues.get(chat.id) || [];
  queue.push(job); messageQueues.set(chat.id, queue);
  messageInput.value = ''; pendingAttachments = []; voiceDrafts.delete(chat.id);
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
    usageSummary: createEmptyUsage(),
    statusLog: [{ at: createdAt, type: 'info', text: 'گفتگوی تازه ساخته شد.' }],
  };
}

function normalizeChat(chat) {
  return {
    id: chat.id || makeId('chat'),
    title: chat.title || 'گفتگوی تازه',
    createdAt: chat.createdAt || nowIso(),
    updatedAt: chat.updatedAt || chat.createdAt || nowIso(),
    messages: Array.isArray(chat.messages) ? chat.messages : [],
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
  if (!chat || chat.title !== 'گفتگوی تازه') return;
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
  const sorted = [...chatStore.chats, ...codexChats]
    .filter(chat => Boolean(chat.archived) === Boolean(archived) && (!activeOnly || isActiveConversation(chat)))
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
    row.append(item, remove); chatList.append(row);
  }
  if (!sorted.length) {
    const empty = document.createElement('p'); empty.className = 'chat-meta';
    empty.textContent = activeOnly ? 'گفتگوی فعالی در این فهرست نیست.' : 'گفتگویی در این فهرست نیست.';
    chatList.append(empty);
  }
}
function renderConsole() {
  const chat = getActiveChat();
  const usage = { ...createEmptyUsage(), ...(chat.usageSummary || {}) };
  const last = usage.last_usage || {};

  usageSummary.innerHTML = '';
  const pills = [
    ['درخواست‌ها', usage.request_count],
    ['ورودی کل', usage.total_input_tokens],
    ['خروجی کل', usage.total_output_tokens],
    ['آخرین ورودی', last.input_tokens || 0],
    ['آخرین خروجی', last.output_tokens || 0],
    ['کش خوانده‌شده', usage.cache_read_input_tokens],
  ];

  for (const [label, value] of pills) {
    const pill = document.createElement('div');
    pill.className = 'usage-pill';
    pill.innerHTML = `<span>${label}</span><strong>${formatNumber(value)}</strong>`;
    usageSummary.append(pill);
  }

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
  sendBtn.disabled = Boolean(voiceSession) || Boolean(getActiveChat().archiving || getActiveChat().deleting);
  messageInput.disabled = Boolean(getActiveChat().archiving || getActiveChat().deleting);
  sendBtn.textContent = activeIsSending ? 'افزودن به صف' : 'ارسال';
  renderMessageQueue();
  const codex = isProjectChat(getActiveChat());
  if (typeof syncClaudeModel === 'function') syncClaudeModel();
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
  activeChatId = chatId;
  const opened = getChatById(chatId);
  if (opened) opened.unreadReply = false;
  chatStore.activeChatId = chatId;
  pendingAttachments = [];
  saveChatStore();
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
      body: JSON.stringify({ chatId, messages: chat.messages }),
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

messageInput.addEventListener('input', updateCounter);
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
setupVoiceInput();
renderApp();
setupCodexSessions();
if (typeof setupClaudeSessions === 'function') setupClaudeSessions();
