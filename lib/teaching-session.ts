import type { LessonSessionStartMode } from "./lesson-state";
import type { LiveTransportState } from "./live-transport-manager";

// Pure decisions used by the realtime teaching session lifecycle in the page.
// No sends, refs or React state: callers keep every side effect and its order.

export type AiConnectionStatus = "Not connected" | "Connecting" | "Connected" | "Error";

export type StartupImperative = "wrap-up" | "persisted-resume" | "new";

export function getMicrophoneErrorMessage(error: unknown) {
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

export function getRealtimeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Gemini Live error";
}

export function isMicrophonePermissionDenied(error: unknown) {
  return error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError");
}

export function aiConnectionStatusForTransportState(state: LiveTransportState): AiConnectionStatus {
  return state === "active" || state === "rollover-ready"
    ? "Connected"
    : state === "closed"
      ? "Not connected"
      : "Connecting";
}

// Selects the single proactive startup imperative; the caller sends it.
export function planStartupImperative({ wrapUp, sessionStartMode }: {
  wrapUp: boolean;
  sessionStartMode: LessonSessionStartMode;
}): StartupImperative {
  if (wrapUp) return "wrap-up";
  if (sessionStartMode === "persisted-resume") return "persisted-resume";
  return "new";
}

// Model-facing text: any change here is a provider-visible behavior change.
export function buildNewLessonStartPrefix(sourceName: string, focus: string) {
  return `Begin the source-grounded spoken lesson now. Identify the uploaded material as "${sourceName}", briefly preview what you will cover, then teach the assigned first presentation beat${
    focus ? ` related to ${focus}` : " from the source"
  }.`;
}
