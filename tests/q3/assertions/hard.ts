// Deterministic Q3 hard assertions over an EvidencePacket. Pure code: no LLM,
// no timing thresholds, no pedagogical opinion. Each assertion reports pass,
// fail (with evidence references), not-applicable (nothing in the packet
// exercises it), or unsupported (the packet lacks the evidence to decide).

import { stableStringify } from "../evidence/build";
import type { EvidenceEvent, EvidencePacket, EvidenceSnapshot } from "../evidence/types";

export const HARD_EVALUATOR_VERSION = "q3a-hard-1";

export type HardAssertionId = "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "H7" | "H8" | "H10";
export type HardStatus = "pass" | "fail" | "not-applicable" | "unsupported";
export type Violation = { message: string; evidence: string[] };

export type HardAssertionResult = {
  id: HardAssertionId;
  title: string;
  status: HardStatus;
  violations: Violation[];
  notes: string[];
};

export type CorePathSummary = {
  status: "complete" | "incomplete" | "aborted";
  allCoreBeatsCommitted: boolean;
  requiredCoreBeats: number;
  committedCoreBeats: number;
  incompleteCoreConcepts: Array<{ conceptId: string; cursor: number; required: number; attributedTo: string[] }>;
};

export type HardEvaluation = {
  evaluatorVersion: typeof HARD_EVALUATOR_VERSION;
  packetId: string;
  packetHash: string;
  /**
   * fail: any hard violation. inconclusive: no violation, but an applicable
   * assertion was unsupported, the capture is partial (open or aborted), or a
   * finished capture has no final canonical anchor. pass: a finished, anchored
   * capture where every applicable assertion was proven. not-applicable
   * assertions never affect the verdict.
   */
  verdict: "pass" | "fail" | "inconclusive";
  finalization: FinalizationEvidence;
  assertions: HardAssertionResult[];
  deferred: Array<{ id: string; reason: string }>;
  corePath: CorePathSummary;
};

export const DEFERRED_ASSERTIONS: HardEvaluation["deferred"] = [
  { id: "H9", reason: "Liveness depends on real-provider timing; reported as performance measurements, never a hard gate." },
  { id: "H11", reason: "Harness integrity (caps, student output validation, network allow-list) belongs to the Q3-C/Q3-D harness." },
  { id: "stale-audio", reason: "Stale audio rejection is Q1-owned; the packet records no per-chunk admission evidence." },
  {
    id: "non-beat-output-stop",
    reason: "Clarification and farewell output has no lifecycle end event, so physical stop of interrupted non-beat output is not provable from Q3-A evidence.",
  },
];

/** Tokens that only exist in app/provider control traffic and must never be spoken. */
export const INTERNAL_CONTROL_PATTERNS: RegExp[] = [
  /APP_CONTROL/i,
  /\[\[|\]\]/,
  /\b(lesson_state|session_control|update_teaching_preferences)\b/,
  /\bteachingAssignment\b/,
  /\bTEACH_PRESENTATION_BEAT\b/,
];

const CANONICAL_CHANGE_EVENTS = new Set(["beat.commit", "delivery.cursor-changed", "coverage.changed"]);

// ---- packet access helpers ----

const app = (event: EvidenceEvent, name: string) => event.source === "app" && event.name === name;
const str = (event: EvidenceEvent, key: string) =>
  typeof event.detail?.[key] === "string" ? event.detail[key] as string : null;
const num = (event: EvidenceEvent, key: string) =>
  typeof event.detail?.[key] === "number" ? event.detail[key] as number : null;
const isLessonCommit = (event: EvidenceEvent) => app(event, "beat.commit") && event.detail?.mode === "lesson";
const isReviewCommit = (event: EvidenceEvent) => app(event, "beat.commit") && event.detail?.mode === "review";
const isCanonicalChange = (event: EvidenceEvent) => event.source === "app" &&
  CANONICAL_CHANGE_EVENTS.has(event.name) && !(event.name === "beat.commit" && event.detail?.mode === "review");
const isAppliedTransition = (event: EvidenceEvent) => app(event, "tool.decision") &&
  event.detail?.name === "lesson_state" && event.detail?.outcome === "transition-applied";
const tpis = (event: EvidenceEvent) => Array.isArray(event.detail?.teachingPointIndexes)
  ? (event.detail!.teachingPointIndexes as unknown[]).map(Number) : null;
