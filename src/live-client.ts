// Manages the Gemini Live API session: connect with a translation system
// instruction, stream mic PCM in, surface transcription/translation text out.
// Handles the TEXT-modality fallback (native-audio models may only accept AUDIO
// responses — in that case we request AUDIO + outputAudioTranscription and use
// the transcription as the caption, never playing the audio), GoAway-driven
// reconnects, and capped-backoff retry on unexpected drops.

import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';

const MODEL = 'gemini-3.1-flash-live-preview';
const MAX_RECONNECT_ATTEMPTS = 3;

export type Direction = 'ko-en' | 'en-ko';
export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';

/**
 * Where connection credentials come from:
 * - 'api-key': a raw Gemini key, inlined at build time (local dev only).
 * - 'token-endpoint': a server URL that mints single-use ephemeral tokens
 *   (production — the real key stays server-side). Tokens are uses:1, so a
 *   fresh one is fetched for every connect/reconnect.
 */
export type KeySource =
  | { mode: 'api-key'; apiKey: string }
  | { mode: 'token-endpoint'; url: string };

export interface LiveClientEvents {
  onStatus: (status: ConnectionStatus, detail?: string) => void;
  /** Incremental original-language transcription of what the speaker said. */
  onInputDelta: (text: string) => void;
  /** Incremental translated text. */
  onOutputDelta: (text: string) => void;
  onTurnComplete: () => void;
}

const SYSTEM_INSTRUCTIONS: Record<Direction, string> = {
  'ko-en':
    'You are a simultaneous interpreter. The audio you hear is Korean. ' +
    'Output ONLY the English translation of what was said — no commentary, ' +
    'no answers, no romanization. If the audio is unintelligible, output nothing.',
  'en-ko':
    'You are a simultaneous interpreter. The audio you hear is English. ' +
    'Output ONLY the Korean translation of what was said — no commentary, ' +
    'no answers. If the audio is unintelligible, output nothing.',
};

export class LiveClient {
  private keySource: KeySource;
  private session: Session | null = null;
  private events: LiveClientEvents;
  private direction: Direction = 'ko-en';
  private useAudioFallback = false;
  private setupCompleted = false;
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private connected = false;

  constructor(keySource: KeySource, events: LiveClientEvents) {
    this.keySource = keySource;
    this.events = events;
  }

  private async createClient(): Promise<GoogleGenAI> {
    if (this.keySource.mode === 'api-key') {
      return new GoogleGenAI({ apiKey: this.keySource.apiKey });
    }
    const res = await fetch(this.keySource.url, { method: 'POST' });
    if (!res.ok) {
      throw new Error(
        `Token endpoint returned ${res.status}. When deployed, set GEMINI_API_KEY in the ` +
          'Netlify dashboard; for local dev, set VITE_GEMINI_API_KEY in .env.local instead.'
      );
    }
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error('Token endpoint returned no token.');
    // Ephemeral tokens require the v1alpha API surface.
    return new GoogleGenAI({ apiKey: body.token, httpOptions: { apiVersion: 'v1alpha' } });
  }

  async connect(direction: Direction): Promise<void> {
    this.direction = direction;
    this.reconnectAttempts = 0;
    await this.openSession();
  }

  private async openSession(): Promise<void> {
    this.events.onStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    this.setupCompleted = false;
    this.intentionalClose = false;

    // Credential acquisition is kept outside the connect try/catch below so a
    // failed token fetch surfaces as an error instead of triggering the
    // TEXT→AUDIO modality fallback.
    let ai: GoogleGenAI;
    try {
      ai = await this.createClient();
    } catch (err) {
      this.events.onStatus('error', err instanceof Error ? err.message : String(err));
      throw err;
    }

    const config: Record<string, unknown> = {
      systemInstruction: SYSTEM_INSTRUCTIONS[this.direction],
      inputAudioTranscription: {},
    };
    if (this.useAudioFallback) {
      config.responseModalities = [Modality.AUDIO];
      config.outputAudioTranscription = {};
    } else {
      config.responseModalities = [Modality.TEXT];
    }

    try {
      this.session = await ai.live.connect({
        model: MODEL,
        config,
        callbacks: {
          onopen: () => {
            this.connected = true;
          },
          onmessage: (msg: LiveServerMessage) => this.handleMessage(msg),
          onerror: (e: ErrorEvent) => {
            this.events.onStatus('error', e.message ?? 'connection error');
          },
          onclose: (e: CloseEvent) => {
            this.connected = false;
            this.handleClose(e);
          },
        },
      });
    } catch (err) {
      if (!this.useAudioFallback) {
        // TEXT modality may be rejected outright by native-audio models —
        // retry once with the AUDIO + transcription fallback before failing.
        this.useAudioFallback = true;
        await this.openSession();
        return;
      }
      this.events.onStatus('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private handleMessage(msg: LiveServerMessage): void {
    if (msg.setupComplete) {
      this.setupCompleted = true;
      this.reconnectAttempts = 0;
      this.events.onStatus('live');
      return;
    }

    if (msg.goAway) {
      // Server is about to drop the connection (session/connection time limit).
      // Reconnect proactively; transcript state lives in the UI, nothing is lost.
      void this.restart().catch(() => {});
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.inputTranscription?.text) {
      this.events.onInputDelta(sc.inputTranscription.text);
    }
    if (sc.outputTranscription?.text) {
      this.events.onOutputDelta(sc.outputTranscription.text);
    }
    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        if (part.text) this.events.onOutputDelta(part.text);
      }
    }
    if (sc.turnComplete) {
      this.events.onTurnComplete();
    }
  }

  private handleClose(e: CloseEvent): void {
    if (this.intentionalClose) return;

    // Closed during setup while asking for TEXT → assume modality rejection
    // and retry with the AUDIO+transcription fallback.
    if (!this.setupCompleted && !this.useAudioFallback) {
      this.useAudioFallback = true;
      // Errors surface via onStatus inside openSession; swallow the rejection.
      void this.openSession().catch(() => {});
      return;
    }

    if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      const delay = 500 * 2 ** this.reconnectAttempts;
      this.events.onStatus('reconnecting', e.reason || undefined);
      setTimeout(() => void this.openSession().catch(() => {}), delay);
    } else {
      this.events.onStatus('error', e.reason || 'connection lost');
    }
  }

  private async restart(): Promise<void> {
    const old = this.session;
    this.intentionalClose = true;
    this.session = null;
    old?.close();
    this.reconnectAttempts = 0;
    await this.openSession();
  }

  sendAudio(base64Pcm: string): void {
    if (!this.session || !this.connected || !this.setupCompleted) return;
    this.session.sendRealtimeInput({
      audio: { data: base64Pcm, mimeType: 'audio/pcm;rate=16000' },
    });
  }

  async setDirection(direction: Direction): Promise<void> {
    if (direction === this.direction && this.session) return;
    this.direction = direction;
    if (this.session) await this.restart();
  }

  close(): void {
    this.intentionalClose = true;
    this.session?.close();
    this.session = null;
    this.connected = false;
    this.events.onStatus('idle');
  }
}
