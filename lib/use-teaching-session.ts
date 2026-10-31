"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { AudioSession } from "./audio-session";
import {
  ACOUSTIC_ACTIVITY_MULTIPLIER,
  ACOUSTIC_LOG_COOLDOWN_MS,
  MIN_ACOUSTIC_RMS,
  NOISE_FLOOR_SMOOTHING,
  pcm16Rms,
} from "./engagement";
import {
  buildLessonInstruction,
  createLessonState,
  GEMINI_LIVE_MODEL,
  getCurrentConcept,
  isLessonPlanComplete,
  LESSON_WRAP_UP_CONTROL,
  PERSISTED_LESSON_RESUME_CONTROL,
  queryLessonState,
  type LessonSessionStartMode,
  type LessonState,
} from "./lesson-state";
import { getPersistedResumeContext } from "./lesson-snapshot";
import type { LiveProviderMessage } from "./live-message-events";
import {
  LiveTransportManager,
  type LiveTransportState,
} from "./live-transport-manager";
import type { RecentTeachingContextEntry } from "./local-persistence";
import type { ActiveTeachingBeat } from "./teaching-beat-runtime";
import type { TeachingPreferences } from "./teaching-preferences";
import {
  buildNewLessonStartPrefix,
  getMicrophoneErrorMessage,
  getRealtimeErrorMessage,
  isMicrophonePermissionDenied,
  planStartupImperative,
  type AiConnectionStatus,
  type MicrophoneStatus,
} from "./teaching-session";
import { emitTestEvent } from "./test-observability";
import type { useLessonWorkspace } from "./use-lesson-workspace";

// Realtime teaching session lifecycle: conversation runs, token requests, the
// Live transport and its callbacks, startup seeding and the single startup
// imperative, stop, restart and disposal. It coordinates the page's existing
// modules (AudioSession, the lesson workspace, the beat runtime, review and
// farewell controllers) through refs and callbacks passed in, and never decides
// lesson progress itself. Operations are intentionally recreated each render
// (not memoized), so transport callbacks capture the same render's page
// handlers and workspace values as before the extraction.
export type TeachingSessionInput = {
  // Page-allocated refs shared with the workspace and the message handlers,
  // which need them before this hook is called.
  isMountedRef: RefObject<boolean>;
  conversationRunRef: RefObject<number>;
  transportRef: RefObject<LiveTransportManager | null>;
  lessonActiveRef: RefObject<boolean>;
  lessonStartupPendingRef: RefObject<boolean>;
  lessonStateRef: RefObject<LessonState>;
  lessonWrapUpRef: RefObject<boolean>;
  teachingPreferencesRef: RefObject<TeachingPreferences>;
  recentTeachingContextRef: RefObject<RecentTeachingContextEntry[]>;
  persistedResumeBriefingPendingRef: RefObject<boolean>;
  persistedResumeFirstResponseLoggedRef: RefObject<boolean>;
  audioSession: AudioSession;
  // This render's workspace; start/stop read its values at call time.
  workspace: ReturnType<typeof useLessonWorkspace>;
  // Page-owned state setters.
  setLessonState: (state: LessonState) => void;
  updateLessonState: (update: (current: LessonState) => LessonState) => void;
  setMicrophoneStatus: (status: MicrophoneStatus) => void;
  setAiConnectionStatus: (status: AiConnectionStatus) => void;
  setUserError: (message: string) => void;
  setRestartConfirmationOpen: (open: boolean) => void;
  addDebugMessage: (text: string) => void;
  // Page-owned operations, coordinated but not reimplemented here.
  handleLiveMessage: (message: LiveProviderMessage) => void;
  onTransportStateChange: (state: LiveTransportState) => void;
  markProviderGenerationRequested: () => void;
  canForwardMicrophone: () => boolean;
  resetConversationForStart: () => void;
  pauseLessonForStop: () => LessonState;
  invalidateActiveTeachingBeat: (reason: string) => void;
  assignNextTeachingBeat: (prefix?: string) => ActiveTeachingBeat | null;
  beginIdleMonitoring: () => void;
  resetSessionState: () => void;
  resetSessionTimersAndControls: () => void;
  resetCurrentLessonProgress: () => Promise<boolean>;
};

