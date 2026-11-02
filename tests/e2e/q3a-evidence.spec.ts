import { expect, test, type Page } from "@playwright/test";
import { expectHardEvidencePass, startEvidence, statusOf } from "../helpers/evidence-recorder";
import {
  deliverLive, getLiveSends, holdSavedLessonWrites, installFakeLive, openLessonAndStart, readSavedLesson,
  readTestState, releaseSavedLessonWrites,
} from "../helpers/fake-live";
import { PLC_Q3_FIXTURE } from "../helpers/lesson-fixture";
import { evaluateHardAssertions } from "../q3/assertions/hard";
import { measurePerformance } from "../q3/assertions/performance";
import { verifyPacketHash } from "../q3/evidence/build";

const pcmOf = (page: Page) => page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
const eventCount = async (page: Page, name: string) =>
  (await readTestState(page)).events.filter((event) => event.name === name).length;

async function deliverBeat(page: Page, text: string) {
  const commits = await eventCount(page, "beat.commit");
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: await pcmOf(page) } }] },
    outputTranscription: { text },
    generationComplete: true,
  } });
  await expect.poll(() => eventCount(page, "beat.commit")).toBe(commits + 1);
}

async function sendTool(page: Page, id: string, name: string, args: Record<string, unknown>) {
  const responses = (await getLiveSends(page)).filter(({ message }) => Boolean(message.toolResponse)).length;
  await deliverLive(page, { toolCall: { functionCalls: [{ id, name, args }] } });
  await expect.poll(async () => (await getLiveSends(page))
    .filter(({ message }) => Boolean(message.toolResponse)).length).toBe(responses + 1);
}

test("Q3-A scripted Q3-fixture session produces evidence that passes every applicable hard assertion", async ({ page }, testInfo) => {
  await installFakeLive(page, { lessonFixture: PLC_Q3_FIXTURE });
  await openLessonAndStart(page);
  const evidence = await startEvidence(page, "q3a-plc-fixture-session");
  const start = evidence.observe("start", await readTestState(page));
  expect(start.snapshot.coverage).toEqual({
    "what-is-a-plc": "teaching", "plc-scan-cycle": "not-started", "plc-history": "not-started", "plc-io-modules": "not-started",
  });

  // Beat 1 drains naturally; beat 2 auto-chains and is interrupted mid-output.
  await deliverBeat(page, "PLC means programmable logic controller.");
  await deliverLive(page, { serverContent: { modelTurn: { parts: [{
    inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(96_000).toString("base64") },
  }] }, outputTranscription: { text: "PLCs coordinate" } } });
  await expect.poll(() => eventCount(page, "tutor.audio-started")).toBe(2);

  const question = "Wait, what counts as an input?";
  await evidence.learnerTyped(question, { duringTutorOutput: true });
  await page.getByLabel("Type a reply").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => eventCount(page, "interruption.accepted")).toBe(1);
  await deliverLive(page, { serverContent: { interrupted: true } });
  await deliverLive(page, { serverContent: { turnComplete: true } });

  // Clarification: no canonical progress until the tutor resumes the lesson.
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: await pcmOf(page) } }] },
    outputTranscription: { text: "Inputs are signals from sensors, such as a push button." },
    generationComplete: true,
  } });
  await deliverLive(page, { serverContent: { turnComplete: true } });
  // This typed-clarification path emits canonical.resume-requested but not
  // clarification.completed; H6 closes the branch at the next teaching assignment.
  await expect.poll(() => eventCount(page, "canonical.resume-requested")).toBe(1);
  const clarified = evidence.observe("clarified", await readTestState(page));
  expect(clarified.snapshot.deliveryCursor).toBe(1);

  await sendTool(page, "resume-after-clarification", "lesson_state", { action: "query", purpose: "continue" });
  await deliverBeat(page, "PLCs coordinate industrial inputs and outputs.");
  evidence.observe("first concept taught", await readTestState(page));

  await sendTool(page, "continue-to-scan-cycle", "lesson_state", { action: "query", purpose: "continue" });
  await deliverBeat(page, "A PLC first reads the state of every input.");
  await deliverBeat(page, "It then executes its program and updates outputs, again and again.");

  const skipRequest = "Can we skip the history part?";
  await evidence.learnerTyped(skipRequest, { duringTutorOutput: false });
  await page.getByLabel("Type a reply").fill(skipRequest);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await sendTool(page, "skip-history", "lesson_state", { action: "skip", conceptId: "plc-history" });
  const skipped = evidence.observe("history skipped", await readTestState(page));
  expect(skipped.snapshot.coverage).toMatchObject({ "plc-history": "skipped", "plc-io-modules": "teaching" });

  await deliverBeat(page, "Input modules convert sensor signals into values the program can read.");
  await deliverBeat(page, "Output modules turn program decisions into signals that drive actuators.");
  const complete = evidence.observe("canonical complete", await readTestState(page));
  expect(complete.snapshot.coverage).toEqual({
    "what-is-a-plc": "taught", "plc-scan-cycle": "taught", "plc-history": "skipped", "plc-io-modules": "taught",
  });

  await deliverLive(page, { serverContent: { inputTranscription: { text: "No more questions, thanks.", finished: true } } });
  await sendTool(page, "end-lesson", "session_control", { action: "end" });
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: await pcmOf(page) } }] },
    outputTranscription: { text: "Thanks for learning with me today. Goodbye!" },
    generationComplete: true,
  } });
  await expect.poll(async () => (await readTestState(page)).snapshot.lessonActive, { timeout: 8_000 }).toBe(false);

  const packet = await evidence.finalize({ endedBy: "lesson-completed" });
  const evaluation = await expectHardEvidencePass(packet, testInfo);
  expect(statusOf(evaluation)).toEqual({
    H1: "pass", H2: "pass", H3: "pass", H4: "not-applicable", H5: "pass",
    H6: "pass", H7: "pass", H8: "pass", H10: "pass",
  });
  expect(evaluation.corePath).toMatchObject({ status: "complete", requiredCoreBeats: 6, committedCoreBeats: 6 });
  expect(packet.contract).toMatchObject({ fixtureId: "plc-q3", fixtureVersion: "1" });
  expect(packet.turns.filter(({ role }) => role === "learner").map(({ channel, text }) => `${channel}:${text}`)).toEqual([
    `typed:${question}`, `typed:${skipRequest}`, "voice-transcript:No more questions, thanks.",
  ]);
  expect(packet.audioSummary.invalidationsByReason["barge-in"]).toBe(1);
  expect(JSON.stringify(packet)).not.toContain(await pcmOf(page));

  const performance = measurePerformance(packet);
  expect(performance.gating).toBe(false);
  expect(performance.interruptionAcceptLatencyMs).toHaveLength(1);
});

