import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioSession } from "../../lib/audio-session";
import { MicrophonePcmStreamer, PcmAudioPlayer } from "../../lib/realtime-audio";

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = "suspended";
  currentTime = 0;
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  constructor() { FakeAudioContext.instances.push(this); }
}

class FakeTrack extends EventTarget {
  stop = vi.fn();
}

function fakeStream(track = new FakeTrack()) {
  return { getAudioTracks: () => [track] } as unknown as MediaStream;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("AudioSession", () => {
  let debug: ReturnType<typeof vi.fn<(text: string) => void>>;
  let session: AudioSession;

  beforeEach(() => {
    FakeAudioContext.instances = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
    debug = vi.fn<(text: string) => void>();
    session = new AudioSession(debug);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("createPlayer", () => {
    it("assigns the slot and resumes the context synchronously, before any await", () => {
      const { player, ready } = session.createPlayer();
      expect(session.player).toBe(player);
      expect(FakeAudioContext.instances).toHaveLength(1);
      expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledOnce();
      return ready;
    });
  });

  describe("requestMicrophone", () => {
    it("calls getUserMedia synchronously and returns its promise", () => {
      const result = Promise.resolve(fakeStream());
      const getUserMedia = vi.fn(() => result);
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
      expect(session.requestMicrophone()).toBe(result);
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    });

    it("throws synchronously when getUserMedia is unsupported", () => {
      vi.stubGlobal("navigator", {});
      expect(() => session.requestMicrophone())
        .toThrow("Microphone access is not supported by this browser");
    });
  });

  describe("microphone stream", () => {
    it("reports the stream and fires the track-ended callback once", () => {
      const track = new FakeTrack();
      const onEnded = vi.fn();
      expect(session.hasMicrophoneStream).toBe(false);
      session.attachStream(fakeStream(track), onEnded);
      expect(session.hasMicrophoneStream).toBe(true);
      track.dispatchEvent(new Event("ended"));
      track.dispatchEvent(new Event("ended"));
      expect(onEnded).toHaveBeenCalledOnce();
    });

    it("stopTracks stops every audio track and clears the slot", () => {
      const track = new FakeTrack();
      session.attachStream(fakeStream(track), vi.fn());
      session.stopTracks();
      expect(track.stop).toHaveBeenCalledOnce();
      expect(session.hasMicrophoneStream).toBe(false);
      session.stopTracks();
      expect(track.stop).toHaveBeenCalledOnce();
    });
  });

  describe("streamer", () => {
    it("assigns the streamer slot before start and clears it before awaiting stop", async () => {
      const gate = deferred();
      const stop = vi.spyOn(MicrophonePcmStreamer.prototype, "stop").mockImplementation(() => gate.promise);
      const flush = vi.spyOn(MicrophonePcmStreamer.prototype, "flushPendingAudio").mockResolvedValue();
      const streamer = session.createStreamer(fakeStream(), vi.fn());
      expect(streamer).toBeInstanceOf(MicrophonePcmStreamer);

      await session.flushPendingMicrophoneAudio();
      expect(flush).toHaveBeenCalledOnce();

      const stopping = session.stopStreamer();
      expect(stop).toHaveBeenCalledOnce();
      await session.flushPendingMicrophoneAudio();
      expect(flush).toHaveBeenCalledOnce();
      gate.resolve();
      await stopping;
    });

    it("flush and stop are no-ops without a streamer", async () => {
      await expect(session.flushPendingMicrophoneAudio()).resolves.toBeUndefined();
      await expect(session.stopStreamer()).resolves.toBeUndefined();
    });
  });

  describe("closePlayer", () => {
    it("clears the slot before awaiting close so a resume cannot reach the closing player", async () => {
      const gate = deferred();
      const close = vi.spyOn(PcmAudioPlayer.prototype, "close").mockImplementation(() => gate.promise);
      const { ready } = session.createPlayer();
      await ready;
      const closing = session.closePlayer();
      expect(close).toHaveBeenCalledOnce();
      expect(session.player).toBeNull();
      gate.resolve();
      await closing;
    });
  });

  describe("wake lock", () => {
    function stubWakeLock(visibilityState: DocumentVisibilityState, request: () => Promise<WakeLockSentinel>) {
      vi.stubGlobal("navigator", { wakeLock: { request: vi.fn(request) } });
      vi.stubGlobal("document", { visibilityState });
      return (navigator as unknown as { wakeLock: { request: ReturnType<typeof vi.fn> } }).wakeLock.request;
    }

    it("requests and releases the screen lock with the existing debug text", async () => {
      const release = vi.fn(async () => undefined);
      const request = stubWakeLock("visible", async () => ({ release }) as unknown as WakeLockSentinel);
      await session.requestWakeLock();
      expect(request).toHaveBeenCalledWith("screen");
      expect(debug).toHaveBeenCalledWith("Screen wake lock active");
      await session.releaseWakeLock();
      expect(release).toHaveBeenCalledOnce();
      await session.releaseWakeLock();
      expect(release).toHaveBeenCalledOnce();
    });

    it("skips the request while hidden", async () => {
      const request = stubWakeLock("hidden", async () => ({}) as WakeLockSentinel);
      await session.requestWakeLock();
      expect(request).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
    });

    it("reports an unavailable lock and swallows release failures", async () => {
      stubWakeLock("visible", async () => { throw new Error("denied"); });
      await session.requestWakeLock();
      expect(debug).toHaveBeenCalledWith("Screen wake lock unavailable");

      stubWakeLock("visible", async () => ({
        release: vi.fn(async () => { throw new Error("gone"); }),
      }) as unknown as WakeLockSentinel);
      await session.requestWakeLock();
      await expect(session.releaseWakeLock()).resolves.toBeUndefined();
    });

    it("is skipped when the Wake Lock API is unavailable", async () => {
      vi.stubGlobal("navigator", {});
      vi.stubGlobal("document", { visibilityState: "visible" });
      await session.requestWakeLock();
      expect(debug).not.toHaveBeenCalled();
    });
  });

  it("stays reusable after a full teardown (no terminal disposed state)", async () => {
    const first = session.createPlayer();
    await first.ready;
    session.attachStream(fakeStream(), vi.fn());
    session.createStreamer(fakeStream(), vi.fn());
    vi.spyOn(MicrophonePcmStreamer.prototype, "stop").mockResolvedValue();

    await session.stopStreamer();
    session.stopTracks();
    await session.closePlayer();
    await session.releaseWakeLock();

    const second = session.createPlayer();
    await second.ready;
    expect(second.player).not.toBe(first.player);
    expect(session.player).toBe(second.player);
    session.attachStream(fakeStream(), vi.fn());
    expect(session.hasMicrophoneStream).toBe(true);
  });
});
