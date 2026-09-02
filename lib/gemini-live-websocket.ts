import type { LiveServerMessage } from "@google/genai";
import type { PreparedLearningSource } from "./learning-source";
import { createLessonState, queryLessonState } from "./lesson-state";

const LIVE_WEBSOCKET_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

export const TUTOR_VOICE = "Kore";

type LiveCallbacks = {
  onMessage: (message: LiveServerMessage) => void;
  onError: (message: string) => void;
  onClose: (details: { code: number; reason: string }) => void;
};

type SetupConfig = {
  model: string;
  systemInstruction: string;
  resumptionHandle?: string;
};

type InitialSource = PreparedLearningSource & {
  focus: string;
};

function buildLiveSetup(config: SetupConfig) {
  return {
    model: `models/${config.model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: TUTOR_VOICE },
        },
      },
    },
    systemInstruction: {
      parts: [{ text: config.systemInstruction }],
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: config.resumptionHandle
      ? { handle: config.resumptionHandle }
      : {},
    contextWindowCompression: { slidingWindow: {} },
    historyConfig: { initialHistoryInClientContent: true },
    tools: [
      {
        functionDeclarations: [
          {
            name: "lesson_state",
            description:
              "Synchronize authoritative hierarchical lesson coverage and teaching-contract progress. After fully delivering one ordered teaching point, call progress for that point. Use navigate only for explicit learner-directed movement, skip for explicit subtree skipping, complete only after all teaching points are reported and the current atomic concept is meaningfully finished, and query for authoritative state. A successful complete automatically advances to the next eligible atomic concept.",
            parametersJsonSchema: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["navigate", "progress", "complete", "skip", "query"],
                },
                conceptId: {
                  type: "string",
                  description:
                    "Stable node ID from LESSON_TREE. Required for navigate, progress, complete, and skip.",
                },
                teachingPointIndex: {
                  type: "integer",
                  minimum: 0,
                  description:
                    "Zero-based teachingPoints array index just fully delivered. Required only for progress.",
                },
              },
              required: ["action"],
              additionalProperties: false,
            },
          },
          {
            name: "session_control",
            description:
              "Resolve the application's idle confirmation. Use only when the application has asked whether the learner wants to continue. Continue only for speech clearly directed to the tutor or a clear lesson request; end for a clear stop/finish response; otherwise use unclear.",
            parametersJsonSchema: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["continue", "end", "unclear"],
                },
              },
              required: ["action"],
              additionalProperties: false,
            },
          },
          {
            name: "update_teaching_preferences",
            description:
              "Update application-owned session teaching style only for a clearly ongoing request. speakingSpeed means physical spoken-word delivery, not lesson progression. Use it for requests to speak/talk slower or faster, never for requests to move through topics faster or spend less time on a concept. Do not persist a one-off request about only the current equation, sentence, example, explanation, repetition, or summary.",
            parametersJsonSchema: {
              type: "object",
              properties: {
                explanationDepth: {
                  type: "string",
                  enum: ["overview", "normal", "detailed"],
                },
                speakingSpeed: {
                  type: "string",
                  enum: ["slow", "normal", "fast"],
                  description: "Persistent qualitative speed of the tutor's spoken delivery.",
                },
              },
              minProperties: 1,
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  };
}

export class GeminiLiveWebSocket {
  private socket: WebSocket | null = null;

  constructor(private readonly callbacks: LiveCallbacks) {}

  connect(ephemeralToken: string, config: SetupConfig) {
    return new Promise<void>((resolve, reject) => {
      let setupComplete = false;
      const url = `${LIVE_WEBSOCKET_URL}?access_token=${encodeURIComponent(ephemeralToken)}`;
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      let incomingMessages = Promise.resolve();

      socket.onopen = () => {
        this.send({
          setup: buildLiveSetup(config),
        });
      };

      socket.onmessage = (event: MessageEvent<string | ArrayBuffer | Blob>) => {
        incomingMessages = incomingMessages
          .then(async () => {
            const payload = await decodeServerMessage(event.data);
            const message = JSON.parse(payload) as LiveServerMessage;

            if ("setupComplete" in message && !setupComplete) {
              setupComplete = true;
              resolve();
              return;
            }

            this.callbacks.onMessage(message);
          })
          .catch(() => {
            const message = "Gemini Live returned an unreadable server message";
            if (!setupComplete) {
              reject(new Error(message));
              return;
            }
            this.callbacks.onError(message);
          });
      };

      socket.onerror = () => {
        const message = "Gemini Live WebSocket error";
        if (!setupComplete) {
          reject(new Error(message));
          return;
        }
        this.callbacks.onError(message);
      };

      socket.onclose = (event) => {
        this.socket = null;
        if (!setupComplete) {
          reject(
            new Error(
              event.reason || `Gemini Live closed during setup (${event.code})`,
            ),
          );
          return;
        }
        this.callbacks.onClose({ code: event.code, reason: event.reason });
      };
    });
  }

  seedInitialSource(source: InitialSource) {
    const sourceType = source.mimeType === "application/pdf" ? "PDF" : "PLAIN_TEXT";
    const sourceIdentity = `The learner supplied an educational source named "${source.name}". Use it as the primary course reference for topics, terminology, notation, conventions, equations, examples, and teaching sequence. Relevant general knowledge may be used to clarify or extend the source, but never claim that outside knowledge came from the source. ${
      source.focus
        ? `The learner's requested focus is: ${source.focus}.`
        : "Teach the source's main topics."
    } This is initial history context; do not answer it as a standalone request.`;
    const initialCoverage = queryLessonState(
      createLessonState(source.focus || source.name, source.lessonTree),
    );
    const parts = [
      {
        text: `${sourceIdentity}\n\nSOURCE_FILENAME:\n${source.name}\n\nSOURCE_TYPE:\n${sourceType}\n\nSOURCE_POLICY:\nTreat this as the authoritative course reference. Use reliable general knowledge when it helps explain relevant gaps, identify when doing so where useful, and follow the source when conventions differ.\n\nLESSON_TREE:\n${JSON.stringify(source.lessonTree)}\n\nINITIAL_LESSON_COVERAGE:\n${JSON.stringify(initialCoverage)}\n\nBEGIN SOURCE_CONTENT\n${source.text}\nEND SOURCE_CONTENT`,
      },
    ];

    this.send({
      clientContent: {
        turns: [
          {
            role: "user",
            parts,
          },
        ],
        // With initialHistoryInClientContent enabled, this completes history
        // processing without triggering generation. Realtime input may begin
        // only after this history-completion marker has been sent.
        turnComplete: true,
      },
    });
  }

  seedRecoveryContext(source: InitialSource, lessonSnapshot: unknown) {
    const currentSource = source.mimeType === "application/pdf" ? "PDF" : "PLAIN_TEXT";
    this.send({
      clientContent: {
        turns: [{
          role: "user",
          parts: [{
            text: `RECOVERED_APPLICATION_CONTEXT. Continue the existing spoken lesson naturally; do not greet or restart it. The application lesson state below is authoritative.\n\nSOURCE_FILENAME:\n${source.name}\n\nSOURCE_TYPE:\n${currentSource}\n\nLESSON_STATE:\n${JSON.stringify(lessonSnapshot)}\n\nBEGIN SOURCE_CONTENT\n${source.text}\nEND SOURCE_CONTENT`,
          }],
        }],
        turnComplete: true,
      },
    });
  }

  sendRealtimeInput(input: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ realtimeInput: input }));
    return true;
  }

  sendLearnerText(text: string) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    }));
    return true;
  }

  sendToolResponse(functionResponses: Array<Record<string, unknown>>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ toolResponse: { functionResponses } }));
    return true;
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "Conversation stopped");
    }
  }

  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private send(message: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live WebSocket is not open");
    }
    this.socket.send(JSON.stringify(message));
  }
}

async function decodeServerMessage(data: string | ArrayBuffer | Blob) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return data.text();
}
