import { describe, expect, it } from "vitest";

import type {
  AtomicTeachingContract,
  LearningSource,
  LessonSource,
  LessonTreeItem,
  PreparedLearningSource,
} from "../../lib/learning-source";
import {
  createLessonState,
  type LessonState,
} from "../../lib/lesson-state";
import {
  appendRecentTeachingContext,
  buildSavedLessonSnapshot,
  createRecentTeachingExcerpt,
  getPersistedResumeContext,
  type SavedLessonSnapshotInput,
} from "../../lib/lesson-snapshot";
import {
  MAX_RECENT_TEACHING_CONTEXT_ENTRIES,
  MAX_RECENT_TEACHING_EXCERPT_LENGTH,
  SAVED_LESSON_SCHEMA_VERSION,
  getSavedLessonContentSignature,
  parseSavedLesson,
  type RecentTeachingContextEntry,
} from "../../lib/local-persistence";
import type { TeachingPreferences } from "../../lib/teaching-preferences";

function contract(): AtomicTeachingContract {
  return {
    objective: "Understand the concept",
    teachingPoints: ["Point 1", "Point 2"],
    completionCriteria: ["Can explain it"],
    type: "concept",
    importance: "core",
  };
}

function lessonTree(): LessonTreeItem[] {
  return [
    { id: "module", title: "Module", parentId: null, order: 1 },
    { id: "module.first", title: "First", parentId: "module", order: 1, teaching: contract() },
    { id: "module.second", title: "Second", parentId: "module", order: 2, teaching: contract() },
    { id: "module.third", title: "Third", parentId: "module", order: 3, teaching: contract() },
  ];
}

function lessonState(): LessonState {
  return createLessonState("Snapshot", lessonTree());
}

function withStatuses(
  state: LessonState,
  currentNodeId: string,
  statuses: Record<string, LessonState["nodes"][string]["status"]>,
): LessonState {
  const nodes = { ...state.nodes };
  for (const [id, status] of Object.entries(statuses)) {
    nodes[id] = { ...nodes[id], status };
  }
  return { ...state, currentNodeId, nodes };
}

const LESSON_ID = "lesson-1";
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-10-31T12:00:00.000Z";
const EARLIER = "2026-10-30T09:00:00.000Z";
const CREATED = "2026-10-29T08:00:00.000Z";

function preferences(): TeachingPreferences {
  return { explanationDepth: "detailed", speakingSpeed: "slow" };
}

function snapshotInput(overrides: Partial<SavedLessonSnapshotInput> = {}): SavedLessonSnapshotInput {
  const prepared: PreparedLearningSource = {
    name: "notes.txt",
    mimeType: "text/plain",
    text: "Course notes",
    lessonTree: lessonTree(),
  };
  const source: LearningSource = {
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
    status: "ready",
  };
  const lessonSources: LessonSource[] = [{
    id: SOURCE_ID,
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
    role: "notes",
    storagePath: null,
    storageStatus: "local",
  }];
  return {
    id: LESSON_ID,
    prepared,
    source,
    lessonSources,
    topicInput: "  Focus topic  ",
    hasStarted: true,
    state: {
      ...lessonState(),
      lastUserTranscript: "learner words",
      lastAssistantTranscript: "tutor words",
    },
    recentTeachingContext: [{ conceptId: "module.first", excerpt: "Earlier explanation" }],
    teachingPreferences: preferences(),
    createdAt: CREATED,
    previousUpdatedAt: null,
    previousContentSignature: null,
    cloudOwnerId: null,
    cloudSync: undefined,
    now: NOW,
    ...overrides,
  };
}

