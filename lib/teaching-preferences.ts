export const EXPLANATION_DEPTHS = ["overview", "normal", "detailed"] as const;
export const TEACHING_PACES = ["slow", "normal", "fast"] as const;

export type ExplanationDepth = (typeof EXPLANATION_DEPTHS)[number];
export type TeachingPace = (typeof TEACHING_PACES)[number];

export type TeachingPreferences = {
  explanationDepth: ExplanationDepth;
  teachingPace: TeachingPace;
};

export const DEFAULT_TEACHING_PREFERENCES: TeachingPreferences = {
  explanationDepth: "normal",
  teachingPace: "normal",
};

export function isExplanationDepth(value: unknown): value is ExplanationDepth {
  return EXPLANATION_DEPTHS.includes(value as ExplanationDepth);
}

export function isTeachingPace(value: unknown): value is TeachingPace {
  return TEACHING_PACES.includes(value as TeachingPace);
}

export function parseTeachingPreferences(value: unknown): TeachingPreferences | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!isExplanationDepth(candidate.explanationDepth) ||
      !isTeachingPace(candidate.teachingPace)) return null;
  return {
    explanationDepth: candidate.explanationDepth,
    teachingPace: candidate.teachingPace,
  };
}

export function applyTeachingPreferenceUpdate(
  current: TeachingPreferences,
  update: Record<string, unknown>,
) {
  if (Object.keys(update).some(
    (key) => key !== "explanationDepth" && key !== "teachingPace",
  )) return null;
  const hasDepth = update.explanationDepth !== undefined;
  const hasPace = update.teachingPace !== undefined;
  if (!hasDepth && !hasPace) return null;
  if (hasDepth && !isExplanationDepth(update.explanationDepth)) return null;
  if (hasPace && !isTeachingPace(update.teachingPace)) return null;
  return {
    explanationDepth: hasDepth
      ? update.explanationDepth as ExplanationDepth
      : current.explanationDepth,
    teachingPace: hasPace
      ? update.teachingPace as TeachingPace
      : current.teachingPace,
  };
}

export function buildTeachingPreferenceInstruction(preferences: TeachingPreferences) {
  return `CURRENT TEACHING PREFERENCES

Explanation depth: ${preferences.explanationDepth}
Teaching pace: ${preferences.teachingPace}

These independent, application-owned preferences remain active until the learner explicitly requests an ongoing change.

Explanation depth:
- overview: teach the essential structure, intuition, definitions, important notation/equations, and why the concept matters concisely. Keep secondary elaboration brief, but still satisfy every required teaching-contract criterion.
- normal: use the existing balanced style with clear reasoning, helpful examples, important steps, and moderate conversational checking.
- detailed: unpack assumptions, intermediate reasoning, equations, notation, useful examples, and relevant distinctions without filler, repetition, or unrelated expansion.

Teaching pace:
- slow: present one main idea at a time in shorter spoken chunks, with deliberate sentences and room for interruption.
- normal: use the tutor's natural conversational cadence.
- fast: use denser chunks, quicker transitions, and fewer redundant pauses or confirmations while remaining intelligible.

Depth and pace are independent. Neither preference permits skipping source concepts, required teaching points, completion criteria, or lesson-state transitions. Preferences change HOW a teaching contract is delivered, never WHAT must be taught.

Use update_teaching_preferences only for clearly ongoing/session-level requests such as "go slower", "from now on give more detail", or "keep things concise". Do not update persistent preferences for a local request about only the last equation, sentence, example, explanation, or summary. After a valid update, acknowledge it briefly and naturally without exposing tool or enum terminology.`;
}
