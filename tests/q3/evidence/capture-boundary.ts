// Decides whether evidence capture is starting late: live canonical runtime
// state must still equal the seeded contract baseline. Pure, so the rule is
// unit-testable; the recorder feeds it one atomic browser-side read.

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

/** Returns why live state has moved past the seed, or null when capture may start. */
export function liveCaptureDivergence(
  seededLesson: Rec,
  liveSnapshot: Rec | null,
  liveEvents: RawAppEvent[],
): string | null {
  if (!liveSnapshot) return "live canonical state is unavailable";
  const progress = liveEvents.find(isCanonicalProgressEvent);
  if (progress) return `live runtime already emitted ${progress.name}`;

  const seed = asRecord(seededLesson.lessonState);
  const seedNodes = asRecord(seed.nodes);
  const seedCurrent = typeof seed.currentNodeId === "string" ? seed.currentNodeId : null;
  if (liveSnapshot.currentNodeId !== seedCurrent) {
    return `live current concept is ${String(liveSnapshot.currentNodeId)}, seeded ${String(seedCurrent)}`;
  }
  // Coverage has progressed when a concept became taught/skipped/partial, or a
  // not-started concept was activated. Hydration may normalize a seeded
  // non-current "teaching" concept down to "not-started"; that is not progress.
  const liveCoverage = asRecord(liveSnapshot.coverage);
  for (const [id, node] of Object.entries(seedNodes)) {
    const seeded = asRecord(node).status;
    const live = liveCoverage[id];
    const advanced = live !== seeded && (PROGRESSED_STATUSES.has(String(live)) ||
      (live === "teaching" && seeded === "not-started"));
    if (advanced) return `live coverage of ${id} is ${String(live)}, seeded ${String(seeded)}`;
  }
  if (seedCurrent && typeof liveSnapshot.deliveryCursor === "number") {
    const seededCursor = Number(asRecord(asRecord(seed.teachingContractProgress)[seedCurrent]).nextTeachingPointIndex ?? 0);
    if (liveSnapshot.deliveryCursor !== seededCursor) {
      return `live cursor of ${seedCurrent} is ${liveSnapshot.deliveryCursor}, seeded ${seededCursor}`;
    }
  }
  return null;
}
