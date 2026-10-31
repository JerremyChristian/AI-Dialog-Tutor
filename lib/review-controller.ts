import type { LessonNode } from "./lesson-state";
import type {
  ActiveTeachingBeat,
  NodeReviewState,
  PresentationBeat,
} from "./teaching-beat-runtime";

// Pure Review decisions. Review is a temporary overlay: nothing here reads or
// returns canonical LessonState progress. The page owns the refs, transport,
// audio and debug side effects and applies these plans in its existing order.
// Beat assignment and commit live in teaching-beat-runtime
// (planReviewBeatAssignment, evaluateReviewBeatCommit).

export const NODE_REVIEW_BEAT_PREFIX =
  "Review this concept from its beginning using the existing lesson contract. This is a bounded review and must not alter canonical lesson coverage.";

export type NodeReviewStartContext = {
  lessonActive: boolean;
  restartPending: boolean;
  closingActive: boolean;
};

// Only teachable leaves can be reviewed, and not while restarting or closing.
export function canStartNodeReview(
  node: Pick<LessonNode, "teaching" | "childrenIds">,
  ctx: NodeReviewStartContext,
): boolean {
  return ctx.lessonActive && Boolean(node.teaching) && !node.childrenIds.length &&
    !ctx.restartPending && !ctx.closingActive;
}

// Review starts at cursor 0 and returns to the Presentation Beat that was
// showing when it began.
export function createNodeReview(
  nodeId: string,
  returnPresentationBeat: PresentationBeat | null,
): NodeReviewState {
  return {
    nodeId,
    nextTeachingPointIndex: 0,
    returnPresentationBeat,
    complete: false,
  };
}

// Leaving Review without resuming (roadmap navigation). Any active beat is
// invalidated and audio cleared; no lesson beat is assigned and the resume
// guard is cleared. Intentionally distinct from planFinishNodeReview.
export type NodeReviewExitPlan = {
  review: NodeReviewState;
  presentationBeat: PresentationBeat | null;
  reviewResumeGuard: false;
};

export function planExitNodeReview(review: NodeReviewState | null): NodeReviewExitPlan | null {
  if (!review) return null;
  return {
    review,
    presentationBeat: review.returnPresentationBeat,
    reviewResumeGuard: false,
  };
}

// Leaving Review and resuming the lesson (final-beat continue or manual exit).
// Sets the resume guard so a following `query continue` does not assign a
// second lesson beat; only an active review beat is invalidated. Whether a
// lesson beat is then assigned is decided by shouldResumeTeachingAfterReview.
export type NodeReviewFinishPlan = {
  review: NodeReviewState;
  presentationBeat: PresentationBeat | null;
  reviewResumeGuard: true;
  invalidateReviewBeat: boolean;
};

export function planFinishNodeReview(
  review: NodeReviewState | null,
  reviewResumeGuard: boolean,
  active: Pick<ActiveTeachingBeat, "mode"> | null,
): NodeReviewFinishPlan | null {
  if (!review || reviewResumeGuard) return null;
  return {
    review,
    presentationBeat: review.returnPresentationBeat,
    reviewResumeGuard: true,
    invalidateReviewBeat: active?.mode === "review",
  };
}

export function shouldResumeTeachingAfterReview(wrapUp: boolean, lessonPlanComplete: boolean) {
  return !wrapUp && !lessonPlanComplete;
}

// Tutor turns during Review (or the closing farewell) are not attributed to
// the canonical concept, so they never refresh its resume point.
export function resolveAssistantCheckpointConceptId(
  review: NodeReviewState | null,
  closingActive: boolean,
  currentNodeId: string | null,
): string | null {
  return review || closingActive ? null : currentNodeId;
}
