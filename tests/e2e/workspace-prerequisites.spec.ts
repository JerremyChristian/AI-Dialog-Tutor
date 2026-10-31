import { expect, test, type Page } from "@playwright/test";
import {
  deliverLive,
  getExternalRequests,
  holdSavedLessonWrites,
  installFakeLive,
  installNoExternalNetworkGuard,
  openLessonAndStart,
  QA_LESSON_ID,
  readAppState,
  readSavedLesson,
  readTestState,
  releaseSavedLessonWrites,
} from "../helpers/fake-live";

type StoredLesson = {
  id: string;
  lessonFocus: string;
  updatedAt: string;
  lessonState: {
    currentNodeId: string | null;
    resumePoint: string;
    teachingContractProgress: Record<string, { nextTeachingPointIndex: number }>;
  };
};

async function openSeededWorkspace(page: Page) {
  await page.goto("/");
  await page.waitForFunction((id) => new Promise<boolean>((resolve) => {
    const open = indexedDB.open("ai-dialog-tutor", 2);
    open.onsuccess = () => {
      const db = open.result;
      const get = db.transaction("savedLessons", "readonly").objectStore("savedLessons").get(id);
      get.onsuccess = () => { db.close(); resolve(Boolean(get.result)); };
    };
  }), QA_LESSON_ID);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__AI_TEACHER_TEST__?.getSnapshot().persistenceHydrated)).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await installNoExternalNetworkGuard(page);
});

test.afterEach(async ({ page }) => {
  expect(getExternalRequests(page), "workspace QA must not contact external providers").toEqual([]);
});

test("incompatible active snapshot completes hydration without restoring it and clears the pointer", async ({ page }) => {
  await installFakeLive(page, { schemaVersion: 999, persisted: true });
  await openSeededWorkspace(page);

  const state = await readTestState(page);
  expect(state.snapshot.persistenceHydrated).toBe(true);
  expect(state.snapshot.lessonId).toBeNull();
  expect(await readAppState(page)).toBeUndefined();
  expect(await readSavedLesson(page)).toBeDefined();
});

test("canonical progress is debounced before IndexedDB receives the committed cursor", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  const before = await readSavedLesson<StoredLesson>(page);
  expect(before?.lessonState.teachingContractProgress["what-is-a-plc"].nextTeachingPointIndex).toBe(0);

  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    generationComplete: true,
  } });
  await expect.poll(async () => (await readTestState(page)).snapshot.deliveryCursor).toBe(1);

  await page.waitForTimeout(300);
  const duringDebounce = await readSavedLesson<StoredLesson>(page);
  expect(duringDebounce?.lessonState.teachingContractProgress["what-is-a-plc"].nextTeachingPointIndex).toBe(0);

  await expect.poll(async () =>
    (await readSavedLesson<StoredLesson>(page))?.lessonState.teachingContractProgress["what-is-a-plc"].nextTeachingPointIndex,
  { timeout: 2_500 }).toBe(1);
  expect(Date.parse((await readSavedLesson<StoredLesson>(page))!.updatedAt)).toBeGreaterThan(Date.parse(before!.updatedAt));
});

test("selecting lesson B flushes pending edits to A before B hydrates", async ({ page }) => {
  await installFakeLive(page, { persisted: true, secondLesson: true });
  await openSeededWorkspace(page);
  await page.locator(".continue-card").getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Lesson topic or focus (optional)").fill("edited PLC focus");
  await page.getByRole("button", { name: /Back to Library/ }).click();
  await page.locator(".lesson-card").filter({ hasText: "Hydraulics Basics" })
    .getByRole("button", { name: "Continue" }).click();

  const outgoing = await readSavedLesson<StoredLesson>(page, QA_LESSON_ID);
  expect(outgoing?.lessonFocus).toBe("edited PLC focus");
  expect(await readAppState(page)).toBe("qa-hydraulics-002");
  const state = await readTestState(page);
  expect(state.snapshot.lessonId).toBe("qa-hydraulics-002");
  expect(state.snapshot.deliveryCursor).toBe(0);
  expect(state.snapshot.resumePoint).toBe("hydraulic-only resume point");
});

