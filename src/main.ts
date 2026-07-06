import { AudioCapture, type AudioSource } from './audio-capture';
import { LiveClient, type ConnectionStatus, type Direction, type KeySource } from './live-client';

interface FinishedSegment {
  time: string;
  original: string;
  translated: string;
}

const transcriptEl = document.getElementById('transcript')!;
const columnEl = document.getElementById('column')!;
const emptyState = document.getElementById('empty-state')!;
const emptyTitleText = document.getElementById('empty-title-text')!;
const emptyHint = document.getElementById('empty-hint')!;
const liveIndicator = document.getElementById('live-indicator')!;
const connLabel = document.getElementById('conn-label')!;
const srcLangEl = document.getElementById('src-lang')!;
const tgtLangEl = document.getElementById('tgt-lang')!;
const dirToggle = document.getElementById('direction-toggle') as HTMLButtonElement;
const fontDecBtn = document.getElementById('font-dec') as HTMLButtonElement;
const fontIncBtn = document.getElementById('font-inc') as HTMLButtonElement;
const autoScrollBtn = document.getElementById('autoscroll') as HTMLButtonElement;
const saveTxtBtn = document.getElementById('save-txt') as HTMLButtonElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const startStopBtn = document.getElementById('start-stop') as HTMLButtonElement;
const micLabel = document.getElementById('mic-label')!;
const micIconStart = document.getElementById('mic-icon-start')!;
const micIconStop = document.getElementById('mic-icon-stop')!;
const errorBanner = document.getElementById('error-banner')!;
const sourceSeg = document.querySelector('.source-seg') as HTMLElement;
const srcMicBtn = document.getElementById('src-mic') as HTMLButtonElement;
const srcSystemBtn = document.getElementById('src-system') as HTMLButtonElement;
const srcBothBtn = document.getElementById('src-both') as HTMLButtonElement;
const partialEl = document.getElementById('partial')!;
const partialSource = document.getElementById('partial-source')!;
const partialTarget = document.getElementById('partial-target')!;

let direction: Direction = 'ko-en';
let audioSource: AudioSource = 'mic';
let running = false;
let autoScroll = true;
let fontScale = 1;
let segments: FinishedSegment[] = [];
let current: { time: string; original: string; translated: string } | null = null;
let latestCard: { badgeEl: HTMLElement; dirLabel: string } | null = null;

// Local dev: set VITE_GEMINI_API_KEY in .env.local for a direct connection.
// Production builds ALWAYS use the token endpoint (Netlify function at
// /api/token minting single-use ephemeral tokens) — the dev-only guard here
// keeps a key from .env.local from ever being baked into a deployed bundle.
const apiKey = import.meta.env.DEV
  ? (import.meta.env.VITE_GEMINI_API_KEY as string | undefined)
  : undefined;
const keySource: KeySource = apiKey
  ? { mode: 'api-key', apiKey }
  : { mode: 'token-endpoint', url: '/api/token' };

const capture = new AudioCapture({
  onEnded: () => {
    if (!running) return;
    void stop();
    showError('Screen sharing ended.');
  },
});
const client = new LiveClient(keySource, {
  onStatus: setStatus,
  onInputDelta: (text) => {
    ensureCurrent();
    current!.original += text;
    renderPartial();
  },
  onOutputDelta: (text) => {
    ensureCurrent();
    current!.translated += text;
    renderPartial();
  },
  onTurnComplete: finalizeCurrent,
});

// --- Header controls ---

startStopBtn.addEventListener('click', () => {
  void (running ? stop() : start());
});

dirToggle.addEventListener('click', () => {
  direction = direction === 'ko-en' ? 'en-ko' : 'ko-en';
  finalizeCurrent();
  updateLanguageLabels();
  if (running) void client.setDirection(direction);
});

srcMicBtn.addEventListener('click', () => setAudioSource('mic'));
srcSystemBtn.addEventListener('click', () => setAudioSource('system'));
srcBothBtn.addEventListener('click', () => setAudioSource('both'));

