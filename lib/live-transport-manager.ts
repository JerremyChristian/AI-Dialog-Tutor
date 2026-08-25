import type { LiveServerMessage } from "@google/genai";
import { GeminiLiveWebSocket, TUTOR_VOICE } from "./gemini-live-websocket";

export type LiveTransportState =
  | "connecting"
  | "active"
  | "rollover-ready"
  | "handoff"
  | "synchronizing"
  | "recovering"
  | "closed";

type PostResumeState =
  | "none"
  | "syncing"
  | "waiting-for-user"
  | "continuing-interrupted-output";

export type RolloverReason =
  | "go-away"
  | "forced-safe"
  | "forced-immediate"
  | "socket-failure";

const ROLLOVER_PREPARE_MS = 8 * 60_000;
const INPUT_SAMPLE_RATE = 16_000;
const INPUT_BYTES_PER_SAMPLE = 2;
const INPUT_CHUNK_SAMPLES = 800;
const INPUT_CHUNK_DURATION_MS = INPUT_CHUNK_SAMPLES / INPUT_SAMPLE_RATE * 1_000;
const HANDOFF_BUFFER_DURATION_MS = 12_000;
const HANDOFF_BUFFER_CHUNKS = Math.ceil(
  HANDOFF_BUFFER_DURATION_MS / INPUT_CHUNK_DURATION_MS,
);
const HANDOFF_BUFFER_CAPACITY_BYTES =
  INPUT_SAMPLE_RATE * INPUT_BYTES_PER_SAMPLE * HANDOFF_BUFFER_DURATION_MS / 1_000;
const LEARNER_UTTERANCE_END_SILENCE_MS = 650;
const INTERRUPTION_EPOCH_POST_HANDOFF_GRACE_MS = 3_000;
const GO_AWAY_ROLLOVER_SAFETY_MS = 8_000;
const PREPARED_TOKEN_MIN_VALIDITY_MS = 15_000;
const POST_RESUME_SYNC_TIMEOUT_MS = 4_000;

type TokenResult = { token: string; newSessionExpiresAt?: number };

type ManagerOptions = {
  model: string;
  systemInstruction: string;
  requestToken: () => Promise<TokenResult>;
  onMessage: (message: LiveServerMessage) => void;
  onDebug: (message: string) => void;
  onStateChange: (state: LiveTransportState) => void;
  seedFreshRecovery: (socket: GeminiLiveWebSocket) => void;
  onFatalError: (message: string) => void;
};

export class LiveTransportManager {
  private activeSocket: GeminiLiveWebSocket | null = null;
  private state: LiveTransportState = "closed";
  private latestResumableHandle: string | null = null;
  private latestResumableHandleUpdatedAt: number | null = null;
  private prepareTimer: ReturnType<typeof setTimeout> | null = null;
  private forcedHandoffTimer: ReturnType<typeof setTimeout> | null = null;
  private handoffBuffer: ArrayBuffer[] = [];
  private handoffDropped = false;
  private handoffStartedAt: number | null = null;
  private handoffDroppedDurationMs = 0;
  private learnerSpeaking = false;
  private learnerSpeechStartedAt: number | null = null;
  private learnerSpeechEndTimer: ReturnType<typeof setTimeout> | null = null;
  private interruptionEpochExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private microphoneForwardingEnabled = true;
  private assistantSpeaking = false;
  private rolloverReason: RolloverReason | null = null;
  private rolloverRequestedAt: number | null = null;
  private goAwayDeadlineAt: number | null = null;
  private intentionalSockets = new WeakSet<GeminiLiveWebSocket>();
  private preparedToken: TokenResult | null = null;
  private preparingTokenPromise: Promise<void> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncAttempts = 0;
  private postResumeSyncStartedAt: number | null = null;
  private queuedLearnerText: string | null = null;
  private awaitingFirstPostResumeTurn = false;
  private firstPostResumeLearnerTurnAt: number | null = null;
  private firstPostResumeGeminiEventLogged = false;
  private firstPostResumeToolLogged = false;
  private firstPostResumeResponseLogged = false;
  private firstPostResumeAudioLogged = false;
  private postResumeState: PostResumeState = "none";
  private postResumeStateResponseSent = false;
  private unexpectedSyncOutputLogged = false;
  private interruptedTutorContinuationRequired = false;
  private learnerUtteranceSequence = 0;
  private currentLearnerUtteranceId: number | null = null;
  private learnerUtteranceOpen = false;
  private interruptionRegisteredForUtterance = false;
  private learnerUtteranceSpansRollover = false;

