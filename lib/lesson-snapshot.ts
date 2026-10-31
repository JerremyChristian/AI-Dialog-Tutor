import type {
  LearningSource,
  LessonSource,
  PreparedLearningSource,
} from "./learning-source";
import {
  getCurrentConcept,
  getLessonTreeRows,
  type CoverageStatus,
  type LessonState,
} from "./lesson-state";
import {
  MAX_RECENT_TEACHING_CONTEXT_ENTRIES,
  MAX_RECENT_TEACHING_EXCERPT_LENGTH,
  SAVED_LESSON_SCHEMA_VERSION,
  getSavedLessonContentSignature,
  type RecentTeachingContextEntry,
  type SavedLesson,
} from "./local-persistence";
import type { TeachingPreferences } from "./teaching-preferences";

export type PersistedResumeContext = {
  currentConceptTitle: string | null;
  currentConceptStatus: CoverageStatus | null;
  resumePointAvailable: boolean;
  previousCoveredConceptTitle: string | null;
  recentTeachingContext: string[];
};

export function getPersistedResumeContext(
  state: LessonState,
  recentTeachingContext: RecentTeachingContextEntry[],
): PersistedResumeContext {
  const current = getCurrentConcept(state);
  const atomicConcepts = getLessonTreeRows(state)
    .map(({ node }) => node)
    .filter((node) => node.childrenIds.length === 0 && Boolean(node.teaching));
  const currentIndex = current
    ? atomicConcepts.findIndex((node) => node.id === current.id)
    : -1;
  const previousCovered = currentIndex > 0
    ? atomicConcepts.slice(0, currentIndex).reverse()
      .find((node) => node.status === "taught")
    : undefined;
  return {
    currentConceptTitle: current?.title ?? null,
    currentConceptStatus: current?.status ?? null,
    resumePointAvailable: Boolean(state.resumePoint.trim()),
    previousCoveredConceptTitle: previousCovered?.title ?? null,
    recentTeachingContext: current
      ? recentTeachingContext
        .filter((entry) => entry.conceptId === current.id)
        .map((entry) => entry.excerpt)
      : [],
  };
}

export function createRecentTeachingExcerpt(transcript: string) {
  const concise = transcript.trim().replace(/\s+/g, " ");
  if (!concise) return "";
  return concise.length <= MAX_RECENT_TEACHING_EXCERPT_LENGTH
    ? concise
    : `${concise.slice(0, MAX_RECENT_TEACHING_EXCERPT_LENGTH - 3).trimEnd()}...`;
}

/**
 * Returns the next recent-teaching-context entries, or null when nothing should change.
 * Entries for other concepts are dropped whenever a new excerpt is appended.
 */
export function appendRecentTeachingContext(
  entries: RecentTeachingContextEntry[],
  state: LessonState,
  conceptId: string | null,
  transcript: string,
): RecentTeachingContextEntry[] | null {
  if (!conceptId || !state.nodes[conceptId]) return null;
  const excerpt = createRecentTeachingExcerpt(transcript);
  if (!excerpt) return null;
  const matching = entries.filter((entry) => entry.conceptId === conceptId);
  if (matching.at(-1)?.excerpt === excerpt) return null;
  return [
    ...matching,
    { conceptId, excerpt },
  ].slice(-MAX_RECENT_TEACHING_CONTEXT_ENTRIES);
}

export type SavedLessonSnapshotInput = {
  id: string;
  prepared: PreparedLearningSource;
  source: LearningSource;
  lessonSources: LessonSource[];
  topicInput: string;
  hasStarted: boolean;
  state: LessonState;
  recentTeachingContext: RecentTeachingContextEntry[];
  teachingPreferences: TeachingPreferences;
  createdAt: string;
  previousUpdatedAt: string | null;
  previousContentSignature: string | null;
  cloudOwnerId: string | null;
  cloudSync: SavedLesson["cloudSync"];
  now: string;
};

export function buildSavedLessonSnapshot(input: SavedLessonSnapshotInput): SavedLesson {
  const { source, state, now } = input;
  const candidate = structuredClone<SavedLesson>({
    schemaVersion: SAVED_LESSON_SCHEMA_VERSION,
    id: input.id,
    title: source.name,
    lessonFocus: input.topicInput.trim(),
    hasStarted: input.hasStarted,
    source: {
      metadata: { ...source, status: "ready", error: undefined },
      prepared: input.prepared,
    },
    sources: input.lessonSources,
    lessonState: {
      ...state,
      // M6.1 persists lesson continuity, not conversation history.
      lastUserTranscript: "",
      lastAssistantTranscript: "",
    },
    recentTeachingContext: input.recentTeachingContext,
    teachingPreferences: input.teachingPreferences,
    createdAt: input.createdAt,
    updatedAt: input.previousUpdatedAt ?? now,
    cloudOwnerId: input.cloudOwnerId,
    ...(input.cloudSync ? { cloudSync: input.cloudSync } : {}),
  });
  const contentSignature = getSavedLessonContentSignature(candidate);
  candidate.updatedAt = input.previousContentSignature === contentSignature &&
    input.previousUpdatedAt
    ? input.previousUpdatedAt
    : now;
  return candidate;
}
