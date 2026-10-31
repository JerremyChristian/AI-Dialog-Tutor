import { IDLE_AFTER_MS, type EngagementState } from "./engagement";

// Pure idle-engagement decisions (active → possibly-idle → confirming →
// ended). The page owns the engagement ref/state, the check interval, the
// confirmation timer, the transport and stopConversation, and applies these
// decisions in its existing order.

export const IDLE_CONFIRMATION_CONTROL_TEXT = "[[APP_CONTROL:IDLE_CONFIRMATION]]";

export function canRequestIdleConfirmation(lessonActive: boolean, state: EngagementState) {
  return lessonActive && state !== "confirming";
}

// Interval tick: only an active lesson in the active state can become idle.
// A missing activity timestamp counts as "just now".
export function shouldRequestIdleConfirmation(
  lessonActive: boolean,
  state: EngagementState,
  lastMeaningfulActivityAt: number | null,
  now: number,
) {
  if (!lessonActive || state !== "active") return false;
  return now - (lastMeaningfulActivityAt ?? now) >= IDLE_AFTER_MS;
}

// The confirmation timer ends the session only if still confirming.
export function shouldEndForInactivity(state: EngagementState) {
  return state === "confirming";
}

export function shouldLogMeaningfulActivity(state: EngagementState) {
  return state === "active";
}

// Meaningful learner speech refreshes activity while active; while
// confirming it is only remembered until session_control resolves.
export type MeaningfulSpeechEffect = "mark-activity" | "note-confirmation-speech" | "none";

export function classifyMeaningfulSpeech(state: EngagementState): MeaningfulSpeechEffect {
  if (state === "active") return "mark-activity";
  if (state === "confirming") return "note-confirmation-speech";
  return "none";
}

export type QuickResponse = "Yes" | "Repeat" | "Continue";

export type QuickResponsePlan = {
  text: string;
  idleEffect: "resume-active" | "restart-confirmation-timer" | "none";
};

export function planQuickResponse(response: QuickResponse, confirming: boolean): QuickResponsePlan {
  let text = response === "Yes"
    ? "Yes."
    : response === "Repeat"
      ? "Please repeat or re-explain the last explanation."
      : "Continue with the lesson.";
  if (confirming && response === "Repeat") {
    text = "Please repeat the question asking whether I want to continue.";
  }
  const idleEffect = !confirming
    ? "none"
    : response === "Repeat"
      ? "restart-confirmation-timer"
      : "resume-active";
  return { text, idleEffect };
}

// How the page applies a resolved idle confirmation from session_control.
export type IdleConfirmationKind = "confirm-continue" | "confirm-end" | "confirm-unclear";

export type IdleConfirmationPlan = {
  resumeActive: boolean;
  markMeaningfulActivity: boolean;
  endAfterResponse: boolean;
  debugMessage: string;
};

export function planIdleConfirmationResolution(
  kind: IdleConfirmationKind,
  meaningfulConfirmationSpeech: boolean,
): IdleConfirmationPlan {
  if (kind === "confirm-continue") {
    return {
      resumeActive: true,
      markMeaningfulActivity: meaningfulConfirmationSpeech,
      endAfterResponse: false,
      debugMessage: "Continue confirmed",
    };
  }
  if (kind === "confirm-end") {
    return {
      resumeActive: false,
      markMeaningfulActivity: false,
      endAfterResponse: true,
      debugMessage: "End confirmed",
    };
  }
  return {
    resumeActive: false,
    markMeaningfulActivity: false,
    endAfterResponse: false,
    debugMessage: "Idle confirmation unclear",
  };
}
