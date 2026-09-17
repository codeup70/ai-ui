let claudeRefreshing = false;
let claudeDefaultCwd = '';
const providerModels = { claude: [], codex: [] };
function openNewChatDialog() {
  if (voiceSession) { showToast('اول ضبط ویس را متوقف کن.'); return; }
  document.getElementById('newChatProvider').value = getActiveChat().source === 'claude' ? 'claude' : 'codex';
  document.getElementById('claudeCwd').value = '';
  document.getElementById('projectOptions').open = false;
  document.getElementById('claudeCreateError').textContent = '';
  document.getElementById('newClaudeDialog').showModal();
}
function syncClaudeModel() {
  const chat = getActiveChat();
  document.getElementById('claudeModelLabel').hidden = !isProjectChat(chat);
  document.getElementById('modelProviderName').textContent = agentName(chat);
  const select = document.getElementById('claudeModel');
  const entries = providerModels[chat.source] || [];
  const signature = JSON.stringify([chat.source, entries]);
  if (select.dataset.models !== signature) {
    select.replaceChildren();
    for (const entry of [{ value: '', displayName: 'پیش‌فرض گفتگو' }, ...entries]) {
      const option = document.createElement('option'); option.value = entry.value; option.textContent = entry.displayName || entry.value; select.append(option);
    }
    select.dataset.models = signature;
  }
  select.value = chat.model || '';
}
async function refreshClaudeSessions() {
  if (claudeRefreshing) return;
  claudeRefreshing = true;
  const version = codexListVersion;
  const status = document.getElementById('claudeStatus');
  try {
    const archived = document.getElementById('archivedSessions').checked;
    const data = await codexApi('/threads?archived=' + archived, undefined, 'claude');
    if (version !== codexListVersion) return;
    const next = data.threads.map(thread => {
      const id = 'claude_' + thread.id;
      return Object.assign(codexChats.find(chat => chat.id === id) || normalizeChat({ ...thread, id }),
        { source: 'claude', general: thread.general, threadId: thread.id, title: thread.title, cwd: thread.cwd, updatedAt: thread.updatedAt, archived });
    });
    for (const chat of codexChats) {
      if (chat.source === 'claude' && (chat.id === activeChatId || sendingChatIds.has(chat.id) || messageQueues.get(chat.id)?.length) && !next.some(item => item.id === chat.id)) next.push(chat);
    }
    const codex = codexChats.filter(chat => chat.source !== 'claude');
    codexChats.splice(0, codexChats.length, ...codex, ...next);
    status.textContent = `${formatNumber(data.threads.length)} سشن Claude`;
    renderChatList();
  } catch (error) { status.textContent = error.message; }
  finally { claudeRefreshing = false; if (version !== codexListVersion) refreshClaudeSessions(); }
}
function setupClaudeSessions() {
  const dialog = document.getElementById('newClaudeDialog');
  const model = document.getElementById('claudeModel');
  model.onchange = () => { const chat = getActiveChat(); if (isProjectChat(chat)) chat.model = model.value; };
  document.getElementById('cancelClaudeBtn').onclick = () => dialog.close();
  document.getElementById('newClaudeForm').onsubmit = async event => {
    event.preventDefault();
    const button = document.getElementById('createClaudeBtn'); button.disabled = true;
    try {
      const source = document.getElementById('newChatProvider').value;
      const { thread } = await codexApi('/threads', { cwd: document.getElementById('claudeCwd').value.trim() }, source);
      const chat = Object.assign(normalizeChat({ ...thread, id: source + '_' + thread.id }), { source, general: thread.general, threadId: thread.id, cwd: thread.cwd, archived: false });
      codexChats.push(chat); dialog.close(); switchChat(chat.id);
    } catch (error) { document.getElementById('claudeCreateError').textContent = error.message; }
    finally { button.disabled = false; }
  };
  codexApi('/status', undefined, 'claude').then(data => {
    claudeDefaultCwd = data.defaultCwd;
  }).catch(error => { document.getElementById('claudeStatus').textContent = error.message; });
  for (const source of ['claude', 'codex']) codexApi('/models', undefined, source).then(data => {
    providerModels[source] = data.models;
    syncClaudeModel();
  }).catch(error => { model.title = error.message; });
  const previous = localStorage.getItem('persian-chat-active-session');
  const initial = activeChatId;
  refreshClaudeSessions().then(() => {
    if (activeChatId === initial && previous?.startsWith('claude_') && codexChats.some(chat => chat.id === previous)) switchChat(previous);
  });
  setInterval(refreshClaudeSessions, 30000);
}
