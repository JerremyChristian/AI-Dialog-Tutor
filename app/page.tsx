"use client";

import type { FunctionCall, LiveServerMessage } from "@google/genai";
import { useEffect, useRef, useState } from "react";
import { LearningSourceUpload } from "../components/learning-source-upload";
import { LessonRoadmap } from "../components/lesson-roadmap";
import { RecentLessons } from "../components/recent-lessons";
import type {
  LearningSource,
  PreparedLearningSource,
} from "../lib/learning-source";
import {
  MicrophonePcmStreamer,
  PcmAudioPlayer,
} from "../lib/realtime-audio";
import {
  ACOUSTIC_ACTIVITY_MULTIPLIER,
  ACOUSTIC_LOG_COOLDOWN_MS,
  ENGAGEMENT_CHECK_INTERVAL_MS,
  IDLE_AFTER_MS,
  IDLE_CONFIRMATION_MS,
  MIN_ACOUSTIC_RMS,
  NOISE_FLOOR_SMOOTHING,
  isMeaningfulLearnerTranscript,
  pcm16Rms,
  type EngagementState,
} from "../lib/engagement";
import {
  LiveTransportManager,
  type LiveTransportState,
} from "../lib/live-transport-manager";
import {
  buildLessonInstruction,
  completeLessonConcept,
  createLessonState,
  deriveResumePoint,
  GEMINI_LIVE_MODEL,
  getCurrentConcept,
  getLessonTreeRows,
  mergeTranscript,
  navigateLessonState,
  pauseLessonState,
  PERSISTED_LESSON_RESUME_CONTROL,
  progressLessonTeachingPoint,
  queryLessonState,
  skipLessonNode,
  type LessonSessionStartMode,
  type LessonState,
} from "../lib/lesson-state";
import {
  DEFAULT_TEACHING_PREFERENCES,
  EXPLANATION_DEPTHS,
  SPEAKING_SPEEDS,
  applyTeachingPreferenceUpdate,
  type TeachingPreferences,
} from "../lib/teaching-preferences";
import {
  MAX_RECENT_TEACHING_CONTEXT_ENTRIES,
  MAX_RECENT_TEACHING_EXCERPT_LENGTH,
  SAVED_LESSON_SCHEMA_VERSION,
  clearActiveLessonId,
  deleteSavedLesson,
  getSavedLesson,
  listSavedLessons,
  loadActiveLesson,
  saveActiveLesson,
  setActiveLessonId,
  type RecentTeachingContextEntry,
  type SavedLesson,
} from "../lib/local-persistence";

type MicrophoneStatus =
  | "Not active"
  | "Requesting permission"
  | "Active"
  | "Permission denied"
  | "Error";

type AiConnectionStatus = "Not connected" | "Connecting" | "Connected" | "Error";

type DebugMessage = {
  id: number;
  timestamp: string;
  text: string;
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type QuickResponse = "Yes" | "Repeat" | "Continue";
type TeachingPreferenceUpdate = Partial<TeachingPreferences>;

type ConversationContinuity = {
  lastMeaningfulLearnerTranscript?: string;
  lastAssistantTranscript?: string;
  lastAssistantTurnComplete: boolean;
  interruptedAssistantTranscript?: string;
  resumePoint?: string;
  learnerUtteranceActive: boolean;
  learnerUtteranceOpen: boolean;
  interruptionAlreadyRegistered: boolean;
  interruptionEpoch?: string;
};

function getMicrophoneErrorMessage(error: unknown) {
  if (!(error instanceof DOMException)) {
    return error instanceof Error ? error.message : "Unknown microphone error";
  }

  switch (error.name) {
    case "NotFoundError":
      return "No microphone was found";
    case "NotReadableError":
      return "The microphone is unavailable or in use by another application";
    case "OverconstrainedError":
      return "No microphone matches the requested audio settings";
    case "AbortError":
      return "Microphone access was interrupted";
    default:
      return error.message || error.name;
  }
}

function getRealtimeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Gemini Live error";
}

