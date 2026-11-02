import { describe, expect, it } from "vitest";
import { liveCaptureDivergence, persistedCaptureDivergence } from "../q3/evidence/capture-boundary";
import type { RawAppEvent } from "../q3/evidence/types";
import { buildFixtureSavedLesson, PLC_Q3_FIXTURE } from "../helpers/lesson-fixture";

const seed = buildFixtureSavedLesson(PLC_Q3_FIXTURE, "qa", { now: "2026-01-01T00:00:00.000Z" });
const seededCoverage = Object.fromEntries(Object.entries(seed.lessonState.nodes).map(([id, node]) => [id, node.status]));
const liveSnapshot = (overrides: Record<string, unknown> = {}) => ({
  currentNodeId: "what-is-a-plc",
  coverage: { ...seededCoverage },
  deliveryCursor: 0,
  interruptionCount: 0,
  reviewActive: false,
  tutorAudioPlaying: false,
  status: "teaching",
  ...overrides,
});
const event = (name: string, detail?: Record<string, unknown>): RawAppEvent => ({ name, timestamp: 1, ...(detail ? { detail } : {}) });
const startup = [event("lesson.start-requested"), event("live.setup-complete"),
  event("lesson.generation-started", { conceptId: "what-is-a-plc", generationEpoch: 1 })];

describe("live capture boundary", () => {
  it("allows capture from an untouched seed", () => {
    expect(liveCaptureDivergence(seed, liveSnapshot(), startup)).toBeNull();
  });

  it.each([
    ["live cursor advanced", liveSnapshot({ deliveryCursor: 1 }), [], /live cursor of what-is-a-plc is 1, seeded 0/],
    ["live coverage advanced", liveSnapshot({ coverage: { ...seededCoverage, "plc-history": "skipped" } }), [],
      /live coverage of plc-history is skipped, seeded not-started/],
    ["a not-started concept activated", liveSnapshot({ coverage: { ...seededCoverage, "plc-scan-cycle": "teaching" } }), [],
      /live coverage of plc-scan-cycle is teaching/],
    ["live current concept changed", liveSnapshot({ currentNodeId: "plc-scan-cycle" }), [],
      /live current concept is plc-scan-cycle, seeded what-is-a-plc/],
    ["a lesson beat committed", liveSnapshot(), [event("beat.commit", { mode: "lesson", conceptId: "what-is-a-plc" })],
      /already emitted beat.commit/],
    ["a navigation was applied", liveSnapshot(),
      [event("tool.decision", { name: "lesson_state", action: "skip", outcome: "transition-applied" })], /already emitted tool.decision/],
    ["the lesson already completed", liveSnapshot(), [event("lesson.completed", { reason: "stopped" })], /already emitted lesson.completed/],
    ["live state unavailable", null, [], /unavailable/],
  ] as const)("refuses capture when %s", (_label, snapshot, events, reason) => {
    expect(liveCaptureDivergence(seed, snapshot, [...startup, ...events])).toMatch(reason);
  });

  it("ignores transient noncanonical activity", () => {
    const noncanonical = [
      event("tutor.audio-started", { generationEpoch: 1 }),
      event("audio.epoch-invalidated", { reason: "barge-in", invalidatedEpoch: 1, generationEpoch: 2 }),
      event("interruption.accepted", { conceptId: "what-is-a-plc", interruptionCount: 1 }),
      event("clarification.started", { source: "voice" }),
      event("canonical.resume-requested", { conceptId: "what-is-a-plc" }),
      event("engagement.changed", { state: "confirming" }),
      event("tool.decision", { name: "lesson_state", action: "query", outcome: "query" }),
      event("tool.decision", { name: "lesson_state", action: "navigate", outcome: "review-rejected" }),
    ];
    const snapshot = liveSnapshot({ tutorAudioPlaying: true, status: "interrupted", interruptionCount: 1 });
    expect(liveCaptureDivergence(seed, snapshot, [...startup, ...noncanonical])).toBeNull();
  });

  it("allows capture during Review while canonical progress is unchanged", () => {
    const review = [event("review.started", { nodeId: "what-is-a-plc" }),
      event("beat.commit", { mode: "review", conceptId: "what-is-a-plc", nextIndex: 1 })];
    expect(liveCaptureDivergence(seed, liveSnapshot({ reviewActive: true }), [...startup, ...review])).toBeNull();
  });

  it("does not treat hydration normalizing a seeded non-current concept down as progress", () => {
    const quirkySeed = structuredClone(seed);
    quirkySeed.lessonState.nodes["plc-scan-cycle"].status = "teaching";
    expect(liveCaptureDivergence(quirkySeed, liveSnapshot(), startup)).toBeNull();
  });
});

