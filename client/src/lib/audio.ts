/**
 * Mic capture (16 kHz int16 PCM) + speaker playback (24 kHz int16 PCM).
 * Uses Web Audio API + AudioWorklet for streaming downsampled mic.
 */

const MIC_SAMPLE_RATE = 16_000;
const SPEAKER_SAMPLE_RATE = 24_000;

const PCM_WORKLET_CODE = `
class PCMWorklet extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input && input.length) {
      const i16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        i16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      this.port.postMessage(i16.buffer, [i16.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-worklet', PCMWorklet);
`;

export class AudioIO {
  private micCtx?: AudioContext;
  private micStream?: MediaStream;
  private micWorklet?: AudioWorkletNode;

  private speakerCtx?: AudioContext;
  private speakerNextTime = 0;

  async startMic(onChunk: (pcm16: ArrayBuffer) => void): Promise<void> {
    // Some browsers ignore sampleRate hint; getUserMedia at 16kHz isn't guaranteed.
    this.micCtx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });

    const blob = new Blob([PCM_WORKLET_CODE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    await this.micCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: MIC_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      } as any,
    });
    const source = this.micCtx.createMediaStreamSource(this.micStream);
    this.micWorklet = new AudioWorkletNode(this.micCtx, "pcm-worklet");
    this.micWorklet.port.onmessage = (e) => onChunk(e.data);
    source.connect(this.micWorklet);
  }

  stopMic() {
    this.micWorklet?.disconnect();
    this.micWorklet = undefined;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = undefined;
    void this.micCtx?.close();
    this.micCtx = undefined;
  }

  async playPCM(pcm16: ArrayBuffer): Promise<void> {
    if (!this.speakerCtx) {
      this.speakerCtx = new AudioContext({ sampleRate: SPEAKER_SAMPLE_RATE });
      this.speakerNextTime = this.speakerCtx.currentTime;
    }
    const int16 = new Int16Array(pcm16);
    if (!int16.length) return;
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    const buffer = this.speakerCtx.createBuffer(
      1,
      float32.length,
      SPEAKER_SAMPLE_RATE,
    );
    buffer.copyToChannel(float32, 0);
    const src = this.speakerCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.speakerCtx.destination);
    const startAt = Math.max(this.speakerNextTime, this.speakerCtx.currentTime);
    src.start(startAt);
    this.speakerNextTime = startAt + buffer.duration;
  }

  isSpeaking(): boolean {
    if (!this.speakerCtx) return false;
    return this.speakerNextTime > this.speakerCtx.currentTime + 0.02;
  }

  closeSpeaker() {
    void this.speakerCtx?.close();
    this.speakerCtx = undefined;
    this.speakerNextTime = 0;
  }
}
