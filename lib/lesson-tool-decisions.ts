import type { LessonStateResult } from "./lesson-state";

// Pure decision tables for the Live tool calls handled by the page. Each
// function reads plain values and returns a decision; the page executes every
// side effect (refs, timers, transport sends, debug messages) in its existing
// order. Result payloads are returned verbatim because the model reads them.

export type ToolResult = Record<string, unknown>;

export type ToolCallRoute =
  | "update_teaching_preferences"
  | "session_control"
  | "lesson_state"
  | "unknown";

export function routeToolCall(name: string | undefined): ToolCallRoute {
  if (name === "update_teaching_preferences") return name;
  if (name === "session_control") return name;
  if (name === "lesson_state") return name;
  return "unknown";
}

export function unknownToolResult(name: string | undefined): ToolResult {
  return { ok: false, error: `Unknown function: ${name || "missing"}` };
}

export type SessionControlContext = {
  // The lesson has started (or resumed), so a restart has something to clear.
  lessonStarted: boolean;
  restartConfirmationPending: boolean;
  wrapUpActive: boolean;
  idleConfirmationActive: boolean;
};

// `kind` names the side effects the page performs; `result` is the tool result.
// "wrap-up-end" has no fixed result: the page starts the closing farewell and
// picks the result with `wrapUpEndResult`.
export type SessionControlDecision =
  | { kind: "restart-not-started"; result: ToolResult }
  | { kind: "restart-request"; result: ToolResult }
  | { kind: "restart-confirm-missing"; result: ToolResult }
  | { kind: "restart-confirm"; result: ToolResult }
  | { kind: "restart-cancel"; result: ToolResult }
  | { kind: "wrap-up-end" }
  | { kind: "wrap-up-remain"; result: ToolResult }
  | { kind: "already-active"; result: ToolResult }
  | { kind: "no-idle-confirmation"; result: ToolResult }
  | { kind: "confirm-continue"; result: ToolResult }
  | { kind: "confirm-end"; result: ToolResult }
  | { kind: "confirm-unclear"; result: ToolResult };

export function decideSessionControl(
  action: unknown,
  ctx: SessionControlContext,
): SessionControlDecision {
  if (action === "restart_request") {
    if (!ctx.lessonStarted) {
      return {
        kind: "restart-not-started",
        result: { ok: false, action, message: "The lesson has not started and does not need restarting" },
      };
    }
    return {
      kind: "restart-request",
      result: {
        ok: true,
        action,
        message: "Ask the learner to confirm that teaching progress will be cleared while lesson materials and content are preserved",
      },
    };
  }
  if (action === "restart_confirm") {
    if (!ctx.restartConfirmationPending) {
      return {
        kind: "restart-confirm-missing",
        result: { ok: false, action, message: "No lesson restart confirmation is pending" },
      };
    }
    return {
      kind: "restart-confirm",
      result: { ok: true, action, message: "Restart the completed lesson from the beginning" },
    };
  }
  if (action === "restart_cancel") {
    return {
      kind: "restart-cancel",
      result: { ok: true, action, message: "Keep the completed lesson unchanged" },
    };
  }
  if (ctx.wrapUpActive && action === "end") return { kind: "wrap-up-end" };
  if (ctx.wrapUpActive) {
    return {
      kind: "wrap-up-remain",
      result: {
        ok: true,
        action: action === "continue" ? "continue" : "unclear",
        message: "Remain in final-question wrap-up",
      },
    };
  }
  if (!ctx.idleConfirmationActive && action === "continue") {
    return {
      kind: "already-active",
      result: { ok: true, action: "continue", message: "Session is already active" },
    };
  }
  if (!ctx.idleConfirmationActive) {
    return { kind: "no-idle-confirmation", result: { ok: false, message: "No idle confirmation is active" } };
  }
  if (action === "continue") {
    return {
      kind: "confirm-continue",
      result: { ok: true, action: "continue", message: "Continue the current lesson" },
    };
  }
  if (action === "end") {
    return { kind: "confirm-end", result: { ok: true, action: "end", message: "End the lesson" } };
  }
  return {
    kind: "confirm-unclear",
    result: { ok: true, action: "unclear", message: "Remain in confirmation" },
  };
}

export function wrapUpEndResult(closingStarted: boolean): ToolResult {
  return closingStarted
    ? {
        ok: true,
        action: "end",
        message: "The learner has no more questions. Give exactly one brief, warm, natural closing sentence. Do not teach new material and do not ask another question.",
      }
    : { ok: true, action: "end", message: "Lesson closing is already in progress" };
}