const sameIndexes = (a: number[], b: number[]) => a.length === b.length && a.every((value, i) => value === b[i]);

function result(id: HardAssertionId, title: string, violations: Violation[], applicable: boolean, notes: string[] = [],
  unsupported = false): HardAssertionResult {
  return {
    id, title, notes,
    violations,
    status: violations.length ? "fail" : unsupported ? "unsupported" : applicable ? "pass" : "not-applicable",
  };
}

/**
 * Replays canonical cursors from the contract's initial state through lesson
 * commits. `cursorsAt(seq)` answers "what had been committed by event seq".
 */
function cursorReplay(packet: EvidencePacket) {
  const timeline: Array<{ seq: number; cursors: Record<string, number> }> = [];
  const cursors = { ...packet.contract.initial.cursors };
  timeline.push({ seq: 0, cursors: { ...cursors } });
  for (const event of packet.events) {
    if (app(event, "delivery.cursor-changed")) {
      const conceptId = str(event, "conceptId");
      const to = num(event, "to");
      if (conceptId && to !== null) {
        cursors[conceptId] = to;
        timeline.push({ seq: event.seq, cursors: { ...cursors } });
      }
    }
  }
  return {
    final: cursors,
    at(seq: number) {
      let found = timeline[0].cursors;
      for (const entry of timeline) if (entry.seq <= seq) found = entry.cursors;
      return found;
    },
  };
}

const conceptById = (packet: EvidencePacket, id: string) => packet.contract.concepts.find((concept) => concept.id === id);
const requiredCount = (packet: EvidencePacket, id: string) => conceptById(packet, id)?.teachingPoints.length ?? 0;

// ---- H1: canonical cursor / navigation integrity ----

export function checkH1(packet: EvidencePacket): HardAssertionResult {
  const violations: Violation[] = [];
  const cursors = { ...packet.contract.initial.cursors };
  let applicable = false;
  const events = packet.events;
  const appEvents = events.filter(({ source }) => source === "app");

  appEvents.forEach((event, index) => {
    if (isLessonCommit(event)) {
      applicable = true;
      const conceptId = str(event, "conceptId") ?? "";
      const concept = conceptById(packet, conceptId);
      const indexes = tpis(event);
      const next = num(event, "nextIndex");
      if (!concept) {
        violations.push({ message: `lesson beat.commit for unknown concept "${conceptId}"`, evidence: [event.id] });
        return;
      }
      if (!indexes) {
        violations.push({ message: "lesson beat.commit lacks teachingPointIndexes", evidence: [event.id] });
        return;
      }
      if (!concept.beats.some((beat) => sameIndexes(beat, indexes))) {
        violations.push({ message: `committed points [${indexes}] are not a canonical beat of ${conceptId}`, evidence: [event.id] });
      }
      if (indexes[0] !== cursors[conceptId]) {
        violations.push({
          message: `${conceptId} committed points starting at ${indexes[0]} while its cursor was ${cursors[conceptId]}`,
          evidence: [event.id],
        });
      }
      if (next !== indexes[indexes.length - 1] + 1) {
        violations.push({ message: `beat.commit nextIndex ${next} does not follow committed points [${indexes}]`, evidence: [event.id] });
      }
    }
    if (app(event, "delivery.cursor-changed")) {
      applicable = true;
      const conceptId = str(event, "conceptId") ?? "";
      const from = num(event, "from");
      const to = num(event, "to");
      const previous = appEvents[index - 1];
      if (!previous || !isLessonCommit(previous) || str(previous, "conceptId") !== conceptId ||
          num(previous, "nextIndex") !== to) {
        violations.push({
          message: `cursor change for ${conceptId} is not paired with its lesson beat.commit`,
          evidence: [event.id, ...(previous ? [previous.id] : [])],
        });
      }
      if (from !== cursors[conceptId]) {
        violations.push({ message: `${conceptId} cursor moved from ${from} but was ${cursors[conceptId]}`, evidence: [event.id] });
      }
      if (to === null || from === null || to <= from) {
        violations.push({ message: `${conceptId} cursor did not advance (${from} -> ${to})`, evidence: [event.id] });
      }
      if (to !== null && to > requiredCount(packet, conceptId)) {
        violations.push({ message: `${conceptId} cursor ${to} exceeds its ${requiredCount(packet, conceptId)} teaching points`, evidence: [event.id] });
      }
      if (to !== null) cursors[conceptId] = to;
    }
  });

  // Snapshot cross-check: the reported canonical cursor always equals the
  // replayed committed cursor, and every change of current concept is
  // explained by an applied transition or a teaching assignment for it.
  const replay = cursorReplay(packet);
  let previousNode = packet.contract.initial.currentNodeId;
  let previousSeq = 0;
  for (const snapshot of packet.snapshots) {
    const { currentNodeId, deliveryCursor } = snapshot.canonical;
    if (currentNodeId && deliveryCursor !== null && conceptById(packet, currentNodeId)) {
      applicable = true;
      const expected = replay.at(snapshot.afterSeq)[currentNodeId];
      if (deliveryCursor !== expected) {
        violations.push({
          message: `snapshot reports ${currentNodeId} cursor ${deliveryCursor}; committed evidence gives ${expected}`,
          evidence: [snapshot.id, ...(snapshot.afterEventId ? [snapshot.afterEventId] : [])],
        });
      }
    }
    if (currentNodeId && currentNodeId !== previousNode) {
      applicable = true;
      const between = events.filter(({ seq }) => seq > previousSeq && seq <= snapshot.afterSeq);
      const explained = between.some((event) => isAppliedTransition(event) ||
        (app(event, "lesson.generation-started") && str(event, "conceptId") === currentNodeId));
      if (!explained) {
        violations.push({
          message: `current concept changed ${previousNode} -> ${currentNodeId} without an applied navigation or teaching assignment`,
          evidence: [snapshot.id],
        });
      }
    }
    if (currentNodeId) previousNode = currentNodeId;
    previousSeq = snapshot.afterSeq;
  }
  return result("H1", "Canonical cursor and navigation integrity", violations, applicable);
}

