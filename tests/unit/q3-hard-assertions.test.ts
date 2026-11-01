import { describe, expect, it } from "vitest";
import {
  checkH1, checkH2, checkH3, checkH4, checkH5, checkH6, checkH7, checkH8, checkH10,
  aggregateVerdict, evaluateHardAssertions, type HardAssertionResult,
} from "../q3/assertions/hard";
import { SyntheticTrace, validFullSession } from "../q3/evidence/synthetic-trace";

function expectFail(result: HardAssertionResult, reason: RegExp) {
  expect(result.status).toBe("fail");
  expect(result.violations.map(({ message }) => message).join("\n")).toMatch(reason);
  for (const violation of result.violations) expect(violation.evidence.length).toBeGreaterThan(0);
}

/** A delivered first concept, then a Review of it. */
function reviewTrace() {
  const trace = new SyntheticTrace();
  trace.deliver("what-is-a-plc", [0]).deliver("what-is-a-plc", [1]);
  trace.snap("before review");
  trace.app("review.started", { nodeId: "what-is-a-plc" });
  trace.reviewActive = true;
  trace.snap("review started");
  return trace;
}

describe("Q3-A full valid session", () => {
  it("passes every applicable hard assertion and reports a complete Core Path", () => {
    const evaluation = evaluateHardAssertions(validFullSession().build("lesson-completed"));
    expect(Object.fromEntries(evaluation.assertions.map(({ id, status }) => [id, status]))).toEqual({
      H1: "pass", H2: "pass", H3: "pass", H4: "not-applicable", H5: "pass",
      H6: "pass", H7: "pass", H8: "pass", H10: "pass",
    });
    expect(evaluation.verdict).toBe("pass");
    expect(evaluation.corePath).toMatchObject({
      status: "complete", allCoreBeatsCommitted: true, requiredCoreBeats: 6, committedCoreBeats: 6,
    });
    expect(evaluation.deferred.map(({ id }) => id)).toEqual(["H9", "H11", "stale-audio", "non-beat-output-stop"]);
  });
});