test("Add New Lesson preserves LW8 by re-pointing and restoring the outgoing lesson", async ({ page }) => {
  await installFakeLive(page, { persisted: true });
  await openSeededWorkspace(page);
  await page.locator(".continue-card").getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Lesson topic or focus (optional)").fill("LW8 outgoing focus");
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "+ Add New Lesson" }).click();

  await expect.poll(() => readAppState(page)).toBe(QA_LESSON_ID);
  await expect.poll(async () => (await readSavedLesson<StoredLesson>(page))?.lessonFocus).toBe("LW8 outgoing focus");
  expect((await readTestState(page)).snapshot.lessonId).toBeNull();

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__AI_TEACHER_TEST__?.getSnapshot().persistenceHydrated)).toBe(true);
  expect((await readTestState(page)).snapshot.lessonId).toBe(QA_LESSON_ID);
  await expect(page.getByRole("heading", { name: "Continue learning" })).toBeVisible();
});

test("deleting the current lesson removes its record and pointer and returns to a blank library", async ({ page }) => {
  await installFakeLive(page, { persisted: true });
  await openSeededWorkspace(page);
  await page.locator(".continue-card").getByRole("button", { name: "Continue" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Lesson" }).click();

  await expect.poll(() => readSavedLesson(page)).toBeUndefined();
  await expect.poll(() => readAppState(page)).toBeUndefined();
  expect((await readTestState(page)).snapshot.lessonId).toBeNull();
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No lessons yet" })).toBeVisible();
});

test("stale current-lesson delete completion does not reset a lesson started while deletion is in flight", async ({ page }) => {
  await installFakeLive(page, { persisted: true, persistedCursor: 1 });
  await openSeededWorkspace(page);
  await page.locator(".continue-card").getByRole("button", { name: "Continue" }).click();
  const before = await readTestState(page);
  expect(before.snapshot.deliveryCursor).toBe(1);

  await holdSavedLessonWrites(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Lesson" }).click();
  await expect(page.getByRole("button", { name: "Delete Lesson" })).toBeDisabled();

  await page.getByRole("button", { name: "Continue Lesson", exact: true }).click();
  await expect.poll(async () => (await readTestState(page)).snapshot.lessonActive).toBe(true);
  expect((await readTestState(page)).snapshot.deliveryCursor).toBe(1);

  await releaseSavedLessonWrites(page);
  await expect.poll(() => readSavedLesson(page)).toBeUndefined();
  await expect.poll(() => readAppState(page)).toBeUndefined();

  const afterDelete = await readTestState(page);
  expect(afterDelete.snapshot.lessonActive).toBe(true);
  expect.soft({
    lessonId: afterDelete.snapshot.lessonId,
    deliveryCursor: afterDelete.snapshot.deliveryCursor,
  }, "stale delete completion must preserve the active workspace and its canonical progress").toEqual({
    lessonId: QA_LESSON_ID,
    deliveryCursor: 1,
  });
  await page.close();
});

test("hydration-triggered identical autosave keeps updatedAt stable", async ({ page }) => {
  await installFakeLive(page, { persisted: true });
  await openSeededWorkspace(page);
  const rawFixtureTimestamp = (await readSavedLesson<StoredLesson>(page))!.updatedAt;
  await expect.poll(async () => (await readSavedLesson<StoredLesson>(page))?.updatedAt)
    .not.toBe(rawFixtureTimestamp);
  const canonicalBaseline = await readSavedLesson<StoredLesson>(page);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__AI_TEACHER_TEST__?.getSnapshot().persistenceHydrated)).toBe(true);
  await page.waitForTimeout(1_500);
  const afterHydrationSave = await readSavedLesson<StoredLesson>(page);
  expect(afterHydrationSave?.updatedAt).toBe(canonicalBaseline?.updatedAt);
});

test("anonymous workspace neither restores nor lists a cloud-owned seeded lesson", async ({ page }) => {
  await installFakeLive(page, { persisted: true, cloudOwnerId: "11111111-1111-4111-8111-111111111111" });
  await openSeededWorkspace(page);

  expect((await readTestState(page)).snapshot.lessonId).toBeNull();
  await page.getByRole("button", { name: "Library" }).click();
  await expect(page.locator(".lesson-card")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No lessons yet" })).toBeVisible();
  expect(await readAppState(page)).toBe(QA_LESSON_ID);
});
