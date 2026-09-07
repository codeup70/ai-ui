const codexChats = [];
const codexVoiceClips = new Map();
let codexRefreshing = false;
const codexThreadRefreshes = new Set();
let codexRequestSignature = '';
let codexListVersion = 0;

async function codexApi(url, body) {
  const response = await fetch('/api/codex' + url, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    if (response.status === 404) throw new Error('سرور هنوز نسخهٔ قبلی را اجرا می‌کند؛ سرور پروژه را دوباره راه‌اندازی کن و صفحه را تازه کن.');
    throw new Error(`پاسخ سرور نامعتبر است (کد ${response.status}).`);
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'ارتباط با Codex ناموفق بود.');
  return data;
}
function renderCodexList(container) {
  const projects = new Map();
  for (const chat of codexChats) {
    if (chat.archived !== document.getElementById('archivedSessions').checked) continue;
    if (!projects.has(chat.cwd)) projects.set(chat.cwd, []);
    projects.get(chat.cwd).push(chat);
  }
  for (const [cwd, chats] of projects) {
    const heading = document.createElement('div');
    heading.className = 'project-heading';
    heading.textContent = cwd.split(/[\\/]/).filter(Boolean).pop() || 'Codex';
    heading.title = cwd;
    container.append(heading);
    for (const chat of chats) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `chat-list-item ${chat.id === activeChatId ? 'active' : ''}`;
      const title = document.createElement('strong');
      title.className = 'chat-title';
      title.textContent = chat.title;
      const meta = document.createElement('span');
      meta.className = 'chat-meta';
      meta.textContent = sendingChatIds.has(chat.id) ? 'Codex در حال کار…' : formatTime(chat.updatedAt);
      button.append(title, meta);
      button.onclick = () => switchChat(chat.id);
      const row = document.createElement('div');
      row.className = 'session-row';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ghost session-delete';
      remove.textContent = 'حذف';
      remove.setAttribute('aria-label', `حذف گفتگوی ${chat.title}`);
      remove.disabled = Boolean(chat.deleting || chat.archiving || voiceSession || sendingChatIds.has(chat.id));
      remove.onclick = () => deleteCodexChat(chat.id);
      row.append(button, remove);
      container.append(row);
    }
  }
  const heading = document.createElement('div');
  heading.className = 'project-heading';
  heading.textContent = 'گفتگوهای عادی';
  container.append(heading);
}
async function refreshCodexSessions() {
  if (codexRefreshing) return;
  codexRefreshing = true;
  const version = codexListVersion;
  const status = document.getElementById('sessionsStatus');
  status.textContent = 'در حال دریافت سشن‌ها…';
  try {
    const records = [];
    let cursor = null;
    const archived = document.getElementById('archivedSessions').checked;
    do {
      const params = new URLSearchParams({ archived: String(archived) });
      if (cursor) params.set('cursor', cursor);
      const data = await codexApi('/threads?' + params);
      records.push(...data.threads);
      cursor = data.nextCursor;
    } while (cursor);
    if (version !== codexListVersion) return;
    const next = records.map(thread => {
      const id = 'codex_' + thread.id;
      const existing = codexChats.find(chat => chat.id === id);
      return Object.assign(existing || normalizeChat({ ...thread, id }), { title: thread.title, cwd: thread.cwd,
        updatedAt: thread.updatedAt, source: 'codex', threadId: thread.id, archived });
    });
    // Keep an open thread available if the list filter changes.
    const active = codexChats.find(chat => chat.id === activeChatId);
    if (active && !next.some(chat => chat.id === active.id)) next.push(active);
    codexChats.splice(0, codexChats.length, ...next);
    renderChatList();
    status.textContent = `${formatNumber(records.length)} سشن Codex`;
  } catch (error) { status.textContent = error.message; }
  finally {
    codexRefreshing = false;
    if (version !== codexListVersion) refreshCodexSessions();
  }
}
async function toggleCodexArchive() {
  const chat = getActiveChat();
  if (chat.source !== 'codex' || chat.archiving || chat.deleting || voiceSession || sendingChatIds.has(chat.id)) return;
  const archived = !chat.archived;
  chat.archiving = true;
  syncComposerState();
  try {
    await codexApi(`/threads/${encodeURIComponent(chat.threadId)}/archive`, { archived });
    codexListVersion++;
    chat.archived = archived;
    // Keep the opened history available, but remove it from the opposite list.
    renderChatList();
    await refreshCodexSessions();
    showToast(archived ? 'گفتگو آرشیو شد؛ از «آرشیوشده‌ها» قابل بازیابی است.' : 'گفتگو از آرشیو خارج شد.');
  } catch (error) { showToast(error.message); }
  finally { chat.archiving = false; syncComposerState(); }
}
async function deleteCodexChat(chatId) {
  const chat = codexChats.find(c => c.id === chatId);
  if (!chat || chat.deleting || chat.archiving || voiceSession || sendingChatIds.has(chatId)) return;
  if (!window.confirm(`گفتگوی «${chat.title}» در پروژهٔ\n${chat.cwd}\n\nبرای همیشه حذف شود؟ تاریخچهٔ این سشن و سشن‌های فرزندِ ساخته‌شده توسط آن حذف می‌شوند و قابل بازیابی نیستند.\nبرای نگهداری تاریخچه، لغو کن و از آرشیو استفاده کن.`)) return;
  chat.deleting = true;
  syncComposerState();
  renderChatList();
  try {
    await codexApi(`/threads/${encodeURIComponent(chat.threadId)}/delete`, { confirmedThreadId: chat.threadId });
    codexListVersion++;
    codexChats.splice(codexChats.indexOf(chat), 1);
    discardChatVoice(chat.id);
    if (activeChatId === chat.id) {
      messageInput.value = '';
      switchChat(chatStore.chats[0].id);
    }
    await refreshCodexSessions();
    renderChatList();
    showToast('گفتگو حذف شد.');
  } catch (error) { showToast(error.message); }
  finally { chat.deleting = false; syncComposerState(); renderChatList(); }
}
async function refreshCodexThread(chatId) {
  const chat = codexChats.find(chat => chat.id === chatId);
  if (!chat || codexThreadRefreshes.has(chatId)) return;
  codexThreadRefreshes.add(chatId);
  try {
    const data = await codexApi('/threads/' + encodeURIComponent(chat.threadId));
    for (const clip of codexVoiceClips.values()) {
      if (clip.threadId !== chat.threadId) continue;
      const message = clip.messageId ? data.messages.find(m => m.id === clip.messageId) : [...data.messages].reverse().find(m => m.role === 'user' && m.content === clip.prompt);
      if (message) {
        message.voiceId = clip.id;
        if (!clip.messageId) {
          clip.messageId = message.id;
          voiceStorage('readwrite', store => store.put(clip)).catch(() => {});
        }
      }
    }
    const changed = JSON.stringify(chat.messages) !== JSON.stringify(data.messages);
    chat.messages = data.messages;
    chat.title = data.title;
    chat.cwd = data.cwd;
    chat.updatedAt = data.updatedAt;
    chat.requests = data.requests;
    chat.statusLog = data.activity.map(item => ({ at: data.updatedAt, type: item.status === 'failed' ? 'error' : 'info', text: `${item.text || ''}\n${item.output || ''}`.trim() }));
    if (data.error) chat.statusLog.push({ at: nowIso(), type: 'error', text: data.error });
    if (data.usage?.total) {
      chat.usageSummary.total_input_tokens = data.usage.total.inputTokens || 0;
      chat.usageSummary.total_output_tokens = data.usage.total.outputTokens || 0;
    }
    if (data.running) sendingChatIds.add(chatId);
    else if (!chat.submitting) sendingChatIds.delete(chatId);
    if (chatId === activeChatId) {
      const wasNearBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 100;
      const scrollTop = chatLog.scrollTop;
      if (changed || !chat.loaded) {
        renderMessages();
        if (chat.loaded && !wasNearBottom) chatLog.scrollTop = scrollTop;
      }
      chat.loaded = true;
      syncComposerState();
      renderConsole();
      renderCodexRequests();
      setStatus(data.running ? 'Codex در حال کار روی پروژه…' : data.error || 'آمادهٔ ادامهٔ این سشن');
    }
    renderChatList();
  } catch (error) {
    if (chatId === activeChatId) setStatus(error.message);
  } finally { codexThreadRefreshes.delete(chatId); }
}

