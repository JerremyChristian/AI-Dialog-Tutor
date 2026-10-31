import { describe, expect, it } from "vitest";

import { IDLE_AFTER_MS } from "../../lib/engagement";
import {
  canRequestIdleConfirmation,
  classifyMeaningfulSpeech,
  IDLE_CONFIRMATION_CONTROL_TEXT,
  planIdleConfirmationResolution,
  planQuickResponse,
  shouldEndForInactivity,
  shouldLogMeaningfulActivity,
  shouldRequestIdleConfirmation,
} from "../../lib/idle-engagement";
import { decideSessionControl } from "../../lib/lesson-tool-decisions";

const NOW = 1_000_000_000;

describe("idle transitions", () => {
  it("requests confirmation only once an active lesson has been idle for IDLE_AFTER_MS", () => {
    expect(shouldRequestIdleConfirmation(true, "active", NOW - IDLE_AFTER_MS + 1, NOW)).toBe(false);
    expect(shouldRequestIdleConfirmation(true, "active", NOW - IDLE_AFTER_MS, NOW)).toBe(true);
  });

  it("treats a missing activity timestamp as just now", () => {
    expect(shouldRequestIdleConfirmation(true, "active", null, NOW)).toBe(false);
  });

  it("never requests from an inactive lesson or a non-active state", () => {
    const stale = NOW - IDLE_AFTER_MS * 2;
    expect(shouldRequestIdleConfirmation(false, "active", stale, NOW)).toBe(false);
    expect(shouldRequestIdleConfirmation(true, "possibly-idle", stale, NOW)).toBe(false);
    expect(shouldRequestIdleConfirmation(true, "confirming", stale, NOW)).toBe(false);
    expect(shouldRequestIdleConfirmation(true, "ended", stale, NOW)).toBe(false);
  });

  it("does not re-request while already confirming or with no active lesson", () => {
    expect(canRequestIdleConfirmation(true, "active")).toBe(true);
    expect(canRequestIdleConfirmation(true, "ended")).toBe(true);
    expect(canRequestIdleConfirmation(true, "confirming")).toBe(false);
    expect(canRequestIdleConfirmation(false, "active")).toBe(false);
  });

  it("ends for inactivity only if still confirming when the timer fires", () => {
    expect(shouldEndForInactivity("confirming")).toBe(true);
    expect(shouldEndForInactivity("active")).toBe(false);
    expect(shouldEndForInactivity("ended")).toBe(false);
  });

  it("keeps the idle confirmation control text", () => {
    expect(IDLE_CONFIRMATION_CONTROL_TEXT).toBe("[[APP_CONTROL:IDLE_CONFIRMATION]]");
  });
});

describe("meaningful activity", () => {
  it("logs activity only while active", () => {
    expect(shouldLogMeaningfulActivity("active")).toBe(true);
    expect(shouldLogMeaningfulActivity("confirming")).toBe(false);
  });

  it("resets activity while active but only notes speech while confirming", () => {
    expect(classifyMeaningfulSpeech("active")).toBe("mark-activity");
    expect(classifyMeaningfulSpeech("confirming")).toBe("note-confirmation-speech");
    expect(classifyMeaningfulSpeech("possibly-idle")).toBe("none");
    expect(classifyMeaningfulSpeech("ended")).toBe("none");
  });
});

describe("planQuickResponse", () => {
  it("sends the lesson wording with no idle effect outside confirmation", () => {
    expect(planQuickResponse("Yes", false)).toEqual({ text: "Yes.", idleEffect: "none" });
    expect(planQuickResponse("Repeat", false)).toEqual({
      text: "Please repeat or re-explain the last explanation.",
      idleEffect: "none",
    });
    expect(planQuickResponse("Continue", false)).toEqual({
      text: "Continue with the lesson.",
      idleEffect: "none",
    });
  });

  it("resumes on Yes/Continue and re-asks on Repeat while confirming", () => {
    expect(planQuickResponse("Yes", true)).toEqual({ text: "Yes.", idleEffect: "resume-active" });
    expect(planQuickResponse("Continue", true)).toEqual({
      text: "Continue with the lesson.",
      idleEffect: "resume-active",
    });
    expect(planQuickResponse("Repeat", true)).toEqual({
      text: "Please repeat the question asking whether I want to continue.",
      idleEffect: "restart-confirmation-timer",
    });
  });
});

describe("idle confirmation resolution", () => {
  const confirming = {
    lessonStarted: true,
    restartConfirmationPending: false,
    wrapUpActive: false,
    idleConfirmationActive: true,
  };

  it("continue resumes active and marks activity only after meaningful confirmation speech", () => {
    const decision = decideSessionControl("continue", confirming);
    expect(decision).toMatchObject({ kind: "confirm-continue" });
    expect(decision).toMatchObject({ result: { ok: true, action: "continue", message: "Continue the current lesson" } });
    expect(planIdleConfirmationResolution("confirm-continue", true)).toEqual({
      resumeActive: true,
      markMeaningfulActivity: true,
      endAfterResponse: false,
      debugMessage: "Continue confirmed",
    });
    expect(planIdleConfirmationResolution("confirm-continue", false).markMeaningfulActivity).toBe(false);
  });

  it("end stops after the response without resuming", () => {
    const decision = decideSessionControl("end", confirming);
    expect(decision).toMatchObject({ kind: "confirm-end" });
    expect(decision).toMatchObject({ result: { ok: true, action: "end", message: "End the lesson" } });
    expect(planIdleConfirmationResolution("confirm-end", true)).toEqual({
      resumeActive: false,
      markMeaningfulActivity: false,
      endAfterResponse: true,
      debugMessage: "End confirmed",
    });
  });

  it("unclear remains in confirmation", () => {
    const decision = decideSessionControl("maybe", confirming);
    expect(decision).toMatchObject({ kind: "confirm-unclear" });
    expect(decision).toMatchObject({ result: { ok: true, action: "unclear", message: "Remain in confirmation" } });
    expect(planIdleConfirmationResolution("confirm-unclear", true)).toEqual({
      resumeActive: false,
      markMeaningfulActivity: false,
      endAfterResponse: false,
      debugMessage: "Idle confirmation unclear",
    });
  });
});
