"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  LearningSource,
  LessonSource,
  PreparedLearningSource,
} from "./learning-source";
import { createLessonState, type LessonState } from "./lesson-state";
import {
  DEFAULT_TEACHING_PREFERENCES,
  type TeachingPreferences,
} from "./teaching-preferences";
import {
  clearActiveLessonId,
  deleteSavedLesson,
  getSavedLesson,
  getSavedLessonContentSignature,
  listSavedLessons,
  loadActiveLesson,
  saveActiveLesson,
  saveSavedLesson,
  setActiveLessonId,
  type RecentTeachingContextEntry,
  type SavedLesson,
} from "./local-persistence";
import { buildSavedLessonSnapshot } from "./lesson-snapshot";
import {
  createCloudCompatibleLessonId,
  associateCloudLesson,
  deleteCloudLesson,
  isUuid,
  reconcileCloudLessons,
  type CloudSyncState,
} from "./cloud-sync";
import {
  cloudSyncStateAfterSummary,
  createImportCandidate,
  libraryRefreshDiagnostics,
  scopeLibrary,
  upsertLibraryLesson,
  workspaceHydrationSkipReason,
} from "./lesson-workspace";

// Lesson workspace: the selected lesson's source/identity, IndexedDB persistence,
// hydration and Supabase sync orchestration. Canonical LessonState, teaching
// preferences and recent teaching context stay owned by the page/session runtime
// and are passed in; the workspace snapshots and replaces them but never decides
// lesson progress. Operations are intentionally recreated each render (not
// memoized) so they capture the same render values as before the extraction,
// and the two effects keep their original dependency arrays.
export type LessonWorkspaceInput = {
  // Session-owned refs, read only (hydration blocking, cloud defer).
  lessonActiveRef: RefObject<boolean>;
  lessonStartupPendingRef: RefObject<boolean>;
  // Canonical lesson content owned by the page/runtime.
  lessonState: LessonState;
  lessonStateRef: RefObject<LessonState>;
  setLessonState: (state: LessonState) => void;
  recentTeachingContextRef: RefObject<RecentTeachingContextEntry[]>;
  teachingPreferences: TeachingPreferences;
  teachingPreferencesRef: RefObject<TeachingPreferences>;
  setTeachingPreferences: (preferences: TeachingPreferences) => void;
  // Auth identity owned by the page (CloudAccount).
  cloudUserId: string | null;
  cloudAuthReady: boolean;
  // Workspace-load re-trigger signals; effect dependencies only.
  aiConnectionStatus: string;
  microphoneStatus: string;
  addDebugMessage: (text: string) => void;
  setUserError: (message: string) => void;
  // Session/UI resets performed whenever the workspace lesson is replaced.
  onWorkspaceReplaced: () => void;
  // Navigation after the current lesson is deleted.
  onCurrentLessonDeleted: () => void;
};

