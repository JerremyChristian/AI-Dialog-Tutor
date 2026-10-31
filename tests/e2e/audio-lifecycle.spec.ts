import { expect, test } from "@playwright/test";
import {
  deliverLive, endMicrophoneTrack, getExternalRequests, getLiveSends, installFakeLive,
  getTokenRequestCount, installNoExternalNetworkGuard, openLessonAndStart, QA_LESSON_ID,
  readTestState, releaseFirstPlayerReady, releaseFirstStreamerClose, releaseFirstTokenResponse,
} from "../helpers/fake-live";

const learnerAudioCount = async (page: Parameters<typeof getLiveSends>[0]) =>
  (await getLiveSends(page)).filter(({ message }) =>
    Boolean((message.realtimeInput as { audio?: unknown } | undefined)?.audio)).length;

test("a startup made stale while playerReady is pending cannot request a token", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { persisted: true, holdFirstPlayerReady: true });
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
  await expect.poll(() => page.evaluate(() => window.__AI_TEACHER_TEST__?.getSnapshot().persistenceHydrated)).toBe(true);
  await page.locator(".continue-card").getByRole("button", { name: "Continue" }).click();

  const start = page.getByRole("button", { name: "Continue Lesson", exact: true });
  await start.click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__QA_PLAYER_READY__")?.isHeld())).toBe(true);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__QA_MICROPHONE__")?.hasStream())).toBe(true);
  expect(getTokenRequestCount(page)).toBe(0);

  await page.getByRole("button", { name: "Restart Lesson" }).click();
  await page.getByRole("alertdialog", { name: "Restart this lesson?" })
    .getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(() => getTokenRequestCount(page)).toBe(1);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__QA_LIVE__").socketCount())).toBe(1);
  expect(getExternalRequests(page)).toEqual([]);

  await releaseFirstPlayerReady(page);
  await expect.poll(async () => ({
    tokenRequests: getTokenRequestCount(page),
    socketCount: await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").socketCount()),
  })).toEqual({ tokenRequests: 1, socketCount: 1 });
});

test("a stale startup cannot clear startupPending owned by a newer startup", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, {
    persisted: true,
    holdFirstPlayerReady: true,
    holdFirstTokenResponse: true,
  });
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
  await page.locator(".continue-card").getByRole("button", { name: "Continue" }).click();

  await page.getByRole("button", { name: "Continue Lesson", exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_PLAYER_READY__")?.isHeld())).toBe(true);

  await page.getByRole("button", { name: "Restart Lesson" }).click();
  await page.getByRole("alertdialog", { name: "Restart this lesson?" })
    .getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(() => getTokenRequestCount(page)).toBe(1);

  await releaseFirstPlayerReady(page);
  await page.waitForTimeout(50);

  const startupPendingWhileRunBIsHeld = (await readTestState(page)).snapshot.startupPending;
  expect(getExternalRequests(page)).toEqual([]);

  releaseFirstTokenResponse(page);
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_LIVE__").socketCount())).toBe(1);
  await expect.poll(async () => (await readTestState(page)).snapshot.lessonActive).toBe(true);

  expect(startupPendingWhileRunBIsHeld).toBe(true);
});

test("stale disposal cannot close the newer run's playback player", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { persisted: true, holdFirstStreamerClose: true });
  await openLessonAndStart(page, true);
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_DISPOSAL__")?.playerCount())).toBe(1);
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_DISPOSAL__")?.wakeLockCount())).toBe(1);

  await endMicrophoneTrack(page);
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_DISPOSAL__")?.isHeld())).toBe(true);

  await page.getByRole("button", { name: "Continue Lesson", exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_DISPOSAL__")?.playerCount())).toBe(2);
  await expect.poll(async () => (await readTestState(page)).snapshot.lessonActive).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_DISPOSAL__")?.wakeLockCount())).toBe(2);

  await releaseFirstStreamerClose(page);
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_DISPOSAL__")?.wakeLockReleaseCount())).toBe(1);

  const newerPlayerClosed = await page.evaluate(() =>
    Reflect.get(window, "__QA_DISPOSAL__").isPlayerClosed(1) as boolean);
  expect(getExternalRequests(page)).toEqual([]);
  expect(newerPlayerClosed).toBe(false);
});

test("stale disposal cannot tear down the newer authoritative session", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { persisted: true, holdFirstStreamerClose: true });
  await openLessonAndStart(page, true);
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_DISPOSAL__")?.wakeLockCount())).toBe(1);

  await endMicrophoneTrack(page);
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_DISPOSAL__")?.isHeld())).toBe(true);

  await page.getByRole("button", { name: "Continue Lesson", exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_LIVE__").socketCount())).toBe(2);
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_DISPOSAL__")?.wakeLockCount())).toBe(2);
  await expect.poll(async () => {
    const snapshot = (await readTestState(page)).snapshot;
    return snapshot.lessonActive && snapshot.connectionState !== "closed";
  }).toBe(true);

  const before = (await readTestState(page)).snapshot;
  const bSocketStateBefore = await page.evaluate(() =>
    Reflect.get(window, "__QA_LIVE__").socketState(1) as number);

  await releaseFirstStreamerClose(page);
  await expect.poll(() => page.evaluate(() =>
    Reflect.get(window, "__QA_DISPOSAL__")?.wakeLockReleaseCount())).toBe(1);
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

  const after = (await readTestState(page)).snapshot;
  const bSocketStateAfter = await page.evaluate(() =>
    Reflect.get(window, "__QA_LIVE__").socketState(1) as number);
  const newerPlayerClosed = await page.evaluate(() =>
    Reflect.get(window, "__QA_DISPOSAL__").isPlayerClosed(1) as boolean);

  expect(getExternalRequests(page)).toEqual([]);
  expect(newerPlayerClosed).toBe(false);
  expect.soft(after.lessonActive).toBe(true);
  expect.soft(after.connectionState).toBe(before.connectionState);
  expect(bSocketStateAfter).toBe(bSocketStateBefore);
});

