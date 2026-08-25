export type EngagementState = "active" | "possibly-idle" | "confirming" | "ended";

export const IDLE_AFTER_MS = 8 * 60_000;
export const IDLE_CONFIRMATION_MS = 60_000;
export const ENGAGEMENT_CHECK_INTERVAL_MS = 5_000;
export const ACOUSTIC_LOG_COOLDOWN_MS = 15_000;
export const NOISE_FLOOR_SMOOTHING = 0.02;
export const ACOUSTIC_ACTIVITY_MULTIPLIER = 2.5;
export const MIN_ACOUSTIC_RMS = 0.008;

const FILLER_ONLY = new Set([
  "ah", "er", "erm", "hmm", "hm", "mm", "mmm", "uh", "um",
]);

export function pcm16Rms(buffer: ArrayBuffer) {
  // Energy is supporting evidence only. It cannot identify who is speaking,
  // and television or nearby speech may look exactly like learner speech.
  const samples = new Int16Array(buffer);
  if (!samples.length) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = sample / 32_768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / samples.length);
}

export function isMeaningfulLearnerTranscript(value: string) {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}'-]+/gu, " ")
    .trim();
  if (!normalized) return false;
  const tokens = normalized.split(/\s+/);
  return tokens.some((token) => !FILLER_ONLY.has(token));
}
