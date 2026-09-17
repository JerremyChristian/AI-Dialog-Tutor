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
const SERIALIZED_TOOL_PATTERN = new RegExp(
  `(?:${TOOL_NAMES.map(escapeRegExp).join("|")})\\s*\\{[^{}\\r\\n]*\\}`,
  "g",
);

/** Removes only application syntax known to the current Gemini Live contract. */
export function sanitizeLearnerVisibleTutorTranscript(value: string) {
  return value
    .replace(APP_CONTROL_PATTERN, "")
    .replace(SERIALIZED_TOOL_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
