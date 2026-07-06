// Captures audio and delivers base64-encoded 16-bit LE PCM @ 16 kHz, the format the
// Gemini Live API expects for realtime input. The source can be the microphone, captured
// system/tab audio (via getDisplayMedia), or both mixed together.

export type ChunkHandler = (base64Pcm: string) => void;
export type AudioSource = 'mic' | 'system' | 'both';

export interface AudioCaptureOptions {
  // Fired when a captured track ends on its own — e.g. the user clicks Chrome's
  // "Stop sharing" bar. Lets the app stop the session gracefully.
  onEnded?: () => void;
}

export class AudioCapture {
  private streams: MediaStream[] = [];
  private context: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sources: MediaStreamAudioSourceNode[] = [];
  private onEnded?: () => void;

  constructor(options: AudioCaptureOptions = {}) {
    this.onEnded = options.onEnded;
  }

  // Phase 1: obtain the MediaStream(s). MUST be called synchronously from a user
  // gesture (e.g. the Start click) — getDisplayMedia requires transient activation,
  // which is lost if we await anything else (like the socket connect) first.
  async acquire(source: AudioSource): Promise<void> {
    try {
      if (source === 'mic' || source === 'both') {
        this.streams.push(await this.getMicStream());
      }
      if (source === 'system' || source === 'both') {
        this.streams.push(await this.getSystemStream());
      }
    } catch (err) {
      // Roll back any stream already acquired so a partial 'both' failure doesn't leak.
      this.release();
      throw err;
    }
  }

  private async getMicStream(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  }

  private async getSystemStream(): Promise<MediaStream> {
    // getDisplayMedia cannot be audio-only in Chrome — request video too, then drop it.
    // Disable browser audio processing so clean playback audio isn't degraded.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(
        "No audio was shared. When picking a tab or screen, tick “Share tab audio” / “Share system audio”, then try again."
      );
    }
    return stream;
  }

  // Phase 2: build the audio graph and start delivering PCM chunks. Call after the
  // Gemini session is connected so no chunk is emitted before the socket is ready.
  async start(onChunk: ChunkHandler): Promise<void> {
    // Chrome honors the requested rate; if the platform doesn't, we downsample below.
    this.context = new AudioContext({ sampleRate: 16000 });
    if (this.context.state === 'suspended') await this.context.resume();

    await this.context.audioWorklet.addModule('/pcm-processor.js');
    this.workletNode = new AudioWorkletNode(this.context, 'pcm-processor');

    const sourceRate = this.context.sampleRate;
    this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      let samples = e.data;
      if (sourceRate !== 16000) samples = downsample(samples, sourceRate, 16000);
      onChunk(floatTo16BitPcmBase64(samples));
    };

    // Connecting every source into the one worklet node sums (mixes) them — this is
    // how 'both' merges mic + system audio. The context resamples each source to 16 kHz.
    for (const stream of this.streams) {
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', this.handleTrackEnded);
      }
      const node = this.context.createMediaStreamSource(stream);
      node.connect(this.workletNode);
      this.sources.push(node);
    }

    // Route through a muted gain so the worklet is pulled by the graph without
    // feeding audio back to the speakers.
    const mute = this.context.createGain();
    mute.gain.value = 0;
    this.workletNode.connect(mute);
    mute.connect(this.context.destination);
  }

  private handleTrackEnded = (): void => {
    this.onEnded?.();
  };

  async stop(): Promise<void> {
    this.workletNode?.port.close();
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.sources.forEach((s) => s.disconnect());
    this.sources = [];
    this.release();
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
  }

  // Stop and drop the raw streams. Used on stop(), and to clean up after acquire()
  // if the subsequent connect() fails (no audio graph was built yet).
  release(): void {
    for (const stream of this.streams) {
      for (const track of stream.getTracks()) {
        track.removeEventListener('ended', this.handleTrackEnded);
        track.stop();
      }
    }
    this.streams = [];
  }

  get running(): boolean {
    return this.streams.length > 0;
  }
}

function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    out[i] = input[Math.floor(i * ratio)];
  }
  return out;
}

function floatTo16BitPcmBase64(samples: Float32Array): string {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
