// Q3 performance/SLO measurements. Recorded for reports and trends only: no
// threshold here ever turns into a hard correctness failure.

import type { EvidenceEvent, EvidencePacket } from "../evidence/types";

export const PERFORMANCE_MEASURES_VERSION = "q3a-perf-1";

export type LatencySample = { turnId: string; ms: number | null };

export type PerformanceMeasures = {
  measuresVersion: typeof PERFORMANCE_MEASURES_VERSION;
  gating: false;
  clockDomain: EvidencePacket["harness"]["clockDomain"];
  /** Typed during-output learner turn -> interruption accepted / beat invalidated. */
  interruptionAcceptLatencyMs: LatencySample[];
  /** Learner turn end -> next tutor audio start. null = no tutor output followed. */
  tutorResponseLatencyMs: LatencySample[];
  summary: {
    maxInterruptionAcceptLatencyMs: number | null;
    maxTutorResponseLatencyMs: number | null;
    learnerTurnsWithoutTutorResponse: number;
  };
};

const isAccept = (event: EvidenceEvent) => event.source === "app" && (event.name === "interruption.accepted" ||
  (event.name === "audio.epoch-invalidated" && event.detail?.reason === "barge-in"));
const isTutorStart = (event: EvidenceEvent) => event.source === "app" && event.name === "tutor.audio-started";

const max = (samples: LatencySample[]) => samples.reduce<number | null>((highest, { ms }) =>
  ms === null ? highest : highest === null ? ms : Math.max(highest, ms), null);

export function measurePerformance(packet: EvidencePacket): PerformanceMeasures {
  const bySeq = new Map(packet.events.map((event) => [event.id, event]));
  const interruptionAcceptLatencyMs: LatencySample[] = [];
  const tutorResponseLatencyMs: LatencySample[] = [];

  for (const turn of packet.turns.filter(({ role }) => role === "learner")) {
    const end = bySeq.get(turn.endEventId);
    if (!end) continue;
    if (turn.duringTutorOutput) {
      const accept = packet.events.find((event) => event.seq > end.seq && isAccept(event));
      interruptionAcceptLatencyMs.push({ turnId: turn.id, ms: accept ? Math.max(0, accept.t - end.t) : null });
    }
    const response = packet.events.find((event) => event.seq > end.seq && isTutorStart(event));
    tutorResponseLatencyMs.push({ turnId: turn.id, ms: response ? Math.max(0, response.t - end.t) : null });
  }

  return {
    measuresVersion: PERFORMANCE_MEASURES_VERSION,
    gating: false,
    clockDomain: packet.harness.clockDomain,
    interruptionAcceptLatencyMs,
    tutorResponseLatencyMs,
    summary: {
      maxInterruptionAcceptLatencyMs: max(interruptionAcceptLatencyMs),
      maxTutorResponseLatencyMs: max(tutorResponseLatencyMs),
      learnerTurnsWithoutTutorResponse: tutorResponseLatencyMs.filter(({ ms }) => ms === null).length,
    },
  };
}
