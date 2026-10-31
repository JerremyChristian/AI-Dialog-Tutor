import { expect, test, type Page } from "@playwright/test";
import {
  deliverLive,
  getExternalRequests,
  getLiveSends,
  installFakeLive,
  installNoExternalNetworkGuard,
  openLessonAndStart,
  readTestState,
} from "../helpers/fake-live";

const OLD_AUDIO_MARKER = 1_111;
const NEW_AUDIO_MARKER = 2_222;

type PlaybackRecord = { marker: number; stopped: boolean };

function markedPcm(marker: number, sampleCount = 24_000) {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) pcm.writeInt16LE(marker, index * 2);
  return pcm.toString("base64");
}

async function playbackRecords(page: Page): Promise<PlaybackRecord[]> {
  return page.evaluate(() => Reflect.get(window, "__QA_TUTOR_PLAYBACK__").records());
}

async function interruptBeforeFirstOutput(page: Page) {
  await deliverLive(page, {
    voiceActivity: { voiceActivityType: "ACTIVITY_START" },
    serverContent: { interrupted: true },
  });
  await expect.poll(async () => (await readTestState(page)).events.map(({ name }) => name))
    .toContain("interruption.accepted");

  await deliverLive(page, { serverContent: { modelTurn: { parts: [{
    inlineData: { mimeType: "audio/pcm;rate=24000", data: markedPcm(OLD_AUDIO_MARKER) },
  }] } } });
  await deliverLive(page, { serverContent: { turnComplete: true } });
  await deliverLive(page, { serverContent: { modelTurn: { parts: [{
    inlineData: { mimeType: "audio/pcm;rate=24000", data: markedPcm(NEW_AUDIO_MARKER) },
  }] } } });
}

function assertOnlyNewAudio(records: PlaybackRecord[], message: string) {
  expect.soft(records.map(({ marker }) => marker), message).toEqual([NEW_AUDIO_MARKER]);
  expect.soft(records.some(({ marker, stopped }) => marker === OLD_AUDIO_MARKER && !stopped),
    "stale OLD audio must not remain audible").toBe(false);
}

test("Q1-E voice response is protected before its first provider output", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { observeTutorPlayback: true });
  await openLessonAndStart(page);

  // Close the startup provider turn without output, then complete an ordinary
  // learner voice turn. Its pending tutor response has not produced output yet.
  await deliverLive(page, { serverContent: { generationComplete: true } });
  await deliverLive(page, {
    voiceActivity: { voiceActivityType: "ACTIVITY_START" },
    serverContent: { inputTranscription: { text: "Can you explain PLC inputs?", finished: true } },
  });
  await deliverLive(page, { voiceActivity: { voiceActivityType: "ACTIVITY_END" } });
  expect(await playbackRecords(page)).toHaveLength(0);

  await interruptBeforeFirstOutput(page);
  const records = await playbackRecords(page);
  const state = await readTestState(page);

  assertOnlyNewAudio(records, "a replaced pending voice response must admit only NEW audio");
  expect.soft(state.snapshot.deliveryCursor).toBe(0);
  expect.soft((state.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect.soft(state.events.map(({ name }) => name)).not.toContain("beat.commit");
  expect(getExternalRequests(page)).toEqual([]);
});

test("Q1-E completed-lesson wrap-up is protected before its first provider output", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { completed: true, observeTutorPlayback: true });
  await openLessonAndStart(page, true);
  expect(await playbackRecords(page)).toHaveLength(0);

  await interruptBeforeFirstOutput(page);
  const records = await playbackRecords(page);
  const state = await readTestState(page);

  assertOnlyNewAudio(records, "an interrupted wrap-up prompt must admit only NEW audio");
  expect.soft(state.snapshot.deliveryCursor).toBe(2);
  expect.soft((state.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("taught");
  expect.soft(state.events.map(({ name }) => name)).not.toContain("beat.commit");
  expect(getExternalRequests(page)).toEqual([]);
});

test("Q1-E idle confirmation is protected before its first provider output", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { observeTutorPlayback: true });
  await openLessonAndStart(page);
  await deliverLive(page, { serverContent: { generationComplete: true } });

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
  expect(await playbackRecords(page)).toHaveLength(0);

  await interruptBeforeFirstOutput(page);
  const records = await playbackRecords(page);
  const state = await readTestState(page);

  assertOnlyNewAudio(records, "an interrupted idle-confirmation prompt must admit only NEW audio");
  expect.soft(state.snapshot.deliveryCursor).toBe(0);
  expect.soft((state.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect.soft(state.events.map(({ name }) => name)).not.toContain("beat.commit");
  expect(getExternalRequests(page)).toEqual([]);
});
