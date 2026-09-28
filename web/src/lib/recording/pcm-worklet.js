// AudioWorklet tap for live lecture recording (DESIGN §22; the protocol spike's worklet): Float32 → s16le
// (×32768, clamped), posted every `blockFrames` frames (100 ms at 16 kHz) with the running frame count — the
// recording clock that slide-view events are stamped with. While paused nothing is captured, so the clock stops.
// Messages in: 'pause', 'resume', 'flush' (post what is held now, with `flushed: true`, even when nothing is).
// Loaded with audioWorklet.addModule (plain JS: it runs in the AudioWorkletGlobalScope, not in the bundle).
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.blockFrames = (options && options.processorOptions && options.processorOptions.blockFrames) || 1600;
    this.buf = new Int16Array(this.blockFrames);
    this.fill = 0;
    this.frames = 0;
    this.on = !(options && options.processorOptions && options.processorOptions.paused);
    this.port.onmessage = (e) => {
      if (e.data === 'pause') this.on = false;
      else if (e.data === 'resume') this.on = true;
      else if (e.data === 'flush') this.post(true);
    };
  }

  post(flushed) {
    if (this.fill === 0 && !flushed) return;
    const out = this.buf.slice(0, this.fill);
    this.frames += this.fill;
    this.fill = 0;
    this.port.postMessage({ pcm: out.buffer, frames: this.frames, flushed: !!flushed }, [out.buffer]);
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !this.on) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.round(ch[i] * 32768);
      this.buf[this.fill++] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      if (this.fill === this.blockFrames) this.post(false);
    }
    return true;
  }
}

registerProcessor('easy-study-pcm-tap', PcmTap);
