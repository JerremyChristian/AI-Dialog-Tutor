import { describe, expect, it } from "vitest";

import {
  buildLessonQueryResult,
  classifyLessonStateCall,
  decideQueryContinuation,
  decideSessionControl,
  decideSilentRecoveryFollowUp,
  decorateLessonStateResult,
  invalidLessonStateResult,
  planLessonTransitionEffects,
  reviewActiveRejection,
  routeToolCall,
  unknownToolResult,
  wrapUpEndResult,
  type QueryContinuationContext,
  type SessionControlContext,
} from "../../lib/lesson-tool-decisions";
import type { LessonStateResult } from "../../lib/lesson-state";

const normal: SessionControlContext = {
  lessonStarted: true,
  restartConfirmationPending: false,
  wrapUpActive: false,
  idleConfirmationActive: false,
};
const idleConfirming = { ...normal, idleConfirmationActive: true };
const wrapUp = { ...normal, wrapUpActive: true };
const restartPending = { ...normal, restartConfirmationPending: true };
const notStarted = { ...normal, lessonStarted: false };

const actions = ["restart_request", "restart_confirm", "restart_cancel", "continue", "end", "bogus", undefined];

function kinds(ctx: SessionControlContext) {
  return Object.fromEntries(actions.map((action) => [String(action), decideSessionControl(action, ctx).kind]));
}

describe("routeToolCall", () => {
  it("routes known tools and treats everything else as unknown", () => {
    expect(routeToolCall("update_teaching_preferences")).toBe("update_teaching_preferences");
    expect(routeToolCall("session_control")).toBe("session_control");
    expect(routeToolCall("lesson_state")).toBe("lesson_state");
    expect(routeToolCall("other")).toBe("unknown");
    expect(routeToolCall(undefined)).toBe("unknown");
  });

  it("names the unknown function, or 'missing'", () => {
    expect(unknownToolResult("other")).toEqual({ ok: false, error: "Unknown function: other" });
    expect(unknownToolResult(undefined)).toEqual({ ok: false, error: "Unknown function: missing" });
    expect(unknownToolResult("")).toEqual({ ok: false, error: "Unknown function: missing" });
  });
});

describe("decideSessionControl decision table", () => {
  it("normal (no idle confirmation, no wrap-up)", () => {
    expect(kinds(normal)).toEqual({
      restart_request: "restart-request",
      restart_confirm: "restart-confirm-missing",
      restart_cancel: "restart-cancel",
      continue: "already-active",
      end: "no-idle-confirmation",
      bogus: "no-idle-confirmation",
      undefined: "no-idle-confirmation",
    });
  });

  it("idle confirming", () => {
    expect(kinds(idleConfirming)).toEqual({
      restart_request: "restart-request",
      restart_confirm: "restart-confirm-missing",
      restart_cancel: "restart-cancel",
      continue: "confirm-continue",
      end: "confirm-end",
      bogus: "confirm-unclear",
      undefined: "confirm-unclear",
    });
  });

  it("wrap-up takes precedence over idle confirmation", () => {
    const expected = {
      restart_request: "restart-request",
      restart_confirm: "restart-confirm-missing",
      restart_cancel: "restart-cancel",
      continue: "wrap-up-remain",
      end: "wrap-up-end",
      bogus: "wrap-up-remain",
      undefined: "wrap-up-remain",
    };
    expect(kinds(wrapUp)).toEqual(expected);
    expect(kinds({ ...wrapUp, idleConfirmationActive: true })).toEqual(expected);
  });

  it("restart pending: restart actions win over wrap-up and idle state", () => {
    expect(kinds({ ...restartPending, wrapUpActive: true, idleConfirmationActive: true })).toEqual({
      restart_request: "restart-request",
      restart_confirm: "restart-confirm",
      restart_cancel: "restart-cancel",
      continue: "wrap-up-remain",
      end: "wrap-up-end",
      bogus: "wrap-up-remain",
      undefined: "wrap-up-remain",
    });
    expect(kinds(restartPending).restart_confirm).toBe("restart-confirm");
  });

  it("refuses a restart request before the lesson has started", () => {
    expect(decideSessionControl("restart_request", notStarted)).toEqual({
      kind: "restart-not-started",
      result: {
        ok: false,
        action: "restart_request",
        message: "The lesson has not started and does not need restarting",
      },
    });
  });

  it("returns the exact result payloads", () => {
    expect(decideSessionControl("restart_request", normal)).toEqual({
      kind: "restart-request",
      result: {
        ok: true,
        action: "restart_request",
        message: "Ask the learner to confirm that teaching progress will be cleared while lesson materials and content are preserved",
      },
    });
    expect(decideSessionControl("restart_confirm", normal)).toMatchObject({
      result: { ok: false, action: "restart_confirm", message: "No lesson restart confirmation is pending" },
    });
    expect(decideSessionControl("restart_confirm", restartPending)).toMatchObject({
      result: { ok: true, action: "restart_confirm", message: "Restart the completed lesson from the beginning" },
    });
    expect(decideSessionControl("restart_cancel", normal)).toMatchObject({
      result: { ok: true, action: "restart_cancel", message: "Keep the completed lesson unchanged" },
    });
    expect(decideSessionControl("continue", wrapUp)).toMatchObject({
      result: { ok: true, action: "continue", message: "Remain in final-question wrap-up" },
    });
    expect(decideSessionControl("bogus", wrapUp)).toMatchObject({
      result: { ok: true, action: "unclear", message: "Remain in final-question wrap-up" },
    });
    expect(decideSessionControl("continue", normal)).toMatchObject({
      result: { ok: true, action: "continue", message: "Session is already active" },
    });
    expect(decideSessionControl("end", normal)).toEqual({
      kind: "no-idle-confirmation",
      result: { ok: false, message: "No idle confirmation is active" },
    });
    expect(decideSessionControl("continue", idleConfirming)).toMatchObject({
      result: { ok: true, action: "continue", message: "Continue the current lesson" },
    });
    expect(decideSessionControl("end", idleConfirming)).toMatchObject({
      result: { ok: true, action: "end", message: "End the lesson" },
    });
    expect(decideSessionControl("bogus", idleConfirming)).toMatchObject({
      result: { ok: true, action: "unclear", message: "Remain in confirmation" },
    });
  });

  it("wrap-up end result depends on whether the farewell actually started", () => {
    expect(wrapUpEndResult(true)).toEqual({
      ok: true,
      action: "end",
      message: "The learner has no more questions. Give exactly one brief, warm, natural closing sentence. Do not teach new material and do not ask another question.",
    });
    expect(wrapUpEndResult(false)).toEqual({
      ok: true,
      action: "end",
      message: "Lesson closing is already in progress",
    });
  });
});