  constructor(private readonly options: ManagerOptions) {}

  async connectInitial(token: string) {
    this.setState("connecting");
    const socket = this.createSocket();
    this.activeSocket = socket;
    await socket.connect(token, {
      model: this.options.model,
      systemInstruction: this.options.systemInstruction,
    });
    this.options.onDebug(`Tutor voice configured: ${TUTOR_VOICE}`);
    this.setState("active");
    this.options.onDebug("Session resumption enabled");
    this.options.onDebug("Context compression enabled");
    this.schedulePreparation();
    return socket;
  }

  sendAudio(chunk: ArrayBuffer) {
    if (this.state === "handoff" || this.state === "synchronizing" || this.state === "recovering") {
      if (this.handoffBuffer.length === HANDOFF_BUFFER_CHUNKS) {
        const dropped = this.handoffBuffer.shift();
        this.handoffDroppedDurationMs += dropped
          ? pcmDurationMs(dropped.byteLength)
          : INPUT_CHUNK_DURATION_MS;
        if (!this.handoffDropped) {
          this.handoffDropped = true;
          this.options.onDebug(
            `Handoff buffer overflow: buffered=${HANDOFF_BUFFER_DURATION_MS} ms, ` +
            `capacity=${HANDOFF_BUFFER_DURATION_MS} ms, ` +
            `dropped=${this.handoffDroppedDurationMs} ms`,
          );
        }
      }
      this.handoffBuffer.push(chunk);
      return true;
    }
    return this.activeSocket?.sendRealtimeInput({
      audio: { data: arrayBufferToBase64(chunk), mimeType: "audio/pcm;rate=16000" },
    }) ?? false;
  }

  sendRealtimeInput(input: Record<string, unknown>) {
    return this.activeSocket?.sendRealtimeInput(input) ?? false;
  }

  sendLearnerText(text: string) {
    if (this.state === "synchronizing") {
      if (this.queuedLearnerText) return false;
      this.options.onDebug("First post-resume learner turn received");
      this.queuedLearnerText = text;
      return true;
    }
    if (this.state !== "active" && this.state !== "rollover-ready") return false;
    const trackingFirstTurn = this.awaitingFirstPostResumeTurn;
    this.noteFirstPostResumeLearnerTurn();
    if (trackingFirstTurn && this.firstPostResumeLearnerTurnAt) {
      this.options.onDebug("First post-resume learner turn sent");
    }
    return this.activeSocket?.sendLearnerText(text) ?? false;
  }

  sendToolResponse(responses: Array<Record<string, unknown>>) {
    return this.activeSocket?.sendToolResponse(responses) ?? false;
  }

  setLearnerSpeaking(speaking: boolean) {
    if (!this.microphoneForwardingEnabled) return;
    if (speaking) {
      if (this.learnerSpeechEndTimer) clearTimeout(this.learnerSpeechEndTimer);
      if (this.interruptionEpochExpiryTimer) clearTimeout(this.interruptionEpochExpiryTimer);
      this.learnerSpeechEndTimer = null;
      this.interruptionEpochExpiryTimer = null;
      if (!this.learnerSpeaking) {
        this.learnerSpeaking = true;
        this.learnerSpeechStartedAt = Date.now();
      }
      if (!this.learnerUtteranceOpen) this.openLearnerUtterance();
      return;
    }
    if ((!this.learnerSpeaking && !this.learnerUtteranceOpen) || this.learnerSpeechEndTimer) return;
    this.learnerSpeechEndTimer = setTimeout(() => {
      this.learnerSpeechEndTimer = null;
      this.learnerSpeaking = false;
      this.learnerSpeechStartedAt = null;
      if (this.rolloverReason) {
        const waited = this.rolloverRequestedAt
          ? Date.now() - this.rolloverRequestedAt
          : 0;
        this.finishLearnerUtterance();
        this.options.onDebug(
          `Learner utterance ended; executing pending rollover (waited ${waited} ms)`,
        );
        void this.tryRequestedRollover(false);
      } else {
        const preservingSpanningEpoch = this.learnerUtteranceSpansRollover &&
          (this.state === "handoff" || this.state === "synchronizing" || this.state === "recovering");
        if (!preservingSpanningEpoch) this.finishLearnerUtterance();
      }
    }, LEARNER_UTTERANCE_END_SILENCE_MS);
  }

