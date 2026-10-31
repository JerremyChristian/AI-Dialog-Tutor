import { describe, expect, it } from "vitest";

import type { AtomicTeachingContract, LessonTreeItem } from "../../lib/learning-source";
import { createLessonState, type LessonState } from "../../lib/lesson-state";
import {
  buildTeachingBeatControl,
  createActiveBeat,
  createPresentationBeat,
  evaluateLessonBeatCommit,
  evaluateReviewBeatCommit,
  planLessonBeatAssignment,
  planReviewBeatAssignment,
  type ActiveTeachingBeat,
  type NodeReviewState,
} from "../../lib/teaching-beat-runtime";
import { resolveNextPresentationBeat } from "../../lib/teaching-delivery";

// Unit 0 has three single-point beats (first/middle/final); unit 1 has one (only).
function contract(): AtomicTeachingContract {
  return {
    objective: "Understand the concept",
    teachingPoints: ["Point A", "Point B", "Point C", "Point D"],
    teachingPointSourceReferences: [
      [{ sourceId: "deck", page: 1 }],
      [],
      [{ sourceId: "deck", page: 2 }],
      [],
    ],
    completionCriteria: ["Can explain A", "Can apply C"],
    type: "concept",
    importance: "core",
    deliveryUnits: [
      {
        objective: "Teach A through C",
        teachingPointIndexes: [0, 1, 2],
        completionCriteriaIndexes: [0, 1],
        presentationBeats: [
          { teachingPointIndexes: [0] },
          { teachingPointIndexes: [1] },
          { teachingPointIndexes: [2] },
        ],
      },
      {
        objective: "Teach D",
        teachingPointIndexes: [3],
        completionCriteriaIndexes: [],
        presentationBeats: [{ teachingPointIndexes: [3] }],
      },
    ],
  };
}

function lessonTree(): LessonTreeItem[] {
  return [
    { id: "module", title: "Module", parentId: null, order: 1 },
    { id: "first", title: "First", parentId: "module", order: 1, teaching: contract() },
    { id: "second", title: "Second", parentId: "module", order: 2, teaching: contract() },
    { id: "third", title: "Third", parentId: "module", order: 3, teaching: contract() },
  ];
}

function lessonState(): LessonState {
  return createLessonState("Beat runtime", lessonTree());
}

function withCursor(state: LessonState, conceptId: string, nextTeachingPointIndex: number): LessonState {
  return {
    ...state,
    teachingContractProgress: {
      ...state.teachingContractProgress,
      [conceptId]: { nextTeachingPointIndex },
    },
  };
}

function withStatuses(state: LessonState, statuses: Record<string, LessonState["nodes"][string]["status"]>): LessonState {
  const nodes = { ...state.nodes };
  for (const [id, status] of Object.entries(statuses)) nodes[id] = { ...nodes[id], status };
  return { ...state, nodes };
}

function beat(
  conceptId: string,
  cursor: number,
  mode: ActiveTeachingBeat["mode"] = "lesson",
  overrides: Partial<ActiveTeachingBeat> = {},
): ActiveTeachingBeat {
  const resolved = resolveNextPresentationBeat(contract(), cursor);
  if (!resolved) throw new Error(`No beat starts at ${cursor}`);
  return { ...createActiveBeat(resolved, conceptId, mode, 5), ...overrides };
}

function readyBeat(conceptId: string, cursor: number, mode: ActiveTeachingBeat["mode"] = "lesson") {
  return beat(conceptId, cursor, mode, { generationComplete: true, audioNaturallyDrained: true });
}

const lines = (...value: string[]) => value.join("\n");

const HEADER = [
  "[[APP_CONTROL:TEACH_PRESENTATION_BEAT]]",
  "Teach exactly this application-assigned presentation beat as one natural source-grounded spoken explanation. Do not call progress or complete.",
];
const ESTABLISH = "Establish the unit naturally.";
const CONTINUE = "Continue directly from the preceding explanation without greeting, praise, announcing a new section, or unnecessary recap.";
const NO_CHECK_IN = "Do not ask a question or invite learner interaction at the end; finish with natural continuity because the application will immediately assign the next beat.";
const UNIT_BOUNDARY = "Briefly synthesize if useful, then create a natural learner interaction boundary; vary the check-in and do not use a fixed script.";
const UNIT_0_CRITERIA = 'RELEVANT_COMPLETION_CRITERIA: [{"index":0,"content":"Can explain A"},{"index":1,"content":"Can apply C"}]';