describe("classifyLessonStateCall", () => {
  it("query is handled even during review", () => {
    expect(classifyLessonStateCall("query", undefined, true)).toEqual({ kind: "query" });
  });

  it("rejects navigate/skip during review, even without a concept", () => {
    for (const action of ["navigate", "skip"]) {
      expect(classifyLessonStateCall(action, "c1", true)).toEqual({ kind: "review-rejected" });
      expect(classifyLessonStateCall(action, undefined, true)).toEqual({ kind: "review-rejected" });
    }
  });

  it("transitions navigate/skip with a non-empty concept id", () => {
    expect(classifyLessonStateCall("navigate", "c1", false))
      .toEqual({ kind: "transition", action: "navigate", conceptId: "c1" });
    expect(classifyLessonStateCall("skip", "c2", false))
      .toEqual({ kind: "transition", action: "skip", conceptId: "c2" });
  });

  it("flags a missing concept for navigate/skip and an invalid action otherwise", () => {
    expect(classifyLessonStateCall("navigate", "", false)).toEqual({ kind: "invalid", missingConcept: true });
    expect(classifyLessonStateCall("skip", 42, false)).toEqual({ kind: "invalid", missingConcept: true });
    expect(classifyLessonStateCall("teleport", "c1", false)).toEqual({ kind: "invalid", missingConcept: false });
    expect(classifyLessonStateCall("teleport", "c1", true)).toEqual({ kind: "invalid", missingConcept: false });
    expect(classifyLessonStateCall(undefined, undefined, false)).toEqual({ kind: "invalid", missingConcept: false });
  });

  it("review_active rejection payload", () => {
    expect(reviewActiveRejection("skip")).toEqual({
      ok: false,
      action: "skip",
      error: "review_active",
      message: "Review is active. Continue the current Review or wait for the learner to explicitly exit Review.",
    });
  });
});

const snapshot = {
  ok: true,
  action: "query",
  message: "Authoritative hierarchical lesson coverage snapshot",
  currentNodeId: "c1",
  currentPath: ["c1"],
  nodes: [],
} as LessonStateResult;