  setMicrophoneForwardingEnabled(enabled: boolean) {
    this.microphoneForwardingEnabled = enabled;
    if (enabled) return;
    if (this.learnerSpeechEndTimer) clearTimeout(this.learnerSpeechEndTimer);
    if (this.interruptionEpochExpiryTimer) clearTimeout(this.interruptionEpochExpiryTimer);
    this.learnerSpeechEndTimer = null;
    this.interruptionEpochExpiryTimer = null;
    this.learnerSpeaking = false;
    this.learnerSpeechStartedAt = null;
    if (!this.learnerUtteranceSpansRollover) this.finishLearnerUtterance();
    if (this.rolloverReason) void this.tryRequestedRollover(false);
  }

  registerInterruption() {
    if (!this.learnerUtteranceOpen) this.openLearnerUtterance();
    const epoch = this.currentLearnerUtteranceId;
    const duplicate = this.interruptionRegisteredForUtterance;
    if (!duplicate) {
      this.interruptionRegisteredForUtterance = true;
      this.options.onDebug(`Interruption registered: utterance-${epoch}`);
      this.options.onDebug(`Learner utterance protected after interruption: utterance-${epoch}`);
    } else {
      this.options.onDebug(this.learnerUtteranceSpansRollover
        ? `Duplicate interruption across rollover suppressed: utterance-${epoch}`
        : `Duplicate interruption suppressed: utterance-${epoch}`);
    }
    return { duplicate, epoch };
  }

  getInterruptionContinuity() {
    return {
      learnerUtteranceActive: this.learnerSpeaking,
      learnerUtteranceOpen: this.learnerUtteranceOpen,
      interruptionAlreadyRegistered: this.interruptionRegisteredForUtterance,
      interruptionEpoch: this.currentLearnerUtteranceId
        ? `utterance-${this.currentLearnerUtteranceId}`
        : undefined,
    };
  }

  setAssistantSpeaking(speaking: boolean) {
    this.assistantSpeaking = speaking;
    if (!speaking) void this.tryRequestedRollover(false);
  }

  isHealthy() {
    return this.activeSocket?.isOpen() === true &&
      (this.state === "active" || this.state === "rollover-ready");
  }

  isPostResumeSynchronizing() {
    return this.state === "synchronizing";
  }

  completePostResumeSynchronization() {
    if (this.state !== "synchronizing") return;
    this.postResumeStateResponseSent = true;
    this.scheduleSyncTimeout();
  }

  private finishPostResumeSynchronization() {
    if (this.state !== "synchronizing" || !this.postResumeStateResponseSent) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    const duration = this.postResumeSyncStartedAt
      ? Date.now() - this.postResumeSyncStartedAt
      : 0;
    this.options.onDebug("Post-resume synchronization complete");
    this.options.onDebug(`Post-resume sync duration: ${duration} ms`);
    this.awaitingFirstPostResumeTurn = true;
    this.finishHandoff();
    const queued = this.queuedLearnerText;
    if (queued) {
      this.firstPostResumeLearnerTurnAt = Date.now();
      this.awaitingFirstPostResumeTurn = false;
      this.options.onDebug("First post-resume learner turn sent");
      this.activeSocket?.sendLearnerText(queued);
      this.queuedLearnerText = null;
      this.postResumeState = "waiting-for-user";
      this.options.onDebug("Pending learner turn released after sync");
      return;
    }
    if (this.interruptedTutorContinuationRequired) {
      this.postResumeState = "continuing-interrupted-output";
      this.options.onDebug("Interrupted tutor continuation required");
      this.activeSocket?.sendRealtimeInput({
        text: "[[APP_CONTROL:CONTINUE_INTERRUPTED_TUTOR_TURN]]",
      });
      return;
    }
    this.postResumeState = "waiting-for-user";
    this.options.onDebug("Post-resume waiting for learner");
  }