describe("buildTeachingBeatControl (golden)", () => {
  it("lesson first beat", () => {
    expect(buildTeachingBeatControl(lessonState(), beat("first", 0))).toBe(lines(
      ...HEADER,
      "CONCEPT: First",
      "DELIVERY_UNIT_OBJECTIVE: Teach A through C",
      "BEAT_POSITION: first",
      'ASSIGNED_TEACHING_POINTS: [{"index":0,"content":"Point A","sourceReferences":[{"sourceId":"deck","page":1}]}]',
      UNIT_0_CRITERIA,
      ESTABLISH,
      NO_CHECK_IN,
    ));
  });

  it("lesson middle beat with prefix", () => {
    expect(buildTeachingBeatControl(withCursor(lessonState(), "first", 1), beat("first", 1), "Begin now.")).toBe(lines(
      "Begin now.",
      ...HEADER,
      "CONCEPT: First",
      "DELIVERY_UNIT_OBJECTIVE: Teach A through C",
      "BEAT_POSITION: middle",
      'ASSIGNED_TEACHING_POINTS: [{"index":1,"content":"Point B","sourceReferences":[]}]',
      UNIT_0_CRITERIA,
      CONTINUE,
      NO_CHECK_IN,
    ));
  });

  it("lesson final beat in a unit", () => {
    expect(buildTeachingBeatControl(lessonState(), beat("first", 2))).toBe(lines(
      ...HEADER,
      "CONCEPT: First",
      "DELIVERY_UNIT_OBJECTIVE: Teach A through C",
      "BEAT_POSITION: final",
      'ASSIGNED_TEACHING_POINTS: [{"index":2,"content":"Point C","sourceReferences":[{"sourceId":"deck","page":2}]}]',
      UNIT_0_CRITERIA,
      CONTINUE,
      UNIT_BOUNDARY,
    ));
  });

  it("lesson only beat that ends a concept while other concepts remain", () => {
    expect(buildTeachingBeatControl(lessonState(), beat("first", 3))).toBe(lines(
      ...HEADER,
      "CONCEPT: First",
      "DELIVERY_UNIT_OBJECTIVE: Teach D",
      "BEAT_POSITION: only",
      'ASSIGNED_TEACHING_POINTS: [{"index":3,"content":"Point D","sourceReferences":[]}]',
      "RELEVANT_COMPLETION_CRITERIA: []",
      ESTABLISH,
      UNIT_BOUNDARY,
    ));
  });

  it("lesson final beat of the planned lesson includes wrap-up control (skipped counts as done)", () => {
    const state = withStatuses(lessonState(), { first: "taught", second: "skipped", third: "teaching" });
    expect(buildTeachingBeatControl(state, beat("third", 3))).toBe(lines(
      ...HEADER,
      "CONCEPT: Third",
      "DELIVERY_UNIT_OBJECTIVE: Teach D",
      "BEAT_POSITION: only",
      'ASSIGNED_TEACHING_POINTS: [{"index":3,"content":"Point D","sourceReferences":[]}]',
      "RELEVANT_COMPLETION_CRITERIA: []",
      ESTABLISH,
      "All planned lesson content will be covered after this beat. [[APP_CONTROL:LESSON_WRAP_UP]] Ask naturally whether the learner has any final questions. Do not restart or revisit content unless they ask. If they clearly have no more questions, call session_control with action end.",
    ));
  });

  it("review non-final beat", () => {
    expect(buildTeachingBeatControl(lessonState(), beat("first", 0, "review"), "Review prefix.")).toBe(lines(
      "Review prefix.",
      ...HEADER,
      "CONCEPT: First",
      "DELIVERY_UNIT_OBJECTIVE: Teach A through C",
      "BEAT_POSITION: first",
      'ASSIGNED_TEACHING_POINTS: [{"index":0,"content":"Point A","sourceReferences":[{"sourceId":"deck","page":1}]}]',
      UNIT_0_CRITERIA,
      ESTABLISH,
      "This review continues after this beat. Do not ask a question, invite learner interaction, or create a check-in merely because a delivery unit ended; finish with natural continuity because the application will immediately assign the next review beat.",
    ));
  });

  it("review final beat (even when it would also finish the planned lesson)", () => {
    const state = withStatuses(lessonState(), { second: "taught", third: "taught" });
    expect(buildTeachingBeatControl(state, beat("first", 3, "review"))).toBe(lines(
      ...HEADER,
      "CONCEPT: First",
      "DELIVERY_UNIT_OBJECTIVE: Teach D",
      "BEAT_POSITION: only",
      'ASSIGNED_TEACHING_POINTS: [{"index":3,"content":"Point D","sourceReferences":[]}]',
      "RELEVANT_COMPLETION_CRITERIA: []",
      ESTABLISH,
      "This is the final beat of a bounded node review. Briefly check whether the learner has questions or is ready to return to the main lesson. Do not continue into another concept and do not describe this review as new canonical progress.",
    ));
  });

  it("returns an empty string when the concept has no contract", () => {
    expect(buildTeachingBeatControl(lessonState(), beat("module", 0))).toBe("");
    expect(buildTeachingBeatControl(lessonState(), beat("missing", 0))).toBe("");
  });

  it("reads the supplied state rather than any other source", () => {
    const outstanding = buildTeachingBeatControl(lessonState(), beat("third", 3));
    const finishing = buildTeachingBeatControl(
      withStatuses(lessonState(), { first: "taught", second: "taught" }),
      beat("third", 3),
    );
    expect(outstanding).not.toContain("[[APP_CONTROL:LESSON_WRAP_UP]]");
    expect(finishing).toContain("[[APP_CONTROL:LESSON_WRAP_UP]]");
  });
});

