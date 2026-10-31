import type { AtomicTeachingContract } from "./learning-source";
import {
  activateNextSequentialConcept,
  commitDeliveredTeachingBeat,
  getCurrentConcept,
  LESSON_WRAP_UP_CONTROL,
  type LessonNode,
  type LessonState,
} from "./lesson-state";
import {
  computeNextTeachingPointIndexAfterBeat,
  isBeatCommitValid,
  resolveNextPresentationBeat,
  type ResolvedTeachingBeat,
} from "./teaching-delivery";

export type ActiveTeachingBeat = ResolvedTeachingBeat & {
  conceptId: string;
  mode: "lesson" | "review";
  generationEpoch: number;
  generationComplete: boolean;
  audioNaturallyDrained: boolean;
  cancelled: boolean;
};

export type PresentationBeat = ResolvedTeachingBeat & { conceptId: string };

export type NodeReviewState = {
  nodeId: string;
  nextTeachingPointIndex: number;
  returnPresentationBeat: PresentationBeat | null;
  complete: boolean;
};

export type TeachableConcept = LessonNode & { teaching: AtomicTeachingContract };

export type LessonBeatAssignmentPlan = {
  concept: TeachableConcept;
  resolved: ResolvedTeachingBeat;
  activatedState: LessonState | null;
};

export type ReviewBeatAssignmentPlan = {
  concept: TeachableConcept;
  resolved: ResolvedTeachingBeat;
};

export type LessonBeatCommitEvaluation =
  | { kind: "not-ready" }
  | { kind: "rejected" }
  | {
    kind: "committed";
    state: LessonState;
    previousIndex: number;
    nextIndex: number;
    wrapUp: boolean;
    autoChain: boolean;
  };

export type ReviewBeatCommitEvaluation =
  | { kind: "not-ready" }
  | { kind: "committed"; review: NodeReviewState; nextIndex: number; complete: boolean };

export function buildTeachingBeatControl(state: LessonState, active: ActiveTeachingBeat, prefix = "") {
  const concept = state.nodes[active.conceptId];
  const contract = concept?.teaching;
  if (!contract) return "";
  const points = active.teachingPointIndexes.map((index) => ({
    index,
    content: contract.teachingPoints[index],
    sourceReferences: contract.teachingPointSourceReferences?.[index] ?? [],
  }));
  const criteria = active.unit.completionCriteriaIndexes.map((index) => ({
    index,
    content: contract.completionCriteria[index],
  }));
  const position = active.isFirstBeatInUnit
    ? active.isFinalBeatInUnit ? "only" : "first"
    : active.isFinalBeatInUnit ? "final" : "middle";
  const otherOutstandingConcept = Object.values(state.nodes).some((candidate) =>
    candidate.id !== active.conceptId && candidate.childrenIds.length === 0 &&
    Boolean(candidate.teaching) && candidate.status !== "taught" &&
    candidate.status !== "skipped",
  );
  const completesPlannedLesson = active.mode === "lesson" && active.teachingPointIndexes.at(-1) ===
    contract.teachingPoints.length - 1 && !otherOutstandingConcept;
  const completesReview = active.mode === "review" && active.teachingPointIndexes.at(-1) ===
    contract.teachingPoints.length - 1;
  return `${prefix}\n[[APP_CONTROL:TEACH_PRESENTATION_BEAT]]
Teach exactly this application-assigned presentation beat as one natural source-grounded spoken explanation. Do not call progress or complete.
CONCEPT: ${concept.title}
DELIVERY_UNIT_OBJECTIVE: ${active.unit.objective}
BEAT_POSITION: ${position}
ASSIGNED_TEACHING_POINTS: ${JSON.stringify(points)}
RELEVANT_COMPLETION_CRITERIA: ${JSON.stringify(criteria)}
${active.isFirstBeatInUnit ? "Establish the unit naturally." : "Continue directly from the preceding explanation without greeting, praise, announcing a new section, or unnecessary recap."}
${active.mode === "review"
  ? completesReview
    ? "This is the final beat of a bounded node review. Briefly check whether the learner has questions or is ready to return to the main lesson. Do not continue into another concept and do not describe this review as new canonical progress."
    : "This review continues after this beat. Do not ask a question, invite learner interaction, or create a check-in merely because a delivery unit ended; finish with natural continuity because the application will immediately assign the next review beat."
  : completesPlannedLesson
  ? `All planned lesson content will be covered after this beat. ${LESSON_WRAP_UP_CONTROL} Ask naturally whether the learner has any final questions. Do not restart or revisit content unless they ask. If they clearly have no more questions, call session_control with action end.`
  : active.isFinalBeatInUnit
    ? "Briefly synthesize if useful, then create a natural learner interaction boundary; vary the check-in and do not use a fixed script."
    : "Do not ask a question or invite learner interaction at the end; finish with natural continuity because the application will immediately assign the next beat."}`.trim();
}