// ---- H2: no duplicate lesson beat.commit ----

export function checkH2(packet: EvidencePacket): HardAssertionResult {
  const violations: Violation[] = [];
  const seen = new Map<string, string>();
  for (const event of packet.events.filter(isLessonCommit)) {
    const indexes = tpis(event);
    const key = `${str(event, "conceptId")}:${indexes ? indexes.join(",") : `next=${num(event, "nextIndex")}`}`;
    const earlier = seen.get(key);
    if (earlier) violations.push({ message: `lesson beat ${key} committed more than once`, evidence: [earlier, event.id] });
    else seen.set(key, event.id);
  }
  return result("H2", "No duplicate lesson beat.commit", violations, seen.size > 0);
}

// ---- H3: interrupted/invalidated beats never commit; commits follow natural drain ----

export function checkH3(packet: EvidencePacket): HardAssertionResult {
  const violations: Violation[] = [];
  const started = new Map<number, EvidenceEvent>();
  const drained = new Map<number, EvidenceEvent>();
  const invalidated = new Map<number, EvidenceEvent>();
  let applicable = false;
  for (const event of packet.events) {
    if (app(event, "lesson.generation-started")) {
      const epoch = num(event, "generationEpoch");
      if (epoch !== null) started.set(epoch, event);
    } else if (app(event, "tutor.audio-ended") && event.detail?.natural === true) {
      const epoch = num(event, "generationEpoch");
      if (epoch !== null) drained.set(epoch, event);
    } else if (app(event, "audio.epoch-invalidated")) {
      applicable = true;
      const epoch = num(event, "invalidatedEpoch");
      if (epoch !== null) invalidated.set(epoch, event);
    } else if (app(event, "beat.commit")) {
      applicable = true;
      const epoch = num(event, "generationEpoch");
      if (epoch === null) {
        violations.push({ message: "beat.commit has no generationEpoch correlation", evidence: [event.id] });
        continue;
      }
      const invalidation = invalidated.get(epoch);
      if (invalidation) {
        violations.push({ message: `epoch ${epoch} committed after it was invalidated (${str(invalidation, "reason")})`, evidence: [invalidation.id, event.id] });
      }
      if (isReviewCommit(event)) continue;
      const start = started.get(epoch);
      if (!start) {
        violations.push({ message: `lesson commit for epoch ${epoch} has no teaching assignment`, evidence: [event.id] });
      } else if (str(start, "conceptId") !== str(event, "conceptId")) {
        violations.push({ message: `epoch ${epoch} was assigned ${str(start, "conceptId")} but committed ${str(event, "conceptId")}`, evidence: [start.id, event.id] });
      }
      const drain = drained.get(epoch);
      if (!drain || (start && drain.seq < start.seq)) {
        violations.push({ message: `lesson commit for epoch ${epoch} without a natural audio drain of that epoch`, evidence: [event.id] });
      }
    }
  }
  return result("H3", "Interrupted beats never commit; commits follow natural drain", violations, applicable);
}