function setAudioSource(source: AudioSource): void {
  if (running) return; // source is fixed for a running session
  audioSource = source;
  for (const [btn, val] of [
    [srcMicBtn, 'mic'],
    [srcSystemBtn, 'system'],
    [srcBothBtn, 'both'],
  ] as [HTMLButtonElement, AudioSource][]) {
    const on = val === source;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  renderPartial();
}

fontIncBtn.addEventListener('click', () => setFontScale(fontScale + 0.15));
fontDecBtn.addEventListener('click', () => setFontScale(fontScale - 0.15));

function setFontScale(scale: number): void {
  fontScale = Math.min(1.6, Math.max(0.85, +scale.toFixed(2)));
  document.documentElement.style.setProperty('--fs', String(fontScale));
}

autoScrollBtn.addEventListener('click', () => {
  setAutoScroll(!autoScroll);
  if (autoScroll) scrollToBottom();
});

function setAutoScroll(on: boolean): void {
  autoScroll = on;
  autoScrollBtn.classList.toggle('active', on);
}

transcriptEl.addEventListener('scroll', () => {
  const nearBottom =
    transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 60;
  if (nearBottom !== autoScroll) setAutoScroll(nearBottom);
});

clearBtn.addEventListener('click', () => {
  segments = [];
  current = null;
  latestCard = null;
  columnEl.querySelectorAll('.card:not(.partial)').forEach((el) => el.remove());
  renderPartial();
});

saveTxtBtn.addEventListener('click', () => {
  const all = current && (current.original || current.translated) ? [...segments, current] : segments;
  const lines: string[] = [];
  for (const seg of all) {
    lines.push(`[${seg.time}]`);
    if (seg.original) lines.push(seg.original.trim());
    if (seg.translated) lines.push(seg.translated.trim());
    lines.push('');
  }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
  a.href = url;
  a.download = `transcript_${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

// --- Start / stop ---

async function start(): Promise<void> {
  hideError();
  // Acquire the media stream FIRST, inside the click gesture — getDisplayMedia needs
  // transient user activation, which awaiting the socket connect would consume.
  try {
    await capture.acquire(audioSource);
  } catch (err) {
    showError(sourceErrorMessage(err));
    return;
  }
  try {
    await client.connect(direction);
  } catch {
    capture.release();
    return; // status/error already surfaced by the client
  }
  try {
    await capture.start((chunk) => client.sendAudio(chunk));
  } catch (err) {
    client.close();
    await capture.stop();
    showError(`Could not start audio capture: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  running = true;
  updateMicButton();
  renderPartial();
}

function sourceErrorMessage(err: unknown): string {
  // User cancelled or the browser blocked the mic/screen prompt.
  if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
    if (audioSource === 'mic') {
      return 'Microphone access was denied. Allow the microphone for this site in the browser address bar, then try again.';
    }
    return 'Screen / tab-audio sharing was cancelled or blocked. Press Start and pick a tab or screen to capture.';
  }
  // e.g. the "No audio was shared" error thrown by AudioCapture.
  return err instanceof Error ? err.message : String(err);
}

async function stop(): Promise<void> {
  running = false;
  finalizeCurrent();
  await capture.stop();
  client.close();
  updateMicButton();
  renderPartial();
}

function updateMicButton(): void {
  startStopBtn.classList.toggle('active', running);
  micLabel.textContent = running ? 'Stop' : 'Start';
  micIconStart.hidden = running;
  micIconStop.hidden = !running;
  sourceSeg.classList.toggle('locked', running);
  for (const btn of [srcMicBtn, srcSystemBtn, srcBothBtn]) btn.disabled = running;
}

// --- Segments ---

function ensureCurrent(): void {
  if (current) return;
  current = { time: timestamp(), original: '', translated: '' };
}

function timestamp(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dirLabelOf(dir: Direction): string {
  return dir === 'ko-en' ? 'KO → EN' : 'EN → KO';
}

function finalizeCurrent(): void {
  if (!current) return;
  if (!current.original && !current.translated) {
    current = null;
    return;
  }
  const seg: FinishedSegment = {
    time: current.time,
    original: current.original.trim(),
    translated: current.translated.trim(),
  };
  segments.push(seg);
  current = null;

  // Demote the previous "new" badge to its direction label.
  if (latestCard) {
    latestCard.badgeEl.textContent = latestCard.dirLabel;
    latestCard.badgeEl.classList.remove('new');
  }
  columnEl.querySelector('.card.latest')?.classList.remove('latest');

  const card = buildCard(seg);
  columnEl.insertBefore(card.el, partialEl);
  latestCard = { badgeEl: card.badgeEl, dirLabel: dirLabelOf(direction) };

  renderPartial();
  scrollToBottom();
}

function buildCard(seg: FinishedSegment): { el: HTMLElement; badgeEl: HTMLElement } {
  const el = document.createElement('div');
  el.className = 'card latest';

  const accent = document.createElement('span');
  accent.className = 'accent';

  const body = document.createElement('div');
  body.className = 'body';

  const meta = document.createElement('div');
  meta.className = 'meta';

  const metaLeft = document.createElement('span');
  metaLeft.className = 'meta-left';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = seg.time;
  const badgeEl = document.createElement('span');
  badgeEl.className = running ? 'badge new' : 'badge';
  badgeEl.textContent = running ? 'new' : dirLabelOf(direction);
  metaLeft.append(time, badgeEl);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.title = 'Copy translation';
  copyBtn.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span>';
  let revertTimer: ReturnType<typeof setTimeout> | undefined;
  copyBtn.addEventListener('click', () => {
    void navigator.clipboard?.writeText(seg.translated || seg.original).catch(() => {});
    copyBtn.classList.add('copied');
    copyBtn.querySelector('span')!.textContent = 'Copied';
    clearTimeout(revertTimer);
    revertTimer = setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.querySelector('span')!.textContent = 'Copy';
    }, 1600);
  });

  meta.append(metaLeft, copyBtn);

  const source = document.createElement('p');
  source.className = 'source';
  source.textContent = seg.original;

  const target = document.createElement('p');
  target.className = `target ${direction === 'ko-en' ? 'lang-en' : 'lang-ko'}`;
  target.textContent = seg.translated;

  body.append(meta, source, target);
  el.append(accent, body);
  return { el, badgeEl };
}

