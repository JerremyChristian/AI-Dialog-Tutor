"use client";

import type { FunctionCall, LiveServerMessage } from "@google/genai";
import { useEffect, useRef, useState } from "react";
import { LearningSourceUpload } from "../components/learning-source-upload";
import { GeminiLiveWebSocket } from "../lib/gemini-live-websocket";
import type {
  LearningSource,
  PreparedLearningSource,
} from "../lib/learning-source";
import {
  MicrophonePcmStreamer,
  PcmAudioPlayer,
  arrayBufferToBase64,
} from "../lib/realtime-audio";
import {
  buildLessonInstruction,
  completeLessonConcept,
  createLessonState,
  deriveResumePoint,
  GEMINI_LIVE_MODEL,
  getCurrentConcept,
  getLessonTreeRows,
  mergeTranscript,
  navigateLessonState,
  queryLessonState,
  skipLessonNode,
  type LessonState,
} from "../lib/lesson-state";

type MicrophoneStatus =
  | "Not active"
  | "Requesting permission"
  | "Active"
  | "Permission denied"
  | "Error";

type AiConnectionStatus = "Not connected" | "Connecting" | "Connected" | "Error";

type DebugMessage = {
  id: number;
  timestamp: string;
  text: string;
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function getMicrophoneErrorMessage(error: unknown) {
  if (!(error instanceof DOMException)) {
    return error instanceof Error ? error.message : "Unknown microphone error";
  }

  switch (error.name) {
    case "NotFoundError":
      return "No microphone was found";
    case "NotReadableError":
      return "The microphone is unavailable or in use by another application";
    case "OverconstrainedError":
      return "No microphone matches the requested audio settings";
    case "AbortError":
      return "Microphone access was interrupted";
    default:
      return error.message || error.name;
  }
}

function getRealtimeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Gemini Live error";
}