// ---- H4: Review isolation ----

const canonicalKey = (snapshot: EvidenceSnapshot) => stableStringify({
  currentNodeId: snapshot.canonical.currentNodeId,
  coverage: snapshot.canonical.coverage,
  deliveryCursor: snapshot.canonical.deliveryCursor,
  interruptionCount: snapshot.canonical.interruptionCount,
});

/** Events after which a canonical snapshot can no longer stand in for the current state. */
const mayMoveCanonical = (event: EvidenceEvent) => isCanonicalChange(event) ||
  app(event, "lesson.generation-started") || app(event, "tool.decision") || app(event, "interruption.accepted");

export function checkH4(packet: EvidencePacket): HardAssertionResult {
  const violations: Violation[] = [];
  const notes: string[] = [];
  let unsupportedWindows = 0;
  const starts = packet.events.filter((event) => app(event, "review.started"));
  for (const start of starts) {
    const nodeId = str(start, "nodeId");
    const end = packet.events.find((event) => event.seq > start.seq && app(event, "review.ended"));
    const endSeq = end?.seq ?? Number.POSITIVE_INFINITY;
    const inside = packet.events.filter(({ seq }) => seq > start.seq && seq < endSeq);
    for (const event of inside) {
      if (isCanonicalChange(event)) {
        violations.push({ message: `${event.name} changed canonical progress during Review of ${nodeId}`, evidence: [start.id, event.id] });
      }
      if (isAppliedTransition(event)) {
        violations.push({ message: "lesson navigation was applied while Review was active", evidence: [start.id, event.id] });
      }
      if (isReviewCommit(event) && str(event, "conceptId") !== nodeId) {
        violations.push({ message: `Review of ${nodeId} committed a beat of ${str(event, "conceptId")}`, evidence: [event.id] });
      }
    }

    // Snapshot proof needs a baseline taken after the last event that could
    // move canonical state before Review, and a snapshot covering Review's end
    // (or, for a Review still open at packet end, a snapshot during it).
    const before = [...packet.snapshots].reverse().find((snapshot) => snapshot.afterSeq < start.seq);
    const staleBaseline = before && packet.events.some((event) =>
      event.seq > before.afterSeq && event.seq < start.seq && mayMoveCanonical(event));
    const nextCanonical = packet.events.find((event) => event.seq > endSeq && mayMoveCanonical(event));
    const comparable = packet.snapshots.filter((snapshot) => snapshot.afterSeq >= start.seq &&
      snapshot.afterSeq < (nextCanonical?.seq ?? Number.POSITIVE_INFINITY));
    const covered = end ? comparable.some(({ afterSeq }) => afterSeq >= endSeq) : comparable.length > 0;
    if (!before || staleBaseline) {
      unsupportedWindows += 1;
      notes.push(`No canonical snapshot immediately before Review ${start.id}; isolation cannot be proven.`);
      continue;
    }
    if (!covered) {
      unsupportedWindows += 1;
      notes.push(`No canonical snapshot ${end ? `after Review end ${end.id}` : "during open Review"} for ${start.id}; isolation cannot be proven.`);
    }
    for (const snapshot of comparable) {
      if (canonicalKey(before) !== canonicalKey(snapshot)) {
        violations.push({
          message: `canonical state during/after Review differs from before Review`,
          evidence: [before.id, start.id, snapshot.id],
        });
      }
    }
  }
  // FAIL beats UNSUPPORTED: result() reports fail whenever violations exist.
  return result("H4", "Review does not mutate canonical progress", violations, starts.length > 0, notes,
    unsupportedWindows > 0);
}

// ---- Completion attribution (shared by H5 and H7) ----

/**
 * A completion's `reason` is an outcome, not evidence. Each reason names the
 * observable cause that must precede it; the cause is returned, or null when
 * the packet cannot show why the runtime was allowed to end the lesson.
 */
