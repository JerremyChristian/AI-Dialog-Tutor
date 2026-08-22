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

const MODEL = "gemini-3.1-flash-live-preview";
const SYSTEM_INSTRUCTION =
  "You are a friendly conversational tutor. Have a natural spoken conversation with the learner. Keep responses concise and conversational. Do not start teaching a structured course yet.";

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

  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const microphoneStreamerRef = useRef<MicrophonePcmStreamer | null>(null);
  const playerRef = useRef<PcmAudioPlayer | null>(null);
  const tokenRequestRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const conversationRunRef = useRef(0);
  const assistantSpeakingRef = useRef(false);
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
    const voiceActivity = message.voiceActivity?.voiceActivityType;
    if (voiceActivity === VoiceActivityType.ACTIVITY_START) {
      addDebugMessage("User speech started");
    } else if (voiceActivity === VoiceActivityType.ACTIVITY_END) {
      addDebugMessage("User speech ended");
    }

    const serverContent = message.serverContent;
    if (!serverContent) return;

    if (serverContent.interrupted) {
      playerRef.current?.clear();
      assistantSpeakingRef.current = false;
      addDebugMessage("Assistant response interrupted");
    }

    for (const part of serverContent.modelTurn?.parts ?? []) {
      const audio = part.inlineData;
      if (!audio?.data || !audio.mimeType?.startsWith("audio/")) continue;

      if (!assistantSpeakingRef.current) {
        assistantSpeakingRef.current = true;
        addDebugMessage("Assistant response started");
      }
      playerRef.current?.play(audio.data);
    }

    if (serverContent.generationComplete) {
      assistantSpeakingRef.current = false;
      addDebugMessage("Assistant response completed");
    }
  };

  const startConversation = async () => {
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

      const ai = new GoogleGenAI({
        apiKey: tokenBody.token,
        httpOptions: { apiVersion: "v1beta" },
      });
      const session = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
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
