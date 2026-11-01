import { expect, test } from "@playwright/test";
import {
  deliverLive, failActiveSocket, getLiveSends, installFakeLive,
  openLessonAndStart, readTestState, textOf,
} from "../helpers/fake-live";

const teachingImperatives = (items: Awaited<ReturnType<typeof getLiveSends>>) =>
  items.filter(({ message }) => Boolean(message.realtimeInput) && textOf(message).includes("APP_CONTROL:TEACH_PRESENTATION_BEAT"));

test("startup seeds authoritative history before exactly one proactive teaching imperative", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);

  const sends = await getLiveSends(page);
  const seedIndex = sends.findIndex(({ message }) => Boolean(message.clientContent) && textOf(message).includes("INITIAL_LESSON_COVERAGE"));
  const imperativeIndexes = sends.flatMap(({ message }, index) =>
    message.realtimeInput && textOf(message).includes("APP_CONTROL:TEACH_PRESENTATION_BEAT") ? [index] : []);
  expect(seedIndex).toBeGreaterThan(-1);
  expect(imperativeIndexes).toHaveLength(1);
  expect(seedIndex).toBeLessThan(imperativeIndexes[0]);
});

test("persisted resume seeds first and sends exactly one resume teaching imperative", async ({ page }) => {
  await installFakeLive(page, { persisted: true });
  await openLessonAndStart(page, true);

  const sends = await getLiveSends(page);
  const seedIndex = sends.findIndex(({ message }) => Boolean(message.clientContent) && textOf(message).includes("RECOVERED_APPLICATION_CONTEXT"));
  const imperatives = teachingImperatives(sends);
  expect(seedIndex).toBeGreaterThan(-1);
  expect(imperatives).toHaveLength(1);
  expect(seedIndex).toBeLessThan(sends.indexOf(imperatives[0]));
  expect(textOf(imperatives[0].message)).toContain("PERSISTED_LESSON_RESUME");
});

test("fresh-socket recovery sends history only and does not duplicate a teaching imperative", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(1);

  await failActiveSocket(page);
  await expect.poll(async () => Math.max(...(await getLiveSends(page)).map((item) => item.socketId))).toBe(1);
  await expect.poll(async () => (await getLiveSends(page)).filter(({ socketId, message }) =>
    socketId === 1 && Boolean(message.clientContent) && textOf(message).includes("RECOVERED_APPLICATION_CONTEXT")).length).toBe(1);

  const replacement = (await getLiveSends(page)).filter(({ socketId }) => socketId === 1);
  expect(replacement.filter(({ message }) => Boolean(message.clientContent))).toHaveLength(1);
  expect(teachingImperatives(replacement)).toHaveLength(0);
  expect(replacement.some(({ message }) => {
    const input = message.realtimeInput as { text?: string } | undefined;
    return Boolean(input?.text);
  })).toBe(false);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(1);
});

