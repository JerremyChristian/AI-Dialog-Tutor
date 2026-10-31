import type { CloudSyncState, CloudSyncSummary } from "./cloud-sync";
import type { SavedLesson } from "./local-persistence";

// Pure lesson-workspace decisions lifted from the page so they can be tested
// without IndexedDB or Supabase. Callers keep their own side effects and
// debug-message templates; these functions only compute values.

export type WorkspaceHydrationSkipReason = "lesson-active" | "startup-pending" | "request-stale";

/** Reason logged when a workspace hydration is refused. An active lesson wins over a pending startup. */
export function workspaceHydrationSkipReason(
  lessonActive: boolean,
  startupPending: boolean,
): WorkspaceHydrationSkipReason {
  return lessonActive ? "lesson-active" : startupPending ? "startup-pending" : "request-stale";
}

/** Library lessons visible to `ownerId`, plus the unowned count shown to a signed-in owner. */
export function scopeLibrary(library: SavedLesson[], ownerId: string | null) {
  const scoped = library.filter((lesson) => (lesson.cloudOwnerId ?? null) === ownerId);
  const localOnlyCount = ownerId
    ? library.filter((lesson) => !lesson.cloudOwnerId).length
    : 0;
  return { scoped, localOnlyCount };
}

/** Debug messages logged after a library refresh, in emission order. */
export function libraryRefreshDiagnostics(scoped: SavedLesson[], reason: string) {
  const messages = [
    `Library refreshed: reason=${reason}, activeLessonHydrated=no`,
    `Saved lesson library loaded: ${scoped.length} lessons`,
    `Recent Lessons cache: scopedUniqueLessons=${new Set(scoped.map((lesson) => lesson.id)).size}`,
  ];
  const titleIds = new Map<string, string[]>();
  scoped.forEach((lesson) => {
    titleIds.set(lesson.title, [...(titleIds.get(lesson.title) ?? []), lesson.id]);
  });
  titleIds.forEach((ids) => {
    if (ids.length > 1) messages.push(`Recent Lessons same-title IDs: ${ids.join(",")}`);
  });
  return messages;
}

/** Replaces or inserts `snapshot`, newest `updatedAt` first. */
export function upsertLibraryLesson(current: SavedLesson[], snapshot: SavedLesson) {
  return [
    snapshot,
    ...current.filter((lesson) => lesson.id !== snapshot.id),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Sync state after an upload or manual reconciliation (not the initial reconciliation). */
export function cloudSyncStateAfterSummary(
  summary: Pick<CloudSyncSummary, "deferred">,
): Extract<CloudSyncState, "pending" | "synced"> {
  return summary.deferred > 0 ? "pending" : "synced";
}

/**
 * Copy of an unowned local lesson prepared for association with `ownerId`.
 * UUID ids are kept; other ids get a new cloud-compatible id from `createId`.
 */
export function createImportCandidate(
  lesson: SavedLesson,
  ownerId: string,
  ids: { isUuid: (id: string) => boolean; createId: () => string },
): SavedLesson {
  const cloudId = ids.isUuid(lesson.id) ? lesson.id : ids.createId();
  return {
    ...structuredClone(lesson),
    id: cloudId,
    cloudOwnerId: ownerId,
    cloudSync: undefined,
  };
}
