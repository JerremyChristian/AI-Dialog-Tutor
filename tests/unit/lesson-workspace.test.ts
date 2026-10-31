import { describe, expect, it, vi } from "vitest";

import {
  cloudSyncStateAfterSummary,
  createImportCandidate,
  libraryRefreshDiagnostics,
  scopeLibrary,
  upsertLibraryLesson,
  workspaceHydrationSkipReason,
} from "../../lib/lesson-workspace";
import type { SavedLesson } from "../../lib/local-persistence";

// Only the fields these helpers read are populated; the rest of the snapshot
// shape is covered by lesson-snapshot.test.ts.
function lesson(
  id: string,
  overrides: Partial<SavedLesson> = {},
): SavedLesson {
  return {
    id,
    title: `Lesson ${id}`,
    updatedAt: "2026-10-01T00:00:00.000Z",
    lessonFocus: "focus",
    teachingPreferences: { explanationDepth: "balanced", speakingSpeed: "normal" },
    ...overrides,
  } as SavedLesson;
}

const OWNER = "owner-1";
const OTHER_OWNER = "owner-2";
const UUID = "11111111-1111-4111-8111-111111111111";
const NEW_ID = "22222222-2222-4222-8222-222222222222";

describe("workspaceHydrationSkipReason", () => {
  it("prefers an active lesson over a pending startup", () => {
    expect(workspaceHydrationSkipReason(true, true)).toBe("lesson-active");
    expect(workspaceHydrationSkipReason(true, false)).toBe("lesson-active");
  });

  it("reports a pending startup when no lesson is active", () => {
    expect(workspaceHydrationSkipReason(false, true)).toBe("startup-pending");
  });

  it("falls back to a stale request", () => {
    expect(workspaceHydrationSkipReason(false, false)).toBe("request-stale");
  });
});

