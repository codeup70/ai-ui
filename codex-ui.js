const codexChats = [];
const codexVoiceClips = new Map();
const CODEX_APPROVAL_MODES_KEY = 'persian-approval-modes-v2';
let codexApprovalModes = {};
try { codexApprovalModes = JSON.parse(localStorage.getItem(CODEX_APPROVAL_MODES_KEY) || '{}'); } catch { codexApprovalModes = {}; }
const codexApprovalSyncing = new Set();
let codexRefreshing = false;
const codexThreadRefreshes = new Set();
let codexRequestSignature = '';
let codexListVersion = 0;

function isProjectChat(chat) { return chat?.source === 'codex' || chat?.source === 'claude'; }
function agentName(chat) { return chat?.source === 'claude' ? 'Claude' : 'Codex'; }
function projectApi(chat, url, body) { return codexApi(url, body, chat.source); }
function syncCodexApprovalMode() {
  const chat = getActiveChat();
  const label = document.getElementById('codexApprovalLabel');
  const select = document.getElementById('codexApprovalMode');
  if (!label || !select) return;
  const visible = isProjectChat(chat);
  label.hidden = !visible;
  if (visible) select.value = codexApprovalModes[`${chat.source}:${chat.threadId}`] || 'ask';
}
async function ensureCodexApprovalMode(chat) {
  if (!chat || !isProjectChat(chat) || !chat.threadId || codexApprovalSyncing.has(`${chat.source}:${chat.threadId}`)) return;
  const key = `${chat.source}:${chat.threadId}`;
  const desired = codexApprovalModes[key];
  if (!desired) return;
  codexApprovalSyncing.add(key);
  try {
    const current = await projectApi(chat, `/threads/${encodeURIComponent(chat.threadId)}/approval-mode`);
    if (current.mode !== desired) await projectApi(chat, `/threads/${encodeURIComponent(chat.threadId)}/approval-mode`, { mode: desired });
  } catch { /* Older servers keep the manual mode; sending remains safe. */ }
  finally { codexApprovalSyncing.delete(key); }
}
async function changeCodexApprovalMode(mode) {
  const chat = getActiveChat();
  if (!chat || !isProjectChat(chat)) return;
  try {
    await projectApi(chat, `/threads/${encodeURIComponent(chat.threadId)}/approval-mode`, { mode });
    codexApprovalModes[`${chat.source}:${chat.threadId}`] = mode;
    localStorage.setItem(CODEX_APPROVAL_MODES_KEY, JSON.stringify(codexApprovalModes));
    showToast(mode === 'auto-accept' ? 'خواندن خودکار شد؛ تغییرات هنوز اجازه می‌خواهند.' : mode === 'auto-decline' ? 'رد خودکار فعال شد.' : 'برای هر درخواست اجازه می‌پرسد.');
  } catch (error) {
    syncCodexApprovalMode();
    showToast(error.message);
  }
}
async function codexApi(url, body, source = 'codex') {
  const response = await fetch('/api/' + source + url, body === undefined ? {} : {
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
        updatedAt: thread.updatedAt, general: thread.general, source: 'codex', threadId: thread.id, archived });
    });
    // Keep an open thread available if the list filter changes.
    for (const active of codexChats) {
      if (active.source === 'codex' && (active.id === activeChatId || sendingChatIds.has(active.id) || active.unreadReply || messageQueues.get(active.id)?.length) && !next.some(chat => chat.id === active.id)) next.push(active);
    }
    const claude = codexChats.filter(chat => chat.source === 'claude');
    codexChats.splice(0, codexChats.length, ...next.filter(chat => chat.source !== 'claude'), ...claude);
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
  if (!isProjectChat(chat) || chat.archiving || chat.deleting || voiceSession || sendingChatIds.has(chat.id)) return;
  const archived = !chat.archived;
  chat.archiving = true;
  syncComposerState();
  try {
    await projectApi(chat, `/threads/${encodeURIComponent(chat.threadId)}/archive`, { archived });
    codexListVersion++;
    chat.archived = archived;
    // Keep the opened history available, but remove it from the opposite list.
    renderChatList();
    await refreshCodexSessions();
    if (typeof refreshClaudeSessions === 'function') await refreshClaudeSessions();
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
    await projectApi(chat, `/threads/${encodeURIComponent(chat.threadId)}/delete`, { confirmedThreadId: chat.threadId });
    codexListVersion++;
    codexChats.splice(codexChats.indexOf(chat), 1);
    discardChatVoice(chat.id);
    if (activeChatId === chat.id) {
      messageInput.value = '';
      switchChat(chatStore.chats[0].id);
    }
    await refreshCodexSessions();
    if (typeof refreshClaudeSessions === 'function') await refreshClaudeSessions();
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
    ensureCodexApprovalMode(chat);
    const data = await projectApi(chat, '/threads/' + encodeURIComponent(chat.threadId));
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
    if (chat.loaded && changed) chat.lastMessageAt = nowIso();
    chat.messages = data.messages;
    chat.title = data.title;
    chat.cwd = data.cwd;
    chat.general = data.general;
    chat.updatedAt = data.updatedAt;
    chat.requests = data.requests;
    chat.statusLog = data.activity.map(item => ({ at: data.updatedAt, type: item.status === 'failed' ? 'error' : 'info', text: `${item.text || ''}\n${item.output || ''}`.trim() }));
    if (data.error) {
      chat.statusLog.push({ at: nowIso(), type: 'error', text: data.error });
      if (sendingChatIds.has(chatId) && !chat.stopRequested) pausedQueues.add(chatId);
    }
    if (data.usage?.total) {
      chat.usageSummary.total_input_tokens = data.usage.total.inputTokens || 0;
      chat.usageSummary.total_output_tokens = data.usage.total.outputTokens || 0;
    }
    if (!data.running && !chat.submitting && sendingChatIds.has(chatId) && chatId !== activeChatId) chat.unreadReply = true;
    if (data.running) sendingChatIds.add(chatId);
    else {
      // The server is authoritative once it reports no running turn. Clear
      // the client flag even if the send promise is still unwinding; its
      // finally block still prevents a queued job from starting too early.
      sendingChatIds.delete(chatId);
      if (chat.stopRequested) {
        chat.stopRequested = false;
        pausedQueues.delete(chatId);
      }
    }
    chat.lastRunning = Boolean(data.running);
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
      setStatus(data.running ? `${agentName(chat)} در حال کار روی پروژه…` : data.error || 'آمادهٔ ادامهٔ این سشن');
    }
    renderChatList();
  } catch (error) {
    if (chatId === activeChatId) setStatus(error.message);
  } finally { codexThreadRefreshes.delete(chatId); drainMessageQueue(chatId); }
}