test("Q2-G transport recovery preserves canonical state and resumes the unconfirmed beat once", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
  const beforeFailure = await readTestState(page);
  const originalBeat = beforeFailure.snapshot.activePresentationBeat;
  expect(originalBeat).toMatchObject({ index: 0, teachingPointIndexes: [0], mode: "lesson" });
  expect(beforeFailure.snapshot.deliveryCursor).toBe(0);
  expect((beforeFailure.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(beforeFailure.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(1);

  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "A PLC is a rugged industrial computer." },
  } }, 0);
  await expect.poll(async () => (await readTestState(page)).snapshot.tutorAudioPlaying).toBe(true);
  await failActiveSocket(page);

  await expect.poll(async () => Math.max(...(await getLiveSends(page)).map(({ socketId }) => socketId))).toBe(1);
  await expect.poll(async () => (await getLiveSends(page)).filter(({ socketId, message }) =>
    socketId === 1 && Boolean(message.clientContent) &&
    textOf(message).includes("RECOVERED_APPLICATION_CONTEXT")).length).toBe(1);

  const recoverySends = (await getLiveSends(page)).filter(({ socketId }) => socketId === 1);
  expect(recoverySends.filter(({ message }) => Boolean(message.clientContent) &&
    textOf(message).includes("RECOVERED_APPLICATION_CONTEXT"))).toHaveLength(1);
  expect(teachingImperatives(recoverySends)).toHaveLength(0);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(1);

  const recovered = await readTestState(page);
  expect(recovered.snapshot.lessonActive).toBe(true);
  expect(recovered.snapshot.deliveryCursor).toBe(0);
  expect((recovered.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(recovered.snapshot.activePresentationBeat).toBeNull();
  expect(recovered.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);
  const audioStartsAfterRecovery = recovered.events.filter((event) => event.name === "tutor.audio-started").length;

  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "Stale socket output." },
    generationComplete: true,
  } }, 0);
  const afterStaleSocket = await readTestState(page);
  expect(afterStaleSocket.snapshot.deliveryCursor).toBe(0);
  expect(afterStaleSocket.snapshot.activePresentationBeat).toBeNull();
  expect(afterStaleSocket.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);
  expect(afterStaleSocket.events.filter((event) => event.name === "tutor.audio-started")).toHaveLength(audioStartsAfterRecovery);

  await deliverLive(page, { serverContent: {
    inputTranscription: { text: "Continue with the lesson.", finished: true },
  } }, 1);
  await deliverLive(page, { toolCall: { functionCalls: [{
    id: "continue-after-recovery",
    name: "lesson_state",
    args: { action: "query", purpose: "continue" },
  }] } }, 1);
  await expect.poll(async () => (await getLiveSends(page))
    .filter(({ message }) => Boolean(message.toolResponse)).length).toBe(1);

  const resumed = await readTestState(page);
  expect(resumed.snapshot.activePresentationBeat).toEqual(originalBeat);
  expect(resumed.snapshot.deliveryCursor).toBe(0);
  expect((resumed.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(resumed.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(1);
  const continueResponse = (await getLiveSends(page)).find(({ message }) => Boolean(message.toolResponse));
  expect(textOf(continueResponse!.message)).toContain("PLC means programmable logic controller");
  expect(textOf(continueResponse!.message)).toContain("APP_CONTROL:TEACH_PRESENTATION_BEAT");

  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "A PLC means programmable logic controller." },
    generationComplete: true,
  } }, 1);
  await expect.poll(async () => (await readTestState(page)).snapshot.deliveryCursor).toBe(1);

  const completed = await readTestState(page);
  expect(completed.events.filter((event) => event.name === "beat.commit")).toHaveLength(1);
  expect(completed.events.filter((event) => event.name === "beat.commit")[0]).toMatchObject({
    detail: { mode: "lesson", conceptId: "what-is-a-plc", nextIndex: 1 },
  });
  expect(completed.snapshot.deliveryCursor).toBe(1);
  expect((completed.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(completed.snapshot.activePresentationBeat).toMatchObject({ index: 1, mode: "lesson" });
  expect(completed.snapshot.lessonActive).toBe(true);
});

test("Q2-A clarification preserves progress and continue restarts then commits the same beat once", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  const initialImperative = teachingImperatives(await getLiveSends(page))[0];
  const initialState = await readTestState(page);
  expect(initialState.snapshot.activePresentationBeat).toMatchObject({
    index: 0,
    teachingPointIndexes: [0],
    mode: "lesson",
  });
  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
  await deliverLive(page, { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] }, outputTranscription: { text: "A PLC is a rugged industrial computer." } } });
  await deliverLive(page, { voiceActivity: { voiceActivityType: "ACTIVITY_START" }, serverContent: { interrupted: true } });
  const interrupted = await readTestState(page);
  expect(interrupted.events.map((event) => event.name)).toContain("interruption.accepted");
  expect(interrupted.events.map((event) => event.name)).toContain("audio.epoch-invalidated");
  expect(interrupted.snapshot.deliveryCursor).toBe(0);
  expect((interrupted.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(interrupted.events.map((event) => event.name)).not.toContain("beat.commit");
  await deliverLive(page, { serverContent: { inputTranscription: { text: "What exactly does rugged mean?", finished: true }, turnComplete: true } });
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "It means designed for harsh industrial conditions." },
  } });
  await deliverLive(page, { serverContent: { generationComplete: true } });

  const afterClarification = await readTestState(page);
  expect(afterClarification.snapshot.deliveryCursor).toBe(0);
  expect((afterClarification.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(afterClarification.events.map((event) => event.name)).not.toContain("beat.commit");

  await deliverLive(page, { toolCall: { functionCalls: [{ id: "continue-1", name: "lesson_state", args: { action: "query", purpose: "continue" } }] } });
  await expect.poll(async () => (await getLiveSends(page)).filter(({ message }) => Boolean(message.toolResponse)).length).toBe(1);
  const toolResponse = (await getLiveSends(page)).find(({ message }) => Boolean(message.toolResponse));
  expect(toolResponse).toBeDefined();
  expect(textOf(toolResponse!.message)).toContain("teachingAssignment");
  expect(textOf(toolResponse!.message)).toContain("PLC means programmable logic controller");
  expect(textOf(toolResponse!.message)).toContain("ASSIGNED_TEACHING_POINTS");
  expect(textOf(toolResponse!.message)).toContain('\\"index\\":0');
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(1);
  expect(textOf(toolResponse!.message)).toContain("APP_CONTROL:TEACH_PRESENTATION_BEAT");
  expect(textOf(initialImperative.message)).toContain("APP_CONTROL:TEACH_PRESENTATION_BEAT");

  const afterContinue = await readTestState(page);
  expect(afterContinue.snapshot.deliveryCursor).toBe(0);
  expect(afterContinue.snapshot.activePresentationBeat).toEqual(initialState.snapshot.activePresentationBeat);
  expect((afterContinue.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(afterContinue.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);

  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "A PLC means programmable logic controller." },
  } });
  await deliverLive(page, { serverContent: { generationComplete: true } });

  const beforeResumedBeatDrain = await readTestState(page);
  expect(beforeResumedBeatDrain.snapshot.deliveryCursor).toBe(0);
  expect(beforeResumedBeatDrain.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);
  await expect.poll(async () => (await readTestState(page)).snapshot.deliveryCursor).toBe(1);

  const completed = await readTestState(page);
  expect(completed.events.filter((event) => event.name === "beat.commit")).toHaveLength(1);
  expect(completed.events.filter((event) => event.name === "beat.commit")[0]).toMatchObject({
    detail: { mode: "lesson", conceptId: "what-is-a-plc", nextIndex: 1 },
  });
  expect(completed.snapshot.deliveryCursor).toBe(1);
  expect((completed.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(completed.snapshot.activePresentationBeat).toMatchObject({ index: 1, mode: "lesson" });
  expect(completed.snapshot.lessonActive).toBe(true);
});

