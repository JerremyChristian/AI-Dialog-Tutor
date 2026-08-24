import type { LiveServerMessage } from "@google/genai";
import type { PreparedLearningSource } from "./learning-source";

const LIVE_WEBSOCKET_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

type LiveCallbacks = {
  onMessage: (message: LiveServerMessage) => void;
  onError: (message: string) => void;
  onClose: (details: { code: number; reason: string }) => void;
};

type SetupConfig = {
  model: string;
  systemInstruction: string;
};

type InitialSource = PreparedLearningSource & {
  focus: string;
};

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
          setup: {
            model: `models/${config.model}`,
            generationConfig: { responseModalities: ["AUDIO"] },
            systemInstruction: {
              parts: [{ text: config.systemInstruction }],
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            historyConfig: { initialHistoryInClientContent: true },
          },
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
    const parts = [
      {
        text: `${sourceIdentity}\n\nSOURCE_FILENAME:\n${source.name}\n\nSOURCE_TYPE:\n${sourceType}\n\nSOURCE_POLICY:\nTreat this as the authoritative course reference. Use reliable general knowledge when it helps explain relevant gaps, identify when doing so where useful, and follow the source when conventions differ.\n\nBEGIN SOURCE_CONTENT\n${source.text}\nEND SOURCE_CONTENT`,
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

  sendRealtimeInput(input: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ realtimeInput: input }));
    return true;
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "Conversation stopped");
    }
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
