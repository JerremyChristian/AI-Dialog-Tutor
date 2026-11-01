// Normalizes Live provider->app frames into evidence events. Audio payload bytes
// are dropped (only mime type and byte length survive) and anything that looks
// like a credential is redacted, so a packet can be saved and shared safely.

export type NormalizedProviderEvent = { name: string; detail?: Record<string, unknown> };

const SECRET_KEY_PATTERN = /^(access_?token|token|api_?key|key|authorization|secret|password)$/i;
// Header-style names whose last `-`/`_` segment is sensitive, e.g. X-Custom-Auth, x-goog-api-key.
const SECRET_KEY_SUFFIX_PATTERN = /[-_](auth|authorization|api[-_]?key|token|secret|password|cookie|credentials?)$/i;
const SECRET_QUERY_PATTERN = /([?&](?:access_token|key|token)=)[^&\s"]+/gi;
const EPHEMERAL_TOKEN_PATTERN = /\bauth_tokens\/[A-Za-z0-9._-]+/g;
// An HTTP auth scheme followed by a credential-shaped value: 8+ token chars that
// include a digit, or 20+ token chars. Prose such as "Bearer tokens are used
// for authorization" has no such value and is left intact.
const AUTH_SCHEME_CREDENTIAL_PATTERN =
  /\b(Bearer|Basic)\s+(?:(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{8,}|[A-Za-z0-9._~+/-]{20,})=*/gi;

export const REDACTED = "[redacted]";

const isSecretKey = (key: string) => SECRET_KEY_PATTERN.test(key) || SECRET_KEY_SUFFIX_PATTERN.test(key);

/**
 * Deep-copies a JSON value, redacting secret-named fields, secret query
 * parameters and auth-scheme credentials wherever they appear as values.
 */
export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replace(SECRET_QUERY_PATTERN, `$1${REDACTED}`)
      .replace(EPHEMERAL_TOKEN_PATTERN, `auth_tokens/${REDACTED}`)
      .replace(AUTH_SCHEME_CREDENTIAL_PATTERN, `$1 ${REDACTED}`) as T;
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      isSecretKey(key) ? REDACTED : redactSecrets(item),
    ])) as T;
  }
  return value;
}

function base64ByteLength(data: unknown) {
  if (typeof data !== "string") return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

type Record_ = Record<string, unknown>;
const asRecord = (value: unknown): Record_ | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record_ : undefined;

/**
 * One frame can carry several facts; they are emitted in the order the app
 * processes them: voice activity, interruption, audio, transcriptions, then
 * completion markers and tool calls.
 */
export function normalizeProviderFrame(body: Record<string, unknown>): NormalizedProviderEvent[] {
  const events: NormalizedProviderEvent[] = [];
  const known = new Set(["setupComplete", "serverContent", "voiceActivity", "toolCall", "toolCallCancellation"]);

  if (body.setupComplete !== undefined) events.push({ name: "provider.setup-complete" });

  const voiceActivity = asRecord(body.voiceActivity);
  if (voiceActivity) {
    events.push({ name: "provider.voice-activity", detail: { type: voiceActivity.voiceActivityType ?? null } });
  }

  const content = asRecord(body.serverContent);
  if (content) {
    if (content.interrupted === true) events.push({ name: "provider.interrupted" });
    const parts = asRecord(content.modelTurn)?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const inline = asRecord(asRecord(part)?.inlineData);
        if (inline) {
          events.push({
            name: "provider.audio",
            detail: { mimeType: inline.mimeType ?? null, bytes: base64ByteLength(inline.data) },
          });
        } else if (typeof asRecord(part)?.text === "string") {
          events.push({ name: "provider.model-text", detail: { text: asRecord(part)!.text } });
        }
      }
    }
    const output = asRecord(content.outputTranscription);
    if (typeof output?.text === "string") {
      events.push({ name: "provider.output-transcription", detail: { text: output.text } });
    }
    const input = asRecord(content.inputTranscription);
    if (typeof input?.text === "string") {
      events.push({
        name: "provider.input-transcription",
        detail: { text: input.text, finished: input.finished === true },
      });
    }
    if (content.generationComplete === true) events.push({ name: "provider.generation-complete" });
    if (content.turnComplete === true) events.push({ name: "provider.turn-complete" });
  }

  const toolCall = asRecord(body.toolCall);
  if (toolCall && Array.isArray(toolCall.functionCalls)) {
    events.push({
      name: "provider.tool-call",
      detail: {
        calls: toolCall.functionCalls.map((call) => {
          const record = asRecord(call) ?? {};
          return { id: record.id ?? null, name: record.name ?? null, args: redactSecrets(record.args ?? {}) };
        }),
      },
    });
  }
  const cancellation = asRecord(body.toolCallCancellation);
  if (cancellation) events.push({ name: "provider.tool-call-cancellation", detail: { ids: cancellation.ids ?? [] } });

  const usage = asRecord(body.usageMetadata);
  if (usage) events.push({ name: "provider.usage", detail: redactSecrets(usage) });

  const otherKeys = Object.keys(body).filter((key) => !known.has(key) && key !== "usageMetadata");
  if (otherKeys.length) events.push({ name: "provider.other", detail: { keys: otherKeys } });
  return events;
}