test("Q2-B confused learner response preserves canonical progress until explicit continue", async ({ page }) => {
  await installFakeLive(page, { additionalConcept: true });
  await openLessonAndStart(page);
  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);

  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "A PLC means programmable logic controller." },
    generationComplete: true,
  } });
  await expect.poll(async () => (await readTestState(page)).snapshot.deliveryCursor).toBe(1);
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "PLCs coordinate industrial inputs and outputs." },
    generationComplete: true,
  } });
  await expect.poll(async () => (await readTestState(page)).snapshot.deliveryCursor).toBe(2);

  const atCheckIn = await readTestState(page);
  expect(atCheckIn.snapshot.currentNodeId).toBe("what-is-a-plc");
  expect(atCheckIn.snapshot.activePresentationBeat).toBeNull();
  expect((atCheckIn.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("taught");
  expect((atCheckIn.snapshot.coverage as Record<string, string>)["plc-scan-cycle"]).toBe("not-started");
  expect(atCheckIn.events.filter((event) => event.name === "beat.commit")).toHaveLength(2);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(2);

  await deliverLive(page, { serverContent: {
    inputTranscription: { text: "I don't understand.", finished: true },
    turnComplete: true,
  } });
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "A PLC is a rugged computer that controls machines." },
    generationComplete: true,
  } });

  const afterClarification = await readTestState(page);
  expect(afterClarification.snapshot.currentNodeId).toBe("what-is-a-plc");
  expect(afterClarification.snapshot.deliveryCursor).toBe(2);
  expect(afterClarification.snapshot.coverage).toEqual(atCheckIn.snapshot.coverage);
  expect(afterClarification.snapshot.activePresentationBeat).toBeNull();
  expect(afterClarification.snapshot.lessonActive).toBe(true);
  expect(afterClarification.events.filter((event) => event.name === "beat.commit")).toHaveLength(2);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(2);

  await deliverLive(page, { toolCall: { functionCalls: [{
    id: "continue-after-confusion",
    name: "lesson_state",
    args: { action: "query", purpose: "continue" },
  }] } });
  await expect.poll(async () => (await getLiveSends(page))
    .filter(({ message }) => Boolean(message.toolResponse)).length).toBe(1);

  const continued = await readTestState(page);
  expect(continued.snapshot.currentNodeId).toBe("plc-scan-cycle");
  expect(continued.snapshot.deliveryCursor).toBe(0);
  expect(continued.snapshot.activePresentationBeat).toMatchObject({
    index: 0,
    teachingPointIndexes: [0],
    mode: "lesson",
  });
  expect(continued.events.filter((event) => event.name === "beat.commit")).toHaveLength(2);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(2);
  const continueResponse = (await getLiveSends(page)).find(({ message }) => Boolean(message.toolResponse));
  expect(textOf(continueResponse!.message)).toContain("A PLC repeatedly reads inputs, executes logic, and updates outputs.");
  expect(textOf(continueResponse!.message)).toContain("APP_CONTROL:TEACH_PRESENTATION_BEAT");
});