describe("aggregate verdict", () => {
  /** Review with no boundary snapshots: H4 unsupported, nothing fails. */
  const unsupportedReview = () => {
    const trace = new SyntheticTrace();
    trace.app("review.started", { nodeId: "what-is-a-plc" });
    trace.app("review.ended", { nodeId: "what-is-a-plc", reason: "completed" });
    return trace;
  };

  it("fails when one applicable assertion fails", () => {
    const trace = new SyntheticTrace();
    trace.app("delivery.cursor-changed", { conceptId: "what-is-a-plc", from: 0, to: 1 });
    expect(evaluateHardAssertions(trace.build()).verdict).toBe("fail");
  });

  it("fails, not inconclusive, when an unsupported assertion coexists with a failure", () => {
    const trace = unsupportedReview();
    trace.deliver("what-is-a-plc", [0]);
    trace.app("review.started", { nodeId: "what-is-a-plc" });
    trace.deliver("what-is-a-plc", [1]);
    const evaluation = evaluateHardAssertions(trace.build());
    expect(evaluation.assertions.find(({ id }) => id === "H4")?.status).toBe("fail");
    expect(evaluation.verdict).toBe("fail");
  });

  it("fails an aborted run that has a hard failure", () => {
    const trace = new SyntheticTrace();
    trace.app("delivery.cursor-changed", { conceptId: "what-is-a-plc", from: 0, to: 1 });
    expect(evaluateHardAssertions(trace.build("aborted", { category: "provider", message: "Live 503" })).verdict).toBe("fail");
  });

  it("keeps a partial open packet inconclusive instead of passing it", () => {
    const trace = new SyntheticTrace();
    trace.deliver("what-is-a-plc", [0]).snap("partial capture");

    const evaluation = evaluateHardAssertions(trace.build("open"));
    expect(evaluation.assertions.some(({ status }) => status === "fail")).toBe(false);
    expect(evaluation.verdict).toBe("inconclusive");
  });

  it("does not pass a finished packet with no canonical snapshots", () => {
    const trace = validFullSession();
    trace.snapshots.length = 0;

    const evaluation = evaluateHardAssertions(trace.build("lesson-completed"));
    expect(evaluation.assertions.some(({ status }) => status === "fail")).toBe(false);
    expect(evaluation.verdict).toBe("inconclusive");
  });

  describe("finalization anchor", () => {
    /** A learner-stopped session; `finalSnap` adds the anchor read after the last app event. */
    const stoppedSession = (finalSnap: boolean) => {
      const trace = new SyntheticTrace();
      trace.snap("start");
      trace.deliver("what-is-a-plc", [0]);
      trace.stopRequested().complete("stopped", false);
      if (finalSnap) trace.snap("finalize");
      return trace;
    };

    it("anchors a completed session on its final snapshot", () => {
      const evaluation = evaluateHardAssertions(validFullSession().build("lesson-completed"));
      expect(evaluation.finalization).toEqual({ status: "anchored", anchorSnapshotId: "S5" });
      expect(evaluation.verdict).toBe("pass");
    });

    it("passes a harness-stopped session with a final anchor", () => {
      const evaluation = evaluateHardAssertions(stoppedSession(true).build("harness-stop"));
      expect(evaluation.finalization.status).toBe("anchored");
      expect(evaluation.verdict).toBe("pass");
    });

    it("is inconclusive when a harness-stopped session's only snapshot predates the end", () => {
      const evaluation = evaluateHardAssertions(stoppedSession(false).build("harness-stop"));
      expect(evaluation.assertions.some(({ status }) => status === "fail")).toBe(false);
      expect(evaluation.finalization).toEqual({ status: "missing", anchorSnapshotId: null });
      expect(evaluation.verdict).toBe("inconclusive");
    });

    it("fails, not inconclusive, when the anchor is missing and a hard assertion fails", () => {
      const trace = validFullSession();
      trace.snapshots.length = 0;
      trace.app("delivery.cursor-changed", { conceptId: "what-is-a-plc", from: 2, to: 3 });
      expect(evaluateHardAssertions(trace.build("lesson-completed")).verdict).toBe("fail");
    });

    it("fails when the final snapshot contradicts the committed event history", () => {
      const trace = validFullSession();
      trace.snap("contradicting finalize", { deliveryCursor: 0 });
      const evaluation = evaluateHardAssertions(trace.build("lesson-completed"));
      expect(evaluation.finalization.status).toBe("anchored");
      expect(evaluation.assertions.find(({ id }) => id === "H1")?.status).toBe("fail");
      expect(evaluation.verdict).toBe("fail");
    });

    it("is not required for open or aborted captures, which stay inconclusive", () => {
      for (const endedBy of ["open", "aborted"] as const) {
        const trace = new SyntheticTrace();
        trace.deliver("what-is-a-plc", [0]);
        const evaluation = evaluateHardAssertions(trace.build(endedBy));
        expect(evaluation.finalization.status).toBe("not-required");
        expect(evaluation.verdict).toBe("inconclusive");
      }
    });
  });

  it.each([
    ["finished, all applicable pass", ["pass", "pass", "not-applicable"], "lesson-completed", "anchored", "pass"],
    ["harness-stopped, all applicable pass", ["pass", "pass"], "harness-stop", "anchored", "pass"],
    ["finished, only not-applicable", ["not-applicable", "not-applicable"], "lesson-completed", "anchored", "pass"],
    ["finished without final anchor", ["pass", "pass"], "lesson-completed", "missing", "inconclusive"],
    ["harness-stopped without final anchor", ["pass", "pass"], "harness-stop", "missing", "inconclusive"],
    ["finished without final anchor, with fail", ["pass", "fail"], "lesson-completed", "missing", "fail"],
    ["one unsupported", ["pass", "unsupported", "not-applicable"], "lesson-completed", "anchored", "inconclusive"],
    ["multiple unsupported", ["unsupported", "pass", "unsupported"], "lesson-completed", "anchored", "inconclusive"],
    ["unsupported plus fail", ["unsupported", "fail", "pass"], "lesson-completed", "anchored", "fail"],
    ["open without fail", ["pass", "not-applicable"], "open", "not-required", "inconclusive"],
    ["open with unsupported", ["pass", "unsupported"], "open", "not-required", "inconclusive"],
    ["open with fail", ["pass", "fail"], "open", "not-required", "fail"],
    ["aborted without fail", ["pass", "not-applicable"], "aborted", "not-required", "inconclusive"],
    ["aborted with unsupported", ["unsupported"], "aborted", "not-required", "inconclusive"],
    ["aborted with fail", ["pass", "fail"], "aborted", "not-required", "fail"],
  ] as const)("aggregates %s", (_label, statuses, endedBy, finalization, verdict) => {
    expect(aggregateVerdict(statuses.map((status) => ({ status })), endedBy, { status: finalization })).toBe(verdict);
  });
});