test("Q3-A evidence capture refuses duplicate finalization", async ({ page }) => {
  await installFakeLive(page, { lessonFixture: PLC_Q3_FIXTURE });
  await openLessonAndStart(page);
  const evidence = await startEvidence(page, "q3a-duplicate-finalization");

  await evidence.finalize({ endedBy: "open" });

  await expect(evidence.finalize({ endedBy: "open" })).rejects.toThrow(/already finalized/i);
});

test("Q3-A evidence capture refuses to start after live canonical progress moves", async ({ page }) => {
  await installFakeLive(page, { lessonFixture: PLC_Q3_FIXTURE });
  await openLessonAndStart(page);
  await deliverBeat(page, "PLC means programmable logic controller.");

  await expect(startEvidence(page, "q3a-late-capture"))
    .rejects.toThrow(/before canonical progress/i);
});

test("Q3-A finalized evidence is one immutable artifact and rejects further capture", async ({ page }) => {
  await installFakeLive(page, { lessonFixture: PLC_Q3_FIXTURE });
  await openLessonAndStart(page);
  const evidence = await startEvidence(page, "q3a-finalize-once");
  evidence.observe("before finalize", await readTestState(page));

  const packet = await evidence.finalize({ endedBy: "open" });
  const serialized = JSON.stringify(packet);
  const { packetId, packetHash } = packet;
  expect(packet.snapshots.filter(({ label }) => label === "finalize")).toHaveLength(1);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await expect(evidence.finalize({ endedBy: "open" })).rejects.toThrow(/already finalized/i);
    await expect(evidence.finalize({ endedBy: "lesson-completed" })).rejects.toThrow(/already finalized/i);
  }
  const state = await readTestState(page);
  expect(() => evidence.observe("late", state)).toThrow(/already finalized/i);
  await expect(evidence.snapshot("late")).rejects.toThrow(/already finalized/i);
  await expect(evidence.learnerTyped("late", { duringTutorOutput: false })).rejects.toThrow(/already finalized/i);
  await expect(evidence.stopRequested()).rejects.toThrow(/already finalized/i);

  expect(JSON.stringify(packet)).toBe(serialized);
  expect(packet.packetId).toBe(packetId);
  expect(packet.packetHash).toBe(packetHash);
  expect(verifyPacketHash(packet)).toBe(true);
  expect(Object.isFrozen(packet.snapshots)).toBe(true);
  expect(evaluateHardAssertions(packet).verdict).toBe("inconclusive");

  // Concurrent finalize calls on a fresh capture still produce exactly one packet.
  const concurrent = await startEvidence(page, "q3a-finalize-concurrent");
  const settled = await Promise.allSettled([
    concurrent.finalize({ endedBy: "open" }),
    concurrent.finalize({ endedBy: "open" }),
  ]);
  expect(settled.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
});

