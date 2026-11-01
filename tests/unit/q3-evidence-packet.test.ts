import { describe, expect, it } from "vitest";
import { measurePerformance } from "../q3/assertions/performance";
import { buildContract, buildEvidencePacket, verifyPacketHash } from "../q3/evidence/build";
import { normalizeProviderFrame, REDACTED, redactSecrets } from "../q3/evidence/provider-frames";
import { SyntheticTrace, validFullSession } from "../q3/evidence/synthetic-trace";
import { EVIDENCE_PACKET_SCHEMA, EVIDENCE_PACKET_SCHEMA_VERSION, type EvidencePacket } from "../q3/evidence/types";
import { buildFixtureSavedLesson, countFixtureBeats, PLC_Q3_FIXTURE } from "../helpers/lesson-fixture";
import { parseSavedLesson } from "../../lib/local-persistence";

describe("PLC Q3 fixture", () => {
  it("has 3 core concepts, 1 optional concept and 7 canonical beats", () => {
    const importance = PLC_Q3_FIXTURE.concepts.map(({ teaching }) => teaching.importance);
    expect(importance.filter((level) => level === "core")).toHaveLength(3);
    expect(importance.filter((level) => level === "optional")).toHaveLength(1);
    expect(countFixtureBeats(PLC_Q3_FIXTURE)).toBe(7);
  });

  it("is accepted unchanged by the app's saved-lesson parser", () => {
    const parsed = parseSavedLesson(buildFixtureSavedLesson(PLC_Q3_FIXTURE, "a", { now: "2026-01-01T00:00:00.000Z" }));
    expect(parsed?.lessonState.rootNodeIds).toEqual(PLC_Q3_FIXTURE.concepts.map(({ id }) => id));
    expect(parsed?.source.prepared.lessonTree.map(({ id }) => id)).toEqual(PLC_Q3_FIXTURE.concepts.map(({ id }) => id));
  });

  it("derives a stable contract whose Core Path excludes the optional concept", () => {
    const seeded = {
      fixtureId: "plc-q3", fixtureVersion: "1",
      lesson: buildFixtureSavedLesson(PLC_Q3_FIXTURE, "a", { now: "2026-01-01T00:00:00.000Z" }),
    };
    const contract = buildContract(seeded);
    const again = buildContract({ ...seeded, lesson: buildFixtureSavedLesson(PLC_Q3_FIXTURE, "a", { now: "2027-01-01T00:00:00.000Z" }) });
    expect(contract.corePath).toHaveLength(6);
    expect(contract.corePath.some(({ conceptId }) => conceptId === "plc-history")).toBe(false);
    expect(contract.initial.cursors).toEqual({
      "what-is-a-plc": 0, "plc-scan-cycle": 0, "plc-history": 0, "plc-io-modules": 0,
    });
    expect(again.contractHash).toBe(contract.contractHash);
  });
});

