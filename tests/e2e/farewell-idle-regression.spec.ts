import { expect, test, type Page } from "@playwright/test";
import {
  deliverLive, getLiveSends, installFakeLive, openLessonAndStart,
  readTestState, textOf,
} from "../helpers/fake-live";
import { expectHardEvidencePass, startEvidence, statusOf } from "../helpers/evidence-recorder";

function canonicalProgress(snapshot: Record<string, unknown>) {
  return {
    currentNodeId: snapshot.currentNodeId,
    deliveryCursor: snapshot.deliveryCursor,
    coverage: snapshot.coverage,
    interruptionCount: snapshot.interruptionCount,
  };
}

async function sendSessionControl(page: Page, id: string, action: string) {
  const count = (await getLiveSends(page)).filter(({ message }) => message.toolResponse).length;
  await deliverLive(page, {
    toolCall: { functionCalls: [{ id, name: "session_control", args: { action } }] },
  });
  await expect.poll(async () =>
    (await getLiveSends(page)).filter(({ message }) => message.toolResponse).length,
  ).toBe(count + 1);
  return (await getLiveSends(page)).filter(({ message }) => message.toolResponse).at(-1)!.message;
}

async function sendLessonContinue(page: Page, id: string) {
  const count = (await getLiveSends(page)).filter(({ message }) => message.toolResponse).length;
  await deliverLive(page, {
    toolCall: { functionCalls: [{ id, name: "lesson_state", args: { action: "query", purpose: "continue" } }] },
  });
  await expect.poll(async () =>
    (await getLiveSends(page)).filter(({ message }) => message.toolResponse).length,
  ).toBe(count + 1);
  return (await getLiveSends(page)).filter(({ message }) => message.toolResponse).at(-1)!.message;
}

function teachingImperatives(items: Awaited<ReturnType<typeof getLiveSends>>) {
  return items.filter(({ message }) => Boolean(message.realtimeInput) &&
    textOf(message).includes("APP_CONTROL:TEACH_PRESENTATION_BEAT"));
}

async function enterWrapUp(page: Page) {
  await installFakeLive(page, { completed: true });
  await openLessonAndStart(page, true);

  const state = await readTestState(page);
  expect(state.snapshot.coverage).toEqual({ "what-is-a-plc": "taught" });
  expect(state.snapshot.deliveryCursor).toBe(2);
  return state.snapshot;
}

async function requestIdleConfirmation(page: Page) {
  const sendsBefore = (await getLiveSends(page)).length;
  await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".debug-session-controls button")]
      .find((candidate) => candidate.textContent?.trim() === "Test idle confirmation");
    if (!button) throw new Error("Idle-confirmation test control is unavailable");
    button.click();
  });
  await expect.poll(async () => (await getLiveSends(page)).slice(sendsBefore).some(({ message }) =>
    (message.realtimeInput as { text?: string } | undefined)?.text === "[[APP_CONTROL:IDLE_CONFIRMATION]]",
  )).toBe(true);
}

test("wrap-up end starts farewell without changing canonical progress or stopping early", async ({ page }) => {
  const before = await enterWrapUp(page);
  const response = await sendSessionControl(page, "end-wrap-up", "end");

  expect(response.toolResponse).toBeDefined();
  expect(canonicalProgress((await readTestState(page)).snapshot)).toEqual(canonicalProgress(before));
  expect((await readTestState(page)).snapshot.lessonActive).toBe(true);
  await expect(page.getByText("Finishing lesson…")).toBeVisible();

  await page.waitForTimeout(300);
  expect((await readTestState(page)).snapshot.lessonActive).toBe(true);
});

test("zero-audio farewell generationComplete finishes only after the completion sequence", async ({ page }) => {
  await enterWrapUp(page);
  await sendSessionControl(page, "end-wrap-up-zero-audio", "end");

  await deliverLive(page, { serverContent: { generationComplete: true } });
  expect((await readTestState(page)).snapshot.lessonActive).toBe(true);
  await expect(page.getByText("Lesson complete")).toBeVisible();
  await expect.poll(async () => (await readTestState(page)).snapshot.lessonActive, { timeout: 5_000 }).toBe(false);
});

