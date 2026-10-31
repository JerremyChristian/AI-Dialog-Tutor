import { describe, expect, it } from "vitest";

import type { LiveTransportState } from "../../lib/live-transport-manager";
import {
  aiConnectionStatusForTransportState,
  buildNewLessonStartPrefix,
  getMicrophoneErrorMessage,
  getRealtimeErrorMessage,
  isMicrophonePermissionDenied,
  planStartupImperative,
} from "../../lib/teaching-session";

describe("getMicrophoneErrorMessage", () => {
  it.each([
    ["NotFoundError", "No microphone was found"],
    ["NotReadableError", "The microphone is unavailable or in use by another application"],
    ["OverconstrainedError", "No microphone matches the requested audio settings"],
    ["AbortError", "Microphone access was interrupted"],
  ])("maps DOMException %s", (name, expected) => {
    expect(getMicrophoneErrorMessage(new DOMException("raw", name))).toBe(expected);
  });

  it("falls back to the DOMException message, then its name", () => {
    expect(getMicrophoneErrorMessage(new DOMException("Device busy", "NotAllowedError"))).toBe("Device busy");
    expect(getMicrophoneErrorMessage(new DOMException("", "SecurityError"))).toBe("SecurityError");
  });

  it("uses an Error message, otherwise the generic fallback", () => {
    expect(getMicrophoneErrorMessage(new Error("Microphone access is not supported by this browser")))
      .toBe("Microphone access is not supported by this browser");
    expect(getMicrophoneErrorMessage("boom")).toBe("Unknown microphone error");
    expect(getMicrophoneErrorMessage(undefined)).toBe("Unknown microphone error");
  });
});

describe("getRealtimeErrorMessage", () => {
  it("uses an Error message, otherwise the generic fallback", () => {
    expect(getRealtimeErrorMessage(new Error("Gemini token request failed"))).toBe("Gemini token request failed");
    expect(getRealtimeErrorMessage(new DOMException("aborted", "AbortError"))).toBe("aborted");
    expect(getRealtimeErrorMessage({ message: "not an Error" })).toBe("Unknown Gemini Live error");
  });
});

describe("isMicrophonePermissionDenied", () => {
  it("is true only for NotAllowedError and SecurityError DOMExceptions", () => {
    expect(isMicrophonePermissionDenied(new DOMException("", "NotAllowedError"))).toBe(true);
    expect(isMicrophonePermissionDenied(new DOMException("", "SecurityError"))).toBe(true);
    expect(isMicrophonePermissionDenied(new DOMException("", "NotFoundError"))).toBe(false);
    expect(isMicrophonePermissionDenied(new DOMException("", "AbortError"))).toBe(false);
  });

  it("is false for non-DOMException errors with a matching name", () => {
    const error = new Error("denied");
    error.name = "NotAllowedError";
    expect(isMicrophonePermissionDenied(error)).toBe(false);
    expect(isMicrophonePermissionDenied({ name: "NotAllowedError" })).toBe(false);
    expect(isMicrophonePermissionDenied(undefined)).toBe(false);
  });
});

describe("aiConnectionStatusForTransportState", () => {
  it.each<[LiveTransportState, string]>([
    ["active", "Connected"],
    ["rollover-ready", "Connected"],
    ["closed", "Not connected"],
    ["connecting", "Connecting"],
    ["handoff", "Connecting"],
    ["synchronizing", "Connecting"],
    ["recovering", "Connecting"],
  ])("maps %s to %s", (state, expected) => {
    expect(aiConnectionStatusForTransportState(state)).toBe(expected);
  });
});

describe("planStartupImperative", () => {
  it("prefers wrap-up over every start mode", () => {
    expect(planStartupImperative({ wrapUp: true, sessionStartMode: "new" })).toBe("wrap-up");
    expect(planStartupImperative({ wrapUp: true, sessionStartMode: "persisted-resume" })).toBe("wrap-up");
  });

  it("otherwise follows the session start mode", () => {
    expect(planStartupImperative({ wrapUp: false, sessionStartMode: "persisted-resume" }))
      .toBe("persisted-resume");
    expect(planStartupImperative({ wrapUp: false, sessionStartMode: "new" })).toBe("new");
  });
});

describe("buildNewLessonStartPrefix", () => {
  it("matches the golden prefix with a lesson focus", () => {
    expect(buildNewLessonStartPrefix("PLC Basics.pdf", "ladder logic")).toBe(
      "Begin the source-grounded spoken lesson now. Identify the uploaded material as \"PLC Basics.pdf\", " +
      "briefly preview what you will cover, then teach the assigned first presentation beat related to ladder logic.",
    );
  });

  it("matches the golden prefix without a lesson focus", () => {
    expect(buildNewLessonStartPrefix("PLC Basics.pdf", "")).toBe(
      "Begin the source-grounded spoken lesson now. Identify the uploaded material as \"PLC Basics.pdf\", " +
      "briefly preview what you will cover, then teach the assigned first presentation beat from the source.",
    );
  });

  it("inserts the source name and focus verbatim", () => {
    expect(buildNewLessonStartPrefix("a \"quoted\" name", "  spaced  ")).toBe(
      "Begin the source-grounded spoken lesson now. Identify the uploaded material as \"a \"quoted\" name\", " +
      "briefly preview what you will cover, then teach the assigned first presentation beat related to   spaced  .",
    );
  });
});
