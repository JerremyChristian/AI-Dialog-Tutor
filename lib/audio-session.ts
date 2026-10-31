import { MicrophonePcmStreamer, PcmAudioPlayer } from "./realtime-audio";

// Browser audio resources for the teaching page: one microphone stream, its PCM
// streamer, the tutor playback player and the screen wake lock. The page owns
// conversation runs, mounted checks, epochs, batches, mute and farewell gating,
// the transport and every ordering decision; this class only holds the
// resources and performs each step it is asked to.
//
// One instance lives for the whole page. It has no terminal disposed state
// (React StrictMode re-mounts and every new lesson reuse it), and teardown is
// deliberately split into separate steps so disposeResources keeps its order:
// streamer stop, transport close, track stop, player close, then the wake lock
// after the synchronous resets. Each slot is read at the moment its step runs.
export class AudioSession {
  private stream: MediaStream | null = null;
  private streamer: MicrophonePcmStreamer | null = null;
  private currentPlayer: PcmAudioPlayer | null = null;
  private wakeLock: WakeLockSentinel | null = null;

  constructor(private readonly debug: (text: string) => void) {}

  get player() {
    return this.currentPlayer;
  }

  get hasMicrophoneStream() {
    return Boolean(this.stream);
  }

  // Must run synchronously inside the user gesture: prepare() resumes the new
  // AudioContext before its first await, which unlocks playback on iOS.
  createPlayer() {
    const player = new PcmAudioPlayer();
    this.currentPlayer = player;
    const ready = player.prepare();
    return { player, ready };
  }

  // Not async, so getUserMedia starts in the caller's tick; the unsupported
  // error is thrown synchronously into the caller's try.
  requestMicrophone(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access is not supported by this browser");
    }
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }

  attachStream(stream: MediaStream, onTrackEnded: () => void) {
    this.stream = stream;
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.addEventListener("ended", onTrackEnded, { once: true });
    }
  }

  // The slot is assigned before the caller awaits start(), so a concurrent
  // stopStreamer() can stop a streamer that is still starting.
  createStreamer(stream: MediaStream, onChunk: (chunk: ArrayBuffer) => void) {
    const streamer = new MicrophonePcmStreamer(stream, onChunk);
    this.streamer = streamer;
    return streamer;
  }

  flushPendingMicrophoneAudio() {
    return this.streamer ? this.streamer.flushPendingAudio() : Promise.resolve();
  }

  async requestWakeLock() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
      this.debug("Screen wake lock active");
    } catch {
      this.debug("Screen wake lock unavailable");
    }
  }

  async stopStreamer() {
    const streamer = this.streamer;
    this.streamer = null;
    await streamer?.stop();
  }

  stopTracks() {
    this.stream?.getAudioTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  // The slot is cleared before awaiting close(), so a visibility resume can
  // never prepare() (and so re-create) a context that is being closed.
  async closePlayer() {
    const player = this.currentPlayer;
    this.currentPlayer = null;
    await player?.close();
  }

  async releaseWakeLock() {
    await this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }
}