export function useTeachingSession(input: TeachingSessionInput) {
  const {
    isMountedRef,
    conversationRunRef,
    transportRef,
    lessonActiveRef,
    lessonStartupPendingRef,
    lessonStateRef,
    lessonWrapUpRef,
    teachingPreferencesRef,
    recentTeachingContextRef,
    persistedResumeBriefingPendingRef,
    persistedResumeFirstResponseLoggedRef,
    audioSession,
    workspace,
    setLessonState,
    updateLessonState,
    setMicrophoneStatus,
    setAiConnectionStatus,
    setUserError,
    setRestartConfirmationOpen,
    addDebugMessage,
    handleLiveMessage,
    onTransportStateChange,
    markProviderGenerationRequested,
    canForwardMicrophone,
    resetConversationForStart,
    pauseLessonForStop,
    invalidateActiveTeachingBeat,
    assignNextTeachingBeat,
    beginIdleMonitoring,
    resetSessionState,
    resetSessionTimersAndControls,
    resetCurrentLessonProgress,
  } = input;
  const [restartPending, setRestartPending] = useState(false);
  const restartPendingRef = useRef(false);
  const restartActiveLessonRef = useRef<() => Promise<void>>(async () => undefined);
  const tokenRequestRef = useRef<AbortController | null>(null);
  // Run that set lessonStartupPendingRef; only that run may clear it in finally.
  const lessonStartupRunRef = useRef(0);
  const noiseFloorRef = useRef(0.004);
  const lastAcousticLogAtRef = useRef(0);

  // Captured before the first await: a newer run may install its own audio
  // resources while this disposal is suspended, and those are not ours to release.
  // Every caller bumps the run before capturing; only a newer startConversation
  // changes it again, so a mismatch after an await means this session was replaced
  // and the shared page/session state now belongs to the newer run.
  const captureDisposalOwnership = () => ({
    ...audioSession.captureResources(),
    run: conversationRunRef.current,
    transport: transportRef.current,
  });

  // Callers that await before disposing (stopConversation) capture first and pass it in.
  const disposeResources = async (
    sendAudioStreamEnd: boolean,
    owned = captureDisposalOwnership(),
  ) => {
    const { run } = owned;
    if (run === conversationRunRef.current) invalidateActiveTeachingBeat("resources-disposed");
    tokenRequestRef.current?.abort();
    tokenRequestRef.current = null;

    await audioSession.stopStreamer(owned.streamer);

    owned.transport?.close(sendAudioStreamEnd);
    if (transportRef.current === owned.transport) transportRef.current = null;

    audioSession.stopTracks(owned.stream);

    await audioSession.closePlayer(owned.player);
    if (run === conversationRunRef.current) resetSessionState();
    await audioSession.releaseWakeLock(owned.wakeLock);
    if (run === conversationRunRef.current) resetSessionTimersAndControls();
  };

  const startConversation = async () => {
    emitTestEvent("lesson.start-requested", { lessonId: workspace.savedLessonIdRef.current });
    setUserError("");
    workspace.setPersistenceNotice("");
    if (
      workspace.learningSource?.status !== "ready" ||
      !workspace.preparedSourceRef.current
    ) {
      addDebugMessage("Source grounding failed: a ready learning source is required");
      return;
    }

    lessonStartupPendingRef.current = true;
    workspace.invalidatePendingHydration();

    const activeSource = workspace.learningSource;
    const preparedSource = workspace.preparedSourceRef.current;
    const lessonFocus = workspace.topicInput.trim();
    const lessonTopic = lessonFocus || `Main topics in ${activeSource.name}`;
    const continuingSavedLesson = workspace.resumeExistingLessonRef.current;
    const sessionStartMode: LessonSessionStartMode = continuingSavedLesson
      ? "persisted-resume"
      : "new";
    const persistedResumeContext = continuingSavedLesson
      ? getPersistedResumeContext(
          lessonStateRef.current,
          recentTeachingContextRef.current,
        )
      : null;
    const sessionInitialTeachingPreferences = { ...teachingPreferencesRef.current };
    const requestFreshToken = async () => {
      addDebugMessage("Gemini token requested");
      const controller = new AbortController();
      tokenRequestRef.current = controller;
      const response = await fetch("/api/gemini-token", {
        method: "POST",
        cache: "no-store",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: lessonFocus,
          source: { name: activeSource.name, mimeType: activeSource.mimeType },
          teachingPreferences: teachingPreferencesRef.current,
        }),
      });
      const body = (await response.json()) as {
        token?: string;
        newSessionExpiresAt?: number;
        error?: string;
        source?: { name: string; mimeType: string };
      };
      if (!response.ok || !body.token || !body.source) {
        throw new Error(body.error || "Gemini token request failed");
      }
      if (tokenRequestRef.current === controller) tokenRequestRef.current = null;
      addDebugMessage("Gemini token received");
      return {
        token: body.token,
        source: body.source,
        newSessionExpiresAt: body.newSessionExpiresAt,
      };
    };
    const initialLessonState = continuingSavedLesson
      ? lessonStateRef.current
      : createLessonState(lessonTopic, preparedSource.lessonTree);
    lessonWrapUpRef.current = isLessonPlanComplete(initialLessonState);
    if (!continuingSavedLesson) {
      lessonStateRef.current = initialLessonState;
      setLessonState(initialLessonState);
    }
    const startingConcept = getCurrentConcept(initialLessonState);
    if (startingConcept?.teaching) {
      addDebugMessage(
        `Teaching contract progress: concept=${startingConcept.title}, ` +
        `next=${initialLessonState.teachingContractProgress[startingConcept.id]
          ?.nextTeachingPointIndex ?? 0}, total=${startingConcept.teaching.teachingPoints.length}`,
      );
    }
    workspace.setTopicInput(lessonFocus);
    resetConversationForStart();
    addDebugMessage(
      continuingSavedLesson
        ? `Saved lesson continuation initialized: ${activeSource.name}`
        : `Lesson initialized from source: ${activeSource.name}`,
    );
    addDebugMessage(continuingSavedLesson ? "Saved lesson tree restored" : "Lesson tree initialized");
    addDebugMessage(
      `Teaching preferences initialized: depth=${sessionInitialTeachingPreferences.explanationDepth}, ` +
      `speakingSpeed=${sessionInitialTeachingPreferences.speakingSpeed}`,
    );
    const firstConcept = getCurrentConcept(initialLessonState);
    if (firstConcept) {
      if (firstConcept.teaching) {
        addDebugMessage(`Teaching contract loaded: ${firstConcept.title}`);
      }
      addDebugMessage(`Atomic concept started: ${firstConcept.title}`);
    }

    const run = ++conversationRunRef.current;
    lessonStartupRunRef.current = run;
    setMicrophoneStatus("Requesting permission");
    setAiConnectionStatus("Not connected");
    addDebugMessage("Microphone permission requested");

    // Synchronous inside the click: prepare() resumes playback for iOS, then
    // getUserMedia starts in the same tick. Permission is awaited before playerReady.
    const { player, ready: playerReady } = audioSession.createPlayer();

    try {
      const stream = await audioSession.requestMicrophone();
      if (!isMountedRef.current || run !== conversationRunRef.current) {
        stream.getAudioTracks().forEach((track) => track.stop());
        await player.close();
        return;
      }

      audioSession.attachStream(stream, () => {
        if (!isMountedRef.current || run !== conversationRunRef.current) return;
        setUserError("The microphone stopped unexpectedly. Start the lesson again.");
        addDebugMessage("Microphone stream ended unexpectedly");
        conversationRunRef.current += 1;
        setMicrophoneStatus("Not active");
        setAiConnectionStatus("Not connected");
        updateLessonState((current) => ({ ...current, status: "idle" }));
        void disposeResources(false);
      });
      setMicrophoneStatus("Active");
      addDebugMessage("Microphone active");
      await playerReady;
      if (!isMountedRef.current || run !== conversationRunRef.current) return;

      setAiConnectionStatus("Connecting");
      const tokenBody = await requestFreshToken();
      if (!isMountedRef.current || run !== conversationRunRef.current) return;

      addDebugMessage("Live connection opening");
      const systemInstruction = buildLessonInstruction(
        lessonFocus,
        tokenBody.source.name,
        sessionInitialTeachingPreferences,
        sessionStartMode,
      );

      const transport = new LiveTransportManager({
        model: GEMINI_LIVE_MODEL,
        systemInstruction,
        requestToken: requestFreshToken,
        onMessage: (message) => {
          if (isMountedRef.current && run === conversationRunRef.current) {
            handleLiveMessage(message);
          }
        },
        onDebug: addDebugMessage,
        onStateChange: (state) => {
          if (!isMountedRef.current || run !== conversationRunRef.current) return;
          onTransportStateChange(state);
        },
        onGenerationRequested: () => {
          if (isMountedRef.current && run === conversationRunRef.current) {
            markProviderGenerationRequested();
          }
        },
        seedFreshRecovery: (socket) => {
          const coverage = queryLessonState(lessonStateRef.current);
          socket.seedRecoveryContext({ ...preparedSource, focus: lessonFocus }, {
            coverage,
            currentTeachingContract: getCurrentConcept(lessonStateRef.current)?.teaching,
            contractProgress: coverage.currentTeachingProgress,
            resumePoint: lessonStateRef.current.resumePoint,
            teachingPreferences: teachingPreferencesRef.current,
          });
        },
        onFatalError: (message) => {
          if (!isMountedRef.current || run !== conversationRunRef.current) return;
          setUserError(`The realtime lesson could not recover: ${message}`);
          setAiConnectionStatus("Error");
          setMicrophoneStatus("Not active");
          updateLessonState((current) => ({ ...current, status: "idle" }));
          conversationRunRef.current += 1;
          void disposeResources(false);
        },
      });
      transportRef.current = transport;
      const session = await transport.connectInitial(tokenBody.token);

      if (!isMountedRef.current || run !== conversationRunRef.current) {
        transport.close(false);
        return;
      }

      setAiConnectionStatus("Connected");
      emitTestEvent("live.setup-complete");
      addDebugMessage("Live connection established");
      addDebugMessage("Source seeding started");
      if (continuingSavedLesson) {
        const current = getCurrentConcept(lessonStateRef.current);
        const contractNext = current?.teaching
          ? lessonStateRef.current.teachingContractProgress[current.id]?.nextTeachingPointIndex ?? 0
          : 0;
        const coverage = queryLessonState(lessonStateRef.current);
        session.seedRecoveryContext({ ...preparedSource, focus: lessonFocus }, {
          coverage,
          currentTeachingContract: getCurrentConcept(lessonStateRef.current)?.teaching,
          contractProgress: coverage.currentTeachingProgress,
          persistedResumeContext,
          resumePoint: lessonStateRef.current.resumePoint,
          teachingPreferences: teachingPreferencesRef.current,
        });
        addDebugMessage(
          `Persisted resume seed: concept=${persistedResumeContext?.currentConceptTitle || "current lesson topic"}, ` +
          `status=${persistedResumeContext?.currentConceptStatus || "unknown"}, ` +
          `resumePointAvailable=${persistedResumeContext?.resumePointAvailable ? "yes" : "no"}, ` +
          `recentContextEntries=${persistedResumeContext?.recentTeachingContext.length ?? 0}`,
        );
        addDebugMessage(
          `Persisted contract resume: concept=${current?.title || "current lesson topic"}, ` +
          `next=${contractNext}, total=${current?.teaching?.teachingPoints.length ?? 0}`,
        );
        addDebugMessage(
          `Persisted resume context delivered: ` +
          `recentContextEntries=${persistedResumeContext?.recentTeachingContext.length ?? 0}, ` +
          `resumePointAvailable=${persistedResumeContext?.resumePointAvailable ? "yes" : "no"}`,
        );
      } else {
        session.seedInitialSource({
          ...preparedSource,
          focus: lessonFocus,
        });
      }
      addDebugMessage("Source seeded into Live context");
      addDebugMessage("Source grounding ready");

      const microphoneStreamer = audioSession.createStreamer(stream, (chunk) => {
        if (run !== conversationRunRef.current || transportRef.current !== transport) return;
        const rms = pcm16Rms(chunk);
        noiseFloorRef.current += (rms - noiseFloorRef.current) * NOISE_FLOOR_SMOOTHING;
        if (rms >= Math.max(MIN_ACOUSTIC_RMS, noiseFloorRef.current * ACOUSTIC_ACTIVITY_MULTIPLIER)) {
          if (Date.now() - lastAcousticLogAtRef.current >= ACOUSTIC_LOG_COOLDOWN_MS) {
            lastAcousticLogAtRef.current = Date.now();
            addDebugMessage("Acoustic activity detected");
          }
        }
        if (canForwardMicrophone()) transport.sendAudio(chunk);
      });
      await microphoneStreamer.start();

      if (!isMountedRef.current || run !== conversationRunRef.current) {
        await microphoneStreamer.stop();
        return;
      }

      addDebugMessage("Microphone streaming started");
      updateLessonState((current) => ({
        ...current,
        status: "teaching",
      }));
      workspace.markLessonStarted();
      addDebugMessage("Lesson started");
      lessonActiveRef.current = true;
      lessonStartupPendingRef.current = false;
      beginIdleMonitoring();
      void audioSession.requestWakeLock();
      const startupImperative = planStartupImperative({
        wrapUp: lessonWrapUpRef.current,
        sessionStartMode,
      });
      if (startupImperative === "wrap-up") {
        addDebugMessage("Completed lesson restored in wrap-up");
        transportRef.current?.sendGenerationRequest(LESSON_WRAP_UP_CONTROL);
      } else if (startupImperative === "persisted-resume") {
        const current = getCurrentConcept(lessonStateRef.current);
        const resumePoint = lessonStateRef.current.resumePoint.trim();
        addDebugMessage("Persisted lesson continuation started");
        addDebugMessage(`Resume briefing requested: concept=${current?.title || "current lesson topic"}`);
        addDebugMessage(`Resume point available: ${resumePoint ? "yes" : "no"}`);
        addDebugMessage(
          `Teaching preferences on resume: depth=${sessionInitialTeachingPreferences.explanationDepth}, ` +
          `speakingSpeed=${sessionInitialTeachingPreferences.speakingSpeed}`,
        );
        persistedResumeFirstResponseLoggedRef.current = false;
        persistedResumeBriefingPendingRef.current = Boolean(assignNextTeachingBeat(
          PERSISTED_LESSON_RESUME_CONTROL,
        ));
        if (persistedResumeBriefingPendingRef.current) {
          addDebugMessage("Resume briefing control sent");
        }
      } else {
        assignNextTeachingBeat(buildNewLessonStartPrefix(tokenBody.source.name, lessonFocus));
      }
    } catch (error) {
      if (!isMountedRef.current || run !== conversationRunRef.current) return;

      if (isMicrophonePermissionDenied(error)) {
        setMicrophoneStatus("Permission denied");
        setUserError("Microphone permission was denied. Allow access in browser settings and try again.");
        addDebugMessage("Microphone permission denied");
        await disposeResources(false);
        return;
      }

      if (audioSession.hasMicrophoneStream) {
        setAiConnectionStatus("Error");
        const message = getRealtimeErrorMessage(error);
        if (message.toLowerCase().includes("source")) {
          addDebugMessage(`Source grounding failed: ${message}`);
        }
        addDebugMessage(`Realtime error: ${message}`);
        setUserError(`The realtime lesson could not start: ${message}`);
        await disposeResources(false);
        setMicrophoneStatus("Not active");
        updateLessonState((current) => ({ ...current, status: "idle" }));
        addDebugMessage("Microphone stopped");
      } else {
        setMicrophoneStatus("Error");
        const message = getMicrophoneErrorMessage(error);
        setUserError(message);
        addDebugMessage(`Microphone error: ${message}`);
        await player.close();
      }
    } finally {
      if (lessonStartupRunRef.current === run) lessonStartupPendingRef.current = false;
    }
  };

  const stopConversation = async (reason?: "inactivity" | "confirmed") => {
    conversationRunRef.current += 1;
    const ownedDisposal = captureDisposalOwnership();
    invalidateActiveTeachingBeat("lesson-ended");
    audioSession.player?.clear();
    const hadMicrophone = audioSession.hasMicrophoneStream;
    const hadSession = Boolean(transportRef.current);
    const stoppedLessonState = pauseLessonForStop();
    const persistedCurrent = getCurrentConcept(stoppedLessonState);
    setMicrophoneStatus("Not active");
    setAiConnectionStatus("Not connected");
    lessonStateRef.current = stoppedLessonState;
    setLessonState(stoppedLessonState);
    addDebugMessage(
      `Persisting resume state: concept=${persistedCurrent
        ? `${persistedCurrent.id}/${persistedCurrent.title}`
        : "none"}, status=${persistedCurrent?.status || "none"}, ` +
      `resumePointAvailable=${stoppedLessonState.resumePoint ? "yes" : "no"}, ` +
      `recentContextEntries=${recentTeachingContextRef.current.length}`,
    );
    if (persistedCurrent?.teaching) {
      addDebugMessage(
        `Persisting teaching progress: concept=${persistedCurrent.id}/${persistedCurrent.title}, ` +
        `next=${stoppedLessonState.teachingContractProgress[persistedCurrent.id]
          ?.nextTeachingPointIndex ?? 0}, total=${persistedCurrent.teaching.teachingPoints.length}`,
      );
    }
    await workspace.persistCurrentLesson(stoppedLessonState);
    await disposeResources(true, ownedDisposal);

    if (reason === "inactivity") {
      setUserError("The lesson ended after no response to the inactivity check.");
    } else if (reason === "confirmed") {
      setUserError("The lesson has ended.");
    }

    if (hadMicrophone) addDebugMessage("Microphone stopped");
    if (hadSession) addDebugMessage("Live connection closed");
  };

  const restartLesson = async () => {
    if (restartPendingRef.current || !workspace.resumeExistingLessonRef.current) return;
    restartPendingRef.current = true;
    setRestartPending(true);
    setRestartConfirmationOpen(false);
    try {
      if (lessonActiveRef.current) await stopConversation();
      if (await resetCurrentLessonProgress()) await startConversation();
    } finally {
      restartPendingRef.current = false;
      setRestartPending(false);
    }
  };
  restartActiveLessonRef.current = restartLesson;

  // Mount-only on purpose: the unmount disposal uses the first render's
  // disposeResources and page reset callbacks, exactly as the page effect did.
  useEffect(() => {
    isMountedRef.current = true;

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && lessonActiveRef.current) {
        void audioSession.requestWakeLock();
        transportRef.current?.ensureHealthy();
        void audioSession.player?.prepare().catch(() => {
          setUserError("Audio was suspended. End the lesson, then start again.");
          addDebugMessage("Audio context could not resume after backgrounding");
        });
      } else if (document.visibilityState === "hidden" && lessonActiveRef.current) {
        addDebugMessage("App backgrounded; mobile audio or connection may be suspended");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      isMountedRef.current = false;
      conversationRunRef.current += 1;
      void disposeResources(false);
    };
  }, []);

  return {
    startConversation,
    stopConversation,
    restartLesson,
    restartPending,
    restartPendingRef,
    restartActiveLessonRef,
  };
}
