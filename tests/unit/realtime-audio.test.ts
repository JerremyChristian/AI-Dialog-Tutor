import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicrophonePcmStreamer, PcmAudioPlayer } from "../../lib/realtime-audio";

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn(() => this.onended?.());
  end() { this.onended?.(); }
}

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

class FakeWorklet {
  static latest: FakeWorklet;
  port = new FakePort();
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() { FakeWorklet.latest = this; }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = "running";
  currentTime = 1;
  destination = {} as AudioDestinationNode;
  sources: FakeSource[] = [];
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  mediaSource = { connect: vi.fn(), disconnect: vi.fn() };
  gain = { value: 1 };
  constructor() { FakeAudioContext.instances.push(this); }
  createBuffer(_channels: number, samples: number, rate: number) {
    return { duration: samples / rate, getChannelData: () => new Float32Array(samples) };
  }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source; }
  createMediaStreamSource() { return this.mediaSource; }
  createGain() { return { gain: this.gain, connect: vi.fn(), disconnect: vi.fn() }; }
}

describe("realtime audio lifecycle", () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeWorklet);
    vi.stubGlobal("atob", (value: string) => Buffer.from(value, "base64").toString("binary"));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("does not drain on generation completion until queued audio ends", async () => {
    const drained = vi.fn();
    const player = new PcmAudioPlayer();
    await player.prepare();
    player.beginBatch(4, drained);
    player.play(Buffer.alloc(4).toString("base64"));
    player.completeBatch(4);
    expect(drained).not.toHaveBeenCalled();

    FakeAudioContext.instances[0].sources[0].end();
    expect(drained).toHaveBeenCalledOnce();
    expect(drained).toHaveBeenCalledWith(4);
  });

  it("does not report a zero-audio batch as naturally drained", async () => {
    const drained = vi.fn();
    const player = new PcmAudioPlayer();
    await player.prepare();
    player.beginBatch(5, drained);
    player.completeBatch(5);
    expect(drained).not.toHaveBeenCalled();
  });

  it("clear and cancellation make old source callbacks inert", async () => {
    const staleDrain = vi.fn();
    const currentDrain = vi.fn();
    const player = new PcmAudioPlayer();
    await player.prepare();
    player.beginBatch(6, staleDrain);
    player.play(Buffer.alloc(4).toString("base64"));
    const staleSource = FakeAudioContext.instances[0].sources[0];
    player.completeBatch(6);
    player.clear();
    staleSource.end();
    expect(staleDrain).not.toHaveBeenCalled();

    player.beginBatch(7, currentDrain);
    player.play(Buffer.alloc(4).toString("base64"));
    player.completeBatch(6);
    FakeAudioContext.instances[0].sources[1].end();
    expect(currentDrain).not.toHaveBeenCalled();
    player.completeBatch(7);
    expect(currentDrain).toHaveBeenCalledWith(7);
  });

  it("resumes a suspended player context when prepared again", async () => {
    const player = new PcmAudioPlayer();
    await player.prepare();
    const context = FakeAudioContext.instances[0];
    context.state = "suspended";
    await player.prepare();
    expect(context.resume).toHaveBeenCalledOnce();
  });

  it("forwards recorder chunks, flushes at an explicit boundary, and ignores chunks after stop", async () => {
    const onChunk = vi.fn();
    const streamer = new MicrophonePcmStreamer({} as MediaStream, onChunk);
    await streamer.start();
    const worklet = FakeWorklet.latest;
    const beforeFlush = new ArrayBuffer(8);
    worklet.port.emit(beforeFlush);
    expect(onChunk).toHaveBeenCalledWith(beforeFlush);

    const flushing = streamer.flushPendingAudio();
    const request = worklet.port.postMessage.mock.calls[0][0] as { requestId: number };
    worklet.port.emit({ type: "flush-complete", requestId: request.requestId });
    await flushing;
    await streamer.stop();
    worklet.port.emit(new ArrayBuffer(8));
    expect(onChunk).toHaveBeenCalledOnce();
  });
});