  noteLearnerTurnReceived() {
    this.noteFirstPostResumeLearnerTurn();
  }

  ensureHealthy() {
    if (this.isHealthy() || this.state === "handoff" || this.state === "synchronizing" || this.state === "recovering") return;
    this.requestRollover("socket-failure", true);
  }

  requestSafeRolloverForTest() {
    this.options.onDebug("Force safe rollover requested");
    this.requestRollover("forced-safe", false);
  }

  requestImmediateRolloverForTest(invalidateHandle = false) {
    this.options.onDebug("Force immediate rollover requested");
    if (invalidateHandle) this.latestResumableHandle = "invalid-test-handle";
    this.requestRollover("forced-immediate", true);
  }

  close(sendAudioStreamEnd: boolean) {
    this.clearTimers();
    this.setState("closed");
    this.rolloverReason = null;
    this.rolloverRequestedAt = null;
    this.goAwayDeadlineAt = null;
    this.handoffBuffer = [];
    this.preparedToken = null;
    this.queuedLearnerText = null;
    this.postResumeState = "none";
    if (this.learnerSpeechEndTimer) clearTimeout(this.learnerSpeechEndTimer);
    if (this.interruptionEpochExpiryTimer) clearTimeout(this.interruptionEpochExpiryTimer);
    this.learnerSpeechEndTimer = null;
    this.interruptionEpochExpiryTimer = null;
    this.finishLearnerUtterance();
    const socket = this.activeSocket;
    this.activeSocket = null;
    if (socket) {
      this.intentionalSockets.add(socket);
      if (sendAudioStreamEnd) socket.sendRealtimeInput({ audioStreamEnd: true });
      socket.close();
    }
  }

  private createSocket() {
    let socket: GeminiLiveWebSocket;
    socket = new GeminiLiveWebSocket({
      onMessage: (message) => this.handleMessage(socket, message),
      onError: (message) => {
        if (socket === this.activeSocket) this.options.onDebug(`Realtime error: ${message}`);
      },
      onClose: ({ code, reason }) => {
        if (this.intentionalSockets.has(socket) || this.state === "closed") return;
        if (socket !== this.activeSocket) return;
        this.options.onDebug(`Live connection closed (${reason || `code ${code}`})`);
        this.requestRollover("socket-failure", true);
      },
    });
    return socket;
  }

