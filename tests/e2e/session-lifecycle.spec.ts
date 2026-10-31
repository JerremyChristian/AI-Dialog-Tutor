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

test("clarification preserves canonical progress and continue reassigns the unconfirmed beat", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);
  const initialImperative = teachingImperatives(await getLiveSends(page))[0];
  const pcm = await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").pcm as string);
  await deliverLive(page, { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] }, outputTranscription: { text: "A PLC is a rugged industrial computer." } } });
  await deliverLive(page, { voiceActivity: { voiceActivityType: "ACTIVITY_START" }, serverContent: { interrupted: true } });
  await deliverLive(page, { serverContent: { inputTranscription: { text: "What exactly does rugged mean?", finished: true }, turnComplete: true } });
  await deliverLive(page, { serverContent: { outputTranscription: { text: "It means designed for harsh industrial conditions." } } });
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

  expect((await readTestState(page)).snapshot.deliveryCursor).toBe(0);
});