describe("H1 canonical cursor and navigation integrity", () => {
  it("passes sequential commits and an applied navigation back", () => {
    const trace = new SyntheticTrace();
    trace.deliver("what-is-a-plc", [0]);
    trace.navigate("plc-scan-cycle").snap("moved forward");
    trace.navigate("what-is-a-plc").snap("moved back");
    trace.deliver("what-is-a-plc", [1]).snap("finished first");
    expect(checkH1(trace.build()).status).toBe("pass");
  });

  it("fails when a commit skips the uncommitted beat", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [1]);
    trace.speak(beat.generationEpoch, "Second point first").drain(beat.generationEpoch).commit(beat);
    expectFail(checkH1(trace.build()), /starting at 1 while its cursor was 0/);
  });

  it("fails when a snapshot reports a regressed cursor", () => {
    const trace = new SyntheticTrace();
    trace.deliver("what-is-a-plc", [0]).snap("after commit", { deliveryCursor: 0 });
    expectFail(checkH1(trace.build()), /snapshot reports what-is-a-plc cursor 0; committed evidence gives 1/);
  });

  it("fails when the current concept changes without navigation or assignment", () => {
    const trace = new SyntheticTrace();
    trace.snap("start").snap("jumped", { currentNodeId: "plc-scan-cycle", deliveryCursor: 0 });
    expectFail(checkH1(trace.build()), /current concept changed what-is-a-plc -> plc-scan-cycle/);
  });

  it("fails when a cursor change is not paired with a lesson commit", () => {
    const trace = new SyntheticTrace();
    trace.app("delivery.cursor-changed", { conceptId: "what-is-a-plc", from: 0, to: 1 });
    expectFail(checkH1(trace.build()), /not paired with its lesson beat.commit/);
  });
});

describe("H2 no duplicate lesson beat.commit", () => {
  it("passes distinct commits and does not count Review commits", () => {
    const trace = reviewTrace();
    trace.commit({ conceptId: "what-is-a-plc", teachingPointIndexes: [0], generationEpoch: 90 }, "review");
    expect(checkH2(trace.build()).status).toBe("pass");
  });

  it("fails when the same lesson beat commits twice", () => {
    const trace = new SyntheticTrace();
    trace.deliver("what-is-a-plc", [0]);
    const again = trace.assign("what-is-a-plc", [0]);
    trace.speak(again.generationEpoch, "Again").drain(again.generationEpoch);
    trace.app("beat.commit", { mode: "lesson", conceptId: "what-is-a-plc", nextIndex: 1, teachingPointIndexes: [0], generationEpoch: again.generationEpoch });
    expectFail(checkH2(trace.build()), /what-is-a-plc:0 committed more than once/);
  });
});