// --- Partial card, empty state, button enablement ---

function renderPartial(): void {
  const koEn = direction === 'ko-en';
  const hasCurrentText = !!current && !!(current.original || current.translated);
  const hasAny = segments.length > 0 || hasCurrentText;

  emptyState.hidden = hasAny;
  emptyState.classList.toggle('running', running);
  emptyTitleText.textContent = running
    ? `Listening for ${koEn ? '한국어' : 'English'}`
    : 'Ready to translate';
  emptyHint.innerHTML = running ? runningHint() : idleHint();

  partialEl.hidden = !(running && hasAny);
  if (hasCurrentText) {
    partialSource.classList.remove('placeholder');
    partialSource.textContent = current!.original;
    partialTarget.textContent = current!.translated;
    partialTarget.className = `target ${koEn ? 'lang-en' : 'lang-ko'}`;
  } else {
    partialSource.classList.add('placeholder');
    partialSource.textContent = koEn
      ? '지금 말하는 내용을 듣고 있어요…'
      : 'Listening to what you say now…';
    partialTarget.textContent = '';
  }

  saveTxtBtn.disabled = !hasAny;
  clearBtn.disabled = !hasAny;
  if (hasCurrentText) scrollToBottom();
}

function idleHint(): string {
  switch (audioSource) {
    case 'system':
      return 'Press <strong>Start</strong>, then pick the tab or screen to capture (tick “Share tab/system audio”).';
    case 'both':
      return 'Press <strong>Start</strong>, share a tab/screen, and speak — best with headphones.';
    default:
      return 'Press <strong>Start</strong>, allow the microphone, and begin speaking.';
  }
}

function runningHint(): string {
  switch (audioSource) {
    case 'system':
      return 'Play the video or meeting — its audio will appear here, translated in real time.';
    case 'both':
      return 'Captured audio and your voice will appear here, translated in real time.';
    default:
      return 'Start speaking and your words will appear here, translated in real time.';
  }
}

function updateLanguageLabels(): void {
  const koEn = direction === 'ko-en';
  srcLangEl.textContent = koEn ? '한국어' : 'English';
  tgtLangEl.textContent = koEn ? 'English' : '한국어';
  renderPartial();
}

function scrollToBottom(): void {
  if (autoScroll) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// --- Status & errors ---

function setStatus(status: ConnectionStatus, detail?: string): void {
  liveIndicator.className = status;
  const labels: Record<ConnectionStatus, string> = {
    idle: 'Paused',
    connecting: 'Connecting…',
    live: 'Live',
    reconnecting: 'Reconnecting…',
    error: 'Error',
  };
  connLabel.textContent = labels[status];
  if (status === 'error') {
    showError(detail ? `Connection error: ${detail}` : 'Connection error. Press Start to retry.');
    if (running) void stop();
  }
}

function showError(message: string): void {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}

function hideError(): void {
  errorBanner.hidden = true;
}

updateLanguageLabels();
