import { expect, test, type Page } from "@playwright/test";
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

type PlaybackRecord = {
  id: number;
  marker: number;
  startTime: number;
  stopped: boolean;
  ended: boolean;
};

function markedPcm(marker: number, sampleCount = 24_000) {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) pcm.writeInt16LE(marker, index * 2);
  return pcm.toString("base64");
}

async function playbackRecords(page: Page): Promise<PlaybackRecord[]> {
  return page.evaluate(() => Reflect.get(window, "__QA_TUTOR_PLAYBACK__").records());
}

async function acceptVoiceInterruption(page: Page) {
  await deliverLive(page, {
    voiceActivity: { voiceActivityType: "ACTIVITY_START" },
    serverContent: { interrupted: true },
  });
  await expect.poll(async () => (await readTestState(page)).events.map(({ name }) => name))
    .toContain("interruption.accepted");
}

async function deliverLearnerTurnComplete(page: Page) {
  await deliverLive(page, { serverContent: {
    inputTranscription: { text: "Wait, what exactly is a PLC?", finished: true },
    turnComplete: true,
  } });
}

test("Q1-C interruption before first output rejects the interrupted turn's late OLD audio", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { observeTutorPlayback: true });
  await openLessonAndStart(page);

  // The teaching imperative has started a provider generation, but no provider
  // audio or output transcription has arrived yet.
  expect(await playbackRecords(page)).toHaveLength(0);
  await acceptVoiceInterruption(page);

  const oldAudio = markedPcm(OLD_AUDIO_MARKER);
  const newAudio = markedPcm(NEW_AUDIO_MARKER);
  await deliverLive(page, { serverContent: { modelTurn: { parts: [
    { inlineData: { mimeType: "audio/pcm;rate=24000", data: oldAudio } },
  ] } } });
  await deliverLearnerTurnComplete(page);
  await deliverLive(page, { serverContent: {
    outputTranscription: { text: "A PLC is an industrial computer." },
    modelTurn: { parts: [
      { inlineData: { mimeType: "audio/pcm;rate=24000", data: newAudio } },
    ] },
  } });

  const records = await playbackRecords(page);
  const state = await readTestState(page);

  expect.soft(records.map(({ marker }) => marker),
    "pre-first-output interruption must admit only the NEW response after turnComplete")
    .toEqual([NEW_AUDIO_MARKER]);
  expect.soft(records.some(({ marker, stopped }) =>
    marker === OLD_AUDIO_MARKER && !stopped),
  "OLD audio arriving before interrupted turnComplete must never remain audible").toBe(false);
  expect.soft(state.snapshot.deliveryCursor).toBe(0);
  expect.soft((state.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect.soft(state.events.map(({ name }) => name)).not.toContain("beat.commit");
  expect(getExternalRequests(page)).toEqual([]);
});

test("Q1-D interruption after provider completion stops local OLD playback and admits NEW audio", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { observeTutorPlayback: true });
  await openLessonAndStart(page);

  const oldAudio = markedPcm(OLD_AUDIO_MARKER);
  const newAudio = markedPcm(NEW_AUDIO_MARKER);
  await deliverLive(page, { serverContent: { modelTurn: { parts: [
    { inlineData: { mimeType: "audio/pcm;rate=24000", data: oldAudio } },
    { inlineData: { mimeType: "audio/pcm;rate=24000", data: oldAudio } },
  ] } } });
  await deliverLive(page, { serverContent: { generationComplete: true } });

  const beforeInterruption = await readTestState(page);
  expect(beforeInterruption.snapshot.deliveryCursor).toBe(0);
  expect(beforeInterruption.events.map(({ name }) => name)).not.toContain("beat.commit");
  expect((await playbackRecords(page)).every(({ marker, stopped, ended }) =>
    marker === OLD_AUDIO_MARKER && !stopped && !ended)).toBe(true);

  await acceptVoiceInterruption(page);
  await expect.poll(async () => (await playbackRecords(page)).filter(({ stopped }) => stopped).length).toBe(2);

  // generationComplete already closed the OLD provider generation, so there is
  // deliberately no second OLD turnComplete to reopen audio admission.
  await deliverLive(page, { serverContent: {
    inputTranscription: { text: "Wait, what exactly is a PLC?", finished: true },
  } });
  await deliverLive(page, { serverContent: {
    outputTranscription: { text: "A PLC is an industrial computer." },
    modelTurn: { parts: [
      { inlineData: { mimeType: "audio/pcm;rate=24000", data: newAudio } },
    ] },
  } });

  const records = await playbackRecords(page);
  const oldRecords = records.filter(({ marker }) => marker === OLD_AUDIO_MARKER);
  const postInterruption = records.slice(2);
  const state = await readTestState(page);

  expect(oldRecords).toHaveLength(2);
  expect(oldRecords.every(({ stopped, ended }) => stopped && ended)).toBe(true);
  expect(postInterruption.map(({ marker }) => marker)).toEqual([NEW_AUDIO_MARKER]);
  expect(postInterruption[0].stopped).toBe(false);
  expect(state.snapshot.deliveryCursor).toBe(0);
  expect((state.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(state.events.map(({ name }) => name)).not.toContain("beat.commit");
  expect(getExternalRequests(page)).toEqual([]);
});