test("Q2-F rapid double interruption follows the latest clarification then resumes the original beat once", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
  const original = await readTestState(page);
  const originalBeat = original.snapshot.activePresentationBeat;
  expect(originalBeat).toMatchObject({ index: 0, teachingPointIndexes: [0], mode: "lesson" });
  expect(original.snapshot.deliveryCursor).toBe(0);

  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "A PLC is a rugged industrial computer." },
  } });
  await page.getByLabel("Type a reply").fill("Wait, what does that mean?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await readTestState(page)).snapshot.interruptionCount).toBe(1);
  const afterFirstInterruption = await readTestState(page);
  expect(afterFirstInterruption.snapshot.interruptionCount).toBe(1);
  expect(afterFirstInterruption.snapshot.deliveryCursor).toBe(0);
  expect(afterFirstInterruption.snapshot.activePresentationBeat).toBeNull();
  expect(afterFirstInterruption.events.filter((event) => event.name === "interruption.accepted")).toHaveLength(1);
  expect(afterFirstInterruption.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);

  await deliverLive(page, { serverContent: { interrupted: true } });
  await deliverLive(page, { serverContent: { turnComplete: true } });
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "It means the controller is designed for harsh factory conditions." },
  } });
  const firstClarification = await readTestState(page);
  expect(firstClarification.snapshot.tutorAudioPlaying).toBe(true);
  expect(firstClarification.snapshot.deliveryCursor).toBe(0);
  expect(firstClarification.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);

  await deliverLive(page, {
    voiceActivity: { voiceActivityType: "ACTIVITY_START" },
    serverContent: { interrupted: true },
  });
  const afterSecondInterruption = await readTestState(page);
  expect(afterSecondInterruption.snapshot.interruptionCount).toBe(2);
  expect(afterSecondInterruption.snapshot.tutorAudioPlaying).toBe(false);
  expect(afterSecondInterruption.snapshot.deliveryCursor).toBe(0);
  expect((afterSecondInterruption.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(afterSecondInterruption.events.filter((event) => event.name === "interruption.accepted")).toHaveLength(2);
  expect(afterSecondInterruption.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);

  await deliverLive(page, { serverContent: {
    inputTranscription: { text: "Actually, I mean why is that important?", finished: true },
    turnComplete: true,
  } });
  await deliverLive(page, { voiceActivity: { voiceActivityType: "ACTIVITY_END" } });
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "It matters because reliable control keeps industrial machinery operating safely." },
    generationComplete: true,
  } });
  await deliverLive(page, { serverContent: { turnComplete: true } });

  const afterSecondClarification = await readTestState(page);
  expect(afterSecondClarification.snapshot.deliveryCursor).toBe(0);
  expect((afterSecondClarification.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(afterSecondClarification.snapshot.activePresentationBeat).toBeNull();
  expect(afterSecondClarification.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);
  const visibleConversation = page.locator(".conversation-transcript-body");
  await expect(visibleConversation).toContainText("Actually, I mean why is that important?");
  await expect(visibleConversation).toContainText("It matters because reliable control keeps industrial machinery operating safely.");
  await expect(visibleConversation).not.toContainText("designed for harsh factory conditions");

  await deliverLive(page, { serverContent: {
    inputTranscription: { text: "Okay, continue.", finished: true },
  } });
  await deliverLive(page, { toolCall: { functionCalls: [{
    id: "continue-after-double-interruption",
    name: "lesson_state",
    args: { action: "query", purpose: "continue" },
  }] } });
  await expect.poll(async () => (await getLiveSends(page))
    .filter(({ message }) => Boolean(message.toolResponse)).length).toBe(1);

  const resumed = await readTestState(page);
  expect(resumed.snapshot.activePresentationBeat).toEqual(originalBeat);
  expect(resumed.snapshot.deliveryCursor).toBe(0);
  expect((resumed.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(resumed.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);
  const continueResponse = (await getLiveSends(page)).find(({ message }) => Boolean(message.toolResponse));
  expect(textOf(continueResponse!.message)).toContain("PLC means programmable logic controller");
  expect(textOf(continueResponse!.message)).toContain("APP_CONTROL:TEACH_PRESENTATION_BEAT");

  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "A PLC means programmable logic controller." },
    generationComplete: true,
  } });
  await expect.poll(async () => (await readTestState(page)).snapshot.deliveryCursor).toBe(1);

  const completed = await readTestState(page);
  expect(completed.events.filter((event) => event.name === "beat.commit")).toHaveLength(1);
  expect(completed.events.filter((event) => event.name === "beat.commit")[0]).toMatchObject({
    detail: { mode: "lesson", conceptId: "what-is-a-plc", nextIndex: 1 },
  });
  expect(completed.snapshot.deliveryCursor).toBe(1);
  expect((completed.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(completed.snapshot.activePresentationBeat).toMatchObject({ index: 1, mode: "lesson" });
  expect(completed.snapshot.lessonActive).toBe(true);
});
