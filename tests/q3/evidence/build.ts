// Pure EvidencePacket construction. Takes raw captures (app test events,
// provider frames, harness events, snapshots, seeded lesson) and produces one
// ordered, hashed, deep-frozen packet. No Playwright, network, or model calls.

import { createHash } from "node:crypto";
import { normalizeProviderFrame, redactSecrets } from "./provider-frames";
import {
  EVIDENCE_PACKET_SCHEMA,
  EVIDENCE_PACKET_SCHEMA_VERSION,
  type AudioSummary,
  type CanonicalProjection,
  type ContractConcept,
  type EvidenceContract,
  type EvidenceEvent,
  type EvidencePacket,
  type EvidenceSnapshot,
  type EvidenceTurn,
  type RawEvidence,
} from "./types";

type Rec = Record<string, unknown>;
const asRecord = (value: unknown): Rec => value && typeof value === "object" && !Array.isArray(value)
  ? value as Rec : {};

/** JSON with recursively sorted keys, so equal content always hashes equally. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .filter((key) => (value as Rec)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Rec)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export function buildContract(seeded: RawEvidence["seeded"]): EvidenceContract {
  const lesson = asRecord(seeded.lesson);
  const state = asRecord(lesson.lessonState);
  const nodes = asRecord(state.nodes);
  const progress = asRecord(state.teachingContractProgress);
  const leafIds: string[] = [];
  const visit = (id: string) => {
    const node = asRecord(nodes[id]);
    const children = Array.isArray(node.childrenIds) ? node.childrenIds as string[] : [];
    if (children.length) children.forEach(visit);
    else if (node.teaching) leafIds.push(id);
  };
  (Array.isArray(state.rootNodeIds) ? state.rootNodeIds as string[] : []).forEach(visit);

  const concepts: ContractConcept[] = leafIds.map((id) => {
    const node = asRecord(nodes[id]);
    const teaching = asRecord(node.teaching);
    const units = Array.isArray(teaching.deliveryUnits) ? teaching.deliveryUnits : [];
    return {
      id,
      title: String(node.title ?? id),
      importance: String(teaching.importance ?? "core"),
      teachingPoints: Array.isArray(teaching.teachingPoints) ? teaching.teachingPoints.map(String) : [],
      beats: units.flatMap((unit) => {
        const beats = asRecord(unit).presentationBeats;
        return Array.isArray(beats)
          ? beats.map((beat) => (asRecord(beat).teachingPointIndexes as number[] | undefined) ?? [])
          : [];
      }),
    };
  });
  const initial = {
    currentNodeId: typeof state.currentNodeId === "string" ? state.currentNodeId : null,
    cursors: Object.fromEntries(concepts.map(({ id }) => [
      id,
      Number(asRecord(progress[id]).nextTeachingPointIndex ?? 0),
    ])),
    coverage: Object.fromEntries(Object.keys(nodes).map((id) => [id, String(asRecord(nodes[id]).status)])),
  };
  const corePath = concepts.filter(({ importance }) => importance === "core")
    .flatMap(({ id, beats }) => beats.map((teachingPointIndexes) => ({ conceptId: id, teachingPointIndexes })));
  return {
    fixtureId: seeded.fixtureId,
    fixtureVersion: seeded.fixtureVersion,
    contractHash: sha256({ concepts, initial }),
    lessonId: String(lesson.id ?? ""),
    concepts,
    corePath,
    initial,
  };
}

export function projectSnapshot(snapshot: Rec): CanonicalProjection {
  const beat = asRecord(snapshot.activePresentationBeat);
  return {
    currentNodeId: typeof snapshot.currentNodeId === "string" ? snapshot.currentNodeId : null,
    coverage: Object.fromEntries(Object.entries(asRecord(snapshot.coverage)).map(([key, value]) => [key, String(value)])),
    deliveryCursor: typeof snapshot.deliveryCursor === "number" ? snapshot.deliveryCursor : null,
    interruptionCount: typeof snapshot.interruptionCount === "number" ? snapshot.interruptionCount : null,
    reviewActive: typeof snapshot.reviewActive === "boolean" ? snapshot.reviewActive : null,
    lessonActive: typeof snapshot.lessonActive === "boolean" ? snapshot.lessonActive : null,
    activePresentationBeat: snapshot.activePresentationBeat ? {
      index: Number(beat.index),
      teachingPointIndexes: Array.isArray(beat.teachingPointIndexes) ? beat.teachingPointIndexes.map(Number) : [],
      mode: String(beat.mode),
    } : null,
  };
}

/**
 * Orders every event. App events keep their emitted order; a frame or harness
 * event anchored at N (N app events already existed) goes immediately before
 * app event N, ties broken by time and then capture order.
 */