test.describe("Q3-A live capture boundary", () => {
  type Saved = { lessonState: { currentNodeId: string; nodes: Record<string, { status: string }>;
    teachingContractProgress: Record<string, { nextTeachingPointIndex: number }> } };
  const lateCapture = /Evidence must start before canonical progress diverges/;

  test("refuses when live coverage advances while persistence is held at the seed", async ({ page }) => {
    await installFakeLive(page, { lessonFixture: PLC_Q3_FIXTURE });
    await openLessonAndStart(page);
    await holdSavedLessonWrites(page);
    await sendTool(page, "skip-history-early", "lesson_state", { action: "skip", conceptId: "plc-history" });
    expect((await readTestState(page)).snapshot.coverage).toMatchObject({ "plc-history": "skipped" });

    await expect(startEvidence(page, "q3a-late-coverage")).rejects.toThrow(lateCapture);
    await releaseSavedLessonWrites(page);
  });

  test("refuses when the live current concept changes while persistence is held at the seed", async ({ page }) => {
    await installFakeLive(page, { lessonFixture: PLC_Q3_FIXTURE });
    await openLessonAndStart(page);
    await holdSavedLessonWrites(page);
    await sendTool(page, "jump-ahead", "lesson_state", { action: "navigate", conceptId: "plc-scan-cycle" });
    expect((await readTestState(page)).snapshot.currentNodeId).toBe("plc-scan-cycle");

    await expect(startEvidence(page, "q3a-late-concept")).rejects.toThrow(lateCapture);
    await releaseSavedLessonWrites(page);
  });

  test("still refuses once persisted progress has caught up", async ({ page }) => {
    await installFakeLive(page, { lessonFixture: PLC_Q3_FIXTURE });
    await openLessonAndStart(page);
    await deliverBeat(page, "PLC means programmable logic controller.");
    await expect.poll(async () => (await readSavedLesson<Saved>(page))?.lessonState
      .teachingContractProgress["what-is-a-plc"].nextTeachingPointIndex, { timeout: 10_000 }).toBe(1);

    await expect(startEvidence(page, "q3a-late-persisted")).rejects.toThrow(lateCapture);
  });

  test("refuses when persisted coverage moved but the live runtime still matches the seed", async ({ page }) => {
    await installFakeLive(page, { lessonFixture: PLC_Q3_FIXTURE });
    await openLessonAndStart(page);
    const saved = await readSavedLesson<Saved>(page);
    expect(saved).toBeDefined();
    saved!.lessonState.nodes["plc-history"].status = "skipped";
    await page.evaluate((lesson) => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("ai-dialog-tutor", 2);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const put = db.transaction("savedLessons", "readwrite").objectStore("savedLessons").put(lesson);
        put.onerror = () => { db.close(); reject(put.error); };
        put.onsuccess = () => { db.close(); resolve(); };
      };
    }), saved);
    expect((await readTestState(page)).snapshot.coverage).toMatchObject({ "plc-history": "not-started" });
    expect((await readSavedLesson<Saved>(page))!.lessonState.nodes["plc-history"].status).toBe("skipped");

    await expect(startEvidence(page, "q3a-persisted-coverage-ahead")).rejects.toThrow(lateCapture);
  });

  test("starts during transient noncanonical activity with unchanged canonical progress", async ({ page }) => {
    await installFakeLive(page, { lessonFixture: PLC_Q3_FIXTURE });
    await openLessonAndStart(page);
    await deliverLive(page, { serverContent: { modelTurn: { parts: [{
      inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(96_000).toString("base64") },
    }] }, outputTranscription: { text: "PLC means" } } });
    await page.getByLabel("Type a reply").fill("Wait, say that again?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(async () => (await readTestState(page)).events
      .some(({ name }) => name === "interruption.accepted")).toBe(true);

    const evidence = await startEvidence(page, "q3a-start-after-interruption");
    const packet = await evidence.finalize({ endedBy: "open" });
    expect(evaluateHardAssertions(packet).assertions.filter(({ status }) => status === "fail")).toEqual([]);
  });
});