describe("getPersistedResumeContext", () => {
  it("summarizes the current concept, previous taught concept, and matching excerpts", () => {
    const state = withStatuses(
      { ...lessonState(), resumePoint: "  halfway through  " },
      "module.third",
      { "module.first": "taught", "module.second": "skipped", "module.third": "teaching" },
    );
    const context = getPersistedResumeContext(state, [
      { conceptId: "module.first", excerpt: "about first" },
      { conceptId: "module.third", excerpt: "third a" },
      { conceptId: "module.third", excerpt: "third b" },
    ]);
    expect(context).toEqual({
      currentConceptTitle: "Third",
      currentConceptStatus: "teaching",
      resumePointAvailable: true,
      previousCoveredConceptTitle: "First",
      recentTeachingContext: ["third a", "third b"],
    });
  });

  it("reports no resume point for whitespace and no previous concept at the first concept", () => {
    const state = withStatuses({ ...lessonState(), resumePoint: "   " }, "module.first", {
      "module.first": "teaching",
    });
    const context = getPersistedResumeContext(state, [
      { conceptId: "module.second", excerpt: "other concept" },
    ]);
    expect(context.resumePointAvailable).toBe(false);
    expect(context.previousCoveredConceptTitle).toBeNull();
    expect(context.recentTeachingContext).toEqual([]);
  });

  it("returns empty context when there is no current concept", () => {
    const state = { ...lessonState(), currentNodeId: null };
    expect(getPersistedResumeContext(state, [{ conceptId: "module.first", excerpt: "x" }])).toEqual({
      currentConceptTitle: null,
      currentConceptStatus: null,
      resumePointAvailable: false,
      previousCoveredConceptTitle: null,
      recentTeachingContext: [],
    });
  });
});

describe("createRecentTeachingExcerpt", () => {
  it("collapses whitespace and trims", () => {
    expect(createRecentTeachingExcerpt("  Hello \n\n  world\t again  ")).toBe("Hello world again");
  });

  it("returns empty for blank transcripts", () => {
    expect(createRecentTeachingExcerpt(" \n\t ")).toBe("");
  });

  it("keeps transcripts at exactly the limit", () => {
    const exact = "a".repeat(MAX_RECENT_TEACHING_EXCERPT_LENGTH);
    expect(createRecentTeachingExcerpt(exact)).toBe(exact);
  });

  it("truncates longer transcripts with an ellipsis within the limit", () => {
    expect(MAX_RECENT_TEACHING_EXCERPT_LENGTH).toBe(360);
    const words = "word ".repeat(100);
    const excerpt = createRecentTeachingExcerpt(words);
    expect(excerpt.length).toBeLessThanOrEqual(MAX_RECENT_TEACHING_EXCERPT_LENGTH);
    expect(excerpt.endsWith("...")).toBe(true);
    // Trailing whitespace before the ellipsis is trimmed.
    expect(excerpt).not.toMatch(/\s\.\.\.$/);
    expect(excerpt).toBe(`${words.trim().slice(0, 357).trimEnd()}...`);
  });
});

describe("appendRecentTeachingContext", () => {
  it("returns null for a missing or unknown concept", () => {
    const state = lessonState();
    expect(appendRecentTeachingContext([], state, null, "text")).toBeNull();
    expect(appendRecentTeachingContext([], state, "missing", "text")).toBeNull();
  });

  it("returns null for blank transcripts", () => {
    expect(appendRecentTeachingContext([], lessonState(), "module.first", "   ")).toBeNull();
  });

  it("returns null when the excerpt repeats the latest entry for the concept", () => {
    const entries = [{ conceptId: "module.first", excerpt: "Same text" }];
    expect(appendRecentTeachingContext(entries, lessonState(), "module.first", "  Same   text ")).toBeNull();
  });

  it("appends a new excerpt without mutating the input", () => {
    const entries = [{ conceptId: "module.first", excerpt: "One" }];
    const next = appendRecentTeachingContext(entries, lessonState(), "module.first", "Two");
    expect(next).toEqual([
      { conceptId: "module.first", excerpt: "One" },
      { conceptId: "module.first", excerpt: "Two" },
    ]);
    expect(entries).toEqual([{ conceptId: "module.first", excerpt: "One" }]);
  });

  it("drops entries for other concepts when appending", () => {
    const entries = [
      { conceptId: "module.first", excerpt: "One" },
      { conceptId: "module.second", excerpt: "Two" },
    ];
    expect(appendRecentTeachingContext(entries, lessonState(), "module.second", "Three")).toEqual([
      { conceptId: "module.second", excerpt: "Two" },
      { conceptId: "module.second", excerpt: "Three" },
    ]);
  });

  it("caps the per-concept history to the most recent entries", () => {
    expect(MAX_RECENT_TEACHING_CONTEXT_ENTRIES).toBe(3);
    let entries: RecentTeachingContextEntry[] = [];
    for (const text of ["A", "B", "C", "D"]) {
      entries = appendRecentTeachingContext(entries, lessonState(), "module.first", text) ?? entries;
    }
    expect(entries.map((entry) => entry.excerpt)).toEqual(["B", "C", "D"]);
  });

  it("allows an excerpt matching an older, non-latest entry", () => {
    const entries = [
      { conceptId: "module.first", excerpt: "A" },
      { conceptId: "module.first", excerpt: "B" },
    ];
    expect(appendRecentTeachingContext(entries, lessonState(), "module.first", "A")?.map((e) => e.excerpt))
      .toEqual(["A", "B", "A"]);
  });
});