const COMPLETION_CAUSES: Record<string, (before: EvidenceEvent[]) => EvidenceEvent | undefined> = {
  confirmed: (before) => before.findLast((event) => app(event, "tool.decision") &&
    event.detail?.name === "session_control" &&
    (event.detail?.outcome === "wrap-up-end" || event.detail?.outcome === "confirm-end")),
  stopped: (before) => before.findLast((event) =>
    (event.source === "harness" && event.name === "harness.stop-requested") ||
    (app(event, "tool.decision") && event.detail?.outcome === "restart-confirm")),
  // The runtime ends for inactivity only while engagement is still
  // "confirming" (an idle confirmation was requested and never resolved).
  inactivity: (before) => {
    const latest = before.findLast((event) => app(event, "engagement.changed"));
    return latest?.detail?.state === "confirming" ? latest : undefined;
  },
};

export function completionCause(packet: EvidencePacket, completion: EvidenceEvent) {
  const findCause = COMPLETION_CAUSES[str(completion, "reason") ?? ""];
  return findCause?.(packet.events.filter(({ seq }) => seq < completion.seq)) ?? null;
}

/** Completions whose cause is evidenced; only these may explain unfinished content. */
const attributedCompletions = (packet: EvidencePacket) => packet.events
  .filter((event) => app(event, "lesson.completed"))
  .flatMap((completion) => {
    const cause = completionCause(packet, completion);
    return cause ? [{ completion, cause }] : [];
  });

// ---- H5: Core Path integrity ----

export function corePathSummary(packet: EvidencePacket): CorePathSummary {
  const replay = cursorReplay(packet);
  const transitions = packet.events.filter(isAppliedTransition);
  const earlyEnds = attributedCompletions(packet)
    .filter(({ completion }) => completion.detail?.planComplete !== true);
  const core = packet.contract.concepts.filter(({ importance }) => importance === "core");
  const incomplete = core.filter(({ id, teachingPoints }) => (replay.final[id] ?? 0) < teachingPoints.length)
    .map(({ id, teachingPoints }) => {
      const attributedTo: string[] = [];
      if (transitions.length) attributedTo.push(...transitions.map(({ id: eventId }) => eventId));
      attributedTo.push(...earlyEnds.map(({ cause }) => cause.id));
      if (packet.harness.endedBy !== "lesson-completed") attributedTo.push(`harness:${packet.harness.endedBy}`);
      return { conceptId: id, cursor: replay.final[id] ?? 0, required: teachingPoints.length, attributedTo };
    });
  const required = packet.contract.corePath.length;
  const committed = packet.contract.corePath.filter(({ conceptId, teachingPointIndexes }) =>
    (replay.final[conceptId] ?? 0) > teachingPointIndexes[teachingPointIndexes.length - 1]).length;
  const allCommitted = committed === required;
  return {
    status: packet.harness.endedBy === "aborted" ? "aborted" : allCommitted ? "complete" : "incomplete",
    allCoreBeatsCommitted: allCommitted,
    requiredCoreBeats: required,
    committedCoreBeats: committed,
    incompleteCoreConcepts: incomplete,
  };
}

