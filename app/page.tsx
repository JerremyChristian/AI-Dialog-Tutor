"use client";

import {
  GoogleGenAI,
  Modality,
  VoiceActivityType,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import { useEffect, useRef, useState } from "react";
import {
  MicrophonePcmStreamer,
  PcmAudioPlayer,
  arrayBufferToBase64,
} from "../lib/realtime-audio";
import {
  buildLessonInstruction,
  createLessonState,
  DEFAULT_LESSON_TOPIC,
  deriveConcept,
  deriveResumePoint,
  GEMINI_LIVE_MODEL,
  mergeTranscript,
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
  const [topicInput, setTopicInput] = useState(DEFAULT_LESSON_TOPIC);
  const [lessonState, setLessonState] = useState<LessonState>(() =>
    createLessonState(DEFAULT_LESSON_TOPIC),
  );

  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<Session | null>(null);
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
  const nextMessageIdRef = useRef(0);

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
  };

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      conversationRunRef.current += 1;
      void disposeResources(false);
    };
  }, []);

  const handleLiveMessage = (message: LiveServerMessage) => {
    const serverContent = message.serverContent;
    if (serverContent?.inputTranscription?.text) {
      const wasInterrupted = lessonStateRef.current.status === "interrupted";
      userTranscriptRef.current = mergeTranscript(
        userTranscriptRef.current,
        serverContent.inputTranscription.text,
      );
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
      const currentConcept = deriveConcept(
        interruptedTranscript,
        current.currentConcept,
      );
      const resumePoint = deriveResumePoint(
        interruptedTranscript,
        currentConcept,
      );
      updateLessonState((state) => ({
        ...state,
        status: "interrupted",
        currentConcept,
        resumePoint,
        interruptionCount: state.interruptionCount + 1,
        lastAssistantTranscript: interruptedTranscript,
      }));
      resumptionPendingRef.current = true;
      addDebugMessage("Assistant interrupted");
      addDebugMessage(`Resume point saved: ${resumePoint}`);
    }

    const voiceActivity = message.voiceActivity?.voiceActivityType;
    if (voiceActivity === VoiceActivityType.ACTIVITY_START) {
      userTranscriptRef.current = "";
      addDebugMessage("User speech started");
      if (lessonStateRef.current.status === "interrupted") {
        updateLessonState((current) => ({
          ...current,
          status: "resolving-interruption",
        }));
        addDebugMessage("Resolving learner interruption");
      }
    } else if (voiceActivity === VoiceActivityType.ACTIVITY_END) {
      addDebugMessage("User speech ended");
    }

    if (!serverContent) return;

    for (const part of serverContent.modelTurn?.parts ?? []) {
      const audio = part.inlineData;
      if (!audio?.data || !audio.mimeType?.startsWith("audio/")) continue;

      if (!assistantSpeakingRef.current) {
        assistantSpeakingRef.current = true;
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
      const current = lessonStateRef.current;
      const nextConcept = deriveConcept(
        assistantTranscriptRef.current,
        current.currentConcept,
      );
      updateLessonState((state) => ({
        ...state,
        status: state.status === "idle" ? "idle" : "teaching",
        currentConcept: nextConcept,
        lastAssistantTranscript:
          assistantTranscriptRef.current || state.lastAssistantTranscript,
      }));
      if (nextConcept !== current.currentConcept) {
        addDebugMessage(`Current concept updated: ${nextConcept}`);
      }
      resumptionPendingRef.current = false;
      addDebugMessage("Assistant response completed");
    }
  };

  const startConversation = async () => {
    const lessonTopic = topicInput.trim() || DEFAULT_LESSON_TOPIC;
    const initialLessonState = createLessonState(lessonTopic);
    lessonStateRef.current = initialLessonState;
    setLessonState(initialLessonState);
    setTopicInput(lessonTopic);
    userTranscriptRef.current = "";
    assistantTranscriptRef.current = "";
    resumptionPendingRef.current = false;
    addDebugMessage(`Lesson initialized: ${lessonTopic}`);

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
        body: JSON.stringify({ topic: lessonTopic }),
      });
      const tokenBody = (await tokenResponse.json()) as {
        token?: string;
        error?: string;
      };

      if (!tokenResponse.ok || !tokenBody.token) {
        throw new Error(tokenBody.error || "Gemini token request failed");
      }
      if (!isMountedRef.current || run !== conversationRunRef.current) return;

      tokenRequestRef.current = null;
      addDebugMessage("Gemini token received");
      addDebugMessage("Live connection opening");
      const systemInstruction = buildLessonInstruction(lessonTopic);

      const ai = new GoogleGenAI({
        apiKey: tokenBody.token,
        httpOptions: { apiVersion: "v1beta" },
      });
      const session = await ai.live.connect({
        model: GEMINI_LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction,
        },
        callbacks: {
          onopen: () => {
            if (isMountedRef.current && run === conversationRunRef.current) {
              setAiConnectionStatus("Connected");
              addDebugMessage("Live connection established");
            }
          },
          onmessage: (message) => {
            if (isMountedRef.current && run === conversationRunRef.current) {
              handleLiveMessage(message);
            }
          },
          onerror: (event) => {
            if (isMountedRef.current && run === conversationRunRef.current) {
              setAiConnectionStatus("Error");
              addDebugMessage(`Realtime error: ${event.message || "WebSocket error"}`);
            }
          },
          onclose: () => {
            if (isMountedRef.current && run === conversationRunRef.current) {
              setAiConnectionStatus("Not connected");
              addDebugMessage("Live connection closed");
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
        },
      });

      if (!isMountedRef.current || run !== conversationRunRef.current) {
        session.close();
        return;
      }

      sessionRef.current = session;
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
      session.sendRealtimeInput({
        text: `Begin the spoken lesson about ${lessonTopic} now. Briefly preview the lesson, then teach the first concept.`,
      });
    } catch (error) {
      if (!isMountedRef.current || run !== conversationRunRef.current) return;

      const permissionDenied =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");

      if (permissionDenied) {
        setMicrophoneStatus("Permission denied");
        addDebugMessage("Microphone permission denied");
        await disposeResources(false);
        return;
      }

      if (streamRef.current) {
        setAiConnectionStatus("Error");
        addDebugMessage(`Realtime error: ${getRealtimeErrorMessage(error)}`);
        await disposeResources(false);
        setMicrophoneStatus("Not active");
        updateLessonState((current) => ({ ...current, status: "idle" }));
        addDebugMessage("Microphone stopped");
      } else {
        setMicrophoneStatus("Error");
        addDebugMessage(`Microphone error: ${getMicrophoneErrorMessage(error)}`);
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

  return (
    <main className="page-shell">
      <section className="tutor-card" aria-labelledby="page-title">
        <header className="hero">
          <p className="eyebrow">Learning workspace</p>
          <h1 id="page-title">Conversational AI Tutor</h1>
          <p className="intro">
            A simple workspace for realtime, voice-guided conversation.
          </p>
        </header>

        <label className="topic-field">
          <span>Lesson topic</span>
          <input
            type="text"
            value={topicInput}
            onChange={(event) => setTopicInput(event.target.value)}
            maxLength={160}
            disabled={microphoneActive || requestingPermission}
          />
        </label>

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
              <strong>AI connection</strong>
              <small>{aiConnectionStatus}</small>
            </span>
          </div>
        </div>

        <button
          className="start-button"
          type="button"
          onClick={microphoneActive ? stopConversation : startConversation}
          disabled={requestingPermission}
        >
          {microphoneActive
            ? "Stop Conversation"
            : requestingPermission
              ? "Requesting Permission..."
              : "Start Conversation"}
        </button>

        <section className="lesson-state" aria-labelledby="lesson-state-title">
          <div className="panel-heading">
            <h2 id="lesson-state-title">Lesson State</h2>
            <span>Development</span>
          </div>
          <dl>
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
              <dd>{lessonState.currentConcept || "-"}</dd>
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
        </section>

        <section className="transcript" aria-labelledby="transcript-title">
          <div className="panel-heading">
            <h2 id="transcript-title">Transcript / Debug</h2>
            <span>{aiConnected ? "Live conversation" : "Idle"}</span>
          </div>
          <div className="transcript-body" role="log" aria-live="polite">
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
        </section>
      </section>
    </main>
  );
}