describe("buildSavedLessonSnapshot", () => {
  it("builds a schema-versioned snapshot that round-trips through parseSavedLesson", () => {
    const input = snapshotInput();
    const snapshot = buildSavedLessonSnapshot(input);
    expect(snapshot.schemaVersion).toBe(SAVED_LESSON_SCHEMA_VERSION);
    expect(snapshot.id).toBe(LESSON_ID);
    expect(snapshot.title).toBe("notes.txt");
    expect(snapshot.lessonFocus).toBe("Focus topic");
    expect(snapshot.hasStarted).toBe(true);
    expect(snapshot.source.metadata).toEqual({ ...input.source, status: "ready", error: undefined });
    expect(snapshot.source.prepared).toEqual(input.prepared);
    expect(snapshot.sources).toEqual(input.lessonSources);
    expect(snapshot.createdAt).toBe(CREATED);
    expect(snapshot.updatedAt).toBe(NOW);
    expect(Object.keys(snapshot)).toContain("cloudOwnerId");
    expect(snapshot.cloudOwnerId).toBeNull();
    expect("cloudSync" in snapshot).toBe(false);

    const parsed = parseSavedLesson(structuredClone(snapshot));
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(LESSON_ID);
    // The parser normalizes the lesson tree, so compare the builder-owned fields.
    expect(parsed?.lessonFocus).toBe(snapshot.lessonFocus);
    expect(parsed?.hasStarted).toBe(snapshot.hasStarted);
    expect(parsed?.sources).toEqual(snapshot.sources);
    expect(parsed?.lessonState.currentNodeId).toBe(snapshot.lessonState.currentNodeId);
    expect(parsed?.lessonState.lastAssistantTranscript).toBe("");
    expect(parsed?.recentTeachingContext).toEqual(snapshot.recentTeachingContext);
    expect(parsed?.teachingPreferences).toEqual(snapshot.teachingPreferences);
    expect(parsed?.createdAt).toBe(CREATED);
    expect(parsed?.updatedAt).toBe(NOW);
    expect(parsed?.cloudOwnerId).toBeNull();
  });

  it("forces ready metadata and clears any source error", () => {
    const snapshot = buildSavedLessonSnapshot(snapshotInput({
      source: { name: "x.txt", mimeType: "text/plain", sizeBytes: 1, status: "ready", error: "old" },
    }));
    expect(snapshot.source.metadata.status).toBe("ready");
    expect(snapshot.source.metadata.error).toBeUndefined();
  });

  it("strips transcripts from persisted lesson state but keeps the rest", () => {
    const input = snapshotInput();
    const snapshot = buildSavedLessonSnapshot(input);
    expect(snapshot.lessonState.lastUserTranscript).toBe("");
    expect(snapshot.lessonState.lastAssistantTranscript).toBe("");
    expect(input.state.lastUserTranscript).toBe("learner words");
    expect(input.state.lastAssistantTranscript).toBe("tutor words");
    expect(snapshot.lessonState).toEqual({
      ...input.state,
      lastUserTranscript: "",
      lastAssistantTranscript: "",
    });
  });

  it("retains teaching preferences, delivery cursor, resume state, and recent context", () => {
    const base = lessonState();
    const state: LessonState = {
      ...base,
      status: "interrupted",
      currentNodeId: "module.second",
      resumePoint: "the second point",
      interruptionCount: 2,
      teachingContractProgress: {
        ...base.teachingContractProgress,
        "module.second": {
          ...base.teachingContractProgress["module.second"],
          nextTeachingPointIndex: 1,
        },
      },
    };
    const input = snapshotInput({ state });
    const snapshot = buildSavedLessonSnapshot(input);
    expect(snapshot.teachingPreferences).toEqual(preferences());
    expect(snapshot.lessonState.teachingContractProgress).toEqual(state.teachingContractProgress);
    expect(snapshot.lessonState.teachingContractProgress["module.second"].nextTeachingPointIndex).toBe(1);
    expect(snapshot.lessonState.status).toBe("interrupted");
    expect(snapshot.lessonState.currentNodeId).toBe("module.second");
    expect(snapshot.lessonState.resumePoint).toBe("the second point");
    expect(snapshot.lessonState.interruptionCount).toBe(2);
    expect(snapshot.recentTeachingContext).toEqual(input.recentTeachingContext);
  });

  it("deep-clones inputs so later mutation does not leak into the snapshot", () => {
    const input = snapshotInput();
    const snapshot = buildSavedLessonSnapshot(input);
    expect(snapshot.recentTeachingContext).not.toBe(input.recentTeachingContext);
    expect(snapshot.teachingPreferences).not.toBe(input.teachingPreferences);
    expect(snapshot.sources).not.toBe(input.lessonSources);
    input.recentTeachingContext.push({ conceptId: "module.first", excerpt: "later" });
    expect(snapshot.recentTeachingContext).toHaveLength(1);
  });

  it("retains owner and cloud-sync metadata", () => {
    const cloudSync = {
      lastSyncedLocalUpdatedAt: EARLIER,
      lastKnownCloudUpdatedAt: EARLIER,
    };
    const snapshot = buildSavedLessonSnapshot(snapshotInput({
      cloudOwnerId: "owner-1",
      cloudSync,
    }));
    expect(snapshot.cloudOwnerId).toBe("owner-1");
    expect(snapshot.cloudSync).toEqual(cloudSync);
    expect(parseSavedLesson(structuredClone(snapshot))?.cloudSync).toEqual(cloudSync);
  });

  it("keeps the previous updatedAt when the content signature is unchanged", () => {
    const first = buildSavedLessonSnapshot(snapshotInput({ now: EARLIER }));
    const second = buildSavedLessonSnapshot(snapshotInput({
      previousUpdatedAt: first.updatedAt,
      previousContentSignature: getSavedLessonContentSignature(first),
      now: NOW,
    }));
    expect(second.updatedAt).toBe(EARLIER);
  });

  it("ignores infrastructure-only changes when comparing content", () => {
    const first = buildSavedLessonSnapshot(snapshotInput({ now: EARLIER }));
    const second = buildSavedLessonSnapshot(snapshotInput({
      previousUpdatedAt: first.updatedAt,
      previousContentSignature: getSavedLessonContentSignature(first),
      cloudOwnerId: "owner-1",
      cloudSync: { lastSyncedLocalUpdatedAt: EARLIER, lastKnownCloudUpdatedAt: EARLIER },
      createdAt: NOW,
      now: NOW,
    }));
    expect(second.updatedAt).toBe(EARLIER);
  });

  it("uses now when content changes", () => {
    const first = buildSavedLessonSnapshot(snapshotInput({ now: EARLIER }));
    const second = buildSavedLessonSnapshot(snapshotInput({
      topicInput: "Different focus",
      previousUpdatedAt: first.updatedAt,
      previousContentSignature: getSavedLessonContentSignature(first),
      now: NOW,
    }));
    expect(second.updatedAt).toBe(NOW);
  });

  it("does not treat transcript-only changes as content changes", () => {
    const first = buildSavedLessonSnapshot(snapshotInput({ now: EARLIER }));
    const base = snapshotInput().state;
    const second = buildSavedLessonSnapshot(snapshotInput({
      state: { ...base, lastAssistantTranscript: "something new" },
      previousUpdatedAt: first.updatedAt,
      previousContentSignature: getSavedLessonContentSignature(first),
      now: NOW,
    }));
    expect(second.updatedAt).toBe(EARLIER);
  });

  it("uses now when there is no previous updatedAt even if signatures match", () => {
    const first = buildSavedLessonSnapshot(snapshotInput({ now: EARLIER }));
    const second = buildSavedLessonSnapshot(snapshotInput({
      previousUpdatedAt: null,
      previousContentSignature: getSavedLessonContentSignature(first),
      now: NOW,
    }));
    expect(second.updatedAt).toBe(NOW);
  });
});