  private handleMessage(socket: GeminiLiveWebSocket, message: LiveServerMessage) {
    if (socket !== this.activeSocket) return;
    const update = message.sessionResumptionUpdate;
    if (update) {
      if (update.resumable && update.newHandle) {
        this.latestResumableHandle = update.newHandle;
        this.latestResumableHandleUpdatedAt = Date.now();
        this.options.onDebug(`Resumption handle updated (${redactHandle(update.newHandle)})`);
      } else {
        this.options.onDebug("Resumption temporarily unavailable");
      }
    }
    if (message.goAway) {
      const timeLeftMs = parseDurationMs(message.goAway.timeLeft);
      this.options.onDebug(`GoAway received: ${message.goAway.timeLeft || "unknown"}`);
      this.options.onDebug(`GoAway deadline: ${timeLeftMs} ms`);
      if (this.state === "active") {
        this.options.onDebug("Rollover preparation started");
        this.setState("rollover-ready");
        this.options.onDebug("Rollover ready");
      }
      this.goAwayDeadlineAt = Date.now() + timeLeftMs;
      const emergency = timeLeftMs <= GO_AWAY_ROLLOVER_SAFETY_MS;
      this.requestRollover("go-away", emergency);
      if (!emergency) {
        this.forcedHandoffTimer = setTimeout(
          () => {
            this.options.onDebug("GoAway safety margin reached");
            if (this.learnerUtteranceOpen) {
              this.options.onDebug("Learner speech still active; rollover deadline reached");
            }
            this.requestRollover("go-away", true);
          },
          timeLeftMs - GO_AWAY_ROLLOVER_SAFETY_MS,
        );
      }
    }
    this.logFirstPostResumeEvent(message);
    if (this.state === "synchronizing" && message.serverContent) {
      if (!this.unexpectedSyncOutputLogged && hasAssistantOutput(message)) {
        this.unexpectedSyncOutputLogged = true;
        this.options.onDebug("Unexpected post-resume assistant output suppressed");
      }
      if (this.postResumeStateResponseSent && isTurnFinished(message)) {
        this.finishPostResumeSynchronization();
      }
      return;
    }
    if (this.postResumeState === "continuing-interrupted-output" && message.serverContent) {
      if (hasAssistantOutput(message) && !this.firstPostResumeResponseLogged) {
        this.firstPostResumeResponseLogged = true;
        this.options.onDebug("Interrupted tutor continuation started");
      }
      if (isTurnFinished(message)) {
        this.postResumeState = "waiting-for-user";
        this.interruptedTutorContinuationRequired = false;
        this.options.onDebug("Interrupted tutor continuation completed");
      }
    }
    this.options.onMessage(message);
  }

  private schedulePreparation() {
    if (this.prepareTimer) clearTimeout(this.prepareTimer);
    this.prepareTimer = setTimeout(() => {
      if (this.state !== "active") return;
      this.options.onDebug("Rollover preparation started");
      this.setState("rollover-ready");
      this.options.onDebug(
        this.latestResumableHandleUpdatedAt
          ? "Rollover ready"
          : "Rollover ready; waiting for a valid resumption handle",
      );
      void this.prepareReplacementToken();
    }, ROLLOVER_PREPARE_MS);
  }

  private requestRollover(reason: RolloverReason, emergency: boolean) {
    if (this.state === "closed") return;
    const firstRequest = this.rolloverReason === null;
    this.rolloverReason = reason;
    this.rolloverRequestedAt ??= Date.now();
    this.options.onDebug(`Rollover requested: ${reason}`);
    const speechDurationMs = this.learnerSpeaking && this.learnerSpeechStartedAt
      ? Date.now() - this.learnerSpeechStartedAt
      : 0;
    this.options.onDebug(
      `Learner speech active at request: ${this.learnerSpeaking} ` +
      `(active=${speechDurationMs} ms, utteranceOpen=${this.learnerUtteranceOpen})`,
    );
    if (emergency) {
      if (this.learnerUtteranceOpen) {
        this.options.onDebug("Emergency mid-speech rollover started");
      }
      void this.beginHandoff(true);
      return;
    }
    if (this.learnerUtteranceOpen) {
      if (firstRequest) {
        this.options.onDebug("Learner utterance active; rollover deferred");
        this.options.onDebug("Rollover pending for learner speech end");
      }
      return;
    }
    void this.tryRequestedRollover(false);
  }

  private async tryRequestedRollover(emergency: boolean) {
    if (!this.rolloverReason || this.state === "handoff" || this.state === "synchronizing" || this.state === "recovering") return;
    if (!emergency && (this.learnerUtteranceOpen || this.assistantSpeaking)) return;
    await this.beginHandoff(emergency);
  }

