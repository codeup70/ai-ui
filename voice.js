// Audio is stored in this browser; expired clips are removed on the next load.
// Browser speech recognition runs during recording; only its transcript goes to chat.
const voiceDrafts = new Map();
let voiceSession = null;
const voiceDb = new Promise((resolve, reject) => {
  const request = indexedDB.open('persian-chat-voice', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('clips', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function voiceStorage(mode, operation) {
  const db = await voiceDb;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('clips', mode);
    const request = operation(tx.objectStore('clips'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const voiceReady = voiceStorage('readwrite', store => store.getAll()).then(async clips => {
  for (const clip of clips) {
    if (Date.now() - clip.createdAt > 86400000) {
      await voiceStorage('readwrite', store => store.delete(clip.id));
    } else if (!clip.sent) voiceDrafts.set(clip.chatId, clip);
    else if (clip.threadId) codexVoiceClips.set(clip.id, clip);
  }
}).catch(() => showToast('ذخیرهٔ محلی ویس در این مرورگر در دسترس نیست.'));

function createVoicePlayer(clip) {
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.setAttribute('aria-label', 'پخش ویس ضبط‌شده');
  const url = URL.createObjectURL(clip.blob);
  audio.src = url;
  // Release URLs when rerendering; stored blobs remain available in IndexedDB.
  audio.dataset.voiceUrl = url;
  return audio;
}
function releaseVoicePlayers(container) {
  container.querySelectorAll('audio[data-voice-url]').forEach(audio => {
    audio.pause();
    URL.revokeObjectURL(audio.dataset.voiceUrl);
  });
}
function renderVoiceDraft() {
  const tray = document.getElementById('voiceTray');
  releaseVoicePlayers(tray);
  tray.replaceChildren();
  const clip = voiceDrafts.get(activeChatId);
  if (!clip) return;
  const label = document.createElement('span');
  label.textContent = 'ویس آماده است؛ گوش بده و سپس ارسال کن.';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'ghost';
  remove.textContent = 'حذف ویس';
  remove.onclick = async () => {
    try {
      await voiceStorage('readwrite', store => store.delete(clip.id));
      voiceDrafts.delete(clip.chatId);
      renderVoiceDraft();
    } catch { showToast('حذف ویس ناموفق بود؛ دوباره تلاش کن.'); }
  };
  tray.append(label, createVoicePlayer(clip), remove);
  if (!clip.transcript || clip.error) {
    const warning = document.createElement('span');
    warning.textContent = 'متن ویس کامل تشخیص داده نشد؛ ویس را حذف و دوباره ضبط کن.';
    tray.append(warning);
  }
}
function updateVoiceUi() {
  voiceBtn.textContent = voiceSession ? 'توقف ضبط' : 'ضبط ویس';
  voiceBtn.classList.toggle('listening', Boolean(voiceSession));
  voiceBtn.disabled = Boolean(voiceSession?.stopping || voiceSession?.starting);
  const timer = document.getElementById('voiceTimer');
  timer.hidden = !voiceSession?.startedAt;
  if (!voiceSession) timer.textContent = '00:00';
  syncComposerState();
}
function updateRecordingTimer() {
  const session = voiceSession;
  if (!session?.startedAt || session.stopping) return;
  const seconds = Math.floor((performance.now() - session.startedAt) / 1000);
  document.getElementById('voiceTimer').textContent =
    `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  session.timer = setTimeout(updateRecordingTimer, 250);
}
function stopVoiceRecording() {
  const session = voiceSession;
  if (!session || session.stopping || session.starting) return;
  session.stopping = true;
  clearTimeout(session.restart);
  clearTimeout(session.limit);
  clearTimeout(session.timer);
  try { session.recognition.stop(); } catch { session.recognitionDone(); }
  if (session.recorder.state !== 'inactive') session.recorder.stop();
  // Speech recognition may fail to deliver onend after stopping.
  session.finishTimer = setTimeout(() => session.recognitionDone(), 3000);
  updateVoiceUi();
}
async function toggleVoiceInput() {
  if (voiceSession) { stopVoiceRecording(); return; }
  if (sendingChatIds.has(activeChatId)) return;
  await voiceReady;
  if (voiceSession) return;
  if (voiceDrafts.has(activeChatId)) {
    showToast('اول ویس قبلی را ارسال یا حذف کن.');
    return;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const session = { chatId: activeChatId, starting: true, chunks: [], transcript: '', interim: '', error: false };
  voiceSession = session;
  updateVoiceUi();
  try {
    session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    session.recorder = new MediaRecorder(session.stream);
    session.recognition = new SpeechRecognition();
    const recognition = session.recognition;
    recognition.lang = 'fa-IR';
    recognition.continuous = false;
    recognition.interimResults = true;
    let resolveRecognition;
    const recognitionEnded = new Promise(resolve => { resolveRecognition = resolve; });
    session.recognitionDone = resolveRecognition;
    recognition.onresult = event => {
      session.interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) session.transcript += event.results[i][0].transcript + ' ';
        else session.interim += event.results[i][0].transcript + ' ';
      }
    };
    recognition.onerror = event => {
      if (!['no-speech', 'aborted'].includes(event.error)) {
        session.error = true;
        stopVoiceRecording();
      }
    };
    recognition.onend = () => {
      if (session.stopping) { resolveRecognition(); return; }
      if (session.interim.trim()) session.error = true;
      session.interim = '';
      session.restart = setTimeout(() => {
        if (session.stopping) return;
        try { recognition.start(); }
        catch { session.error = true; stopVoiceRecording(); }
      }, 120);
    };
    session.recorder.ondataavailable = event => { if (event.data.size) session.chunks.push(event.data); };
    session.recorder.onerror = () => { session.error = true; stopVoiceRecording(); };
    session.recorder.onstop = async () => {
      if (!session.stopping) stopVoiceRecording();
      session.stream.getTracks().forEach(track => track.stop());
      await recognitionEnded;
      clearTimeout(session.finishTimer);
      const clip = {
        id: makeId('voice'), chatId: session.chatId, createdAt: Date.now(), sent: false,
        blob: new Blob(session.chunks, { type: session.recorder.mimeType }),
        transcript: session.transcript.trim(), error: session.error || Boolean(session.interim.trim()),
      };
      try {
        if (!clip.blob.size) throw new Error('empty recording');
        await voiceStorage('readwrite', store => store.put(clip));
        voiceDrafts.set(session.chatId, clip);
      } catch { showToast('ذخیرهٔ ویس ناموفق بود. دوباره ضبط کن.'); }
      voiceSession = null;
      updateVoiceUi();
      renderVoiceDraft();
      setStatus('ضبط تمام شد؛ ویس را بررسی کن.');
    };
    session.starting = false;
    session.recorder.start(1000);
    session.startedAt = performance.now();
    updateRecordingTimer();
    recognition.start();
    session.limit = setTimeout(stopVoiceRecording, 5 * 60 * 1000);
    updateVoiceUi();
    setStatus('در حال ضبط؛ برای پایان «توقف ضبط» را بزن.');
  } catch {
    session.stopping = true;
    clearTimeout(session.restart);
    clearTimeout(session.limit);
    clearTimeout(session.timer);
    if (session.recorder) {
      session.recorder.onstop = null;
      if (session.recorder.state !== 'inactive') session.recorder.stop();
    }
    session.stream?.getTracks().forEach(track => track.stop());
    if (session.recognition) {
      session.recognition.onend = null;
      session.recognition.abort();
    }
    voiceSession = null;
    updateVoiceUi();
    showToast('ضبط شروع نشد؛ دسترسی میکروفون را بررسی کن.');
  }
}
function setupVoiceInput() {
  voiceBtn.textContent = 'ضبط ویس';
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition) || !window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    voiceBtn.disabled = true;
    voiceBtn.textContent = 'ضبط ویس پشتیبانی نمی‌شود';
  }
  voiceReady.then(renderVoiceDraft);
}
function discardChatVoice(chatId) {
  voiceDrafts.delete(chatId);
  voiceStorage('readonly', store => store.getAll()).then(clips => Promise.all(
    clips.filter(clip => clip.chatId === chatId).map(clip => voiceStorage('readwrite', store => store.delete(clip.id))),
  )).catch(() => {});
}