function mergeTimeline(raw: RawEvidence): Omit<EvidenceEvent, "id" | "seq">[] {
  type Pending = { anchor: number; t: number; order: number; events: Omit<EvidenceEvent, "id" | "seq">[] };
  const appCount = raw.appEvents.length;
  const pending: Pending[] = [];
  raw.providerFrames.forEach((frame, frameIndex) => pending.push({
    anchor: Math.min(frame.anchor, appCount), t: frame.t, order: pending.length,
    events: normalizeProviderFrame(redactSecrets(frame.body)).map((event) => ({
      source: "provider" as const, name: event.name, t: frame.t,
      detail: { frame: frameIndex, ...event.detail },
    })),
  }));
  raw.harnessEvents.forEach((event) => pending.push({
    anchor: Math.min(event.anchor, appCount), t: event.t, order: pending.length,
    events: [{
      source: "harness" as const, name: event.name, t: event.t,
      ...(event.detail ? { detail: redactSecrets(event.detail) } : {}),
    }],
  }));
  pending.sort((a, b) => a.anchor - b.anchor || a.t - b.t || a.order - b.order);

  const merged: Omit<EvidenceEvent, "id" | "seq">[] = [];
  let cursor = 0;
  for (let index = 0; index <= appCount; index += 1) {
    while (cursor < pending.length && pending[cursor].anchor === index) merged.push(...pending[cursor++].events);
    if (index < appCount) {
      const event = raw.appEvents[index];
      merged.push({
        source: "app", name: event.name, t: event.timestamp,
        ...(event.detail ? { detail: redactSecrets(event.detail) } : {}),
      });
    }
  }
  return merged;
}

export function deriveTurns(events: EvidenceEvent[]): EvidenceTurn[] {
  const turns: EvidenceTurn[] = [];
  let tutor: EvidenceTurn | null = null;
  let voice: EvidenceTurn | null = null;
  const nextId = () => `T${turns.length + 1}`;
  const close = (turn: EvidenceTurn | null, event: EvidenceEvent, endedBy: EvidenceTurn["endedBy"]) => {
    if (!turn) return;
    turn.endEventId = event.id;
    turn.endedBy = endedBy;
  };

  for (const event of events) {
    const detail = event.detail ?? {};
    if (event.name === "provider.output-transcription") {
      if (voice) { close(voice, event, "tutor-output"); voice = null; }
      if (!tutor) {
        tutor = {
          id: nextId(), role: "tutor", channel: "tutor-transcript", text: "",
          startEventId: event.id, endEventId: event.id, endedBy: "packet-end",
        };
        turns.push(tutor);
      }
      tutor.text += String(detail.text ?? "");
      tutor.endEventId = event.id;
    } else if (event.name === "provider.generation-complete" || event.name === "provider.turn-complete" ||
               event.name === "provider.interrupted") {
      const endedBy = event.name === "provider.interrupted" ? "interrupted"
        : event.name === "provider.turn-complete" ? "turn-complete" : "generation-complete";
      if (tutor) { close(tutor, event, endedBy); tutor = null; }
      if (voice && event.name === "provider.turn-complete") { close(voice, event, "turn-complete"); voice = null; }
    } else if (event.source === "app" && event.name === "interruption.accepted") {
      if (tutor) { close(tutor, event, "interrupted"); tutor = null; }
    } else if (event.name === "provider.input-transcription") {
      if (tutor) { close(tutor, event, "learner-turn"); tutor = null; }
      if (!voice) {
        voice = {
          id: nextId(), role: "learner", channel: "voice-transcript", text: "",
          startEventId: event.id, endEventId: event.id, endedBy: "packet-end",
        };
        turns.push(voice);
      }
      voice.text += String(detail.text ?? "");
      voice.endEventId = event.id;
      if (detail.finished === true) { voice.endedBy = "finished"; voice = null; }
    } else if (event.source === "harness" && event.name === "harness.learner-text") {
      if (tutor) { close(tutor, event, "learner-turn"); tutor = null; }
      turns.push({
        id: nextId(), role: "learner", channel: "typed", text: String(detail.text ?? ""),
        startEventId: event.id, endEventId: event.id, endedBy: "sent",
        duringTutorOutput: detail.duringTutorOutput === true,
      });
    }
  }
  return turns;
}