describe("H3 interrupted beats never commit; commits follow natural drain", () => {
  it("passes an interrupted beat that is re-assigned and then committed", () => {
    expect(checkH3(validFullSession().build()).status).toBe("pass");
  });

  it("fails when an invalidated epoch commits", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "PLC means");
    trace.typedInterrupt(beat.generationEpoch, "wait");
    trace.drain(beat.generationEpoch).commit(beat);
    expectFail(checkH3(trace.build()), /epoch 1 committed after it was invalidated \(barge-in\)/);
  });

  it("fails when a lesson beat commits without a natural drain", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "PLC means").commit(beat);
    expectFail(checkH3(trace.build()), /without a natural audio drain/);
  });

  it("fails when a commit has no generation epoch correlation", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "PLC means").drain(beat.generationEpoch);
    trace.commit({ conceptId: beat.conceptId, teachingPointIndexes: beat.teachingPointIndexes });
    expectFail(checkH3(trace.build()), /no generationEpoch correlation/);
  });

  it("fails when a generation epoch is reused by a newer assignment", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "First owner").drain(beat.generationEpoch);
    trace.app("lesson.generation-started", {
      conceptId: "what-is-a-plc",
      generationEpoch: beat.generationEpoch,
      deliveryUnitIndex: 0,
      beatIndex: 1,
    });
    trace.speak(beat.generationEpoch, "Second owner").drain(beat.generationEpoch).commit(beat);

    expectFail(checkH3(trace.build()), /generation epoch 1 was assigned more than once/);
  });

  describe("generation epoch ownership", () => {
    const assignment = (trace: SyntheticTrace, conceptId: string, generationEpoch: number, beatIndex = 0) =>
      trace.app("lesson.generation-started", { conceptId, generationEpoch, deliveryUnitIndex: 0, beatIndex });

    it("passes distinct epochs for distinct beats, including a retried beat on a new epoch", () => {
      const trace = new SyntheticTrace();
      const first = trace.assign("what-is-a-plc", [0]);
      trace.speak(first.generationEpoch, "PLC means").typedInterrupt(first.generationEpoch, "wait");
      trace.deliver("what-is-a-plc", [0]).deliver("what-is-a-plc", [1]);
      const result = checkH3(trace.build());
      expect(result.status).toBe("pass");
      expect(new Set(trace.appEvents.filter(({ name }) => name === "lesson.generation-started")
        .map(({ detail }) => detail?.generationEpoch)).size).toBe(3);
    });

    it("fails when one epoch is assigned to two different concepts", () => {
      const trace = new SyntheticTrace();
      const beat = trace.assign("what-is-a-plc", [0]);
      assignment(trace, "plc-scan-cycle", beat.generationEpoch);
      trace.speak(beat.generationEpoch, "Scan cycle").drain(beat.generationEpoch).commit(beat);
      expectFail(checkH3(trace.build()), /generation epoch 1 was assigned more than once/);
    });

    it("rejects a duplicate assignment even to the identical owner (no replay mechanism exists)", () => {
      const trace = new SyntheticTrace();
      const beat = trace.assign("what-is-a-plc", [0]);
      assignment(trace, "what-is-a-plc", beat.generationEpoch);
      trace.speak(beat.generationEpoch, "PLC means").drain(beat.generationEpoch).commit(beat);
      expectFail(checkH3(trace.build()), /generation epoch 1 was assigned more than once/);
    });

    it("fails when a Review commit reuses a canonical lesson epoch", () => {
      const trace = new SyntheticTrace();
      trace.deliver("what-is-a-plc", [0]).deliver("what-is-a-plc", [1]);
      trace.app("review.started", { nodeId: "what-is-a-plc" });
      trace.commit({ conceptId: "what-is-a-plc", teachingPointIndexes: [0], generationEpoch: 1 }, "review");
      expectFail(checkH3(trace.build()), /Review commit reuses canonical lesson epoch 1/);
    });

    it("fails when a lesson assignment reuses an epoch a Review commit already owned", () => {
      const trace = new SyntheticTrace();
      trace.app("review.started", { nodeId: "what-is-a-plc" });
      trace.commit({ conceptId: "what-is-a-plc", teachingPointIndexes: [0], generationEpoch: 5 }, "review");
      trace.app("review.ended", { nodeId: "what-is-a-plc", reason: "manual" });
      assignment(trace, "what-is-a-plc", 5);
      expectFail(checkH3(trace.build()), /lesson assignment reuses Review epoch 5/);
    });

    it("fails when the drain belongs to a different epoch than the commit", () => {
      const trace = new SyntheticTrace();
      const beat = trace.assign("what-is-a-plc", [0]);
      const other = trace.assign("what-is-a-plc", [1]);
      trace.speak(other.generationEpoch, "Second point").drain(other.generationEpoch).commit(beat);
      expectFail(checkH3(trace.build()), /lesson commit for epoch 1 without a natural audio drain of that epoch/);
    });

    it("fails when one epoch's lifecycle is combined with another epoch's commit", () => {
      // Epoch 1 is assigned and drains; the commit claims epoch 2, assigned later
      // and never drained, while citing epoch 1's beat.
      const trace = new SyntheticTrace();
      const beat = trace.assign("what-is-a-plc", [0]);
      trace.speak(beat.generationEpoch, "PLC means").drain(beat.generationEpoch);
      const later = trace.assign("what-is-a-plc", [0]);
      trace.commit({ ...beat, generationEpoch: later.generationEpoch });
      expectFail(checkH3(trace.build()), /lesson commit for epoch 2 without a natural audio drain of that epoch/);
    });

    it("fails when one epoch commits twice or drains twice", () => {
      const trace = new SyntheticTrace();
      const beat = trace.assign("what-is-a-plc", [0]);
      trace.speak(beat.generationEpoch, "PLC means").drain(beat.generationEpoch).drain(beat.generationEpoch);
      trace.commit(beat);
      trace.app("beat.commit", { mode: "lesson", conceptId: "what-is-a-plc", nextIndex: 2, teachingPointIndexes: [1], generationEpoch: 1 });
      const result = checkH3(trace.build());
      expectFail(result, /generation epoch 1 was naturally drained more than once/);
      expectFail(result, /generation epoch 1 was committed more than once/);
    });
  });
});

