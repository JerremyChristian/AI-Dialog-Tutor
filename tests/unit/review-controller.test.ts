import { describe, expect, it } from "vitest";

import type { AtomicTeachingContract, LessonTreeItem } from "../../lib/learning-source";
import { createLessonState, type LessonState } from "../../lib/lesson-state";
import {
  canStartNodeReview,
  createNodeReview,
  NODE_REVIEW_BEAT_PREFIX,
  planExitNodeReview,
  planFinishNodeReview,
  resolveAssistantCheckpointConceptId,
  shouldResumeTeachingAfterReview,
} from "../../lib/review-controller";
import {
  createActiveBeat,
  createPresentationBeat,
  evaluateReviewBeatCommit,
  planReviewBeatAssignment,
  type NodeReviewState,
  type PresentationBeat,
} from "../../lib/teaching-beat-runtime";
import { resolveNextPresentationBeat } from "../../lib/teaching-delivery";

// Two delivery units: [0, 1] in two beats, then [2] in one beat.
function contract(): AtomicTeachingContract {
  return {
    objective: "Understand the concept",
    teachingPoints: ["Point A", "Point B", "Point C"],
    completionCriteria: ["Can explain A"],
    type: "concept",
    importance: "core",
    deliveryUnits: [
      {
        objective: "Teach A and B",
        teachingPointIndexes: [0, 1],
        completionCriteriaIndexes: [0],
        presentationBeats: [{ teachingPointIndexes: [0] }, { teachingPointIndexes: [1] }],
      },
      {
        objective: "Teach C",
        teachingPointIndexes: [2],
        completionCriteriaIndexes: [],
        presentationBeats: [{ teachingPointIndexes: [2] }],
      },
    ],
  };
}

function lessonTree(): LessonTreeItem[] {
  return [
    { id: "module", title: "Module", parentId: null, order: 1 },
    { id: "first", title: "First", parentId: "module", order: 1, teaching: contract() },
    { id: "second", title: "Second", parentId: "module", order: 2, teaching: contract() },
  ];
}

function lessonState(): LessonState {
  return createLessonState("Review controller", lessonTree());
}

function presentation(conceptId: string, index: number): PresentationBeat {
  const resolved = resolveNextPresentationBeat(contract(), index);
  if (!resolved) throw new Error(`no beat at ${index}`);
  return createPresentationBeat(resolved, conceptId);
}

const startable = { lessonActive: true, restartPending: false, closingActive: false };

describe("canStartNodeReview", () => {
  const state = lessonState();

  it("allows a teachable leaf while the lesson is active", () => {
    expect(canStartNodeReview(state.nodes.first, startable)).toBe(true);
  });

  it("rejects parents and nodes without a teaching contract", () => {
    expect(canStartNodeReview(state.nodes.module, startable)).toBe(false);
    expect(canStartNodeReview({ ...state.nodes.first, teaching: undefined }, startable)).toBe(false);
  });

  it("rejects when inactive, restarting or closing", () => {
    expect(canStartNodeReview(state.nodes.first, { ...startable, lessonActive: false })).toBe(false);
    expect(canStartNodeReview(state.nodes.first, { ...startable, restartPending: true })).toBe(false);
    expect(canStartNodeReview(state.nodes.first, { ...startable, closingActive: true })).toBe(false);
  });
});

describe("createNodeReview", () => {
  it("starts at review cursor 0 and keeps the current Presentation Beat as the return target", () => {
    const returnBeat = presentation("second", 1);
    expect(createNodeReview("first", returnBeat)).toEqual({
      nodeId: "first",
      nextTeachingPointIndex: 0,
      returnPresentationBeat: returnBeat,
      complete: false,
    });
  });

  it("allows a null return target", () => {
    expect(createNodeReview("first", null).returnPresentationBeat).toBeNull();
  });

  it("assigns the first beat of the reviewed node regardless of canonical progress", () => {
    const state = {
      ...lessonState(),
      teachingContractProgress: { first: { nextTeachingPointIndex: 2 } },
    };
    const plan = planReviewBeatAssignment(state, createNodeReview("first", null));
    expect(plan?.concept.id).toBe("first");
    expect(plan?.resolved.teachingPointIndexes).toEqual([0]);
  });
});

describe("planExitNodeReview", () => {
  it("does nothing without a review", () => {
    expect(planExitNodeReview(null)).toBeNull();
  });

  it("restores the return beat and clears the resume guard", () => {
    const returnBeat = presentation("second", 0);
    const review = createNodeReview("first", returnBeat);
    expect(planExitNodeReview(review)).toEqual({
      review,
      presentationBeat: returnBeat,
      reviewResumeGuard: false,
    });
  });
});

