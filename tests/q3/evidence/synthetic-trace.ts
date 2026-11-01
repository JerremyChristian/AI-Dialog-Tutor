// Test support: composes synthetic raw evidence that mirrors what the runtime
// emits, so each hard assertion can be exercised with valid and intentionally
// violating packets without Playwright. Tracks a simple canonical model only to
// fill snapshots; every value can be overridden to inject a violation.

import { buildFixtureSavedLesson, PLC_Q3_FIXTURE, type LessonFixture } from "../../helpers/lesson-fixture";
import { buildEvidencePacket } from "./build";
import type {
  EvidenceHarness, RawAppEvent, RawEvidence, RawHarnessEvent, RawProviderFrame, RawSnapshot,
} from "./types";

export class SyntheticTrace {
  readonly appEvents: RawAppEvent[] = [];
  readonly frames: RawProviderFrame[] = [];
  readonly harnessEvents: RawHarnessEvent[] = [];
  readonly snapshots: RawSnapshot[] = [];
  readonly seeded: RawEvidence["seeded"];
  currentNodeId: string;
  coverage: Record<string, string>;
  cursors: Record<string, number>;
  interruptionCount = 0;
  reviewActive = false;
  lessonActive = true;
  epoch = 0;
  private clock = 1_000;

  constructor(readonly fixture: LessonFixture = PLC_Q3_FIXTURE) {
    const lesson = buildFixtureSavedLesson(fixture, "qa-synthetic", { now: "2026-01-01T00:00:00.000Z" });
    this.seeded = { fixtureId: fixture.fixtureId, fixtureVersion: fixture.fixtureVersion, lesson };
    this.currentNodeId = fixture.concepts[0].id;
    this.coverage = Object.fromEntries(Object.entries(lesson.lessonState.nodes).map(([id, node]) => [id, node.status]));
    this.cursors = Object.fromEntries(fixture.concepts.map(({ id }) => [id, 0]));
  }

  private tick() { this.clock += 10; return this.clock; }
  private count(conceptId: string) {
    return this.fixture.concepts.find(({ id }) => id === conceptId)!.teaching.teachingPoints.length;
  }

  app(name: string, detail?: Record<string, unknown>) {
    this.appEvents.push({ name, timestamp: this.tick(), ...(detail ? { detail } : {}) });
    return this;
  }
  frame(body: Record<string, unknown>) {
    this.frames.push({ anchor: this.appEvents.length, t: this.tick(), body });
    return this;
  }
  typed(text: string, duringTutorOutput: boolean) {
    this.harnessEvents.push({
      anchor: this.appEvents.length, t: this.tick(), name: "harness.learner-text", detail: { text, duringTutorOutput },
    });
    return this;
  }
  stopRequested() {
    this.harnessEvents.push({ anchor: this.appEvents.length, t: this.tick(), name: "harness.stop-requested" });
    return this;
  }
  snap(label: string, overrides: Record<string, unknown> = {}) {
    this.snapshots.push({
      anchor: this.appEvents.length, label, snapshot: {
        currentNodeId: this.currentNodeId,
        coverage: { ...this.coverage },
        deliveryCursor: this.cursors[this.currentNodeId] ?? null,
        interruptionCount: this.interruptionCount,
        reviewActive: this.reviewActive,
        lessonActive: this.lessonActive,
        activePresentationBeat: null,
        ...overrides,
      },
    });
    return this;
  }

