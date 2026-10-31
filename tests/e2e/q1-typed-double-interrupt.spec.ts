import { expect, test, type Page } from "@playwright/test";
import {
  deliverLive,
  getExternalRequests,
  getLiveSends,
  installFakeLive,
  installNoExternalNetworkGuard,
  openLessonAndStart,
  readTestState,
  textOf,
} from "../helpers/fake-live";

const INITIAL_AUDIO_MARKER = 3_333;
const STALE_TYPED_RESPONSE_MARKER = 1_111;
const LATEST_RESPONSE_MARKER = 2_222;

type PlaybackRecord = { marker: number; stopped: boolean; ended: boolean };

function markedPcm(marker: number, sampleCount = 24_000) {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) pcm.writeInt16LE(marker, index * 2);
  return pcm.toString("base64");
}

async function playbackRecords(page: Page): Promise<PlaybackRecord[]> {
  return page.evaluate(() => Reflect.get(window, "__QA_TUTOR_PLAYBACK__").records());
}

test("Q1-F OLD turnComplete cannot erase a typed replacement response before a second interruption", async ({ page }) => {
  await installNoExternalNetworkGuard(page);
  await installFakeLive(page, { observeTutorPlayback: true });
  await openLessonAndStart(page);

  await deliverLive(page, { serverContent: { modelTurn: { parts: [{
    inlineData: {
      mimeType: "audio/pcm;rate=24000",
      data: markedPcm(INITIAL_AUDIO_MARKER),
    },
  }] } } });
  await expect.poll(async () => (await playbackRecords(page)).length).toBe(1);

  const typedText = "Wait, explain that another way.";
  const sendsBeforeTypedTurn = (await getLiveSends(page)).length;
  await page.getByLabel("Type a reply").fill(typedText);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await getLiveSends(page)).slice(sendsBeforeTypedTurn).some(({ message }) =>
    Boolean(message.clientContent) && textOf(message).includes(typedText),
  )).toBe(true);
  await expect.poll(async () => (await playbackRecords(page))[0]?.stopped).toBe(true);

  // The typed learner turn is already on the socket. Gemini now acknowledges
  // interruption of the preceding OLD model turn and closes that OLD turn.
  await deliverLive(page, { serverContent: { interrupted: true } });
  await deliverLive(page, { serverContent: { turnComplete: true } });

  // Before the typed turn's response produces any output, voice input replaces it.
  await deliverLive(page, {
    voiceActivity: { voiceActivityType: "ACTIVITY_START" },
    serverContent: { interrupted: true },
  });
  await expect.poll(async () => (await readTestState(page)).snapshot.interruptionCount).toBe(2);

  await deliverLive(page, { serverContent: { modelTurn: { parts: [{
    inlineData: {
      mimeType: "audio/pcm;rate=24000",
      data: markedPcm(STALE_TYPED_RESPONSE_MARKER),
    },
  }] } } });
  await deliverLive(page, { serverContent: { turnComplete: true } });
  await deliverLive(page, { serverContent: { modelTurn: { parts: [{
    inlineData: {
      mimeType: "audio/pcm;rate=24000",
      data: markedPcm(LATEST_RESPONSE_MARKER),
    },
  }] } } });

  const records = await playbackRecords(page);
  const postSecondInterruption = records.slice(1);
  const state = await readTestState(page);

  expect.soft(postSecondInterruption.map(({ marker }) => marker),
    "the second interruption must admit only the latest voice-turn response")
    .toEqual([LATEST_RESPONSE_MARKER]);
  expect.soft(postSecondInterruption.some(({ marker, stopped }) =>
    marker === STALE_TYPED_RESPONSE_MARKER && !stopped),
  "the stale typed-response audio must not remain scheduled").toBe(false);
  expect.soft(postSecondInterruption.some(({ marker, stopped }) =>
    marker === LATEST_RESPONSE_MARKER && !stopped),
  "the latest response must remain audible").toBe(true);
  expect.soft(state.snapshot.deliveryCursor).toBe(0);
  expect.soft((state.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect.soft(state.events.map(({ name }) => name)).not.toContain("beat.commit");
  expect(getExternalRequests(page)).toEqual([]);
});
