"use client";

import { useEffect, useRef, useState } from "react";

type MicrophoneStatus =
  | "Not active"
  | "Requesting permission"
  | "Active"
  | "Permission denied"
  | "Error";

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

export default function Home() {
  const [microphoneStatus, setMicrophoneStatus] =
    useState<MicrophoneStatus>("Not active");
  const [debugMessages, setDebugMessages] = useState<DebugMessage[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const isMountedRef = useRef(true);
  const nextMessageIdRef = useRef(0);

  const addDebugMessage = (text: string) => {
    const message: DebugMessage = {
      id: nextMessageIdRef.current++,
      timestamp: new Date().toLocaleTimeString(),
      text,
    };

    setDebugMessages((messages) => [...messages, message]);
  };

  const stopMicrophone = () => {
    streamRef.current?.getAudioTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      stopMicrophone();
    };
  }, []);

  const startConversation = async () => {
    setMicrophoneStatus("Requesting permission");
    addDebugMessage("Microphone permission requested");

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access is not supported by this browser");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      if (!isMountedRef.current) {
        stream.getAudioTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      setMicrophoneStatus("Active");
      addDebugMessage("Microphone active");
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }

      const permissionDenied =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");

      if (permissionDenied) {
        setMicrophoneStatus("Permission denied");
        addDebugMessage("Microphone permission denied");
        return;
      }

      setMicrophoneStatus("Error");
      addDebugMessage(`Microphone error: ${getMicrophoneErrorMessage(error)}`);
    }
  };

  const stopConversation = () => {
    stopMicrophone();
    setMicrophoneStatus("Not active");
    addDebugMessage("Microphone stopped");
  };

  const microphoneActive = microphoneStatus === "Active";
  const requestingPermission = microphoneStatus === "Requesting permission";

  return (
    <main className="page-shell">
      <section className="tutor-card" aria-labelledby="page-title">
        <header className="hero">
          <p className="eyebrow">Learning workspace</p>
          <h1 id="page-title">Conversational AI Tutor</h1>
          <p className="intro">
            A simple workspace for future realtime, voice-guided lessons.
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
          <div className="status-item">
            <span className="status-dot" aria-hidden="true" />
            <span>
              <strong>AI connection</strong>
              <small>Not connected</small>
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
              ? "Requesting Permission…"
              : "Start Conversation"}
        </button>

        <section className="transcript" aria-labelledby="transcript-title">
          <div className="panel-heading">
            <h2 id="transcript-title">Transcript / Debug</h2>
            <span>{microphoneActive ? "Microphone active" : "Idle"}</span>
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
