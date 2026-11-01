import { expect, test, type Page } from "@playwright/test";
import {
  deliverLive,
  getLiveSends,
  installFakeLive,
  openLessonAndStart,
  readTestState,
  textOf,
} from "../helpers/fake-live";

async function sendLessonActions(
  page: Page,
  calls: Array<{ id: string; action: "navigate" | "skip"; conceptId: string }>,
) {
  const responseCount = (await getLiveSends(page))
    .filter(({ message }) => Boolean(message.toolResponse)).length;
  await deliverLive(page, { toolCall: { functionCalls: calls.map(({ id, ...args }) => ({
    id,
    name: "lesson_state",
    args,
  })) } });
  await expect.poll(async () => (await getLiveSends(page))
    .filter(({ message }) => Boolean(message.toolResponse)).length).toBe(responseCount + 1);
  return (await getLiveSends(page))
    .filter(({ message }) => Boolean(message.toolResponse)).at(-1)!.message;
}

test("Q2-C skip forward preserves the unfinished concept and explicitly navigates to the next", async ({ page }) => {
  await installFakeLive(page, { additionalConcept: true });
  await openLessonAndStart(page);

  const before = await readTestState(page);
  expect(before.snapshot.currentNodeId).toBe("what-is-a-plc");
  expect(before.snapshot.deliveryCursor).toBe(0);
  expect(before.snapshot.activePresentationBeat).toMatchObject({
    index: 0,
    teachingPointIndexes: [0],
    mode: "lesson",
  });
  expect(before.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);

  const response = await sendLessonActions(page, [
    { id: "skip-current", action: "skip", conceptId: "what-is-a-plc" },
    { id: "navigate-next", action: "navigate", conceptId: "plc-scan-cycle" },
  ]);

  const after = await readTestState(page);
  expect(after.snapshot.currentNodeId).toBe("plc-scan-cycle");
  expect(after.snapshot.deliveryCursor).toBe(0);
  expect(after.snapshot.activePresentationBeat).toMatchObject({
    index: 0,
    teachingPointIndexes: [0],
    mode: "lesson",
  });
  expect(after.snapshot.coverage).toEqual({
    "what-is-a-plc": "partial",
    "plc-scan-cycle": "teaching",
  });
  expect(after.events.filter((event) => event.name === "beat.commit")).toHaveLength(0);
  expect(after.snapshot.lessonActive).toBe(true);
  expect(textOf(response)).toContain("Skipped unfinished content under What is a PLC?");
  expect(textOf(response)).toContain("Moved to PLC scan cycle");
  expect(textOf(response)).toContain("A PLC repeatedly reads inputs, executes logic, and updates outputs.");
  expect(textOf(response)).toContain("APP_CONTROL:TEACH_PRESENTATION_BEAT");
});

test("Q2-C go back preserves committed history and reassigns only the earlier uncommitted beat", async ({ page }) => {
  await installFakeLive(page, { additionalConcept: true });
  await openLessonAndStart(page);
  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);

  await deliverLive(page, { serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
    outputTranscription: { text: "A PLC means programmable logic controller." },
    generationComplete: true,
  } });
  await expect.poll(async () => (await readTestState(page)).snapshot.deliveryCursor).toBe(1);

  const beforeForwardNavigation = await readTestState(page);
  expect(beforeForwardNavigation.snapshot.activePresentationBeat).toMatchObject({
    index: 1,
    teachingPointIndexes: [1],
    mode: "lesson",
  });
  expect(beforeForwardNavigation.events.filter((event) => event.name === "beat.commit")).toHaveLength(1);

  await sendLessonActions(page, [
    { id: "navigate-later", action: "navigate", conceptId: "plc-scan-cycle" },
  ]);
  const later = await readTestState(page);
  expect(later.snapshot.currentNodeId).toBe("plc-scan-cycle");
  expect(later.snapshot.deliveryCursor).toBe(0);
  expect(later.snapshot.coverage).toEqual({
    "what-is-a-plc": "partial",
    "plc-scan-cycle": "teaching",
  });
  expect(later.events.filter((event) => event.name === "beat.commit")).toHaveLength(1);

  const response = await sendLessonActions(page, [
    { id: "navigate-back", action: "navigate", conceptId: "what-is-a-plc" },
  ]);

  const returned = await readTestState(page);
  expect(returned.snapshot.currentNodeId).toBe("what-is-a-plc");
  expect(returned.snapshot.deliveryCursor).toBe(1);
  expect(returned.snapshot.coverage).toEqual({
    "what-is-a-plc": "teaching",
    "plc-scan-cycle": "partial",
  });
  expect(returned.snapshot.activePresentationBeat).toMatchObject({
    index: 1,
    teachingPointIndexes: [1],
    mode: "lesson",
  });
  expect(returned.events.filter((event) => event.name === "beat.commit")).toHaveLength(1);
  expect(returned.snapshot.lessonActive).toBe(true);
  expect(textOf(response)).toContain("Moved to What is a PLC?");
  expect(textOf(response)).toContain("PLCs coordinate industrial inputs and outputs.");
  expect(textOf(response)).toContain("APP_CONTROL:TEACH_PRESENTATION_BEAT");
});