describe("H4 Review isolation", () => {
  it("passes a Review that only advances its own cursor", () => {
    const trace = reviewTrace();
    trace.commit({ conceptId: "what-is-a-plc", teachingPointIndexes: [0], generationEpoch: 90 }, "review");
    trace.snap("review progressed");
    trace.app("review.ended", { nodeId: "what-is-a-plc", reason: "completed" });
    trace.reviewActive = false;
    trace.snap("review ended");
    expect(checkH4(trace.build()).status).toBe("pass");
  });

  it("is not applicable without Review", () => {
    expect(checkH4(new SyntheticTrace().build()).status).toBe("not-applicable");
  });

  it("is unsupported when Review has no canonical boundary snapshot", () => {
    const trace = new SyntheticTrace();
    trace.app("review.started", { nodeId: "what-is-a-plc" });
    trace.app("review.ended", { nodeId: "what-is-a-plc", reason: "completed" });

    expect(checkH4(trace.build()).status).toBe("unsupported");
  });

  it("makes the aggregate verdict inconclusive when Review isolation is unsupported", () => {
    const trace = new SyntheticTrace();
    trace.app("review.started", { nodeId: "what-is-a-plc" });
    trace.app("review.ended", { nodeId: "what-is-a-plc", reason: "completed" });

    const evaluation = evaluateHardAssertions(trace.build());
    expect(evaluation.assertions.find(({ id }) => id === "H4")?.status).toBe("unsupported");
    expect(evaluation.assertions.some(({ status }) => status === "fail")).toBe(false);
    expect(evaluation.verdict).toBe("inconclusive");
  });

  describe("snapshot evidence sufficiency", () => {
    const endReview = (trace: SyntheticTrace) => {
      trace.app("review.ended", { nodeId: "what-is-a-plc", reason: "completed" });
      trace.reviewActive = false;
      return trace;
    };

    it("is unsupported when the baseline snapshot before Review is missing", () => {
      const trace = new SyntheticTrace();
      trace.deliver("what-is-a-plc", [0]).deliver("what-is-a-plc", [1]);
      trace.app("review.started", { nodeId: "what-is-a-plc" });
      endReview(trace).snap("after review");
      const result = checkH4(trace.build());
      expect(result.status).toBe("unsupported");
      expect(result.notes.join(" ")).toMatch(/No canonical snapshot immediately before Review/);
    });

    it("is unsupported when the baseline snapshot predates later canonical progress", () => {
      const trace = new SyntheticTrace();
      trace.snap("stale baseline");
      trace.deliver("what-is-a-plc", [0]).deliver("what-is-a-plc", [1]);
      trace.app("review.started", { nodeId: "what-is-a-plc" });
      endReview(trace).snap("after review");
      expect(checkH4(trace.build()).status).toBe("unsupported");
    });

    it("is unsupported when an ended Review has no snapshot after its end", () => {
      const trace = reviewTrace();
      endReview(trace);
      const result = checkH4(trace.build());
      expect(result.status).toBe("unsupported");
      expect(result.notes.join(" ")).toMatch(/No canonical snapshot after Review end/);
    });

    it("fails, not unsupported, on an explicit canonical mutation despite missing snapshots", () => {
      const trace = new SyntheticTrace();
      trace.app("review.started", { nodeId: "what-is-a-plc" });
      trace.deliver("what-is-a-plc", [0]);
      endReview(trace);
      expectFail(checkH4(trace.build()), /beat.commit changed canonical progress during Review/);
    });

    it("passes multiple Review windows when each is fully evidenced", () => {
      const trace = reviewTrace();
      endReview(trace).snap("first review ended");
      trace.app("review.started", { nodeId: "what-is-a-plc" });
      endReview(trace).snap("second review ended");
      expect(checkH4(trace.build()).status).toBe("pass");
    });

    it("is unsupported when one of several Review windows lacks evidence", () => {
      const trace = reviewTrace();
      endReview(trace).snap("first review ended");
      trace.app("review.started", { nodeId: "what-is-a-plc" });
      endReview(trace);
      const result = checkH4(trace.build());
      expect(result.status).toBe("unsupported");
      expect(result.notes).toHaveLength(1);
    });
  });

  it("fails when a lesson commit happens during Review", () => {
    const trace = reviewTrace();
    trace.deliver("plc-scan-cycle", [0]);
    expectFail(checkH4(trace.build()), /beat.commit changed canonical progress during Review/);
  });

  it("fails when canonical state drifts during Review", () => {
    const trace = reviewTrace();
    trace.snap("drifted", { interruptionCount: 1 });
    expectFail(checkH4(trace.build()), /differs from before Review/);
  });

  it("fails when navigation is applied during Review", () => {
    const trace = reviewTrace();
    trace.decision("lesson_state", "navigate", "plc-scan-cycle", "transition-applied");
    expectFail(checkH4(trace.build()), /navigation was applied while Review was active/);
  });
});