test("fake microphone starts and mute gates learner PCM until unmuted", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__QA_MICROPHONE__")?.hasStream())).toBe(true);
  await expect.poll(() => learnerAudioCount(page)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Mute microphone" }).click();
  const mutedCount = await learnerAudioCount(page);
  await page.waitForTimeout(500);
  expect(await learnerAudioCount(page)).toBe(mutedCount);

  await page.getByRole("button", { name: "Unmute microphone" }).click();
  await expect.poll(() => learnerAudioCount(page)).toBeGreaterThan(mutedCount);
});

test("microphone permission failure leaves no active session", async ({ page }) => {
  await installFakeLive(page, { microphoneFailure: "QA microphone denied" });
  await page.goto("/");
  await page.waitForFunction((id) => new Promise<boolean>((resolve) => {
    const request = indexedDB.open("ai-dialog-tutor", 2);
    request.onsuccess = () => {
      const db = request.result;
      const lookup = db.transaction("savedLessons", "readonly").objectStore("savedLessons").get(id);
      lookup.onsuccess = () => { db.close(); resolve(Boolean(lookup.result)); };
    };
  }), "qa-session-lifecycle-001");
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__AI_TEACHER_TEST__?.getSnapshot().persistenceHydrated)).toBe(true);
  await page.getByRole("button", { name: "Library" }).click();
  await page.locator(".lesson-card").filter({ hasText: "PLC Fundamentals" }).getByRole("button", { name: "Start" }).click();
  await page.getByRole("button", { name: "Start Lesson", exact: true }).click();

  await expect(page.locator(".session-error")).toContainText("Microphone permission was denied");
  await expect.poll(async () => (await readTestState(page)).snapshot.lessonActive).toBe(false);
  expect(await getLiveSends(page)).toHaveLength(0);
});

test("generation completion commits only after natural audio drain", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
  await deliverLive(page, { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] } } });
  await deliverLive(page, { serverContent: { generationComplete: true } });

  const afterGenerationComplete = await readTestState(page);
  expect(afterGenerationComplete.snapshot.deliveryCursor).toBe(0);
  expect(afterGenerationComplete.events.map(({ name }) => name)).not.toContain("beat.commit");
  await expect.poll(async () => (await readTestState(page)).snapshot.deliveryCursor).toBe(1);
  expect((await readTestState(page)).events.map(({ name }) => name)).toContain("tutor.audio-ended");
});

test("track ending disposes the run and stale old-socket audio cannot mutate it", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  await endMicrophoneTrack(page);
  await expect(page.getByText(/microphone stopped unexpectedly/i)).toBeVisible();
  await expect.poll(async () => (await readTestState(page)).snapshot.lessonActive).toBe(false);
  const before = (await readTestState(page)).snapshot.deliveryCursor;
  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    generationComplete: true,
  } }, 0);
  await page.waitForTimeout(250);
  expect((await readTestState(page)).snapshot.deliveryCursor).toBe(before);
  expect((await readTestState(page)).events.map(({ name }) => name)).not.toContain("beat.commit");
});

test("restart isolates the new run from old-socket audio callbacks", async ({ page }) => {
  await installFakeLive(page, { persisted: true });
  await openLessonAndStart(page, true);
  await page.getByRole("button", { name: "Restart Lesson" }).click();
  await page.getByRole("alertdialog", { name: "Restart this lesson?" })
    .getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(async () => new Set((await getLiveSends(page)).map(({ socketId }) => socketId)).size).toBe(2);
  await expect.poll(async () => (await readTestState(page)).snapshot.deliveryCursor).toBe(0);
  await page.evaluate(() => window.__AI_TEACHER_TEST__?.clearEvents());

  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    generationComplete: true,
  } }, 0);
  await page.waitForTimeout(250);

  const state = await readTestState(page);
  expect(state.snapshot.lessonActive).toBe(true);
  expect(state.snapshot.deliveryCursor).toBe(0);
  expect(state.events.map(({ name }) => name)).not.toContain("tutor.audio-started");
  expect(state.events.map(({ name }) => name)).not.toContain("beat.commit");
});

test("audio-bearing farewell waits for its audio to drain", async ({ page }) => {
  await installFakeLive(page, { completed: true });
  await openLessonAndStart(page, true);
  await deliverLive(page, { toolCall: { functionCalls: [{ id: "farewell-audio", name: "session_control", args: { action: "end" } }] } });
  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
  await deliverLive(page, { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] } } });
  await deliverLive(page, { serverContent: { generationComplete: true } });
  expect((await readTestState(page)).snapshot.lessonActive).toBe(true);
  await expect(page.getByText("Lesson complete")).toHaveCount(0);
  await expect(page.getByText("Lesson complete")).toBeVisible();
});