describe("planLessonBeatAssignment", () => {
  it("plans the current concept's next beat without activation", () => {
    const state = withCursor(lessonState(), "first", 1);
    const plan = planLessonBeatAssignment(state, { wrapUp: false });

    expect(plan?.concept.id).toBe("first");
    expect(plan?.resolved).toMatchObject({ deliveryUnitIndex: 0, beatIndex: 1, teachingPointIndexes: [1] });
    expect(plan?.activatedState).toBeNull();
  });

  it("activates the next sequential concept when the current one is taught, without mutating input", () => {
    const state = withStatuses(withCursor(lessonState(), "first", 4), { first: "taught" });
    const plan = planLessonBeatAssignment(state, { wrapUp: false });

    expect(plan?.concept.id).toBe("second");
    expect(plan?.resolved).toMatchObject({ deliveryUnitIndex: 0, beatIndex: 0, teachingPointIndexes: [0] });
    expect(plan?.activatedState?.currentNodeId).toBe("second");
    expect(plan?.concept).toBe(plan?.activatedState?.nodes.second);
    expect(state.currentNodeId).toBe("first");
  });

  it("does not activate during wrap-up", () => {
    const state = withStatuses(withCursor(lessonState(), "first", 4), { first: "taught" });
    expect(planLessonBeatAssignment(state, { wrapUp: true })).toBeNull();
  });

  it("returns null when a taught concept has no successor", () => {
    const state = withStatuses(
      withCursor({ ...lessonState(), currentNodeId: "third" }, "third", 4),
      { first: "taught", second: "taught", third: "taught" },
    );
    expect(planLessonBeatAssignment(state, { wrapUp: false })).toBeNull();
  });

  it("returns null without a teachable current concept or a beat at the cursor", () => {
    expect(planLessonBeatAssignment({ ...lessonState(), currentNodeId: null }, { wrapUp: false })).toBeNull();
    expect(planLessonBeatAssignment({ ...lessonState(), currentNodeId: "module" }, { wrapUp: false })).toBeNull();
    expect(planLessonBeatAssignment(withCursor(lessonState(), "first", 4), { wrapUp: false })).toBeNull();
  });
});

