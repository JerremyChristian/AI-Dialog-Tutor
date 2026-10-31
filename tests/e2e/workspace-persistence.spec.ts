import { expect, test } from "@playwright/test";
import {
  deliverLive,
  getExternalRequests,
  getLiveSends,
  installFakeLive,
  installNoExternalNetworkGuard,
  openLessonAndStart,
  QA_LESSON_ID,
  readSavedLesson,
  readTestState,
  textOf,
} from "../helpers/fake-live";

test.beforeEach(async ({ page }) => {
  await installNoExternalNetworkGuard(page);
});

test.afterEach(async ({ page }) => {
  expect(getExternalRequests(page), "workspace QA must not contact external providers").toEqual([]);
});

type StoredLesson = {
  id: string;
  hasStarted: boolean;
  lessonState: {
    status: string;
    currentNodeId: string | null;
    resumePoint: string;
    lastUserTranscript: string;
    lastAssistantTranscript: string;
    teachingContractProgress: Record<string, { nextTeachingPointIndex: number }>;
  };
  recentTeachingContext: Array<{ conceptId: string; excerpt: string }>;
  teachingPreferences: { explanationDepth: string; speakingSpeed: string };
};

test("persisted workspace hydrates canonical progress, context, and preferences before resume startup", async ({ page }) => {
  await installFakeLive(page, {
    persisted: true,
    persistedCursor: 1,
    persistedStatus: "interrupted",
    resumePoint: "after the definition but before industrial I/O",
    recentTeachingContext: [{ conceptId: "what-is-a-plc", excerpt: "The saved explanation of rugged controllers." }],
    teachingPreferences: { explanationDepth: "detailed", speakingSpeed: "slow" },
  });
  await openLessonAndStart(page, true);

  const state = await readTestState(page);
  expect(state.snapshot.lessonId).toBe(QA_LESSON_ID);
  expect(state.snapshot.currentNodeId).toBe("what-is-a-plc");
  expect(state.snapshot.deliveryCursor).toBe(1);
  expect(state.snapshot.resumePoint).toBe("after the definition but before industrial I/O");

  const sends = await getLiveSends(page);
  const seedIndex = sends.findIndex(({ message }) => Boolean(message.clientContent));
  const imperatives = sends.flatMap(({ message }, index) =>
    message.realtimeInput && textOf(message).includes("APP_CONTROL:TEACH_PRESENTATION_BEAT") ? [index] : []);
  expect(imperatives).toHaveLength(1);
  expect(seedIndex).toBeLessThan(imperatives[0]);
  const seed = textOf(sends[seedIndex].message);
  expect(seed).toContain("The saved explanation of rugged controllers.");
  expect(seed).toContain("after the definition but before industrial I/O");
  expect(seed).toContain('\\"nextTeachingPointIndex\\":1');
  expect(seed).toContain('\\"explanationDepth\\":\\"detailed\\"');
  expect(textOf(sends[imperatives[0]].message)).toContain("PERSISTED_LESSON_RESUME");
  expect(textOf(sends[imperatives[0]].message)).toContain('\\"index\\":1');
});

test("reload restores local progress and preferences while persisted transcripts remain blank", async ({ page }) => {
  await installFakeLive(page, {
    persisted: true,
    persistedCursor: 1,
    teachingPreferences: { explanationDepth: "detailed", speakingSpeed: "fast" },
  });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.__AI_TEACHER_TEST__?.getSnapshot().persistenceHydrated)).toBe(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__AI_TEACHER_TEST__?.getSnapshot().persistenceHydrated)).toBe(true);

  const hydrated = await readTestState(page);
  expect(hydrated.snapshot.lessonId).toBe(QA_LESSON_ID);
  expect(hydrated.snapshot.deliveryCursor).toBe(1);
  await page.locator(".continue-card").getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue Lesson", exact: true }).click();
  await expect(page.getByRole("button", { name: "Detailed explanation depth" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Fast speaking speed" })).toHaveAttribute("aria-pressed", "true");

  const stored = await readSavedLesson<StoredLesson>(page);
  expect(stored?.lessonState.lastUserTranscript).toBe("");
  expect(stored?.lessonState.lastAssistantTranscript).toBe("");
  expect(stored?.recentTeachingContext).toEqual([
    { conceptId: "what-is-a-plc", excerpt: "A PLC is a rugged industrial computer." },
  ]);
});

test("stopping persists canonical state before inactivity and stale socket callbacks cannot overwrite it", async ({ page }) => {
  await installFakeLive(page, { persisted: true, persistedCursor: 1 });
  await openLessonAndStart(page, true);
  await page.getByRole("button", { name: "End lesson", exact: true }).click();

  await expect.poll(async () => (await readSavedLesson<StoredLesson>(page))?.lessonState.status).toBe("idle");
  const stopped = await readSavedLesson<StoredLesson>(page);
  expect(stopped?.lessonState.teachingContractProgress["what-is-a-plc"].nextTeachingPointIndex).toBe(1);
  expect((await readTestState(page)).snapshot.lessonActive).toBe(false);

  await deliverLive(page, { serverContent: { outputTranscription: { text: "stale tutor output" }, generationComplete: true } }, 0);
  await page.waitForTimeout(700);
  const afterStaleCallback = await readSavedLesson<StoredLesson>(page);
  expect(afterStaleCallback?.lessonState.status).toBe("idle");
  expect(afterStaleCallback?.lessonState.teachingContractProgress["what-is-a-plc"].nextTeachingPointIndex).toBe(1);
  expect(afterStaleCallback?.lessonState.lastAssistantTranscript).toBe("");
});

test("restart durably clears current lesson progress and context but preserves teaching preferences", async ({ page }) => {
  await installFakeLive(page, {
    persisted: true,
    persistedCursor: 1,
    persistedStatus: "interrupted",
    recentTeachingContext: [{ conceptId: "what-is-a-plc", excerpt: "Old run context" }],
    teachingPreferences: { explanationDepth: "detailed", speakingSpeed: "slow" },
  });
  await openLessonAndStart(page, true);
  await page.getByRole("button", { name: "Restart Lesson" }).click();
  await page.getByRole("alertdialog", { name: "Restart this lesson?" })
    .getByRole("button", { name: "Restart", exact: true }).click();

  await expect.poll(async () => (await readSavedLesson<StoredLesson>(page))?.lessonState.teachingContractProgress["what-is-a-plc"].nextTeachingPointIndex).toBe(0);
  const restarted = await readSavedLesson<StoredLesson>(page);
  expect(restarted?.recentTeachingContext).toEqual([]);
  expect(restarted?.lessonState.resumePoint).toBe("");
  expect(restarted?.teachingPreferences).toEqual({ explanationDepth: "detailed", speakingSpeed: "slow" });

  await page.getByRole("button", { name: "End lesson", exact: true }).click();
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__AI_TEACHER_TEST__?.getSnapshot().persistenceHydrated)).toBe(true);
  expect((await readTestState(page)).snapshot.deliveryCursor).toBe(0);
});