test("idle continue keeps the lesson active", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  await requestIdleConfirmation(page);

  const accepted = await sendSessionControl(page, "idle-continue", "continue");
  expect(accepted.toolResponse).toBeDefined();
  expect((await readTestState(page)).snapshot.lessonActive).toBe(true);

});

test("idle end follows the existing confirmed-stop behavior", async ({ page }, testInfo) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  const evidence = await startEvidence(page, "q2-idle-confirmed-end");
  await requestIdleConfirmation(page);

  await sendSessionControl(page, "idle-end", "end");
  await expect.poll(async () => (await readTestState(page)).snapshot.lessonActive).toBe(false);

  // Early end is attributed to the observable idle confirmation and end decision.
  const packet = await evidence.finalize({ endedBy: "lesson-completed" });
  const evaluation = await expectHardEvidencePass(packet, testInfo);
  expect(statusOf(evaluation)).toMatchObject({ H5: "pass", H7: "pass" });
  const completion = packet.events.find(({ name }) => name === "lesson.completed")!;
  expect(completion.detail).toMatchObject({ reason: "confirmed", planComplete: false });
  const before = packet.events.filter(({ seq }) => seq < completion.seq);
  expect(before.findLast(({ name }) => name === "engagement.changed")?.detail).toEqual({ state: "confirming" });
  expect(before.some(({ name, detail }) => name === "tool.decision" && detail?.outcome === "confirm-end")).toBe(true);
});

test("unclear idle response preserves confirmation until a later clear end", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  await requestIdleConfirmation(page);

  await sendSessionControl(page, "idle-unclear", "unclear");
  expect((await readTestState(page)).snapshot.lessonActive).toBe(true);

  await sendSessionControl(page, "idle-end-after-unclear", "end");
  await expect.poll(async () => (await readTestState(page)).snapshot.lessonActive).toBe(false);
});

test("meaningful learner speech during idle confirmation remains active when continue is confirmed", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  await requestIdleConfirmation(page);

  await deliverLive(page, { serverContent: {
    inputTranscription: { text: "Yes, please continue the lesson.", finished: true },
    turnComplete: true,
  } });
  await sendSessionControl(page, "idle-spoken-continue", "continue");

  const state = await readTestState(page);
  expect(state.snapshot.lessonActive).toBe(true);
  expect(state.snapshot.latestTranscriptRole).toBe("learner");
});

