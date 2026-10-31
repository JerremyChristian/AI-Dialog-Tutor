import { describe, expect, it } from "vitest";

import {
  activateNextSequentialConcept,
  commitDeliveredTeachingBeat,
  createLessonState,
  isLessonPlanComplete,
  navigateLessonState,
  pauseLessonState,
  skipLessonNode,
  type LessonState,
} from "../../lib/lesson-state";
import {
  isBeatCommitValid,
  resolveNextPresentationBeat,
  type BeatCommitContext,
} from "../../lib/teaching-delivery";
import type { AtomicTeachingContract, LessonTreeItem } from "../../lib/learning-source";

function contract(overrides: Partial<AtomicTeachingContract> = {}): AtomicTeachingContract {
  return {
    objective: "Understand the concept",
    teachingPoints: ["Point 1", "Point 2", "Point 3", "Point 4"],
    completionCriteria: ["Can explain it"],
    type: "concept",
    importance: "core",
    deliveryUnits: [
      {
        objective: "Teach points 1 through 3",
        teachingPointIndexes: [0, 1, 2],
        completionCriteriaIndexes: [0],
        presentationBeats: [
          { teachingPointIndexes: [0] },
          { teachingPointIndexes: [1, 2] },
        ],
      },
      {
        objective: "Teach point 4",
        teachingPointIndexes: [3],
        completionCriteriaIndexes: [],
        presentationBeats: [{ teachingPointIndexes: [3] }],
      },
    ],
    ...overrides,
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
  return createLessonState("Characterization", lessonTree());
}

describe("isBeatCommitValid", () => {
  const valid: BeatCommitContext = {
    expectedConceptId: "first",
    currentConceptId: "first",
    expectedEpoch: 7,
    currentEpoch: 7,
    expectedStartIndex: 1,
    currentNextTeachingPointIndex: 1,
    generationComplete: true,
    audioNaturallyDrained: true,
    cancelled: false,
    lessonActive: true,
  };

  it("accepts a valid commit baseline", () => {
    expect(isBeatCommitValid(valid)).toBe(true);
  });

  it.each([
    ["lesson is inactive", { lessonActive: false }],
    ["assignment was cancelled", { cancelled: true }],
    ["generation is incomplete", { generationComplete: false }],
    ["audio did not drain naturally", { audioNaturallyDrained: false }],
    ["concept changed", { currentConceptId: "second" }],
    ["epoch changed", { currentEpoch: 8 }],
    ["cursor changed", { currentNextTeachingPointIndex: 2 }],
  ] satisfies Array<[string, Partial<BeatCommitContext>]>)
    ("rejects when %s", (_label, change) => {
      expect(isBeatCommitValid({ ...valid, ...change })).toBe(false);
    });
});

describe("resolveNextPresentationBeat", () => {
  const explicit = contract();

  it.each([
    ["first", 0, 0, 0, [0], true, false],
    ["middle", 1, 0, 1, [1, 2], false, true],
    ["final", 3, 1, 0, [3], true, true],
  ] as const)("resolves the %s beat", (_label, cursor, unit, beat, points, first, final) => {
    expect(resolveNextPresentationBeat(explicit, cursor)).toMatchObject({
      deliveryUnitIndex: unit,
      beatIndex: beat,
      teachingPointIndexes: [...points],
      isFirstBeatInUnit: first,
      isFinalBeatInUnit: final,
    });
  });

  it("falls back to legacy delivery units when deliveryUnits are absent", () => {
    const legacy = contract({
      deliveryUnits: undefined,
      teachingPointSourceReferences: [
        [{ sourceId: "source", page: 1 }],
        [{ sourceId: "source", page: 2 }],
        [{ sourceId: "source", page: 2 }],
        [],
      ],
    });

    expect(resolveNextPresentationBeat(legacy, 1)).toMatchObject({
      deliveryUnitIndex: 0,
      beatIndex: 1,
      teachingPointIndexes: [1, 2],
      isFirstBeatInUnit: false,
      isFinalBeatInUnit: true,
    });
  });

  it.each([-1, 2, 4, 99])("returns null for cursor %s when it is invalid or not a beat boundary", (cursor) => {
    expect(resolveNextPresentationBeat(explicit, cursor)).toBeNull();
  });
});

describe("commitDeliveredTeachingBeat", () => {
  it("advances only the cursor for a non-final beat", () => {
    const initial = lessonState();
    const committed = commitDeliveredTeachingBeat(initial, "first", [0]);

    expect(committed.result.ok).toBe(true);
    expect(committed.result.action).toBe("progress");
    expect(committed.state.teachingContractProgress.first.nextTeachingPointIndex).toBe(1);
    expect(committed.state.nodes.first.status).toBe("teaching");
    expect(committed.state.currentNodeId).toBe("first");
  });

  it("marks the current concept taught when the final beat completes its contract", () => {
    const initial = lessonState();
    const nearlyDone: LessonState = {
      ...initial,
      teachingContractProgress: {
        ...initial.teachingContractProgress,
        first: { nextTeachingPointIndex: 3 },
      },
    };
    const committed = commitDeliveredTeachingBeat(nearlyDone, "first", [3]);

    expect(committed.result).toMatchObject({ ok: true, action: "complete", completedNodeId: "first" });
    expect(committed.state.teachingContractProgress.first.nextTeachingPointIndex).toBe(4);
    expect(committed.state.nodes.first.status).toBe("taught");
    expect(committed.state.currentNodeId).toBe("first");
  });

  it("rejects a beat for a non-current concept without changing state", () => {
    const initial = lessonState();
    const committed = commitDeliveredTeachingBeat(initial, "second", [0]);

    expect(committed.result).toMatchObject({ ok: false, action: "progress", error: "invalid_transition" });
    expect(committed.state).toBe(initial);
    expect(committed.state.teachingContractProgress.second.nextTeachingPointIndex).toBe(0);
  });

  it("treats a duplicate final commit as a no-op", () => {
    const initial = lessonState();
    const ready: LessonState = {
      ...initial,
      teachingContractProgress: {
        ...initial.teachingContractProgress,
        first: { nextTeachingPointIndex: 3 },
      },
    };
    const firstCommit = commitDeliveredTeachingBeat(ready, "first", [3]);
    const duplicate = commitDeliveredTeachingBeat(firstCommit.state, "first", [3]);

    expect(duplicate.result).toMatchObject({
      ok: true,
      action: "complete",
      noOp: true,
      reason: "already_taught",
      completedNodeId: "first",
    });
    expect(duplicate.state).toBe(firstCommit.state);
  });
});

describe("lesson-state transitions", () => {
  it("activateNextSequentialConcept activates the next unfinished concept and clears resume state", () => {
    const initial = lessonState();
    const taughtFirst: LessonState = {
      ...initial,
      nodes: {
        ...initial.nodes,
        first: { ...initial.nodes.first, status: "taught" },
      },
      resumePoint: "old resume point",
    };

    const activated = activateNextSequentialConcept(taughtFirst);

    expect(activated).not.toBeNull();
    expect(activated).toMatchObject({ currentNodeId: "second", status: "teaching", resumePoint: "" });
    expect(activated?.nodes.second.status).toBe("teaching");
    expect(activateNextSequentialConcept({ ...taughtFirst, currentNodeId: "third" })).toBeNull();
  });

  it("isLessonPlanComplete counts skipped teachable nodes as complete", () => {
    const initial = lessonState();
    const complete: LessonState = {
      ...initial,
      nodes: {
        ...initial.nodes,
        first: { ...initial.nodes.first, status: "taught" },
        second: { ...initial.nodes.second, status: "skipped" },
        third: { ...initial.nodes.third, status: "taught" },
      },
    };

    expect(isLessonPlanComplete(initial)).toBe(false);
    expect(isLessonPlanComplete(complete)).toBe(true);
    expect(isLessonPlanComplete(createLessonState("Empty"))).toBe(false);
  });

  it("navigateLessonState marks the current concept partial and skipped concepts skipped", () => {
    const initial = lessonState();
    const navigated = navigateLessonState(initial, "third");

    expect(navigated.result).toMatchObject({ ok: true, action: "navigate", currentNodeId: "third" });
    expect(navigated.state.nodes.first.status).toBe("partial");
    expect(navigated.state.nodes.second.status).toBe("skipped");
    expect(navigated.state.nodes.third.status).toBe("teaching");
    expect(navigated.state.resumePoint).toBe("");
  });

  it("navigateLessonState resolves a structural node to its first incomplete descendant", () => {
    const initial = lessonState();
    const moved = navigateLessonState({
      ...initial,
      currentNodeId: "third",
      nodes: {
        ...initial.nodes,
        first: { ...initial.nodes.first, status: "taught" },
        third: { ...initial.nodes.third, status: "teaching" },
      },
    }, "module");

    expect(moved.result).toMatchObject({ ok: true, currentNodeId: "second" });
    expect(moved.state.nodes.second.status).toBe("teaching");
  });

  it("skipLessonNode preserves a current teaching concept as partial and clears selection", () => {
    const initial = lessonState();
    const skipped = skipLessonNode(initial, "module");

    expect(skipped.result).toMatchObject({ ok: true, action: "skip", currentNodeId: null });
    expect(skipped.state.nodes.first.status).toBe("partial");
    expect(skipped.state.nodes.second.status).toBe("skipped");
    expect(skipped.state.nodes.third.status).toBe("skipped");
    expect(skipped.state.resumePoint).toBe("");
  });

  it("pauseLessonState records matching progress and preserves completed status", () => {
    const initial = { ...lessonState(), status: "teaching" as const };
    const paused = pauseLessonState(initial, { conceptId: "first", resumePoint: "after point one" });

    expect(paused).toMatchObject({ status: "idle", resumePoint: "after point one" });
    expect(paused.nodes.first.status).toBe("partial");

    const completed = pauseLessonState({ ...initial, status: "completed" }, {
      conceptId: "second",
      resumePoint: "wrong concept",
    });
    expect(completed.status).toBe("completed");
    expect(completed.resumePoint).toBe(initial.resumePoint);
    expect(completed.nodes.first.status).toBe("teaching");
  });
});
