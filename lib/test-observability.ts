export const TEST_EVENT_NAMES = [
  "live.setup-complete",
  "lesson.start-requested",
  "lesson.generation-started",
  "tutor.audio-started",
  "tutor.audio-ended",
  "learner.activity-detected",
  "interruption.accepted",
  "audio.epoch-invalidated",
  "clarification.started",
  "clarification.completed",
  "canonical.resume-requested",
  "beat.commit",
  "delivery.cursor-changed",
  "coverage.changed",
  "review.started",
  "review.ended",
  "tool.decision",
  "lesson.completed",
  "engagement.changed",
] as const;

export type TestEventName = (typeof TEST_EVENT_NAMES)[number];

export type TestEvent = {
  name: TestEventName;
  timestamp: number;
  detail?: Record<string, unknown>;
};

export type TestSnapshot = Record<string, unknown>;

declare global {
  interface Window {
    __AI_TEACHER_TEST__?: {
      getSnapshot: () => TestSnapshot;
      getEvents: () => TestEvent[];
      clearEvents: () => void;
    };
  }
}

const events: TestEvent[] = [];

export function emitTestEvent(name: TestEventName, detail?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") return;
  events.push({ name, timestamp: Date.now(), ...(detail ? { detail } : {}) });
}

export function installTestObservabilityBridge(getSnapshot: () => TestSnapshot) {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return () => undefined;
  window.__AI_TEACHER_TEST__ = {
    getSnapshot: () => structuredClone(getSnapshot()),
    getEvents: () => structuredClone(events),
    clearEvents: () => { events.length = 0; },
  };
  // The root page owns this bridge for the lifetime of the document. Keeping
  // cleanup as a no-op also prevents React development Strict Mode's probe
  // unmount from briefly removing the harness between effect passes.
  return () => undefined;
}