test("Q2-E idle confirmation learner return resumes the correct next canonical beat once", async ({ page }) => {
  await installFakeLive(page, { additionalConcept: true });
  await openLessonAndStart(page);
  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);

  for (const transcript of [
    "A PLC means programmable logic controller.",
    "PLCs coordinate industrial inputs and outputs.",
  ]) {
    await deliverLive(page, { serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
      outputTranscription: { text: transcript },
      generationComplete: true,
    } });
    await expect.poll(async () => (await readTestState(page)).events.filter((event) =>
      event.name === "beat.commit" && event.detail?.mode === "lesson").length)
      .toBe(transcript.startsWith("A PLC means") ? 1 : 2);
  }

  const beforeIdle = await readTestState(page);
  expect(beforeIdle.snapshot.currentNodeId).toBe("what-is-a-plc");
  expect(beforeIdle.snapshot.deliveryCursor).toBe(2);
  expect(beforeIdle.snapshot.coverage).toEqual({
    "what-is-a-plc": "taught",
    "plc-scan-cycle": "not-started",
  });
  expect(beforeIdle.snapshot.activePresentationBeat).toBeNull();
  expect(beforeIdle.events.filter((event) => event.name === "beat.commit")).toHaveLength(2);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(2);

  await requestIdleConfirmation(page);
  const engagementValue = page.locator(".engineering-state dt", { hasText: "Engagement" })
    .locator("..").locator("dd");
  await expect(engagementValue).toHaveText("confirming");
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "Are you still there and would you like to continue?" },
    generationComplete: true,
  } });
  await deliverLive(page, { serverContent: { turnComplete: true } });

  const afterPrompt = await readTestState(page);
  expect(canonicalProgress(afterPrompt.snapshot)).toEqual(canonicalProgress(beforeIdle.snapshot));
  expect(afterPrompt.events.filter((event) => event.name === "beat.commit")).toHaveLength(2);
  expect(afterPrompt.snapshot.activePresentationBeat).toBeNull();

  await deliverLive(page, { serverContent: {
    inputTranscription: { text: "Yes, continue.", finished: true },
  } });
  await sendSessionControl(page, "q2-e-idle-continue", "continue");
  await expect(engagementValue).toHaveText("active");

  const continuationResponse = await sendLessonContinue(page, "q2-e-lesson-continue");
  const resumed = await readTestState(page);
  expect(resumed.snapshot.currentNodeId).toBe("plc-scan-cycle");
  expect(resumed.snapshot.deliveryCursor).toBe(0);
  expect(resumed.snapshot.coverage).toEqual({
    "what-is-a-plc": "taught",
    "plc-scan-cycle": "teaching",
  });
  expect(resumed.snapshot.activePresentationBeat).toMatchObject({
    index: 0,
    teachingPointIndexes: [0],
    mode: "lesson",
  });
  expect(resumed.events.filter((event) => event.name === "beat.commit")).toHaveLength(2);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(2);
  expect(textOf(continuationResponse)).toContain("A PLC repeatedly reads inputs, executes logic, and updates outputs.");
  expect(textOf(continuationResponse)).toContain("APP_CONTROL:TEACH_PRESENTATION_BEAT");
  expect(resumed.snapshot.lessonActive).toBe(true);

  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "A PLC repeatedly reads inputs, executes logic, and updates outputs." },
    generationComplete: true,
  } });
  await expect.poll(async () => (await readTestState(page)).events.filter((event) =>
    event.name === "beat.commit" && event.detail?.mode === "lesson").length).toBe(3);

  const completed = await readTestState(page);
  expect(completed.snapshot.currentNodeId).toBe("plc-scan-cycle");
  expect(completed.snapshot.deliveryCursor).toBe(1);
  expect(completed.snapshot.coverage).toEqual({
    "what-is-a-plc": "taught",
    "plc-scan-cycle": "taught",
  });
  expect(completed.events.filter((event) => event.name === "beat.commit")).toHaveLength(3);
  expect(completed.snapshot.lessonActive).toBe(true);
});

