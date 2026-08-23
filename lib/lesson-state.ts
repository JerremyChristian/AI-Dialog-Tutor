export const GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
export const DEFAULT_LESSON_TOPIC = "Newton's laws of motion";

export type LessonStatus =
  | "idle"
  | "teaching"
  | "interrupted"
  | "resolving-interruption"
  | "resuming"
  | "completed";

export type LessonState = {
  topic: string;
  objective: string;
  status: LessonStatus;
  currentConcept: string;
  resumePoint: string;
  interruptionCount: number;
  lastUserTranscript: string;
  lastAssistantTranscript: string;
};

export function createLessonState(topic: string): LessonState {
  return {
    topic,
    objective: `Understand the core ideas of ${topic} through a concise spoken lesson.`,
    status: "idle",
    currentConcept: "Lesson introduction",
    resumePoint: "",
    interruptionCount: 0,
    lastUserTranscript: "",
    lastAssistantTranscript: "",
  };
}

export function buildLessonInstruction(topic: string) {
  return `You are conducting a spoken one-on-one lesson about: ${topic}.

Your job is to actively teach the learner, not merely wait for questions. Structure the topic into a small logical sequence and teach it progressively. Briefly state what the lesson will cover, then begin the first concept.

Use concise spoken explanations suitable for natural dialogue. Regularly pause to ask short understanding questions. Do not produce long monologues.

If the learner interrupts you, immediately give them the conversational floor and listen to their complete question. Answer it in the context of the current lesson. Resolve confusion before moving on. Do not restart the lesson. Once the interruption is addressed, naturally bridge back to the idea you were explaining and continue from that concept. Vary transitions such as "So, going back to what we were discussing...", "Right - with that cleared up, let's return to...", or "Exactly. Now, where we left off..." rather than repeating one mechanically.

If the learner says they understand, continue without unnecessary repetition. Teach conversationally and keep the lesson moving.`;
}

export function mergeTranscript(current: string, fragment: string) {
  const next = fragment.trim();
  if (!next) return current;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;

  const needsSpace = !/\s$/.test(current) && !/^[.,!?;:]/.test(next);
  return `${current}${needsSpace ? " " : ""}${next}`;
}

export function deriveConcept(transcript: string, fallback: string) {
  const concise = transcript.trim().replace(/\s+/g, " ");
  if (!concise) return fallback;

  const firstSentence = concise.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
  return truncate(firstSentence || concise, 140);
}

export function deriveResumePoint(transcript: string, fallback: string) {
  const concise = transcript.trim().replace(/\s+/g, " ");
  if (!concise) return fallback;

  const completeSentences = concise.match(/[^.!?]+[.!?]+/g);
  const semanticPoint = completeSentences?.at(-1)?.trim() || concise;
  return truncate(semanticPoint, 180);
}

function truncate(value: string, maximumLength: number) {
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, maximumLength - 3).trimEnd()}...`;
}