export function useLessonWorkspace(input: LessonWorkspaceInput) {
  const {
    lessonActiveRef,
    lessonStartupPendingRef,
    lessonState,
    lessonStateRef,
    setLessonState,
    recentTeachingContextRef,
    teachingPreferences,
    teachingPreferencesRef,
    setTeachingPreferences,
    cloudUserId,
    cloudAuthReady,
    aiConnectionStatus,
    microphoneStatus,
    addDebugMessage,
    setUserError,
    onWorkspaceReplaced,
    onCurrentLessonDeleted,
  } = input;
  const [persistenceHydrated, setPersistenceHydrated] = useState(false);
  const [persistenceNotice, setPersistenceNotice] = useState("");
  const [savedLessonId, setSavedLessonId] = useState<string | null>(null);
  const [resumeExistingLesson, setResumeExistingLesson] = useState(false);
  const [savedLessons, setSavedLessons] = useState<SavedLesson[]>([]);
  const [lessonLibraryBusyId, setLessonLibraryBusyId] = useState<string | null>(null);
  const [cloudSyncState, setCloudSyncState] = useState<CloudSyncState>("local-only");
  const [cloudLessonCount, setCloudLessonCount] = useState(0);
  const [localOnlyLessonCount, setLocalOnlyLessonCount] = useState(0);
  const [topicInput, setTopicInput] = useState("");
  const [learningSource, setLearningSource] = useState<LearningSource | null>(null);
  const [lessonSources, setLessonSources] = useState<LessonSource[]>([]);
  const preparedSourceRef = useRef<PreparedLearningSource | null>(null);
  const savedLessonIdRef = useRef<string | null>(null);
  const savedLessonCreatedAtRef = useRef<string | null>(null);
  const savedLessonUpdatedAtRef = useRef<string | null>(null);
  const savedLessonContentSignatureRef = useRef<string | null>(null);
  const savedLessonWasPersistedRef = useRef(false);
  const resumeExistingLessonRef = useRef(false);
  const persistenceAvailableRef = useRef(true);
  const persistenceHydratedRef = useRef(false);
  const workspaceOwnerIdRef = useRef<string | null>(null);
  const cloudOwnerIdRef = useRef<string | null>(null);
  const cloudSyncMetadataRef = useRef<SavedLesson["cloudSync"]>(undefined);
  const cloudUploadTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const workspaceLoadGenerationRef = useRef(0);
  const lessonHydrationGenerationRef = useRef(0);
  const workspaceLoadedRef = useRef(false);
  const persistenceSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applySyncedLessonMetadata = (synced: SavedLesson) => {
    setSavedLessons((current) => current.map((lesson) =>
      lesson.id === synced.id ? synced : lesson
    ));
    if (savedLessonIdRef.current === synced.id) {
      cloudSyncMetadataRef.current = synced.cloudSync;
    }
  };

  const scheduleCloudUpload = (snapshot: SavedLesson) => {
    const ownerId = snapshot.cloudOwnerId ?? null;
    if (!ownerId || ownerId !== cloudUserId) return;
    const existing = cloudUploadTimersRef.current.get(snapshot.id);
    if (existing) clearTimeout(existing);
    setCloudSyncState("pending");
    const timer = setTimeout(() => {
      cloudUploadTimersRef.current.delete(snapshot.id);
      setCloudSyncState("syncing");
      void reconcileCloudLessons({
        userId: ownerId,
        deferDownloadLessonId: lessonActiveRef.current ? snapshot.id : null,
        debug: addDebugMessage,
      })
        .then(async (summary) => {
          const synced = await getSavedLesson(snapshot.id);
          if (synced) {
            applySyncedLessonMetadata(synced);
          } else if (!lessonActiveRef.current && !lessonStartupPendingRef.current &&
              savedLessonIdRef.current === snapshot.id) {
            resetIdleLessonWorkspace();
            await clearActiveLessonId(ownerId);
          }
          await refreshScopedLibrary(ownerId);
          setCloudLessonCount(summary.cloudLessonCount);
          setCloudSyncState(cloudSyncStateAfterSummary(summary));
        })
        .catch(() => {
          setCloudSyncState("pending");
          addDebugMessage("Cloud sync failed: category=lesson-upload");
        });
    }, 1_200);
    cloudUploadTimersRef.current.set(snapshot.id, timer);
  };

  const createCurrentLessonSnapshot = (stateOverride?: LessonState) => {
    if (!persistenceAvailableRef.current || !persistenceHydratedRef.current) return;
    const id = savedLessonIdRef.current;
    const prepared = preparedSourceRef.current;
    const source = learningSource;
    if (!id || !prepared || !source || source.status !== "ready") return;
    const now = new Date().toISOString();
    const createdAt = savedLessonCreatedAtRef.current ?? now;
    savedLessonCreatedAtRef.current = createdAt;
    return buildSavedLessonSnapshot({
      id,
      prepared,
      source,
      lessonSources,
      topicInput,
      hasStarted: resumeExistingLessonRef.current,
      state: stateOverride ?? lessonStateRef.current,
      recentTeachingContext: recentTeachingContextRef.current,
      teachingPreferences: teachingPreferencesRef.current,
      createdAt,
      previousUpdatedAt: savedLessonUpdatedAtRef.current,
      previousContentSignature: savedLessonContentSignatureRef.current,
      cloudOwnerId: cloudOwnerIdRef.current,
      cloudSync: cloudSyncMetadataRef.current,
      now,
    });
  };

  const persistLessonSnapshot = async (snapshot: SavedLesson) => {
    try {
      await saveActiveLesson(snapshot);
      if (savedLessonIdRef.current === snapshot.id) {
        savedLessonUpdatedAtRef.current = snapshot.updatedAt;
        savedLessonContentSignatureRef.current = getSavedLessonContentSignature(snapshot);
      }
      if ((snapshot.cloudOwnerId ?? null) === workspaceOwnerIdRef.current) {
        setSavedLessons((current) => upsertLibraryLesson(current, snapshot));
      }
      if (savedLessonIdRef.current === snapshot.id && !savedLessonWasPersistedRef.current) {
        savedLessonWasPersistedRef.current = true;
        addDebugMessage(`Saved lesson created: ${snapshot.id}`);
      } else {
        addDebugMessage("Lesson autosaved");
      }
      scheduleCloudUpload(snapshot);
    } catch {
      persistenceAvailableRef.current = false;
      setPersistenceNotice("Local lesson saving is unavailable on this device.");
      addDebugMessage("Local persistence unavailable");
    }
  };

  const persistCurrentLesson = async (stateOverride?: LessonState) => {
    const snapshot = createCurrentLessonSnapshot(stateOverride);
    if (snapshot) await persistLessonSnapshot(snapshot);
  };

  // Must stay synchronous: callers rely on the whole replacement landing in one tick.
  const hydrateSavedLesson = (saved: SavedLesson, requestedGeneration?: number) => {
    if (lessonActiveRef.current || lessonStartupPendingRef.current ||
        (requestedGeneration !== undefined && requestedGeneration !== lessonHydrationGenerationRef.current)) {
      addDebugMessage(`Stale workspace hydration skipped: reason=${workspaceHydrationSkipReason(lessonActiveRef.current, lessonStartupPendingRef.current)}`);
      return false;
    }
    preparedSourceRef.current = saved.source.prepared;
    lessonStateRef.current = saved.lessonState;
    onWorkspaceReplaced();
    recentTeachingContextRef.current = saved.recentTeachingContext;
    teachingPreferencesRef.current = saved.teachingPreferences;
    savedLessonIdRef.current = saved.id;
    savedLessonCreatedAtRef.current = saved.createdAt;
    savedLessonUpdatedAtRef.current = saved.updatedAt;
    savedLessonContentSignatureRef.current = getSavedLessonContentSignature(saved);
    savedLessonWasPersistedRef.current = true;
    cloudOwnerIdRef.current = saved.cloudOwnerId ?? null;
    cloudSyncMetadataRef.current = saved.cloudSync;
    resumeExistingLessonRef.current = saved.hasStarted;
    setLearningSource(saved.source.metadata);
    setLessonSources(saved.sources);
    saved.sources.forEach((item) => addDebugMessage(`Source restored from cloud metadata: source=${item.id}`));
    setLessonState(saved.lessonState);
    setTeachingPreferences(saved.teachingPreferences);
    setTopicInput(saved.lessonFocus);
    setSavedLessonId(saved.id);
    setResumeExistingLesson(saved.hasStarted);
    setUserError("");
    addDebugMessage(
      `Restored resume teaching context: entries=${saved.recentTeachingContext.length}`,
    );
    return true;
  };

  const resetIdleLessonWorkspace = () => {
    const emptyLesson = createLessonState("Uploaded material", []);
    preparedSourceRef.current = null;
    lessonStateRef.current = emptyLesson;
    onWorkspaceReplaced();
    recentTeachingContextRef.current = [];
    teachingPreferencesRef.current = DEFAULT_TEACHING_PREFERENCES;
    savedLessonIdRef.current = null;
    savedLessonCreatedAtRef.current = null;
    savedLessonUpdatedAtRef.current = null;
    savedLessonContentSignatureRef.current = null;
    savedLessonWasPersistedRef.current = false;
    cloudOwnerIdRef.current = workspaceOwnerIdRef.current;
    cloudSyncMetadataRef.current = undefined;
    resumeExistingLessonRef.current = false;
    setLearningSource(null);
    setLessonSources([]);
    setLessonState(emptyLesson);
    setTeachingPreferences(DEFAULT_TEACHING_PREFERENCES);
    setTopicInput("");
    setSavedLessonId(null);
    setResumeExistingLesson(false);
    setUserError("");
  };

  /** Workspace half of "+ Add New Lesson". Returns false while a lesson is active. */
  const prepareNewLesson = () => {
    if (lessonActiveRef.current) return false;
    setPersistenceNotice("");
    if (persistenceSaveTimerRef.current) clearTimeout(persistenceSaveTimerRef.current);
    persistenceSaveTimerRef.current = null;
    const outgoingSnapshot = createCurrentLessonSnapshot();
    if (outgoingSnapshot) void persistLessonSnapshot(outgoingSnapshot);
    resetIdleLessonWorkspace();
    return true;
  };

  const selectSavedLesson = async (id: string) => {
    if (lessonActiveRef.current || lessonLibraryBusyId) return;
    setPersistenceNotice("");
    setLessonLibraryBusyId(id);
    const hydrationGeneration = ++lessonHydrationGenerationRef.current;
    try {
      if (persistenceSaveTimerRef.current) clearTimeout(persistenceSaveTimerRef.current);
      persistenceSaveTimerRef.current = null;
      const outgoingSnapshot = createCurrentLessonSnapshot();
      if (outgoingSnapshot) await persistLessonSnapshot(outgoingSnapshot);
      const saved = await getSavedLesson(id);
      if (!saved || (saved.cloudOwnerId ?? null) !== workspaceOwnerIdRef.current) {
        setUserError("That saved lesson is unavailable or incompatible.");
        setSavedLessons((current) => current.filter((lesson) => lesson.id !== id));
        return;
      }
      await setActiveLessonId(id, workspaceOwnerIdRef.current);
      if (!hydrateSavedLesson(saved, hydrationGeneration)) return;
      addDebugMessage(`Saved lesson selected: ${id}`);
      addDebugMessage(`Active lesson changed: ${id}`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setPersistenceNotice("Local lesson saving is unavailable on this device.");
      addDebugMessage("Local persistence unavailable");
    } finally {
      setLessonLibraryBusyId(null);
    }
  };

  const requestDeleteSavedLesson = async (saved: SavedLesson) => {
    if (lessonActiveRef.current || lessonLibraryBusyId) return;
    const deleteScope = saved.cloudOwnerId
      ? "This removes its cloud snapshot and local cached source and progress."
      : "This removes its local source and progress.";
    if (!window.confirm(`Delete "${saved.title}"?\n\n${deleteScope}`)) {
      return;
    }
    setLessonLibraryBusyId(saved.id);
    try {
      if (savedLessonIdRef.current === saved.id && persistenceSaveTimerRef.current) {
        clearTimeout(persistenceSaveTimerRef.current);
        persistenceSaveTimerRef.current = null;
      }
      if (saved.cloudOwnerId) {
        if (saved.cloudOwnerId !== cloudUserId) {
          throw new Error("cloud-owner-mismatch");
        }
        await deleteCloudLesson(saved.id, saved.cloudOwnerId, addDebugMessage);
        setCloudLessonCount((count) => Math.max(0, count - 1));
      }
      await deleteSavedLesson(saved.id);
      setSavedLessons((current) => current.filter((lesson) => lesson.id !== saved.id));
      if (savedLessonIdRef.current === saved.id) {
        resetIdleLessonWorkspace();
        onCurrentLessonDeleted();
      }
      addDebugMessage(`Saved lesson deleted: ${saved.id}`);
    } catch {
      setPersistenceNotice(saved.cloudOwnerId
        ? "That lesson could not be deleted from the cloud. Its local copy was kept."
        : "That saved lesson could not be deleted on this device.");
      addDebugMessage(saved.cloudOwnerId
        ? "Cloud sync failed: category=lesson-delete"
        : "Local persistence unavailable");
    } finally {
      setLessonLibraryBusyId(null);
    }
  };

  const refreshScopedLibrary = async (ownerId: string | null, reason = "workspace") => {
    const library = await listSavedLessons();
    const { scoped, localOnlyCount } = scopeLibrary(library, ownerId);
    setSavedLessons(scoped);
    setLocalOnlyLessonCount(localOnlyCount);
    libraryRefreshDiagnostics(scoped, reason).forEach(addDebugMessage);
    return scoped;
  };

  const syncCurrentAccount = async () => {
    const ownerId = workspaceOwnerIdRef.current;
    if (!ownerId || ownerId !== cloudUserId) return;
    setCloudSyncState("syncing");
    try {
      await persistCurrentLesson();
      const summary = await reconcileCloudLessons({
        userId: ownerId,
        deferDownloadLessonId: lessonActiveRef.current ? savedLessonIdRef.current : null,
        debug: addDebugMessage,
      });
      setCloudLessonCount(summary.cloudLessonCount);
      await refreshScopedLibrary(ownerId, "cloud-sync");
      if (!lessonActiveRef.current && savedLessonIdRef.current) {
        const hydrationGeneration = lessonHydrationGenerationRef.current;
        const refreshed = await getSavedLesson(savedLessonIdRef.current);
        if (refreshed?.cloudOwnerId === ownerId) {
          hydrateSavedLesson(refreshed, hydrationGeneration);
        } else if (!lessonActiveRef.current && !lessonStartupPendingRef.current) {
          resetIdleLessonWorkspace();
          await clearActiveLessonId(ownerId);
        }
      }
      setCloudSyncState(cloudSyncStateAfterSummary(summary));
    } catch {
      setCloudSyncState("error");
      addDebugMessage("Cloud sync failed: category=reconciliation");
    }
  };

  const importLocalLessons = async () => {
    const ownerId = workspaceOwnerIdRef.current;
    if (!ownerId || ownerId !== cloudUserId || lessonActiveRef.current) return;
    if (!window.confirm("Sync all unowned local lessons to this account? They will become associated with the signed-in account.")) return;
    setCloudSyncState("syncing");
    try {
      const localOnly = (await listSavedLessons()).filter((lesson) => !lesson.cloudOwnerId);
      let imported = 0;
      for (const lesson of localOnly) {
        const candidate = createImportCandidate(lesson, ownerId, {
          isUuid,
          createId: createCloudCompatibleLessonId,
        });
        try {
          const synced = await associateCloudLesson(candidate, ownerId, addDebugMessage);
          await saveSavedLesson(synced);
          if (synced.id !== lesson.id) await deleteSavedLesson(lesson.id);
          addDebugMessage(
            `Legacy import: localId=${lesson.id}, cloudId=${synced.id}, ` +
            `identityChanged=${synced.id === lesson.id ? "no" : "yes"}`,
          );
          imported += 1;
        } catch {
          addDebugMessage(`Cloud sync failed: category=local-import, id=${lesson.id}`);
        }
      }
      await clearActiveLessonId(null);
      addDebugMessage(`Local lessons imported: ${imported}/${localOnly.length}`);
      await syncCurrentAccount();
    } catch {
      setCloudSyncState("error");
      addDebugMessage("Cloud sync failed: category=local-import");
    }
  };

  /** disposeResources: drop a pending autosave without flushing it. */
  const cancelScheduledSave = () => {
    if (persistenceSaveTimerRef.current) clearTimeout(persistenceSaveTimerRef.current);
    persistenceSaveTimerRef.current = null;
  };

  /** startConversation: invalidate an in-flight workspace load, then any pending hydration. */
  const invalidatePendingHydration = () => {
    workspaceLoadGenerationRef.current += 1;
    lessonHydrationGenerationRef.current += 1;
  };

  const markLessonStarted = () => {
    resumeExistingLessonRef.current = true;
    setResumeExistingLesson(true);
  };

  const markLessonNotStarted = () => {
    resumeExistingLessonRef.current = false;
    setResumeExistingLesson(false);
  };

  /** CloudAccount auth change. Reads only refs, so a stale render's copy behaves the same. */
  const handleAuthResolved = (nextUserId: string | null) => {
    if (workspaceOwnerIdRef.current !== nextUserId) {
      cloudUploadTimersRef.current.forEach((timer) => clearTimeout(timer));
      cloudUploadTimersRef.current.clear();
      workspaceLoadedRef.current = false;
    }
  };

  useEffect(() => {
    if (!cloudAuthReady || lessonActiveRef.current || lessonStartupPendingRef.current) return;
    const ownerId = cloudUserId;
    if (workspaceLoadedRef.current && workspaceOwnerIdRef.current === ownerId) return;
    const generation = ++workspaceLoadGenerationRef.current;
    void (async () => {
      try {
        if (persistenceHydratedRef.current) {
          const outgoing = createCurrentLessonSnapshot();
          if (outgoing) await persistLessonSnapshot(outgoing);
        }
        if (generation !== workspaceLoadGenerationRef.current ||
            lessonActiveRef.current || lessonStartupPendingRef.current) {
          addDebugMessage(`Stale workspace hydration skipped: reason=${workspaceHydrationSkipReason(lessonActiveRef.current, lessonStartupPendingRef.current)}`);
          return;
        }
        resetIdleLessonWorkspace();
        workspaceOwnerIdRef.current = ownerId;
        cloudOwnerIdRef.current = ownerId;
        cloudSyncMetadataRef.current = undefined;

        if (ownerId) {
          setCloudSyncState("syncing");
          try {
            const summary = await reconcileCloudLessons({ userId: ownerId, debug: addDebugMessage });
            setCloudLessonCount(summary.cloudLessonCount);
            setCloudSyncState("synced");
          } catch {
            setCloudSyncState("error");
            addDebugMessage("Cloud sync failed: category=initial-reconciliation");
          }
        } else {
          setCloudSyncState("local-only");
          setCloudLessonCount(0);
        }

        if (generation !== workspaceLoadGenerationRef.current) return;
        const [result] = await Promise.all([
          loadActiveLesson(ownerId),
          refreshScopedLibrary(ownerId, "workspace-restore"),
        ]);
        addDebugMessage("IndexedDB opened");
        if (result.status === "incompatible") {
          addDebugMessage("Saved lesson schema incompatible");
          await clearActiveLessonId(ownerId);
        } else if (result.status === "restored") {
          const hydrationGeneration = lessonHydrationGenerationRef.current;
          if (generation !== workspaceLoadGenerationRef.current ||
              ownerId !== workspaceOwnerIdRef.current ||
              lessonActiveRef.current || lessonStartupPendingRef.current) {
            addDebugMessage(`Stale workspace hydration skipped: reason=${workspaceHydrationSkipReason(lessonActiveRef.current, lessonStartupPendingRef.current)}`);
          } else if (hydrateSavedLesson(result.lesson, hydrationGeneration)) {
            addDebugMessage(`Restored saved lesson: ${result.lesson.id}`);
          }
        }
        workspaceLoadedRef.current = true;
      } catch {
        persistenceAvailableRef.current = false;
        setPersistenceNotice("Local lesson saving is unavailable on this device.");
        addDebugMessage("Local persistence unavailable");
      } finally {
        if (generation === workspaceLoadGenerationRef.current) {
          persistenceHydratedRef.current = true;
          setPersistenceHydrated(true);
        }
      }
    })();
  }, [aiConnectionStatus, cloudAuthReady, cloudUserId, microphoneStatus]);

  useEffect(() => {
    if (!persistenceHydrated || !savedLessonId || learningSource?.status !== "ready") return;
    const snapshot = createCurrentLessonSnapshot();
    if (!snapshot) return;
    if (persistenceSaveTimerRef.current) clearTimeout(persistenceSaveTimerRef.current);
    persistenceSaveTimerRef.current = setTimeout(() => {
      persistenceSaveTimerRef.current = null;
      void persistLessonSnapshot(snapshot);
    }, 600);
    return () => {
      if (persistenceSaveTimerRef.current) clearTimeout(persistenceSaveTimerRef.current);
      persistenceSaveTimerRef.current = null;
    };
  }, [
    persistenceHydrated,
    savedLessonId,
    learningSource,
    lessonSources,
    lessonState.currentNodeId,
    lessonState.nodes,
    lessonState.teachingContractProgress,
    lessonState.resumePoint,
    lessonState.status,
    teachingPreferences,
    topicInput,
  ]);

  return {
    persistenceHydrated,
    persistenceNotice,
    setPersistenceNotice,
    savedLessonId,
    resumeExistingLesson,
    savedLessons,
    lessonLibraryBusyId,
    cloudSyncState,
    cloudLessonCount,
    localOnlyLessonCount,
    topicInput,
    setTopicInput,
    learningSource,
    lessonSources,
    savedLessonIdRef,
    preparedSourceRef,
    resumeExistingLessonRef,
    persistenceHydratedRef,
    workspaceOwnerIdRef,
    persistCurrentLesson,
    cancelScheduledSave,
    invalidatePendingHydration,
    markLessonStarted,
    markLessonNotStarted,
    prepareNewLesson,
    selectSavedLesson,
    requestDeleteSavedLesson,
    refreshScopedLibrary,
    syncCurrentAccount,
    importLocalLessons,
    handleAuthResolved,
  };
}
