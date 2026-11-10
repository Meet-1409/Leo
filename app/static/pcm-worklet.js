// Sends the microphone to the page as 16-bit audio in 100 ms pieces, for the Mumbai voice route.
const PIECE_SAMPLES = 1600;
class PcmSender extends AudioWorkletProcessor {
  constructor() {
    super();
    this.piece = new Int16Array(PIECE_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.piece[this.filled] = Math.max(-1, Math.min(1, channel[i])) * 32767;
      this.filled += 1;
      if (this.filled === PIECE_SAMPLES) {
        const out = this.piece.buffer;
        this.port.postMessage(out, [out]);
        this.piece = new Int16Array(PIECE_SAMPLES);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-sender", PcmSender);
