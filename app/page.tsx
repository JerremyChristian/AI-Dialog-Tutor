"use client";

import type { FunctionCall, LiveServerMessage } from "@google/genai";
import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { LearningSourceUpload } from "../components/learning-source-upload";
import { AppNavigation, type AppView } from "../components/app-navigation";
import { LessonLibrary, lessonProgress } from "../components/lesson-library";
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
  activateNextSequentialConcept,
  buildLessonInstruction,
  commitDeliveredTeachingBeat,
  createLessonState,
  deriveResumePoint,
  GEMINI_LIVE_MODEL,
  getCurrentConcept,
  getLessonTreeRows,
  isLessonPlanComplete,
  LESSON_WRAP_UP_CONTROL,
  mergeTranscript,
  navigateLessonState,
  pauseLessonState,
  PERSISTED_LESSON_RESUME_CONTROL,
  queryLessonState,
  skipLessonNode,
  type LessonSessionStartMode,
  type LessonState,
} from "../lib/lesson-state";
import {
  computeNextTeachingPointIndexAfterBeat,
  isBeatCommitValid,
  resolveNextPresentationBeat,
  type ResolvedTeachingBeat,
} from "../lib/teaching-delivery";
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
  getSavedLessonContentSignature,
  listSavedLessons,
  loadActiveLesson,
  saveActiveLesson,
  saveSavedLesson,
  setActiveLessonId,
  type RecentTeachingContextEntry,
  type SavedLesson,
} from "../lib/local-persistence";
import {
  createCloudCompatibleLessonId,
  associateCloudLesson,
  deleteCloudLesson,
  isUuid,
  reconcileCloudLessons,
  type CloudSyncState,
} from "../lib/cloud-sync";
import { isSupabaseConfigured } from "../lib/supabase/config";
import { sanitizeLearnerVisibleTutorTranscript } from "../lib/transcript-visibility";
import { mergeLearnerTranscript } from "../lib/learner-transcript";
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
type PendingTeachingPreferences = Partial<TeachingPreferences>;
type LibraryView = "index" | "lesson" | "new";
type AppearancePreference = "system" | "light" | "dark";

type ActiveTeachingBeat = ResolvedTeachingBeat & {
  conceptId: string;
  mode: "lesson" | "review";
  generationEpoch: number;
  generationComplete: boolean;
  audioNaturallyDrained: boolean;
  cancelled: boolean;
};

type PresentationBeat = ResolvedTeachingBeat & { conceptId: string };

type NodeReviewState = {
  nodeId: string;
  nextTeachingPointIndex: number;
  returnPresentationBeat: PresentationBeat | null;
  complete: boolean;
};

type FarewellTurn = {
  conversationRun: number;
  generationEpoch: number;
  generationComplete: boolean;
  audioReceived: boolean;
  audioNaturallyDrained: boolean;
  completionStarted: boolean;
};

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

