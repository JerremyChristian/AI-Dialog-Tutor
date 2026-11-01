import { expect, test, type Page } from "@playwright/test";
import {
  deliverLive, failActiveSocket, getLiveSends, installFakeLive,
  openLessonAndStart, readTestState, textOf,
} from "../helpers/fake-live";

const REVIEWED_NODE = "what-is-a-plc";
const CANONICAL_NODE = "plc-scan-cycle";

async function startReview(page: Page) {
  await installFakeLive(page, { persisted: true, reviewReady: true });
  await openLessonAndStart(page, true);
  const before = await readTestState(page);
  await page.locator(".lesson-roadmap").locator("summary").click();
  await page.getByRole("button", { name: "Review What is a PLC? from start" }).click();
  await expect.poll(async () => (await readTestState(page)).snapshot.reviewActive).toBe(true);
  return before.snapshot;
}

async function finishActiveBeat(page: Page, transcript: string) {
  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: transcript },
  } });
  await deliverLive(page, { serverContent: { generationComplete: true } });
}

async function sendLessonTool(page: Page, id: string, args: Record<string, unknown>) {
  const before = (await getLiveSends(page)).filter(({ message }) => Boolean(message.toolResponse)).length;
  await deliverLive(page, { toolCall: { functionCalls: [{ id, name: "lesson_state", args }] } });
  await expect.poll(async () => (await getLiveSends(page)).filter(({ message }) => Boolean(message.toolResponse)).length).toBe(before + 1);
  return (await getLiveSends(page)).filter(({ message }) => Boolean(message.toolResponse)).at(-1)!;
}

function canonicalProjection(snapshot: Record<string, unknown>) {
  return {
    currentNodeId: snapshot.currentNodeId,
    deliveryCursor: snapshot.deliveryCursor,
    coverage: snapshot.coverage,
    interruptionCount: snapshot.interruptionCount,
  };
}

test("Review starts on a completed leaf and progresses only its review cursor", async ({ page }) => {
  const before = await startReview(page);
  const started = await readTestState(page);

  expect(canonicalProjection(started.snapshot)).toEqual(canonicalProjection(before));
  expect(started.snapshot.currentNodeId).toBe(CANONICAL_NODE);
  expect(started.snapshot.activePresentationBeat).toMatchObject({ index: 0, mode: "review" });
  expect(started.events).toContainEqual(expect.objectContaining({ name: "review.started", detail: { nodeId: REVIEWED_NODE } }));

  await finishActiveBeat(page, "PLC means programmable logic controller.");
  await expect.poll(async () => (await readTestState(page)).events.filter((event) =>
    event.name === "beat.commit" && event.detail?.mode === "review").length).toBe(1);

  const progressed = await readTestState(page);
  expect(progressed.events).toContainEqual(expect.objectContaining({
    name: "beat.commit", detail: { mode: "review", conceptId: REVIEWED_NODE, nextIndex: 1 },
  }));
  expect(progressed.snapshot.activePresentationBeat).toMatchObject({ index: 1, mode: "review" });
  expect(canonicalProjection(progressed.snapshot)).toEqual(canonicalProjection(before));
  expect(progressed.events.filter((event) => event.name === "delivery.cursor-changed")).toHaveLength(0);
  expect(progressed.events.filter((event) => event.name === "coverage.changed")).toHaveLength(0);
});

test("interruption invalidates the Review beat without canonical interruption or progress", async ({ page }) => {
  const before = await startReview(page);
  await deliverLive(page, { voiceActivity: { voiceActivityType: "ACTIVITY_START" }, serverContent: { interrupted: true } });
  await expect.poll(async () => (await readTestState(page)).snapshot.activePresentationBeat).toBeNull();

  const interrupted = await readTestState(page);
  expect(interrupted.snapshot.reviewActive).toBe(true);
  expect(canonicalProjection(interrupted.snapshot)).toEqual(canonicalProjection(before));
  expect(interrupted.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);
  expect(interrupted.events.filter((event) => event.name === "interruption.accepted")).toHaveLength(0);
});