describe("lesson_state result builders", () => {
  it("invalid result overrides snapshot fields", () => {
    expect(invalidLessonStateResult(snapshot, true)).toEqual({
      ...snapshot,
      ok: false,
      message: "A concept is required for this operation",
      error: "missing_concept_id",
      recoveryRequired: true,
    });
    expect(invalidLessonStateResult(snapshot, false)).toEqual({
      ...snapshot,
      ok: false,
      message: "Unsupported lesson-state action",
      error: "invalid_action",
      recoveryRequired: false,
    });
  });

  it("query result includes continuity and preferences only during post-resume sync", () => {
    const continuity = { lastAssistantTurnComplete: true };
    const prefs = { explanationDepth: "brief" };
    expect(buildLessonQueryResult(snapshot, false, continuity, prefs)).toEqual(snapshot);
    expect(buildLessonQueryResult(snapshot, true, continuity, prefs))
      .toEqual({ ...snapshot, continuity, teachingPreferences: prefs });
  });

  it("decoration always adds preferences and adds an assignment only when present", () => {
    const prefs = { explanationDepth: "deep" };
    expect(decorateLessonStateResult({ ok: true }, prefs, "")).toEqual({ ok: true, teachingPreferences: prefs });
    expect(decorateLessonStateResult({ ok: true, teachingPreferences: "old" }, prefs, "BEAT"))
      .toEqual({ ok: true, teachingPreferences: prefs, teachingAssignment: "BEAT" });
  });
});

describe("decideQueryContinuation", () => {
  const base: QueryContinuationContext = {
    purpose: "continue",
    postResumeQueryReceived: false,
    silentRecoveryPending: false,
    review: null,
    reviewResumeGuard: false,
    lessonPlanComplete: false,
  };

  it("only purpose=continue continues", () => {
    expect(decideQueryContinuation(base)).toBe("assign-teaching-beat");
    expect(decideQueryContinuation({ ...base, purpose: undefined })).toBe("none");
    expect(decideQueryContinuation({ ...base, purpose: "status" })).toBe("none");
  });

  it("assigns nothing during post-resume sync or pending silent recovery", () => {
    expect(decideQueryContinuation({ ...base, postResumeQueryReceived: true })).toBe("none");
    expect(decideQueryContinuation({ ...base, silentRecoveryPending: true })).toBe("none");
    expect(decideQueryContinuation({ ...base, postResumeQueryReceived: true, review: { complete: true } }))
      .toBe("none");
  });

  it("finishes a complete review, otherwise continues the review", () => {
    expect(decideQueryContinuation({ ...base, review: { complete: true } })).toBe("finish-review");
    expect(decideQueryContinuation({ ...base, review: { complete: false } })).toBe("assign-review-beat");
    expect(decideQueryContinuation({ ...base, review: { complete: false }, reviewResumeGuard: true }))
      .toBe("assign-review-beat");
  });

  it("does not assign a lesson beat behind the review-resume guard or after the plan completes", () => {
    expect(decideQueryContinuation({ ...base, reviewResumeGuard: true })).toBe("none");
    expect(decideQueryContinuation({ ...base, lessonPlanComplete: true })).toBe("none");
  });
});

describe("planLessonTransitionEffects", () => {
  it("successful navigate", () => {
    expect(planLessonTransitionEffects("navigate", { ok: true })).toEqual({
      clearWrapUp: true,
      logContractProgress: true,
      assignNextBeat: true,
      clearRoadmapPending: true,
      recoveryRequired: false,
    });
  });

  it("failed navigate still clears roadmap pending and can require recovery", () => {
    expect(planLessonTransitionEffects("navigate", { ok: false, recoveryRequired: true })).toEqual({
      clearWrapUp: false,
      logContractProgress: false,
      assignNextBeat: false,
      clearRoadmapPending: true,
      recoveryRequired: true,
    });
  });

  it("skip never touches wrap-up or roadmap pending", () => {
    expect(planLessonTransitionEffects("skip", { ok: true })).toEqual({
      clearWrapUp: false,
      logContractProgress: false,
      assignNextBeat: true,
      clearRoadmapPending: false,
      recoveryRequired: false,
    });
    expect(planLessonTransitionEffects("skip", { ok: false, recoveryRequired: true }).recoveryRequired).toBe(true);
  });
});

describe("decideSilentRecoveryFollowUp", () => {
  it("a recovery query completes recovery and wins over a new recovery request", () => {
    expect(decideSilentRecoveryFollowUp(true, true)).toBe("complete");
    expect(decideSilentRecoveryFollowUp(true, false)).toBe("complete");
    expect(decideSilentRecoveryFollowUp(false, true)).toBe("start");
    expect(decideSilentRecoveryFollowUp(false, false)).toBe("none");
  });
});