export function checkH5(packet: EvidencePacket): HardAssertionResult {
  const violations: Violation[] = [];
  const replay = cursorReplay(packet);
  const initial = packet.contract.initial;
  let applicable = false;

  for (const concept of packet.contract.concepts) {
    if (initial.coverage[concept.id] === "taught" && (initial.cursors[concept.id] ?? 0) < concept.teachingPoints.length) {
      violations.push({ message: `${concept.id} starts taught with cursor ${initial.cursors[concept.id]}`, evidence: ["contract.initial"] });
    }
  }
  for (const event of packet.events) {
    if (app(event, "coverage.changed") && event.detail?.status === "taught") {
      applicable = true;
      const conceptId = str(event, "conceptId") ?? "";
      const cursor = replay.at(event.seq)[conceptId] ?? 0;
      if (cursor < requiredCount(packet, conceptId)) {
        violations.push({ message: `${conceptId} marked taught with ${cursor}/${requiredCount(packet, conceptId)} points committed`, evidence: [event.id] });
      }
    }
  }
  const seenStatus = new Map(Object.entries(initial.coverage));
  for (const snapshot of packet.snapshots) {
    for (const [conceptId, status] of Object.entries(snapshot.canonical.coverage)) {
      if (!conceptById(packet, conceptId)) continue;
      applicable = true;
      if (status === "taught") {
        const cursor = replay.at(snapshot.afterSeq)[conceptId] ?? 0;
        if (cursor < requiredCount(packet, conceptId)) {
          violations.push({ message: `${conceptId} reported taught with ${cursor}/${requiredCount(packet, conceptId)} points committed`, evidence: [snapshot.id] });
        }
      }
      if ((status === "skipped" || status === "partial") && seenStatus.get(conceptId) !== status) {
        // Skip/navigation produce skipped/partial; ending a session pauses the
        // current concept as partial. Nothing else may.
        const attributed = packet.events.some((event) => event.seq <= snapshot.afterSeq && isAppliedTransition(event)) ||
          (status === "partial" && attributedCompletions(packet)
            .some(({ completion }) => completion.seq <= snapshot.afterSeq));
        if (!attributed) {
          violations.push({ message: `${conceptId} became ${status} without an applied skip/navigation or session end`, evidence: [snapshot.id] });
        }
      }
      seenStatus.set(conceptId, status);
    }
  }
  const summary = corePathSummary(packet);
  for (const concept of summary.incompleteCoreConcepts) {
    if (!concept.attributedTo.length) {
      violations.push({
        message: `core concept ${concept.conceptId} left at ${concept.cursor}/${concept.required} with no skip, navigation, early end, or harness cut`,
        evidence: ["corePath"],
      });
    }
  }
  return result("H5", "Core Path integrity", violations, applicable || packet.contract.corePath.length > 0);
}

// ---- H6: clarification / off-path coverage isolation ----

export function checkH6(packet: EvidencePacket): HardAssertionResult {
  const violations: Violation[] = [];
  let windows = 0;
  let open: EvidenceEvent | null = null;
  for (const event of packet.events) {
    if (app(event, "clarification.started") || app(event, "interruption.accepted")) {
      if (!open) windows += 1;
      open = open ?? event;
      continue;
    }
    if (open && (app(event, "clarification.completed") || app(event, "lesson.generation-started") ||
        app(event, "review.started") || app(event, "lesson.completed"))) {
      open = null;
      continue;
    }
    if (open && isCanonicalChange(event)) {
      violations.push({ message: `${event.name} during an unresolved clarification/off-path branch`, evidence: [open.id, event.id] });
    }
  }
  return result("H6", "Clarification and off-path branches do not change coverage", violations, windows > 0);
}

// ---- H7: completion integrity ----

export function checkH7(packet: EvidencePacket): HardAssertionResult {
  const violations: Violation[] = [];
  const completions = packet.events.filter((event) => app(event, "lesson.completed"));
  if (completions.length > 1) {
    violations.push({ message: `lesson completed ${completions.length} times`, evidence: completions.map(({ id }) => id) });
  }
  if (packet.harness.endedBy === "lesson-completed" && completions.length === 0) {
    violations.push({ message: "harness waited for completion but the runtime never completed the lesson", evidence: ["harness.endedBy"] });
  }
  const replay = cursorReplay(packet);
  for (const completion of completions) {
    const reason = str(completion, "reason") ?? "";
    if (!COMPLETION_CAUSES[reason]) {
      violations.push({ message: `lesson completed with unknown reason "${reason}"`, evidence: [completion.id] });
    } else if (!completionCause(packet, completion)) {
      violations.push({ message: `lesson completed (${reason}) without a preceding idle or end event`, evidence: [completion.id] });
    }

    const coverage = (completion.detail?.coverage ?? {}) as Record<string, string>;
    const teachable = packet.contract.concepts.map(({ id }) => id);
    const coverageComplete = teachable.every((id) => coverage[id] === "taught" || coverage[id] === "skipped");
    if (completion.detail?.planComplete === true && !coverageComplete) {
      violations.push({ message: "completion claims a complete plan while concepts remain unfinished", evidence: [completion.id] });
    }
    for (const id of teachable.filter((conceptId) => coverage[conceptId] === "taught")) {
      const cursor = replay.at(completion.seq)[id] ?? 0;
      if (cursor < requiredCount(packet, id)) {
        violations.push({ message: `completion reports ${id} taught with ${cursor}/${requiredCount(packet, id)} points committed`, evidence: [completion.id] });
      }
    }
    for (const event of packet.events.filter(({ seq }) => seq > completion.seq)) {
      if (isCanonicalChange(event) || app(event, "lesson.generation-started") || isAppliedTransition(event)) {
        violations.push({ message: `${event.name} after lesson completion`, evidence: [completion.id, event.id] });
      }
    }
  }
  return result("H7", "Completion integrity", violations,
    completions.length > 0 || packet.harness.endedBy === "lesson-completed");
}

