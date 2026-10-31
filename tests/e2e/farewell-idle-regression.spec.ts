import { expect, test, type Page } from "@playwright/test";
import {
  deliverLive, getLiveSends, installFakeLive, openLessonAndStart,
  readTestState,
} from "../helpers/fake-live";

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

test("idle end follows the existing confirmed-stop behavior", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  await requestIdleConfirmation(page);

  await sendSessionControl(page, "idle-end", "end");
  await expect.poll(async () => (await readTestState(page)).snapshot.lessonActive).toBe(false);
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