function isRedundantPreparationNotice(value: string) {
  return /lesson is being prepared/i.test(value) &&
    (/visible in your library/i.test(value) || /follow its progress on home/i.test(value));
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
  const [appView, setAppView] = useState<AppView>("home");
  const [libraryView, setLibraryView] = useState<LibraryView>("index");
  const [microphoneStatus, setMicrophoneStatus] =
    useState<MicrophoneStatus>("Not active");
  const [aiConnectionStatus, setAiConnectionStatus] =
    useState<AiConnectionStatus>("Not connected");
  const [debugMessages, setDebugMessages] = useState<DebugMessage[]>([]);
  const [latestLearnerReply, setLatestLearnerReply] = useState("");
  const [visibleTutorTranscript, setVisibleTutorTranscript] = useState("");
  const [userError, setUserError] = useState("");
  const [engagementState, setEngagementState] = useState<EngagementState>("ended");
  const [transportState, setTransportState] = useState<LiveTransportState>("closed");
  const [microphoneMuted, setMicrophoneMuted] = useState(false);
  const [quickResponseFeedback, setQuickResponseFeedback] = useState("");
  const [mobileTranscriptExpanded, setMobileTranscriptExpanded] = useState(false);
  const [desktopTeachingStyleExpanded, setDesktopTeachingStyleExpanded] = useState(true);
  const [mobileTeachingStyleExpanded, setMobileTeachingStyleExpanded] = useState(false);
  const [typedReply, setTypedReply] = useState("");
  const [appearance, setAppearance] = useState<AppearancePreference>("system");
  const [appearanceReady, setAppearanceReady] = useState(false);
  const [teachingPreferences, setTeachingPreferences] = useState<TeachingPreferences>(
    DEFAULT_TEACHING_PREFERENCES,
  );
  const [pendingTeachingPreferences, setPendingTeachingPreferences] =
    useState<PendingTeachingPreferences>({});
  const [preferenceUpdatePending, setPreferenceUpdatePending] = useState(false);
  const [roadmapNavigationPending, setRoadmapNavigationPending] = useState(false);
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
  const [presentationBeat, setPresentationBeat] = useState<PresentationBeat | null>(null);
  const [restartConfirmationOpen, setRestartConfirmationOpen] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [nodeReview, setNodeReview] = useState<NodeReviewState | null>(null);
  const [showLessonComplete, setShowLessonComplete] = useState(false);
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

  const streamRef = useRef<MediaStream | null>(null);
  const transportRef = useRef<LiveTransportManager | null>(null);
  const microphoneStreamerRef = useRef<MicrophonePcmStreamer | null>(null);
  const playerRef = useRef<PcmAudioPlayer | null>(null);
  const tokenRequestRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const conversationRunRef = useRef(0);
  const assistantSpeakingRef = useRef(false);
  const typedInterruptionHandledRef = useRef(false);
  const assistantTurnActiveRef = useRef(false);
  const learnerActivityRunRef = useRef<number | null>(null);
  const userTranscriptRef = useRef("");
  const voiceDraftRef = useRef("");
  const voiceDraftOpenRef = useRef(false);
  const lastMeaningfulLearnerTranscriptRef = useRef("");
  const assistantTranscriptRef = useRef("");
  const visibleTutorTranscriptRawRef = useRef("");
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
  const lessonStartupPendingRef = useRef(false);
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
  const typedReplyInputRef = useRef<HTMLInputElement | null>(null);
  const preferenceUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roadmapNavigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistenceSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roadmapNavigationPendingRef = useRef(false);
  const teachingPreferencesRef = useRef<TeachingPreferences>(teachingPreferences);
  const meaningfulConfirmationSpeechRef = useRef(false);
  const silentLessonRecoveryPendingRef = useRef(false);
  const activeTeachingBeatRef = useRef<ActiveTeachingBeat | null>(null);
  const presentationBeatRef = useRef<PresentationBeat | null>(null);
  const generationEpochRef = useRef(0);
  const lessonWrapUpRef = useRef(false);
  const conversationalRestartConfirmationRef = useRef(false);
  const restartPendingRef = useRef(false);
  const restartActiveLessonRef = useRef<() => Promise<void>>(async () => undefined);
  const nodeReviewRef = useRef<NodeReviewState | null>(null);
  const reviewResumeGuardRef = useRef(false);
  const reviewRecoveryPendingRef = useRef(false);
  const closingTurnRef = useRef<FarewellTurn | null>(null);
  const completionAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [farewellFinishing, setFarewellFinishing] = useState(false);

  const addDebugMessage = useCallback((text: string) => {
    if (!isMountedRef.current) return;

    setDebugMessages((messages) => [
      ...messages,
      {
        id: nextMessageIdRef.current++,
        timestamp: new Date().toLocaleTimeString(),
        text,
      },
    ]);
  }, []);

  function hasCurrentLearnerActivity() {
    if (learnerActivityRunRef.current !== conversationRunRef.current) return false;
    const continuity = transportRef.current?.getInterruptionContinuity();
    return Boolean(continuity?.learnerUtteranceActive || continuity?.learnerUtteranceOpen);
  }

  function addReviewFlowDiagnostic(event: string, details = "") {
    if (process.env.NODE_ENV !== "development") return;
    const review = nodeReviewRef.current;
    const active = activeTeachingBeatRef.current;
    addDebugMessage(
      `REVIEW_FLOW event=${event} reviewActive=${Boolean(review)} ` +
      `reviewCursor=${review?.nextTeachingPointIndex ?? "none"} ` +
      `activeMode=${active?.mode ?? "none"} generationEpoch=${generationEpochRef.current} ` +
      `conversationRun=current${details ? ` ${details}` : ""}`,
    );
  }

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("ai-tutor-appearance");
      setAppearance(saved === "light" || saved === "dark" ? saved : "system");
    } catch {
      setAppearance("system");
    }
    setAppearanceReady(true);
  }, []);

  useEffect(() => {
    if (!appearanceReady) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyAppearance = () => {
      const resolved = appearance === "system"
        ? media.matches ? "dark" : "light"
        : appearance;
      document.documentElement.dataset.theme = resolved;
    };
    try {
      window.localStorage.setItem("ai-tutor-appearance", appearance);
    } catch {
      // Appearance still applies for this session when browser storage is unavailable.
    }
    applyAppearance();
    if (appearance !== "system") return;
    media.addEventListener("change", applyAppearance);
    return () => media.removeEventListener("change", applyAppearance);
  }, [appearance, appearanceReady]);

  const updateLessonState = (
    update: (current: LessonState) => LessonState,
  ) => {
    const next = update(lessonStateRef.current);
    lessonStateRef.current = next;
    setLessonState(next);
  };

  function invalidateActiveTeachingBeat(reason: string) {
    const active = activeTeachingBeatRef.current;
    if (!active) return;
    active.cancelled = true;
    activeTeachingBeatRef.current = null;
    playerRef.current?.cancelBatch(active.generationEpoch);
    generationEpochRef.current += 1;
    addDebugMessage(`Teaching beat interrupted: epoch=${active.generationEpoch}, commit=no, reason=${reason}`);
  }

  function buildTeachingBeatControl(active: ActiveTeachingBeat, prefix = "") {
    const state = lessonStateRef.current;
    const concept = state.nodes[active.conceptId];
    const contract = concept?.teaching;
    if (!contract) return "";
    const points = active.teachingPointIndexes.map((index) => ({
      index,
      content: contract.teachingPoints[index],
      sourceReferences: contract.teachingPointSourceReferences?.[index] ?? [],
    }));
    const criteria = active.unit.completionCriteriaIndexes.map((index) => ({
      index,
      content: contract.completionCriteria[index],
    }));
    const position = active.isFirstBeatInUnit
      ? active.isFinalBeatInUnit ? "only" : "first"
      : active.isFinalBeatInUnit ? "final" : "middle";
    const otherOutstandingConcept = Object.values(state.nodes).some((candidate) =>
      candidate.id !== active.conceptId && candidate.childrenIds.length === 0 &&
      Boolean(candidate.teaching) && candidate.status !== "taught" &&
      candidate.status !== "skipped",
    );
    const completesPlannedLesson = active.mode === "lesson" && active.teachingPointIndexes.at(-1) ===
      contract.teachingPoints.length - 1 && !otherOutstandingConcept;
    const completesReview = active.mode === "review" && active.teachingPointIndexes.at(-1) ===
      contract.teachingPoints.length - 1;
    return `${prefix}\n[[APP_CONTROL:TEACH_PRESENTATION_BEAT]]
Teach exactly this application-assigned presentation beat as one natural source-grounded spoken explanation. Do not call progress or complete.
CONCEPT: ${concept.title}
DELIVERY_UNIT_OBJECTIVE: ${active.unit.objective}
BEAT_POSITION: ${position}
ASSIGNED_TEACHING_POINTS: ${JSON.stringify(points)}
RELEVANT_COMPLETION_CRITERIA: ${JSON.stringify(criteria)}
${active.isFirstBeatInUnit ? "Establish the unit naturally." : "Continue directly from the preceding explanation without greeting, praise, announcing a new section, or unnecessary recap."}
${active.mode === "review"
  ? completesReview
    ? "This is the final beat of a bounded node review. Briefly check whether the learner has questions or is ready to return to the main lesson. Do not continue into another concept and do not describe this review as new canonical progress."
    : "This review continues after this beat. Do not ask a question, invite learner interaction, or create a check-in merely because a delivery unit ended; finish with natural continuity because the application will immediately assign the next review beat."
  : completesPlannedLesson
  ? `All planned lesson content will be covered after this beat. ${LESSON_WRAP_UP_CONTROL} Ask naturally whether the learner has any final questions. Do not restart or revisit content unless they ask. If they clearly have no more questions, call session_control with action end.`
  : active.isFinalBeatInUnit
    ? "Briefly synthesize if useful, then create a natural learner interaction boundary; vary the check-in and do not use a fixed script."
    : "Do not ask a question or invite learner interaction at the end; finish with natural continuity because the application will immediately assign the next beat."}`.trim();
  }

  function assignNextTeachingBeat(prefix = "", sendInstruction = true): ActiveTeachingBeat | null {
    if (!lessonActiveRef.current || activeTeachingBeatRef.current ||
        closingTurnRef.current || nodeReviewRef.current) return null;
    let state = lessonStateRef.current;
    let concept = getCurrentConcept(state);
    let activatedState: LessonState | null = null;
    if (concept?.status === "taught" && !lessonWrapUpRef.current) {
      const activated = activateNextSequentialConcept(state);
      if (!activated) return null;
      state = activated;
      activatedState = activated;
      concept = getCurrentConcept(activated);
    }
    if (!concept?.teaching) return null;
    const nextIndex = state.teachingContractProgress[concept.id]?.nextTeachingPointIndex ?? 0;
    const resolved = resolveNextPresentationBeat(concept.teaching, nextIndex);
    if (!resolved) return null;
    const generationEpoch = ++generationEpochRef.current;
    const active: ActiveTeachingBeat = {
      ...resolved,
      conceptId: concept.id,
      mode: "lesson",
      generationEpoch,
      generationComplete: false,
      audioNaturallyDrained: false,
      cancelled: false,
    };
    activeTeachingBeatRef.current = active;
    const presentation = { ...resolved, conceptId: concept.id };
    presentationBeatRef.current = presentation;
    setPresentationBeat(presentation);
    playerRef.current?.beginBatch(generationEpoch, (epoch) => {
      const current = activeTeachingBeatRef.current;
      if (!current || current.generationEpoch !== epoch) {
        addDebugMessage(`Teaching beat stale event ignored: epoch=${epoch}`);
        return;
      }
      current.audioNaturallyDrained = true;
      addDebugMessage(`Teaching audio naturally drained: epoch=${epoch}`);
      assistantSpeakingRef.current = false;
      transportRef.current?.setAssistantSpeaking(false);
      maybeCommitTeachingBeat(epoch);
    });
    addDebugMessage(
      `Teaching beat assigned: concept=${concept.id}, unit=${resolved.deliveryUnitIndex}, ` +
      `beat=${resolved.beatIndex}, points=${resolved.teachingPointIndexes[0]}-${resolved.teachingPointIndexes.at(-1)}, epoch=${generationEpoch}`,
    );
    addDebugMessage(
      `Presentation beat changed: concept=${concept.id}, unit=${resolved.deliveryUnitIndex}, beat=${resolved.beatIndex}`,
    );
    const instruction = buildTeachingBeatControl(active, prefix);
    if (sendInstruction && (!instruction || !transportRef.current?.sendRealtimeInput({ text: instruction }))) {
      invalidateActiveTeachingBeat("send-failed");
      return null;
    }
    if (activatedState) {
      lessonStateRef.current = activatedState;
      setLessonState(activatedState);
      addDebugMessage(`Sequential concept activated for teaching: ${concept.title}`);
    }
    return active;
  }

  function assignNextReviewBeat(prefix = "", sendInstruction = true): ActiveTeachingBeat | null {
    const review = nodeReviewRef.current;
    const concept = review ? lessonStateRef.current.nodes[review.nodeId] : undefined;
    if (!lessonActiveRef.current || !review || review.complete || !concept?.teaching ||
        activeTeachingBeatRef.current || closingTurnRef.current) return null;
    const resolved = resolveNextPresentationBeat(concept.teaching, review.nextTeachingPointIndex);
    if (!resolved) return null;
    const generationEpoch = ++generationEpochRef.current;
    const active: ActiveTeachingBeat = {
      ...resolved,
      conceptId: concept.id,
      mode: "review",
      generationEpoch,
      generationComplete: false,
      audioNaturallyDrained: false,
      cancelled: false,
    };
    activeTeachingBeatRef.current = active;
    const presentation = { ...resolved, conceptId: concept.id };
    presentationBeatRef.current = presentation;
    setPresentationBeat(presentation);
    playerRef.current?.beginBatch(generationEpoch, (epoch) => {
      const current = activeTeachingBeatRef.current;
      if (!current || current.generationEpoch !== epoch) return;
      current.audioNaturallyDrained = true;
      addReviewFlowDiagnostic("review-audio-drained");
      assistantSpeakingRef.current = false;
      transportRef.current?.setAssistantSpeaking(false);
      maybeCommitTeachingBeat(epoch);
    });
    addReviewFlowDiagnostic(
      "review-beat-assigned",
      `unitIndex=${resolved.deliveryUnitIndex} beatIndex=${resolved.beatIndex} ` +
      `wholeNodeFinal=${resolved.teachingPointIndexes.at(-1) === concept.teaching.teachingPoints.length - 1} ` +
      `unitFinal=${resolved.isFinalBeatInUnit}`,
    );
    const instruction = buildTeachingBeatControl(active, prefix ||
      "Review this concept from its beginning using the existing lesson contract. This is a bounded review and must not alter canonical lesson coverage.");
    if (sendInstruction && (!instruction || !transportRef.current?.sendRealtimeInput({ text: instruction }))) {
      invalidateActiveTeachingBeat("review-send-failed");
      return null;
    }
    addDebugMessage(`Node review beat assigned: concept=${concept.id}, beat=${resolved.deliveryUnitIndex}/${resolved.beatIndex}, epoch=${generationEpoch}`);
    return active;
  }

  function maybeFinishFarewell() {
    const farewell = closingTurnRef.current;
    if (!farewell || farewell.completionStarted ||
        farewell.conversationRun !== conversationRunRef.current ||
        farewell.generationEpoch !== generationEpochRef.current ||
        !farewell.generationComplete ||
        (farewell.audioReceived && !farewell.audioNaturallyDrained)) return;
    farewell.completionStarted = true;
    assistantSpeakingRef.current = false;
    transportRef.current?.setAssistantSpeaking(false);
    setShowLessonComplete(true);
    addDebugMessage(farewell.audioReceived
      ? "FAREWELL_FLOW audio-drained"
      : "FAREWELL_FLOW zero-audio");
    addDebugMessage("FAREWELL_FLOW completion-animation");
    completionAnimationTimerRef.current = setTimeout(() => {
      completionAnimationTimerRef.current = null;
      addDebugMessage("FAREWELL_FLOW stop");
      void stopConversation("confirmed");
    }, 2_000);
  }

  function finishNodeReviewAndResume(reason: "completed" | "manual") {
    const review = nodeReviewRef.current;
    if (!review || reviewResumeGuardRef.current) return false;
    reviewResumeGuardRef.current = true;
    const active = activeTeachingBeatRef.current;
    if (active?.mode === "review") {
      invalidateActiveTeachingBeat(`node-review-${reason}`);
      playerRef.current?.clear();
    }
    nodeReviewRef.current = null;
    setNodeReview(null);
    presentationBeatRef.current = review.returnPresentationBeat;
    setPresentationBeat(review.returnPresentationBeat);
    addDebugMessage(`Node review exited: reason=${reason}`);
    if (lessonWrapUpRef.current || isLessonPlanComplete(lessonStateRef.current)) return true;
    assignNextTeachingBeat();
    return true;
  }

  function beginClosingFarewell() {
    if (closingTurnRef.current || restartPendingRef.current) return false;
    invalidateActiveTeachingBeat("lesson-closing");
    const generationEpoch = ++generationEpochRef.current;
    closingTurnRef.current = {
      conversationRun: conversationRunRef.current,
      generationEpoch,
      generationComplete: false,
      audioReceived: false,
      audioNaturallyDrained: false,
      completionStarted: false,
    };
    setFarewellFinishing(true);
    playerRef.current?.beginBatch(generationEpoch, (epoch) => {
      const farewell = closingTurnRef.current;
      if (!farewell || farewell.conversationRun !== conversationRunRef.current ||
          farewell.generationEpoch !== epoch || epoch !== generationEpochRef.current) return;
      farewell.audioNaturallyDrained = true;
      maybeFinishFarewell();
    });
    addDebugMessage("FAREWELL_FLOW started");
    return true;
  }

  function maybeCommitTeachingBeat(epoch: number) {
    const active = activeTeachingBeatRef.current;
    if (!active || active.generationEpoch !== epoch) {
      addDebugMessage(`Teaching beat stale event ignored: epoch=${epoch}`);
      return;
    }
    const state = lessonStateRef.current;
    if (active.mode === "review") {
      const review = nodeReviewRef.current;
      if (!review || review.nodeId !== active.conceptId || active.cancelled ||
          !active.generationComplete || !active.audioNaturallyDrained ||
          active.generationEpoch !== generationEpochRef.current ||
          active.teachingPointIndexes[0] !== review.nextTeachingPointIndex) return;
      const concept = state.nodes[review.nodeId];
      if (!concept?.teaching) return;
      const nextIndex = computeNextTeachingPointIndexAfterBeat(active.teachingPointIndexes);
      const complete = nextIndex >= concept.teaching.teachingPoints.length;
      const nextReview = { ...review, nextTeachingPointIndex: nextIndex, complete };
      nodeReviewRef.current = nextReview;
      setNodeReview(nextReview);
      activeTeachingBeatRef.current = null;
      playerRef.current?.cancelBatch(epoch);
      addDebugMessage(`Node review beat committed: concept=${review.nodeId}, next=${nextIndex}, complete=${complete}`);
      addReviewFlowDiagnostic(
        "review-beat-committed",
        `nextReviewCursor=${nextIndex} nodeComplete=${complete} ` +
        `nextAction=${complete ? "review-final-wait" : "review-next"}`,
      );
      if (!complete) assignNextReviewBeat();
      return;
    }
    const currentNext = state.teachingContractProgress[active.conceptId]?.nextTeachingPointIndex ?? 0;
    if (!isBeatCommitValid({
      expectedConceptId: active.conceptId,
      currentConceptId: state.currentNodeId,
      expectedEpoch: active.generationEpoch,
      currentEpoch: activeTeachingBeatRef.current?.generationEpoch ?? null,
      expectedStartIndex: active.teachingPointIndexes[0],
      currentNextTeachingPointIndex: currentNext,
      generationComplete: active.generationComplete,
      audioNaturallyDrained: active.audioNaturallyDrained,
      cancelled: active.cancelled,
      lessonActive: lessonActiveRef.current,
    })) return;
    const transition = commitDeliveredTeachingBeat(state, active.conceptId, active.teachingPointIndexes);
    if (!transition.result.ok) {
      invalidateActiveTeachingBeat("commit-rejected");
      return;
    }
    const nextIndex = computeNextTeachingPointIndexAfterBeat(active.teachingPointIndexes);
    lessonStateRef.current = transition.state;
    setLessonState(transition.state);
    activeTeachingBeatRef.current = null;
    playerRef.current?.cancelBatch(epoch);
    addDebugMessage(
      `Teaching beat committed: concept=${active.conceptId}, points=${active.teachingPointIndexes[0]}-${active.teachingPointIndexes.at(-1)}, nextTeachingPointIndex=${nextIndex}`,
    );
    if (transition.state.status === "completed") {
      lessonWrapUpRef.current = true;
      addDebugMessage(`Lesson wrap-up entered: finalConcept=${active.conceptId}`);
    }
    if (!active.isFinalBeatInUnit) {
      addDebugMessage(
        `Teaching beat auto-chain: from=${active.deliveryUnitIndex}/${active.beatIndex} ` +
        `to=${active.deliveryUnitIndex}/${active.beatIndex + 1}`,
      );
      assignNextTeachingBeat();
    } else {
      addDebugMessage(`Teaching unit waiting for learner: unit=${active.deliveryUnitIndex}`);
    }
  }

  const disposeResources = async (sendAudioStreamEnd: boolean) => {
    invalidateActiveTeachingBeat("resources-disposed");
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
    learnerActivityRunRef.current = null;
    typedInterruptionHandledRef.current = false;
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
    closingTurnRef.current = null;
    setFarewellFinishing(false);
    nodeReviewRef.current = null;
    reviewRecoveryPendingRef.current = false;
    setNodeReview(null);
    setShowLessonComplete(false);
    if (completionAnimationTimerRef.current) clearTimeout(completionAnimationTimerRef.current);
    completionAnimationTimerRef.current = null;
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
    setTypedReply("");
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

  useEffect(() => {
    setPendingTeachingPreferences((pending) => {
      const depthCaughtUp = pending.explanationDepth !== undefined &&
        pending.explanationDepth === teachingPreferences.explanationDepth;
      const speedCaughtUp = pending.speakingSpeed !== undefined &&
        pending.speakingSpeed === teachingPreferences.speakingSpeed;
      if (!depthCaughtUp && !speedCaughtUp) return pending;
      const next = { ...pending };
      if (depthCaughtUp) delete next.explanationDepth;
      if (speedCaughtUp) delete next.speakingSpeed;
      return next;
    });
  }, [
    pendingTeachingPreferences.explanationDepth,
    pendingTeachingPreferences.speakingSpeed,
    teachingPreferences.explanationDepth,
    teachingPreferences.speakingSpeed,
  ]);

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
          setCloudSyncState(summary.deferred > 0 ? "pending" : "synced");
        })
        .catch(() => {
          setCloudSyncState("pending");
          addDebugMessage("Cloud sync failed: category=lesson-upload");
        });
    }, 1_200);
    cloudUploadTimersRef.current.set(snapshot.id, timer);
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
      recentTeachingContext: recentTeachingContextRef.current,
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

  const resetCurrentLessonProgress = async () => {
    const prepared = preparedSourceRef.current;
    if (!prepared) return false;
    const freshState = createLessonState(lessonStateRef.current.topic, prepared.lessonTree);
    invalidateActiveTeachingBeat("lesson-restarted");
    generationEpochRef.current += 1;
    presentationBeatRef.current = null;
    setPresentationBeat(null);
    lessonWrapUpRef.current = false;
    closingTurnRef.current = null;
    nodeReviewRef.current = null;
    setNodeReview(null);
    setShowLessonComplete(false);
    conversationalRestartConfirmationRef.current = false;
    resumptionPendingRef.current = false;
    persistedResumeBriefingPendingRef.current = false;
    persistedResumeFirstResponseLoggedRef.current = false;
    silentLessonRecoveryPendingRef.current = false;
    roadmapNavigationPendingRef.current = false;
    toolResultsRef.current.clear();
    cancelledToolCallIdsRef.current.clear();
    recentTeachingContextRef.current = [];
    userTranscriptRef.current = "";
    voiceDraftRef.current = "";
    voiceDraftOpenRef.current = false;
    lastMeaningfulLearnerTranscriptRef.current = "";
    assistantTranscriptRef.current = "";
    visibleTutorTranscriptRawRef.current = "";
    assistantCheckpointConceptIdRef.current = null;
    lastAssistantTurnCompleteRef.current = true;
    lessonStateRef.current = freshState;
    setLessonState(freshState);
    setLatestLearnerReply("");
    setVisibleTutorTranscript("");
    setTypedReply("");
    setRoadmapNavigationPending(false);
    setPendingTeachingPreferences({});
    setPreferenceUpdatePending(false);
    setUserError("");
    resumeExistingLessonRef.current = false;
    setResumeExistingLesson(false);
    await persistCurrentLesson(freshState);
    addDebugMessage(`Completed lesson progress reset: lesson=${savedLessonIdRef.current || "unknown"}`);
    return true;
  };

  const hydrateSavedLesson = (saved: SavedLesson, requestedGeneration?: number) => {
    if (lessonActiveRef.current || lessonStartupPendingRef.current ||
        (requestedGeneration !== undefined && requestedGeneration !== lessonHydrationGenerationRef.current)) {
      addDebugMessage(`Stale workspace hydration skipped: reason=${lessonActiveRef.current ? "lesson-active" : lessonStartupPendingRef.current ? "startup-pending" : "request-stale"}`);
      return false;
    }
    preparedSourceRef.current = saved.source.prepared;
    lessonStateRef.current = saved.lessonState;
    lessonWrapUpRef.current = false;
    conversationalRestartConfirmationRef.current = false;
    setRestartConfirmationOpen(false);
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
    presentationBeatRef.current = null;
    setPresentationBeat(null);
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
    lessonWrapUpRef.current = false;
    conversationalRestartConfirmationRef.current = false;
    setRestartConfirmationOpen(false);
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
    presentationBeatRef.current = null;
    setPresentationBeat(null);
    setUserError("");
  };

  const startNewLessonFlow = () => {
    if (lessonActiveRef.current) return;
    setPersistenceNotice("");
    if (persistenceSaveTimerRef.current) clearTimeout(persistenceSaveTimerRef.current);
    persistenceSaveTimerRef.current = null;
    const outgoingSnapshot = createCurrentLessonSnapshot();
    if (outgoingSnapshot) void persistLessonSnapshot(outgoingSnapshot);
    resetIdleLessonWorkspace();
    setAppView("library");
    setLibraryView("new");
    addDebugMessage("New lesson setup opened");
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
        setLibraryView("index");
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

  const changeActiveTeachingPreference = (update: TeachingPreferenceUpdate) => {
    const current = teachingPreferencesRef.current;
    const displayed = { ...current, ...pendingTeachingPreferences };
    if ((update.explanationDepth === undefined ||
         update.explanationDepth === displayed.explanationDepth) &&
        (update.speakingSpeed === undefined ||
         update.speakingSpeed === displayed.speakingSpeed)) return;
    setPendingTeachingPreferences((pending) => ({ ...pending, ...update }));
    const requested = update.explanationDepth
      ? `depth=${update.explanationDepth}`
      : `speakingSpeed=${update.speakingSpeed}`;
    const text = update.explanationDepth
      ? `Please use ${update.explanationDepth} explanations from now on.`
      : `Please use a ${update.speakingSpeed} speaking speed from now on.`;
    if (!transportRef.current?.sendLearnerText(text)) {
      setPendingTeachingPreferences((pending) => {
        const next = { ...pending };
        if (update.explanationDepth !== undefined &&
            pending.explanationDepth === update.explanationDepth) {
          delete next.explanationDepth;
        }
        if (update.speakingSpeed !== undefined &&
            pending.speakingSpeed === update.speakingSpeed) {
          delete next.speakingSpeed;
        }
        return next;
      });
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
    if (nodeReviewRef.current) exitNodeReview();
    if (node.id === lessonStateRef.current.currentNodeId || node.childrenIds.length) return;
    invalidateActiveTeachingBeat("roadmap-navigation");
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
    if (closingTurnRef.current) return;
    reviewResumeGuardRef.current = false;
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
    voiceDraftRef.current = "";
    voiceDraftOpenRef.current = false;
    setLatestLearnerReply(response);
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

  const refreshScopedLibrary = async (ownerId: string | null, reason = "workspace") => {
    const library = await listSavedLessons();
    const scoped = library.filter((lesson) => (lesson.cloudOwnerId ?? null) === ownerId);
    setSavedLessons(scoped);
    setLocalOnlyLessonCount(ownerId
      ? library.filter((lesson) => !lesson.cloudOwnerId).length
      : 0);
    addDebugMessage(`Library refreshed: reason=${reason}, activeLessonHydrated=no`);
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

  const processingQueue = useLessonProcessingQueue({
    ownerId: cloudUserId,
    onDebug: addDebugMessage,
    onLessonReady: async () => {
      await refreshScopedLibrary(workspaceOwnerIdRef.current, "processing-ready");
      setPersistenceNotice("Your processed lesson is ready in the library.");
    },
  });

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
          addDebugMessage(`Stale workspace hydration skipped: reason=${lessonActiveRef.current ? "lesson-active" : lessonStartupPendingRef.current ? "startup-pending" : "request-stale"}`);
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
            addDebugMessage(`Stale workspace hydration skipped: reason=${lessonActiveRef.current ? "lesson-active" : lessonStartupPendingRef.current ? "startup-pending" : "request-stale"}`);
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

  const handleLearnerInterruption = (discreteTextTurn = false) => {
    const farewell = closingTurnRef.current;
    if (farewell && farewell.conversationRun === conversationRunRef.current &&
        farewell.generationEpoch === generationEpochRef.current) return;
    // Gemini cuts playback immediately. Smoothing a mid-phoneme cutoff is a
    // later UX refinement; yielding to the learner remains the priority.
    invalidateActiveTeachingBeat("barge-in");
    playerRef.current?.clear();
    assistantSpeakingRef.current = false;
    typedInterruptionHandledRef.current = false;
    const interruption = transportRef.current?.registerInterruption(
      discreteTextTurn || roadmapNavigationPendingRef.current,
    );
    transportRef.current?.setAssistantSpeaking(false);
    assistantTurnActiveRef.current = false;
    lastAssistantTurnCompleteRef.current = false;
    if (!interruption?.duplicate) {
      if (nodeReviewRef.current) {
        addDebugMessage(`Node review interrupted without canonical progress change: concept=${nodeReviewRef.current.nodeId}`);
        return;
      }
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
  };

  const submitTypedReply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (closingTurnRef.current) return;
    reviewResumeGuardRef.current = false;
    const text = typedReply.trim();
    if (!text) return;
    if (!transportRef.current?.sendLearnerText(text)) {
      setUserError("Your reply could not be sent while reconnecting. Try again.");
      addDebugMessage("Typed learner reply send failed: connection unavailable");
      return;
    }
    if (assistantSpeakingRef.current) {
      handleLearnerInterruption(true);
      typedInterruptionHandledRef.current = true;
    }
    userTranscriptRef.current = text;
    voiceDraftRef.current = "";
    voiceDraftOpenRef.current = false;
    lastMeaningfulLearnerTranscriptRef.current = text;
    setLatestLearnerReply(text);
    updateLessonState((current) => ({
      ...current,
      status: current.status === "interrupted" ? "resolving-interruption" : current.status,
      lastUserTranscript: text,
    }));
    markMeaningfulActivity();
    setUserError("");
    setTypedReply("");
    addDebugMessage("Typed learner reply sent");
    window.requestAnimationFrame(() => typedReplyInputRef.current?.focus());
  };

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
      learnerActivityRunRef.current = conversationRunRef.current;
      reviewResumeGuardRef.current = false;
      transportRef.current?.setLearnerSpeaking(true);
      userTranscriptRef.current = "";
      voiceDraftRef.current = "";
      voiceDraftOpenRef.current = true;
      lastMeaningfulLearnerTranscriptRef.current = "";
      setLatestLearnerReply("");
      lastCandidateLearnerActivityAtRef.current = Date.now();
      addDebugMessage("User speech started");
    } else if (voiceActivity === "ACTIVITY_END") {
      transportRef.current?.setLearnerSpeaking(false);
    }
    if (serverContent?.inputTranscription?.text) {
      const transcriptFragment = serverContent.inputTranscription.text;
      if (!voiceDraftOpenRef.current) {
        voiceDraftRef.current = "";
        voiceDraftOpenRef.current = true;
      }
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
      voiceDraftRef.current = mergeLearnerTranscript(
        voiceDraftRef.current,
        transcriptFragment,
      );
      setLatestLearnerReply(voiceDraftRef.current);
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
    } else if (serverContent?.interimInputTranscription?.text) {
      if (!voiceDraftOpenRef.current) {
        voiceDraftRef.current = "";
        voiceDraftOpenRef.current = true;
      }
      voiceDraftRef.current = mergeLearnerTranscript(
        voiceDraftRef.current,
        serverContent.interimInputTranscription.text,
      );
      setLatestLearnerReply(voiceDraftRef.current);
    }
    if (serverContent?.inputTranscription?.finished ||
        voiceActivity === "ACTIVITY_END" || serverContent?.turnComplete) {
      voiceDraftRef.current = "";
      voiceDraftOpenRef.current = false;
    }

    if (serverContent?.outputTranscription?.text) {
      lastAssistantTurnCompleteRef.current = false;
      if (!assistantTurnActiveRef.current) {
        assistantTurnActiveRef.current = true;
        assistantTranscriptRef.current = "";
        visibleTutorTranscriptRawRef.current = "";
        setVisibleTutorTranscript("");
        assistantCheckpointConceptIdRef.current = nodeReviewRef.current || closingTurnRef.current
          ? null
          : lessonStateRef.current.currentNodeId;
      }
      if (persistedResumeBriefingPendingRef.current &&
          !persistedResumeFirstResponseLoggedRef.current) {
        persistedResumeFirstResponseLoggedRef.current = true;
        addDebugMessage("First persisted-resume response received");
      }
      if (engagementStateRef.current === "confirming" && !assistantSpeakingRef.current) {
        addDebugMessage("Idle confirmation spoken");
      }
      visibleTutorTranscriptRawRef.current = mergeTranscript(
        visibleTutorTranscriptRawRef.current,
        serverContent.outputTranscription.text,
      );
      assistantTranscriptRef.current = sanitizeLearnerVisibleTutorTranscript(
        visibleTutorTranscriptRawRef.current,
      );
      setVisibleTutorTranscript(assistantTranscriptRef.current);
      updateLessonState((current) => ({
        ...current,
        lastAssistantTranscript: assistantTranscriptRef.current,
      }));
    }

    if (serverContent?.interrupted) {
      if (typedInterruptionHandledRef.current) {
        typedInterruptionHandledRef.current = false;
        addDebugMessage("Provider confirmed typed interruption");
      } else if (hasCurrentLearnerActivity()) {
        addReviewFlowDiagnostic("provider-interrupted-accepted", "reason=current-learner-activity");
        handleLearnerInterruption();
      } else {
        addReviewFlowDiagnostic("provider-interrupted-ignored", "reason=no-learner-activity");
      }
    }

    if (voiceActivity === "ACTIVITY_START") {
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

      const farewell = closingTurnRef.current;
      if (farewell && farewell.conversationRun === conversationRunRef.current &&
          farewell.generationEpoch === generationEpochRef.current) {
        farewell.audioReceived = true;
      }

      if (!assistantSpeakingRef.current) {
        typedInterruptionHandledRef.current = false;
        assistantSpeakingRef.current = true;
        transportRef.current?.setAssistantSpeaking(true);
        sourceGroundingPendingRef.current = false;
        if (!assistantTurnActiveRef.current) {
          assistantTurnActiveRef.current = true;
          assistantTranscriptRef.current = "";
          visibleTutorTranscriptRawRef.current = "";
          setVisibleTutorTranscript("");
          assistantCheckpointConceptIdRef.current = nodeReviewRef.current || closingTurnRef.current
            ? null
            : lessonStateRef.current.currentNodeId;
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
      const active = activeTeachingBeatRef.current;
      const closing = closingTurnRef.current;
      addReviewFlowDiagnostic("provider-generation-complete");
      if (active) {
        active.generationComplete = true;
        if (active.mode === "review") addReviewFlowDiagnostic("review-generation-complete");
        addDebugMessage(`Teaching generation complete: epoch=${active.generationEpoch}`);
        playerRef.current?.completeBatch(active.generationEpoch);
      }
      if (closing) {
        if (closing.conversationRun !== conversationRunRef.current ||
            closing.generationEpoch !== generationEpochRef.current) return;
        closing.generationComplete = true;
        addDebugMessage("FAREWELL_FLOW generation-complete");
        playerRef.current?.completeBatch(closing.generationEpoch);
        maybeFinishFarewell();
      }
      if (!active && !closing) assistantSpeakingRef.current = false;
      assistantTurnActiveRef.current = false;
      lastAssistantTurnCompleteRef.current = true;
      if (!active && !closing) transportRef.current?.setAssistantSpeaking(false);
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
          status: lessonWrapUpRef.current
            ? "completed"
            : state.status === "idle" ? "idle" : "teaching",
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
    let restartAfterResponse = false;

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
      const queryPurpose = args.purpose;
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
      let assignmentControl = "";

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
        if (action === "restart_request") {
          if (!resumeExistingLessonRef.current) {
            result = { ok: false, action, message: "The lesson has not started and does not need restarting" };
          } else {
            conversationalRestartConfirmationRef.current = true;
            addDebugMessage("Conversational lesson restart confirmation requested");
            result = {
              ok: true,
              action,
              message: "Ask the learner to confirm that teaching progress will be cleared while lesson materials and content are preserved",
            };
          }
        } else if (action === "restart_confirm") {
          if (!conversationalRestartConfirmationRef.current) {
            result = { ok: false, action, message: "No lesson restart confirmation is pending" };
          } else {
            conversationalRestartConfirmationRef.current = false;
            restartAfterResponse = true;
            result = { ok: true, action, message: "Restart the completed lesson from the beginning" };
          }
        } else if (action === "restart_cancel") {
          conversationalRestartConfirmationRef.current = false;
          result = { ok: true, action, message: "Keep the completed lesson unchanged" };
        } else if (lessonWrapUpRef.current && action === "end") {
          if (beginClosingFarewell()) {
            addDebugMessage("Final questions completed; graceful closing started");
            result = {
              ok: true,
              action: "end",
              message: "The learner has no more questions. Give exactly one brief, warm, natural closing sentence. Do not teach new material and do not ask another question.",
            };
          } else {
            result = { ok: true, action: "end", message: "Lesson closing is already in progress" };
          }
        } else if (lessonWrapUpRef.current) {
          result = {
            ok: true,
            action: action === "continue" ? "continue" : "unclear",
            message: "Remain in final-question wrap-up",
          };
        } else if (engagementStateRef.current !== "confirming" && action === "continue") {
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
        if (queryPurpose === "continue" && !postResumeQueryReceived &&
            !silentLessonRecoveryPendingRef.current) {
          const review = nodeReviewRef.current;
          let assignment: ActiveTeachingBeat | null = null;
          if (review?.complete) {
            finishNodeReviewAndResume("completed");
          } else if (review) {
            assignment = assignNextReviewBeat("", false);
          } else if (!reviewResumeGuardRef.current && !isLessonPlanComplete(lessonStateRef.current)) {
            assignment = assignNextTeachingBeat("", false);
          }
          if (assignment) assignmentControl = buildTeachingBeatControl(assignment);
        }
        if (postResumeQueryReceived) {
          addDebugMessage("Post-resume continuity snapshot prepared");
          addDebugMessage("Teaching preferences included in post-resume state");
        }
        addDebugMessage("Lesson state queried");
      } else if (
        (action === "navigate" || action === "skip") &&
        nodeReviewRef.current
      ) {
        addReviewFlowDiagnostic("navigation-rejected-during-review");
        result = {
          ok: false,
          action,
          error: "review_active",
          message: "Review is active. Continue the current Review or wait for the learner to explicitly exit Review.",
        };
      } else if (
        (action === "navigate" || action === "skip") &&
        typeof conceptId === "string" && conceptId
      ) {
        invalidateActiveTeachingBeat(`lesson-${action}`);
        playerRef.current?.clear();
        const transition = action === "navigate"
          ? navigateLessonState(lessonStateRef.current, conceptId)
          : skipLessonNode(lessonStateRef.current, conceptId);
        result = transition.result;
        events = transition.events;
        if (transition.state !== lessonStateRef.current) {
          if (action === "navigate" && transition.result.ok) lessonWrapUpRef.current = false;
          lessonStateRef.current = transition.state;
          setLessonState(transition.state);
        }
        if (transition.result.ok && action === "navigate") {
          const active = getCurrentConcept(transition.state);
          if (active?.teaching) {
            addDebugMessage(
              `Teaching contract progress: concept=${active.title}, ` +
              `next=${transition.state.teachingContractProgress[active.id]
                ?.nextTeachingPointIndex ?? 0}, total=${active.teaching.teachingPoints.length}`,
            );
          }
        }
        if (transition.result.ok) {
          const assignment = assignNextTeachingBeat("", false);
          if (assignment) assignmentControl = buildTeachingBeatControl(assignment);
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
        const missingConcept = action === "navigate" || action === "skip";
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
          ...(assignmentControl ? { teachingAssignment: assignmentControl } : {}),
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
    if (restartAfterResponse) {
      window.setTimeout(() => void restartActiveLessonRef.current(), 250);
    }
  };

  const exitNodeReview = () => {
    const review = nodeReviewRef.current;
    if (!review) return;
    invalidateActiveTeachingBeat("node-review-exited");
    playerRef.current?.clear();
    nodeReviewRef.current = null;
    reviewResumeGuardRef.current = false;
    setNodeReview(null);
    presentationBeatRef.current = review.returnPresentationBeat;
    setPresentationBeat(review.returnPresentationBeat);
    addDebugMessage(`Node review exited: concept=${review.nodeId}`);
  };

  const startNodeReview = (node: LessonState["nodes"][string]) => {
    if (!lessonActiveRef.current || !node.teaching || node.childrenIds.length ||
        restartPendingRef.current || closingTurnRef.current) return;
    invalidateActiveTeachingBeat("node-review-started");
    playerRef.current?.clear();
    const review: NodeReviewState = {
      nodeId: node.id,
      nextTeachingPointIndex: 0,
      returnPresentationBeat: presentationBeatRef.current,
      complete: false,
    };
    nodeReviewRef.current = review;
    reviewResumeGuardRef.current = false;
    setNodeReview(review);
    addDebugMessage(`Node review started: concept=${node.id}`);
    addReviewFlowDiagnostic("review-start");
    assignNextReviewBeat();
  };

  const startConversation = async () => {
    setUserError("");
    setPersistenceNotice("");
    if (
      learningSource?.status !== "ready" ||
      !preparedSourceRef.current
    ) {
      addDebugMessage("Source grounding failed: a ready learning source is required");
      return;
    }

    lessonStartupPendingRef.current = true;
    workspaceLoadGenerationRef.current += 1;
    lessonHydrationGenerationRef.current += 1;

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
    lessonWrapUpRef.current = isLessonPlanComplete(initialLessonState);
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
    voiceDraftRef.current = "";
    voiceDraftOpenRef.current = false;
    lastMeaningfulLearnerTranscriptRef.current = "";
    assistantTranscriptRef.current = "";
    visibleTutorTranscriptRawRef.current = "";
    lastAssistantTurnCompleteRef.current = true;
    setLatestLearnerReply("");
    setVisibleTutorTranscript("");
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
          if (state === "recovering") {
            const review = nodeReviewRef.current;
            const canonical = getCurrentConcept(lessonStateRef.current);
            addReviewFlowDiagnostic(
              "recovery-start",
              `reviewedNodePresent=${Boolean(review && lessonStateRef.current.nodes[review.nodeId])} ` +
              `canonicalNode=${canonical ? "present" : "none"} ` +
              `canonicalCursor=${canonical
                ? lessonStateRef.current.teachingContractProgress[canonical.id]?.nextTeachingPointIndex ?? 0
                : "none"} recoveryIncludesReview=false`,
            );
            reviewRecoveryPendingRef.current = true;
            invalidateActiveTeachingBeat("transport-recovery");
            playerRef.current?.clear();
          } else if (state === "active" && reviewRecoveryPendingRef.current) {
            reviewRecoveryPendingRef.current = false;
            addReviewFlowDiagnostic("recovery-complete", "recoveryIncludesReview=false");
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
        if (!microphoneMutedRef.current && !closingTurnRef.current) transport.sendAudio(chunk);
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
      lessonStartupPendingRef.current = false;
      beginIdleMonitoring();
      void requestWakeLock();
      if (lessonWrapUpRef.current) {
        addDebugMessage("Completed lesson restored in wrap-up");
        transportRef.current?.sendRealtimeInput({ text: LESSON_WRAP_UP_CONTROL });
      } else if (sessionStartMode === "persisted-resume") {
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
        persistedResumeBriefingPendingRef.current = Boolean(assignNextTeachingBeat(
          PERSISTED_LESSON_RESUME_CONTROL,
        ));
        if (persistedResumeBriefingPendingRef.current) {
          addDebugMessage("Resume briefing control sent");
        }
      } else {
        assignNextTeachingBeat(
          `Begin the source-grounded spoken lesson now. Identify the uploaded material as "${tokenBody.source.name}", briefly preview what you will cover, then teach the assigned first presentation beat${
            lessonFocus ? ` related to ${lessonFocus}` : " from the source"
          }.`,
        );
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
    } finally {
      lessonStartupPendingRef.current = false;
    }
  };

  const stopConversation = async (reason?: "inactivity" | "confirmed") => {
    conversationRunRef.current += 1;
    invalidateActiveTeachingBeat("lesson-ended");
    playerRef.current?.clear();
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

  const restartLesson = async () => {
    if (restartPendingRef.current || !resumeExistingLessonRef.current) return;
    restartPendingRef.current = true;
    setRestartPending(true);
    setRestartConfirmationOpen(false);
    try {
      if (lessonActiveRef.current) await stopConversation();
      if (await resetCurrentLessonProgress()) await startConversation();
    } finally {
      restartPendingRef.current = false;
      setRestartPending(false);
    }
  };
  restartActiveLessonRef.current = restartLesson;

  const microphoneActive = microphoneStatus === "Active";
  const aiConnected = aiConnectionStatus === "Connected";
  const requestingPermission = microphoneStatus === "Requesting permission";
  const currentTeachingContract = getCurrentConcept(lessonState)?.teaching;
  const currentConcept = getCurrentConcept(lessonState);
  const currentTeachingPointIndex = currentConcept
    ? lessonState.teachingContractProgress[currentConcept.id]?.nextTeachingPointIndex ?? 0
    : 0;
  const presentedConcept = presentationBeat
    ? lessonState.nodes[presentationBeat.conceptId]
    : currentConcept;
  const presentedTeachingPointIndexes = useMemo(
    () => presentationBeat?.teachingPointIndexes ?? [currentTeachingPointIndex],
    [presentationBeat, currentTeachingPointIndex],
  );
  const presentationKey = presentationBeat
    ? `${presentationBeat.conceptId}:${presentationBeat.deliveryUnitIndex}:${presentationBeat.beatIndex}`
    : `${currentConcept?.id ?? "none"}:pending`;
  const lessonActive = microphoneActive || requestingPermission || aiConnected;
  const resumableLesson = savedLessons.find((lesson) => lesson.hasStarted);
  const hasRecentLessons = savedLessons.some((lesson) => lesson.id !== resumableLesson?.id);
  const selectedSavedLesson = savedLessonId
    ? savedLessons.find((lesson) => lesson.id === savedLessonId)
    : undefined;
  const selectedLessonRestartable = Boolean(selectedSavedLesson?.hasStarted);

  const acknowledgeReadyLessonNotifications = (lessonId: string) => {
    const matchingJobs = processingQueue.jobs.filter(
      (job) => job.lessonId === lessonId && job.status === "ready",
    );
    if (matchingJobs.length === 0) return;
    void Promise.allSettled(
      matchingJobs.map((job) => processingQueue.discard(job)),
    ).then((results) => {
      const failures = results.filter((result) => result.status === "rejected").length;
      if (failures > 0) {
        addDebugMessage(
          `Ready notification acknowledgement failed: lesson=${lessonId}, failures=${failures}`,
        );
      }
    });
  };

  const openLesson = async (id: string) => {
    acknowledgeReadyLessonNotifications(id);
    await selectSavedLesson(id);
    setAppView("library");
    setLibraryView("lesson");
  };

  const navigateProduct = (view: AppView) => {
    setAppView(view);
    if (view === "library") setLibraryView("index");
  };

  const requestInstall = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  return (
    <main className={`page-shell${lessonActive ? " teaching-shell" : ""}`}>
      {!lessonActive && <AppNavigation activeView={appView} onNavigate={navigateProduct} />}
      <section className={`tutor-card${lessonActive ? " lesson-active" : ""}`}>
        {lessonActive ? <header className="teaching-header"><div><p className="eyebrow">Teaching room</p><h1 id="page-title">{learningSource?.name || "Your lesson"}</h1></div><div className="teaching-header-actions"><button className="button-secondary" type="button" disabled={restartPending || Boolean(closingTurnRef.current)} onClick={() => setRestartConfirmationOpen(true)}>Restart Lesson</button><button className="button-danger end-lesson-top" type="button" aria-label="End lesson" onClick={() => void stopConversation()}><span className="end-lesson-desktop">End Lesson</span><span className="end-lesson-mobile" aria-hidden="true">End</span></button></div></header> : null}

        {lessonActive && restartConfirmationOpen && <section className="restart-lesson-confirmation" role="alertdialog" aria-labelledby="active-restart-lesson-title" aria-describedby="active-restart-lesson-description"><h2 id="active-restart-lesson-title">Restart this lesson?</h2><p id="active-restart-lesson-description">This will clear all teaching progress for this lesson and start it again from the beginning. Your materials and lesson content will not be deleted.</p><div><button className="button-secondary" type="button" disabled={restartPending} onClick={() => setRestartConfirmationOpen(false)}>Cancel</button><button className="button-danger" type="button" disabled={restartPending} onClick={() => void restartLesson()}>{restartPending ? "Restarting…" : "Restart"}</button></div></section>}
        {lessonActive && showLessonComplete && <div className="lesson-complete-transition" role="status"><span aria-hidden="true">✓</span><strong>Lesson complete</strong></div>}

        {!lessonActive && !persistenceHydrated && <div className="loading-state" role="status"><span className="loading-spinner" aria-hidden="true" /> Restoring your learning workspace…</div>}

        {!lessonActive && persistenceHydrated && appView === "home" && <section className="product-view home-view" aria-labelledby="page-title">
          <div className="home-heading"><p className="eyebrow">Home</p><h1 id="page-title">Continue learning</h1><p>Pick up where you left off or revisit a recent lesson.</p></div>
          {resumableLesson ? <section className="continue-card" aria-labelledby="continue-title"><div><p className="eyebrow">Up next</p><h2 id="continue-title">{resumableLesson.title}</h2><p>{lessonProgress(resumableLesson)}% complete{resumableLesson.lessonState.currentNodeId && resumableLesson.lessonState.nodes[resumableLesson.lessonState.currentNodeId]?.title ? ` · ${resumableLesson.lessonState.nodes[resumableLesson.lessonState.currentNodeId].title}` : ""}</p></div><button className="button-primary" type="button" disabled={lessonLibraryBusyId !== null} onClick={() => void openLesson(resumableLesson.id)}>Continue</button></section> : <section className="continue-empty" aria-label="Continue learning"><h2>Ready for your next lesson?</h2><p>Your most recent learning will appear here once you begin.</p></section>}
          {hasRecentLessons && <RecentLessons lessons={savedLessons.slice(0, 5)} activeLessonId={resumableLesson?.id ?? null} busyLessonId={lessonLibraryBusyId} onContinue={(id) => void openLesson(id)} onDelete={(saved) => void requestDeleteSavedLesson(saved)} onNewLesson={startNewLessonFlow} />}
          <ProcessingQueue jobs={processingQueue.jobs} lessonActive={lessonActive} onOpen={(id) => void openLesson(id)} onRetry={(job) => void processingQueue.retry(job)} onReselect={(job, files) => void processingQueue.reselect(job, files).catch((error) => setPersistenceNotice(error instanceof Error ? error.message : "Those files did not match this lesson."))} onDiscard={(job) => void processingQueue.discard(job).catch(() => setPersistenceNotice("The lesson could not be discarded safely."))} />
          <div className="home-create-footer"><button className="button-secondary" type="button" onClick={startNewLessonFlow}>+ Add New Lesson</button></div>
        </section>}

        <div hidden={lessonActive || !persistenceHydrated || appView !== "library" || libraryView !== "index"}>
          <LessonLibrary lessons={savedLessons} processingJobs={processingQueue.jobs} busyLessonId={lessonLibraryBusyId} onOpen={(lesson) => void openLesson(lesson.id)} onDelete={(lesson) => void requestDeleteSavedLesson(lesson)} onNewLesson={startNewLessonFlow} />
          {persistenceNotice && !isRedundantPreparationNotice(persistenceNotice) && <p className="session-notice" role="status">{persistenceNotice}</p>}
        </div>

        <div className="product-view profile-view" hidden={lessonActive || !persistenceHydrated || appView !== "profile"}>
          <div className="view-heading"><div><p className="eyebrow">Your account</p><h1>Profile</h1><p>Manage account access and how your tutor teaches.</p></div></div>
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
          <section className="appearance-settings" aria-labelledby="appearance-title">
            <p className="eyebrow">Appearance</p><h2 id="appearance-title">Choose your theme</h2>
            <div className="appearance-options">
              {(["system", "light", "dark"] as AppearancePreference[]).map((option) => <button key={option} type="button" className={appearance === option ? "selected" : undefined} aria-pressed={appearance === option} onClick={() => setAppearance(option)}><strong>{capitalize(option)}</strong><small>{option === "system" ? "Use your device appearance" : option === "light" ? "Always use light appearance" : "Always use dark appearance"}</small></button>)}
            </div>
          </section>
          <section className="teaching-style" aria-labelledby="profile-preferences-title"><p className="eyebrow">Teaching preferences</p><h2 id="profile-preferences-title">Make lessons feel right for you</h2><TeachingStyleControls preferences={teachingPreferences} onChange={(update) => applyAuthoritativeTeachingPreferences({ ...teachingPreferencesRef.current, ...update })} /></section>
        </div>

        {!lessonActive && persistenceHydrated && appView === "library" && libraryView === "new" && <section className="product-view new-lesson-view" aria-labelledby="new-lesson-title">
          <button className="back-button" type="button" onClick={() => setLibraryView("index")}>← Back to Library</button>
          <div className="focused-view-heading"><p className="eyebrow">New lesson</p><h1 id="new-lesson-title">Create New Lesson</h1><p>Turn your learning materials into a focused voice lesson.</p></div>
          <LearningSourceUpload
            disabled={!persistenceHydrated}
            cloudUserId={cloudUserId}
            onQueueBundle={async (sources, files, title) => {
              await processingQueue.enqueue(sources, files, title);
              setLibraryView("index");
              setPersistenceNotice("");
            }}
            onDebug={addDebugMessage}
          />
          {userError && <p className="session-error" role="alert">{userError}</p>}
        </section>}

        {!lessonActive && persistenceHydrated && appView === "library" && libraryView === "lesson" && <section className="product-view lesson-detail-view" aria-labelledby="lesson-detail-title">
          <button className="back-button" type="button" onClick={() => setLibraryView("index")}>← Back to Library</button>
          {selectedSavedLesson ? <>
            <div className="focused-view-heading"><p className="eyebrow">Lesson</p><h1 id="lesson-detail-title">{selectedSavedLesson.title}</h1></div>
            <section className="lesson-detail-card" aria-label="Lesson details"><dl>
              <div><dt>Progress</dt><dd>{lessonProgress(selectedSavedLesson)}%</dd></div>
              <div><dt>Current topic</dt><dd>{selectedSavedLesson.lessonState.currentNodeId ? selectedSavedLesson.lessonState.nodes[selectedSavedLesson.lessonState.currentNodeId]?.title || "Ready to begin" : "Ready to begin"}</dd></div>
              <div><dt>Sources</dt><dd>{selectedSavedLesson.sources.length}</dd></div>
            </dl></section>
            <label className="topic-field setup-only"><span>Lesson topic or focus (optional)</span><input type="text" value={topicInput} onChange={(event) => setTopicInput(event.target.value)} placeholder="Teach the source's main topics" maxLength={160} disabled={requestingPermission} /></label>
            <div className="lesson-detail-actions"><button className="button-primary" type="button" onClick={startConversation} disabled={requestingPermission || learningSource?.status !== "ready" || restartPending}>{requestingPermission ? "Connecting…" : resumeExistingLesson ? "Continue Lesson" : "Start Lesson"}</button>{selectedLessonRestartable && <button className="button-secondary" type="button" disabled={restartPending || lessonLibraryBusyId !== null} onClick={() => setRestartConfirmationOpen(true)}>Restart Lesson</button>}<button className="button-danger" type="button" disabled={restartPending || lessonLibraryBusyId !== null} onClick={() => void requestDeleteSavedLesson(selectedSavedLesson)}>Delete Lesson</button></div>
            {selectedLessonRestartable && restartConfirmationOpen && <section className="restart-lesson-confirmation" role="alertdialog" aria-labelledby="restart-lesson-title" aria-describedby="restart-lesson-description">
              <h2 id="restart-lesson-title">Restart this lesson?</h2>
              <p id="restart-lesson-description">This will clear all teaching progress for this lesson and start it again from the beginning. Your materials and lesson content will not be deleted.</p>
              <div><button className="button-secondary" type="button" disabled={restartPending} onClick={() => setRestartConfirmationOpen(false)}>Cancel</button><button className="button-danger" type="button" disabled={restartPending} onClick={() => void restartLesson()}>{restartPending ? "Restarting…" : "Restart"}</button></div>
            </section>}
            <div className="lesson-detail-progress"><LessonRoadmap lessonState={selectedSavedLesson.lessonState} lessonActive={false} readOnly navigationPending={false} onNavigate={() => undefined} /></div>
            {userError && <p className="session-error" role="alert">{userError}</p>}
          </> : <div className="empty-state compact"><h1 id="lesson-detail-title">Lesson unavailable</h1><p>This lesson could not be loaded.</p></div>}
        </section>}

        {lessonActive && <div className="active-learning-grid">
          <SourceVisual
            conceptId={presentedConcept?.id ?? null}
            conceptTitle={presentedConcept?.title}
            contract={presentedConcept?.teaching}
            teachingPointIndexes={presentedTeachingPointIndexes}
            presentationKey={presentationKey}
            sources={lessonSources}
            lessonId={savedLessonId}
            cloudOwnerId={cloudUserId}
            authReady={cloudAuthReady}
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
          </section>}

          <section className={desktopTeachingStyleExpanded ? "active-teaching-preferences" : "active-teaching-preferences desktop-collapsed"} aria-labelledby="active-teaching-style-title">
            <header className="mobile-disclosure-header">
              <h2 id="active-teaching-style-title">Teaching style</h2>
              <button type="button" aria-expanded={mobileTeachingStyleExpanded} aria-controls="active-teaching-style-content" onClick={() => setMobileTeachingStyleExpanded((expanded) => !expanded)}>Teaching style</button>
              <button className="desktop-teaching-style-toggle" type="button" aria-label={desktopTeachingStyleExpanded ? "Collapse teaching style" : "Expand teaching style"} aria-expanded={desktopTeachingStyleExpanded} aria-controls="active-teaching-style-content" onClick={() => setDesktopTeachingStyleExpanded((expanded) => !expanded)}>
                <span aria-hidden="true">{desktopTeachingStyleExpanded ? "▼" : "▶"}</span>
              </button>
            </header>
            <div id="active-teaching-style-content" className={mobileTeachingStyleExpanded ? "mobile-disclosure-content mobile-expanded" : "mobile-disclosure-content"}>
            <TeachingStyleControls
              preferences={{ ...teachingPreferences, ...pendingTeachingPreferences }}
              onChange={changeActiveTeachingPreference}
            />
            {preferenceUpdatePending && (
              <p className="preference-pending" role="status">Updating teaching style…</p>
            )}
            </div>
          </section>

          <section className="conversation-transcript" aria-labelledby="conversation-transcript-title">
            <header className="mobile-disclosure-header">
              <h2 id="conversation-transcript-title">Transcript</h2>
              <button type="button" aria-expanded={mobileTranscriptExpanded} aria-controls="conversation-transcript-content" onClick={() => setMobileTranscriptExpanded((expanded) => !expanded)}>Transcript</button>
            </header>
            <div id="conversation-transcript-content" className={mobileTranscriptExpanded ? "conversation-transcript-body mobile-disclosure-content mobile-expanded" : "conversation-transcript-body mobile-disclosure-content"}><p><strong>You</strong>{latestLearnerReply || "No learner transcript yet."}</p><p><strong>Tutor</strong>{visibleTutorTranscript || "The tutor has not spoken yet."}</p></div>
          </section>
          </div>
        </div>}

        {lessonActive && userError && <p className="session-error" role="alert">{userError}</p>}
        {lessonActive && persistenceNotice && !isRedundantPreparationNotice(persistenceNotice) && <p className="session-notice" role="status">{persistenceNotice}</p>}

        {lessonActive && <div className="teaching-controls-stack">
        {lessonActive && <div className="status-row" aria-label="Conversation status">
          <div className="status-item" aria-live="polite">
            <span
              className={`status-dot${microphoneActive ? " status-dot-active" : ""}`}
              aria-hidden="true"
            />
            <span className="status-copy">
              <strong>{farewellFinishing ? "Finishing lesson…" : microphoneMuted ? "Muted" : "Listening"}</strong>
              <small>{farewellFinishing ? "Playing the tutor’s farewell" : microphoneMuted ? "Microphone is off" : "You can speak at any time"}</small>
            </span>
            <button className={`mute-button${microphoneMuted ? " mute-button-active" : ""}`} type="button" onClick={toggleMicrophoneMute} aria-label={microphoneMuted ? "Unmute microphone" : "Mute microphone"} aria-pressed={microphoneMuted}>{microphoneMuted ? "Unmute" : "Mute"}</button>
          </div>
          <div className="status-item" aria-live="polite">
            <span
              className={`status-dot${aiConnected ? " status-dot-active" : ""}`}
              aria-hidden="true"
            />
            <span>
              <strong>{transportState === "recovering" || transportState === "handoff" || transportState === "synchronizing" ? "Reconnecting…" : aiConnected ? "Tutor ready" : "Connecting…"}</strong>
              <small>{aiConnected ? "Voice conversation is active" : "Starting your lesson"}</small>
            </span>
          </div>
        </div>}

        {lessonActive && (
          <section className="lesson-controls" aria-label="Lesson response controls">
            <div className="quick-replies-group">
              <h3 className="quick-replies-heading" id="quick-replies-title">Quick Replies</h3>
              <div className="quick-responses" aria-labelledby="quick-replies-title">
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
            </div>
            <form className="typed-reply-form" onSubmit={submitTypedReply}>
              <label className="visually-hidden" htmlFor="typed-reply">Type a reply</label>
              <input ref={typedReplyInputRef} id="typed-reply" type="text" value={typedReply} onChange={(event) => setTypedReply(event.target.value)} placeholder="Type a reply…" autoComplete="off" />
              <button type="submit" disabled={!typedReply.trim()}>Send</button>
            </form>
          </section>
        )}

        {lessonActive && lessonState.rootNodeIds.length > 0 && <div className="lesson-progress-area"><LessonRoadmap
          lessonState={lessonState}
          lessonActive={lessonActive}
          navigationPending={roadmapNavigationPending}
          onNavigate={navigateFromRoadmap}
          reviewNodeId={nodeReview?.nodeId ?? null}
          onReview={startNodeReview}
          onExitReview={() => finishNodeReviewAndResume("manual")}
        /></div>}
        </div>}

        {lessonActive && <button
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
        </button>}

        {process.env.NODE_ENV === "development" && <details className="developer-debug"><summary>Developer Debug</summary><section className="lesson-state" aria-labelledby="lesson-state-title">
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
        </details></details>}

        {!lessonActive && appView === "home" && (installPrompt || showIosInstallHint) && (
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