test("Q2-H final canonical completion waits for one naturally drained farewell before stopping", async ({ page }, testInfo) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  const evidence = await startEvidence(page, "q2-h-final-farewell");
  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);

  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "A PLC means programmable logic controller." },
    generationComplete: true,
  } });
  await expect.poll(async () => (await readTestState(page)).snapshot.deliveryCursor).toBe(1);

  const beforeFinalBeat = evidence.observe("before final beat", await readTestState(page));
  expect(beforeFinalBeat.snapshot.currentNodeId).toBe("what-is-a-plc");
  expect(beforeFinalBeat.snapshot.deliveryCursor).toBe(1);
  expect(beforeFinalBeat.snapshot.coverage).toEqual({ "what-is-a-plc": "teaching" });
  expect(beforeFinalBeat.snapshot.activePresentationBeat).toMatchObject({
    index: 1,
    teachingPointIndexes: [1],
    mode: "lesson",
  });
  expect(beforeFinalBeat.events.filter((event) => event.name === "beat.commit")).toHaveLength(1);

  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "PLCs coordinate industrial inputs and outputs." },
    generationComplete: true,
  } });
  await expect.poll(async () => (await readTestState(page)).snapshot.deliveryCursor).toBe(2);

  const canonicalComplete = evidence.observe("canonical complete", await readTestState(page));
  expect(canonicalComplete.snapshot.coverage).toEqual({ "what-is-a-plc": "taught" });
  expect(canonicalComplete.snapshot.activePresentationBeat).toBeNull();
  expect(canonicalComplete.snapshot.lessonActive).toBe(true);
  expect(canonicalComplete.snapshot.tutorAudioPlaying).toBe(false);
  expect(canonicalComplete.events.filter((event) => event.name === "beat.commit")).toHaveLength(2);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(2);
  const audioStartsBeforeFarewell = canonicalComplete.events
    .filter((event) => event.name === "tutor.audio-started").length;

  await deliverLive(page, { serverContent: {
    inputTranscription: { text: "No more questions, thanks.", finished: true },
  } });
  const farewellResponse = await sendSessionControl(page, "q2-h-end", "end");
  expect(textOf(farewellResponse)).toContain("exactly one brief, warm, natural closing sentence");
  await expect(page.getByText("Finishing lesson…")).toBeVisible();

  const farewellPcm = Buffer.alloc(48_000).toString("base64");
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: farewellPcm } }] },
    outputTranscription: { text: "Thanks for learning with me today. Goodbye!" },
    generationComplete: true,
  } });

  const generationCompleteBeforeDrain = await readTestState(page);
  expect(generationCompleteBeforeDrain.snapshot.lessonActive).toBe(true);
  expect(generationCompleteBeforeDrain.snapshot.tutorAudioPlaying).toBe(true);
  expect(generationCompleteBeforeDrain.snapshot.deliveryCursor).toBe(2);
  expect(generationCompleteBeforeDrain.snapshot.coverage).toEqual({ "what-is-a-plc": "taught" });
  expect(generationCompleteBeforeDrain.snapshot.activePresentationBeat).toBeNull();
  expect(generationCompleteBeforeDrain.events.filter((event) => event.name === "beat.commit")).toHaveLength(2);
  expect(generationCompleteBeforeDrain.events.filter((event) => event.name === "tutor.audio-started"))
    .toHaveLength(audioStartsBeforeFarewell + 1);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(2);
  await expect(page.getByText("Lesson complete")).toHaveCount(0);

  await expect(page.getByText("Lesson complete")).toBeVisible();
  const afterNaturalDrain = await readTestState(page);
  expect(afterNaturalDrain.snapshot.lessonActive).toBe(true);
  expect(afterNaturalDrain.snapshot.tutorAudioPlaying).toBe(false);
  expect(afterNaturalDrain.snapshot.deliveryCursor).toBe(2);
  expect(afterNaturalDrain.snapshot.coverage).toEqual({ "what-is-a-plc": "taught" });
  expect(afterNaturalDrain.events.filter((event) => event.name === "beat.commit")).toHaveLength(2);
  expect(page.getByText("Lesson complete")).toHaveCount(1);

  await expect.poll(async () => (await readTestState(page)).snapshot.lessonActive, { timeout: 5_000 }).toBe(false);
  const stopped = evidence.observe("stopped", await readTestState(page));
  expect(stopped.snapshot.deliveryCursor).toBe(2);
  expect(stopped.snapshot.coverage).toEqual({ "what-is-a-plc": "taught" });
  expect(stopped.snapshot.activePresentationBeat).toBeNull();
  expect(stopped.snapshot.tutorAudioPlaying).toBe(false);
  expect(stopped.events.filter((event) => event.name === "beat.commit")).toHaveLength(2);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(2);
  expect((await getLiveSends(page)).filter(({ message }) => Boolean(message.toolResponse))).toHaveLength(1);

  const evaluation = await expectHardEvidencePass(await evidence.finalize({ endedBy: "lesson-completed" }), testInfo);
  expect(statusOf(evaluation)).toMatchObject({ H1: "pass", H2: "pass", H3: "pass", H5: "pass", H7: "pass", H10: "pass" });
  expect(evaluation.corePath).toMatchObject({ status: "complete", requiredCoreBeats: 2, committedCoreBeats: 2 });
});