describe("persisted capture boundary", () => {
  type Persisted = typeof seed;
  const persisted = (mutate: (lesson: Persisted) => void = () => {}) => {
    const lesson = structuredClone(seed);
    mutate(lesson);
    return lesson;
  };

  it("allows capture from an untouched persisted seed", () => {
    expect(persistedCaptureDivergence(seed, persisted())).toBeNull();
  });

  it.each([
    ["the cursor advanced", (lesson: Persisted) => {
      lesson.lessonState.teachingContractProgress["what-is-a-plc"].nextTeachingPointIndex = 1;
    }, /persisted cursor of what-is-a-plc is 1, seeded 0/],
    ["a non-current concept's cursor advanced", (lesson: Persisted) => {
      lesson.lessonState.teachingContractProgress["plc-scan-cycle"].nextTeachingPointIndex = 1;
    }, /persisted cursor of plc-scan-cycle is 1, seeded 0/],
    ["coverage moved not-started -> skipped", (lesson: Persisted) => {
      lesson.lessonState.nodes["plc-history"].status = "skipped";
    }, /persisted coverage of plc-history is skipped, seeded not-started/],
    ["coverage moved not-started -> partial", (lesson: Persisted) => {
      lesson.lessonState.nodes["plc-scan-cycle"].status = "partial";
    }, /persisted coverage of plc-scan-cycle is partial, seeded not-started/],
    ["coverage moved not-started -> taught", (lesson: Persisted) => {
      lesson.lessonState.nodes["plc-io-modules"].status = "taught";
    }, /persisted coverage of plc-io-modules is taught, seeded not-started/],
    ["the current concept was taught", (lesson: Persisted) => {
      lesson.lessonState.nodes["what-is-a-plc"].status = "taught";
    }, /persisted coverage of what-is-a-plc is taught, seeded teaching/],
    ["a not-started concept was activated", (lesson: Persisted) => {
      lesson.lessonState.nodes["plc-scan-cycle"].status = "teaching";
    }, /persisted coverage of plc-scan-cycle is teaching, seeded not-started/],
    ["the current concept changed", (lesson: Persisted) => {
      lesson.lessonState.currentNodeId = "plc-scan-cycle";
    }, /persisted current concept is plc-scan-cycle, seeded what-is-a-plc/],
  ] as const)("refuses capture when %s", (_label, mutate, reason) => {
    expect(persistedCaptureDivergence(seed, persisted(mutate))).toMatch(reason);
  });

  it("refuses capture when the persisted lesson is missing", () => {
    expect(persistedCaptureDivergence(seed, undefined)).toMatch(/persisted lesson is unavailable/);
  });

  it("does not treat hydration normalizing a seeded non-current concept down as progress", () => {
    const quirkySeed = structuredClone(seed);
    quirkySeed.lessonState.nodes["plc-scan-cycle"].status = "teaching";
    expect(persistedCaptureDivergence(quirkySeed, persisted())).toBeNull();
  });

  it("ignores persisted noncanonical fields", () => {
    const lesson = persisted((value) => Object.assign(value, { updatedAt: "2030-01-01T00:00:00.000Z",
      transcript: [{ role: "tutor", text: "Hello" }], lessonState: { ...value.lessonState, resumePoint: "PLC means" } }));
    expect(persistedCaptureDivergence(seed, lesson)).toBeNull();
  });

  it("needs both checks: stale persistence does not hide live progress, nor live state hide persisted progress", () => {
    expect(persistedCaptureDivergence(seed, persisted())).toBeNull();
    expect(liveCaptureDivergence(seed, liveSnapshot({ deliveryCursor: 1 }), startup)).toMatch(/live cursor/);
    const ahead = persisted((lesson) => { lesson.lessonState.nodes["plc-history"].status = "skipped"; });
    expect(liveCaptureDivergence(seed, liveSnapshot(), startup)).toBeNull();
    expect(persistedCaptureDivergence(seed, ahead)).toMatch(/persisted coverage of plc-history/);
  });

  it("refuses when live and persisted state agree on moved progress", () => {
    const moved = persisted((lesson) => { lesson.lessonState.teachingContractProgress["what-is-a-plc"].nextTeachingPointIndex = 1; });
    expect(liveCaptureDivergence(seed, liveSnapshot({ deliveryCursor: 1 }), startup)).toMatch(/live cursor/);
    expect(persistedCaptureDivergence(seed, moved)).toMatch(/persisted cursor/);
  });
});