// ---- H8: logical interruption integrity (no latency threshold) ----

export function checkH8(packet: EvidencePacket): HardAssertionResult {
  const violations: Violation[] = [];
  const notes: string[] = [];
  const events = packet.events;
  const beatEpochs = new Set(events.filter((event) => app(event, "lesson.generation-started"))
    .map((event) => num(event, "generationEpoch")));
  let checked = 0;

  const openEpochBefore = (seq: number) => {
    const start = [...events].reverse().find((event) => event.seq < seq && app(event, "tutor.audio-started"));
    if (!start) return null;
    const epoch = num(start, "generationEpoch");
    const closed = events.some((event) => event.seq > start.seq && event.seq < seq &&
      ((app(event, "tutor.audio-ended") && num(event, "generationEpoch") === epoch) ||
       (app(event, "audio.epoch-invalidated") && num(event, "invalidatedEpoch") === epoch)));
    return closed ? null : { start, epoch };
  };

  // Every learner trigger, evaluated or not, owns the events up to the next one.
  const isLearnerTrigger = (event: EvidenceEvent) =>
    (event.source === "harness" && event.name === "harness.learner-text") ||
    (event.name === "provider.voice-activity" && event.detail?.type === "ACTIVITY_START");
  const reviewActiveAt = (seq: number) => {
    const latest = events.findLast((event) => event.seq < seq &&
      (app(event, "review.started") || app(event, "review.ended")));
    return Boolean(latest && latest.name === "review.started");
  };

  const verify = (trigger: EvidenceEvent, label: string, claimed: boolean) => {
    const open = openEpochBefore(trigger.seq);
    if (!open) {
      if (claimed) notes.push(`${label} ${trigger.id} was sent as during-output, but no open tutor output is evidenced; not checked.`);
      return;
    }
    checked += 1;
    const windowEnd = events.find((event) => event.seq > trigger.seq &&
      (app(event, "tutor.audio-started") || isLearnerTrigger(event)))?.seq ?? Number.POSITIVE_INFINITY;
    const window = events.filter((event) => event.seq > trigger.seq && event.seq < windowEnd);
    // Review interruptions are deliberately noncanonical: the runtime invalidates
    // the Review beat but emits no interruption.accepted. Elsewhere acceptance
    // is interruption.accepted. Either way, exactly one per learner trigger.
    const review = reviewActiveAt(trigger.seq);
    const acceptances = window.filter((event) => review
      ? app(event, "audio.epoch-invalidated") && event.detail?.reason === "barge-in"
      : app(event, "interruption.accepted"));
    if (acceptances.length === 0) {
      violations.push({ message: `${label} during tutor output was not accepted as an interruption`, evidence: [trigger.id, open.start.id] });
    } else if (acceptances.length > 1) {
      violations.push({
        message: `learner interruption was accepted ${acceptances.length} times for one ${label}`,
        evidence: [trigger.id, ...acceptances.map(({ id }) => id)],
      });
    }
    if (open.epoch !== null && beatEpochs.has(open.epoch)) {
      const invalidated = window.some((event) => app(event, "audio.epoch-invalidated") &&
        num(event, "invalidatedEpoch") === open.epoch);
      if (!invalidated) {
        violations.push({ message: `${label} did not invalidate the interrupted beat epoch ${open.epoch}`, evidence: [trigger.id, open.start.id] });
      }
      const committed = events.find((event) => event.seq > trigger.seq && app(event, "beat.commit") &&
        num(event, "generationEpoch") === open.epoch);
      if (committed) {
        violations.push({ message: `interrupted beat epoch ${open.epoch} committed after ${label}`, evidence: [trigger.id, committed.id] });
      }
    }
  };

  for (const event of events) {
    if (event.source === "harness" && event.name === "harness.learner-text" && event.detail?.duringTutorOutput === true) {
      verify(event, "typed learner turn", true);
    }
    if (event.name === "provider.voice-activity" && event.detail?.type === "ACTIVITY_START") {
      const frame = event.detail.frame;
      const sameFrameInterrupted = events.some((other) => other.name === "provider.interrupted" && other.detail?.frame === frame);
      if (sameFrameInterrupted) verify(event, "voice barge-in", false);
    }
  }
  return result("H8", "Each learner interruption during tutor output is accepted exactly once and invalidates the beat", violations, checked > 0, notes);
}