function renderCodexRequests() {
  const panel = document.getElementById('codexRequests');
  const chat = getActiveChat();
  const requests = isProjectChat(chat) ? chat.requests || [] : [];
  const signature = chat.id + JSON.stringify(requests);
  if (signature === codexRequestSignature) return;
  codexRequestSignature = signature;
  panel.replaceChildren();
  for (const request of requests) {
    const box = document.createElement('div');
    box.className = 'codex-request';
    const title = document.createElement('strong');
    title.textContent = request.method === 'item/tool/requestUserInput' ? `سؤال ${agentName(chat)}` : `${agentName(chat)} به اجازهٔ شما نیاز دارد`;
    box.append(title);
    const details = document.createElement('pre');
    details.textContent = [request.reason, request.command, request.cwd, request.grantRoot,
      request.permissions ? JSON.stringify(request.permissions, null, 2) : '',
      ...(request.changes || []).map(change => `${change.path}\n${change.diff || ''}`)].filter(Boolean).join('\n');
    box.append(details);
    const fields = [];
    for (const question of request.questions || []) {
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
        await projectApi(chat, `/threads/${encodeURIComponent(chat.threadId)}/requests/${encodeURIComponent(request.id)}`, body);
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
async function sendCodexMessage(job) {
  if ((!job && voiceSession) || sendingChatIds.has(job?.chatId || activeChatId)) return;
  const chat = job ? getChatById(job.chatId) : getActiveChat();
  if (chat.archiving || chat.deleting) return;
  const voice = job ? job.voice : voiceDrafts.get(chat.id);
  if (voice && (!voice.transcript || voice.error)) { showToast('متن ویس کامل نیست؛ دوباره ضبط کن.'); return; }
  const typed = job ? job.typedText : messageInput.value.trim();
  const attachments = job ? job.attachments : [...pendingAttachments];
  const text = [typed, voice?.transcript].filter(Boolean).join('\n\n');
  if (!text && !attachments.length) return;
  chat.submitting = true;
  sendingChatIds.add(chat.id);
  syncComposerState();
  try {
    await projectApi(chat, `/threads/${encodeURIComponent(chat.threadId)}/turns`, { text, attachmentIds: attachments.map(a => a.id), model: job?.model ?? chat.model ?? '', projectContext: job?.projectContext || chat.projectContext || '' });
    chat.lastMessageAt = nowIso();
    renderChatList();
    if (chat.archived) { chat.archived = false; codexListVersion++; refreshCodexSessions(); }
    if (!job && activeChatId === chat.id) { messageInput.value = ''; pendingAttachments = []; }
    if (voice) {
      if (!job) voiceDrafts.delete(chat.id);
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
    if (job) {
      if (/already|active|running|in use|locked|مشغول|در حال اجرا|قفل/i.test(error.message || '')) {
        job.errorText = 'این گفتگو در ترمینال دیگری باز است؛ پس از پایان آن دوباره ادامه بده.';
      }
      requeueMessage(job);
    }
    showToast(error.message);
  } finally {
    chat.submitting = false;
    if (chat.lastRunning === false) sendingChatIds.delete(chat.id);
    syncComposerState();
    renderAttachments();
    renderVoiceDraft();
    updateCounter();
    drainMessageQueue(chat.id);
  }
}
function setupCodexSessions() {
  document.getElementById('activeSessions').onchange = renderChatList;
  document.getElementById('codexApprovalMode').onchange = event => changeCodexApprovalMode(event.target.value);
  document.getElementById('archiveChatBtn').onclick = toggleCodexArchive;
  document.getElementById('refreshSessionsBtn').onclick = () => { refreshCodexSessions(); if (typeof refreshClaudeSessions === 'function') refreshClaudeSessions(); };
  document.getElementById('archivedSessions').onchange = () => { codexListVersion++; refreshCodexSessions(); if (typeof refreshClaudeSessions === 'function') refreshClaudeSessions(); };
  document.getElementById('stopCodexBtn').onclick = async () => {
    const chat = getActiveChat();
    if (!chat || !isProjectChat(chat)) return;
    chat.stopRequested = true;
    pausedQueues.delete(chat.id);
    persistMessageQueues();
    renderMessageQueue();
    try {
      await projectApi(chat, `/threads/${encodeURIComponent(chat.threadId)}/interrupt`, {});
      // The interrupt acknowledgement can arrive before the app-server emits
      // turn/completion. Keep polling until the turn is really free so the
      // next queued message starts immediately after stop.
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await refreshCodexThread(chat.id);
        if (!sendingChatIds.has(chat.id) && !chat.submitting && chat.lastRunning === false) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
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
