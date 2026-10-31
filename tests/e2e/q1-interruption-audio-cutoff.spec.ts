import { expect, test } from "@playwright/test";
import {
  deliverLive,
  getExternalRequests,
  installFakeLive,
  installNoExternalNetworkGuard,
  openLessonAndStart,
  readTestState,
} from "../helpers/fake-live";

const OLD_AUDIO_MARKER = 1_111;
const NEW_AUDIO_MARKER = 2_222;

function markedPcm(marker: number, sampleCount = 24_000) {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) pcm.writeInt16LE(marker, index * 2);
  return pcm.toString("base64");
}

type PlaybackRecord = {
  id: number;
  marker: number;
  startTime: number;
  stopped: boolean;
  ended: boolean;
};

async function playbackRecords(page: Parameters<typeof readTestState>[0]): Promise<PlaybackRecord[]> {
  return page.evaluate(() => Reflect.get(window, "__QA_TUTOR_PLAYBACK__").records());
}

test("Q1-A interruption cancels old playback before the new response becomes audible", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { observeTutorPlayback: true });
  await openLessonAndStart(page);

  const oldAudio = markedPcm(OLD_AUDIO_MARKER);
  const newAudio = markedPcm(NEW_AUDIO_MARKER);
  await deliverLive(page, { serverContent: { modelTurn: { parts: [
    { inlineData: { mimeType: "audio/pcm;rate=24000", data: oldAudio } },
    { inlineData: { mimeType: "audio/pcm;rate=24000", data: oldAudio } },
  ] } } });
  await expect.poll(async () => (await playbackRecords(page)).length).toBe(2);
  const oldRecords = await playbackRecords(page);
  expect(oldRecords.every(({ marker, stopped, ended }) =>
    marker === OLD_AUDIO_MARKER && !stopped && !ended)).toBe(true);

  await deliverLive(page, {
    voiceActivity: { voiceActivityType: "ACTIVITY_START" },
    serverContent: { interrupted: true },
  });
  await expect.poll(async () => (await readTestState(page)).events.map(({ name }) => name))
    .toContain("interruption.accepted");
  await expect.poll(async () => (await playbackRecords(page)).filter(({ stopped }) => stopped).length).toBe(2);
  const afterCancellation = await playbackRecords(page);
  expect(afterCancellation.every(({ marker, stopped }) =>
    marker === OLD_AUDIO_MARKER && stopped)).toBe(true);

  await deliverLive(page, { serverContent: {
    inputTranscription: { text: "Wait, what exactly is a PLC?", finished: true },
    turnComplete: true,
  } });

  // A provider chunk already in flight from the cancelled response arrives late,
  // followed by the first audio for the interruption response.
  await deliverLive(page, { serverContent: { modelTurn: { parts: [
    { inlineData: { mimeType: "audio/pcm;rate=24000", data: oldAudio } },
  ] } } });
  await deliverLive(page, { serverContent: {
    outputTranscription: { text: "A PLC is an industrial computer." },
    modelTurn: { parts: [
      { inlineData: { mimeType: "audio/pcm;rate=24000", data: newAudio } },
    ] },
  } });
  await deliverLive(page, { serverContent: { generationComplete: true } });

  const records = await playbackRecords(page);
  const postInterruption = records.slice(2);
  const state = await readTestState(page);

  expect.soft(postInterruption.map(({ marker }) => marker),
    "the first audible source after forced cancellation must be the new interruption response")
    .toEqual([NEW_AUDIO_MARKER]);
  expect.soft(postInterruption.some(({ marker, stopped }) =>
    marker === OLD_AUDIO_MARKER && !stopped),
  "stale old-response audio must never remain scheduled after interruption").toBe(false);
  expect.soft(state.snapshot.deliveryCursor).toBe(0);
  expect.soft((state.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect.soft(state.events.map(({ name }) => name)).not.toContain("beat.commit");
  expect(getExternalRequests(page)).toEqual([]);
});
