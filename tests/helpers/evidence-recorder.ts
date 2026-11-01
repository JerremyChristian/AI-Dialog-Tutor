// Playwright glue for Q3 evidence: collects app test events, fake-Live provider
// frames, harness events and labelled snapshots from one page document, then
// hands them to the pure packet builder. Never calls a provider.

import { expect, type Page, type TestInfo } from "@playwright/test";
import { evaluateHardAssertions, type HardEvaluation } from "../q3/assertions/hard";
import { measurePerformance } from "../q3/assertions/performance";
import { buildEvidencePacket } from "../q3/evidence/build";
import type { EvidenceHarness, EvidencePacket, RawHarnessEvent, RawSnapshot } from "../q3/evidence/types";
import { getLiveReceived, getSeededLesson, readSavedLesson, readTestState } from "./fake-live";

type TestState = Awaited<ReturnType<typeof readTestState>>;

const documentOrigin = (page: Page) => page.evaluate(() => performance.timeOrigin);

/**
 * Starts evidence capture for the current document. Call after the lesson has
 * opened (openLessonAndStart reloads) and before any canonical progress, so the
 * seeded lesson is a faithful starting contract; both conditions are checked.
 */
export async function startEvidence(page: Page, scenarioId: string) {
  const snapshots: RawSnapshot[] = [];
  const harnessEvents: RawHarnessEvent[] = [];
  const origin = await documentOrigin(page);
  const seededAtStart = await getSeededLesson(page);
  if (!seededAtStart) throw new Error("Evidence requires a fake-Live seeded lesson");
  type Progress = { lessonState?: { teachingContractProgress?: Record<string, { nextTeachingPointIndex?: number }> } };
  const cursors = (lesson: Progress | undefined) => JSON.stringify(Object.entries(lesson?.lessonState?.teachingContractProgress ?? {})
    .map(([id, progress]) => [id, progress?.nextTeachingPointIndex ?? 0]).sort());
  if (cursors(await readSavedLesson<Progress>(page)) !== cursors(seededAtStart.lesson as Progress)) {
    throw new Error("Evidence must start before canonical progress diverges from the seeded lesson");
  }

  const pageClock = () => page.evaluate(() => ({
    anchor: window.__AI_TEACHER_TEST__?.getEvents().length ?? 0,
    t: Date.now(),
  }));

  return {
    /** Records a state the test already read; its anchor is the event count it saw. */
    observe(label: string, state: TestState) {
      snapshots.push({ label, anchor: state.events.length, snapshot: state.snapshot });
      return state;
    },
    async snapshot(label: string) {
      return this.observe(label, await readTestState(page));
    },
    /** Call immediately before the UI send, so app events it causes sort after it. */
    async learnerTyped(text: string, options: { duringTutorOutput: boolean }) {
      harnessEvents.push({ ...(await pageClock()), name: "harness.learner-text", detail: { text, ...options } });
    },
    async stopRequested() {
      harnessEvents.push({ ...(await pageClock()), name: "harness.stop-requested" });
    },
    async finalize(harness: { endedBy: EvidenceHarness["endedBy"]; abort?: EvidenceHarness["abort"]; notes?: string[] }) {
      if (await documentOrigin(page) !== origin) {
        throw new Error("The page reloaded during evidence capture; app events no longer cover the session");
      }
      const seeded = seededAtStart;
      // One read supplies both the final snapshot and the events, so the
      // snapshot is always anchored after the last app event in the packet.
      const state = this.observe("finalize", await readTestState(page));
      return buildEvidencePacket({
        seeded,
        appEvents: state.events,
        providerFrames: await getLiveReceived(page),
        harnessEvents,
        snapshots,
        harness: { kind: "q2-scripted", scenarioId, ...harness },
      });
    },
  };
}

/**
 * Attaches packet + evaluation to the test report and asserts that no hard
 * assertion failed or was unsupported. A finished capture must then pass; an
 * open (mid-session) capture is partial evidence, so its verdict is inconclusive.
 */
export async function expectHardEvidencePass(packet: EvidencePacket, testInfo: TestInfo): Promise<HardEvaluation> {
  const evaluation = evaluateHardAssertions(packet);
  const performance = measurePerformance(packet);
  await testInfo.attach("q3-evidence-packet.json", { body: JSON.stringify(packet, null, 2), contentType: "application/json" });
  await testInfo.attach("q3-hard-evaluation.json", {
    body: JSON.stringify({ evaluation, performance }, null, 2), contentType: "application/json",
  });
  const failures = evaluation.assertions.filter(({ status }) => status === "fail");
  expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  const unsupported = evaluation.assertions.filter(({ status }) => status === "unsupported");
  expect(unsupported, JSON.stringify(unsupported, null, 2)).toEqual([]);
  expect(evaluation.verdict).toBe(packet.harness.endedBy === "open" ? "inconclusive" : "pass");
  return evaluation;
}

export const statusOf = (evaluation: HardEvaluation) =>
  Object.fromEntries(evaluation.assertions.map(({ id, status }) => [id, status]));
