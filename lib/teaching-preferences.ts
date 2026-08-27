export const EXPLANATION_DEPTHS = ["overview", "normal", "detailed"] as const;
export const SPEAKING_SPEEDS = ["slow", "normal", "fast"] as const;

export type ExplanationDepth = (typeof EXPLANATION_DEPTHS)[number];
export type SpeakingSpeed = (typeof SPEAKING_SPEEDS)[number];

export type TeachingPreferences = {
  explanationDepth: ExplanationDepth;
  speakingSpeed: SpeakingSpeed;
};

export const DEFAULT_TEACHING_PREFERENCES: TeachingPreferences = {
  explanationDepth: "normal",
  speakingSpeed: "normal",
};

export function isExplanationDepth(value: unknown): value is ExplanationDepth {
  return EXPLANATION_DEPTHS.includes(value as ExplanationDepth);
}

export function isSpeakingSpeed(value: unknown): value is SpeakingSpeed {
  return SPEAKING_SPEEDS.includes(value as SpeakingSpeed);
}

export function parseTeachingPreferences(value: unknown): TeachingPreferences | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!isExplanationDepth(candidate.explanationDepth) ||
      !isSpeakingSpeed(candidate.speakingSpeed)) return null;
  return {
    explanationDepth: candidate.explanationDepth,
    speakingSpeed: candidate.speakingSpeed,
  };
}

export function applyTeachingPreferenceUpdate(
  current: TeachingPreferences,
  update: Record<string, unknown>,
) {
  if (Object.keys(update).some(
    (key) => key !== "explanationDepth" && key !== "speakingSpeed",
  )) return null;
  const hasDepth = update.explanationDepth !== undefined;
  const hasSpeakingSpeed = update.speakingSpeed !== undefined;
  if (!hasDepth && !hasSpeakingSpeed) return null;
  if (hasDepth && !isExplanationDepth(update.explanationDepth)) return null;
  if (hasSpeakingSpeed && !isSpeakingSpeed(update.speakingSpeed)) return null;
  return {
    explanationDepth: hasDepth
      ? update.explanationDepth as ExplanationDepth
      : current.explanationDepth,
    speakingSpeed: hasSpeakingSpeed
      ? update.speakingSpeed as SpeakingSpeed
      : current.speakingSpeed,
  };
}

export function buildTeachingPreferenceInstruction(preferences: TeachingPreferences) {
  return `CURRENT TEACHING PREFERENCES

Explanation depth: ${preferences.explanationDepth}
Speaking speed: ${preferences.speakingSpeed}

These independent, application-owned preferences remain active until the learner explicitly requests an ongoing change.

Explanation depth:
- overview: teach the essential structure, intuition, definitions, important notation/equations, and why the concept matters concisely. Keep secondary elaboration brief, but still satisfy every required teaching-contract criterion.
- normal: use the existing balanced style with clear reasoning, helpful examples, important steps, and moderate conversational checking.
- detailed: unpack assumptions, intermediate reasoning, equations, notation, useful examples, and relevant distinctions without filler, repetition, or unrelated expansion.

Speaking speed controls the physical delivery of spoken words only, not lesson progression or explanation depth:
- slow: speak noticeably slower than normal Kore conversational speech. Articulate clearly, use a calm deliberate vocal cadence, and allow slightly longer natural pauses between phrases. Maintain this actual vocal delivery across every response.
- normal: use the tutor's current natural conversational speaking rate and cadence.
- fast: speak noticeably faster than normal with a more energetic, efficient vocal cadence and fewer long pauses, while remaining clear and intelligible.

Depth and speaking speed are independent. Slow speech must not reduce content or make lesson progression slower; fast speech must not skip or shorten required teaching. Neither preference permits skipping source concepts, required teaching points, completion criteria, or lesson-state transitions.

Teaching preferences survive every lesson-state transition. Navigation, roadmap navigation, lesson_state tool results, beginning a new teaching contract, completion, skipping, interruption, and resumption never reset them. After every authoritative lesson_state result, immediately apply its teachingPreferences to the very next spoken response and all later responses. In particular, when speakingSpeed is slow, the first words spoken for a newly selected concept must already use the noticeably slower vocal delivery; never drift back to normal at a concept boundary.

Use update_teaching_preferences for speaking speed only when the learner clearly requests an ongoing change to how fast you speak or talk, such as "speak slower", "you're talking too fast", or "use normal speaking speed again". Requests to move through topics faster, spend less time on a concept, move on, or take more time explaining concern lesson progression or local explanation—not speakingSpeed. Do not persist one-off requests such as "repeat that sentence more slowly" or "say the equation slower". Likewise, persist explanation-depth changes only when they are clearly ongoing. After a valid update, acknowledge it briefly and naturally without exposing tool or enum terminology.`;
}
