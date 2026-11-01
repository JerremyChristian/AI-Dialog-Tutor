import { describe, expect, it } from "vitest";
import {
  checkH1, checkH2, checkH3, checkH4, checkH5, checkH6, checkH7, checkH8, checkH10,
  evaluateHardAssertions, type HardAssertionResult,
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
    expectFail(checkH7(trace.build()), /without a preceding end decision or stop request/);
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

  it("fails when a provider voice barge-in is not accepted", () => {
    const trace = new SyntheticTrace();
    const beat = trace.assign("what-is-a-plc", [0]);
    trace.speak(beat.generationEpoch, "PLC means");
    trace.frame({ voiceActivity: { voiceActivityType: "ACTIVITY_START" }, serverContent: { interrupted: true } });
    expectFail(checkH8(trace.build()), /voice barge-in during tutor output was not accepted/);
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
