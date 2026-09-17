const APP_CONTROL_NAMES = [
  "TEACH_PRESENTATION_BEAT",
  "IDLE_CONFIRMATION",
  "PERSISTED_LESSON_RESUME:RECAP_THEN_RESUME_LOCATION_THEN_CONTINUE_TEACHING;DO_NOT_ASK_WHAT_TO_COVER",
  "POST_RESUME_SYNC",
  "CONTINUE_INTERRUPTED_TUTOR_TURN",
  "LESSON_STATE_RECOVERY",
  "LESSON_WRAP_UP",
  "TEST_INVALID_ID",
] as const;

const TOOL_NAMES = [
  "lesson_state",
  "session_control",
  "update_teaching_preferences",
] as const;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const APP_CONTROL_PATTERN = new RegExp(
  `\\[\\[APP_CONTROL:(?:${APP_CONTROL_NAMES.map(escapeRegExp).join("|")})\\]\\]`,
  "g",
);
const TEACH_PRESENTATION_MARKER = "[[APP_CONTROL:TEACH_PRESENTATION_BEAT]]";
const TEACH_PRESENTATION_ENDINGS = [
  "Establish the unit naturally.",
  "Continue directly from the preceding explanation without greeting, praise, announcing a new section, or unnecessary recap.",
  "This is the final beat of a bounded node review. Briefly check whether the learner has questions or is ready to return to the main lesson. Do not continue into another concept and do not describe this review as new canonical progress.",
  "This review continues after this beat. Do not ask a question, invite learner interaction, or create a check-in merely because a delivery unit ended; finish with natural continuity because the application will immediately assign the next review beat.",
  "Do not ask a question or invite learner interaction at the end; finish with natural continuity because the application will immediately assign the next beat.",
];
const TEACH_PRESENTATION_LINE_END = /\n(?:Establish the unit naturally\.|Continue directly from the preceding explanation|This is the final beat of a bounded node review\.|This review continues after this beat\.|All planned lesson content will be covered after this beat\.|Briefly synthesize if useful,|Do not ask a question or invite learner interaction at the end;)[^\n]*/g;
const SERIALIZED_TOOL_PATTERN = new RegExp(
  `(?:${TOOL_NAMES.map(escapeRegExp).join("|")})\\s*\\{[^{}\\r\\n]*\\}`,
  "g",
);

/** Removes only application syntax known to the current Gemini Live contract. */
export function sanitizeLearnerVisibleTutorTranscript(value: string) {
  const normalized = value.replace(/\[\[APP_CONTROL\\:/g, "[[APP_CONTROL:");
  let sanitized = stripTeachingPresentationControl(normalized);
  sanitized = sanitized
    .replace(APP_CONTROL_PATTERN, "")
    .replace(SERIALIZED_TOOL_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return sanitized;
}

function stripTeachingPresentationControl(value: string) {
  let output = "";
  let cursor = 0;
  while (true) {
    const markerIndex = value.indexOf(TEACH_PRESENTATION_MARKER, cursor);
    if (markerIndex < 0) return output + value.slice(cursor);
    output += value.slice(cursor, markerIndex);
    const payloadStart = markerIndex + TEACH_PRESENTATION_MARKER.length;
    const criteriaIndex = value.indexOf("RELEVANT_COMPLETION_CRITERIA:", payloadStart);
    const endingSearchStart = criteriaIndex >= 0
      ? value.indexOf("\n", criteriaIndex) + 1
      : payloadStart;
    const exactEnding = TEACH_PRESENTATION_ENDINGS
      .map((ending) => ({ ending, index: value.indexOf(ending, endingSearchStart) }))
      .filter(({ index }) => index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    TEACH_PRESENTATION_LINE_END.lastIndex = endingSearchStart;
    const lineEndingMatch = TEACH_PRESENTATION_LINE_END.exec(value);
    const lineEnding = lineEndingMatch
      ? { index: lineEndingMatch.index, ending: lineEndingMatch[0] }
      : undefined;
    const endingIndex = exactEnding && lineEnding
      ? exactEnding.index <= lineEnding.index ? exactEnding : lineEnding
      : exactEnding || lineEnding;
    if (!endingIndex) return output;
    cursor = endingIndex.index + endingIndex.ending.length;
  }
}
