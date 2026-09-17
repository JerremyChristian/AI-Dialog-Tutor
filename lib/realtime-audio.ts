const OUTPUT_SAMPLE_RATE = 24_000;

type RecorderWorkletMessage = ArrayBuffer | {
  type: "flush-complete";
  requestId: number;
};

export class MicrophonePcmStreamer {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silentOutput: GainNode | null = null;
  private flushSequence = 0;
  private flushResolvers = new Map<number, () => void>();

  constructor(
    private readonly stream: MediaStream,
    private readonly onChunk: (chunk: ArrayBuffer) => void,
  ) {}

  async start() {
    this.context = new AudioContext({ latencyHint: "interactive" });
    await resumeAudioContext(this.context);
    await this.context.audioWorklet.addModule("/pcm-recorder-worklet.js");

    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, "pcm-recorder", {
      processorOptions: {
        inputSampleRate: this.context.sampleRate,
        targetSampleRate: 16_000,
        chunkSamples: 800,
      },
    });
    this.silentOutput = this.context.createGain();
    this.silentOutput.gain.value = 0;
    this.worklet.port.onmessage = (event: MessageEvent<RecorderWorkletMessage>) => {
      if (event.data instanceof ArrayBuffer) {
        this.onChunk(event.data);
        return;
      }
      if (event.data.type === "flush-complete") {
        this.flushResolvers.get(event.data.requestId)?.();
        this.flushResolvers.delete(event.data.requestId);
      }
    };

    this.source.connect(this.worklet);
    this.worklet.connect(this.silentOutput);
    this.silentOutput.connect(this.context.destination);
    await resumeAudioContext(this.context);
  }

  flushPendingAudio() {
    const worklet = this.worklet;
    if (!worklet) return Promise.resolve();
    const requestId = ++this.flushSequence;
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!this.flushResolvers.delete(requestId)) return;
        resolve();
      }, 250);
      this.flushResolvers.set(requestId, () => {
        clearTimeout(timeout);
        resolve();
      });
      worklet.port.postMessage({ type: "flush", requestId });
    });
  }

  async stop() {
    for (const resolve of this.flushResolvers.values()) resolve();
    this.flushResolvers.clear();
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
    }
    this.source?.disconnect();
    this.silentOutput?.disconnect();

    const context = this.context;
    this.context = null;
    this.source = null;
    this.worklet = null;
    this.silentOutput = null;

    if (context && context.state !== "closed") {
      await context.close();
    }
  }
}

export class PcmAudioPlayer {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private batch: {
    epoch: number;
    sources: Set<AudioBufferSourceNode>;
    providerComplete: boolean;
    cancelled: boolean;
    hadAudio: boolean;
    drained: boolean;
    onNaturalDrain: (epoch: number) => void;
  } | null = null;

  beginBatch(epoch: number, onNaturalDrain: (epoch: number) => void) {
    this.cancelBatch();
    this.batch = { epoch, sources: new Set(), providerComplete: false, cancelled: false,
      hadAudio: false, drained: false, onNaturalDrain };
  }

  completeBatch(epoch: number) {
    if (!this.batch || this.batch.epoch !== epoch || this.batch.cancelled) return;
    this.batch.providerComplete = true;
    this.maybeReportNaturalDrain();
  }

  cancelBatch(epoch?: number) {
    if (!this.batch || (epoch !== undefined && this.batch.epoch !== epoch)) return;
    this.batch.cancelled = true;
    this.batch = null;
  }

  async prepare() {
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext({
        latencyHint: "interactive",
        sampleRate: OUTPUT_SAMPLE_RATE,
      });
    }

    await resumeAudioContext(this.context);
  }

  play(base64Pcm: string) {
    const context = this.context;
    if (!context || context.state === "closed") {
      return;
    }

    const bytes = base64ToBytes(base64Pcm);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    const audioBuffer = context.createBuffer(1, sampleCount, OUTPUT_SAMPLE_RATE);
    const samples = audioBuffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 32_768;
    }

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    const batch = this.batch;
    if (batch && !batch.cancelled) {
      batch.hadAudio = true;
      batch.sources.add(source);
    }
    source.onended = () => {
      this.sources.delete(source);
      if (batch && this.batch === batch) {
        batch.sources.delete(source);
        this.maybeReportNaturalDrain();
      }
    };

    const startTime = Math.max(context.currentTime + 0.02, this.nextStartTime);
    source.start(startTime);
    this.nextStartTime = startTime + audioBuffer.duration;
    this.sources.add(source);
  }

  clear() {
    this.cancelBatch();
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // The source may already have ended between queueing and cleanup.
      }
    }
    this.sources.clear();

    if (this.context) {
      this.nextStartTime = this.context.currentTime;
    }
  }

  async close() {
    this.clear();
    const context = this.context;
    this.context = null;

    if (context && context.state !== "closed") {
      await context.close();
    }
  }

  private maybeReportNaturalDrain() {
    const batch = this.batch;
    if (!batch || batch.cancelled || batch.drained || !batch.providerComplete ||
        !batch.hadAudio || batch.sources.size > 0) return;
    batch.drained = true;
    batch.onNaturalDrain(batch.epoch);
  }
}

async function resumeAudioContext(context: AudioContext) {
  if (context.state === "suspended") await context.resume();
  if (context.state !== "running") {
    throw new Error("Audio could not start. Tap Start Conversation again.");
  }
}

export function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
