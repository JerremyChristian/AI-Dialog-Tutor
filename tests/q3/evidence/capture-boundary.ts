// Decides whether evidence capture is starting late: live canonical runtime
// state and the persisted lesson must both still equal the seeded contract
// baseline. Pure, so the rules are unit-testable; the recorder feeds them
// browser-side reads.

import type { RawAppEvent } from "./types";

type Rec = Record<string, unknown>;
const asRecord = (value: unknown): Rec => value && typeof value === "object" && !Array.isArray(value)
  ? value as Rec : {};

const PROGRESSED_STATUSES = new Set(["taught", "skipped", "partial"]);

/**
 * App events that only occur once canonical progress has moved. Noncanonical
 * activity (assignments, audio, interruptions, clarification, Review beats,
 * engagement) is deliberately absent.
 */
function isCanonicalProgressEvent(event: RawAppEvent) {
  if (event.name === "beat.commit") return event.detail?.mode === "lesson";
  if (event.name === "tool.decision") {
    return event.detail?.name === "lesson_state" && event.detail?.outcome === "transition-applied";
  }
  return event.name === "delivery.cursor-changed" || event.name === "coverage.changed" ||
    event.name === "lesson.completed";
}

/** Canonical state as one source reports it; absent cursors are not checked. */
type CanonicalState = { currentNodeId: unknown; coverage: Rec; cursors: Record<string, unknown> };

/**
 * Compares one source's current concept, coverage and cursors with the seed.
 * Coverage has progressed when a concept became taught/skipped/partial, or a
 * not-started concept was activated. Hydration may normalize a seeded
 * non-current "teaching" concept down to "not-started"; that is not progress.
 */
function canonicalDivergence(source: string, seededLesson: Rec, state: CanonicalState): string | null {
  const seed = asRecord(seededLesson.lessonState);
  const seedNodes = asRecord(seed.nodes);
  const seedCurrent = typeof seed.currentNodeId === "string" ? seed.currentNodeId : null;
  if (state.currentNodeId !== seedCurrent) {
    return `${source} current concept is ${String(state.currentNodeId)}, seeded ${String(seedCurrent)}`;
  }
  for (const [id, node] of Object.entries(seedNodes)) {
    const seeded = asRecord(node).status;
    const value = state.coverage[id];
    const advanced = value !== seeded && (PROGRESSED_STATUSES.has(String(value)) ||
      (value === "teaching" && seeded === "not-started"));
    if (advanced) return `${source} coverage of ${id} is ${String(value)}, seeded ${String(seeded)}`;
  }
  const seedProgress = asRecord(seed.teachingContractProgress);
  for (const [id, cursor] of Object.entries(state.cursors)) {
    if (cursor === undefined) continue;
    const seededCursor = Number(asRecord(seedProgress[id]).nextTeachingPointIndex ?? 0);
    if (cursor !== seededCursor) return `${source} cursor of ${id} is ${String(cursor)}, seeded ${seededCursor}`;
  }
  return null;
}

/** Returns why live state has moved past the seed, or null when capture may start. */
export function liveCaptureDivergence(
  seededLesson: Rec,
  liveSnapshot: Rec | null,
  liveEvents: RawAppEvent[],
): string | null {
  if (!liveSnapshot) return "live canonical state is unavailable";
  const progress = liveEvents.find(isCanonicalProgressEvent);
  if (progress) return `live runtime already emitted ${progress.name}`;
  // The live snapshot exposes only the current concept's cursor.
  const seedCurrent = asRecord(seededLesson.lessonState).currentNodeId;
  const cursors = typeof seedCurrent === "string" && typeof liveSnapshot.deliveryCursor === "number"
    ? { [seedCurrent]: liveSnapshot.deliveryCursor } : {};
  return canonicalDivergence("live", seededLesson, {
    currentNodeId: liveSnapshot.currentNodeId, coverage: asRecord(liveSnapshot.coverage), cursors,
  });
}

/**
 * Returns why the persisted lesson has moved past the seed, or null. Persistence
 * is debounced, so it can lag live state (the live check covers that race) but
 * may also hold progress the live runtime never showed; both must match.
 */
export function persistedCaptureDivergence(seededLesson: Rec, persistedLesson: Rec | undefined): string | null {
  if (!persistedLesson) return "persisted lesson is unavailable";
  const state = asRecord(persistedLesson.lessonState);
  const coverage = Object.fromEntries(Object.entries(asRecord(state.nodes))
    .map(([id, node]) => [id, asRecord(node).status]));
  const progress = asRecord(state.teachingContractProgress);
  const ids = new Set([...Object.keys(asRecord(asRecord(seededLesson.lessonState).teachingContractProgress)),
    ...Object.keys(progress)]);
  const cursors = Object.fromEntries([...ids]
    .map((id) => [id, Number(asRecord(progress[id]).nextTeachingPointIndex ?? 0)]));
  return canonicalDivergence("persisted", seededLesson, { currentNodeId: state.currentNodeId ?? null, coverage, cursors });
}
