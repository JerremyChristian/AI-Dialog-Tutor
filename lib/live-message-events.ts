import type { LiveServerMessage } from "@google/genai";

// Provider boundary for Gemini Live server messages. The normalizer only reads
// the raw message and returns domain events; all side effects stay with the
// consumer. Event order is the processing order the consumer must follow, and
// some same-message behavior depends on it (for example ACTIVITY_START gating
// must precede `interrupted`).
export type LiveProviderMessage = LiveServerMessage;

export type LiveToolCall = {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
};

export type LiveVoiceActivity = "start" | "end";

export type LiveEvent =
  | { type: "tool-call-cancellation"; ids: string[] }
  // Terminal: no further events are produced for a message carrying tool calls.
  | { type: "tool-calls"; calls: LiveToolCall[] }
  // Transport gating; precedes transcription and interruption handling.
  | { type: "voice-activity-gate"; activity: LiveVoiceActivity }
  | { type: "input-transcription"; text: string }
  | { type: "interim-input-transcription"; text: string }
  | { type: "learner-draft-closed" }
  | { type: "output-transcription"; text: string }
  | { type: "interrupted" }
  // Lesson status/debug updates for voice activity; follows interruption handling.
  | { type: "voice-activity-status"; activity: LiveVoiceActivity }
  | { type: "audio-chunk"; data: string; mimeType: string }
  // Follows the message's audio, so audio carried alongside turnComplete still
  // belongs to the turn it closes. An interrupted turn ends interrupted >
  // turnComplete without generationComplete.
  | { type: "turn-complete" }
  // Always the final event, so an early return while handling it skips nothing.
  | { type: "generation-complete" };

function toVoiceActivity(message: LiveServerMessage): LiveVoiceActivity | null {
  const voiceActivity = message.voiceActivity?.voiceActivityType;
  if (voiceActivity === "ACTIVITY_START") return "start";
  if (voiceActivity === "ACTIVITY_END") return "end";
  return null;
}

export function normalizeLiveServerMessage(message: LiveServerMessage): LiveEvent[] {
  const events: LiveEvent[] = [];

  if (message.toolCallCancellation?.ids) {
    events.push({ type: "tool-call-cancellation", ids: [...message.toolCallCancellation.ids] });
  }

  if (message.toolCall?.functionCalls?.length) {
    events.push({
      type: "tool-calls",
      calls: message.toolCall.functionCalls.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.args,
      })),
    });
    return events;
  }

  const serverContent = message.serverContent;
  const voiceActivity = toVoiceActivity(message);

  if (voiceActivity) events.push({ type: "voice-activity-gate", activity: voiceActivity });

  if (serverContent?.inputTranscription?.text) {
    events.push({ type: "input-transcription", text: serverContent.inputTranscription.text });
  } else if (serverContent?.interimInputTranscription?.text) {
    events.push({
      type: "interim-input-transcription",
      text: serverContent.interimInputTranscription.text,
    });
  }
  if (serverContent?.inputTranscription?.finished ||
      voiceActivity === "end" || serverContent?.turnComplete) {
    events.push({ type: "learner-draft-closed" });
  }

  if (serverContent?.outputTranscription?.text) {
    events.push({ type: "output-transcription", text: serverContent.outputTranscription.text });
  }

  if (serverContent?.interrupted) events.push({ type: "interrupted" });

  if (voiceActivity) events.push({ type: "voice-activity-status", activity: voiceActivity });

  if (!serverContent) return events;

  for (const part of serverContent.modelTurn?.parts ?? []) {
    const audio = part.inlineData;
    if (!audio?.data || !audio.mimeType?.startsWith("audio/")) continue;
    events.push({ type: "audio-chunk", data: audio.data, mimeType: audio.mimeType });
  }

  if (serverContent.turnComplete) events.push({ type: "turn-complete" });

  if (serverContent.generationComplete) events.push({ type: "generation-complete" });

  return events;
}
