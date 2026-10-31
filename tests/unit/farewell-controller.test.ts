import { describe, expect, it } from "vitest";

import {
  createFarewellTurn,
  farewellCompletionDiagnostic,
  isCurrentFarewell,
  isFarewellDrainCurrent,
  isFarewellReadyToFinish,
  type FarewellTurn,
} from "../../lib/farewell-controller";

const RUN = 3;
const EPOCH = 7;

function farewell(overrides: Partial<FarewellTurn> = {}): FarewellTurn {
  return { ...createFarewellTurn(RUN, EPOCH), ...overrides };
}

describe("createFarewellTurn", () => {
  it("binds the run and epoch with every completion flag cleared", () => {
    expect(createFarewellTurn(RUN, EPOCH)).toEqual({
      conversationRun: RUN,
      generationEpoch: EPOCH,
      generationComplete: false,
      audioReceived: false,
      audioNaturallyDrained: false,
      completionStarted: false,
    });
  });
});

describe("isFarewellReadyToFinish", () => {
  it("is false with no farewell", () => {
    expect(isFarewellReadyToFinish(null, RUN, EPOCH)).toBe(false);
  });

  it("is false before generation complete, even when audio drained", () => {
    expect(isFarewellReadyToFinish(farewell(), RUN, EPOCH)).toBe(false);
    expect(isFarewellReadyToFinish(
      farewell({ audioReceived: true, audioNaturallyDrained: true }),
      RUN,
      EPOCH,
    )).toBe(false);
  });

  it("waits for natural drain when farewell audio was received", () => {
    expect(isFarewellReadyToFinish(
      farewell({ generationComplete: true, audioReceived: true }),
      RUN,
      EPOCH,
    )).toBe(false);
  });

  it("finishes on generation complete plus natural drain", () => {
    expect(isFarewellReadyToFinish(
      farewell({ generationComplete: true, audioReceived: true, audioNaturallyDrained: true }),
      RUN,
      EPOCH,
    )).toBe(true);
  });

  it("finishes a zero-audio farewell on generation complete alone", () => {
    expect(isFarewellReadyToFinish(farewell({ generationComplete: true }), RUN, EPOCH)).toBe(true);
  });

  it("starts completion at most once", () => {
    expect(isFarewellReadyToFinish(
      farewell({ generationComplete: true, completionStarted: true }),
      RUN,
      EPOCH,
    )).toBe(false);
  });

  it("ignores a farewell from a stale run or a superseded epoch", () => {
    const ready = farewell({ generationComplete: true });
    expect(isFarewellReadyToFinish(ready, RUN + 1, EPOCH)).toBe(false);
    expect(isFarewellReadyToFinish(ready, RUN, EPOCH + 1)).toBe(false);
  });
});

describe("isCurrentFarewell", () => {
  it("matches only the farewell's own run and epoch", () => {
    expect(isCurrentFarewell(null, RUN, EPOCH)).toBe(false);
    expect(isCurrentFarewell(farewell(), RUN, EPOCH)).toBe(true);
    expect(isCurrentFarewell(farewell(), RUN + 1, EPOCH)).toBe(false);
    expect(isCurrentFarewell(farewell(), RUN, EPOCH + 1)).toBe(false);
  });
});

describe("isFarewellDrainCurrent", () => {
  it("accepts the drain of the current farewell batch", () => {
    expect(isFarewellDrainCurrent(farewell(), RUN, EPOCH, EPOCH)).toBe(true);
  });

  it("rejects drains after the farewell was cleared, cancelled or superseded", () => {
    expect(isFarewellDrainCurrent(null, RUN, EPOCH, EPOCH)).toBe(false);
    expect(isFarewellDrainCurrent(farewell(), RUN + 1, EPOCH, EPOCH)).toBe(false);
    expect(isFarewellDrainCurrent(farewell(), RUN, EPOCH - 1, EPOCH)).toBe(false);
    expect(isFarewellDrainCurrent(farewell(), RUN, EPOCH, EPOCH + 1)).toBe(false);
  });
});

describe("farewellCompletionDiagnostic", () => {
  it("names the completion path", () => {
    expect(farewellCompletionDiagnostic({ audioReceived: true })).toBe("FAREWELL_FLOW audio-drained");
    expect(farewellCompletionDiagnostic({ audioReceived: false })).toBe("FAREWELL_FLOW zero-audio");
  });
});