export default function Home() {
  const [microphoneStatus, setMicrophoneStatus] =
    useState<MicrophoneStatus>("Not active");
  const [aiConnectionStatus, setAiConnectionStatus] =
    useState<AiConnectionStatus>("Not connected");
  const [debugMessages, setDebugMessages] = useState<DebugMessage[]>([]);
  const [currentUtterance, setCurrentUtterance] = useState("");
  const [userError, setUserError] = useState("");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosInstallHint, setShowIosInstallHint] = useState(false);
  const [topicInput, setTopicInput] = useState("");
  const [lessonState, setLessonState] = useState<LessonState>(() =>
    createLessonState("Uploaded material"),
  );
  const [learningSource, setLearningSource] = useState<LearningSource | null>(null);
  const preparedSourceRef = useRef<PreparedLearningSource | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<GeminiLiveWebSocket | null>(null);
  const microphoneStreamerRef = useRef<MicrophonePcmStreamer | null>(null);
  const playerRef = useRef<PcmAudioPlayer | null>(null);
  const tokenRequestRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const conversationRunRef = useRef(0);
  const assistantSpeakingRef = useRef(false);
  const assistantTurnActiveRef = useRef(false);
  const userTranscriptRef = useRef("");
  const assistantTranscriptRef = useRef("");
  const lessonStateRef = useRef(lessonState);
  const resumptionPendingRef = useRef(false);
  const sourceGroundingPendingRef = useRef(false);
  const toolResultsRef = useRef(new Map<string, Record<string, unknown>>());
  const cancelledToolCallIdsRef = useRef(new Set<string>());
  const nextMessageIdRef = useRef(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const lessonActiveRef = useRef(false);

  const addDebugMessage = (text: string) => {
    if (!isMountedRef.current) return;

    setDebugMessages((messages) => [
      ...messages,
      {
        id: nextMessageIdRef.current++,
        timestamp: new Date().toLocaleTimeString(),
        text,
      },
    ]);
  };

  const updateLessonState = (
    update: (current: LessonState) => LessonState,
  ) => {
    const next = update(lessonStateRef.current);
    lessonStateRef.current = next;
    setLessonState(next);
  };

  const disposeResources = async (sendAudioStreamEnd: boolean) => {
    tokenRequestRef.current?.abort();
    tokenRequestRef.current = null;

    const microphoneStreamer = microphoneStreamerRef.current;
    microphoneStreamerRef.current = null;
    await microphoneStreamer?.stop();

    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      if (sendAudioStreamEnd) {
        try {
          session.sendRealtimeInput({ audioStreamEnd: true });
        } catch {
          // The WebSocket may already be closed.
        }
      }
      session.close();
    }

    streamRef.current?.getAudioTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const player = playerRef.current;
    playerRef.current = null;
    await player?.close();
    assistantSpeakingRef.current = false;
    assistantTurnActiveRef.current = false;
    resumptionPendingRef.current = false;
    sourceGroundingPendingRef.current = false;
    toolResultsRef.current.clear();
    cancelledToolCallIdsRef.current.clear();
    lessonActiveRef.current = false;
    await wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  };

  const requestWakeLock = async () => {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
      addDebugMessage("Screen wake lock active");
    } catch {
      addDebugMessage("Screen wake lock unavailable");
    }
  };

  useEffect(() => {
    isMountedRef.current = true;

    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    setShowIosInstallHint(/iPad|iPhone|iPod/.test(navigator.userAgent) && !standalone);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && lessonActiveRef.current) {
        void requestWakeLock();
        void playerRef.current?.prepare().catch(() => {
          setUserError("Audio was suspended. End the lesson, then start again.");
          addDebugMessage("Audio context could not resume after backgrounding");
        });
      } else if (document.visibilityState === "hidden" && lessonActiveRef.current) {
        addDebugMessage("App backgrounded; mobile audio or connection may be suspended");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      isMountedRef.current = false;
      conversationRunRef.current += 1;
      void disposeResources(false);
    };
  }, []);

  const handleLiveMessage = (message: LiveServerMessage) => {
    if (message.toolCallCancellation?.ids) {
      for (const id of message.toolCallCancellation.ids) {
        cancelledToolCallIdsRef.current.add(id);
      }
    }

    if (message.toolCall?.functionCalls?.length) {
      handleLessonToolCalls(message.toolCall.functionCalls);
      return;
    }

    const serverContent = message.serverContent;
    if (serverContent?.inputTranscription?.text) {
      const wasInterrupted = lessonStateRef.current.status === "interrupted";
      userTranscriptRef.current = mergeTranscript(
        userTranscriptRef.current,
        serverContent.inputTranscription.text,
      );
      setCurrentUtterance(userTranscriptRef.current);
      updateLessonState((current) => ({
        ...current,
        status:
          current.status === "interrupted"
            ? "resolving-interruption"
            : current.status,
        lastUserTranscript: userTranscriptRef.current,
      }));

      if (wasInterrupted) {
        addDebugMessage("Resolving learner interruption");
      }
    }

    if (serverContent?.outputTranscription?.text) {
      if (!assistantTurnActiveRef.current) {
        assistantTurnActiveRef.current = true;
        assistantTranscriptRef.current = "";
      }
      assistantTranscriptRef.current = mergeTranscript(
        assistantTranscriptRef.current,
        serverContent.outputTranscription.text,
      );
      setCurrentUtterance(assistantTranscriptRef.current);
      updateLessonState((current) => ({
        ...current,
        lastAssistantTranscript: assistantTranscriptRef.current,
      }));
    }

    if (serverContent?.interrupted) {
      // Gemini cuts playback immediately. Smoothing a mid-phoneme cutoff is a
      // later UX refinement; yielding to the learner remains the priority.
      playerRef.current?.clear();
      assistantSpeakingRef.current = false;
      assistantTurnActiveRef.current = false;

      const current = lessonStateRef.current;
      const interruptedTranscript =
        assistantTranscriptRef.current || current.lastAssistantTranscript;
      const currentConcept = getCurrentConcept(current)?.title || "current concept";
      const resumePoint = deriveResumePoint(
        interruptedTranscript,
        currentConcept,
      );
      updateLessonState((state) => ({
        ...state,
        status: "interrupted",
        resumePoint,
        interruptionCount: state.interruptionCount + 1,
        lastAssistantTranscript: interruptedTranscript,
      }));
      resumptionPendingRef.current = true;
      addDebugMessage("Assistant interrupted");
      addDebugMessage(`Resume point saved: ${resumePoint}`);
    }

    const voiceActivity = message.voiceActivity?.voiceActivityType;
    if (voiceActivity === "ACTIVITY_START") {
      userTranscriptRef.current = "";
      addDebugMessage("User speech started");
      if (lessonStateRef.current.status === "interrupted") {
        updateLessonState((current) => ({
          ...current,
          status: "resolving-interruption",
        }));
        addDebugMessage("Resolving learner interruption");
      }
    } else if (voiceActivity === "ACTIVITY_END") {
      addDebugMessage("User speech ended");
    }

    if (!serverContent) return;

    for (const part of serverContent.modelTurn?.parts ?? []) {
      const audio = part.inlineData;
      if (!audio?.data || !audio.mimeType?.startsWith("audio/")) continue;

      if (!assistantSpeakingRef.current) {
        assistantSpeakingRef.current = true;
        sourceGroundingPendingRef.current = false;
        if (!assistantTurnActiveRef.current) {
          assistantTurnActiveRef.current = true;
          assistantTranscriptRef.current = "";
        }
        if (resumptionPendingRef.current) {
          updateLessonState((current) => ({
            ...current,
            status: "resuming",
          }));
          addDebugMessage("Lesson resuming");
        }
        addDebugMessage("Assistant response started");
      }
      playerRef.current?.play(audio.data);
    }

    if (serverContent.generationComplete) {
      assistantSpeakingRef.current = false;
      assistantTurnActiveRef.current = false;
      updateLessonState((state) => ({
        ...state,
        status: state.status === "idle" ? "idle" : "teaching",
        lastAssistantTranscript:
          assistantTranscriptRef.current || state.lastAssistantTranscript,
      }));
      resumptionPendingRef.current = false;
      addDebugMessage("Assistant response completed");
    }
  };

  const handleLessonToolCalls = (calls: FunctionCall[]) => {
    const functionResponses: Array<Record<string, unknown>> = [];

    for (const call of calls) {
      const id = call.id;
      if (!id || cancelledToolCallIdsRef.current.has(id)) continue;

      const cached = toolResultsRef.current.get(id);
      if (cached) {
        functionResponses.push({ id, name: call.name || "lesson_state", response: cached });
        continue;
      }

      addDebugMessage("Lesson tool call received");
      let result;
      let events: string[] = [];
      const args = call.args ?? {};
      const action = args.action;
      const conceptId = args.conceptId;

      if (call.name !== "lesson_state") {
        result = { ok: false, error: `Unknown function: ${call.name || "missing"}` };
      } else if (action === "query") {
        result = queryLessonState(lessonStateRef.current);
        addDebugMessage("Lesson state queried");
      } else if (
        (action === "navigate" || action === "complete" || action === "skip") &&
        typeof conceptId === "string" && conceptId
      ) {
        if (action === "complete") {
          const requestedNode = lessonStateRef.current.nodes[conceptId];
          addDebugMessage(
            `Atomic concept completion requested: ${requestedNode?.title || conceptId}`,
          );
        }
        const transition = action === "navigate"
          ? navigateLessonState(lessonStateRef.current, conceptId)
          : action === "complete"
            ? completeLessonConcept(lessonStateRef.current, conceptId)
            : skipLessonNode(lessonStateRef.current, conceptId);
        result = transition.result;
        events = transition.events;
        if (transition.state !== lessonStateRef.current) {
          lessonStateRef.current = transition.state;
          setLessonState(transition.state);
        }
      } else {
        const snapshot = queryLessonState(lessonStateRef.current);
        result = {
          ...snapshot,
          ok: false,
          message:
            action === "navigate" || action === "complete" || action === "skip"
              ? `conceptId is required for ${action}`
              : "action must be navigate, complete, skip, or query",
        };
      }

      for (const event of events) addDebugMessage(event);
      const response = { result };
      toolResultsRef.current.set(id, response);
      functionResponses.push({ id, name: "lesson_state", response });
    }

    if (functionResponses.length === 0) return;
    if (sessionRef.current?.sendToolResponse(functionResponses)) {
      addDebugMessage("Lesson state tool response sent");
    } else {
      addDebugMessage("Realtime error: Live connection closed before lesson state response");
    }
  };

  const startConversation = async () => {
    setUserError("");
    if (
      learningSource?.status !== "ready" ||
      !preparedSourceRef.current
    ) {
      addDebugMessage("Source grounding failed: a ready learning source is required");
      return;
    }

    const activeSource = learningSource;
    const preparedSource = preparedSourceRef.current;
    const lessonFocus = topicInput.trim();
    const lessonTopic = lessonFocus || `Main topics in ${activeSource.name}`;
    const initialLessonState = createLessonState(
      lessonTopic,
      preparedSource.lessonTree,
    );
    lessonStateRef.current = initialLessonState;
    setLessonState(initialLessonState);
    setTopicInput(lessonFocus);
    userTranscriptRef.current = "";
    assistantTranscriptRef.current = "";
    setCurrentUtterance("");
    resumptionPendingRef.current = false;
    addDebugMessage(`Lesson initialized from source: ${activeSource.name}`);
    addDebugMessage("Lesson tree initialized");
    const firstConcept = getCurrentConcept(initialLessonState);
    if (firstConcept) {
      if (firstConcept.teaching) {
        addDebugMessage(`Teaching contract loaded: ${firstConcept.title}`);
      }
      addDebugMessage(`Atomic concept started: ${firstConcept.title}`);
    }

    const run = ++conversationRunRef.current;
    setMicrophoneStatus("Requesting permission");
    setAiConnectionStatus("Not connected");
    addDebugMessage("Microphone permission requested");

    const player = new PcmAudioPlayer();
    playerRef.current = player;
    const playerReady = player.prepare();

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access is not supported by this browser");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isMountedRef.current || run !== conversationRunRef.current) {
        stream.getAudioTracks().forEach((track) => track.stop());
        await player.close();
        return;
      }

      streamRef.current = stream;
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.addEventListener("ended", () => {
          if (!isMountedRef.current || run !== conversationRunRef.current) return;
          setUserError("The microphone stopped unexpectedly. Start the lesson again.");
          addDebugMessage("Microphone stream ended unexpectedly");
          conversationRunRef.current += 1;
          setMicrophoneStatus("Not active");
          setAiConnectionStatus("Not connected");
          updateLessonState((current) => ({ ...current, status: "idle" }));
          void disposeResources(false);
        }, { once: true });
      }
      setMicrophoneStatus("Active");
      addDebugMessage("Microphone active");
      await playerReady;

      setAiConnectionStatus("Connecting");
      addDebugMessage("Gemini token requested");
      const tokenRequest = new AbortController();
      tokenRequestRef.current = tokenRequest;
      const tokenResponse = await fetch("/api/gemini-token", {
        method: "POST",
        cache: "no-store",
        signal: tokenRequest.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: lessonFocus,
          source: {
            name: activeSource.name,
            mimeType: activeSource.mimeType,
          },
        }),
      });
      const tokenBody = (await tokenResponse.json()) as {
        token?: string;
        error?: string;
        source?: {
          name: string;
          mimeType: string;
        };
      };

      if (!tokenResponse.ok || !tokenBody.token || !tokenBody.source) {
        throw new Error(tokenBody.error || "Gemini token request failed");
      }
      if (!isMountedRef.current || run !== conversationRunRef.current) return;

      tokenRequestRef.current = null;
      addDebugMessage("Gemini token received");
      addDebugMessage("Live connection opening");
      const systemInstruction = buildLessonInstruction(
        lessonFocus,
        tokenBody.source.name,
      );

      const session = new GeminiLiveWebSocket({
        onMessage: (message) => {
          if (isMountedRef.current && run === conversationRunRef.current) {
            handleLiveMessage(message);
          }
        },
        onError: (message) => {
          if (isMountedRef.current && run === conversationRunRef.current) {
            setAiConnectionStatus("Error");
            setUserError(`Gemini Live connection failed: ${message}`);
            if (sourceGroundingPendingRef.current) {
              addDebugMessage(`Source grounding failed: ${message}`);
            }
            addDebugMessage(`Realtime error: ${message}`);
          }
        },
        onClose: ({ code, reason }) => {
          if (isMountedRef.current && run === conversationRunRef.current) {
            setAiConnectionStatus("Not connected");
            const closeDetails = reason
              ? `${reason} (code ${code})`
              : `code ${code}`;
            setUserError("The realtime connection ended. Start the lesson again when ready.");
            if (sourceGroundingPendingRef.current) {
              addDebugMessage(
                `Source grounding failed: Live connection closed before the first response (${closeDetails})`,
              );
            }
            addDebugMessage(`Live connection closed (${closeDetails})`);
            const hadMicrophone = Boolean(streamRef.current);
            conversationRunRef.current += 1;
            void disposeResources(false).then(() => {
              if (isMountedRef.current && hadMicrophone) {
                setMicrophoneStatus("Not active");
                updateLessonState((current) => ({
                  ...current,
                  status: "idle",
                }));
                addDebugMessage("Microphone stopped");
              }
            });
          }
        },
      });
      await session.connect(tokenBody.token, {
        model: GEMINI_LIVE_MODEL,
        systemInstruction,
      });

      if (!isMountedRef.current || run !== conversationRunRef.current) {
        session.close();
        return;
      }

      sessionRef.current = session;
      setAiConnectionStatus("Connected");
      addDebugMessage("Live connection established");
      sourceGroundingPendingRef.current = true;
      addDebugMessage("Source seeding started");
      session.seedInitialSource({
        ...preparedSource,
        focus: lessonFocus,
      });
      addDebugMessage("Source seeded into Live context");
      addDebugMessage("Source grounding ready");

      const microphoneStreamer = new MicrophonePcmStreamer(stream, (chunk) => {
        if (run !== conversationRunRef.current || sessionRef.current !== session) return;

        session.sendRealtimeInput({
          audio: {
            data: arrayBufferToBase64(chunk),
            mimeType: "audio/pcm;rate=16000",
          },
        });
      });
      microphoneStreamerRef.current = microphoneStreamer;
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
      addDebugMessage("Lesson started");
      lessonActiveRef.current = true;
      void requestWakeLock();
      session.sendRealtimeInput({
        text: `Begin the source-grounded spoken lesson now. Identify the uploaded material as "${tokenBody.source.name}", briefly preview what you will cover, then teach the first concept${
          lessonFocus ? ` related to ${lessonFocus}` : " from the source"
        }.`,
      });
    } catch (error) {
      if (!isMountedRef.current || run !== conversationRunRef.current) return;

      const permissionDenied =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");

      if (permissionDenied) {
        setMicrophoneStatus("Permission denied");
        setUserError("Microphone permission was denied. Allow access in browser settings and try again.");
        addDebugMessage("Microphone permission denied");
        await disposeResources(false);
        return;
      }

      if (streamRef.current) {
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
    }
  };

  const stopConversation = async () => {
    conversationRunRef.current += 1;
    const hadMicrophone = Boolean(streamRef.current);
    const hadSession = Boolean(sessionRef.current);
    setMicrophoneStatus("Not active");
    setAiConnectionStatus("Not connected");
    updateLessonState((current) => ({ ...current, status: "idle" }));
    await disposeResources(true);

    if (hadMicrophone) addDebugMessage("Microphone stopped");
    if (hadSession) addDebugMessage("Live connection closed");
  };

  const microphoneActive = microphoneStatus === "Active";
  const aiConnected = aiConnectionStatus === "Connected";
  const requestingPermission = microphoneStatus === "Requesting permission";
  const currentTeachingContract = getCurrentConcept(lessonState)?.teaching;
  const currentConcept = getCurrentConcept(lessonState);
  const lessonActive = microphoneActive || requestingPermission || aiConnected;

  const requestInstall = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  return (
    <main className="page-shell">
      <section className={`tutor-card${lessonActive ? " lesson-active" : ""}`} aria-labelledby="page-title">
        <header className="hero">
          <p className="eyebrow">Learning workspace</p>
          <h1 id="page-title">Conversational AI Tutor</h1>
          <p className="intro setup-only">
            A simple workspace for realtime, voice-guided conversation.
          </p>
        </header>

        <div className="setup-only">
          <LearningSourceUpload
            source={learningSource}
            disabled={microphoneActive || requestingPermission}
            onChange={setLearningSource}
            onPreparedChange={(source) => {
              preparedSourceRef.current = source;
              if (!source) {
                const resetState = createLessonState("Uploaded material");
                lessonStateRef.current = resetState;
                setLessonState(resetState);
              }
            }}
            onDebug={addDebugMessage}
          />
        </div>

        <label className="topic-field setup-only">
          <span>Lesson topic or focus (optional)</span>
          <input
            type="text"
            value={topicInput}
            onChange={(event) => setTopicInput(event.target.value)}
            placeholder="Leave blank to teach the source's main topics"
            maxLength={160}
            disabled={microphoneActive || requestingPermission}
          />
        </label>

        {learningSource && lessonActive && (
          <section className="active-summary" aria-label="Active lesson overview">
            <p className="active-source" title={learningSource.name}>{learningSource.name}</p>
            <p className="active-label">Current concept</p>
            <h2>{currentConcept?.title || "Preparing lesson…"}</h2>
            <p className="current-utterance">
              {currentUtterance
                ? `“${currentUtterance}”`
                : "Listening for the lesson to begin…"}
            </p>
          </section>
        )}

        {userError && <p className="session-error" role="alert">{userError}</p>}

        <div className="status-row" aria-label="Conversation status">
          <div className="status-item" aria-live="polite">
            <span
              className={`status-dot${microphoneActive ? " status-dot-active" : ""}`}
              aria-hidden="true"
            />
            <span>
              <strong>Microphone</strong>
              <small>{microphoneStatus}</small>
            </span>
          </div>
          <div className="status-item" aria-live="polite">
            <span
              className={`status-dot${aiConnected ? " status-dot-active" : ""}`}
              aria-hidden="true"
            />
            <span>
              <strong>Connection</strong>
              <small>{aiConnectionStatus}</small>
            </span>
          </div>
        </div>

        <button
          className="start-button"
          type="button"
          onClick={microphoneActive ? stopConversation : startConversation}
          disabled={
            requestingPermission ||
            (!microphoneActive && learningSource?.status !== "ready")
          }
        >
          {microphoneActive
            ? "End Lesson"
            : requestingPermission
              ? "Requesting Permission..."
              : "Start Conversation"}
        </button>

        <section className="lesson-state" aria-labelledby="lesson-state-title">
          <div className="panel-heading">
            <h2 id="lesson-state-title">Lesson State</h2>
            <span>Development</span>
          </div>
          <dl className="engineering-state">
            <div>
              <dt>Topic</dt>
              <dd>{lessonState.topic}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{lessonState.status}</dd>
            </div>
            <div>
              <dt>Current concept</dt>
              <dd>{getCurrentConcept(lessonState)?.title || "-"}</dd>
            </div>
            <div>
              <dt>Resume point</dt>
              <dd>{lessonState.resumePoint || "-"}</dd>
            </div>
            <div>
              <dt>Interruptions</dt>
              <dd>{lessonState.interruptionCount}</dd>
            </div>
            <div>
              <dt>Latest learner transcript</dt>
              <dd>{lessonState.lastUserTranscript || "-"}</dd>
            </div>
            <div>
              <dt>Latest tutor transcript</dt>
              <dd>{lessonState.lastAssistantTranscript || "-"}</dd>
            </div>
          </dl>
          <div className="coverage-map">
            <h3>Lesson Coverage</h3>
            {lessonState.rootNodeIds.length === 0 ? (
              <p>No lesson tree loaded.</p>
            ) : (
              <ol>
                {getLessonTreeRows(lessonState).map(({ node, depth }) => (
                  <li
                    key={node.id}
                    className={
                      node.id === lessonState.currentNodeId
                        ? "coverage-current"
                        : undefined
                    }
                    style={{ paddingLeft: `${Math.min(depth * 16, 48)}px` }}
                  >
                    <span aria-hidden="true">
                      {node.id === lessonState.currentNodeId
                        ? "▶"
                        : node.status === "taught"
                          ? "✓"
                          : node.status === "partial"
                            ? "◐"
                            : node.status === "skipped"
                              ? "○"
                              : "·"}
                    </span>
                    <strong>{node.title}</strong>
                    <small>{node.status.replace("-", " ")}</small>
                  </li>
                ))}
              </ol>
            )}
          </div>
          {currentTeachingContract && (
            <div className="teaching-contract">
              <h3>Current Teaching Contract</h3>
              <p className="contract-meta">
                {currentTeachingContract.type.replace("-", " ")} · {currentTeachingContract.importance}
                {currentTeachingContract.sourceConfidence
                  ? ` · ${currentTeachingContract.sourceConfidence}`
                  : ""}
              </p>
              <h4>Objective</h4>
              <p>{currentTeachingContract.objective}</p>
              <h4>Teaching points</h4>
              <ul>
                {currentTeachingContract.teachingPoints.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <h4>Completion criteria</h4>
              <ul>
                {currentTeachingContract.completionCriteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
              {currentTeachingContract.sourceReferences?.length ? (
                <p><strong>Source:</strong> {currentTeachingContract.sourceReferences.join(", ")}</p>
              ) : null}
              {currentTeachingContract.keyTerms?.length ? (
                <p><strong>Terms:</strong> {currentTeachingContract.keyTerms.join(", ")}</p>
              ) : null}
              {currentTeachingContract.notation?.length ? (
                <p><strong>Notation:</strong> {currentTeachingContract.notation.join(", ")}</p>
              ) : null}
              {currentTeachingContract.uncertaintyNote ? (
                <p><strong>Uncertainty:</strong> {currentTeachingContract.uncertaintyNote}</p>
              ) : null}
            </div>
          )}
        </section>

        <details className="transcript">
          <summary id="transcript-title">Show Debug</summary>
          <div className="transcript-body" role="log" aria-live="polite" aria-labelledby="transcript-title">
            {debugMessages.length === 0 ? (
              <p>Conversation events and transcript messages will appear here.</p>
            ) : (
              <ol className="debug-messages">
                {debugMessages.map((message) => (
                  <li key={message.id}>
                    <time>{message.timestamp}</time> {message.text}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </details>

        {!lessonActive && (installPrompt || showIosInstallHint) && (
          <aside className="install-hint">
            {installPrompt ? (
              <button type="button" onClick={requestInstall}>Install AI Tutor</button>
            ) : (
              <p>On iPhone or iPad: open in Safari, tap Share, then Add to Home Screen.</p>
            )}
          </aside>
        )}
      </section>
    </main>
  );
}