/**
 * Pure planning portion of lesson beat assignment. Runtime guards (lesson
 * active, no active beat, no farewell, no review) stay with the caller.
 * The activated state is returned, not applied: the caller commits it only
 * after the beat instruction is sent successfully.
 */
export function planLessonBeatAssignment(
  state: LessonState,
  { wrapUp }: { wrapUp: boolean },
): LessonBeatAssignmentPlan | null {
  let concept = getCurrentConcept(state);
  let activatedState: LessonState | null = null;
  if (concept?.status === "taught" && !wrapUp) {
    const activated = activateNextSequentialConcept(state);
    if (!activated) return null;
    state = activated;
    activatedState = activated;
    concept = getCurrentConcept(activated);
  }
  if (!concept?.teaching) return null;
  const nextIndex = state.teachingContractProgress[concept.id]?.nextTeachingPointIndex ?? 0;
  const resolved = resolveNextPresentationBeat(concept.teaching, nextIndex);
  if (!resolved) return null;
  return { concept: concept as TeachableConcept, resolved, activatedState };
}

/**
 * Pure planning portion of review beat assignment. Runtime guards (lesson
 * active, no active beat, no farewell, review present) stay with the caller.
 */
export function planReviewBeatAssignment(
  state: LessonState,
  review: NodeReviewState,
): ReviewBeatAssignmentPlan | null {
  const concept = state.nodes[review.nodeId];
  if (review.complete || !concept?.teaching) return null;
  const resolved = resolveNextPresentationBeat(concept.teaching, review.nextTeachingPointIndex);
  if (!resolved) return null;
  return { concept: concept as TeachableConcept, resolved };
}

export function createActiveBeat(
  resolved: ResolvedTeachingBeat,
  conceptId: string,
  mode: ActiveTeachingBeat["mode"],
  generationEpoch: number,
): ActiveTeachingBeat {
  return {
    ...resolved,
    conceptId,
    mode,
    generationEpoch,
    generationComplete: false,
    audioNaturallyDrained: false,
    cancelled: false,
  };
}

export function createPresentationBeat(resolved: ResolvedTeachingBeat, conceptId: string): PresentationBeat {
  return { ...resolved, conceptId };
}

/**
 * Lesson-mode commit decision. The caller has already verified that `active`
 * is the current active beat for the drained epoch.
 */
export function evaluateLessonBeatCommit(
  state: LessonState,
  active: ActiveTeachingBeat,
  lessonActive: boolean,
): LessonBeatCommitEvaluation {
  const currentNext = state.teachingContractProgress[active.conceptId]?.nextTeachingPointIndex ?? 0;
  if (!isBeatCommitValid({
    expectedConceptId: active.conceptId,
    currentConceptId: state.currentNodeId,
    expectedEpoch: active.generationEpoch,
    // Intentionally tautological: the caller passes the current active beat,
    // so this preserves the existing check (refactor-plan §6.1).
    currentEpoch: active.generationEpoch,
    expectedStartIndex: active.teachingPointIndexes[0],
    currentNextTeachingPointIndex: currentNext,
    generationComplete: active.generationComplete,
    audioNaturallyDrained: active.audioNaturallyDrained,
    cancelled: active.cancelled,
    lessonActive,
  })) return { kind: "not-ready" };
  const transition = commitDeliveredTeachingBeat(state, active.conceptId, active.teachingPointIndexes);
  if (!transition.result.ok) return { kind: "rejected" };
  return {
    kind: "committed",
    state: transition.state,
    previousIndex: currentNext,
    nextIndex: computeNextTeachingPointIndexAfterBeat(active.teachingPointIndexes),
    wrapUp: transition.state.status === "completed",
    autoChain: !active.isFinalBeatInUnit,
  };
}

/**
 * Review-mode commit decision. Advances only the review cursor; canonical
 * lesson state is read but never changed.
 */
export function evaluateReviewBeatCommit(
  state: LessonState,
  review: NodeReviewState | null,
  active: ActiveTeachingBeat,
  currentEpoch: number,
): ReviewBeatCommitEvaluation {
  if (!review || review.nodeId !== active.conceptId || active.cancelled ||
      !active.generationComplete || !active.audioNaturallyDrained ||
      active.generationEpoch !== currentEpoch ||
      active.teachingPointIndexes[0] !== review.nextTeachingPointIndex) return { kind: "not-ready" };
  const concept = state.nodes[review.nodeId];
  if (!concept?.teaching) return { kind: "not-ready" };
  const nextIndex = computeNextTeachingPointIndexAfterBeat(active.teachingPointIndexes);
  const complete = nextIndex >= concept.teaching.teachingPoints.length;
  return {
    kind: "committed",
    review: { ...review, nextTeachingPointIndex: nextIndex, complete },
    nextIndex,
    complete,
  };
}