  /** Assigns the next lesson beat (activating its concept like the runtime does). */
  assign(conceptId: string, teachingPointIndexes: number[]) {
    const generationEpoch = ++this.epoch;
    if (conceptId !== this.currentNodeId) {
      this.currentNodeId = conceptId;
      if (this.coverage[conceptId] === "not-started") this.coverage[conceptId] = "teaching";
    }
    this.app("lesson.generation-started", { conceptId, generationEpoch, deliveryUnitIndex: 0, beatIndex: 0 });
    return { conceptId, teachingPointIndexes, generationEpoch };
  }
  speak(generationEpoch: number, text: string) {
    this.frame({ serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAAAAAA" } }] },
      outputTranscription: { text },
    } });
    return this.app("tutor.audio-started", { generationEpoch });
  }
  drain(generationEpoch: number) {
    this.frame({ serverContent: { generationComplete: true } });
    return this.app("tutor.audio-ended", { generationEpoch, natural: true });
  }
  commit(beat: { conceptId: string; teachingPointIndexes: number[]; generationEpoch?: number }, mode = "lesson") {
    const { conceptId, teachingPointIndexes } = beat;
    const nextIndex = teachingPointIndexes[teachingPointIndexes.length - 1] + 1;
    this.app("beat.commit", {
      mode, conceptId, nextIndex, teachingPointIndexes,
      ...(beat.generationEpoch !== undefined ? { generationEpoch: beat.generationEpoch } : {}),
    });
    if (mode !== "lesson") return this;
    const from = this.cursors[conceptId];
    this.cursors[conceptId] = nextIndex;
    this.app("delivery.cursor-changed", { conceptId, from, to: nextIndex });
    if (nextIndex >= this.count(conceptId)) this.coverage[conceptId] = "taught";
    return this.app("coverage.changed", { conceptId, status: this.coverage[conceptId] });
  }
  /** Assign, speak, drain naturally, commit: one cleanly delivered beat. */
  deliver(conceptId: string, teachingPointIndexes: number[], text = `Teaching ${conceptId} ${teachingPointIndexes}.`) {
    const beat = this.assign(conceptId, teachingPointIndexes);
    this.speak(beat.generationEpoch, text).drain(beat.generationEpoch);
    return this.commit(beat);
  }
  /** Typed barge-in while `generationEpoch` is speaking, as the runtime records it. */
  typedInterrupt(generationEpoch: number, text: string) {
    this.typed(text, true);
    this.app("audio.epoch-invalidated", { reason: "barge-in", invalidatedEpoch: generationEpoch, generationEpoch: ++this.epoch });
    this.interruptionCount += 1;
    return this.app("interruption.accepted", { conceptId: this.currentNodeId, interruptionCount: this.interruptionCount });
  }
  clarify(answer: string) {
    const generationEpoch = this.epoch;
    this.speak(generationEpoch, answer);
    this.frame({ serverContent: { generationComplete: true } });
    this.frame({ serverContent: { turnComplete: true } });
    return this.app("clarification.completed", { conceptId: this.currentNodeId });
  }
  decision(name: string, action: string | null, conceptId: string | null, outcome: string) {
    return this.app("tool.decision", { name, action, conceptId, outcome });
  }
  skip(conceptId: string) {
    if (this.coverage[conceptId] !== "taught") this.coverage[conceptId] = conceptId === this.currentNodeId ? "partial" : "skipped";
    return this.decision("lesson_state", "skip", conceptId, "transition-applied");
  }
  navigate(conceptId: string) {
    if (this.coverage[this.currentNodeId] === "teaching") this.coverage[this.currentNodeId] = "partial";
    if (this.coverage[conceptId] !== "taught") this.coverage[conceptId] = "teaching";
    this.currentNodeId = conceptId;
    return this.decision("lesson_state", "navigate", conceptId, "transition-applied");
  }
  complete(reason: string, planComplete: boolean, coverage = { ...this.coverage }) {
    this.app("lesson.completed", { reason, planComplete, coverage });
    this.lessonActive = false;
    return this;
  }

  build(endedBy: EvidenceHarness["endedBy"] = "open", abort?: EvidenceHarness["abort"]) {
    return buildEvidencePacket({
      seeded: this.seeded,
      appEvents: this.appEvents,
      providerFrames: this.frames,
      harnessEvents: this.harnessEvents,
      snapshots: this.snapshots,
      harness: { kind: "q2-scripted", scenarioId: "synthetic", endedBy, ...(abort ? { abort } : {}) },
    });
  }
}

/**
 * A complete, valid Q3-fixture session: an interrupted and clarified beat,
 * a learner-requested skip of the optional concept, and a wrap-up ending.
 */
export function validFullSession() {
  const trace = new SyntheticTrace();
  trace.snap("start");
  trace.deliver("what-is-a-plc", [0], "PLC means programmable logic controller.");

  const interrupted = trace.assign("what-is-a-plc", [1]);
  trace.speak(interrupted.generationEpoch, "PLCs coordinate");
  trace.typedInterrupt(interrupted.generationEpoch, "Wait, what are inputs and outputs?");
  trace.clarify("Inputs are signals coming in from sensors; outputs drive devices.");
  trace.snap("after clarification");

  trace.deliver("what-is-a-plc", [1], "PLCs coordinate industrial inputs and outputs.");
  trace.deliver("plc-scan-cycle", [0]).deliver("plc-scan-cycle", [1, 2]);
  trace.typed("Can we skip the history part?", false);
  trace.skip("plc-history");
  trace.snap("after skip");
  trace.deliver("plc-io-modules", [0]).deliver("plc-io-modules", [1]);
  trace.snap("canonical complete");

  trace.decision("session_control", "end", null, "wrap-up-end");
  trace.speak(++trace.epoch, "Thanks for learning with me today.");
  trace.complete("confirmed", true);
  trace.snap("final");
  return trace;
}