describe("planReviewBeatAssignment", () => {
  const review = (overrides: Partial<NodeReviewState> = {}): NodeReviewState => ({
    nodeId: "first",
    nextTeachingPointIndex: 0,
    returnPresentationBeat: null,
    complete: false,
    ...overrides,
  });

  it("plans from the review cursor, independent of canonical progress", () => {
    const state = withCursor(lessonState(), "first", 3);
    const plan = planReviewBeatAssignment(state, review({ nextTeachingPointIndex: 1 }));

    expect(plan?.concept.id).toBe("first");
    expect(plan?.resolved).toMatchObject({ deliveryUnitIndex: 0, beatIndex: 1, teachingPointIndexes: [1] });
  });

  it("returns null for a complete review, a non-teachable node, or an exhausted cursor", () => {
    expect(planReviewBeatAssignment(lessonState(), review({ complete: true }))).toBeNull();
    expect(planReviewBeatAssignment(lessonState(), review({ nodeId: "module" }))).toBeNull();
    expect(planReviewBeatAssignment(lessonState(), review({ nodeId: "missing" }))).toBeNull();
    expect(planReviewBeatAssignment(lessonState(), review({ nextTeachingPointIndex: 4 }))).toBeNull();
  });
});

describe("createActiveBeat / createPresentationBeat", () => {
  it("creates a fresh, uncommitted active beat and a separate presentation beat", () => {
    const resolved = resolveNextPresentationBeat(contract(), 0)!;
    const active = createActiveBeat(resolved, "first", "review", 12);
    const presentation = createPresentationBeat(resolved, "first");

    expect(active).toEqual({
      ...resolved,
      conceptId: "first",
      mode: "review",
      generationEpoch: 12,
      generationComplete: false,
      audioNaturallyDrained: false,
      cancelled: false,
    });
    expect(presentation).toEqual({ ...resolved, conceptId: "first" });
    expect(presentation).not.toBe(active);
  });
});

describe("evaluateLessonBeatCommit", () => {
  it("commits a generated, naturally drained beat and auto-chains within a unit", () => {
    const state = lessonState();
    const evaluation = evaluateLessonBeatCommit(state, readyBeat("first", 0), true);

    expect(evaluation).toMatchObject({
      kind: "committed",
      previousIndex: 0,
      nextIndex: 1,
      wrapUp: false,
      autoChain: true,
    });
    if (evaluation.kind !== "committed") throw new Error("expected commit");
    expect(evaluation.state.teachingContractProgress.first.nextTeachingPointIndex).toBe(1);
    expect(state.teachingContractProgress.first.nextTeachingPointIndex).toBe(0);
  });

  it("waits for the learner after the final beat of a unit", () => {
    const evaluation = evaluateLessonBeatCommit(withCursor(lessonState(), "first", 2), readyBeat("first", 2), true);
    expect(evaluation).toMatchObject({ kind: "committed", nextIndex: 3, autoChain: false, wrapUp: false });
  });

  it("enters wrap-up when the commit completes the lesson", () => {
    const state = withStatuses(withCursor(lessonState(), "first", 3), { second: "taught", third: "skipped" });
    const evaluation = evaluateLessonBeatCommit(state, readyBeat("first", 3), true);

    expect(evaluation).toMatchObject({ kind: "committed", nextIndex: 4, autoChain: false, wrapUp: true });
    if (evaluation.kind !== "committed") throw new Error("expected commit");
    expect(evaluation.state.nodes.first.status).toBe("taught");
  });

  it.each([
    ["generation is incomplete (generationComplete alone never suffices)", { generationComplete: false }],
    ["audio did not drain naturally", { audioNaturallyDrained: false }],
    ["the beat was interrupted/cancelled", { cancelled: true }],
  ] satisfies Array<[string, Partial<ActiveTeachingBeat>]>)("is not ready when %s", (_label, change) => {
    const active = { ...readyBeat("first", 0), ...change };
    expect(evaluateLessonBeatCommit(lessonState(), active, true)).toEqual({ kind: "not-ready" });
  });

  it("is not ready when the lesson is inactive, the concept changed, or the cursor moved", () => {
    expect(evaluateLessonBeatCommit(lessonState(), readyBeat("first", 0), false)).toEqual({ kind: "not-ready" });
    expect(evaluateLessonBeatCommit({ ...lessonState(), currentNodeId: "second" }, readyBeat("first", 0), true))
      .toEqual({ kind: "not-ready" });
    expect(evaluateLessonBeatCommit(withCursor(lessonState(), "first", 1), readyBeat("first", 0), true))
      .toEqual({ kind: "not-ready" });
  });

  it("pins the tautological epoch check: the beat's own epoch is always treated as current", () => {
    const active = { ...readyBeat("first", 0), generationEpoch: 999 };
    expect(evaluateLessonBeatCommit(lessonState(), active, true).kind).toBe("committed");
  });

  it("reports rejection when the canonical transition refuses the beat", () => {
    const active = { ...readyBeat("first", 0), teachingPointIndexes: [0, 9] };
    expect(evaluateLessonBeatCommit(lessonState(), active, true)).toEqual({ kind: "rejected" });
  });
});

