// Captures microphone audio and delivers base64-encoded 16-bit LE PCM @ 16 kHz,
// the format the Gemini Live API expects for realtime input.

export type ChunkHandler = (base64Pcm: string) => void;

export class AudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;

  async start(onChunk: ChunkHandler): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

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

    const source = this.context.createMediaStreamSource(this.stream);
    source.connect(this.workletNode);
    // Route through a muted gain so the worklet is pulled by the graph without
    // feeding the mic back to the speakers.
    const mute = this.context.createGain();
    mute.gain.value = 0;
    this.workletNode.connect(mute);
    mute.connect(this.context.destination);
  }

  async stop(): Promise<void> {
    this.workletNode?.port.close();
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
  }

  get running(): boolean {
    return this.stream !== null;
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