describe("provider frame normalization", () => {
  it("strips audio payload bytes and keeps only their size", () => {
    const data = Buffer.alloc(300).toString("base64");
    const events = normalizeProviderFrame({ serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data } }] },
      outputTranscription: { text: "Hello" },
      generationComplete: true,
    } });
    expect(events.map(({ name }) => name)).toEqual([
      "provider.audio", "provider.output-transcription", "provider.generation-complete",
    ]);
    expect(events[0].detail).toEqual({ mimeType: "audio/pcm;rate=24000", bytes: 300 });
    expect(JSON.stringify(events)).not.toContain(data);
  });

  it("redacts tokens, keys and ephemeral token names", () => {
    const redacted = redactSecrets({
      url: "wss://generativelanguage.googleapis.com/ws?access_token=auth_tokens/abc123&x=1",
      apiKey: "AIza-secret",
      nested: { token: "auth_tokens/xyz", note: "uses auth_tokens/qqq" },
    });
    const json = JSON.stringify(redacted);
    for (const secret of ["abc123", "AIza-secret", "xyz", "qqq"]) expect(json).not.toContain(secret);
    expect(redacted.url).toContain("x=1");
  });

  it("redacts a bearer credential carried under a nonstandard nested header name", () => {
    const credential = "Bearer q3-provider-secret";
    const events = normalizeProviderFrame({
      toolCall: {
        functionCalls: [{
          id: "call-1",
          name: "lesson_state",
          args: { headers: { "X-Custom-Auth": credential }, action: "query" },
        }],
      },
    });

    const json = JSON.stringify(events);
    expect(json).not.toContain("q3-provider-secret");
    expect(json).toContain("lesson_state");
    expect(json).toContain("query");
  });

  describe("credential redaction by key and by value", () => {
    it("redacts standard sensitive keys", () => {
      const redacted = redactSecrets({
        Authorization: "Bearer abc123def456", api_key: "k-1", token: "t-1", password: "p", "x-goog-api-key": "AIza-1",
      });
      expect(Object.values(redacted)).toEqual(Array(5).fill(REDACTED));
    });

    it("redacts a bearer credential by value under a key that is not sensitive", () => {
      const redacted = redactSecrets({ meta: { forwarded: "Bearer sk-live-9f8e7d6c5b" } });
      expect(redacted.meta.forwarded).toBe(`Bearer ${REDACTED}`);
    });

    it("redacts auth-scheme credentials inside nested arrays and embedded text", () => {
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxMyJ9.c2lnbmF0dXJlLXZhbHVl";
      const redacted = redactSecrets({
        calls: [{ args: { lines: ["curl -H 'Authorization: Bearer abc123def456' https://x", `Basic ${jwt}`] } }],
      });
      const json = JSON.stringify(redacted);
      for (const secret of ["abc123def456", jwt]) expect(json).not.toContain(secret);
      expect(redacted.calls[0].args.lines[0]).toBe(`curl -H 'Authorization: Bearer ${REDACTED}' https://x`);
    });

    it("removes URL credentials while keeping the rest of the URL", () => {
      const url = redactSecrets("https://generativelanguage.googleapis.com/ws/Live?key=AIza-q3&alt=json");
      expect(url).toBe(`https://generativelanguage.googleapis.com/ws/Live?key=${REDACTED}&alt=json`);
    });

    it("keeps educational text and ordinary fields that only mention auth words", () => {
      const prose = "Bearer tokens are commonly used for HTTP authorization; an API key or auth token proves identity.";
      const value = {
        text: prose,
        topic: "Bearer authentication",
        author: "Ada",
        maxTokens: 3,
        token_count: 12,
        action: "query",
        conceptId: "what-is-a-plc",
      };
      expect(redactSecrets(value)).toEqual(value);
      const events = normalizeProviderFrame({ serverContent: { outputTranscription: { text: prose } } });
      expect(events[0].detail).toEqual({ text: prose });
    });

    it("keeps tool identity and arguments while redacting the credential inside them", () => {
      const [event] = normalizeProviderFrame({ toolCall: { functionCalls: [{
        id: "call-7", name: "lesson_state",
        args: { action: "navigate", conceptId: "plc-scan-cycle", note: "Bearer q3secret12345" },
      }] } });
      expect(event.detail).toEqual({ calls: [{
        id: "call-7", name: "lesson_state",
        args: { action: "navigate", conceptId: "plc-scan-cycle", note: `Bearer ${REDACTED}` },
      }] });
    });

    it("redacts credentials in app and harness details on the packet path", () => {
      const packet = buildEvidencePacket({
        seeded: new SyntheticTrace().seeded,
        appEvents: [{ name: "tool.decision", timestamp: 1, detail: { name: "lesson_state", note: "Bearer abc123def456" } }],
        providerFrames: [],
        harnessEvents: [{ anchor: 0, t: 1, name: "harness.learner-text", detail: { text: "my key is Bearer zz9-secret-77" } }],
        snapshots: [],
        harness: { kind: "q2-scripted", scenarioId: "redaction", endedBy: "open" },
      });
      const json = JSON.stringify(packet);
      for (const secret of ["abc123def456", "zz9-secret-77"]) expect(json).not.toContain(secret);
      expect(json).toContain("lesson_state");
    });
  });
});