// ---- H10: internal-control leakage ----

export function checkH10(packet: EvidencePacket): HardAssertionResult {
  const violations: Violation[] = [];
  const tutorTurns = packet.turns.filter(({ role }) => role === "tutor");
  for (const turn of tutorTurns) {
    const pattern = INTERNAL_CONTROL_PATTERNS.find((candidate) => candidate.test(turn.text));
    if (pattern) violations.push({ message: `tutor speech leaked internal control text (${pattern})`, evidence: [turn.id] });
  }
  for (const event of packet.events.filter(({ name }) => name === "provider.model-text")) {
    const text = String(event.detail?.text ?? "");
    const pattern = INTERNAL_CONTROL_PATTERNS.find((candidate) => candidate.test(text));
    if (pattern) violations.push({ message: `tutor model text leaked internal control text (${pattern})`, evidence: [event.id] });
  }
  return result("H10", "No internal-control leakage in tutor output", violations, tutorTurns.length > 0);
}

export const HARD_ASSERTIONS = [checkH1, checkH2, checkH3, checkH4, checkH5, checkH6, checkH7, checkH8, checkH10];

/**
 * A finished capture claims a final canonical state, so it must contain a
 * snapshot read after the last app event (the recorder's "finalize" snapshot).
 * Missing proof is inconclusive, never a failure; contradictions between that
 * snapshot and the event history are failed by H1/H5/H7.
 */
export type FinalizationEvidence = {
  status: "anchored" | "missing" | "not-required";
  anchorSnapshotId: string | null;
};

export function checkFinalizationAnchor(packet: EvidencePacket): FinalizationEvidence {
  if (!FINAL_CAPTURE_ENDINGS.has(packet.harness.endedBy)) return { status: "not-required", anchorSnapshotId: null };
  const lastAppSeq = packet.events.findLast(({ source }) => source === "app")?.seq ?? 0;
  const anchor = packet.snapshots.findLast(({ afterSeq }) => afterSeq >= lastAppSeq);
  return anchor ? { status: "anchored", anchorSnapshotId: anchor.id } : { status: "missing", anchorSnapshotId: null };
}

/** Captures that ended with the session; open (cut mid-session) and aborted ones are partial. */
const FINAL_CAPTURE_ENDINGS: ReadonlySet<EvidencePacket["harness"]["endedBy"]> =
  new Set(["lesson-completed", "harness-stop"]);

/**
 * Precedence: any fail -> fail; otherwise an unsupported assertion, a partial
 * capture (open or aborted) or a finished capture without a final canonical
 * anchor -> inconclusive; otherwise pass.
 */
export function aggregateVerdict(
  assertions: Pick<HardAssertionResult, "status">[],
  endedBy: EvidencePacket["harness"]["endedBy"],
  finalization: Pick<FinalizationEvidence, "status">,
): HardEvaluation["verdict"] {
  if (assertions.some(({ status }) => status === "fail")) return "fail";
  if (assertions.some(({ status }) => status === "unsupported")) return "inconclusive";
  if (!FINAL_CAPTURE_ENDINGS.has(endedBy)) return "inconclusive";
  if (finalization.status !== "anchored") return "inconclusive";
  return "pass";
}

export function evaluateHardAssertions(packet: EvidencePacket): HardEvaluation {
  const assertions = HARD_ASSERTIONS.map((check) => check(packet));
  const finalization = checkFinalizationAnchor(packet);
  return {
    evaluatorVersion: HARD_EVALUATOR_VERSION,
    packetId: packet.packetId,
    packetHash: packet.packetHash,
    verdict: aggregateVerdict(assertions, packet.harness.endedBy, finalization),
    finalization,
    assertions,
    deferred: DEFERRED_ASSERTIONS,
    corePath: corePathSummary(packet),
  };
}