describe("evaluateReviewBeatCommit", () => {
  const review = (overrides: Partial<NodeReviewState> = {}): NodeReviewState => ({
    nodeId: "first",
    nextTeachingPointIndex: 0,
    returnPresentationBeat: null,
    complete: false,
    ...overrides,
  });

  it("advances only the review cursor and never canonical lesson state", () => {
    const state = withStatuses(withCursor(lessonState(), "first", 4), { first: "taught" });
    const snapshot = structuredClone(state);
    const current = review();
    const evaluation = evaluateReviewBeatCommit(state, current, readyBeat("first", 0, "review"), 5);

    expect(evaluation).toEqual({
      kind: "committed",
      review: { ...current, nextTeachingPointIndex: 1, complete: false },
      nextIndex: 1,
      complete: false,
    });
    expect(evaluation).not.toHaveProperty("state");
    expect(state).toEqual(snapshot);
    expect(current.nextTeachingPointIndex).toBe(0);
  });

  it("marks the review complete after the node's final teaching point", () => {
    const evaluation = evaluateReviewBeatCommit(
      lessonState(),
      review({ nextTeachingPointIndex: 3 }),
      readyBeat("first", 3, "review"),
      5,
    );
    expect(evaluation).toMatchObject({ kind: "committed", nextIndex: 4, complete: true, review: { complete: true } });
  });

  it.each([
    ["generation is incomplete", { generationComplete: false }],
    ["audio did not drain naturally", { audioNaturallyDrained: false }],
    ["the beat was cancelled", { cancelled: true }],
    ["the beat targets another node", { conceptId: "second" }],
  ] satisfies Array<[string, Partial<ActiveTeachingBeat>]>)("is not ready when %s", (_label, change) => {
    const active = { ...readyBeat("first", 0, "review"), ...change };
    expect(evaluateReviewBeatCommit(lessonState(), review(), active, 5)).toEqual({ kind: "not-ready" });
  });

  it("is not ready without a review, on epoch mismatch, cursor mismatch, or a non-teachable node", () => {
    const active = readyBeat("first", 0, "review");
    expect(evaluateReviewBeatCommit(lessonState(), null, active, 5)).toEqual({ kind: "not-ready" });
    expect(evaluateReviewBeatCommit(lessonState(), review(), active, 6)).toEqual({ kind: "not-ready" });
    expect(evaluateReviewBeatCommit(lessonState(), review({ nextTeachingPointIndex: 1 }), active, 5))
      .toEqual({ kind: "not-ready" });
    expect(evaluateReviewBeatCommit(
      lessonState(),
      review({ nodeId: "module" }),
      { ...active, conceptId: "module" },
      5,
    )).toEqual({ kind: "not-ready" });
  });
});
