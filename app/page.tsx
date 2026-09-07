"use client";

import type { FunctionCall, LiveServerMessage } from "@google/genai";
import type { User } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import { LearningSourceUpload } from "../components/learning-source-upload";
import { LessonRoadmap } from "../components/lesson-roadmap";
import { RecentLessons } from "../components/recent-lessons";
import { SourceVisual } from "../components/source-visual";
import { ProcessingQueue } from "../components/processing-queue";
import CloudAccount from "../components/cloud-account";
import type {
  LearningSource,
  LessonSource,
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
  MAX_RECENT_TEACHING_EXCERPT_LENGTH,
  SAVED_LESSON_SCHEMA_VERSION,
  clearActiveLessonId,
  deleteSavedLesson,
  getSavedLesson,
  getSavedLessonContentSignature,
  listSavedLessons,
  loadActiveLesson,
  saveActiveLesson,
  saveSavedLesson,
  setActiveLessonId,
  type SavedLesson,
} from "../lib/local-persistence";
import {
  createCloudCompatibleLessonId,
  associateCloudLesson,
  deleteCloudLesson,
  isUuid,
  reconcileCloudLessons,
  uploadCloudLessonSources,
  type CloudSyncState,
} from "../lib/cloud-sync";
import { isSupabaseConfigured } from "../lib/supabase/config";
import { useLessonProcessingQueue } from "../lib/use-lesson-processing-queue";

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
type AfterDelivery = "continue" | "await-learner";
type GenerationMode = "teaching-point" | "clarification" | "control";
type GenerationIntent = {
  mode: GenerationMode;
  conceptId?: string;
  teachingPointIndex?: number;
};
type ActiveTeachingGeneration = GenerationIntent & {
  generationId: number;
  progressRequested: boolean;
  closing: boolean;
  afterDelivery: AfterDelivery;
  generationComplete: boolean;
  playbackComplete: boolean;
  cancelled: boolean;
  transcript: string;
  acceptedAudioEvents: number;
  suppressedAudioEvents: number;
  suppressedTranscriptEvents: number;
};
type TurnOrigin = "learner" | "app-control";

type ConversationContinuity = {
  lastMeaningfulLearnerTranscript?: string;
  lastAssistantTranscript?: string;
  lastAssistantTurnComplete: boolean;
  interruptedAssistantTranscript?: string;
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
) {
  const current = getCurrentConcept(state);
  const progress = current ? state.teachingContractProgress[current.id] : undefined;
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
    previousCoveredConceptTitle: previousCovered?.title ?? null,
    lastCompletedCheckpoint: progress?.lastCompletedCheckpoint ?? null,
  };
}

function createRecentTeachingExcerpt(transcript: string) {
  const concise = transcript.trim().replace(/\s+/g, " ");
  if (!concise) return "";
  return concise.length <= MAX_RECENT_TEACHING_EXCERPT_LENGTH
    ? concise
    : `${concise.slice(0, MAX_RECENT_TEACHING_EXCERPT_LENGTH - 3).trimEnd()}...`;
}

// Gemini Live output transcription is an incremental stream for the current
// generation. Preserve the provider's ordering and append each fragment once;
// cumulative-hypothesis merging belongs only to interim input transcription.
function appendTranscriptDelta(current: string, fragment: string) {
  if (!fragment) return current;
  if (!current) return fragment.trimStart();
  const needsSpace = !/\s$/.test(current) && !/^\s|^[.,!?;:]/.test(fragment);
  return `${current}${needsSpace ? " " : ""}${fragment}`;
}