export type LessonStateCallKind =
  | { kind: "query" }
  | { kind: "review-rejected" }
  | { kind: "transition"; action: "navigate" | "skip"; conceptId: string }
  | { kind: "invalid"; missingConcept: boolean };

export function classifyLessonStateCall(
  action: unknown,
  conceptId: unknown,
  reviewActive: boolean,
): LessonStateCallKind {
  if (action === "query") return { kind: "query" };
  const isMove = action === "navigate" || action === "skip";
  if (isMove && reviewActive) return { kind: "review-rejected" };
  if (isMove && typeof conceptId === "string" && conceptId) {
    return { kind: "transition", action, conceptId };
  }
  return { kind: "invalid", missingConcept: isMove };
}

export function reviewActiveRejection(action: unknown): ToolResult {
  return {
    ok: false,
    action,
    error: "review_active",
    message: "Review is active. Continue the current Review or wait for the learner to explicitly exit Review.",
  };
}

export function invalidLessonStateResult(
  snapshot: LessonStateResult,
  missingConcept: boolean,
): ToolResult {
  return {
    ...snapshot,
    ok: false,
    message: missingConcept
      ? "A concept is required for this operation"
      : "Unsupported lesson-state action",
    error: missingConcept ? "missing_concept_id" : "invalid_action",
    recoveryRequired: missingConcept,
  };
}

// The post-resume extras are attached only while the transport is waiting for
// the post-resume state query.
export function buildLessonQueryResult(
  snapshot: LessonStateResult,
  postResumeQueryReceived: boolean,
  continuity: unknown,
  teachingPreferences: unknown,
): ToolResult {
  return {
    ...snapshot,
    ...(postResumeQueryReceived ? { continuity, teachingPreferences } : {}),
  };
}

export type QueryContinuationContext = {
  purpose: unknown;
  postResumeQueryReceived: boolean;
  silentRecoveryPending: boolean;
  review: { complete: boolean } | null;
  reviewResumeGuard: boolean;
  lessonPlanComplete: boolean;
};

// What `query` with purpose="continue" does after the snapshot is taken.
// "finish-review" resumes the lesson without an assignment in this response.
export type QueryContinuation =
  | "none"
  | "finish-review"
  | "assign-review-beat"
  | "assign-teaching-beat";

export function decideQueryContinuation(ctx: QueryContinuationContext): QueryContinuation {
  if (ctx.purpose !== "continue" || ctx.postResumeQueryReceived || ctx.silentRecoveryPending) {
    return "none";
  }
  if (ctx.review?.complete) return "finish-review";
  if (ctx.review) return "assign-review-beat";
  if (!ctx.reviewResumeGuard && !ctx.lessonPlanComplete) return "assign-teaching-beat";
  return "none";
}

export type LessonTransitionEffects = {
  clearWrapUp: boolean;
  logContractProgress: boolean;
  assignNextBeat: boolean;
  clearRoadmapPending: boolean;
  recoveryRequired: boolean;
};

// Effects that follow navigateLessonState/skipLessonNode. The page applies
// `clearWrapUp` only when the transition produced a new state object, and
// starts silent recovery for `recoveryRequired` only if none is pending yet
// (read at that point, after the assignment and roadmap clearing).
export function planLessonTransitionEffects(
  action: "navigate" | "skip",
  result: Pick<LessonStateResult, "ok" | "recoveryRequired">,
): LessonTransitionEffects {
  const navigate = action === "navigate";
  return {
    clearWrapUp: navigate && result.ok,
    logContractProgress: navigate && result.ok,
    assignNextBeat: result.ok,
    clearRoadmapPending: navigate,
    recoveryRequired: Boolean(result.recoveryRequired),
  };
}

export function decorateLessonStateResult(
  result: ToolResult,
  teachingPreferences: unknown,
  assignmentControl: string,
): ToolResult {
  return {
    ...result,
    teachingPreferences,
    ...(assignmentControl ? { teachingAssignment: assignmentControl } : {}),
  };
}

export type SilentRecoveryFollowUp = "complete" | "start" | "none";

// After a successful tool response send: a recovery query completes recovery
// and takes precedence over starting a new one in the same batch.
export function decideSilentRecoveryFollowUp(
  recoveryQueryReceived: boolean,
  requestSilentRecovery: boolean,
): SilentRecoveryFollowUp {
  if (recoveryQueryReceived) return "complete";
  if (requestSilentRecovery) return "start";
  return "none";
}