  private async beginHandoff(emergency = false) {
    if (this.state === "handoff" || this.state === "synchronizing" || this.state === "recovering" || this.state === "closed") return;
    this.clearTimers();
    const rolloverReason = this.rolloverReason ?? "socket-failure";
    const rolloverWaitMs = this.rolloverRequestedAt
      ? Date.now() - this.rolloverRequestedAt
      : 0;
    const deadlineRemainingMs = this.goAwayDeadlineAt
      ? Math.max(0, this.goAwayDeadlineAt - Date.now())
      : null;
    this.rolloverReason = null;
    this.rolloverRequestedAt = null;
    this.goAwayDeadlineAt = null;
    this.setState("handoff");
    this.handoffBuffer = [];
    this.handoffDropped = false;
    this.handoffDroppedDurationMs = 0;
    this.handoffStartedAt = Date.now();
    this.interruptedTutorContinuationRequired =
      this.assistantSpeaking && !this.learnerUtteranceOpen;
    if (this.learnerUtteranceOpen || (emergency && this.interruptionRegisteredForUtterance)) {
      this.learnerUtteranceSpansRollover = true;
    }
    this.options.onDebug("Audio handoff started");
    this.options.onDebug(
      `Handoff buffer started: capacity=${HANDOFF_BUFFER_DURATION_MS} ms/${HANDOFF_BUFFER_CAPACITY_BYTES} bytes`,
    );
    this.options.onDebug(
      `Rollover handoff: reason=${rolloverReason}, waited=${rolloverWaitMs} ms, emergency=${emergency}`,
    );
    if (deadlineRemainingMs !== null) {
      this.options.onDebug(`GoAway remaining at handoff: ${deadlineRemainingMs} ms`);
    }

    const oldSocket = this.activeSocket;
    this.activeSocket = null;
    if (oldSocket) {
      this.intentionalSockets.add(oldSocket);
      oldSocket.close();
      this.options.onDebug("Old WebSocket retired");
    }

    const handle = this.latestResumableHandle;
    if (handle) {
      try {
        const { token } = await this.takePreparedOrFreshToken();
        this.options.onDebug("Replacement WebSocket opening");
        const replacement = this.createSocket();
        this.activeSocket = replacement;
        await replacement.connect(token, {
          model: this.options.model,
          systemInstruction: this.options.systemInstruction,
          resumptionHandle: handle,
        });
        this.options.onDebug("Replacement setup complete");
        this.options.onDebug(`Replacement tutor voice configured: ${TUTOR_VOICE}`);
        this.options.onDebug("Session resumed successfully");
        this.startPostResumeSynchronization();
        return;
      } catch {
        this.options.onDebug("Session resumption failed");
      }
    } else {
      this.options.onDebug("Session resumption failed");
    }

    await this.recoverFreshSession();
  }

  private async recoverFreshSession() {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.setState("recovering");
    this.options.onDebug("Fresh-session recovery started");
    try {
      this.options.onDebug("Replacement token requested");
      const { token } = await this.options.requestToken();
      const replacement = this.createSocket();
      this.activeSocket = replacement;
      this.options.onDebug("Replacement WebSocket opening");
      await replacement.connect(token, {
        model: this.options.model,
        systemInstruction: this.options.systemInstruction,
      });
      this.options.onDebug("Replacement setup complete");
      this.options.onDebug(`Recovery tutor voice configured: ${TUTOR_VOICE}`);
      this.options.seedFreshRecovery(replacement);
      this.options.onDebug("Fresh-session recovery completed");
      this.finishHandoff();
      this.flushQueuedLearnerText();
    } catch (error) {
      this.setState("closed");
      this.handoffBuffer = [];
      this.options.onFatalError(
        error instanceof Error ? error.message : "Live session recovery failed",
      );
    }
  }

  private finishHandoff() {
    const socket = this.activeSocket;
    if (!socket) return;
    const bufferedDurationMs = this.handoffBuffer.reduce(
      (total, chunk) => total + pcmDurationMs(chunk.byteLength),
      0,
    );
    for (const chunk of this.handoffBuffer) {
      socket.sendRealtimeInput({
        audio: { data: arrayBufferToBase64(chunk), mimeType: "audio/pcm;rate=16000" },
      });
    }
    this.handoffBuffer = [];
    const handoffDurationMs = this.handoffStartedAt
      ? Date.now() - this.handoffStartedAt
      : 0;
    this.options.onDebug(
      `Handoff buffer flushed: buffered=${bufferedDurationMs} ms, ` +
      `dropped=${this.handoffDroppedDurationMs} ms, handoff=${handoffDurationMs} ms`,
    );
    this.handoffStartedAt = null;
    this.handoffDroppedDurationMs = 0;
    this.options.onDebug("Audio handoff complete");
    if (this.learnerUtteranceSpansRollover && !this.learnerSpeaking) {
      this.interruptionEpochExpiryTimer = setTimeout(() => {
        this.interruptionEpochExpiryTimer = null;
        if (!this.learnerSpeaking) this.finishLearnerUtterance();
      }, INTERRUPTION_EPOCH_POST_HANDOFF_GRACE_MS);
    }
    this.setState("active");
    this.schedulePreparation();
  }

