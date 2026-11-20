// LevelDetectorのAudioWorklet：マイクの音声を、一定の長さの塊にまとめてメインスレッドへ送る。
// AudioWorkletGlobalScopeで動くため、モジュールを読み込まずに書く（Viteは?urlでそのまま同梱する）。

const FRAME_SAMPLES = 320; // 16kHzで20ms

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const n = Math.min(FRAME_SAMPLES - this.filled, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + n), this.filled);
      this.filled += n;
      offset += n;
      if (this.filled === FRAME_SAMPLES) {
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("tekurobo-capture", CaptureProcessor);