describe("EvidencePacket construction", () => {
  it("is versioned, ordered, hashed and immutable", () => {
    const packet = validFullSession().build("lesson-completed");
    expect(packet.schema).toBe(EVIDENCE_PACKET_SCHEMA);
    expect(packet.schemaVersion).toBe(EVIDENCE_PACKET_SCHEMA_VERSION);
    expect(packet.events.map(({ seq }) => seq)).toEqual(packet.events.map((_, index) => index + 1));
    expect(verifyPacketHash(packet)).toBe(true);
    expect(Object.isFrozen(packet)).toBe(true);
    expect(Object.isFrozen(packet.events[0])).toBe(true);
    expect(() => { (packet.events as unknown as unknown[]).push({}); }).toThrow();

    const tampered = structuredClone(packet);
    tampered.events[0].name = "edited";
    expect(verifyPacketHash(tampered)).toBe(false);
  });

  it("rejects a packet whose finalized packet identity was changed", () => {
    const packet = validFullSession().build("lesson-completed");
    const tampered = structuredClone(packet);

    tampered.packetId = "different-finalized-packet";

    expect(verifyPacketHash(tampered)).toBe(false);
  });

  describe("packetHash authenticates every finalized field except itself", () => {
    type Mutable = EvidencePacket;
    const finalized = () => validFullSession().build("lesson-completed");
    const tamper = (mutate: (packet: Mutable) => void) => {
      const copy = structuredClone(finalized());
      mutate(copy);
      return verifyPacketHash(copy);
    };

    it("verifies an unchanged packet, including after JSON serialize and parse", () => {
      const packet = finalized();
      expect(verifyPacketHash(packet)).toBe(true);
      expect(verifyPacketHash(JSON.parse(JSON.stringify(packet)))).toBe(true);
    });

    it("is deterministic and covers the default content-derived packetId", () => {
      const first = finalized();
      const second = finalized();
      expect(second.packetId).toBe(first.packetId);
      expect(second.packetHash).toBe(first.packetHash);
      expect(first.packetId).toMatch(/^synthetic-[0-9a-f]{12}$/);
    });

    it.each([
      ["packetHash", (packet: Mutable) => { packet.packetHash = "0".repeat(64); }],
      ["packetId", (packet: Mutable) => { packet.packetId = "different-finalized-packet"; }],
      ["schemaVersion", (packet: Mutable) => { (packet as { schemaVersion: number }).schemaVersion = 2; }],
      ["event name", (packet: Mutable) => { packet.events[0].name = "edited"; }],
      ["nested event detail", (packet: Mutable) => {
        const commit = packet.events.find(({ name }) => name === "beat.commit")!;
        (commit.detail!.teachingPointIndexes as number[])[0] = 9;
      }],
      ["event removal", (packet: Mutable) => { packet.events.splice(3, 1); }],
      ["event reordering", (packet: Mutable) => { [packet.events[1], packet.events[2]] = [packet.events[2], packet.events[1]]; }],
      ["contract", (packet: Mutable) => { packet.contract.initial.cursors["what-is-a-plc"] = 1; }],
      ["nested contract beat", (packet: Mutable) => { packet.contract.concepts[0].beats[0][0] = 1; }],
      ["snapshot canonical coverage", (packet: Mutable) => { packet.snapshots[0].canonical.coverage["plc-history"] = "skipped"; }],
      ["turn text", (packet: Mutable) => { packet.turns[0].text = "rewritten"; }],
      ["audio summary", (packet: Mutable) => { packet.audioSummary.naturalDrains += 1; }],
      ["harness endedBy", (packet: Mutable) => { packet.harness.endedBy = "open"; }],
      ["added field", (packet: Mutable) => { (packet as Record<string, unknown>).extra = true; }],
    ])("fails verification after %s mutation", (_label, mutate) => {
      expect(tamper(mutate)).toBe(false);
    });

    it("stays immutable after finalization", () => {
      const packet = finalized();
      expect(Object.isFrozen(packet.contract.concepts[0].beats[0])).toBe(true);
      expect(() => { (packet as { packetId: string }).packetId = "x"; }).toThrow();
    });
  });

  it("orders frames and harness events exactly against app events by anchor", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "PLC means");
    trace.typedInterrupt(beat.generationEpoch, "wait");
    const names = trace.build().events.map(({ source, name }) => `${source}:${name}`);
    expect(names).toEqual([
      "app:lesson.generation-started",
      "provider:provider.audio",
      "provider:provider.output-transcription",
      "app:tutor.audio-started",
      "harness:harness.learner-text",
      "app:audio.epoch-invalidated",
      "app:interruption.accepted",
    ]);
  });

  it("derives tutor and learner turns with interruption endings", () => {
    const turns = validFullSession().build().turns;
    expect(turns.slice(0, 4).map(({ role, channel, endedBy }) => `${role}/${channel}/${endedBy}`)).toEqual([
      "tutor/tutor-transcript/generation-complete",
      "tutor/tutor-transcript/learner-turn",
      "learner/typed/sent",
      "tutor/tutor-transcript/generation-complete",
    ]);
    expect(turns[2]).toMatchObject({ text: "Wait, what are inputs and outputs?", duringTutorOutput: true });
  });

  it("summarizes audio without payload bytes", () => {
    const summary = validFullSession().build().audioSummary;
    expect(summary).toMatchObject({
      invalidationsByReason: { "barge-in": 1 }, staleAudioRejection: "q1-owned",
    });
    // Six delivered beats; the optional concept was skipped.
    expect(summary.naturalDrains).toBe(6);
    expect(summary.providerAudioBytes).toBeGreaterThan(0);
  });

  it("anchors snapshots after the last app event they observed", () => {
    const trace = new SyntheticTrace();
    trace.snap("before anything");
    trace.deliver("what-is-a-plc", [0]).snap("after commit");
    const packet = trace.build();
    expect(packet.snapshots[0]).toMatchObject({ label: "before anything", afterEventId: null, afterSeq: 0 });
    const after = packet.events.find(({ id }) => id === packet.snapshots[1].afterEventId);
    expect(after?.name).toBe("coverage.changed");
  });

  it("refuses to carry raw app details it cannot redact", () => {
    const packet = buildEvidencePacket({
      seeded: new SyntheticTrace().seeded,
      appEvents: [{ name: "tool.decision", timestamp: 1, detail: { token: "secret-token" } }],
      providerFrames: [], harnessEvents: [], snapshots: [],
      harness: { kind: "q2-scripted", scenarioId: "redaction", endedBy: "open" },
    });
    expect(JSON.stringify(packet)).not.toContain("secret-token");
  });
});

describe("performance measurements", () => {
  it("records latencies without gating", () => {
    const measures = measurePerformance(validFullSession().build());
    expect(measures.gating).toBe(false);
    expect(measures.interruptionAcceptLatencyMs).toHaveLength(1);
    expect(measures.interruptionAcceptLatencyMs[0].ms).toBeGreaterThanOrEqual(0);
    expect(measures.tutorResponseLatencyMs).toHaveLength(2);
    expect(measures.summary.learnerTurnsWithoutTutorResponse).toBe(0);
  });

  it("reports a missing response as null rather than failing", () => {
    const trace = new SyntheticTrace();
    trace.typed("Is anyone there?", false);
    const measures = measurePerformance(trace.build());
    expect(measures.tutorResponseLatencyMs).toEqual([{ turnId: "T1", ms: null }]);
    expect(measures.summary.learnerTurnsWithoutTutorResponse).toBe(1);
  });
});
