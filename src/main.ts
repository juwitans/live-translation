import { AudioCapture } from './audio-capture';
import { LiveClient, type ConnectionStatus, type Direction, type KeySource } from './live-client';

interface Segment {
  original: string;
  translated: string;
  state: 'listening' | 'translating' | 'done';
  el: HTMLElement;
  originalEl: HTMLElement;
  translatedEl: HTMLElement;
}

const transcriptEl = document.getElementById('transcript')!;
const emptyHint = document.getElementById('empty-hint')!;
const connDot = document.getElementById('conn-dot')!;
const connLabel = document.getElementById('conn-label')!;
const dirToggle = document.getElementById('direction-toggle') as HTMLButtonElement;
const dirLabel = document.getElementById('dir-label')!;
const startStopBtn = document.getElementById('start-stop') as HTMLButtonElement;
const saveTxtBtn = document.getElementById('save-txt') as HTMLButtonElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const errorBanner = document.getElementById('error-banner')!;

let direction: Direction = 'ko-en';
let segments: Segment[] = [];
let currentSegment: Segment | null = null;
let autoScroll = true;
let running = false;

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

const capture = new AudioCapture();
const client = new LiveClient(keySource, {
  onStatus: setStatus,
  onInputDelta: (text) => {
    openSegmentIfNeeded();
    currentSegment!.original += text;
    currentSegment!.originalEl.textContent = currentSegment!.original;
    scrollToBottom();
  },
  onOutputDelta: (text) => {
    openSegmentIfNeeded();
    if (currentSegment!.state === 'listening') setSegmentState(currentSegment!, 'translating');
    currentSegment!.translated += text;
    currentSegment!.translatedEl.textContent = currentSegment!.translated;
    scrollToBottom();
  },
  onTurnComplete: () => {
    if (currentSegment) {
      setSegmentState(currentSegment, 'done');
      currentSegment = null;
    }
  },
});

// --- UI wiring ---

startStopBtn.addEventListener('click', () => {
  void (running ? stop() : start());
});

dirToggle.addEventListener('click', () => {
  direction = direction === 'ko-en' ? 'en-ko' : 'ko-en';
  dirLabel.textContent = direction === 'ko-en' ? 'KO → EN' : 'EN → KO';
  if (currentSegment) {
    setSegmentState(currentSegment, 'done');
    currentSegment = null;
  }
  if (running) void client.setDirection(direction);
});

clearBtn.addEventListener('click', () => {
  segments = [];
  currentSegment = null;
  transcriptEl.querySelectorAll('.segment').forEach((el) => el.remove());
  emptyHint.hidden = false;
  updateTranscriptButtons();
});

saveTxtBtn.addEventListener('click', () => {
  const lines: string[] = [];
  for (const seg of segments) {
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

function updateTranscriptButtons(): void {
  const hasContent = segments.length > 0;
  saveTxtBtn.disabled = !hasContent;
  clearBtn.disabled = !hasContent;
}

transcriptEl.addEventListener('scroll', () => {
  const nearBottom =
    transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 60;
  autoScroll = nearBottom;
});

async function start(): Promise<void> {
  hideError();
  try {
    await client.connect(direction);
  } catch {
    return; // status/error already surfaced by the client
  }
  try {
    await capture.start((chunk) => client.sendAudio(chunk));
  } catch (err) {
    client.close();
    const denied = err instanceof DOMException && err.name === 'NotAllowedError';
    showError(
      denied
        ? 'Microphone access was denied. Allow the microphone for this site in the browser address bar, then try again.'
        : `Could not start the microphone: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  running = true;
  startStopBtn.textContent = 'Stop';
  startStopBtn.classList.add('active');
}

async function stop(): Promise<void> {
  running = false;
  await capture.stop();
  client.close();
  if (currentSegment) {
    setSegmentState(currentSegment, 'done');
    currentSegment = null;
  }
  startStopBtn.textContent = 'Start';
  startStopBtn.classList.remove('active');
}

// --- Segment rendering ---

function openSegmentIfNeeded(): void {
  if (currentSegment) return;
  emptyHint.hidden = true;

  const el = document.createElement('div');
  el.className = 'segment listening';
  const originalEl = document.createElement('div');
  originalEl.className = 'original';
  const translatedEl = document.createElement('div');
  translatedEl.className = 'translated';
  el.append(originalEl, translatedEl);
  transcriptEl.appendChild(el);

  currentSegment = { original: '', translated: '', state: 'listening', el, originalEl, translatedEl };
  segments.push(currentSegment);
  updateTranscriptButtons();
  scrollToBottom();
}

function setSegmentState(segment: Segment, state: Segment['state']): void {
  segment.state = state;
  segment.el.className = `segment ${state}`;
}

function scrollToBottom(): void {
  if (autoScroll) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// --- Status & errors ---

function setStatus(status: ConnectionStatus, detail?: string): void {
  connDot.className = `dot ${status}`;
  connLabel.textContent = status;
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
