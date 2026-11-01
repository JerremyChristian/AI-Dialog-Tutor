// Q3 EvidencePacket contract. A packet is the immutable record of one tutoring
// session that the deterministic evaluator (and, later, the AI judge) reads.
// Bump EVIDENCE_PACKET_SCHEMA_VERSION on any breaking shape change.

export const EVIDENCE_PACKET_SCHEMA = "q3.evidence-packet" as const;
export const EVIDENCE_PACKET_SCHEMA_VERSION = 1 as const;

/** Who produced an event: the app's dev-only test bridge, the Live provider stream, or the harness. */
export type EvidenceSource = "app" | "provider" | "harness";

export type EvidenceEvent = {
  /** Stable reference, `E<seq>`, cited by assertion violations. */
  id: string;
  /** Total order across all sources; app events keep their emitted order. */
  seq: number;
  source: EvidenceSource;
  name: string;
  /** Milliseconds since the Unix epoch in the page clock (see harness.clockDomain). */
  t: number;
  detail?: Record<string, unknown>;
};

export type EvidenceTurn = {
  /** Stable reference, `T<n>`. */
  id: string;
  role: "tutor" | "learner";
  channel: "tutor-transcript" | "typed" | "voice-transcript";
  text: string;
  startEventId: string;
  endEventId: string;
  endedBy: "generation-complete" | "turn-complete" | "interrupted" | "learner-turn" |
    "tutor-output" | "finished" | "packet-end" | "sent";
  /** Harness claim for typed turns: the tutor was audibly outputting when the learner sent. */
  duringTutorOutput?: boolean;
};

/** The canonical fields the evaluator compares; captured from the app snapshot. */
export type CanonicalProjection = {
  currentNodeId: string | null;
  coverage: Record<string, string>;
  deliveryCursor: number | null;
  interruptionCount: number | null;
  reviewActive: boolean | null;
  lessonActive: boolean | null;
  activePresentationBeat: { index: number; teachingPointIndexes: number[]; mode: string } | null;
};

export type EvidenceSnapshot = {
  /** Stable reference, `S<n>`. */
  id: string;
  label: string;
  /** The snapshot was read after this event and before any later one; null = before all events. */
  afterEventId: string | null;
  afterSeq: number;
  canonical: CanonicalProjection;
};

export type ContractConcept = {
  id: string;
  title: string;
  importance: string;
  teachingPoints: string[];
  /** Required canonical beats, in delivery order, as teaching-point index groups. */
  beats: number[][];
};

export type EvidenceContract = {
  fixtureId: string;
  fixtureVersion: string;
  /** sha256 over concepts + initial state; identifies the exact teaching contract. */
  contractHash: string;
  lessonId: string;
  concepts: ContractConcept[];
  /** Ordered required beats of core concepts: the teacher-approved baseline. */
  corePath: Array<{ conceptId: string; teachingPointIndexes: number[] }>;
  /** Canonical state when the packet's document seeded the lesson. */
  initial: {
    currentNodeId: string | null;
    cursors: Record<string, number>;
    coverage: Record<string, string>;
  };
};

export type AudioSummary = {
  tutorOutputsStarted: number;
  naturalDrains: number;
  invalidationsByReason: Record<string, number>;
  providerAudioChunks: number;
  providerAudioBytes: number;
  /** Stale-chunk rejection is proven by Q1 suites, not re-derived here. */
  staleAudioRejection: "q1-owned";
};

export type HarnessAbortCategory = "provider" | "budget" | "student" | "timeout" | "infrastructure";

export type EvidenceHarness = {
  kind: "q2-scripted" | "q3-dynamic";
  scenarioId: string;
  /**
   * lesson-completed: the harness waited for the runtime to end the session.
   * harness-stop: the harness ended it. open: the packet was cut mid-session.
   * aborted: harness/provider/infrastructure failure (never a tutor-quality verdict).
   */
  endedBy: "lesson-completed" | "harness-stop" | "open" | "aborted";
  abort?: { category: HarnessAbortCategory; message: string };
  clockDomain: "page-epoch-ms";
  notes: string[];
};

export type EvidencePacket = {
  schema: typeof EVIDENCE_PACKET_SCHEMA;
  schemaVersion: typeof EVIDENCE_PACKET_SCHEMA_VERSION;
  packetId: string;
  /** sha256 over every other field; detects post-finalization edits. */
  packetHash: string;
  contract: EvidenceContract;
  events: EvidenceEvent[];
  turns: EvidenceTurn[];
  snapshots: EvidenceSnapshot[];
  audioSummary: AudioSummary;
  harness: EvidenceHarness;
};

// ---- Raw capture input to the pure builder ----

export type RawAppEvent = { name: string; timestamp: number; detail?: Record<string, unknown> };
/** `anchor` = number of app events already emitted when this item happened. */
export type RawProviderFrame = { anchor: number; t: number; body: Record<string, unknown> };
export type RawHarnessEvent = { anchor: number; t: number; name: string; detail?: Record<string, unknown> };
export type RawSnapshot = { anchor: number; label: string; snapshot: Record<string, unknown> };

export type RawEvidence = {
  seeded: { fixtureId: string; fixtureVersion: string; lesson: Record<string, unknown> };
  appEvents: RawAppEvent[];
  providerFrames: RawProviderFrame[];
  harnessEvents: RawHarnessEvent[];
  snapshots: RawSnapshot[];
  harness: Omit<EvidenceHarness, "clockDomain" | "notes"> & { notes?: string[] };
  packetId?: string;
};
