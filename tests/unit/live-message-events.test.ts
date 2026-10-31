import { describe, expect, it } from "vitest";

import {
  normalizeLiveServerMessage,
  type LiveEvent,
  type LiveProviderMessage,
} from "../../lib/live-message-events";

function message(raw: Record<string, unknown>): LiveProviderMessage {
  return raw as unknown as LiveProviderMessage;
}

function types(events: LiveEvent[]) {
  return events.map((event) => event.type);
}

describe("normalizeLiveServerMessage", () => {
  it("returns no events for an empty message", () => {
    expect(normalizeLiveServerMessage(message({}))).toEqual([]);
  });

  it("orders ACTIVITY_START gating before interrupted, and status after", () => {
    const events = normalizeLiveServerMessage(message({
      voiceActivity: { voiceActivityType: "ACTIVITY_START" },
      serverContent: { interrupted: true },
    }));

    expect(events).toEqual([
      { type: "voice-activity-gate", activity: "start" },
      { type: "interrupted" },
      { type: "voice-activity-status", activity: "start" },
    ]);
  });

  it("emits interrupted alone without inventing learner activity", () => {
    expect(normalizeLiveServerMessage(message({ serverContent: { interrupted: true } })))
      .toEqual([{ type: "interrupted" }]);
  });

  it("closes the learner draft on ACTIVITY_END between gating and status", () => {
    expect(types(normalizeLiveServerMessage(message({
      voiceActivity: { voiceActivityType: "ACTIVITY_END" },
    })))).toEqual(["voice-activity-gate", "learner-draft-closed", "voice-activity-status"]);
  });

  it("ignores unrecognized voice activity types", () => {
    expect(normalizeLiveServerMessage(message({
      voiceActivity: { voiceActivityType: "TYPE_UNSPECIFIED" },
    }))).toEqual([]);
  });

  describe("tool calls", () => {
    it("emits tool-call cancellation ids first", () => {
      expect(normalizeLiveServerMessage(message({
        toolCallCancellation: { ids: ["call-1", "call-2"] },
        serverContent: { interrupted: true },
      }))).toEqual([
        { type: "tool-call-cancellation", ids: ["call-1", "call-2"] },
        { type: "interrupted" },
      ]);
    });

    it("emits cancellation before tool calls in the same message", () => {
      expect(types(normalizeLiveServerMessage(message({
        toolCallCancellation: { ids: ["old"] },
        toolCall: { functionCalls: [{ id: "new", name: "lesson_state", args: {} }] },
      })))).toEqual(["tool-call-cancellation", "tool-calls"]);
    });

    it("short-circuits every later field when tool calls are present", () => {
      const events = normalizeLiveServerMessage(message({
        toolCall: {
          functionCalls: [
            { id: "a", name: "lesson_state", args: { action: "query" } },
            { id: "b", name: "session_control", args: { action: "end" } },
          ],
        },
        voiceActivity: { voiceActivityType: "ACTIVITY_START" },
        serverContent: {
          inputTranscription: { text: "wait", finished: true },
          outputTranscription: { text: "Hello" },
          interrupted: true,
          modelTurn: { parts: [{ inlineData: { data: "AAA=", mimeType: "audio/pcm" } }] },
          generationComplete: true,
          turnComplete: true,
        },
      }));

      expect(events).toEqual([{
        type: "tool-calls",
        calls: [
          { id: "a", name: "lesson_state", args: { action: "query" } },
          { id: "b", name: "session_control", args: { action: "end" } },
        ],
      }]);
    });

    it("does not short-circuit on an empty function call list", () => {
      expect(types(normalizeLiveServerMessage(message({
        toolCall: { functionCalls: [] },
        serverContent: { interrupted: true },
      })))).toEqual(["interrupted"]);
    });

    it("passes tool calls with missing ids or names through unchanged", () => {
      expect(normalizeLiveServerMessage(message({
        toolCall: { functionCalls: [{ args: { action: "query" } }] },
      }))).toEqual([{
        type: "tool-calls",
        calls: [{ id: undefined, name: undefined, args: { action: "query" } }],
      }]);
    });
  });

  describe("input transcription", () => {
    it("emits final input transcription and closes the draft when finished", () => {
      expect(normalizeLiveServerMessage(message({
        serverContent: { inputTranscription: { text: "what is a PLC", finished: true } },
      }))).toEqual([
        { type: "input-transcription", text: "what is a PLC" },
        { type: "learner-draft-closed" },
      ]);
    });

    it("prefers final transcription over interim in the same message", () => {
      expect(normalizeLiveServerMessage(message({
        serverContent: {
          inputTranscription: { text: "final" },
          interimInputTranscription: { text: "interim" },
        },
      }))).toEqual([{ type: "input-transcription", text: "final" }]);
    });

    it("falls back to interim transcription when final text is empty", () => {
      expect(normalizeLiveServerMessage(message({
        serverContent: {
          inputTranscription: { text: "" },
          interimInputTranscription: { text: "wai" },
        },
      }))).toEqual([{ type: "interim-input-transcription", text: "wai" }]);
    });

    it("closes the draft on finished input or turnComplete without text", () => {
      expect(types(normalizeLiveServerMessage(message({
        serverContent: { inputTranscription: { finished: true } },
      })))).toEqual(["learner-draft-closed"]);
      expect(types(normalizeLiveServerMessage(message({
        serverContent: { turnComplete: true },
      })))).toEqual(["learner-draft-closed", "turn-complete"]);
    });

    it("emits a single draft close when several close conditions coincide", () => {
      expect(types(normalizeLiveServerMessage(message({
        voiceActivity: { voiceActivityType: "ACTIVITY_END" },
        serverContent: { inputTranscription: { finished: true }, turnComplete: true },
      })))).toEqual(["voice-activity-gate", "learner-draft-closed", "voice-activity-status", "turn-complete"]);
    });
  });

  it("emits output transcription after input handling and before interrupted", () => {
    expect(normalizeLiveServerMessage(message({
      serverContent: {
        interrupted: true,
        outputTranscription: { text: "A PLC is" },
        inputTranscription: { text: "wait" },
      },
    }))).toEqual([
      { type: "input-transcription", text: "wait" },
      { type: "output-transcription", text: "A PLC is" },
      { type: "interrupted" },
    ]);
  });

  it("extracts only audio parts with data, in order", () => {
    const events = normalizeLiveServerMessage(message({
      serverContent: {
        modelTurn: {
          parts: [
            { text: "ignored text part" },
            { inlineData: { data: "first", mimeType: "audio/pcm;rate=24000" } },
            { inlineData: { data: "image", mimeType: "image/png" } },
            { inlineData: { data: "", mimeType: "audio/pcm" } },
            { inlineData: { data: "nomime" } },
            { inlineData: { data: "second", mimeType: "audio/pcm;rate=24000" } },
          ],
        },
      },
    }));

    expect(events).toEqual([
      { type: "audio-chunk", data: "first", mimeType: "audio/pcm;rate=24000" },
      { type: "audio-chunk", data: "second", mimeType: "audio/pcm;rate=24000" },
    ]);
  });

  it("emits generationComplete after audio parts", () => {
    expect(types(normalizeLiveServerMessage(message({
      serverContent: {
        generationComplete: true,
        modelTurn: { parts: [{ inlineData: { data: "x", mimeType: "audio/pcm" } }] },
      },
    })))).toEqual(["audio-chunk", "generation-complete"]);
  });

  it("emits turnComplete after the audio it carries and before generationComplete", () => {
    expect(types(normalizeLiveServerMessage(message({
      serverContent: {
        turnComplete: true,
        interrupted: true,
        modelTurn: { parts: [{ inlineData: { data: "x", mimeType: "audio/pcm" } }] },
      },
    })))).toEqual(["learner-draft-closed", "interrupted", "audio-chunk", "turn-complete"]);
  });

  it("emits generationComplete alone without any commit-like event", () => {
    expect(normalizeLiveServerMessage(message({ serverContent: { generationComplete: true } })))
      .toEqual([{ type: "generation-complete" }]);
  });

  it("preserves the full processing order for a message carrying every field", () => {
    const events = normalizeLiveServerMessage(message({
      toolCallCancellation: { ids: ["stale"] },
      voiceActivity: { voiceActivityType: "ACTIVITY_START" },
      serverContent: {
        generationComplete: true,
        modelTurn: { parts: [{ inlineData: { data: "pcm", mimeType: "audio/pcm" } }] },
        interrupted: true,
        outputTranscription: { text: "tutor" },
        turnComplete: true,
        inputTranscription: { text: "learner", finished: true },
      },
    }));

    expect(types(events)).toEqual([
      "tool-call-cancellation",
      "voice-activity-gate",
      "input-transcription",
      "learner-draft-closed",
      "output-transcription",
      "interrupted",
      "voice-activity-status",
      "audio-chunk",
      "turn-complete",
      "generation-complete",
    ]);
  });

  it("keeps generationComplete last so the farewell early return skips nothing else", () => {
    // The page returns from handleLiveMessage inside generation-complete when a
    // stale farewell turn is pending. That is only equivalent to the original
    // early return if no event can follow generation-complete.
    const events = normalizeLiveServerMessage(message({
      voiceActivity: { voiceActivityType: "ACTIVITY_END" },
      serverContent: {
        generationComplete: true,
        turnComplete: true,
        outputTranscription: { text: "Goodbye!" },
        modelTurn: { parts: [{ inlineData: { data: "bye", mimeType: "audio/pcm" } }] },
      },
    }));

    expect(events.at(-1)).toEqual({ type: "generation-complete" });
    expect(events.filter((event) => event.type === "generation-complete")).toHaveLength(1);
    expect(types(events)).toEqual([
      "voice-activity-gate",
      "learner-draft-closed",
      "output-transcription",
      "voice-activity-status",
      "audio-chunk",
      "turn-complete",
      "generation-complete",
    ]);
  });

  it("does not mutate the provider message", () => {
    const raw = {
      toolCallCancellation: { ids: ["a"] },
      serverContent: {
        inputTranscription: { text: "hi" },
        modelTurn: { parts: [{ inlineData: { data: "x", mimeType: "audio/pcm" } }] },
        generationComplete: true,
      },
    };
    const before = JSON.stringify(raw);
    const events = normalizeLiveServerMessage(message(raw));
    expect(JSON.stringify(raw)).toBe(before);

    const cancellation = events[0];
    if (cancellation.type !== "tool-call-cancellation") throw new Error("expected cancellation");
    expect(cancellation.ids).not.toBe(raw.toolCallCancellation.ids);
  });
});