describe("H5 Core Path integrity", () => {
  it("passes an incomplete run that the harness cut open", () => {
    const trace = new SyntheticTrace();
    trace.deliver("what-is-a-plc", [0]).snap("partway");
    const result = checkH5(trace.build("open"));
    expect(result.status).toBe("pass");
  });

  it("never reports an aborted run as a completed Core Path", () => {
    const trace = validFullSession();
    const evaluation = evaluateHardAssertions(trace.build("aborted", { category: "provider", message: "Live 503" }));
    expect(evaluation.corePath.status).toBe("aborted");
    expect(evaluation.corePath.allCoreBeatsCommitted).toBe(true);
    expect(evaluation.verdict).toBe("inconclusive");
  });

  it("fails when a concept is marked taught before all beats commit", () => {
    const trace = new SyntheticTrace();
    trace.deliver("what-is-a-plc", [0]);
    trace.app("coverage.changed", { conceptId: "what-is-a-plc", status: "taught" });
    expectFail(checkH5(trace.build()), /what-is-a-plc marked taught with 1\/2 points committed/);
  });

  it("fails when content becomes skipped without a skip or navigation", () => {
    const trace = new SyntheticTrace();
    trace.snap("silently skipped", { coverage: { ...trace.coverage, "plc-history": "skipped" } });
    expectFail(checkH5(trace.build()), /plc-history became skipped without an applied skip\/navigation/);
  });

  it("fails when the runtime finishes with an unattributed incomplete core concept", () => {
    const trace = new SyntheticTrace();
    trace.deliver("what-is-a-plc", [0]).deliver("what-is-a-plc", [1]);
    trace.decision("session_control", "end", null, "wrap-up-end");
    trace.complete("confirmed", true);
    expectFail(checkH5(trace.build("lesson-completed")), /core concept plc-scan-cycle left at 0\/3/);
  });
});

describe("H6 clarification and off-path coverage isolation", () => {
  it("passes when progress resumes only after a new assignment", () => {
    expect(checkH6(validFullSession().build()).status).toBe("pass");
  });

  it("fails when coverage changes inside an unresolved clarification", () => {
    const trace = new SyntheticTrace();
    trace.app("clarification.started", { source: "voice" });
    trace.app("coverage.changed", { conceptId: "what-is-a-plc", status: "taught" });
    expectFail(checkH6(trace.build()), /coverage.changed during an unresolved clarification/);
  });

  it("fails when a drained beat commits after the learner interrupted", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "PLC means").drain(beat.generationEpoch);
    trace.app("interruption.accepted", { conceptId: "what-is-a-plc", interruptionCount: 1 });
    trace.commit(beat);
    expectFail(checkH6(trace.build()), /beat.commit during an unresolved clarification/);
  });
});