  private startPostResumeSynchronization() {
    const socket = this.activeSocket;
    if (!socket) return;
    this.setState("synchronizing");
    this.postResumeState = "syncing";
    this.postResumeStateResponseSent = false;
    this.unexpectedSyncOutputLogged = false;
    this.syncAttempts = 1;
    this.postResumeSyncStartedAt = Date.now();
    this.firstPostResumeLearnerTurnAt = null;
    this.firstPostResumeGeminiEventLogged = false;
    this.firstPostResumeToolLogged = false;
    this.firstPostResumeResponseLogged = false;
    this.firstPostResumeAudioLogged = false;
    this.options.onDebug("Post-resume synchronization started");
    this.options.onDebug("Post-resume sync entered silent mode");
    socket.sendRealtimeInput({ text: "[[APP_CONTROL:POST_RESUME_SYNC]]" });
    this.scheduleSyncTimeout();
  }

  private scheduleSyncTimeout() {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      if (this.state !== "synchronizing") return;
      if (this.postResumeStateResponseSent) {
        const socket = this.activeSocket;
        this.activeSocket = null;
        if (socket) {
          this.intentionalSockets.add(socket);
          socket.close();
        }
        this.options.onDebug("Post-resume synchronization failed");
        void this.recoverFreshSession();
        return;
      }
      if (this.syncAttempts < 2) {
        this.syncAttempts += 1;
        this.activeSocket?.sendRealtimeInput({ text: "[[APP_CONTROL:POST_RESUME_SYNC]]" });
        this.scheduleSyncTimeout();
        return;
      }
      const socket = this.activeSocket;
      this.activeSocket = null;
      if (socket) {
        this.intentionalSockets.add(socket);
        socket.close();
      }
      this.options.onDebug("Post-resume synchronization failed");
      void this.recoverFreshSession();
    }, POST_RESUME_SYNC_TIMEOUT_MS);
  }

  private async prepareReplacementToken() {
    if (this.preparingTokenPromise) return this.preparingTokenPromise;
    this.preparingTokenPromise = (async () => {
      try {
        const token = await this.options.requestToken();
        if (this.state === "closed") return;
        this.preparedToken = token;
        this.options.onDebug("Replacement token prepared");
      } catch {
        this.preparedToken = null;
        this.options.onDebug("Replacement token preparation deferred");
      } finally {
        this.preparingTokenPromise = null;
      }
    })();
    return this.preparingTokenPromise;
  }

  private async takePreparedOrFreshToken() {
    if (this.preparingTokenPromise) await this.preparingTokenPromise;
    const prepared = this.preparedToken;
    this.preparedToken = null;
    if (prepared) {
      if (!prepared.newSessionExpiresAt ||
          prepared.newSessionExpiresAt - Date.now() > PREPARED_TOKEN_MIN_VALIDITY_MS) {
        return prepared;
      }
      this.options.onDebug("Prepared token expired; refreshing");
    }
    this.options.onDebug("Replacement token requested");
    return this.options.requestToken();
  }

  private flushQueuedLearnerText() {
    const queued = this.queuedLearnerText;
    this.queuedLearnerText = null;
    if (!queued) return;
    this.firstPostResumeLearnerTurnAt = Date.now();
    this.awaitingFirstPostResumeTurn = false;
    this.options.onDebug("First post-resume learner turn sent");
    this.activeSocket?.sendLearnerText(queued);
  }

  private noteFirstPostResumeLearnerTurn() {
    if (!this.awaitingFirstPostResumeTurn && this.state !== "synchronizing") return;
    if (this.firstPostResumeLearnerTurnAt) return;
    this.firstPostResumeLearnerTurnAt = Date.now();
    this.awaitingFirstPostResumeTurn = false;
    this.options.onDebug("First post-resume learner turn received");
  }

  private openLearnerUtterance() {
    if (this.learnerUtteranceOpen) return;
    this.learnerUtteranceOpen = true;
    this.currentLearnerUtteranceId = ++this.learnerUtteranceSequence;
    this.interruptionRegisteredForUtterance = false;
    this.learnerUtteranceSpansRollover = false;
    this.options.onDebug(
      `Learner utterance started: utterance-${this.currentLearnerUtteranceId}`,
    );
  }

  private finishLearnerUtterance() {
    if (this.interruptionEpochExpiryTimer) {
      clearTimeout(this.interruptionEpochExpiryTimer);
      this.interruptionEpochExpiryTimer = null;
    }
    const finishedId = this.currentLearnerUtteranceId;
    this.learnerUtteranceOpen = false;
    this.currentLearnerUtteranceId = null;
    this.interruptionRegisteredForUtterance = false;
    this.learnerUtteranceSpansRollover = false;
    if (finishedId !== null) {
      this.options.onDebug(`Learner utterance ended: utterance-${finishedId}`);
    }
  }

  private logFirstPostResumeEvent(message: LiveServerMessage) {
    const started = this.firstPostResumeLearnerTurnAt;
    if (!started) return;
    const elapsed = Date.now() - started;
    if (!this.firstPostResumeGeminiEventLogged &&
        (message.toolCall || message.serverContent)) {
      this.firstPostResumeGeminiEventLogged = true;
      this.options.onDebug(`First post-resume Gemini event (${elapsed} ms after learner turn)`);
    }
    if (message.toolCall && !this.firstPostResumeToolLogged) {
      this.firstPostResumeToolLogged = true;
      this.options.onDebug(`First post-resume tool call received (${elapsed} ms)`);
    }
    const serverContent = message.serverContent;
    if (serverContent?.outputTranscription?.text && !this.firstPostResumeResponseLogged) {
      this.firstPostResumeResponseLogged = true;
      this.options.onDebug(`First post-resume response started (${elapsed} ms)`);
    }
    const hasAudio = serverContent?.modelTurn?.parts?.some(
      (part) => part.inlineData?.mimeType?.startsWith("audio/") && part.inlineData.data,
    );
    if (hasAudio && !this.firstPostResumeAudioLogged) {
      this.firstPostResumeAudioLogged = true;
      this.options.onDebug(`First post-resume assistant audio started (${elapsed} ms)`);
      this.firstPostResumeLearnerTurnAt = null;
    }
  }

  private setState(state: LiveTransportState) {
    this.state = state;
    this.options.onStateChange(state);
  }

  private clearTimers() {
    if (this.prepareTimer) clearTimeout(this.prepareTimer);
    if (this.forcedHandoffTimer) clearTimeout(this.forcedHandoffTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.prepareTimer = null;
    this.forcedHandoffTimer = null;
    this.syncTimer = null;
  }
}

function parseDurationMs(value?: string) {
  if (!value) return 0;
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)s$/);
  return match ? Number(match[1]) * 1_000 : 0;
}

function hasAssistantOutput(message: LiveServerMessage) {
  const content = message.serverContent;
  return Boolean(
    content?.outputTranscription?.text ||
    content?.modelTurn?.parts?.some((part) => part.inlineData?.data || part.text),
  );
}

function isTurnFinished(message: LiveServerMessage) {
  const content = message.serverContent;
  return content?.generationComplete === true || content?.turnComplete === true;
}

function redactHandle(handle: string) {
  return handle.length <= 8 ? "redacted" : `${handle.slice(0, 4)}…${handle.slice(-4)}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pcmDurationMs(byteLength: number) {
  return Math.round(
    byteLength / (INPUT_SAMPLE_RATE * INPUT_BYTES_PER_SAMPLE) * 1_000,
  );
}
