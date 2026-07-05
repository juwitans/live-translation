// AudioWorkletProcessor that batches mic samples into ~2048-sample Float32 chunks
// and posts them to the main thread. Kept as plain JS in /public so Vite serves it
// verbatim for audioWorklet.addModule().
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.length = 0;
    this.target = 2048;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      this.chunks.push(new Float32Array(channel));
      this.length += channel.length;
      if (this.length >= this.target) {
        const merged = new Float32Array(this.length);
        let offset = 0;
        for (const c of this.chunks) {
          merged.set(c, offset);
          offset += c.length;
        }
        this.port.postMessage(merged, [merged.buffer]);
        this.chunks = [];
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