describe("planFinishNodeReview", () => {
  const returnBeat = presentation("second", 1);
  const review: NodeReviewState = { ...createNodeReview("first", returnBeat), complete: true };

  it("does nothing without a review or behind the resume guard", () => {
    expect(planFinishNodeReview(null, false, null)).toBeNull();
    expect(planFinishNodeReview(review, true, null)).toBeNull();
  });

  it("restores the return beat and sets the resume guard", () => {
    expect(planFinishNodeReview(review, false, null)).toEqual({
      review,
      presentationBeat: returnBeat,
      reviewResumeGuard: true,
      invalidateReviewBeat: false,
    });
  });

  it("invalidates only an active review beat", () => {
    expect(planFinishNodeReview(review, false, { mode: "review" })?.invalidateReviewBeat).toBe(true);
    expect(planFinishNodeReview(review, false, { mode: "lesson" })?.invalidateReviewBeat).toBe(false);
  });

  it("differs from exit in the resume guard", () => {
    expect(planExitNodeReview(review)?.reviewResumeGuard).toBe(false);
    expect(planFinishNodeReview(review, false, null)?.reviewResumeGuard).toBe(true);
  });
});

describe("shouldResumeTeachingAfterReview", () => {
  it("resumes only outside wrap-up with lesson content remaining", () => {
    expect(shouldResumeTeachingAfterReview(false, false)).toBe(true);
    expect(shouldResumeTeachingAfterReview(true, false)).toBe(false);
    expect(shouldResumeTeachingAfterReview(false, true)).toBe(false);
  });
});

describe("resolveAssistantCheckpointConceptId", () => {
  it("is null during review or closing, otherwise the current concept", () => {
    const review = createNodeReview("first", null);
    expect(resolveAssistantCheckpointConceptId(review, false, "second")).toBeNull();
    expect(resolveAssistantCheckpointConceptId(null, true, "second")).toBeNull();
    expect(resolveAssistantCheckpointConceptId(null, false, "second")).toBe("second");
    expect(resolveAssistantCheckpointConceptId(null, false, null)).toBeNull();
  });
});

describe("review lifecycle", () => {
  it("runs a full review without changing canonical LessonState", () => {
    const state = lessonState();
    const before = structuredClone(state);
    const returnBeat = presentation("first", 0);
    let review: NodeReviewState = createNodeReview("first", returnBeat);
    let epoch = 0;
    const cursors: number[] = [];
    for (;;) {
      const plan = planReviewBeatAssignment(state, review);
      if (!plan) break;
      const active = createActiveBeat(plan.resolved, plan.concept.id, "review", ++epoch);
      active.generationComplete = true;
      active.audioNaturallyDrained = true;
      const evaluation = evaluateReviewBeatCommit(state, review, active, epoch);
      if (evaluation.kind !== "committed") throw new Error("expected commit");
      review = evaluation.review;
      cursors.push(evaluation.nextIndex);
    }
    expect(cursors).toEqual([1, 2, 3]);
    expect(review.complete).toBe(true);
    // The final beat waits for the learner: no further beat is assigned.
    expect(planReviewBeatAssignment(state, review)).toBeNull();
    expect(state).toEqual(before);
    expect(planFinishNodeReview(review, false, null)?.presentationBeat).toBe(returnBeat);
  });

  it("an invalidated review beat does not advance the review cursor", () => {
    const state = lessonState();
    const review = createNodeReview("first", null);
    const plan = planReviewBeatAssignment(state, review);
    if (!plan) throw new Error("expected plan");
    const active = createActiveBeat(plan.resolved, plan.concept.id, "review", 1);
    active.generationComplete = true;
    active.audioNaturallyDrained = true;
    active.cancelled = true;
    expect(evaluateReviewBeatCommit(state, review, active, 2)).toEqual({ kind: "not-ready" });
    // The review persists and the same beat is reassigned.
    expect(planReviewBeatAssignment(state, review)?.resolved.teachingPointIndexes).toEqual([0]);
  });
});

describe("NODE_REVIEW_BEAT_PREFIX", () => {
  it("keeps the review instruction wording", () => {
    expect(NODE_REVIEW_BEAT_PREFIX).toBe(
      "Review this concept from its beginning using the existing lesson contract. This is a bounded review and must not alter canonical lesson coverage.",
    );
  });
});