test("Q2-D Review interruption clarification and continue restart the same unconfirmed Review beat", async ({ page }) => {
  const before = await startReview(page);
  const reviewStarted = await readTestState(page);
  const initialReviewBeat = reviewStarted.snapshot.activePresentationBeat;
  expect(initialReviewBeat).toMatchObject({ index: 0, teachingPointIndexes: [0], mode: "review" });
  expect(canonicalProjection(reviewStarted.snapshot)).toEqual(canonicalProjection(before));

  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "PLC means programmable logic controller." },
  } });
  await deliverLive(page, {
    voiceActivity: { voiceActivityType: "ACTIVITY_START" },
    serverContent: { interrupted: true },
  });
  await expect.poll(async () => (await readTestState(page)).snapshot.activePresentationBeat).toBeNull();

  await deliverLive(page, { serverContent: {
    inputTranscription: { text: "Can you clarify what programmable means here?", finished: true },
    turnComplete: true,
  } });
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "Programmable means its control instructions can be changed." },
    generationComplete: true,
  } });
  await deliverLive(page, { serverContent: { turnComplete: true } });

  const clarified = await readTestState(page);
  expect(clarified.snapshot.reviewActive).toBe(true);
  expect(clarified.snapshot.activePresentationBeat).toBeNull();
  expect(canonicalProjection(clarified.snapshot)).toEqual(canonicalProjection(before));
  expect(clarified.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);
  expect(clarified.events.filter((event) => event.name === "delivery.cursor-changed")).toHaveLength(0);
  expect(clarified.events.filter((event) => event.name === "coverage.changed")).toHaveLength(0);

  await deliverLive(page, { serverContent: {
    inputTranscription: { text: "Okay, continue the Review.", finished: true },
  } });
  const continueResponse = await sendLessonTool(page, "continue-review-after-clarification", {
    action: "query",
    purpose: "continue",
  });
  const resumed = await readTestState(page);
  expect(resumed.snapshot.reviewActive).toBe(true);
  expect(resumed.snapshot.activePresentationBeat).toEqual(initialReviewBeat);
  expect(canonicalProjection(resumed.snapshot)).toEqual(canonicalProjection(before));
  expect(resumed.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);
  expect(textOf(continueResponse.message)).toContain("PLC means programmable logic controller");
  expect(textOf(continueResponse.message)).toContain("APP_CONTROL:TEACH_PRESENTATION_BEAT");

  await finishActiveBeat(page, "PLC means programmable logic controller.");
  await expect.poll(async () => (await readTestState(page)).events.filter((event) =>
    event.name === "beat.commit" && event.detail?.mode === "review").length).toBe(1);

  const progressed = await readTestState(page);
  expect(progressed.snapshot.reviewActive).toBe(true);
  expect(progressed.snapshot.activePresentationBeat).toMatchObject({
    index: 1,
    teachingPointIndexes: [1],
    mode: "review",
  });
  expect(canonicalProjection(progressed.snapshot)).toEqual(canonicalProjection(before));
  expect(progressed.events.filter((event) =>
    event.name === "beat.commit" && event.detail?.mode === "lesson")).toHaveLength(0);
  expect(progressed.events.filter((event) => event.name === "delivery.cursor-changed")).toHaveLength(0);
  expect(progressed.events.filter((event) => event.name === "coverage.changed")).toHaveLength(0);
  expect(progressed.events.filter((event) => event.name === "review.ended")).toHaveLength(0);
});

test("final Review beat waits, then continue exits Review and restores canonical lesson", async ({ page }) => {
  const before = await startReview(page);
  const returnBeat = before.activePresentationBeat;

  await finishActiveBeat(page, "PLC means programmable logic controller.");
  await expect.poll(async () => (await readTestState(page)).snapshot.activePresentationBeat).toMatchObject({ index: 1, mode: "review" });
  const finalReviewInstruction = (await getLiveSends(page)).filter(({ message }) =>
    Boolean(message.realtimeInput) && textOf(message).includes("final beat of a bounded node review")).at(-1);
  expect(finalReviewInstruction).toBeDefined();
  expect(textOf(finalReviewInstruction!.message)).toContain("check whether the learner has questions or is ready to return");
  await finishActiveBeat(page, "PLCs coordinate industrial inputs and outputs.");
  await expect.poll(async () => (await readTestState(page)).events.filter((event) =>
    event.name === "beat.commit" && event.detail?.mode === "review").length).toBe(2);

  const waiting = await readTestState(page);
  expect(waiting.snapshot.reviewActive).toBe(true);
  expect(waiting.snapshot.activePresentationBeat).toBeNull();
  expect(canonicalProjection(waiting.snapshot)).toEqual(canonicalProjection(before));
  expect(waiting.events.at(-1)).toMatchObject({ name: "beat.commit", detail: { mode: "review", nextIndex: 2 } });

  await sendLessonTool(page, "continue-after-review", { action: "query", purpose: "continue" });
  await expect.poll(async () => (await readTestState(page)).snapshot.reviewActive).toBe(false);
  const resumed = await readTestState(page);
  expect(resumed.snapshot.activePresentationBeat).toEqual(returnBeat);
  expect(canonicalProjection(resumed.snapshot)).toEqual(canonicalProjection(before));
  expect(resumed.events).toContainEqual(expect.objectContaining({
    name: "review.ended", detail: { nodeId: REVIEWED_NODE, reason: "completed" },
  }));
  expect(resumed.events.filter((event) => event.name === "beat.commit" && event.detail?.mode === "lesson")).toHaveLength(0);
});

test("navigate and skip are rejected while Review is active", async ({ page }) => {
  const before = await startReview(page);
  for (const action of ["navigate", "skip"]) {
    const response = await sendLessonTool(page, `${action}-during-review`, { action, conceptId: CANONICAL_NODE });
    expect(textOf(response.message)).toContain("review_active");
    expect(canonicalProjection((await readTestState(page)).snapshot)).toEqual(canonicalProjection(before));
  }
  expect((await readTestState(page)).snapshot.reviewActive).toBe(true);
});

test("socket recovery during Review preserves canonical state without duplicating progress", async ({ page }) => {
  const before = await startReview(page);
  await failActiveSocket(page);
  await expect.poll(async () => Math.max(...(await getLiveSends(page)).map(({ socketId }) => socketId))).toBe(1);
  await expect.poll(async () => (await getLiveSends(page)).filter(({ socketId, message }) =>
    socketId === 1 && Boolean(message.clientContent) && textOf(message).includes("RECOVERED_APPLICATION_CONTEXT")).length).toBe(1);

  const recovered = await readTestState(page);
  expect(recovered.snapshot.reviewActive).toBe(true);
  expect(canonicalProjection(recovered.snapshot)).toEqual(canonicalProjection(before));
  expect(recovered.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);
});