describe("H7 completion integrity", () => {
  it("passes a learner stop requested by the harness", () => {
    const trace = new SyntheticTrace();
    trace.deliver("what-is-a-plc", [0]);
    trace.stopRequested().complete("stopped", false);
    expect(checkH7(trace.build("harness-stop")).status).toBe("pass");
  });

  it("fails when the lesson completes twice", () => {
    const trace = validFullSession();
    trace.complete("confirmed", true);
    expectFail(checkH7(trace.build("lesson-completed")), /lesson completed 2 times/);
  });

  it("fails when a confirmed completion has no end decision", () => {
    const trace = new SyntheticTrace();
    trace.complete("confirmed", false);
    expectFail(checkH7(trace.build()), /lesson completed \(confirmed\) without a preceding idle or end event/);
  });

  it("fails when canonical progress continues after completion", () => {
    const trace = new SyntheticTrace();
    trace.stopRequested().complete("stopped", false);
    trace.deliver("what-is-a-plc", [0]);
    expectFail(checkH7(trace.build()), /after lesson completion/);
  });

  it("fails when a plan-complete claim leaves concepts unfinished", () => {
    const trace = new SyntheticTrace();
    trace.decision("session_control", "end", null, "wrap-up-end");
    trace.complete("confirmed", true);
    expectFail(checkH7(trace.build()), /claims a complete plan while concepts remain unfinished/);
  });

  it("fails when the harness waited for completion that never happened", () => {
    expectFail(checkH7(new SyntheticTrace().build("lesson-completed")), /never completed the lesson/);
  });

  it("fails an inactivity completion with no observable idle or end attribution", () => {
    const trace = new SyntheticTrace();
    trace.app("clarification.started", { source: "typed" });
    trace.complete("inactivity", false);

    expectFail(checkH7(trace.build("lesson-completed")), /without a preceding idle or end event/);
  });

  describe("completion attribution comes from observable cause, not the reason string", () => {
    it("fails inactivity when idle confirmation was resolved back to active", () => {
      const trace = new SyntheticTrace();
      trace.engagement("active", "possibly-idle", "confirming", "active");
      trace.complete("inactivity", false);
      expectFail(checkH7(trace.build("lesson-completed")), /lesson completed \(inactivity\) without a preceding idle or end event/);
    });

    it("passes inactivity while an idle confirmation is still unresolved", () => {
      const trace = new SyntheticTrace();
      trace.engagement("active");
      trace.deliver("what-is-a-plc", [0]);
      trace.engagement("possibly-idle", "confirming");
      trace.complete("inactivity", false);
      expect(checkH7(trace.build("lesson-completed")).status).toBe("pass");
    });

    it("passes an explicit learner-requested early end via confirmed idle end decision", () => {
      const trace = new SyntheticTrace();
      trace.engagement("active", "possibly-idle", "confirming");
      trace.decision("session_control", "end", null, "confirm-end");
      trace.complete("confirmed", false);
      expect(checkH7(trace.build("lesson-completed")).status).toBe("pass");
    });

    it("passes normal full-plan completion after the wrap-up end decision", () => {
      const packet = validFullSession().build("lesson-completed");
      expect(checkH7(packet).status).toBe("pass");
      expect(checkH5(packet).status).toBe("pass");
    });

    it("fails an unknown completion reason", () => {
      const trace = new SyntheticTrace();
      trace.complete("finished", false);
      expectFail(checkH7(trace.build()), /unknown reason "finished"/);
    });

    it("does not let a fake inactivity completion rescue an unfinished Core Path", () => {
      const trace = new SyntheticTrace();
      trace.deliver("what-is-a-plc", [0]);
      trace.app("clarification.started", { source: "typed" });
      trace.complete("inactivity", false);
      trace.snap("ended", { coverage: { ...trace.coverage, "what-is-a-plc": "partial" } });
      const packet = trace.build("lesson-completed");
      const h5 = checkH5(packet);
      expectFail(h5, /core concept what-is-a-plc left at 1\/2 with no skip, navigation, early end, or harness cut/);
      expectFail(h5, /what-is-a-plc became partial without an applied skip\/navigation or session end/);
      expect(evaluateHardAssertions(packet).corePath.incompleteCoreConcepts
        .every(({ attributedTo }) => attributedTo.length === 0)).toBe(true);
    });

    it("lets an evidenced inactivity end explain unfinished Core Path, citing the cause", () => {
      const trace = new SyntheticTrace();
      trace.engagement("active");
      trace.deliver("what-is-a-plc", [0]);
      trace.engagement("possibly-idle", "confirming");
      trace.complete("inactivity", false);
      trace.snap("ended", { coverage: { ...trace.coverage, "what-is-a-plc": "partial" } });
      const packet = trace.build("lesson-completed");
      const causeId = packet.events.findLast(({ name }) => name === "engagement.changed")!.id;
      expect(packet.events.find(({ id }) => id === causeId)?.detail).toEqual({ state: "confirming" });
      expect(checkH5(packet).status).toBe("pass");
      const incomplete = evaluateHardAssertions(packet).corePath.incompleteCoreConcepts;
      expect(incomplete.every(({ attributedTo }) => attributedTo.includes(causeId))).toBe(true);
    });

    it("keeps an aborted run inconclusive and never a completed Core Path", () => {
      const trace = new SyntheticTrace();
      trace.deliver("what-is-a-plc", [0]);
      const evaluation = evaluateHardAssertions(trace.build("aborted", { category: "infrastructure", message: "browser crashed" }));
      expect(evaluation.verdict).toBe("inconclusive");
      expect(evaluation.assertions.filter(({ status }) => status === "fail")).toEqual([]);
      expect(evaluation.corePath).toMatchObject({ status: "aborted", allCoreBeatsCommitted: false });
      expect(evaluation.corePath.incompleteCoreConcepts[0].attributedTo).toEqual(["harness:aborted"]);
    });
  });
});