function describeLiveProviderEvent(message: LiveServerMessage) {
  if (message.serverContent?.modelTurn) return "serverContent.modelTurn";
  if (message.serverContent?.outputTranscription) return "serverContent.outputTranscription";
  if (message.serverContent?.generationComplete) return "serverContent.generationComplete";
  if (message.serverContent?.turnComplete) return "serverContent.turnComplete";
  if (message.serverContent?.interrupted) return "serverContent.interrupted";
  if (message.toolCall) return "toolCall";
  if (message.sessionResumptionUpdate) return "sessionResumptionUpdate";
  if (message.goAway) return "goAway";
  return "other";
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
  const [generationDiagnostic, setGenerationDiagnostic] = useState<ActiveTeachingGeneration | null>(null);
  const [persistenceHydrated, setPersistenceHydrated] = useState(false);
  const [persistenceNotice, setPersistenceNotice] = useState("");
  const [savedLessonId, setSavedLessonId] = useState<string | null>(null);
  const [resumeExistingLesson, setResumeExistingLesson] = useState(false);
  const [savedLessons, setSavedLessons] = useState<SavedLesson[]>([]);
  const [lessonLibraryBusyId, setLessonLibraryBusyId] = useState<string | null>(null);
  const [cloudUserId, setCloudUserId] = useState<string | null>(null);
  const [cloudAuthReady, setCloudAuthReady] = useState(!isSupabaseConfigured());
  const [cloudSyncState, setCloudSyncState] = useState<CloudSyncState>("local-only");
  const [cloudLessonCount, setCloudLessonCount] = useState(0);
  const [localOnlyLessonCount, setLocalOnlyLessonCount] = useState(0);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosInstallHint, setShowIosInstallHint] = useState(false);
  const [topicInput, setTopicInput] = useState("");
  const [lessonState, setLessonState] = useState<LessonState>(() =>
    createLessonState("Uploaded material"),
  );
  const [learningSource, setLearningSource] = useState<LearningSource | null>(null);
  const [lessonSources, setLessonSources] = useState<LessonSource[]>([]);
  const rawSourceFilesRef = useRef(new Map<string, File>());
  const sourceUploadsInFlightRef = useRef(new Set<string>());
  const sourceUploadsAttemptedRef = useRef(new Set<string>());
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
  const workspaceLoadedRef = useRef(false);

  const streamRef = useRef<MediaStream | null>(null);
  const transportRef = useRef<LiveTransportManager | null>(null);
  const microphoneStreamerRef = useRef<MicrophonePcmStreamer | null>(null);
  const playerRef = useRef<PcmAudioPlayer | null>(null);
  const tokenRequestRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const conversationRunRef = useRef(0);
  const lastAuthorityNodeIdRef = useRef<string | null>(null);
  const conversationStartPendingRef = useRef(false);
  const assistantSpeakingRef = useRef(false);
  const assistantTurnActiveRef = useRef(false);
  const assistantGenerationSequenceRef = useRef(0);
  const nextGenerationIntentRef = useRef<GenerationIntent>({ mode: "clarification" });
  const pendingTurnOriginRef = useRef<TurnOrigin | null>(null);
  const activeTeachingGenerationRef = useRef<ActiveTeachingGeneration | null>(null);
  const startupFirstProviderEventPendingRef = useRef(false);
  const startupFirstAudioPendingRef = useRef(false);
  const startupSessionRef = useRef(0);
  const userTranscriptRef = useRef("");
  const lastMeaningfulLearnerTranscriptRef = useRef("");
  const assistantTranscriptRef = useRef("");
  const lastAssistantTurnCompleteRef = useRef(true);
  const lessonStateRef = useRef(lessonState);
  const resumptionPendingRef = useRef(false);
  const persistedResumeBriefingPendingRef = useRef(false);
  const persistedResumeFirstResponseLoggedRef = useRef(false);
  const persistedResumeFirstAudioLoggedRef = useRef(false);
  const assistantCheckpointConceptIdRef = useRef<string | null>(null);
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

  const cancelActiveTeachingGeneration = (reason: string) => {
    const active = activeTeachingGenerationRef.current;
    if (!active) return;
    active.cancelled = true;
    addDebugMessage(`Teaching generation cancelled: generation=${active.generationId}, reason=${reason}`);
    if (active.progressRequested) {
      addDebugMessage(
        `Pending progress discarded: generation=${active.generationId}, ` +
        `point=${active.teachingPointIndex ?? "-"}, reason=${reason}`,
      );
    }
    activeTeachingGenerationRef.current = null;
    setGenerationDiagnostic(null);
  };

  const currentTeachingIntent = (): GenerationIntent => {
    const current = getCurrentConcept(lessonStateRef.current);
    if (!current?.teaching) return { mode: "control" };
    return {
      mode: "teaching-point",
      conceptId: current.id,
      teachingPointIndex:
        lessonStateRef.current.teachingContractProgress[current.id]?.nextTeachingPointIndex ?? 0,
    };
  };

  const tryCommitTeachingGeneration = (generationId: number) => {
    const active = activeTeachingGenerationRef.current;
    if (!active || active.generationId !== generationId || active.cancelled ||
        !active.generationComplete || !active.playbackComplete) return;
    if (active.mode !== "teaching-point" || !active.progressRequested ||
        !active.conceptId || active.teachingPointIndex === undefined) {
      activeTeachingGenerationRef.current = null;
      setGenerationDiagnostic(null);
      addDebugMessage(`Generation delivered without teaching commit: generation=${generationId}, mode=${active.mode}`);
      return;
    }
    const excerpt = createRecentTeachingExcerpt(active.transcript).slice(0, 420);
    const transition = progressLessonTeachingPoint(
      lessonStateRef.current,
      active.conceptId,
      active.teachingPointIndex,
      excerpt || undefined,
    );
    if (transition.state !== lessonStateRef.current) {
      lessonStateRef.current = transition.state;
      setLessonState(transition.state);
    }
    let committedState = transition.state;
    const node = committedState.nodes[active.conceptId];
    const next = committedState.teachingContractProgress[active.conceptId]?.nextTeachingPointIndex;
    if (node?.teaching && next === node.teaching.teachingPoints.length) {
      committedState = completeLessonConcept(committedState, active.conceptId).state;
    }
    if (committedState !== lessonStateRef.current) {
      lessonStateRef.current = committedState;
      setLessonState(committedState);
    }
    addDebugMessage(
      `Teaching point committed: generation=${generationId}, concept=${active.conceptId}, ` +
      `point=${active.teachingPointIndex}, next=${next}, checkpointTranscript=${excerpt ? "yes" : "no"}`,
    );
    const shouldContinue = active.afterDelivery === "continue";
    activeTeachingGenerationRef.current = null;
    setGenerationDiagnostic(null);
    if (!shouldContinue || !lessonActiveRef.current) return;
    const nextIntent = (() => {
      const current = getCurrentConcept(committedState);
      if (!current?.teaching) return null;
      const point = committedState.teachingContractProgress[current.id]?.nextTeachingPointIndex ?? 0;
      return point < current.teaching.teachingPoints.length
        ? { mode: "teaching-point" as const, conceptId: current.id, teachingPointIndex: point }
        : null;
    })();
    if (!nextIntent) return;
    nextGenerationIntentRef.current = nextIntent;
    pendingTurnOriginRef.current = "app-control";
    if (transportRef.current?.sendRealtimeInput({
      text: `[[APP_CONTROL:TEACH_POINT:${nextIntent.conceptId}:${nextIntent.teachingPointIndex}]]`,
    })) {
      addDebugMessage(`Next teaching generation requested: concept=${nextIntent.conceptId}, point=${nextIntent.teachingPointIndex}`);
    } else {
      nextGenerationIntentRef.current = { mode: "clarification" };
      addDebugMessage("Next teaching generation not sent: transport-not-ready");
    }
  };

  const ensureActiveGeneration = () => {
    const existing = activeTeachingGenerationRef.current;
    if (existing) return existing;
    const intent = nextGenerationIntentRef.current;
    nextGenerationIntentRef.current = { mode: "clarification" };
    pendingTurnOriginRef.current = null;
    const active: ActiveTeachingGeneration = {
      ...intent,
      generationId: ++assistantGenerationSequenceRef.current,
      progressRequested: false,
      closing: false,
      afterDelivery: "await-learner",
      generationComplete: false,
      playbackComplete: false,
      cancelled: false,
      transcript: "",
      acceptedAudioEvents: 0,
      suppressedAudioEvents: 0,
      suppressedTranscriptEvents: 0,
    };
    activeTeachingGenerationRef.current = active;
    setGenerationDiagnostic({ ...active });
    playerRef.current?.beginBatch(active.generationId, (id) => {
      const current = activeTeachingGenerationRef.current;
      if (!current || current.generationId !== id || current.cancelled) return;
      current.playbackComplete = true;
      setGenerationDiagnostic({ ...current });
      addDebugMessage(`Playback batch natural drain: generation=${id}`);
      tryCommitTeachingGeneration(id);
    });
    addDebugMessage(
      `Teaching generation started: generation=${active.generationId}, mode=${active.mode}, ` +
      `concept=${active.conceptId ?? "-"}, point=${active.teachingPointIndex ?? "-"}`,
    );
    return active;
  };

  const disposeResources = async (sendAudioStreamEnd: boolean) => {
    cancelActiveTeachingGeneration("session-disposed");
    pendingTurnOriginRef.current = null;
    conversationStartPendingRef.current = false;
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
    startupFirstProviderEventPendingRef.current = false;
    startupFirstAudioPendingRef.current = false;
    lastAssistantTurnCompleteRef.current = true;
    resumptionPendingRef.current = false;
    persistedResumeBriefingPendingRef.current = false;
    persistedResumeFirstResponseLoggedRef.current = false;
    persistedResumeFirstAudioLoggedRef.current = false;
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

  const processingQueue = useLessonProcessingQueue({
    ownerId: cloudUserId,
    onDebug: addDebugMessage,
    onLessonReady: (lesson) => {
      setSavedLessons((current) => [lesson, ...current.filter((item) => item.id !== lesson.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setPersistenceNotice(`${lesson.title} is ready to study.`);
    },
  });

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
          } else if (!lessonActiveRef.current && savedLessonIdRef.current === snapshot.id) {
            resetIdleLessonWorkspace();
            await clearActiveLessonId(ownerId);
          }
          await refreshScopedLibrary(ownerId);
          setCloudLessonCount(summary.cloudLessonCount);
          setCloudSyncState(summary.deferred > 0 ? "pending" : "synced");
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
    const currentState = stateOverride ?? lessonStateRef.current;
    const candidate = structuredClone<SavedLesson>({
      schemaVersion: SAVED_LESSON_SCHEMA_VERSION,
      id,
      title: source.name,
      lessonFocus: topicInput.trim(),
      hasStarted: resumeExistingLessonRef.current,
      source: {
        metadata: { ...source, status: "ready", error: undefined },
        prepared,
      },
      sources: lessonSources,
      lessonState: {
        ...currentState,
        // M6.1 persists lesson continuity, not conversation history.
        lastUserTranscript: "",
        lastAssistantTranscript: "",
      },
      recentTeachingContext: [],
      teachingPreferences: teachingPreferencesRef.current,
      createdAt,
      updatedAt: savedLessonUpdatedAtRef.current ?? now,
      cloudOwnerId: cloudOwnerIdRef.current,
      ...(cloudSyncMetadataRef.current ? { cloudSync: cloudSyncMetadataRef.current } : {}),
    });
    const contentSignature = getSavedLessonContentSignature(candidate);
    candidate.updatedAt = savedLessonContentSignatureRef.current === contentSignature &&
      savedLessonUpdatedAtRef.current
      ? savedLessonUpdatedAtRef.current
      : now;
    return candidate;
  };

  const persistLessonSnapshot = async (snapshot: SavedLesson) => {
    try {
      await saveActiveLesson(snapshot);
      if (savedLessonIdRef.current === snapshot.id) {
        savedLessonUpdatedAtRef.current = snapshot.updatedAt;
        savedLessonContentSignatureRef.current = getSavedLessonContentSignature(snapshot);
      }
      if ((snapshot.cloudOwnerId ?? null) === workspaceOwnerIdRef.current) {
        setSavedLessons((current) => [
          snapshot,
          ...current.filter((lesson) => lesson.id !== snapshot.id),
        ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      }
      if (savedLessonIdRef.current === snapshot.id && !savedLessonWasPersistedRef.current) {
        savedLessonWasPersistedRef.current = true;
        addDebugMessage(`Saved lesson created: ${snapshot.id}`);
      } else {
        addDebugMessage("Lesson autosaved");
      }
      scheduleCloudUpload(snapshot);
      if (snapshot.cloudOwnerId && rawSourceFilesRef.current.size > 0 &&
          snapshot.sources.some((item) => item.storageStatus !== "stored") &&
          !sourceUploadsInFlightRef.current.has(snapshot.id)) {
        if (sourceUploadsAttemptedRef.current.has(snapshot.id)) return;
        sourceUploadsAttemptedRef.current.add(snapshot.id);
        sourceUploadsInFlightRef.current.add(snapshot.id);
        void uploadCloudLessonSources(snapshot, rawSourceFilesRef.current, snapshot.cloudOwnerId, addDebugMessage)
          .then((synced) => {
            setLessonSources(synced.sources);
            applySyncedLessonMetadata(synced);
            setCloudSyncState(synced.sources.some((item) => item.storageStatus === "error") ? "pending" : "synced");
          })
          .catch(() => {
            setLessonSources((current) => current.map((item) => rawSourceFilesRef.current.has(item.id) && item.storageStatus !== "stored"
              ? { ...item, storageStatus: "error", storageError: "Original source upload failed." }
              : item));
            setCloudSyncState("pending");
          })
          .finally(() => sourceUploadsInFlightRef.current.delete(snapshot.id));
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
    rawSourceFilesRef.current = new Map();
    sourceUploadsAttemptedRef.current.clear();
    saved.sources.forEach((item) => addDebugMessage(`Source restored from cloud metadata: source=${item.id}`));
    setLessonState(saved.lessonState);
    setTeachingPreferences(saved.teachingPreferences);
    setTopicInput(saved.lessonFocus);
    setSavedLessonId(saved.id);
    setResumeExistingLesson(saved.hasStarted);
    setCurrentUtterance("");
    setUserError("");
  };

  const resetIdleLessonWorkspace = () => {
    const emptyLesson = createLessonState("Uploaded material", []);
    preparedSourceRef.current = null;
    lessonStateRef.current = emptyLesson;
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
    rawSourceFilesRef.current = new Map();
    sourceUploadsAttemptedRef.current.clear();
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
      if (!saved || (saved.cloudOwnerId ?? null) !== workspaceOwnerIdRef.current) {
        setUserError("That saved lesson is unavailable or incompatible.");
        setSavedLessons((current) => current.filter((lesson) => lesson.id !== id));
        return;
      }
      await setActiveLessonId(id, workspaceOwnerIdRef.current);
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
      if (savedLessonIdRef.current === saved.id) resetIdleLessonWorkspace();
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

  const handlePreparedSourceChange = (source: PreparedLearningSource | null) => {
    if (!source) {
      const outgoingSnapshot = createCurrentLessonSnapshot();
      if (outgoingSnapshot) void persistLessonSnapshot(outgoingSnapshot);
    }
    preparedSourceRef.current = source;
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
    savedLessonUpdatedAtRef.current = null;
    savedLessonContentSignatureRef.current = null;
    savedLessonWasPersistedRef.current = false;
    cloudOwnerIdRef.current = workspaceOwnerIdRef.current;
    cloudSyncMetadataRef.current = undefined;
    resumeExistingLessonRef.current = false;
    setSavedLessonId(id);
    setResumeExistingLesson(false);
  };

  const handleLearningSourceChange = (source: LearningSource | null) => {
    setLearningSource(source);
    if (source !== null) return;
    savedLessonIdRef.current = null;
    savedLessonCreatedAtRef.current = null;
    savedLessonUpdatedAtRef.current = null;
    savedLessonContentSignatureRef.current = null;
    savedLessonWasPersistedRef.current = false;
    resumeExistingLessonRef.current = false;
    teachingPreferencesRef.current = DEFAULT_TEACHING_PREFERENCES;
    setSavedLessonId(null);
    setResumeExistingLesson(false);
    setTeachingPreferences(DEFAULT_TEACHING_PREFERENCES);
    if (persistenceAvailableRef.current) {
      void clearActiveLessonId(workspaceOwnerIdRef.current).catch(() => {
        persistenceAvailableRef.current = false;
        setPersistenceNotice("Local lesson saving is unavailable on this device.");
        addDebugMessage("Local persistence unavailable");
      });
    }
  };

  const handleLessonSourcesChange = (sources: LessonSource[], files: Map<string, File>) => {
    setLessonSources(sources);
    rawSourceFilesRef.current = files;
  };

  const retrySourceUpload = () => {
    const id = savedLessonIdRef.current;
    if (!id || rawSourceFilesRef.current.size === 0) {
      setPersistenceNotice("Original files are no longer available in this browser session. Create a new lesson to reselect them.");
      return;
    }
    sourceUploadsAttemptedRef.current.delete(id);
    const snapshot = createCurrentLessonSnapshot();
    if (snapshot) void persistLessonSnapshot(snapshot);
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
    pendingTurnOriginRef.current = "learner";
    if (!transportRef.current?.sendLearnerText(text)) {
      setUserError("The teaching style could not be updated while reconnecting. Try again.");
      return;
    }
    nextGenerationIntentRef.current = { mode: "clarification" };
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
    nextGenerationIntentRef.current = {
      mode: "teaching-point",
      conceptId: node.id,
      teachingPointIndex: lessonStateRef.current.teachingContractProgress[node.id]?.nextTeachingPointIndex ?? 0,
    };
    pendingTurnOriginRef.current = "app-control";
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
    pendingTurnOriginRef.current = "app-control";
    nextGenerationIntentRef.current = { mode: "control" };
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

    nextGenerationIntentRef.current = response === "Repeat"
      ? { mode: "clarification" }
      : currentTeachingIntent();
    pendingTurnOriginRef.current = "learner";
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

  const refreshScopedLibrary = async (ownerId: string | null) => {
    const library = await listSavedLessons();
    const scoped = library.filter((lesson) => (lesson.cloudOwnerId ?? null) === ownerId);
    setSavedLessons(scoped);
    setLocalOnlyLessonCount(ownerId
      ? library.filter((lesson) => !lesson.cloudOwnerId).length
      : 0);
    addDebugMessage(`Saved lesson library loaded: ${scoped.length} lessons`);
    addDebugMessage(`Recent Lessons cache: scopedUniqueLessons=${new Set(scoped.map((lesson) => lesson.id)).size}`);
    const titleIds = new Map<string, string[]>();
    scoped.forEach((lesson) => {
      titleIds.set(lesson.title, [...(titleIds.get(lesson.title) ?? []), lesson.id]);
    });
    titleIds.forEach((ids) => {
      if (ids.length > 1) addDebugMessage(`Recent Lessons same-title IDs: ${ids.join(",")}`);
    });
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
      await refreshScopedLibrary(ownerId);
      if (!lessonActiveRef.current && savedLessonIdRef.current) {
        const refreshed = await getSavedLesson(savedLessonIdRef.current);
        if (refreshed?.cloudOwnerId === ownerId) {
          hydrateSavedLesson(refreshed);
        } else {
          resetIdleLessonWorkspace();
          await clearActiveLessonId(ownerId);
        }
      }
      setCloudSyncState(summary.deferred > 0 ? "pending" : "synced");
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
        const cloudId = isUuid(lesson.id) ? lesson.id : createCloudCompatibleLessonId();
        const candidate: SavedLesson = {
          ...structuredClone(lesson),
          id: cloudId,
          cloudOwnerId: ownerId,
          cloudSync: undefined,
        };
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

  useEffect(() => {
    const currentNode = lessonState.currentNodeId
      ? lessonState.nodes[lessonState.currentNodeId]
      : undefined;
    console.log("[LessonState authority]", {
      currentNodeId: lessonState.currentNodeId,
      currentConcept: currentNode?.title ?? null,
      status: currentNode?.status ?? null,
    });
    if (lastAuthorityNodeIdRef.current !== lessonState.currentNodeId) {
      const previous = lastAuthorityNodeIdRef.current
        ? lessonState.nodes[lastAuthorityNodeIdRef.current]
        : undefined;
      addDebugMessage(
        `Lesson concept transition: from=${lastAuthorityNodeIdRef.current ?? "none"}/${previous?.title ?? "none"}, ` +
        `to=${lessonState.currentNodeId ?? "none"}/${currentNode?.title ?? "none"}`,
      );
      lastAuthorityNodeIdRef.current = lessonState.currentNodeId;
    }
  }, [
    lessonState.currentNodeId,
    lessonState.currentNodeId
      ? lessonState.nodes[lessonState.currentNodeId]?.title
      : undefined,
    lessonState.currentNodeId
      ? lessonState.nodes[lessonState.currentNodeId]?.status
      : undefined,
  ]);

  useEffect(() => {
    if (!cloudAuthReady || lessonActiveRef.current || conversationStartPendingRef.current) return;
    const ownerId = cloudUserId;
    if (workspaceLoadedRef.current && workspaceOwnerIdRef.current === ownerId) return;
    const generation = ++workspaceLoadGenerationRef.current;
    void (async () => {
      try {
        if (persistenceHydratedRef.current) {
          const outgoing = createCurrentLessonSnapshot();
          if (outgoing) await persistLessonSnapshot(outgoing);
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
          refreshScopedLibrary(ownerId),
        ]);
        if (lessonActiveRef.current || conversationStartPendingRef.current) {
          addDebugMessage("Stale workspace restore ignored: lesson start is authoritative");
          return;
        }
        addDebugMessage("IndexedDB opened");
        if (result.status === "incompatible") {
          addDebugMessage("Saved lesson schema incompatible");
          await clearActiveLessonId(ownerId);
        } else if (result.status === "restored") {
          hydrateSavedLesson(result.lesson);
          addDebugMessage(`Restored saved lesson: ${result.lesson.id}`);
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
        pendingTurnOriginRef.current = "learner";
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
      const closingGeneration = activeTeachingGenerationRef.current;
      if (closingGeneration?.closing) {
        closingGeneration.suppressedTranscriptEvents += 1;
        setGenerationDiagnostic({ ...closingGeneration });
        addDebugMessage(
          `Post-progress transcript suppressed: generation=${closingGeneration.generationId}`,
        );
      } else {
      lastAssistantTurnCompleteRef.current = false;
      if (!assistantTurnActiveRef.current) {
        assistantTurnActiveRef.current = true;
        assistantTranscriptRef.current = "";
        assistantCheckpointConceptIdRef.current = lessonStateRef.current.currentNodeId;
        ensureActiveGeneration();
      }
      if (persistedResumeBriefingPendingRef.current &&
          !persistedResumeFirstResponseLoggedRef.current) {
        persistedResumeFirstResponseLoggedRef.current = true;
        addDebugMessage("First persisted-resume response received");
      }
      if (engagementStateRef.current === "confirming" && !assistantSpeakingRef.current) {
        addDebugMessage("Idle confirmation spoken");
      }
      assistantTranscriptRef.current = appendTranscriptDelta(
        assistantTranscriptRef.current,
        serverContent.outputTranscription.text,
      );
      const activeGeneration = activeTeachingGenerationRef.current;
      if (activeGeneration) {
        activeGeneration.transcript = assistantTranscriptRef.current;
        setGenerationDiagnostic({ ...activeGeneration });
      }
      setCurrentUtterance(assistantTranscriptRef.current);
      updateLessonState((current) => ({
        ...current,
        lastAssistantTranscript: assistantTranscriptRef.current,
      }));
      }
    }

    if (serverContent?.interrupted) {
      // Gemini cuts playback immediately. Smoothing a mid-phoneme cutoff is a
      // later UX refinement; yielding to the learner remains the priority.
      cancelActiveTeachingGeneration("interruption");
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
        updateLessonState((state) => ({
          ...state,
          status: "interrupted",
          interruptionCount: state.interruptionCount + 1,
          lastAssistantTranscript: interruptedTranscript,
        }));
        resumptionPendingRef.current = true;
        addDebugMessage("Assistant interrupted");
        addDebugMessage("Resume point preserved: reason=incomplete-assistant-turn");
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
      const closingGeneration = activeTeachingGenerationRef.current;
      if (closingGeneration?.closing) {
        closingGeneration.suppressedAudioEvents += 1;
        setGenerationDiagnostic({ ...closingGeneration });
        addDebugMessage(
          `Post-progress model audio suppressed: generation=${closingGeneration.generationId}, ` +
          `count=${closingGeneration.suppressedAudioEvents}`,
        );
        continue;
      }

      if (!assistantSpeakingRef.current) {
        if (startupFirstAudioPendingRef.current) {
          startupFirstAudioPendingRef.current = false;
          addDebugMessage(
            `First startup audio received: session=${startupSessionRef.current}`,
          );
        }
        assistantSpeakingRef.current = true;
        transportRef.current?.setAssistantSpeaking(true);
        sourceGroundingPendingRef.current = false;
        if (!assistantTurnActiveRef.current) {
          assistantTurnActiveRef.current = true;
          assistantTranscriptRef.current = "";
          assistantCheckpointConceptIdRef.current = lessonStateRef.current.currentNodeId;
          ensureActiveGeneration();
        }
        if (persistedResumeBriefingPendingRef.current &&
            !persistedResumeFirstResponseLoggedRef.current) {
          persistedResumeFirstResponseLoggedRef.current = true;
          addDebugMessage("First persisted-resume response received");
        }
        if (persistedResumeBriefingPendingRef.current &&
            !persistedResumeFirstAudioLoggedRef.current) {
          persistedResumeFirstAudioLoggedRef.current = true;
          addDebugMessage(
            `First resume audio received: session=${conversationRunRef.current}`,
          );
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
      const activeGeneration = activeTeachingGenerationRef.current;
      if (activeGeneration) activeGeneration.acceptedAudioEvents += 1;
      playerRef.current?.play(audio.data);
    }

    if (serverContent.generationComplete && assistantTurnActiveRef.current) {
      assistantSpeakingRef.current = false;
      assistantTurnActiveRef.current = false;
      lastAssistantTurnCompleteRef.current = true;
      transportRef.current?.setAssistantSpeaking(false);
      const activeGeneration = activeTeachingGenerationRef.current;
      if (activeGeneration) {
        activeGeneration.generationComplete = true;
        activeGeneration.transcript = assistantTranscriptRef.current;
        setGenerationDiagnostic({ ...activeGeneration });
        playerRef.current?.completeBatch(activeGeneration.generationId);
        addDebugMessage(`Provider generation complete: generation=${activeGeneration.generationId}`);
        tryCommitTeachingGeneration(activeGeneration.generationId);
      }
      const completedAssistantTranscript =
        assistantTranscriptRef.current || lessonStateRef.current.lastAssistantTranscript;
      updateLessonState((state) => {
        const assistantTranscript = completedAssistantTranscript || state.lastAssistantTranscript;
        return {
          ...state,
          status: state.status === "idle" ? "idle" : "teaching",
          lastAssistantTranscript: assistantTranscript,
        };
      });
      resumptionPendingRef.current = false;
      if (persistedResumeBriefingPendingRef.current) {
        persistedResumeBriefingPendingRef.current = false;
        addDebugMessage("Resume briefing completed");
      }
      addDebugMessage("Assistant response completed");
      addDebugMessage(
        `Assistant transcript finalized: generation=${assistantGenerationSequenceRef.current}`,
      );
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
      const afterDelivery: AfterDelivery = args.afterDelivery === "continue"
        ? "continue"
        : "await-learner";
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
      } else if (call.name === "learner_turn_intent") {
        const intent = args.intent;
        const appControl = pendingTurnOriginRef.current === "app-control";
        const route = appControl
          ? nextGenerationIntentRef.current
          : intent === "continue"
            ? currentTeachingIntent()
            : { mode: "clarification" as const };
        if (!activeTeachingGenerationRef.current) {
          nextGenerationIntentRef.current = route;
        }
        const authority = queryLessonState(lessonStateRef.current);
        result = {
          ok: true,
          intent,
          generationMode: route.mode,
          currentNodeId: authority.currentNodeId,
          currentConcept: authority.currentNodeTitle ?? null,
          status: authority.currentNodeStatus ?? null,
          nextTeachingPointIndex:
            authority.currentTeachingProgress?.nextTeachingPointIndex ?? null,
          totalTeachingPoints: authority.totalTeachingPoints ?? null,
          pointsHeard: authority.pointsHeard ?? null,
          nextConcept: authority.nextSequentialNode ?? null,
          ...(route.mode === "teaching-point"
            ? {
                assignedConceptId: route.conceptId,
                assignedTeachingPointIndex: route.teachingPointIndex,
                instruction: "Teach exactly this assigned point in this response.",
              }
            : appControl
              ? { instruction: "This is an application control. Follow its explicit control instruction; do not classify it as learner speech." }
            : intent === "query-state"
              ? { instruction: "Answer the learner only from this authoritative state." }
              : { instruction: "Answer this learner turn without committing teaching progress." }),
        };
        addDebugMessage(
          `${appControl ? "APP_CONTROL intent bypassed" : "Learner turn routed"}: ` +
          `intent=${String(intent)}, mode=${route.mode}, ` +
          `concept=${route.conceptId ?? "-"}, point=${route.teachingPointIndex ?? "-"}`,
        );
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
        const active = activeTeachingGenerationRef.current ?? ensureActiveGeneration();
        const authoritativeNext = lessonStateRef.current.teachingContractProgress[conceptId]
          ?.nextTeachingPointIndex ?? 0;
        const valid = active.mode === "teaching-point" && !active.cancelled &&
          !active.progressRequested && active.conceptId === conceptId &&
          active.teachingPointIndex === teachingPointIndex && authoritativeNext === teachingPointIndex;
        if (valid) {
          active.progressRequested = true;
          active.closing = true;
          // Interactive tutoring is learner-paced. Keep the requested value in
          // the schema for a future explicit lecture mode, but normal lessons
          // always wait for real learner input after an audio-confirmed point.
          active.afterDelivery = "await-learner";
          setGenerationDiagnostic({ ...active });
          result = {
            ...queryLessonState(lessonStateRef.current),
            ok: true,
            action: "progress",
            message: "Teaching-point completion registered for this generation. Do not begin the next teaching point in this response.",
          };
          addDebugMessage(
            `Teaching progress requested: generation=${active.generationId}, concept=${conceptId}, ` +
            `point=${teachingPointIndex}, requestedAfterDelivery=${afterDelivery}, ` +
            `effectiveAfterDelivery=await-learner`,
          );
          addDebugMessage(
            `Teaching generation closing: generation=${active.generationId}, point=${teachingPointIndex}`,
          );
        } else {
          result = {
            ...queryLessonState(lessonStateRef.current),
            ok: false,
            action: "progress",
            error: "invalid_transition",
            message: active.mode === "teaching-point"
              ? `This generation is assigned only to point ${active.teachingPointIndex ?? "-"}.`
              : "This response is not an assigned teaching-point generation.",
          };
          addDebugMessage(
            `Teaching progress rejected: generation=${active.generationId}, concept=${conceptId}, point=${teachingPointIndex}`,
          );
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
        pendingTurnOriginRef.current = "app-control";
        nextGenerationIntentRef.current = { mode: "control" };
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
    if (conversationStartPendingRef.current || lessonActiveRef.current) {
      addDebugMessage("Duplicate lesson start suppressed");
      return;
    }
    conversationStartPendingRef.current = true;
    setUserError("");
    if (
      learningSource?.status !== "ready" ||
      !preparedSourceRef.current
    ) {
      addDebugMessage("Source grounding failed: a ready learning source is required");
      conversationStartPendingRef.current = false;
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
    if (continuingSavedLesson) {
      addDebugMessage(
        `Persisted resume requested: lesson=${savedLessonIdRef.current || "unsaved"}`,
      );
    }
    const persistedResumeContext = continuingSavedLesson
      ? getPersistedResumeContext(lessonStateRef.current)
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
    addDebugMessage(
      `Lesson start requested: lesson=${savedLessonIdRef.current || "unsaved"}, ` +
      `mode=${sessionStartMode}, session=${run}`,
    );
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
            if (startupFirstProviderEventPendingRef.current) {
              startupFirstProviderEventPendingRef.current = false;
              addDebugMessage(
                `First provider event after startup: session=${run}, ` +
                `type=${describeLiveProviderEvent(message)}`,
              );
            }
            handleLiveMessage(message);
          }
        },
        onDebug: addDebugMessage,
        onStateChange: (state) => {
          if (!isMountedRef.current || run !== conversationRunRef.current) return;
          if (state === "handoff" || state === "recovering") {
            cancelActiveTeachingGeneration(`transport-${state}`);
            playerRef.current?.clear();
            nextGenerationIntentRef.current = { mode: "control" };
          }
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
      addDebugMessage(`Live logical session created: session=${run}`);
      const session = await transport.connectInitial(tokenBody.token);

      if (!isMountedRef.current || run !== conversationRunRef.current) {
        transport.close(false);
        return;
      }

      setAiConnectionStatus("Connected");
      addDebugMessage("Live connection established");
      addDebugMessage(`Live session opened: session=${run}`);
      sourceGroundingPendingRef.current = true;
      addDebugMessage("Source seeding started");
      if (continuingSavedLesson) {
        persistedResumeFirstResponseLoggedRef.current = false;
        persistedResumeFirstAudioLoggedRef.current = false;
        persistedResumeBriefingPendingRef.current = true;
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
          teachingPreferences: teachingPreferencesRef.current,
        });
        addDebugMessage("Resume history completed: turnComplete=true, modelCall=no");
        addDebugMessage(
          `Persisted resume seed: concept=${persistedResumeContext?.currentConceptTitle || "current lesson topic"}, ` +
          `status=${persistedResumeContext?.currentConceptStatus || "unknown"}, ` +
          `checkpoint=${persistedResumeContext?.lastCompletedCheckpoint?.teachingPointIndex ?? "none"}`,
        );
        addDebugMessage(
          `Persisted contract resume: concept=${current?.title || "current lesson topic"}, ` +
          `next=${contractNext}, total=${current?.teaching?.teachingPoints.length ?? 0}`,
        );
        addDebugMessage("Persisted checkpoint context delivered");
      } else {
        session.seedInitialSource({
          ...preparedSource,
          focus: lessonFocus,
        });
        addDebugMessage("New lesson history completed: turnComplete=true, modelCall=no");
      }
      addDebugMessage("Source seeded into Live context");
      addDebugMessage(`Initial history seeded: session=${run}`);
      const initialTeachingControl = continuingSavedLesson
        ? PERSISTED_LESSON_RESUME_CONTROL
        : `Begin the source-grounded spoken lesson now. Identify the uploaded material as "${tokenBody.source.name}", briefly preview what you will cover, then teach the first concept${
          lessonFocus ? ` related to ${lessonFocus}` : " from the source"
        }.`;
      startupSessionRef.current = run;
      nextGenerationIntentRef.current = currentTeachingIntent();
      pendingTurnOriginRef.current = "app-control";
      startupFirstProviderEventPendingRef.current = true;
      startupFirstAudioPendingRef.current = true;
      const initialTriggerSent = transport.sendRealtimeInput({
        text: initialTeachingControl,
      });
      if (!initialTriggerSent) {
        startupFirstProviderEventPendingRef.current = false;
        startupFirstAudioPendingRef.current = false;
        addDebugMessage(
          `Initial teaching trigger not sent: session=${run}, reason=transport-not-ready`,
        );
        throw new Error("The Live connection was not ready for the lesson start request");
      }
      addDebugMessage(
        `Realtime startup input sent: session=${run}, trigger=${sessionStartMode}, count=1`,
      );
      if (continuingSavedLesson) {
        addDebugMessage(
          `Persisted resume realtime trigger sent: session=${run}`,
        );
      }
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
      conversationStartPendingRef.current = false;
      beginIdleMonitoring();
      void requestWakeLock();
      if (sessionStartMode === "persisted-resume") {
        const current = getCurrentConcept(lessonStateRef.current);
        addDebugMessage("Persisted lesson continuation started");
        addDebugMessage(`Resume briefing requested: concept=${current?.title || "current lesson topic"}`);
        addDebugMessage(
          `Teaching preferences on resume: depth=${sessionInitialTeachingPreferences.explanationDepth}, ` +
          `speakingSpeed=${sessionInitialTeachingPreferences.speakingSpeed}`,
        );
        if (persistedResumeBriefingPendingRef.current) {
          addDebugMessage("Resume briefing control sent");
        }
      }
    } catch (error) {
      if (!isMountedRef.current || run !== conversationRunRef.current) return;
      conversationStartPendingRef.current = false;

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
    const pending = activeTeachingGenerationRef.current;
    cancelActiveTeachingGeneration("end-lesson");
    cancelActiveTeachingGeneration("navigation");
    playerRef.current?.clear();
    const stoppedLessonState = pauseLessonState(lessonStateRef.current);
    const persistedCurrent = getCurrentConcept(stoppedLessonState);
    setMicrophoneStatus("Not active");
    setAiConnectionStatus("Not connected");
    lessonStateRef.current = stoppedLessonState;
    setLessonState(stoppedLessonState);
    addDebugMessage(
      `Persisting resume state: concept=${persistedCurrent
        ? `${persistedCurrent.id}/${persistedCurrent.title}`
        : "none"}, status=${persistedCurrent?.status || "none"}, ` +
      `pending=${pending?.progressRequested ? pending.teachingPointIndex : "none"}, partialOutputPersisted=no`,
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
  const currentConcept = lessonState.currentNodeId
    ? lessonState.nodes[lessonState.currentNodeId]
    : undefined;
  const currentTeachingContract = currentConcept?.teaching;
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

        {!lessonActive && (
          <CloudAccount
            onDebug={addDebugMessage}
            onAuthResolved={(user: User | null) => {
              const nextUserId = user?.id ?? null;
              if (workspaceOwnerIdRef.current !== nextUserId) {
                cloudUploadTimersRef.current.forEach((timer) => clearTimeout(timer));
                cloudUploadTimersRef.current.clear();
                workspaceLoadedRef.current = false;
              }
              setCloudUserId(nextUserId);
              setCloudAuthReady(true);
            }}
            onBeforeSignOut={async () => {
              await persistCurrentLesson();
            }}
            syncState={cloudSyncState}
            cloudLessonCount={cloudLessonCount}
            localOnlyLessonCount={localOnlyLessonCount}
            onSyncNow={() => void syncCurrentAccount()}
            onImportLocalLessons={() => void importLocalLessons()}
          />
        )}

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

        <ProcessingQueue
          jobs={processingQueue.jobs}
          lessonActive={lessonActive}
          onStudy={(lessonId, job) => {
            void processingQueue.discard(job).then(() => selectSavedLesson(lessonId));
          }}
          onRetry={(job) => void processingQueue.retry(job)}
          onReselect={(job, files) => void processingQueue.reselect(job, files).catch((error) => {
            setPersistenceNotice(error instanceof Error ? error.message : "Those sources did not match the queued lesson.");
          })}
          onDiscard={(job) => void processingQueue.discard(job).catch(() => {
            setPersistenceNotice("The queued lesson could not be discarded safely.");
          })}
        />

        <div className="setup-only">
          <LearningSourceUpload
            source={learningSource}
            sources={lessonSources}
            disabled={microphoneActive || requestingPermission || !persistenceHydrated}
            onChange={handleLearningSourceChange}
            onSourcesChange={handleLessonSourcesChange}
            onRetrySourceUpload={retrySourceUpload}
            cloudUserId={cloudUserId}
            onQueueBundle={processingQueue.enqueue}
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

        {lessonActive && <div className="active-learning-grid">
          <SourceVisual
            conceptId={currentConcept?.id ?? null}
            conceptTitle={currentConcept?.title}
            contract={currentTeachingContract}
            sources={lessonSources}
            cloudOwnerId={cloudUserId}
            onDebug={addDebugMessage}
          />
          <div className="active-learning-sidebar">
          {learningSource && <section className="active-summary" aria-label="Active lesson overview">
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
          </section>}

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
          {lessonState.rootNodeIds.length > 0 && <LessonRoadmap
            lessonState={lessonState}
            lessonActive={lessonActive}
            navigationPending={roadmapNavigationPending}
            onNavigate={navigateFromRoadmap}
          />}
          </div>
        </div>}

        {!lessonActive && lessonState.rootNodeIds.length > 0 && (
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
              <dt>Current node ID</dt>
              <dd>{lessonState.currentNodeId || "-"}</dd>
            </div>
            <div>
              <dt>Current concept</dt>
              <dd>{currentConcept?.title || "-"}</dd>
            </div>
            <div>
              <dt>Teaching progress</dt>
              <dd>{currentTeachingContract
                ? `${lessonState.teachingContractProgress[currentConcept?.id ?? ""]?.nextTeachingPointIndex ?? 0} / ${currentTeachingContract.teachingPoints.length} points heard`
                : "-"}</dd>
            </div>
            <div>
              <dt>Current authoritative point</dt>
              <dd>{currentConcept?.id
                ? lessonState.teachingContractProgress[currentConcept.id]?.nextTeachingPointIndex ?? 0
                : "-"}</dd>
            </div>
            <div>
              <dt>Last completed point</dt>
              <dd>{currentConcept?.id
                ? lessonState.teachingContractProgress[currentConcept.id]?.lastCompletedCheckpoint?.teachingPoint ?? "-"
                : "-"}</dd>
            </div>
            <div>
              <dt>Checkpoint transcript</dt>
              <dd>{currentConcept?.id
                ? lessonState.teachingContractProgress[currentConcept.id]?.lastCompletedCheckpoint?.transcriptExcerpt ?? "-"
                : "-"}</dd>
            </div>
            <div>
              <dt>Generation mode</dt>
              <dd>{generationDiagnostic?.mode ?? "-"}</dd>
            </div>
            <div>
              <dt>Active teaching point</dt>
              <dd>{generationDiagnostic?.teachingPointIndex ?? "-"}</dd>
            </div>
            <div>
              <dt>Progress requested</dt>
              <dd>{generationDiagnostic ? (generationDiagnostic.progressRequested ? "yes" : "no") : "-"}</dd>
            </div>
            <div>
              <dt>Generation / playback complete</dt>
              <dd>{generationDiagnostic
                ? `${generationDiagnostic.generationComplete ? "yes" : "no"} / ${generationDiagnostic.playbackComplete ? "yes" : "no"}`
                : "-"}</dd>
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
                <p><strong>Source:</strong> {currentTeachingContract.sourceReferences.map((reference) => {
                  const sourceName = lessonSources.find((source) => source.id === reference.sourceId)?.name ?? reference.sourceId;
                  return `${sourceName}${reference.page ? ` page ${reference.page}` : ""}${reference.section ? ` (${reference.section})` : ""}`;
                }).join(", ")}</p>
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