function TeachingStyleControls({
  preferences,
  disabled,
  onChange,
}: {
  preferences: TeachingPreferences;
  disabled?: boolean;
  onChange: (update: TeachingPreferenceUpdate) => void;
}) {
  return (
    <div className="teaching-style-controls">
      <fieldset disabled={disabled}>
        <legend>Explanation depth</legend>
        <div className="preference-segments">
          {EXPLANATION_DEPTHS.map((depth) => (
            <button
              key={depth}
              type="button"
              className={preferences.explanationDepth === depth ? "selected" : undefined}
              aria-label={`${capitalize(depth)} explanation depth`}
              aria-pressed={preferences.explanationDepth === depth}
              onClick={() => onChange({ explanationDepth: depth })}
            >
              {capitalize(depth)}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>
          Speaking speed
          <small>How fast the tutor talks</small>
        </legend>
        <div className="preference-segments">
          {SPEAKING_SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              className={preferences.speakingSpeed === speed ? "selected" : undefined}
              aria-label={`${capitalize(speed)} speaking speed`}
              aria-pressed={preferences.speakingSpeed === speed}
              onClick={() => onChange({ speakingSpeed: speed })}
            >
              {capitalize(speed)}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function createLocalLessonId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `lesson-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getPersistedResumeContext(
  state: LessonState,
  recentTeachingContext: RecentTeachingContextEntry[],
) {
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

function createRecentTeachingExcerpt(transcript: string) {
  const concise = transcript.trim().replace(/\s+/g, " ");
  if (!concise) return "";
  return concise.length <= MAX_RECENT_TEACHING_EXCERPT_LENGTH
    ? concise
    : `${concise.slice(0, MAX_RECENT_TEACHING_EXCERPT_LENGTH - 3).trimEnd()}...`;
}

export default function Home() {
  const [microphoneStatus, setMicrophoneStatus] =
    useState<MicrophoneStatus>("Not active");
  const [aiConnectionStatus, setAiConnectionStatus] =
    useState<AiConnectionStatus>("Not connected");
  const [debugMessages, setDebugMessages] = useState<DebugMessage[]>([]);
  const [currentUtterance, setCurrentUtterance] = useState("");
  const [userError, setUserError] = useState("");
  const [engagementState, setEngagementState] = useState<EngagementState>("ended");
  const [transportState, setTransportState] = useState<LiveTransportState>("closed");
  const [microphoneMuted, setMicrophoneMuted] = useState(false);
  const [quickResponseFeedback, setQuickResponseFeedback] = useState("");
  const [teachingPreferences, setTeachingPreferences] = useState<TeachingPreferences>(
    DEFAULT_TEACHING_PREFERENCES,
  );
  const [preferenceUpdatePending, setPreferenceUpdatePending] = useState(false);
  const [roadmapNavigationPending, setRoadmapNavigationPending] = useState(false);
  const [persistenceHydrated, setPersistenceHydrated] = useState(false);
  const [persistenceNotice, setPersistenceNotice] = useState("");
  const [savedLessonId, setSavedLessonId] = useState<string | null>(null);
  const [resumeExistingLesson, setResumeExistingLesson] = useState(false);
  const [savedLessons, setSavedLessons] = useState<SavedLesson[]>([]);
  const [lessonLibraryBusyId, setLessonLibraryBusyId] = useState<string | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosInstallHint, setShowIosInstallHint] = useState(false);
  const [topicInput, setTopicInput] = useState("");
  const [lessonState, setLessonState] = useState<LessonState>(() =>
    createLessonState("Uploaded material"),
  );
  const [learningSource, setLearningSource] = useState<LearningSource | null>(null);
  const preparedSourceRef = useRef<PreparedLearningSource | null>(null);
  const savedLessonIdRef = useRef<string | null>(null);
  const savedLessonCreatedAtRef = useRef<string | null>(null);
  const savedLessonWasPersistedRef = useRef(false);
  const resumeExistingLessonRef = useRef(false);
  const persistenceAvailableRef = useRef(true);
  const persistenceHydratedRef = useRef(false);

  const streamRef = useRef<MediaStream | null>(null);
  const transportRef = useRef<LiveTransportManager | null>(null);
  const microphoneStreamerRef = useRef<MicrophonePcmStreamer | null>(null);
  const playerRef = useRef<PcmAudioPlayer | null>(null);
  const tokenRequestRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const conversationRunRef = useRef(0);
  const assistantSpeakingRef = useRef(false);
  const assistantTurnActiveRef = useRef(false);
  const userTranscriptRef = useRef("");
  const lastMeaningfulLearnerTranscriptRef = useRef("");
  const assistantTranscriptRef = useRef("");
  const lastAssistantTurnCompleteRef = useRef(true);
  const lessonStateRef = useRef(lessonState);
  const resumptionPendingRef = useRef(false);
  const persistedResumeBriefingPendingRef = useRef(false);
  const persistedResumeFirstResponseLoggedRef = useRef(false);
  const assistantCheckpointConceptIdRef = useRef<string | null>(null);
  const recentTeachingContextRef = useRef<RecentTeachingContextEntry[]>([]);
  const sourceGroundingPendingRef = useRef(false);
  const toolResultsRef = useRef(new Map<string, Record<string, unknown>>());
  const cancelledToolCallIdsRef = useRef(new Set<string>());
  const nextMessageIdRef = useRef(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const lessonActiveRef = useRef(false);
  const engagementStateRef = useRef<EngagementState>("ended");
  const lastAcousticActivityAtRef = useRef<number | null>(null);
  const lastCandidateLearnerActivityAtRef = useRef<number | null>(null);
  const lastMeaningfulLearnerActivityAtRef = useRef<number | null>(null);
  const noiseFloorRef = useRef(0.004);
  const lastAcousticLogAtRef = useRef(0);
  const engagementTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const confirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const microphoneMutedRef = useRef(false);
  const microphoneMuteTransitionRef = useRef(false);
  const quickResponseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preferenceUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roadmapNavigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistenceSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roadmapNavigationPendingRef = useRef(false);
  const teachingPreferencesRef = useRef<TeachingPreferences>(teachingPreferences);
  const meaningfulConfirmationSpeechRef = useRef(false);
  const silentLessonRecoveryPendingRef = useRef(false);

  const addDebugMessage = (text: string) => {
    if (!isMountedRef.current) return;

    setDebugMessages((messages) => [
      ...messages,
      {
        id: nextMessageIdRef.current++,
        timestamp: new Date().toLocaleTimeString(),
        text,
      },
    ]);
  };

  const updateLessonState = (
    update: (current: LessonState) => LessonState,
  ) => {
    const next = update(lessonStateRef.current);
    lessonStateRef.current = next;
    setLessonState(next);
  };

  const disposeResources = async (sendAudioStreamEnd: boolean) => {
    tokenRequestRef.current?.abort();
    tokenRequestRef.current = null;

    const microphoneStreamer = microphoneStreamerRef.current;
    microphoneStreamerRef.current = null;
    await microphoneStreamer?.stop();

    transportRef.current?.close(sendAudioStreamEnd);
    transportRef.current = null;

    streamRef.current?.getAudioTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const player = playerRef.current;
    playerRef.current = null;
    await player?.close();
    assistantSpeakingRef.current = false;
    assistantTurnActiveRef.current = false;
    lastAssistantTurnCompleteRef.current = true;
    resumptionPendingRef.current = false;
    persistedResumeBriefingPendingRef.current = false;
    persistedResumeFirstResponseLoggedRef.current = false;
    assistantCheckpointConceptIdRef.current = null;
    sourceGroundingPendingRef.current = false;
    toolResultsRef.current.clear();
    cancelledToolCallIdsRef.current.clear();
    lessonActiveRef.current = false;
    await wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    if (engagementTimerRef.current) clearInterval(engagementTimerRef.current);
    if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
    if (quickResponseTimerRef.current) clearTimeout(quickResponseTimerRef.current);
    if (preferenceUpdateTimerRef.current) clearTimeout(preferenceUpdateTimerRef.current);
    if (roadmapNavigationTimerRef.current) clearTimeout(roadmapNavigationTimerRef.current);
    if (persistenceSaveTimerRef.current) clearTimeout(persistenceSaveTimerRef.current);
    engagementTimerRef.current = null;
    confirmationTimerRef.current = null;
    quickResponseTimerRef.current = null;
    preferenceUpdateTimerRef.current = null;
    roadmapNavigationTimerRef.current = null;
    persistenceSaveTimerRef.current = null;
    engagementStateRef.current = "ended";
    setEngagementState("ended");
    setTransportState("closed");
    microphoneMutedRef.current = false;
    setMicrophoneMuted(false);
    setQuickResponseFeedback("");
    setPreferenceUpdatePending(false);
    setRoadmapNavigationPending(false);
    roadmapNavigationPendingRef.current = false;
    meaningfulConfirmationSpeechRef.current = false;
    silentLessonRecoveryPendingRef.current = false;
    lastMeaningfulLearnerTranscriptRef.current = "";
  };

  const requestWakeLock = async () => {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
      addDebugMessage("Screen wake lock active");
    } catch {
      addDebugMessage("Screen wake lock unavailable");
    }
  };

  const updateEngagementState = (state: EngagementState) => {
    engagementStateRef.current = state;
    setEngagementState(state);
  };

  const markMeaningfulActivity = () => {
    const now = Date.now();
    lastMeaningfulLearnerActivityAtRef.current = now;
    lastCandidateLearnerActivityAtRef.current = now;
    if (engagementStateRef.current === "active") {
      addDebugMessage("Meaningful learner activity");
    }
  };

  const applyAuthoritativeTeachingPreferences = (next: TeachingPreferences) => {
    teachingPreferencesRef.current = next;
    setTeachingPreferences(next);
  };

  const updateRecentTeachingContext = (conceptId: string | null, transcript: string) => {
    if (!conceptId || !lessonStateRef.current.nodes[conceptId]) return;
    const excerpt = createRecentTeachingExcerpt(transcript);
    if (!excerpt) return;
    const matching = recentTeachingContextRef.current
      .filter((entry) => entry.conceptId === conceptId);
    if (matching.at(-1)?.excerpt === excerpt) return;
    recentTeachingContextRef.current = [
      ...matching,
      { conceptId, excerpt },
    ].slice(-MAX_RECENT_TEACHING_CONTEXT_ENTRIES);
    addDebugMessage(
      `Resume teaching context updated: concept=${conceptId}, ` +
      `entries=${recentTeachingContextRef.current.length}`,
    );
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
    const currentState = stateOverride ?? lessonStateRef.current;
    return structuredClone<SavedLesson>({
      schemaVersion: SAVED_LESSON_SCHEMA_VERSION,
      id,
      title: source.name,
      lessonFocus: topicInput.trim(),
      hasStarted: resumeExistingLessonRef.current,
      source: {
        metadata: { ...source, status: "ready", error: undefined },
        prepared,
      },
      lessonState: {
        ...currentState,
        // M6.1 persists lesson continuity, not conversation history.
        lastUserTranscript: "",
        lastAssistantTranscript: "",
      },
      recentTeachingContext: recentTeachingContextRef.current,
      teachingPreferences: teachingPreferencesRef.current,
      createdAt,
      updatedAt: now,
    });
  };

  const persistLessonSnapshot = async (snapshot: SavedLesson) => {
    try {
      await saveActiveLesson(snapshot);
      setSavedLessons((current) => [
        snapshot,
        ...current.filter((lesson) => lesson.id !== snapshot.id),
      ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      if (savedLessonIdRef.current === snapshot.id && !savedLessonWasPersistedRef.current) {
        savedLessonWasPersistedRef.current = true;
        addDebugMessage(`Saved lesson created: ${snapshot.id}`);
      } else {
        addDebugMessage("Lesson autosaved");
      }
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

  const hydrateSavedLesson = (saved: SavedLesson) => {
    preparedSourceRef.current = saved.source.prepared;
    lessonStateRef.current = saved.lessonState;
    recentTeachingContextRef.current = saved.recentTeachingContext;
    teachingPreferencesRef.current = saved.teachingPreferences;
    savedLessonIdRef.current = saved.id;
    savedLessonCreatedAtRef.current = saved.createdAt;
    savedLessonWasPersistedRef.current = true;
    resumeExistingLessonRef.current = saved.hasStarted;
    setLearningSource(saved.source.metadata);
    setLessonState(saved.lessonState);
    setTeachingPreferences(saved.teachingPreferences);
    setTopicInput(saved.lessonFocus);
    setSavedLessonId(saved.id);
    setResumeExistingLesson(saved.hasStarted);
    setCurrentUtterance("");
    setUserError("");
    addDebugMessage(
      `Restored resume teaching context: entries=${saved.recentTeachingContext.length}`,
    );
  };

  const resetIdleLessonWorkspace = () => {
    const emptyLesson = createLessonState("Uploaded material", []);
    preparedSourceRef.current = null;
    lessonStateRef.current = emptyLesson;
    recentTeachingContextRef.current = [];
    teachingPreferencesRef.current = DEFAULT_TEACHING_PREFERENCES;
    savedLessonIdRef.current = null;
    savedLessonCreatedAtRef.current = null;
    savedLessonWasPersistedRef.current = false;
    resumeExistingLessonRef.current = false;
    setLearningSource(null);
    setLessonState(emptyLesson);
    setTeachingPreferences(DEFAULT_TEACHING_PREFERENCES);
    setTopicInput("");
    setSavedLessonId(null);
    setResumeExistingLesson(false);
    setCurrentUtterance("");
    setUserError("");
  };

  const startNewLessonFlow = () => {
    if (lessonActiveRef.current) return;
    if (persistenceSaveTimerRef.current) clearTimeout(persistenceSaveTimerRef.current);
    persistenceSaveTimerRef.current = null;
    const outgoingSnapshot = createCurrentLessonSnapshot();
    if (outgoingSnapshot) void persistLessonSnapshot(outgoingSnapshot);
    resetIdleLessonWorkspace();
    addDebugMessage("New lesson setup opened");
  };

  const selectSavedLesson = async (id: string) => {
    if (lessonActiveRef.current || lessonLibraryBusyId) return;
    setLessonLibraryBusyId(id);
    try {
      if (persistenceSaveTimerRef.current) clearTimeout(persistenceSaveTimerRef.current);
      persistenceSaveTimerRef.current = null;
      const outgoingSnapshot = createCurrentLessonSnapshot();
      if (outgoingSnapshot) await persistLessonSnapshot(outgoingSnapshot);
      const saved = await getSavedLesson(id);
      if (!saved) {
        setUserError("That saved lesson is unavailable or incompatible.");
        setSavedLessons((current) => current.filter((lesson) => lesson.id !== id));
        return;
      }
      await setActiveLessonId(id);
      hydrateSavedLesson(saved);
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
    if (!window.confirm(`Delete "${saved.title}"?\n\nThis removes its local source and progress.`)) {
      return;
    }
    setLessonLibraryBusyId(saved.id);
    try {
      if (savedLessonIdRef.current === saved.id && persistenceSaveTimerRef.current) {
        clearTimeout(persistenceSaveTimerRef.current);
        persistenceSaveTimerRef.current = null;
      }
      await deleteSavedLesson(saved.id);
      setSavedLessons((current) => current.filter((lesson) => lesson.id !== saved.id));
      if (savedLessonIdRef.current === saved.id) resetIdleLessonWorkspace();
      addDebugMessage(`Saved lesson deleted: ${saved.id}`);
    } catch {
      setPersistenceNotice("That saved lesson could not be deleted on this device.");
      addDebugMessage("Local persistence unavailable");
    } finally {
      setLessonLibraryBusyId(null);
    }
  };

  const handlePreparedSourceChange = (source: PreparedLearningSource | null) => {
    if (!source) {
      const outgoingSnapshot = createCurrentLessonSnapshot();
      if (outgoingSnapshot) void persistLessonSnapshot(outgoingSnapshot);
    }
    preparedSourceRef.current = source;
    recentTeachingContextRef.current = [];
    const outlineState = createLessonState(
      source ? `Main topics in ${source.name}` : "Uploaded material",
      source?.lessonTree ?? [],
    );
    lessonStateRef.current = outlineState;
    setLessonState(outlineState);
    if (!source) return;

    const id = createLocalLessonId();
    const createdAt = new Date().toISOString();
    savedLessonIdRef.current = id;
    savedLessonCreatedAtRef.current = createdAt;
    savedLessonWasPersistedRef.current = false;
    resumeExistingLessonRef.current = false;
    setSavedLessonId(id);
    setResumeExistingLesson(false);
  };

  const handleLearningSourceChange = (source: LearningSource | null) => {
    setLearningSource(source);
    if (source !== null) return;
    savedLessonIdRef.current = null;
    savedLessonCreatedAtRef.current = null;
    savedLessonWasPersistedRef.current = false;
    resumeExistingLessonRef.current = false;
    teachingPreferencesRef.current = DEFAULT_TEACHING_PREFERENCES;
    setSavedLessonId(null);
    setResumeExistingLesson(false);
    setTeachingPreferences(DEFAULT_TEACHING_PREFERENCES);
    if (persistenceAvailableRef.current) {
      void clearActiveLessonId().catch(() => {
        persistenceAvailableRef.current = false;
        setPersistenceNotice("Local lesson saving is unavailable on this device.");
        addDebugMessage("Local persistence unavailable");
      });
    }
  };

  const changeActiveTeachingPreference = (update: TeachingPreferenceUpdate) => {
    if (preferenceUpdatePending) return;
    const current = teachingPreferencesRef.current;
    const next = { ...current, ...update };
    if (next.explanationDepth === current.explanationDepth &&
        next.speakingSpeed === current.speakingSpeed) return;
    const requested = update.explanationDepth
      ? `depth=${update.explanationDepth}`
      : `speakingSpeed=${update.speakingSpeed}`;
    const text = update.explanationDepth
      ? `Please use ${update.explanationDepth} explanations from now on.`
      : `Please use a ${update.speakingSpeed} speaking speed from now on.`;
    if (!transportRef.current?.sendLearnerText(text)) {
      setUserError("The teaching style could not be updated while reconnecting. Try again.");
      return;
    }
    markMeaningfulActivity();
    addDebugMessage(`Teaching preference update requested: ${requested}`);
    setPreferenceUpdatePending(true);
    if (preferenceUpdateTimerRef.current) clearTimeout(preferenceUpdateTimerRef.current);
    preferenceUpdateTimerRef.current = setTimeout(() => {
      preferenceUpdateTimerRef.current = null;
      setPreferenceUpdatePending(false);
    }, 5_000);
  };

  const navigateFromRoadmap = (node: LessonState["nodes"][string]) => {
    if (!lessonActiveRef.current || roadmapNavigationPendingRef.current) return;
    if (node.id === lessonStateRef.current.currentNodeId || node.childrenIds.length) return;
    playerRef.current?.clear();
    assistantSpeakingRef.current = false;
    transportRef.current?.setAssistantSpeaking(false);
    const path = [node.title];
    let parentId = node.parentId;
    while (parentId) {
      const parent = lessonStateRef.current.nodes[parentId];
      if (!parent) break;
      path.unshift(parent.title);
      parentId = parent.parentId;
    }
    const text = `Go to "${path.join(" > ")}" in the lesson roadmap.`;
    if (!transportRef.current?.sendLearnerText(text)) {
      setUserError("That lesson navigation could not be sent while reconnecting. Try again.");
      return;
    }
    lastMeaningfulLearnerTranscriptRef.current = text;
    markMeaningfulActivity();
    const preferences = teachingPreferencesRef.current;
    addDebugMessage(`Roadmap navigation requested: target=${node.title}`);
    addDebugMessage(
      `Teaching preferences before navigation: depth=${preferences.explanationDepth}, ` +
      `speakingSpeed=${preferences.speakingSpeed}`,
    );
    setRoadmapNavigationPending(true);
    roadmapNavigationPendingRef.current = true;
    if (roadmapNavigationTimerRef.current) clearTimeout(roadmapNavigationTimerRef.current);
    roadmapNavigationTimerRef.current = setTimeout(() => {
      roadmapNavigationTimerRef.current = null;
      setRoadmapNavigationPending(false);
      roadmapNavigationPendingRef.current = false;
    }, 5_000);
  };

  const scheduleIdleEnd = () => {
    if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
    confirmationTimerRef.current = setTimeout(() => {
      if (engagementStateRef.current !== "confirming") return;
      addDebugMessage("Session ended due to inactivity");
      void stopConversation("inactivity");
    }, IDLE_CONFIRMATION_MS);
  };

  const requestIdleConfirmation = () => {
    if (!lessonActiveRef.current || engagementStateRef.current === "confirming") return;
    updateEngagementState("possibly-idle");
    addDebugMessage("Possible inactivity");
    updateEngagementState("confirming");
    addDebugMessage("Idle confirmation requested");
    transportRef.current?.sendRealtimeInput({
      text: "[[APP_CONTROL:IDLE_CONFIRMATION]]",
    });
    scheduleIdleEnd();
  };

  const beginIdleMonitoring = () => {
    const now = Date.now();
    lastMeaningfulLearnerActivityAtRef.current = now;
    lastCandidateLearnerActivityAtRef.current = now;
    updateEngagementState("active");
    engagementTimerRef.current = setInterval(() => {
      if (!lessonActiveRef.current || engagementStateRef.current !== "active") return;
      const lastMeaningful = lastMeaningfulLearnerActivityAtRef.current ?? Date.now();
      if (Date.now() - lastMeaningful < IDLE_AFTER_MS) return;
      requestIdleConfirmation();
    }, ENGAGEMENT_CHECK_INTERVAL_MS);
  };

  const toggleMicrophoneMute = async () => {
    if (microphoneMuteTransitionRef.current) return;
    const muted = !microphoneMutedRef.current;
    microphoneMuteTransitionRef.current = true;
    try {
      if (muted && transportRef.current?.getInterruptionContinuity().learnerUtteranceOpen) {
        // Keep forwarding enabled until the worklet confirms every PCM sample
        // produced before the explicit mute boundary has reached the transport.
        await microphoneStreamerRef.current?.flushPendingAudio();
      }
      microphoneMutedRef.current = muted;
      transportRef.current?.setMicrophoneForwardingEnabled(!muted);
      setMicrophoneMuted(muted);
      markMeaningfulActivity();
      addDebugMessage(
        muted ? "Microphone forwarding muted" : "Microphone forwarding unmuted",
      );
    } finally {
      microphoneMuteTransitionRef.current = false;
    }
  };

  const sendQuickResponse = (response: QuickResponse) => {
    const confirming = engagementStateRef.current === "confirming";
    let text = response === "Yes"
      ? "Yes."
      : response === "Repeat"
        ? "Please repeat or re-explain the last explanation."
        : "Continue with the lesson.";

    if (confirming && response === "Repeat") {
      text = "Please repeat the question asking whether I want to continue.";
    }

    if (!transportRef.current?.sendLearnerText(text)) {
      setUserError("The quick response could not be sent while reconnecting. Try again.");
      return;
    }

    lastMeaningfulLearnerTranscriptRef.current = text;
    markMeaningfulActivity();
    addDebugMessage(`Quick response sent: ${response}`);
    if (confirming && (response === "Yes" || response === "Continue")) {
      if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
      confirmationTimerRef.current = null;
      updateEngagementState("active");
      addDebugMessage("Quick response confirmed session continuation");
    } else if (confirming && response === "Repeat") {
      scheduleIdleEnd();
    }

    setQuickResponseFeedback(`${response} sent`);
    if (quickResponseTimerRef.current) clearTimeout(quickResponseTimerRef.current);
    quickResponseTimerRef.current = setTimeout(() => {
      setQuickResponseFeedback("");
      quickResponseTimerRef.current = null;
    }, 1_500);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [result, library] = await Promise.all([
          loadActiveLesson(),
          listSavedLessons(),
        ]);
        if (cancelled) return;
        addDebugMessage("IndexedDB opened");
        setSavedLessons(library);
        addDebugMessage(`Saved lesson library loaded: ${library.length} lessons`);
        if (result.status === "incompatible") {
          addDebugMessage("Saved lesson schema incompatible");
          await clearActiveLessonId();
        } else if (result.status === "restored") {
          const saved = result.lesson;
          hydrateSavedLesson(saved);
          addDebugMessage(`Restored saved lesson: ${saved.id}`);
        }
      } catch {
        if (!cancelled) {
          persistenceAvailableRef.current = false;
          setPersistenceNotice("Local lesson saving is unavailable on this device.");
          addDebugMessage("Local persistence unavailable");
        }
      } finally {
        if (!cancelled) {
          persistenceHydratedRef.current = true;
          setPersistenceHydrated(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    lessonState.currentNodeId,
    lessonState.nodes,
    lessonState.teachingContractProgress,
    lessonState.resumePoint,
    lessonState.status,
    teachingPreferences,
    topicInput,
  ]);

  useEffect(() => {
    isMountedRef.current = true;

    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    setShowIosInstallHint(/iPad|iPhone|iPod/.test(navigator.userAgent) && !standalone);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && lessonActiveRef.current) {
        void requestWakeLock();
        transportRef.current?.ensureHealthy();
        void playerRef.current?.prepare().catch(() => {
          setUserError("Audio was suspended. End the lesson, then start again.");
          addDebugMessage("Audio context could not resume after backgrounding");
        });
      } else if (document.visibilityState === "hidden" && lessonActiveRef.current) {
        addDebugMessage("App backgrounded; mobile audio or connection may be suspended");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      isMountedRef.current = false;
      conversationRunRef.current += 1;
      void disposeResources(false);
    };
  }, []);

  const handleLiveMessage = (message: LiveServerMessage) => {
    if (message.toolCallCancellation?.ids) {
      for (const id of message.toolCallCancellation.ids) {
        cancelledToolCallIdsRef.current.add(id);
      }
    }

    if (message.toolCall?.functionCalls?.length) {
      handleLessonToolCalls(message.toolCall.functionCalls);
      return;
    }

    const serverContent = message.serverContent;
    const voiceActivity = message.voiceActivity?.voiceActivityType;
    // Update transport gating before interruption handling. Gemini can deliver
    // ACTIVITY_START and interrupted together; ordering this first prevents a
    // pending graceful rollover from retiring the socket between those events.
    if (voiceActivity === "ACTIVITY_START") {
      transportRef.current?.setLearnerSpeaking(true);
    } else if (voiceActivity === "ACTIVITY_END") {
      transportRef.current?.setLearnerSpeaking(false);
    }
    if (serverContent?.inputTranscription?.text) {
      const transcriptFragment = serverContent.inputTranscription.text;
      if (isMeaningfulLearnerTranscript(transcriptFragment)) {
        lastMeaningfulLearnerTranscriptRef.current = mergeTranscript(
          lastMeaningfulLearnerTranscriptRef.current,
          transcriptFragment,
        );
        lastCandidateLearnerActivityAtRef.current = Date.now();
        transportRef.current?.noteLearnerTurnReceived();
        if (engagementStateRef.current === "active") markMeaningfulActivity();
        else if (engagementStateRef.current === "confirming") {
          meaningfulConfirmationSpeechRef.current = true;
        }
      }
      const wasInterrupted = lessonStateRef.current.status === "interrupted";
      userTranscriptRef.current = mergeTranscript(
        userTranscriptRef.current,
        serverContent.inputTranscription.text,
      );
      setCurrentUtterance(userTranscriptRef.current);
      updateLessonState((current) => ({
        ...current,
        status:
          current.status === "interrupted"
            ? "resolving-interruption"
            : current.status,
        lastUserTranscript: userTranscriptRef.current,
      }));

      if (wasInterrupted) {
        addDebugMessage("Resolving learner interruption");
      }
    }

    if (serverContent?.outputTranscription?.text) {
      lastAssistantTurnCompleteRef.current = false;
      if (!assistantTurnActiveRef.current) {
        assistantTurnActiveRef.current = true;
        assistantTranscriptRef.current = "";
        assistantCheckpointConceptIdRef.current = lessonStateRef.current.currentNodeId;
      }
      if (persistedResumeBriefingPendingRef.current &&
          !persistedResumeFirstResponseLoggedRef.current) {
        persistedResumeFirstResponseLoggedRef.current = true;
        addDebugMessage("First persisted-resume response received");
      }
      if (engagementStateRef.current === "confirming" && !assistantSpeakingRef.current) {
        addDebugMessage("Idle confirmation spoken");
      }
      assistantTranscriptRef.current = mergeTranscript(
        assistantTranscriptRef.current,
        serverContent.outputTranscription.text,
      );
      setCurrentUtterance(assistantTranscriptRef.current);
      updateLessonState((current) => ({
        ...current,
        lastAssistantTranscript: assistantTranscriptRef.current,
      }));
    }

    if (serverContent?.interrupted) {
      // Gemini cuts playback immediately. Smoothing a mid-phoneme cutoff is a
      // later UX refinement; yielding to the learner remains the priority.
      playerRef.current?.clear();
      assistantSpeakingRef.current = false;
      const interruption = transportRef.current?.registerInterruption(
        roadmapNavigationPendingRef.current,
      );
      transportRef.current?.setAssistantSpeaking(false);
      assistantTurnActiveRef.current = false;
      lastAssistantTurnCompleteRef.current = false;
      if (!interruption?.duplicate) {
        const current = lessonStateRef.current;
        const interruptedTranscript =
          assistantTranscriptRef.current || current.lastAssistantTranscript;
        const currentConcept = getCurrentConcept(current)?.title || "current concept";
        const resumePoint = deriveResumePoint(
          interruptedTranscript,
          currentConcept,
        );
        updateLessonState((state) => ({
          ...state,
          status: "interrupted",
          resumePoint,
          interruptionCount: state.interruptionCount + 1,
          lastAssistantTranscript: interruptedTranscript,
        }));
        resumptionPendingRef.current = true;
        addDebugMessage("Assistant interrupted");
        addDebugMessage(`Resume point saved: ${resumePoint}`);
      }
    }

    if (voiceActivity === "ACTIVITY_START") {
      userTranscriptRef.current = "";
      lastMeaningfulLearnerTranscriptRef.current = "";
      lastCandidateLearnerActivityAtRef.current = Date.now();
      addDebugMessage("User speech started");
      if (lessonStateRef.current.status === "interrupted") {
        updateLessonState((current) => ({
          ...current,
          status: "resolving-interruption",
        }));
        addDebugMessage("Resolving learner interruption");
      }
    } else if (voiceActivity === "ACTIVITY_END") {
      addDebugMessage("User speech ended");
    }

    if (!serverContent) return;

    for (const part of serverContent.modelTurn?.parts ?? []) {
      const audio = part.inlineData;
      if (!audio?.data || !audio.mimeType?.startsWith("audio/")) continue;

      if (!assistantSpeakingRef.current) {
        assistantSpeakingRef.current = true;
        transportRef.current?.setAssistantSpeaking(true);
        sourceGroundingPendingRef.current = false;
        if (!assistantTurnActiveRef.current) {
          assistantTurnActiveRef.current = true;
          assistantTranscriptRef.current = "";
          assistantCheckpointConceptIdRef.current = lessonStateRef.current.currentNodeId;
        }
        if (persistedResumeBriefingPendingRef.current &&
            !persistedResumeFirstResponseLoggedRef.current) {
          persistedResumeFirstResponseLoggedRef.current = true;
          addDebugMessage("First persisted-resume response received");
        }
        if (resumptionPendingRef.current) {
          updateLessonState((current) => ({
            ...current,
            status: "resuming",
          }));
          addDebugMessage("Lesson resuming");
        }
        addDebugMessage("Assistant response started");
      }
      playerRef.current?.play(audio.data);
    }

    if (serverContent.generationComplete) {
      assistantSpeakingRef.current = false;
      assistantTurnActiveRef.current = false;
      lastAssistantTurnCompleteRef.current = true;
      transportRef.current?.setAssistantSpeaking(false);
      const completedAssistantTranscript =
        assistantTranscriptRef.current || lessonStateRef.current.lastAssistantTranscript;
      if (engagementStateRef.current !== "confirming") {
        updateRecentTeachingContext(
          assistantCheckpointConceptIdRef.current,
          completedAssistantTranscript,
        );
      }
      updateLessonState((state) => {
        const assistantTranscript = completedAssistantTranscript || state.lastAssistantTranscript;
        const checkpoint = deriveResumePoint(assistantTranscript, "");
        const checkpointMatchesCurrent = Boolean(
          checkpoint && state.currentNodeId &&
          assistantCheckpointConceptIdRef.current === state.currentNodeId,
        );
        return {
          ...state,
          status: state.status === "idle" ? "idle" : "teaching",
          lastAssistantTranscript: assistantTranscript,
          resumePoint: checkpointMatchesCurrent ? checkpoint : state.resumePoint,
        };
      });
      resumptionPendingRef.current = false;
      if (persistedResumeBriefingPendingRef.current) {
        persistedResumeBriefingPendingRef.current = false;
        addDebugMessage("Resume briefing completed");
      }
      addDebugMessage("Assistant response completed");
    }
  };

  const handleLessonToolCalls = (calls: FunctionCall[]) => {
    const functionResponses: Array<Record<string, unknown>> = [];
    let endAfterResponse = false;
    let postResumeQueryReceived = false;
    let recoveryQueryReceived = false;
    let requestSilentRecovery = false;

    for (const call of calls) {
      const id = call.id;
      if (!id) {
        addDebugMessage("Lesson tool call missing required response ID");
        continue;
      }
      if (cancelledToolCallIdsRef.current.has(id)) continue;
      const args = call.args ?? {};
      const action = args.action;
      const conceptId = args.conceptId;
      const teachingPointIndex = args.teachingPointIndex;
      const isRoadmapNavigation = call.name === "lesson_state" &&
        action === "navigate" && roadmapNavigationPendingRef.current;
      const isLessonQuery = call.name === "lesson_state" && action === "query";
      if (isLessonQuery && transportRef.current?.isPostResumeSynchronizing()) {
        postResumeQueryReceived = true;
        addDebugMessage("Post-resume state query received");
      }
      if (isLessonQuery && silentLessonRecoveryPendingRef.current) {
        recoveryQueryReceived = true;
      }

      const cached = toolResultsRef.current.get(id);
      if (cached) {
        functionResponses.push({ id, name: call.name || "lesson_state", response: cached });
        continue;
      }

      addDebugMessage(call.name === "session_control"
        ? "Session control tool call received"
        : call.name === "update_teaching_preferences"
          ? "Teaching preference tool call received"
          : "Lesson tool call received");
      let result;
      let events: string[] = [];

      if (call.name === "update_teaching_preferences") {
        const next = applyTeachingPreferenceUpdate(
          teachingPreferencesRef.current,
          args as Record<string, unknown>,
        );
        if (preferenceUpdateTimerRef.current) clearTimeout(preferenceUpdateTimerRef.current);
        preferenceUpdateTimerRef.current = null;
        setPreferenceUpdatePending(false);
        if (next) {
          applyAuthoritativeTeachingPreferences(next);
          transportRef.current?.updateSystemInstruction(buildLessonInstruction(
            topicInput.trim(),
            learningSource?.name,
            next,
          ));
          addDebugMessage(
            `Teaching preferences updated: depth=${next.explanationDepth}, speakingSpeed=${next.speakingSpeed}`,
          );
          result = { ok: true, teachingPreferences: next };
        } else {
          result = {
            ok: false,
            error: "invalid_teaching_preferences",
            teachingPreferences: teachingPreferencesRef.current,
          };
        }
      } else if (call.name === "session_control") {
        if (engagementStateRef.current !== "confirming" && action === "continue") {
          result = { ok: true, action: "continue", message: "Session is already active" };
        } else if (engagementStateRef.current !== "confirming") {
          result = { ok: false, message: "No idle confirmation is active" };
        } else if (action === "continue") {
          if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
          confirmationTimerRef.current = null;
          updateEngagementState("active");
          if (meaningfulConfirmationSpeechRef.current) markMeaningfulActivity();
          meaningfulConfirmationSpeechRef.current = false;
          addDebugMessage("Continue confirmed");
          result = { ok: true, action: "continue", message: "Continue the current lesson" };
        } else if (action === "end") {
          meaningfulConfirmationSpeechRef.current = false;
          addDebugMessage("End confirmed");
          result = { ok: true, action: "end", message: "End the lesson" };
          endAfterResponse = true;
        } else {
          meaningfulConfirmationSpeechRef.current = false;
          addDebugMessage("Idle confirmation unclear");
          result = { ok: true, action: "unclear", message: "Remain in confirmation" };
        }
      } else if (call.name !== "lesson_state") {
        result = { ok: false, error: `Unknown function: ${call.name || "missing"}` };
      } else if (action === "query") {
        const state = lessonStateRef.current;
        const continuity: ConversationContinuity = {
          lastMeaningfulLearnerTranscript:
            lastMeaningfulLearnerTranscriptRef.current || undefined,
          lastAssistantTranscript:
            assistantTranscriptRef.current || state.lastAssistantTranscript || undefined,
          lastAssistantTurnComplete: lastAssistantTurnCompleteRef.current,
          interruptedAssistantTranscript:
            !lastAssistantTurnCompleteRef.current
              ? assistantTranscriptRef.current || state.lastAssistantTranscript || undefined
              : undefined,
          resumePoint: state.resumePoint || undefined,
          ...(transportRef.current?.getInterruptionContinuity() ?? {
            learnerUtteranceActive: false,
            learnerUtteranceOpen: false,
            interruptionAlreadyRegistered: false,
          }),
        };
        result = {
          ...queryLessonState(state),
          ...(postResumeQueryReceived
            ? {
                continuity,
                teachingPreferences: teachingPreferencesRef.current,
              }
            : {}),
        };
        if (postResumeQueryReceived) {
          addDebugMessage("Post-resume continuity snapshot prepared");
          addDebugMessage("Teaching preferences included in post-resume state");
        }
        addDebugMessage("Lesson state queried");
      } else if (
        action === "progress" && typeof conceptId === "string" && conceptId &&
        typeof teachingPointIndex === "number" && Number.isInteger(teachingPointIndex)
      ) {
        const transition = progressLessonTeachingPoint(
          lessonStateRef.current,
          conceptId,
          teachingPointIndex,
        );
        result = transition.result;
        events = transition.events;
        if (transition.state !== lessonStateRef.current) {
          lessonStateRef.current = transition.state;
          setLessonState(transition.state);
        }
        if (transition.result.recoveryRequired && !silentLessonRecoveryPendingRef.current) {
          silentLessonRecoveryPendingRef.current = true;
          requestSilentRecovery = true;
        }
      } else if (
        (action === "navigate" || action === "complete" || action === "skip") &&
        typeof conceptId === "string" && conceptId
      ) {
        if (action === "complete") {
          const requestedNode = lessonStateRef.current.nodes[conceptId];
          addDebugMessage(
            `Atomic concept completion requested: ${requestedNode?.title || "unknown concept"}`,
          );
        }
        const transition = action === "navigate"
          ? navigateLessonState(lessonStateRef.current, conceptId)
          : action === "complete"
            ? completeLessonConcept(lessonStateRef.current, conceptId)
            : skipLessonNode(lessonStateRef.current, conceptId);
        result = transition.result;
        events = transition.events;
        if (transition.state !== lessonStateRef.current) {
          lessonStateRef.current = transition.state;
          setLessonState(transition.state);
        }
        if (transition.result.ok && (action === "navigate" || action === "complete")) {
          const active = getCurrentConcept(transition.state);
          if (active?.teaching) {
            addDebugMessage(
              `Teaching contract progress: concept=${active.title}, ` +
              `next=${transition.state.teachingContractProgress[active.id]
                ?.nextTeachingPointIndex ?? 0}, total=${active.teaching.teachingPoints.length}`,
            );
          }
        }
        if (action === "navigate") {
          if (isRoadmapNavigation) {
            const preferences = teachingPreferencesRef.current;
            addDebugMessage("lesson_state.navigate completed");
            addDebugMessage(
              `Teaching preferences after navigation: depth=${preferences.explanationDepth}, ` +
              `speakingSpeed=${preferences.speakingSpeed}`,
            );
          }
          if (roadmapNavigationTimerRef.current) clearTimeout(roadmapNavigationTimerRef.current);
          roadmapNavigationTimerRef.current = null;
          setRoadmapNavigationPending(false);
          roadmapNavigationPendingRef.current = false;
        }
        if (transition.result.recoveryRequired && !silentLessonRecoveryPendingRef.current) {
          silentLessonRecoveryPendingRef.current = true;
          requestSilentRecovery = true;
        }
      } else {
        const snapshot = queryLessonState(lessonStateRef.current);
        const missingConcept = action === "navigate" || action === "progress" ||
          action === "complete" || action === "skip";
        result = {
          ...snapshot,
          ok: false,
          message: missingConcept
            ? "A concept is required for this operation"
            : "Unsupported lesson-state action",
          error: missingConcept ? "missing_concept_id" : "invalid_action",
          recoveryRequired: missingConcept,
        };
        if (missingConcept && !silentLessonRecoveryPendingRef.current) {
          silentLessonRecoveryPendingRef.current = true;
          requestSilentRecovery = true;
        }
      }

      if (call.name === "lesson_state" && result && typeof result === "object") {
        result = {
          ...result,
          teachingPreferences: teachingPreferencesRef.current,
        };
        if (isRoadmapNavigation) {
          addDebugMessage("Teaching preferences included in lesson_state.navigate response");
        }
      }
      for (const event of events) addDebugMessage(event);
      const response = { result };
      toolResultsRef.current.set(id, response);
      functionResponses.push({ id, name: call.name || "lesson_state", response });
    }

    if (functionResponses.length === 0) return;
    if (transportRef.current?.sendToolResponse(functionResponses)) {
      addDebugMessage("Lesson state tool response sent");
      if (postResumeQueryReceived) {
        addDebugMessage("Post-resume state response sent");
        transportRef.current.completePostResumeSynchronization();
      }
      if (recoveryQueryReceived) {
        silentLessonRecoveryPendingRef.current = false;
        addDebugMessage("Silent lesson-state recovery complete");
      } else if (requestSilentRecovery) {
        addDebugMessage("Silent lesson-state recovery started");
        transportRef.current?.sendRealtimeInput({
          text: "[[APP_CONTROL:LESSON_STATE_RECOVERY]]",
        });
      }
    } else {
      addDebugMessage("Realtime error: Live connection closed before lesson state response");
    }
    if (endAfterResponse) window.setTimeout(() => void stopConversation("confirmed"), 250);
  };

  const startConversation = async () => {
    setUserError("");
    if (
      learningSource?.status !== "ready" ||
      !preparedSourceRef.current
    ) {
      addDebugMessage("Source grounding failed: a ready learning source is required");
      return;
    }

    const activeSource = learningSource;
    const preparedSource = preparedSourceRef.current;
    const lessonFocus = topicInput.trim();
    const lessonTopic = lessonFocus || `Main topics in ${activeSource.name}`;
    const continuingSavedLesson = resumeExistingLessonRef.current;
    const sessionStartMode: LessonSessionStartMode = continuingSavedLesson
      ? "persisted-resume"
      : "new";
    const persistedResumeContext = continuingSavedLesson
      ? getPersistedResumeContext(
          lessonStateRef.current,
          recentTeachingContextRef.current,
        )
      : null;
    const sessionInitialTeachingPreferences = { ...teachingPreferencesRef.current };
    const requestFreshToken = async () => {
      addDebugMessage("Gemini token requested");
      const controller = new AbortController();
      tokenRequestRef.current = controller;
      const response = await fetch("/api/gemini-token", {
        method: "POST",
        cache: "no-store",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: lessonFocus,
          source: { name: activeSource.name, mimeType: activeSource.mimeType },
          teachingPreferences: teachingPreferencesRef.current,
        }),
      });
      const body = (await response.json()) as {
        token?: string;
        newSessionExpiresAt?: number;
        error?: string;
        source?: { name: string; mimeType: string };
      };
      if (!response.ok || !body.token || !body.source) {
        throw new Error(body.error || "Gemini token request failed");
      }
      if (tokenRequestRef.current === controller) tokenRequestRef.current = null;
      addDebugMessage("Gemini token received");
      return {
        token: body.token,
        source: body.source,
        newSessionExpiresAt: body.newSessionExpiresAt,
      };
    };
    const initialLessonState = continuingSavedLesson
      ? lessonStateRef.current
      : createLessonState(lessonTopic, preparedSource.lessonTree);
    if (!continuingSavedLesson) {
      lessonStateRef.current = initialLessonState;
      setLessonState(initialLessonState);
    }
    const startingConcept = getCurrentConcept(initialLessonState);
    if (startingConcept?.teaching) {
      addDebugMessage(
        `Teaching contract progress: concept=${startingConcept.title}, ` +
        `next=${initialLessonState.teachingContractProgress[startingConcept.id]
          ?.nextTeachingPointIndex ?? 0}, total=${startingConcept.teaching.teachingPoints.length}`,
      );
    }
    setTopicInput(lessonFocus);
    userTranscriptRef.current = "";
    lastMeaningfulLearnerTranscriptRef.current = "";
    assistantTranscriptRef.current = "";
    lastAssistantTurnCompleteRef.current = true;
    setCurrentUtterance("");
    resumptionPendingRef.current = false;
    addDebugMessage(
      continuingSavedLesson
        ? `Saved lesson continuation initialized: ${activeSource.name}`
        : `Lesson initialized from source: ${activeSource.name}`,
    );
    addDebugMessage(continuingSavedLesson ? "Saved lesson tree restored" : "Lesson tree initialized");
    addDebugMessage(
      `Teaching preferences initialized: depth=${sessionInitialTeachingPreferences.explanationDepth}, ` +
      `speakingSpeed=${sessionInitialTeachingPreferences.speakingSpeed}`,
    );
    const firstConcept = getCurrentConcept(initialLessonState);
    if (firstConcept) {
      if (firstConcept.teaching) {
        addDebugMessage(`Teaching contract loaded: ${firstConcept.title}`);
      }
      addDebugMessage(`Atomic concept started: ${firstConcept.title}`);
    }

    const run = ++conversationRunRef.current;
    setMicrophoneStatus("Requesting permission");
    setAiConnectionStatus("Not connected");
    addDebugMessage("Microphone permission requested");

    const player = new PcmAudioPlayer();
    playerRef.current = player;
    const playerReady = player.prepare();

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access is not supported by this browser");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isMountedRef.current || run !== conversationRunRef.current) {
        stream.getAudioTracks().forEach((track) => track.stop());
        await player.close();
        return;
      }

      streamRef.current = stream;
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.addEventListener("ended", () => {
          if (!isMountedRef.current || run !== conversationRunRef.current) return;
          setUserError("The microphone stopped unexpectedly. Start the lesson again.");
          addDebugMessage("Microphone stream ended unexpectedly");
          conversationRunRef.current += 1;
          setMicrophoneStatus("Not active");
          setAiConnectionStatus("Not connected");
          updateLessonState((current) => ({ ...current, status: "idle" }));
          void disposeResources(false);
        }, { once: true });
      }
      setMicrophoneStatus("Active");
      addDebugMessage("Microphone active");
      await playerReady;

      setAiConnectionStatus("Connecting");
      const tokenBody = await requestFreshToken();
      if (!isMountedRef.current || run !== conversationRunRef.current) return;

      addDebugMessage("Live connection opening");
      const systemInstruction = buildLessonInstruction(
        lessonFocus,
        tokenBody.source.name,
        sessionInitialTeachingPreferences,
        sessionStartMode,
      );

      const transport = new LiveTransportManager({
        model: GEMINI_LIVE_MODEL,
        systemInstruction,
        requestToken: requestFreshToken,
        onMessage: (message) => {
          if (isMountedRef.current && run === conversationRunRef.current) {
            handleLiveMessage(message);
          }
        },
        onDebug: addDebugMessage,
        onStateChange: (state) => {
          if (!isMountedRef.current || run !== conversationRunRef.current) return;
          setTransportState(state);
          setAiConnectionStatus(
            state === "active" || state === "rollover-ready"
              ? "Connected"
              : state === "closed"
                ? "Not connected"
                : "Connecting",
          );
        },
        seedFreshRecovery: (socket) => {
          const coverage = queryLessonState(lessonStateRef.current);
          socket.seedRecoveryContext({ ...preparedSource, focus: lessonFocus }, {
            coverage,
            currentTeachingContract: getCurrentConcept(lessonStateRef.current)?.teaching,
            contractProgress: coverage.currentTeachingProgress,
            resumePoint: lessonStateRef.current.resumePoint,
            teachingPreferences: teachingPreferencesRef.current,
          });
        },
        onFatalError: (message) => {
          if (!isMountedRef.current || run !== conversationRunRef.current) return;
          setUserError(`The realtime lesson could not recover: ${message}`);
          setAiConnectionStatus("Error");
          setMicrophoneStatus("Not active");
          updateLessonState((current) => ({ ...current, status: "idle" }));
          conversationRunRef.current += 1;
          void disposeResources(false);
        },
      });
      transportRef.current = transport;
      const session = await transport.connectInitial(tokenBody.token);

      if (!isMountedRef.current || run !== conversationRunRef.current) {
        transport.close(false);
        return;
      }

      setAiConnectionStatus("Connected");
      addDebugMessage("Live connection established");
      sourceGroundingPendingRef.current = true;
      addDebugMessage("Source seeding started");
      if (continuingSavedLesson) {
        const current = getCurrentConcept(lessonStateRef.current);
        const contractNext = current?.teaching
          ? lessonStateRef.current.teachingContractProgress[current.id]?.nextTeachingPointIndex ?? 0
          : 0;
        const coverage = queryLessonState(lessonStateRef.current);
        session.seedRecoveryContext({ ...preparedSource, focus: lessonFocus }, {
          coverage,
          currentTeachingContract: getCurrentConcept(lessonStateRef.current)?.teaching,
          contractProgress: coverage.currentTeachingProgress,
          persistedResumeContext,
          resumePoint: lessonStateRef.current.resumePoint,
          teachingPreferences: teachingPreferencesRef.current,
        });
        addDebugMessage(
          `Persisted resume seed: concept=${persistedResumeContext?.currentConceptTitle || "current lesson topic"}, ` +
          `status=${persistedResumeContext?.currentConceptStatus || "unknown"}, ` +
          `resumePointAvailable=${persistedResumeContext?.resumePointAvailable ? "yes" : "no"}, ` +
          `recentContextEntries=${persistedResumeContext?.recentTeachingContext.length ?? 0}`,
        );
        addDebugMessage(
          `Persisted contract resume: concept=${current?.title || "current lesson topic"}, ` +
          `next=${contractNext}, total=${current?.teaching?.teachingPoints.length ?? 0}`,
        );
        addDebugMessage(
          `Persisted resume context delivered: ` +
          `recentContextEntries=${persistedResumeContext?.recentTeachingContext.length ?? 0}, ` +
          `resumePointAvailable=${persistedResumeContext?.resumePointAvailable ? "yes" : "no"}`,
        );
      } else {
        session.seedInitialSource({
          ...preparedSource,
          focus: lessonFocus,
        });
      }
      addDebugMessage("Source seeded into Live context");
      addDebugMessage("Source grounding ready");

      const microphoneStreamer = new MicrophonePcmStreamer(stream, (chunk) => {
        if (run !== conversationRunRef.current || transportRef.current !== transport) return;
        const rms = pcm16Rms(chunk);
        noiseFloorRef.current += (rms - noiseFloorRef.current) * NOISE_FLOOR_SMOOTHING;
        if (rms >= Math.max(MIN_ACOUSTIC_RMS, noiseFloorRef.current * ACOUSTIC_ACTIVITY_MULTIPLIER)) {
          lastAcousticActivityAtRef.current = Date.now();
          if (Date.now() - lastAcousticLogAtRef.current >= ACOUSTIC_LOG_COOLDOWN_MS) {
            lastAcousticLogAtRef.current = Date.now();
            addDebugMessage("Acoustic activity detected");
          }
        }
        if (!microphoneMutedRef.current) transport.sendAudio(chunk);
      });
      microphoneStreamerRef.current = microphoneStreamer;
      await microphoneStreamer.start();

      if (!isMountedRef.current || run !== conversationRunRef.current) {
        await microphoneStreamer.stop();
        return;
      }

      addDebugMessage("Microphone streaming started");
      updateLessonState((current) => ({
        ...current,
        status: "teaching",
      }));
      resumeExistingLessonRef.current = true;
      setResumeExistingLesson(true);
      addDebugMessage("Lesson started");
      lessonActiveRef.current = true;
      beginIdleMonitoring();
      void requestWakeLock();
      if (sessionStartMode === "persisted-resume") {
        const current = getCurrentConcept(lessonStateRef.current);
        const resumePoint = lessonStateRef.current.resumePoint.trim();
        addDebugMessage("Persisted lesson continuation started");
        addDebugMessage(`Resume briefing requested: concept=${current?.title || "current lesson topic"}`);
        addDebugMessage(`Resume point available: ${resumePoint ? "yes" : "no"}`);
        addDebugMessage(
          `Teaching preferences on resume: depth=${sessionInitialTeachingPreferences.explanationDepth}, ` +
          `speakingSpeed=${sessionInitialTeachingPreferences.speakingSpeed}`,
        );
        persistedResumeFirstResponseLoggedRef.current = false;
        persistedResumeBriefingPendingRef.current = transport.sendLearnerText(
          PERSISTED_LESSON_RESUME_CONTROL,
        );
        if (persistedResumeBriefingPendingRef.current) {
          addDebugMessage("Resume briefing control sent");
        }
      } else {
        transport.sendRealtimeInput({
          text: `Begin the source-grounded spoken lesson now. Identify the uploaded material as "${tokenBody.source.name}", briefly preview what you will cover, then teach the first concept${
            lessonFocus ? ` related to ${lessonFocus}` : " from the source"
          }.`,
        });
      }
    } catch (error) {
      if (!isMountedRef.current || run !== conversationRunRef.current) return;

      const permissionDenied =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");

      if (permissionDenied) {
        setMicrophoneStatus("Permission denied");
        setUserError("Microphone permission was denied. Allow access in browser settings and try again.");
        addDebugMessage("Microphone permission denied");
        await disposeResources(false);
        return;
      }

      if (streamRef.current) {
        setAiConnectionStatus("Error");
        const message = getRealtimeErrorMessage(error);
        if (message.toLowerCase().includes("source")) {
          addDebugMessage(`Source grounding failed: ${message}`);
        }
        addDebugMessage(`Realtime error: ${message}`);
        setUserError(`The realtime lesson could not start: ${message}`);
        await disposeResources(false);
        setMicrophoneStatus("Not active");
        updateLessonState((current) => ({ ...current, status: "idle" }));
        addDebugMessage("Microphone stopped");
      } else {
        setMicrophoneStatus("Error");
        const message = getMicrophoneErrorMessage(error);
        setUserError(message);
        addDebugMessage(`Microphone error: ${message}`);
        await player.close();
      }
    }
  };

  const stopConversation = async (reason?: "inactivity" | "confirmed") => {
    conversationRunRef.current += 1;
    const hadMicrophone = Boolean(streamRef.current);
    const hadSession = Boolean(transportRef.current);
    const currentBeforeStop = getCurrentConcept(lessonStateRef.current);
    const checkpoint = deriveResumePoint(assistantTranscriptRef.current, "");
    const checkpointMatchesCurrent = Boolean(
      checkpoint && currentBeforeStop &&
      assistantCheckpointConceptIdRef.current === currentBeforeStop.id,
    );
    if (checkpointMatchesCurrent) {
      updateRecentTeachingContext(
        assistantCheckpointConceptIdRef.current,
        assistantTranscriptRef.current,
      );
    }
    const stoppedLessonState = pauseLessonState(
      lessonStateRef.current,
      checkpointMatchesCurrent && currentBeforeStop
        ? { conceptId: currentBeforeStop.id, resumePoint: checkpoint }
        : undefined,
    );
    const persistedCurrent = getCurrentConcept(stoppedLessonState);
    setMicrophoneStatus("Not active");
    setAiConnectionStatus("Not connected");
    lessonStateRef.current = stoppedLessonState;
    setLessonState(stoppedLessonState);
    addDebugMessage(
      `Persisting resume state: concept=${persistedCurrent
        ? `${persistedCurrent.id}/${persistedCurrent.title}`
        : "none"}, status=${persistedCurrent?.status || "none"}, ` +
      `resumePointAvailable=${stoppedLessonState.resumePoint ? "yes" : "no"}, ` +
      `recentContextEntries=${recentTeachingContextRef.current.length}`,
    );
    if (persistedCurrent?.teaching) {
      addDebugMessage(
        `Persisting teaching progress: concept=${persistedCurrent.id}/${persistedCurrent.title}, ` +
        `next=${stoppedLessonState.teachingContractProgress[persistedCurrent.id]
          ?.nextTeachingPointIndex ?? 0}, total=${persistedCurrent.teaching.teachingPoints.length}`,
      );
    }
    await persistCurrentLesson(stoppedLessonState);
    await disposeResources(true);

    if (reason === "inactivity") {
      setUserError("The lesson ended after no response to the inactivity check.");
    } else if (reason === "confirmed") {
      setUserError("The lesson has ended.");
    }

    if (hadMicrophone) addDebugMessage("Microphone stopped");
    if (hadSession) addDebugMessage("Live connection closed");
  };

  const microphoneActive = microphoneStatus === "Active";
  const aiConnected = aiConnectionStatus === "Connected";
  const requestingPermission = microphoneStatus === "Requesting permission";
  const currentTeachingContract = getCurrentConcept(lessonState)?.teaching;
  const currentConcept = getCurrentConcept(lessonState);
  const lessonActive = microphoneActive || requestingPermission || aiConnected;

  const requestInstall = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  return (
    <main className="page-shell">
      <section className={`tutor-card${lessonActive ? " lesson-active" : ""}`} aria-labelledby="page-title">
        <header className="hero">
          <p className="eyebrow">Learning workspace</p>
          <h1 id="page-title">Conversational AI Tutor</h1>
          <p className="intro setup-only">
            A simple workspace for realtime, voice-guided conversation.
          </p>
        </header>

        {!lessonActive && savedLessons.length > 0 && (
          <RecentLessons
            lessons={savedLessons}
            activeLessonId={savedLessonId}
            busyLessonId={lessonLibraryBusyId}
            onContinue={(id) => void selectSavedLesson(id)}
            onDelete={(saved) => void requestDeleteSavedLesson(saved)}
            onNewLesson={startNewLessonFlow}
          />
        )}

        <div className="setup-only">
          <LearningSourceUpload
            source={learningSource}
            disabled={microphoneActive || requestingPermission || !persistenceHydrated}
            onChange={handleLearningSourceChange}
            onPreparedChange={handlePreparedSourceChange}
            onDebug={addDebugMessage}
          />
        </div>

        <label className="topic-field setup-only">
          <span>Lesson topic or focus (optional)</span>
          <input
            type="text"
            value={topicInput}
            onChange={(event) => setTopicInput(event.target.value)}
            placeholder="Leave blank to teach the source's main topics"
            maxLength={160}
            disabled={microphoneActive || requestingPermission}
          />
        </label>

        {!lessonActive && (
          <section className="teaching-style setup-only" aria-labelledby="teaching-style-title">
            <h2 id="teaching-style-title">Teaching style</h2>
            <TeachingStyleControls
              preferences={teachingPreferences}
              disabled={requestingPermission}
              onChange={(update) => {
                applyAuthoritativeTeachingPreferences({
                  ...teachingPreferencesRef.current,
                  ...update,
                });
              }}
            />
          </section>
        )}

        {learningSource && lessonActive && (
          <section className="active-summary" aria-label="Active lesson overview">
            <p className="active-source" title={learningSource.name}>{learningSource.name}</p>
            <p className="active-label">Current concept</p>
            <h2>{currentConcept?.title || "Preparing lesson…"}</h2>
            <p className="active-teaching-style">
              Teaching: {capitalize(teachingPreferences.explanationDepth)} · Speech: {capitalize(teachingPreferences.speakingSpeed)}
            </p>
            <p className="current-utterance">
              {currentUtterance
                ? `“${currentUtterance}”`
                : "Listening for the lesson to begin…"}
            </p>
          </section>
        )}

        {lessonActive && (
          <details className="active-teaching-preferences">
            <summary>Teaching style</summary>
            <TeachingStyleControls
              preferences={teachingPreferences}
              disabled={preferenceUpdatePending}
              onChange={changeActiveTeachingPreference}
            />
            {preferenceUpdatePending && (
              <p className="preference-pending" role="status">Updating teaching style…</p>
            )}
          </details>
        )}

        {lessonState.rootNodeIds.length > 0 && (
          <LessonRoadmap
            lessonState={lessonState}
            lessonActive={lessonActive}
            navigationPending={roadmapNavigationPending}
            onNavigate={navigateFromRoadmap}
          />
        )}

        {userError && <p className="session-error" role="alert">{userError}</p>}
        {persistenceNotice && <p className="session-error" role="status">{persistenceNotice}</p>}

        <div className="status-row" aria-label="Conversation status">
          <div className="status-item" aria-live="polite">
            <span
              className={`status-dot${microphoneActive ? " status-dot-active" : ""}`}
              aria-hidden="true"
            />
            <span>
              <strong>Microphone</strong>
              <small>{microphoneStatus}</small>
            </span>
          </div>
          <div className="status-item" aria-live="polite">
            <span
              className={`status-dot${aiConnected ? " status-dot-active" : ""}`}
              aria-hidden="true"
            />
            <span>
              <strong>Connection</strong>
              <small>{aiConnectionStatus}</small>
            </span>
          </div>
        </div>

        {lessonActive && (
          <section className="lesson-controls" aria-label="Lesson response controls">
            <button
              className={`mute-button${microphoneMuted ? " mute-button-active" : ""}`}
              type="button"
              onClick={toggleMicrophoneMute}
              aria-label={microphoneMuted ? "Unmute microphone" : "Mute microphone"}
              aria-pressed={microphoneMuted}
            >
              {microphoneMuted ? "Unmute" : "Mute"}
            </button>
            {microphoneMuted && (
              <p className="mute-notice" role="status">
                Microphone muted — tutor cannot hear you
              </p>
            )}
            <div className="quick-responses" aria-label="Quick responses">
              <button type="button" onClick={() => sendQuickResponse("Yes")} aria-label="Yes">
                Yes
              </button>
              <button type="button" onClick={() => sendQuickResponse("Repeat")} aria-label="Repeat explanation">
                Repeat
              </button>
              <button type="button" onClick={() => sendQuickResponse("Continue")} aria-label="Continue lesson">
                Continue
              </button>
            </div>
            <p className="quick-response-feedback" role="status" aria-live="polite">
              {quickResponseFeedback}
            </p>
          </section>
        )}

        <button
          className="start-button"
          type="button"
          onClick={microphoneActive ? () => void stopConversation() : startConversation}
          disabled={
            requestingPermission ||
            (!microphoneActive && (!persistenceHydrated || learningSource?.status !== "ready"))
          }
        >
          {microphoneActive
            ? "End Lesson"
            : requestingPermission
              ? "Requesting Permission..."
              : resumeExistingLesson
                ? "Continue Lesson"
                : "Start Conversation"}
        </button>

        <section className="lesson-state" aria-labelledby="lesson-state-title">
          <div className="panel-heading">
            <h2 id="lesson-state-title">Lesson State</h2>
            <span>Development</span>
          </div>
          <dl className="engineering-state">
            <div>
              <dt>Topic</dt>
              <dd>{lessonState.topic}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{lessonState.status}</dd>
            </div>
            <div>
              <dt>Current concept</dt>
              <dd>{getCurrentConcept(lessonState)?.title || "-"}</dd>
            </div>
            <div>
              <dt>Resume point</dt>
              <dd>{lessonState.resumePoint || "-"}</dd>
            </div>
            <div>
              <dt>Interruptions</dt>
              <dd>{lessonState.interruptionCount}</dd>
            </div>
            <div>
              <dt>Transport</dt>
              <dd>{transportState}</dd>
            </div>
            <div>
              <dt>Engagement</dt>
              <dd>{engagementState}</dd>
            </div>
            <div>
              <dt>Latest learner transcript</dt>
              <dd>{lessonState.lastUserTranscript || "-"}</dd>
            </div>
            <div>
              <dt>Latest tutor transcript</dt>
              <dd>{lessonState.lastAssistantTranscript || "-"}</dd>
            </div>
          </dl>
          <div className="coverage-map">
            <h3>Lesson Coverage</h3>
            {lessonState.rootNodeIds.length === 0 ? (
              <p>No lesson tree loaded.</p>
            ) : (
              <ol>
                {getLessonTreeRows(lessonState).map(({ node, depth }) => (
                  <li
                    key={node.id}
                    className={
                      node.id === lessonState.currentNodeId
                        ? "coverage-current"
                        : undefined
                    }
                    style={{ paddingLeft: `${Math.min(depth * 16, 48)}px` }}
                  >
                    <span aria-hidden="true">
                      {node.id === lessonState.currentNodeId
                        ? "▶"
                        : node.status === "taught"
                          ? "✓"
                          : node.status === "partial"
                            ? "◐"
                            : node.status === "skipped"
                              ? "○"
                              : "·"}
                    </span>
                    <strong>{node.title}</strong>
                    <small>{node.status.replace("-", " ")}</small>
                  </li>
                ))}
              </ol>
            )}
          </div>
          {currentTeachingContract && (
            <div className="teaching-contract">
              <h3>Current Teaching Contract</h3>
              <p className="contract-meta">
                {currentTeachingContract.type.replace("-", " ")} · {currentTeachingContract.importance}
                {currentTeachingContract.sourceConfidence
                  ? ` · ${currentTeachingContract.sourceConfidence}`
                  : ""}
              </p>
              <h4>Objective</h4>
              <p>{currentTeachingContract.objective}</p>
              <h4>Teaching points</h4>
              <ul>
                {currentTeachingContract.teachingPoints.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <h4>Completion criteria</h4>
              <ul>
                {currentTeachingContract.completionCriteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
              {currentTeachingContract.sourceReferences?.length ? (
                <p><strong>Source:</strong> {currentTeachingContract.sourceReferences.join(", ")}</p>
              ) : null}
              {currentTeachingContract.keyTerms?.length ? (
                <p><strong>Terms:</strong> {currentTeachingContract.keyTerms.join(", ")}</p>
              ) : null}
              {currentTeachingContract.notation?.length ? (
                <p><strong>Notation:</strong> {currentTeachingContract.notation.join(", ")}</p>
              ) : null}
              {currentTeachingContract.uncertaintyNote ? (
                <p><strong>Uncertainty:</strong> {currentTeachingContract.uncertaintyNote}</p>
              ) : null}
            </div>
          )}
        </section>

        <details className="transcript">
          <summary id="transcript-title">Show Debug</summary>
          <div className="transcript-body" role="log" aria-live="polite" aria-labelledby="transcript-title">
            {process.env.NODE_ENV === "development" && lessonActive && (
              <div className="debug-session-controls" aria-label="Development session controls">
                <button type="button" onClick={() => transportRef.current?.requestSafeRolloverForTest()}>
                  Force safe rollover
                </button>
                <button type="button" onClick={() => transportRef.current?.requestImmediateRolloverForTest()}>
                  Force immediate rollover
                </button>
                <button type="button" onClick={() => transportRef.current?.requestImmediateRolloverForTest(true)}>
                  Test recovery fallback
                </button>
                <button type="button" onClick={requestIdleConfirmation}>
                  Test idle confirmation
                </button>
                <button
                  type="button"
                  onClick={() => transportRef.current?.sendRealtimeInput({
                    text: "[[APP_CONTROL:TEST_INVALID_ID]]",
                  })}
                >
                  Test invalid lesson ID
                </button>
              </div>
            )}
            {debugMessages.length === 0 ? (
              <p>Conversation events and transcript messages will appear here.</p>
            ) : (
              <ol className="debug-messages">
                {debugMessages.map((message) => (
                  <li key={message.id}>
                    <time>{message.timestamp}</time> {message.text}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </details>

        {!lessonActive && (installPrompt || showIosInstallHint) && (
          <aside className="install-hint">
            {installPrompt ? (
              <button type="button" onClick={requestInstall}>Install AI Tutor</button>
            ) : (
              <p>On iPhone or iPad: open in Safari, tap Share, then Add to Home Screen.</p>
            )}
          </aside>
        )}
      </section>
    </main>
  );
}