export function summarizeAudio(events: EvidenceEvent[]): AudioSummary {
  const invalidationsByReason: Record<string, number> = {};
  let providerAudioChunks = 0;
  let providerAudioBytes = 0;
  for (const event of events) {
    if (event.source === "app" && event.name === "audio.epoch-invalidated") {
      const reason = String(event.detail?.reason ?? "unknown");
      invalidationsByReason[reason] = (invalidationsByReason[reason] ?? 0) + 1;
    }
    if (event.name === "provider.audio") {
      providerAudioChunks += 1;
      providerAudioBytes += Number(event.detail?.bytes ?? 0);
    }
  }
  return {
    tutorOutputsStarted: events.filter((event) => event.source === "app" && event.name === "tutor.audio-started").length,
    naturalDrains: events.filter((event) => event.source === "app" && event.name === "tutor.audio-ended" &&
      event.detail?.natural === true).length,
    invalidationsByReason,
    providerAudioChunks,
    providerAudioBytes,
    staleAudioRejection: "q1-owned",
  };
}

export function buildEvidencePacket(raw: RawEvidence): EvidencePacket {
  const events: EvidenceEvent[] = mergeTimeline(raw).map((event, index) => ({
    id: `E${index + 1}`, seq: index + 1, ...event,
  }));
  // Index of the evidence event that is app event N-1, so a snapshot read after
  // N app events sits right after it.
  const appEventIds: EvidenceEvent[] = events.filter(({ source }) => source === "app");
  const snapshots: EvidenceSnapshot[] = raw.snapshots
    .map((snapshot, order) => ({ snapshot, order }))
    .sort((a, b) => a.snapshot.anchor - b.snapshot.anchor || a.order - b.order)
    .map(({ snapshot }, index) => {
      const after = snapshot.anchor > 0 ? appEventIds[Math.min(snapshot.anchor, appEventIds.length) - 1] : undefined;
      return {
        id: `S${index + 1}`,
        label: snapshot.label,
        afterEventId: after?.id ?? null,
        afterSeq: after?.seq ?? 0,
        canonical: projectSnapshot(snapshot.snapshot),
      };
    });

  const body = {
    schema: EVIDENCE_PACKET_SCHEMA,
    schemaVersion: EVIDENCE_PACKET_SCHEMA_VERSION,
    contract: buildContract(raw.seeded),
    events,
    turns: deriveTurns(events),
    snapshots,
    audioSummary: summarizeAudio(events),
    harness: {
      ...raw.harness,
      clockDomain: "page-epoch-ms" as const,
      notes: raw.harness.notes ?? [],
    },
  };
  // The default id comes from a content digest, not from packetHash, so the
  // hash can cover the id without circularity.
  const packetId = raw.packetId ?? `${raw.harness.scenarioId}-${sha256(body).slice(0, 12)}`;
  const finalized = { ...body, packetId };
  return deepFreeze({ ...finalized, packetHash: sha256(finalized) });
}

/** True when every finalized field except packetHash still matches packetHash. */
export function verifyPacketHash(packet: EvidencePacket) {
  const { packetHash, ...finalized } = packet;
  return sha256(finalized) === packetHash;
}
