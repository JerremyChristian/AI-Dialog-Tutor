import { describe, expect, it } from "vitest";

import { ProviderTurnLedger } from "../../lib/provider-turn-ledger";

describe("ProviderTurnLedger", () => {
  it("opens a generation at its request and closes it at generationComplete then turnComplete", () => {
    const ledger = new ProviderTurnLedger();
    expect(ledger.outstandingThrough()).toBeNull();
    ledger.request();
    expect(ledger.outstandingThrough()).toBe(1);
    ledger.noteOutput();
    expect(ledger.outstandingThrough()).toBe(1);
    ledger.generationComplete();
    expect(ledger.outstandingThrough()).toBeNull();
    expect(ledger.turnComplete()).toBeNull();
    expect(ledger.outstandingThrough()).toBeNull();
  });

  it("an older turnComplete cannot close a newer overlapping request", () => {
    const ledger = new ProviderTurnLedger();
    ledger.request();
    ledger.noteOutput();
    const typedInterruption = ledger.outstandingThrough();
    ledger.request();
    ledger.closeAudioThrough(typedInterruption!);

    expect(ledger.turnComplete()).toBe(0);
    expect(ledger.outstandingThrough()).toBe(2);

    ledger.closeAudioThrough(ledger.outstandingThrough()!);
    expect(ledger.admitAudio()).toBe(false);
    expect(ledger.turnComplete()).toBe(1);
    expect(ledger.admitAudio()).toBe(true);
    expect(ledger.outstandingThrough()).toBeNull();
  });

  it("keeps audio closed until every interrupted request's turn has closed", () => {
    const ledger = new ProviderTurnLedger();
    ledger.request();
    ledger.request();
    ledger.closeAudioThrough(ledger.outstandingThrough()!);

    expect(ledger.turnComplete()).toBeNull();
    expect(ledger.admitAudio()).toBe(false);
    expect(ledger.turnComplete()).toBe(1);
    expect(ledger.admitAudio()).toBe(true);
  });

  it("reports nothing outstanding after generationComplete while local audio may still drain", () => {
    const ledger = new ProviderTurnLedger();
    ledger.request();
    ledger.noteOutput();
    ledger.generationComplete();
    expect(ledger.outstandingThrough()).toBeNull();
    expect(ledger.admitAudio()).toBe(true);
  });

  it("treats a turnComplete after a completed generation as closing it and the next open request", () => {
    // The completed request's trailing turnComplete never arrived; the next
    // boundary still closes the open request instead of failing closed.
    const ledger = new ProviderTurnLedger();
    ledger.request();
    ledger.generationComplete();
    ledger.request();
    ledger.closeAudioThrough(ledger.outstandingThrough()!);
    expect(ledger.turnComplete()).toBe(0);
    expect(ledger.outstandingThrough()).toBeNull();
  });

  it("opens an implicit generation for output with no open request", () => {
    const ledger = new ProviderTurnLedger();
    ledger.noteOutput();
    expect(ledger.outstandingThrough()).toBe(1);
    ledger.noteOutput();
    expect(ledger.outstandingThrough()).toBe(1);
  });

  it("ignores boundaries with nothing open", () => {
    const ledger = new ProviderTurnLedger();
    ledger.generationComplete();
    expect(ledger.turnComplete()).toBeNull();
    ledger.request();
    expect(ledger.outstandingThrough()).toBe(1);
  });

  it("retires every request and reopens audio when the owing socket is gone", () => {
    const ledger = new ProviderTurnLedger();
    ledger.request();
    ledger.request();
    ledger.closeAudioThrough(2);
    ledger.retireAll();
    expect(ledger.outstandingThrough()).toBeNull();
    expect(ledger.admitAudio()).toBe(true);
    ledger.request();
    expect(ledger.outstandingThrough()).toBe(3);
  });
});