describe("H8 logical interruption integrity", () => {
  it("passes a typed barge-in that invalidates the speaking beat", () => {
    const result = checkH8(validFullSession().build());
    expect(result.status).toBe("pass");
  });

  it("is not applicable, with a note, when no tutor output is evidenced", () => {
    const trace = new SyntheticTrace();
    trace.typed("hello?", true);
    const result = checkH8(trace.build());
    expect(result.status).toBe("not-applicable");
    expect(result.notes.join(" ")).toMatch(/no open tutor output is evidenced/);
  });

  it("fails when a typed turn during output is ignored", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "PLC means").typed("wait, stop", true);
    expectFail(checkH8(trace.build()), /typed learner turn during tutor output was not accepted/);
  });

  it("fails when an accepted interruption leaves the beat epoch valid", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "PLC means").typed("wait", true);
    trace.app("interruption.accepted", { conceptId: "what-is-a-plc", interruptionCount: 1 });
    expectFail(checkH8(trace.build()), /did not invalidate the interrupted beat epoch 1/);
  });

  it("fails when one learner interruption is accepted twice", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "PLC means");
    trace.typedInterrupt(beat.generationEpoch, "wait");
    trace.app("interruption.accepted", { conceptId: "what-is-a-plc", interruptionCount: 2 });

    expectFail(checkH8(trace.build()), /learner interruption was accepted 2 times/);
  });

  it("fails when a provider voice barge-in is not accepted", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "PLC means");
    trace.frame({ voiceActivity: { voiceActivityType: "ACTIVITY_START" }, serverContent: { interrupted: true } });
    expectFail(checkH8(trace.build()), /voice barge-in during tutor output was not accepted/);
  });

  describe("acceptance cardinality per learner trigger", () => {
    it("passes two genuine triggers that are each accepted exactly once", () => {
      const trace = new SyntheticTrace();
      const first = trace.assign("what-is-a-plc", [0]);
      trace.speak(first.generationEpoch, "PLC means").typedInterrupt(first.generationEpoch, "wait");
      const second = trace.assign("what-is-a-plc", [0]);
      trace.speak(second.generationEpoch, "PLC means").typedInterrupt(second.generationEpoch, "hold on");
      const result = checkH8(trace.build());
      expect(result.status).toBe("pass");
      expect(result.violations).toEqual([]);
    });

    it("gives a later learner trigger its own acceptance instead of counting it twice", () => {
      // Typed barge-in, then a voice trigger before any new tutor output (the
      // Q1-F shape): the second acceptance belongs to the second trigger.
      const trace = new SyntheticTrace();
      const beat = trace.assign("what-is-a-plc", [0]);
      trace.speak(beat.generationEpoch, "PLC means").typedInterrupt(beat.generationEpoch, "wait");
      trace.frame({ voiceActivity: { voiceActivityType: "ACTIVITY_START" }, serverContent: { interrupted: true } });
      trace.app("interruption.accepted", { conceptId: "what-is-a-plc", interruptionCount: 2 });
      expect(checkH8(trace.build()).status).toBe("pass");
    });

    it("fails when the acceptance invalidates the wrong epoch", () => {
      const trace = new SyntheticTrace();
      const beat = trace.assign("what-is-a-plc", [0]);
      trace.speak(beat.generationEpoch, "PLC means").typed("wait", true);
      trace.app("audio.epoch-invalidated", { reason: "barge-in", invalidatedEpoch: 99, generationEpoch: 2 });
      trace.app("interruption.accepted", { conceptId: "what-is-a-plc", interruptionCount: 1 });
      expectFail(checkH8(trace.build()), /did not invalidate the interrupted beat epoch 1/);
    });

    it("fails when the interrupted canonical epoch later commits", () => {
      const trace = new SyntheticTrace();
      const beat = trace.assign("what-is-a-plc", [0]);
      trace.speak(beat.generationEpoch, "PLC means").typedInterrupt(beat.generationEpoch, "wait");
      trace.drain(beat.generationEpoch).commit(beat);
      expectFail(checkH8(trace.build()), /interrupted beat epoch 1 committed after typed learner turn/);
    });

    it("does not treat a learner turn after a natural drain as a barge-in", () => {
      const trace = new SyntheticTrace();
      trace.deliver("what-is-a-plc", [0]);
      trace.typed("Okay, makes sense.", true);
      const result = checkH8(trace.build());
      expect(result.status).toBe("not-applicable");
      expect(result.notes.join(" ")).toMatch(/no open tutor output is evidenced/);
    });

    it("accepts a noncanonical Review interruption once, without interruption.accepted", () => {
      const trace = new SyntheticTrace();
      trace.app("review.started", { nodeId: "what-is-a-plc" });
      trace.speak(++trace.epoch, "Reviewing: PLC means");
      trace.typed("wait", true);
      trace.app("audio.epoch-invalidated", { reason: "barge-in", invalidatedEpoch: trace.epoch, generationEpoch: trace.epoch + 1 });
      expect(checkH8(trace.build()).status).toBe("pass");
    });

    it("fails when a Review interruption is accepted twice", () => {
      const trace = new SyntheticTrace();
      trace.app("review.started", { nodeId: "what-is-a-plc" });
      trace.speak(++trace.epoch, "Reviewing: PLC means");
      trace.typed("wait", true);
      trace.app("audio.epoch-invalidated", { reason: "barge-in", invalidatedEpoch: trace.epoch, generationEpoch: trace.epoch + 1 });
      trace.app("audio.epoch-invalidated", { reason: "barge-in", invalidatedEpoch: trace.epoch + 1, generationEpoch: trace.epoch + 2 });
      expectFail(checkH8(trace.build()), /learner interruption was accepted 2 times/);
    });
  });
});

describe("H10 internal-control leakage", () => {
  it("passes ordinary tutor speech", () => {
    expect(checkH10(validFullSession().build()).status).toBe("pass");
  });

  it("fails when tutor speech contains an app control marker", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "Sure. [[APP_CONTROL:TEACH_PRESENTATION_BEAT]] PLC means");
    expectFail(checkH10(trace.build()), /tutor speech leaked internal control text/);
  });

  it("fails when tutor speech names an internal tool", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "Let me call lesson_state to check.");
    expectFail(checkH10(trace.build()), /leaked internal control text/);
  });
});