function renderCodexRequests() {
  const panel = document.getElementById('codexRequests');
  const chat = getActiveChat();
  const requests = chat.source === 'codex' ? chat.requests || [] : [];
  const signature = chat.id + JSON.stringify(requests);
  if (signature === codexRequestSignature) return;
  codexRequestSignature = signature;
  panel.replaceChildren();
  for (const request of requests) {
    const box = document.createElement('div');
    box.className = 'codex-request';
    const title = document.createElement('strong');
    title.textContent = request.method === 'item/tool/requestUserInput' ? 'سؤال Codex' : 'Codex به اجازهٔ شما نیاز دارد';
    box.append(title);
    const details = document.createElement('pre');
    details.textContent = [request.reason, request.command, request.cwd, request.grantRoot,
      request.permissions ? JSON.stringify(request.permissions, null, 2) : '',
      ...(request.changes || []).map(change => `${change.path}\n${change.diff || ''}`)].filter(Boolean).join('\n');
    box.append(details);
    const fields = [];
    for (const question of request.questions) {
      const label = document.createElement('label');
      label.textContent = question.question;
      const input = document.createElement('input');
      input.type = question.isSecret ? 'password' : 'text';
      if (question.options?.length) input.placeholder = question.options.map(option => option.label).join(' / ');
      label.append(input);
      box.append(label);
      fields.push({ id: question.id, input });
    }
    const answer = async body => {
      try {
        await codexApi(`/threads/${encodeURIComponent(chat.threadId)}/requests/${encodeURIComponent(request.id)}`, body);
        await refreshCodexThread(chat.id);
      } catch (error) { showToast(error.message); }
    };
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.textContent = fields.length ? 'ارسال پاسخ' : 'اجازه بده';
    accept.onclick = () => answer(fields.length ? { answers: Object.fromEntries(fields.map(f => [f.id, f.input.value])) } : { decision: 'accept' });
    box.append(accept);
    if (!fields.length) {
      const decline = document.createElement('button');
      decline.type = 'button'; decline.className = 'ghost'; decline.textContent = 'رد درخواست';
      decline.onclick = () => answer({ decision: 'decline' });
      box.append(decline);
    }
    panel.append(box);
  }
}
async function sendCodexMessage() {
  if (voiceSession || sendingChatIds.has(activeChatId)) return;
  const chat = getActiveChat();
  if (chat.archiving || chat.deleting) return;
  const voice = voiceDrafts.get(chat.id);
  if (voice && (!voice.transcript || voice.error)) { showToast('متن ویس کامل نیست؛ دوباره ضبط کن.'); return; }
  const typed = messageInput.value.trim();
  const text = [typed, voice?.transcript].filter(Boolean).join('\n\n');
  if (!text && !pendingAttachments.length) return;
  chat.submitting = true;
  sendingChatIds.add(chat.id);
  syncComposerState();
  try {
    await codexApi(`/threads/${encodeURIComponent(chat.threadId)}/turns`, { text, attachmentIds: pendingAttachments.map(a => a.id) });
    if (chat.archived) { chat.archived = false; codexListVersion++; refreshCodexSessions(); }
    if (activeChatId === chat.id) { messageInput.value = ''; pendingAttachments = []; }
    if (voice) {
      voiceDrafts.delete(chat.id);
      voice.sent = true;
      voice.threadId = chat.threadId;
      voice.prompt = text;
      codexVoiceClips.set(voice.id, voice);
      await voiceStorage('readwrite', store => store.put(voice)).catch(() => {});
    }
    chat.loaded = false;
    await refreshCodexThread(chat.id);
  } catch (error) {
    sendingChatIds.delete(chat.id);
    showToast(error.message);
  } finally {
    chat.submitting = false;
    syncComposerState();
    renderAttachments();
    renderVoiceDraft();
    updateCounter();
  }
}
function setupCodexSessions() {
  document.getElementById('archiveChatBtn').onclick = toggleCodexArchive;
  document.getElementById('refreshSessionsBtn').onclick = refreshCodexSessions;
  document.getElementById('archivedSessions').onchange = () => { codexListVersion++; refreshCodexSessions(); };
  document.getElementById('stopCodexBtn').onclick = async () => {
    const chat = getActiveChat();
    try { await codexApi(`/threads/${encodeURIComponent(chat.threadId)}/interrupt`, {}); await refreshCodexThread(chat.id); }
    catch (error) { showToast(error.message); }
  };
  const previous = localStorage.getItem('persian-chat-active-session');
  const initial = activeChatId;
  refreshCodexSessions().then(() => {
    if (activeChatId === initial && codexChats.some(chat => chat.id === previous)) switchChat(previous);
  });
  setInterval(() => {
    for (const chat of codexChats) if (chat.id === activeChatId || sendingChatIds.has(chat.id)) refreshCodexThread(chat.id);
  }, 2000);
  setInterval(refreshCodexSessions, 30000);
}
