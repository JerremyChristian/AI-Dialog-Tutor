import { expect, test, type Page } from "@playwright/test";
import {
  deliverLive,
  failActiveSocket,
  getExternalRequests,
  getLiveSends,
  getTokenRequestCount,
  installFakeLive,
  installNoExternalNetworkGuard,
  openLessonAndStart,
  QA_LESSON_ID,
  readSavedLesson,
  readTestState,
  textOf,
} from "../helpers/fake-live";

const teachingImperatives = (items: Awaited<ReturnType<typeof getLiveSends>>) =>
  items.filter(({ message }) => Boolean(message.realtimeInput) &&
    textOf(message).includes("APP_CONTROL:TEACH_PRESENTATION_BEAT"));

async function openSeededLesson(page: Page, persisted: boolean) {
  await page.goto("/");
  await page.waitForFunction((id) => new Promise<boolean>((resolve) => {
    const request = indexedDB.open("ai-dialog-tutor", 2);
    request.onsuccess = () => {
      const db = request.result;
      const lookup = db.transaction("savedLessons", "readonly").objectStore("savedLessons").get(id);
      lookup.onsuccess = () => { db.close(); resolve(Boolean(lookup.result)); };
    };
  }), QA_LESSON_ID);
  await page.reload();
  await expect.poll(() => page.evaluate(() =>
    window.__AI_TEACHER_TEST__?.getSnapshot().persistenceHydrated)).toBe(true);
  if (persisted) {
    await page.locator(".continue-card").getByRole("button", { name: "Continue" }).click();
  } else {
    await page.getByRole("button", { name: "Library" }).click();
    await page.locator(".lesson-card").filter({ hasText: "PLC Fundamentals" })
      .getByRole("button", { name: "Start" }).click();
  }
}

test("completed lesson startup enters wrap-up exactly once without advancing progress", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { completed: true });
  await openLessonAndStart(page, true);

  const sends = await getLiveSends(page);
  const wrapUps = sends.filter(({ message }) => Boolean(message.realtimeInput) &&
    textOf(message).includes("APP_CONTROL:LESSON_WRAP_UP"));
  const state = await readTestState(page);

  expect(wrapUps).toHaveLength(1);
  expect(teachingImperatives(sends)).toHaveLength(0);
  expect(sends.filter(({ message }) =>
    typeof (message.realtimeInput as { text?: unknown } | undefined)?.text === "string")).toHaveLength(1);
  expect(state.snapshot.deliveryCursor).toBe(2);
  expect(state.events.map(({ name }) => name)).not.toContain("beat.commit");
  expect(getExternalRequests(page)).toEqual([]);
});

test("initial token failure returns startup to the current idle error state", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { failTokenRequest: 1 });
  await openSeededLesson(page, false);
  await page.getByRole("button", { name: "Start Lesson", exact: true }).click();

  await expect(page.locator(".session-error")).toContainText(
    "The realtime lesson could not start: QA token request failed",
  );
  await expect.poll(async () => (await readTestState(page)).snapshot.startupPending).toBe(false);
  const state = await readTestState(page);

  expect(state.snapshot.lessonActive).toBe(false);
  expect(getTokenRequestCount(page)).toBe(1);
  expect(await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").socketCount())).toBe(0);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(0);
  expect(getExternalRequests(page)).toEqual([]);
});

test("fatal recovery token failure disposes the active lesson and rejects stale socket work", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { failTokenRequest: 2 });
  await openLessonAndStart(page);
  const cursorBeforeRecovery = (await readTestState(page)).snapshot.deliveryCursor;

  await failActiveSocket(page);
  await expect(page.locator(".session-error")).toContainText(
    "The realtime lesson could not recover: QA token request failed",
  );
  await expect.poll(async () => (await readTestState(page)).snapshot.lessonActive).toBe(false);
  await expect.poll(async () => (await readTestState(page)).snapshot.connectionState).toBe("closed");
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_MICROPHONE__")?.trackState())).toBe("ended");
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_WAKE_LOCK__")?.releaseCount())).toBe(1);
  await expect.poll(async () => (await readSavedLesson<{ lessonState: { status: string } }>(page))
    ?.lessonState.status).toBe("idle");

  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    generationComplete: true,
  } }, 0);
  await page.waitForTimeout(250);
  const afterStaleMessage = await readTestState(page);

  expect(getTokenRequestCount(page)).toBe(2);
  expect(await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").socketCount())).toBe(1);
  expect(afterStaleMessage.snapshot.deliveryCursor).toBe(cursorBeforeRecovery);
  expect(afterStaleMessage.events.map(({ name }) => name)).not.toContain("beat.commit");
  expect(getExternalRequests(page)).toEqual([]);
});

test("visibility recovery reacquires one wake lock without restarting the session", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page);
  await openLessonAndStart(page);
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_WAKE_LOCK__")?.requestCount())).toBe(1);
  const tokenCount = getTokenRequestCount(page);
  const socketCount = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").socketCount() as number);

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_WAKE_LOCK__")?.requestCount())).toBe(2);
  const state = await readTestState(page);

  expect(state.snapshot.lessonActive).toBe(true);
  expect(getTokenRequestCount(page)).toBe(tokenCount);
  expect(await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").socketCount())).toBe(socketCount);
  expect(teachingImperatives(await getLiveSends(page))).toHaveLength(1);
  expect(getExternalRequests(page)).toEqual([]);
});