describe("scopeLibrary", () => {
  const library = [
    lesson("anon-a"),
    lesson("anon-b", { cloudOwnerId: null }),
    lesson("owned-a", { cloudOwnerId: OWNER }),
    lesson("other-a", { cloudOwnerId: OTHER_OWNER }),
  ];

  it("scopes the anonymous workspace to unowned lessons and reports no local-only count", () => {
    const { scoped, localOnlyCount } = scopeLibrary(library, null);
    expect(scoped.map((item) => item.id)).toEqual(["anon-a", "anon-b"]);
    expect(localOnlyCount).toBe(0);
  });

  it("scopes a signed-in owner to their lessons and counts unowned local lessons", () => {
    const { scoped, localOnlyCount } = scopeLibrary(library, OWNER);
    expect(scoped.map((item) => item.id)).toEqual(["owned-a"]);
    expect(localOnlyCount).toBe(2);
  });

  it("preserves library order", () => {
    const ordered = [lesson("b", { cloudOwnerId: OWNER }), lesson("a", { cloudOwnerId: OWNER })];
    expect(scopeLibrary(ordered, OWNER).scoped.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("libraryRefreshDiagnostics", () => {
  it("emits the refresh, count and cache lines in order", () => {
    expect(libraryRefreshDiagnostics([lesson("a"), lesson("b")], "workspace-restore")).toEqual([
      "Library refreshed: reason=workspace-restore, activeLessonHydrated=no",
      "Saved lesson library loaded: 2 lessons",
      "Recent Lessons cache: scopedUniqueLessons=2",
    ]);
  });

  it("reports an empty library", () => {
    expect(libraryRefreshDiagnostics([], "workspace")).toEqual([
      "Library refreshed: reason=workspace, activeLessonHydrated=no",
      "Saved lesson library loaded: 0 lessons",
      "Recent Lessons cache: scopedUniqueLessons=0",
    ]);
  });

  it("counts unique ids separately from lesson entries", () => {
    const messages = libraryRefreshDiagnostics([lesson("a"), lesson("a")], "cloud-sync");
    expect(messages[1]).toBe("Saved lesson library loaded: 2 lessons");
    expect(messages[2]).toBe("Recent Lessons cache: scopedUniqueLessons=1");
  });

  it("adds one same-title line per duplicated title, in first-seen order", () => {
    const messages = libraryRefreshDiagnostics([
      lesson("a", { title: "Biology" }),
      lesson("b", { title: "Chemistry" }),
      lesson("c", { title: "Biology" }),
      lesson("d", { title: "Physics" }),
      lesson("e", { title: "Chemistry" }),
      lesson("f", { title: "Biology" }),
    ], "processing-ready");
    expect(messages.slice(3)).toEqual([
      "Recent Lessons same-title IDs: a,c,f",
      "Recent Lessons same-title IDs: b,e",
    ]);
  });

  it("adds no same-title line when titles are unique", () => {
    expect(libraryRefreshDiagnostics([lesson("a"), lesson("b")], "workspace")).toHaveLength(3);
  });
});

describe("upsertLibraryLesson", () => {
  it("replaces an existing entry with the same id instead of duplicating it", () => {
    const current = [
      lesson("a", { updatedAt: "2026-10-03T00:00:00.000Z", title: "Old" }),
      lesson("b", { updatedAt: "2026-10-02T00:00:00.000Z" }),
    ];
    const snapshot = lesson("a", { updatedAt: "2026-10-04T00:00:00.000Z", title: "New" });
    const next = upsertLibraryLesson(current, snapshot);
    expect(next.map((item) => item.id)).toEqual(["a", "b"]);
    expect(next[0]).toBe(snapshot);
  });

  it("inserts a new lesson and sorts by updatedAt descending", () => {
    const current = [
      lesson("newest", { updatedAt: "2026-10-05T00:00:00.000Z" }),
      lesson("oldest", { updatedAt: "2026-10-01T00:00:00.000Z" }),
    ];
    const snapshot = lesson("middle", { updatedAt: "2026-10-03T00:00:00.000Z" });
    expect(upsertLibraryLesson(current, snapshot).map((item) => item.id))
      .toEqual(["newest", "middle", "oldest"]);
  });

  it("keeps an unchanged updatedAt in place relative to newer lessons", () => {
    const current = [
      lesson("newer", { updatedAt: "2026-10-05T00:00:00.000Z" }),
      lesson("same", { updatedAt: "2026-10-02T00:00:00.000Z" }),
    ];
    const snapshot = lesson("same", { updatedAt: "2026-10-02T00:00:00.000Z" });
    expect(upsertLibraryLesson(current, snapshot).map((item) => item.id)).toEqual(["newer", "same"]);
  });

  it("does not mutate the current library", () => {
    const current = [lesson("a", { updatedAt: "2026-10-01T00:00:00.000Z" })];
    const copy = [...current];
    upsertLibraryLesson(current, lesson("b", { updatedAt: "2026-10-02T00:00:00.000Z" }));
    expect(current).toEqual(copy);
  });
});

describe("cloudSyncStateAfterSummary", () => {
  it("is pending while downloads are deferred", () => {
    expect(cloudSyncStateAfterSummary({ deferred: 1 })).toBe("pending");
    expect(cloudSyncStateAfterSummary({ deferred: 3 })).toBe("pending");
  });

  it("is synced when nothing was deferred", () => {
    expect(cloudSyncStateAfterSummary({ deferred: 0 })).toBe("synced");
  });
});

describe("createImportCandidate", () => {
  it("keeps a UUID id without generating a new one", () => {
    const createId = vi.fn(() => NEW_ID);
    const candidate = createImportCandidate(lesson(UUID), OWNER, {
      isUuid: (id) => id === UUID,
      createId,
    });
    expect(candidate.id).toBe(UUID);
    expect(createId).not.toHaveBeenCalled();
  });

  it("replaces a non-UUID id with a generated cloud-compatible id", () => {
    const createId = vi.fn(() => NEW_ID);
    const candidate = createImportCandidate(lesson("local-lesson"), OWNER, {
      isUuid: () => false,
      createId,
    });
    expect(candidate.id).toBe(NEW_ID);
    expect(createId).toHaveBeenCalledTimes(1);
  });

  it("assigns the owner and clears previous cloud sync metadata", () => {
    const candidate = createImportCandidate(lesson("local", {
      cloudOwnerId: null,
      cloudSync: {
        lastSyncedLocalUpdatedAt: "2026-10-01T00:00:00.000Z",
        lastKnownCloudUpdatedAt: "2026-10-01T00:00:00.000Z",
      },
    }), OWNER, { isUuid: () => false, createId: () => NEW_ID });
    expect(candidate.cloudOwnerId).toBe(OWNER);
    expect(candidate.cloudSync).toBeUndefined();
    expect("cloudSync" in candidate).toBe(true);
  });

  it("deep-copies the lesson without mutating the input", () => {
    const original = lesson("local", { cloudOwnerId: null });
    const before = structuredClone(original);
    const candidate = createImportCandidate(original, OWNER, {
      isUuid: () => false,
      createId: () => NEW_ID,
    });
    expect(original).toEqual(before);
    expect(candidate.teachingPreferences).toEqual(original.teachingPreferences);
    expect(candidate.teachingPreferences).not.toBe(original.teachingPreferences);
    expect(candidate.title).toBe(original.title);
    expect(candidate.lessonFocus).toBe(original.lessonFocus);
  });
});
