"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { LearningSourceUpload } from "../components/learning-source-upload";
import { AppNavigation, type AppView } from "../components/app-navigation";
import { LessonLibrary, lessonProgress } from "../components/lesson-library";
import { LessonRoadmap } from "../components/lesson-roadmap";
import { RecentLessons } from "../components/recent-lessons";
import { SourceVisual } from "../components/source-visual";
import { ProcessingQueue } from "../components/processing-queue";
import { PreprocessingDiagnostic } from "../components/preprocessing-diagnostic";
import CloudAccount from "../components/cloud-account";
import { AppearanceSettings } from "../components/appearance-settings";
import { DeveloperDebugPanel, type DebugMessage } from "../components/developer-debug-panel";
import { LessonDetail } from "../components/lesson-detail";
import { RestartLessonConfirmation } from "../components/restart-lesson-confirmation";
import {
  ActiveLessonSummary,
  ActiveTeachingPreferences,
  ConversationStatusRow,
  ConversationTranscript,
  LessonResponseControls,
  TeachingRoomHeader,
} from "../components/teaching-room";
import { TeachingStyleControls } from "../components/teaching-style-controls";
import { AudioSession } from "../lib/audio-session";
import {
  ACOUSTIC_ACTIVITY_MULTIPLIER,
  ACOUSTIC_LOG_COOLDOWN_MS,
  ENGAGEMENT_CHECK_INTERVAL_MS,
  IDLE_CONFIRMATION_MS,
  MIN_ACOUSTIC_RMS,
  NOISE_FLOOR_SMOOTHING,
  isMeaningfulLearnerTranscript,
  pcm16Rms,
  type EngagementState,
} from "../lib/engagement";
import {
  createFarewellTurn,
  farewellCompletionDiagnostic,
  isCurrentFarewell,
  isFarewellDrainCurrent,
  isFarewellReadyToFinish,
  type FarewellTurn,
} from "../lib/farewell-controller";
import {
  canRequestIdleConfirmation,
  classifyMeaningfulSpeech,
  IDLE_CONFIRMATION_CONTROL_TEXT,
  planIdleConfirmationResolution,
  planQuickResponse,
  shouldEndForInactivity,
  shouldLogMeaningfulActivity,
  shouldRequestIdleConfirmation,
  type QuickResponse,
} from "../lib/idle-engagement";
import {
  LiveTransportManager,
  type LiveTransportState,
} from "../lib/live-transport-manager";
import {
  normalizeLiveServerMessage,
  type LiveProviderMessage,
  type LiveToolCall,
} from "../lib/live-message-events";
import {
  buildLessonQueryResult,
  classifyLessonStateCall,
  decideQueryContinuation,
  decideSessionControl,
  decideSilentRecoveryFollowUp,
  decorateLessonStateResult,
  invalidLessonStateResult,
  planLessonTransitionEffects,
  reviewActiveRejection,
  routeToolCall,
  unknownToolResult,
  wrapUpEndResult,
} from "../lib/lesson-tool-decisions";
import {
  buildLessonInstruction,
  createLessonState,
  deriveResumePoint,
  GEMINI_LIVE_MODEL,
  getCurrentConcept,
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
  canStartNodeReview,
  createNodeReview,
  NODE_REVIEW_BEAT_PREFIX,
  planExitNodeReview,
  planFinishNodeReview,
  resolveAssistantCheckpointConceptId,
  shouldResumeTeachingAfterReview,
} from "../lib/review-controller";
import {
  buildTeachingBeatControl,
  createActiveBeat,
  createPresentationBeat,
  evaluateLessonBeatCommit,
  evaluateReviewBeatCommit,
  planLessonBeatAssignment,
  planReviewBeatAssignment,
  type ActiveTeachingBeat,
  type NodeReviewState,
  type PresentationBeat,
} from "../lib/teaching-beat-runtime";
import {
  aiConnectionStatusForTransportState,
  buildNewLessonStartPrefix,
  getMicrophoneErrorMessage,
  getRealtimeErrorMessage,
  isMicrophonePermissionDenied,
  planStartupImperative,
  type AiConnectionStatus,
} from "../lib/teaching-session";
import {
  DEFAULT_TEACHING_PREFERENCES,
  applyTeachingPreferenceUpdate,
  type TeachingPreferences,
} from "../lib/teaching-preferences";
import type { RecentTeachingContextEntry } from "../lib/local-persistence";
import {
  appendRecentTeachingContext,
  getPersistedResumeContext,
} from "../lib/lesson-snapshot";
import { isSupabaseConfigured } from "../lib/supabase/config";
import { sanitizeLearnerVisibleTutorTranscript } from "../lib/transcript-visibility";
import { mergeLearnerTranscript } from "../lib/learner-transcript";
import {
  emitTestEvent,
  installTestObservabilityBridge,
} from "../lib/test-observability";
import { useAppearance } from "../lib/use-appearance";
import { useLessonProcessingQueue } from "../lib/use-lesson-processing-queue";
import { useLessonWorkspace } from "../lib/use-lesson-workspace";
import { usePwaInstall } from "../lib/use-pwa-install";

type MicrophoneStatus =
  | "Not active"
  | "Requesting permission"
  | "Active"
  | "Permission denied"
  | "Error";

type TeachingPreferenceUpdate = Partial<TeachingPreferences>;
type PendingTeachingPreferences = Partial<TeachingPreferences>;
type LibraryView = "index" | "lesson" | "new";

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

function isRedundantPreparationNotice(value: string) {
  return /lesson is being prepared/i.test(value) &&
    (/visible in your library/i.test(value) || /follow its progress on home/i.test(value));
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
  const [teachingPreferences, setTeachingPreferences] = useState<TeachingPreferences>(
    DEFAULT_TEACHING_PREFERENCES,
  );
  const [pendingTeachingPreferences, setPendingTeachingPreferences] =
    useState<PendingTeachingPreferences>({});
  const [preferenceUpdatePending, setPreferenceUpdatePending] = useState(false);
  const [roadmapNavigationPending, setRoadmapNavigationPending] = useState(false);
  const [cloudUserId, setCloudUserId] = useState<string | null>(null);
  const [cloudAuthReady, setCloudAuthReady] = useState(!isSupabaseConfigured());
  const [lessonState, setLessonState] = useState<LessonState>(() =>
    createLessonState("Uploaded material"),
  );
  const [presentationBeat, setPresentationBeat] = useState<PresentationBeat | null>(null);
  const [restartConfirmationOpen, setRestartConfirmationOpen] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [nodeReview, setNodeReview] = useState<NodeReviewState | null>(null);
  const [showLessonComplete, setShowLessonComplete] = useState(false);
  const cloudAuthReadyRef = useRef(cloudAuthReady);
  const cloudUserIdTestRef = useRef<string | null>(cloudUserId);
  const transportStateTestRef = useRef<LiveTransportState>(transportState);

  const transportRef = useRef<LiveTransportManager | null>(null);
  const audioSessionRef = useRef<AudioSession | null>(null);
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
  const toolResultsRef = useRef(new Map<string, Record<string, unknown>>());
  const cancelledToolCallIdsRef = useRef(new Set<string>());
  const nextMessageIdRef = useRef(0);
  const lessonActiveRef = useRef(false);
  const lessonStartupPendingRef = useRef(false);
  // Run that set lessonStartupPendingRef; only that run may clear it in finally.
  const lessonStartupRunRef = useRef(0);
  const engagementStateRef = useRef<EngagementState>("ended");
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

  // One page-lifetime instance; created lazily so renders do not construct it.
  audioSessionRef.current ??= new AudioSession(addDebugMessage);
  const audioSession = audioSessionRef.current;

  useEffect(() => installTestObservabilityBridge(() => {
    const state = lessonStateRef.current;
    const current = getCurrentConcept(state);
    const active = activeTeachingBeatRef.current;
    const transcript = [state.lastUserTranscript, state.lastAssistantTranscript].filter(Boolean);
    return {
      lessonId: workspace.savedLessonIdRef.current,
      currentNodeId: state.currentNodeId,
      coverage: Object.fromEntries(Object.values(state.nodes).map((node) => [node.id, node.status])),
      status: state.status,
      resumePoint: state.resumePoint,
      deliveryCursor: current ? state.teachingContractProgress[current.id]?.nextTeachingPointIndex ?? null : null,
      activeDeliveryUnit: active ? {
        conceptId: active.conceptId,
        index: active.deliveryUnitIndex,
        objective: active.unit.objective,
      } : null,
      activePresentationBeat: active ? {
        index: active.beatIndex,
        teachingPointIndexes: [...active.teachingPointIndexes],
        mode: active.mode,
      } : null,
      reviewActive: Boolean(nodeReviewRef.current),
      interruptionCount: state.interruptionCount,
      connectionState: transportStateTestRef.current,
      tutorAudioPlaying: assistantSpeakingRef.current,
      generationEpoch: generationEpochRef.current,
      audioEpoch: active?.generationEpoch ?? null,
      transcriptLength: transcript.join(" ").length,
      latestTranscriptRole: state.lastUserTranscript
        ? "learner"
        : state.lastAssistantTranscript ? "tutor" : null,
      lessonActive: lessonActiveRef.current,
      startupPending: lessonStartupPendingRef.current,
      persistenceHydrated: workspace.persistenceHydratedRef.current,
      cloudAuthReady: cloudAuthReadyRef.current,
      cloudUserId: cloudUserIdTestRef.current,
    };
  }), []);

  cloudAuthReadyRef.current = cloudAuthReady;
  cloudUserIdTestRef.current = cloudUserId;
  transportStateTestRef.current = transportState;

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

  const { appearance, setAppearance } = useAppearance();

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
    audioSession.player?.cancelBatch(active.generationEpoch);
    generationEpochRef.current += 1;
    emitTestEvent("audio.epoch-invalidated", {
      reason,
      invalidatedEpoch: active.generationEpoch,
      generationEpoch: generationEpochRef.current,
    });
    addDebugMessage(`Teaching beat interrupted: epoch=${active.generationEpoch}, commit=no, reason=${reason}`);
  }

  function assignNextTeachingBeat(prefix = "", sendInstruction = true): ActiveTeachingBeat | null {
    if (!lessonActiveRef.current || activeTeachingBeatRef.current ||
        closingTurnRef.current || nodeReviewRef.current) return null;
    const plan = planLessonBeatAssignment(lessonStateRef.current, { wrapUp: lessonWrapUpRef.current });
    if (!plan) return null;
    const { concept, resolved, activatedState } = plan;
    const generationEpoch = ++generationEpochRef.current;
    const active = createActiveBeat(resolved, concept.id, "lesson", generationEpoch);
    activeTeachingBeatRef.current = active;
    emitTestEvent("lesson.generation-started", {
      conceptId: concept.id,
      generationEpoch,
      deliveryUnitIndex: resolved.deliveryUnitIndex,
      beatIndex: resolved.beatIndex,
    });
    const presentation = createPresentationBeat(resolved, concept.id);
    presentationBeatRef.current = presentation;
    setPresentationBeat(presentation);
    audioSession.player?.beginBatch(generationEpoch, (epoch) => {
      const current = activeTeachingBeatRef.current;
      if (!current || current.generationEpoch !== epoch) {
        addDebugMessage(`Teaching beat stale event ignored: epoch=${epoch}`);
        return;
      }
      current.audioNaturallyDrained = true;
      emitTestEvent("tutor.audio-ended", { generationEpoch: epoch, natural: true });
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
    // Built from the pre-activation ref state: activation is applied only after the send below.
    const instruction = buildTeachingBeatControl(lessonStateRef.current, active, prefix);
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
    if (!lessonActiveRef.current || !review ||
        activeTeachingBeatRef.current || closingTurnRef.current) return null;
    const plan = planReviewBeatAssignment(lessonStateRef.current, review);
    if (!plan) return null;
    const { concept, resolved } = plan;
    const generationEpoch = ++generationEpochRef.current;
    const active = createActiveBeat(resolved, concept.id, "review", generationEpoch);
    activeTeachingBeatRef.current = active;
    const presentation = createPresentationBeat(resolved, concept.id);
    presentationBeatRef.current = presentation;
    setPresentationBeat(presentation);
    audioSession.player?.beginBatch(generationEpoch, (epoch) => {
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
    const instruction = buildTeachingBeatControl(lessonStateRef.current, active, prefix || NODE_REVIEW_BEAT_PREFIX);
    if (sendInstruction && (!instruction || !transportRef.current?.sendRealtimeInput({ text: instruction }))) {
      invalidateActiveTeachingBeat("review-send-failed");
      return null;
    }
    addDebugMessage(`Node review beat assigned: concept=${concept.id}, beat=${resolved.deliveryUnitIndex}/${resolved.beatIndex}, epoch=${generationEpoch}`);
    return active;
  }

  function maybeFinishFarewell() {
    const farewell = closingTurnRef.current;
    if (!isFarewellReadyToFinish(farewell, conversationRunRef.current, generationEpochRef.current)) return;
    farewell.completionStarted = true;
    assistantSpeakingRef.current = false;
    transportRef.current?.setAssistantSpeaking(false);
    setShowLessonComplete(true);
    addDebugMessage(farewellCompletionDiagnostic(farewell));
    addDebugMessage("FAREWELL_FLOW completion-animation");
    completionAnimationTimerRef.current = setTimeout(() => {
      completionAnimationTimerRef.current = null;
      addDebugMessage("FAREWELL_FLOW stop");
      void stopConversation("confirmed");
    }, 2_000);
  }

  function finishNodeReviewAndResume(reason: "completed" | "manual") {
    const plan = planFinishNodeReview(
      nodeReviewRef.current,
      reviewResumeGuardRef.current,
      activeTeachingBeatRef.current,
    );
    if (!plan) return false;
    reviewResumeGuardRef.current = plan.reviewResumeGuard;
    if (plan.invalidateReviewBeat) {
      invalidateActiveTeachingBeat(`node-review-${reason}`);
      audioSession.player?.clear();
    }
    nodeReviewRef.current = null;
    setNodeReview(null);
    emitTestEvent("review.ended", { nodeId: plan.review.nodeId, reason });
    presentationBeatRef.current = plan.presentationBeat;
    setPresentationBeat(plan.presentationBeat);
    addDebugMessage(`Node review exited: reason=${reason}`);
    if (!shouldResumeTeachingAfterReview(lessonWrapUpRef.current, isLessonPlanComplete(lessonStateRef.current))) {
      return true;
    }
    // Sent as realtime text, even from inside a tool-call handler before that
    // call's tool response (refactor-plan §6.6).
    assignNextTeachingBeat();
    return true;
  }

  function beginClosingFarewell() {
    if (closingTurnRef.current || restartPendingRef.current) return false;
    invalidateActiveTeachingBeat("lesson-closing");
    const generationEpoch = ++generationEpochRef.current;
    closingTurnRef.current = createFarewellTurn(conversationRunRef.current, generationEpoch);
    setFarewellFinishing(true);
    audioSession.player?.beginBatch(generationEpoch, (epoch) => {
      const farewell = closingTurnRef.current;
      if (!isFarewellDrainCurrent(farewell, conversationRunRef.current, epoch, generationEpochRef.current)) return;
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
      const evaluation = evaluateReviewBeatCommit(state, nodeReviewRef.current, active, generationEpochRef.current);
      if (evaluation.kind !== "committed") return;
      const { review: nextReview, nextIndex, complete } = evaluation;
      nodeReviewRef.current = nextReview;
      setNodeReview(nextReview);
      activeTeachingBeatRef.current = null;
      audioSession.player?.cancelBatch(epoch);
      addDebugMessage(`Node review beat committed: concept=${nextReview.nodeId}, next=${nextIndex}, complete=${complete}`);
      emitTestEvent("beat.commit", { mode: "review", conceptId: nextReview.nodeId, nextIndex });
      addReviewFlowDiagnostic(
        "review-beat-committed",
        `nextReviewCursor=${nextIndex} nodeComplete=${complete} ` +
        `nextAction=${complete ? "review-final-wait" : "review-next"}`,
      );
      if (!complete) assignNextReviewBeat();
      return;
    }
    const evaluation = evaluateLessonBeatCommit(state, active, lessonActiveRef.current);
    if (evaluation.kind === "not-ready") return;
    if (evaluation.kind === "rejected") {
      invalidateActiveTeachingBeat("commit-rejected");
      return;
    }
    const { state: committedState, previousIndex: currentNext, nextIndex } = evaluation;
    lessonStateRef.current = committedState;
    setLessonState(committedState);
    emitTestEvent("beat.commit", { mode: "lesson", conceptId: active.conceptId, nextIndex });
    emitTestEvent("delivery.cursor-changed", { conceptId: active.conceptId, from: currentNext, to: nextIndex });
    emitTestEvent("coverage.changed", { conceptId: active.conceptId, status: committedState.nodes[active.conceptId]?.status });
    activeTeachingBeatRef.current = null;
    audioSession.player?.cancelBatch(epoch);
    addDebugMessage(
      `Teaching beat committed: concept=${active.conceptId}, points=${active.teachingPointIndexes[0]}-${active.teachingPointIndexes.at(-1)}, nextTeachingPointIndex=${nextIndex}`,
    );
    if (evaluation.wrapUp) {
      lessonWrapUpRef.current = true;
      addDebugMessage(`Lesson wrap-up entered: finalConcept=${active.conceptId}`);
    }
    if (evaluation.autoChain) {
      addDebugMessage(
        `Teaching beat auto-chain: from=${active.deliveryUnitIndex}/${active.beatIndex} ` +
        `to=${active.deliveryUnitIndex}/${active.beatIndex + 1}`,
      );
      assignNextTeachingBeat();
    } else {
      addDebugMessage(`Teaching unit waiting for learner: unit=${active.deliveryUnitIndex}`);
    }
  }

  // Captured before the first await: a newer run may install its own audio
  // resources while this disposal is suspended, and those are not ours to release.
  // Every caller bumps the run before capturing; only a newer startConversation
  // changes it again, so a mismatch after an await means this session was replaced
  // and the shared page/session state now belongs to the newer run.
  const captureDisposalOwnership = () => ({
    ...audioSession.captureResources(),
    run: conversationRunRef.current,
    transport: transportRef.current,
  });

  // Callers that await before disposing (stopConversation) capture first and pass it in.
  const disposeResources = async (
    sendAudioStreamEnd: boolean,
    owned = captureDisposalOwnership(),
  ) => {
    const { run } = owned;
    if (run === conversationRunRef.current) invalidateActiveTeachingBeat("resources-disposed");
    tokenRequestRef.current?.abort();
    tokenRequestRef.current = null;

    await audioSession.stopStreamer(owned.streamer);

    owned.transport?.close(sendAudioStreamEnd);
    if (transportRef.current === owned.transport) transportRef.current = null;

    audioSession.stopTracks(owned.stream);

    await audioSession.closePlayer(owned.player);
    if (run === conversationRunRef.current) resetSessionState();
    await audioSession.releaseWakeLock(owned.wakeLock);
    if (run === conversationRunRef.current) resetSessionTimersAndControls();
  };

  // Shared page/session resets, split around the wake-lock release so the
  // original disposal order is unchanged.
  const resetSessionState = () => {
    assistantSpeakingRef.current = false;
    learnerActivityRunRef.current = null;
    typedInterruptionHandledRef.current = false;
    assistantTurnActiveRef.current = false;
    lastAssistantTurnCompleteRef.current = true;
    resumptionPendingRef.current = false;
    persistedResumeBriefingPendingRef.current = false;
    persistedResumeFirstResponseLoggedRef.current = false;
    assistantCheckpointConceptIdRef.current = null;
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
  };

  const resetSessionTimersAndControls = () => {
    if (engagementTimerRef.current) clearInterval(engagementTimerRef.current);
    if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
    if (quickResponseTimerRef.current) clearTimeout(quickResponseTimerRef.current);
    if (preferenceUpdateTimerRef.current) clearTimeout(preferenceUpdateTimerRef.current);
    if (roadmapNavigationTimerRef.current) clearTimeout(roadmapNavigationTimerRef.current);
    workspace.cancelScheduledSave();
    engagementTimerRef.current = null;
    confirmationTimerRef.current = null;
    quickResponseTimerRef.current = null;
    preferenceUpdateTimerRef.current = null;
    roadmapNavigationTimerRef.current = null;
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

  const updateEngagementState = (state: EngagementState) => {
    engagementStateRef.current = state;
    setEngagementState(state);
  };

  const markMeaningfulActivity = () => {
    const now = Date.now();
    lastMeaningfulLearnerActivityAtRef.current = now;
    if (shouldLogMeaningfulActivity(engagementStateRef.current)) {
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

  const updateRecentTeachingContext = (conceptId: string | null, transcript: string) => {
    const next = appendRecentTeachingContext(
      recentTeachingContextRef.current,
      lessonStateRef.current,
      conceptId,
      transcript,
    );
    if (!next) return;
    recentTeachingContextRef.current = next;
    addDebugMessage(
      `Resume teaching context updated: concept=${conceptId}, ` +
      `entries=${recentTeachingContextRef.current.length}`,
    );
  };

  const resetCurrentLessonProgress = async () => {
    const prepared = workspace.preparedSourceRef.current;
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
    workspace.markLessonNotStarted();
    await workspace.persistCurrentLesson(freshState);
    addDebugMessage(`Completed lesson progress reset: lesson=${workspace.savedLessonIdRef.current || "unknown"}`);
    return true;
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
    audioSession.player?.clear();
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
      if (!shouldEndForInactivity(engagementStateRef.current)) return;
      addDebugMessage("Session ended due to inactivity");
      void stopConversation("inactivity");
    }, IDLE_CONFIRMATION_MS);
  };

  const requestIdleConfirmation = () => {
    if (!canRequestIdleConfirmation(lessonActiveRef.current, engagementStateRef.current)) return;
    updateEngagementState("possibly-idle");
    addDebugMessage("Possible inactivity");
    updateEngagementState("confirming");
    addDebugMessage("Idle confirmation requested");
    transportRef.current?.sendRealtimeInput({
      text: IDLE_CONFIRMATION_CONTROL_TEXT,
    });
    scheduleIdleEnd();
  };

  const beginIdleMonitoring = () => {
    const now = Date.now();
    lastMeaningfulLearnerActivityAtRef.current = now;
    updateEngagementState("active");
    engagementTimerRef.current = setInterval(() => {
      if (!shouldRequestIdleConfirmation(
        lessonActiveRef.current,
        engagementStateRef.current,
        lastMeaningfulLearnerActivityAtRef.current,
        Date.now(),
      )) return;
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
        await audioSession.flushPendingMicrophoneAudio();
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
    const { text, idleEffect } = planQuickResponse(response, confirming);

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
    if (idleEffect === "resume-active") {
      if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
      confirmationTimerRef.current = null;
      updateEngagementState("active");
      addDebugMessage("Quick response confirmed session continuation");
    } else if (idleEffect === "restart-confirmation-timer") {
      scheduleIdleEnd();
    }

    setQuickResponseFeedback(`${response} sent`);
    if (quickResponseTimerRef.current) clearTimeout(quickResponseTimerRef.current);
    quickResponseTimerRef.current = setTimeout(() => {
      setQuickResponseFeedback("");
      quickResponseTimerRef.current = null;
    }, 1_500);
  };

  const processingQueue = useLessonProcessingQueue({
    ownerId: cloudUserId,
    onDebug: addDebugMessage,
    onLessonReady: async () => {
      await workspace.refreshScopedLibrary(workspace.workspaceOwnerIdRef.current, "processing-ready");
      workspace.setPersistenceNotice("Your processed lesson is ready in the library.");
    },
  });

  // Called where the workspace-load and autosave effects used to be declared, so
  // effect order (after the processing queue, before PWA/mount) is unchanged.
  const workspace = useLessonWorkspace({
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
    onWorkspaceReplaced: () => {
      lessonWrapUpRef.current = false;
      conversationalRestartConfirmationRef.current = false;
      setRestartConfirmationOpen(false);
      presentationBeatRef.current = null;
      setPresentationBeat(null);
    },
    onCurrentLessonDeleted: () => setLibraryView("index"),
  });

  const { installPrompt, showIosInstallHint, requestInstall } = usePwaInstall();

  useEffect(() => {
    isMountedRef.current = true;

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && lessonActiveRef.current) {
        void audioSession.requestWakeLock();
        transportRef.current?.ensureHealthy();
        void audioSession.player?.prepare().catch(() => {
          setUserError("Audio was suspended. End the lesson, then start again.");
          addDebugMessage("Audio context could not resume after backgrounding");
        });
      } else if (document.visibilityState === "hidden" && lessonActiveRef.current) {
        addDebugMessage("App backgrounded; mobile audio or connection may be suspended");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      isMountedRef.current = false;
      conversationRunRef.current += 1;
      void disposeResources(false);
    };
  }, []);

  const handleLearnerInterruption = (discreteTextTurn = false) => {
    if (isCurrentFarewell(closingTurnRef.current, conversationRunRef.current, generationEpochRef.current)) return;
    // Gemini cuts playback immediately. Smoothing a mid-phoneme cutoff is a
    // later UX refinement; yielding to the learner remains the priority.
    invalidateActiveTeachingBeat("barge-in");
    audioSession.player?.clear();
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
      emitTestEvent("interruption.accepted", {
        conceptId: current.currentNodeId,
        interruptionCount: current.interruptionCount + 1,
      });
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

  const handleLiveMessage = (message: LiveProviderMessage) => {
    for (const event of normalizeLiveServerMessage(message)) {
      switch (event.type) {
        case "tool-call-cancellation":
          for (const id of event.ids) {
            cancelledToolCallIdsRef.current.add(id);
          }
          break;

        case "tool-calls":
          handleLessonToolCalls(event.calls);
          return;

        // Update transport gating before interruption handling. Gemini can deliver
        // ACTIVITY_START and interrupted together; ordering this first prevents a
        // pending graceful rollover from retiring the socket between those events.
        case "voice-activity-gate":
          if (event.activity === "start") {
            emitTestEvent("learner.activity-detected", { source: "voice" });
            learnerActivityRunRef.current = conversationRunRef.current;
            reviewResumeGuardRef.current = false;
            transportRef.current?.setLearnerSpeaking(true);
            userTranscriptRef.current = "";
            voiceDraftRef.current = "";
            voiceDraftOpenRef.current = true;
            lastMeaningfulLearnerTranscriptRef.current = "";
            setLatestLearnerReply("");
            addDebugMessage("User speech started");
          } else {
            transportRef.current?.setLearnerSpeaking(false);
          }
          break;

        case "input-transcription": {
          const transcriptFragment = event.text;
          if (!voiceDraftOpenRef.current) {
            voiceDraftRef.current = "";
            voiceDraftOpenRef.current = true;
          }
          if (isMeaningfulLearnerTranscript(transcriptFragment)) {
            lastMeaningfulLearnerTranscriptRef.current = mergeTranscript(
              lastMeaningfulLearnerTranscriptRef.current,
              transcriptFragment,
            );
            transportRef.current?.noteLearnerTurnReceived();
            const speechEffect = classifyMeaningfulSpeech(engagementStateRef.current);
            if (speechEffect === "mark-activity") markMeaningfulActivity();
            else if (speechEffect === "note-confirmation-speech") {
              meaningfulConfirmationSpeechRef.current = true;
            }
          }
          const wasInterrupted = lessonStateRef.current.status === "interrupted";
          userTranscriptRef.current = mergeTranscript(
            userTranscriptRef.current,
            transcriptFragment,
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
            emitTestEvent("clarification.started", { source: "voice" });
            addDebugMessage("Resolving learner interruption");
          }
          break;
        }

        case "interim-input-transcription":
          if (!voiceDraftOpenRef.current) {
            voiceDraftRef.current = "";
            voiceDraftOpenRef.current = true;
          }
          voiceDraftRef.current = mergeLearnerTranscript(
            voiceDraftRef.current,
            event.text,
          );
          setLatestLearnerReply(voiceDraftRef.current);
          break;

        case "learner-draft-closed":
          voiceDraftRef.current = "";
          voiceDraftOpenRef.current = false;
          break;

        case "output-transcription":
          lastAssistantTurnCompleteRef.current = false;
          if (!assistantTurnActiveRef.current) {
            assistantTurnActiveRef.current = true;
            assistantTranscriptRef.current = "";
            visibleTutorTranscriptRawRef.current = "";
            setVisibleTutorTranscript("");
            assistantCheckpointConceptIdRef.current = resolveAssistantCheckpointConceptId(
              nodeReviewRef.current,
              Boolean(closingTurnRef.current),
              lessonStateRef.current.currentNodeId,
            );
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
            event.text,
          );
          assistantTranscriptRef.current = sanitizeLearnerVisibleTutorTranscript(
            visibleTutorTranscriptRawRef.current,
          );
          setVisibleTutorTranscript(assistantTranscriptRef.current);
          updateLessonState((current) => ({
            ...current,
            lastAssistantTranscript: assistantTranscriptRef.current,
          }));
          break;

        case "interrupted":
          if (typedInterruptionHandledRef.current) {
            typedInterruptionHandledRef.current = false;
            addDebugMessage("Provider confirmed typed interruption");
          } else if (hasCurrentLearnerActivity()) {
            addReviewFlowDiagnostic("provider-interrupted-accepted", "reason=current-learner-activity");
            handleLearnerInterruption();
          } else {
            addReviewFlowDiagnostic("provider-interrupted-ignored", "reason=no-learner-activity");
          }
          break;

        case "voice-activity-status":
          if (event.activity === "start") {
            if (lessonStateRef.current.status === "interrupted") {
              updateLessonState((current) => ({
                ...current,
                status: "resolving-interruption",
              }));
              addDebugMessage("Resolving learner interruption");
            }
          } else {
            addDebugMessage("User speech ended");
          }
          break;

        case "audio-chunk": {
          const farewell = closingTurnRef.current;
          if (isCurrentFarewell(farewell, conversationRunRef.current, generationEpochRef.current)) {
            farewell.audioReceived = true;
          }

          if (!assistantSpeakingRef.current) {
            typedInterruptionHandledRef.current = false;
            assistantSpeakingRef.current = true;
            emitTestEvent("tutor.audio-started", {
              generationEpoch: activeTeachingBeatRef.current?.generationEpoch ?? generationEpochRef.current,
            });
            transportRef.current?.setAssistantSpeaking(true);
            if (!assistantTurnActiveRef.current) {
              assistantTurnActiveRef.current = true;
              assistantTranscriptRef.current = "";
              visibleTutorTranscriptRawRef.current = "";
              setVisibleTutorTranscript("");
              assistantCheckpointConceptIdRef.current = resolveAssistantCheckpointConceptId(
                nodeReviewRef.current,
                Boolean(closingTurnRef.current),
                lessonStateRef.current.currentNodeId,
              );
            }
            if (persistedResumeBriefingPendingRef.current &&
                !persistedResumeFirstResponseLoggedRef.current) {
              persistedResumeFirstResponseLoggedRef.current = true;
              addDebugMessage("First persisted-resume response received");
            }
            if (resumptionPendingRef.current) {
              emitTestEvent("canonical.resume-requested", {
                conceptId: lessonStateRef.current.currentNodeId,
              });
              updateLessonState((current) => ({
                ...current,
                status: "resuming",
              }));
              addDebugMessage("Lesson resuming");
            }
            addDebugMessage("Assistant response started");
          }
          audioSession.player?.play(event.data);
          break;
        }

        // Always the final event, so the stale-farewell `return` below skips only
        // the rest of this completion handling, exactly as before the extraction.
        case "generation-complete": {
          const active = activeTeachingBeatRef.current;
          const closing = closingTurnRef.current;
          addReviewFlowDiagnostic("provider-generation-complete");
          if (active) {
            active.generationComplete = true;
            if (active.mode === "review") addReviewFlowDiagnostic("review-generation-complete");
            addDebugMessage(`Teaching generation complete: epoch=${active.generationEpoch}`);
            audioSession.player?.completeBatch(active.generationEpoch);
          }
          if (closing) {
            if (!isCurrentFarewell(closing, conversationRunRef.current, generationEpochRef.current)) return;
            closing.generationComplete = true;
            addDebugMessage("FAREWELL_FLOW generation-complete");
            audioSession.player?.completeBatch(closing.generationEpoch);
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
          if (lessonStateRef.current.status === "resolving-interruption" ||
              lessonStateRef.current.status === "resuming") {
            emitTestEvent("clarification.completed", {
              conceptId: lessonStateRef.current.currentNodeId,
            });
          }
          if (persistedResumeBriefingPendingRef.current) {
            persistedResumeBriefingPendingRef.current = false;
            addDebugMessage("Resume briefing completed");
          }
          addDebugMessage("Assistant response completed");
          break;
        }
      }
    }
  };

  const handleLessonToolCalls = (calls: LiveToolCall[]) => {
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
      const route = routeToolCall(call.name);
      const lessonCall = route === "lesson_state"
        ? classifyLessonStateCall(action, conceptId, Boolean(nodeReviewRef.current))
        : null;

      if (route === "update_teaching_preferences") {
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
            workspace.topicInput.trim(),
            workspace.learningSource?.name,
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
      } else if (route === "session_control") {
        const decision = decideSessionControl(action, {
          lessonStarted: workspace.resumeExistingLessonRef.current,
          restartConfirmationPending: conversationalRestartConfirmationRef.current,
          wrapUpActive: lessonWrapUpRef.current,
          idleConfirmationActive: engagementStateRef.current === "confirming",
        });
        switch (decision.kind) {
          case "restart-request":
            conversationalRestartConfirmationRef.current = true;
            addDebugMessage("Conversational lesson restart confirmation requested");
            break;
          case "restart-confirm":
            conversationalRestartConfirmationRef.current = false;
            restartAfterResponse = true;
            break;
          case "restart-cancel":
            conversationalRestartConfirmationRef.current = false;
            break;
          case "wrap-up-end": {
            const closingStarted = beginClosingFarewell();
            if (closingStarted) addDebugMessage("Final questions completed; graceful closing started");
            result = wrapUpEndResult(closingStarted);
            break;
          }
          case "confirm-continue":
          case "confirm-end":
          case "confirm-unclear": {
            const plan = planIdleConfirmationResolution(
              decision.kind,
              meaningfulConfirmationSpeechRef.current,
            );
            if (plan.resumeActive) {
              if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
              confirmationTimerRef.current = null;
              updateEngagementState("active");
            }
            if (plan.markMeaningfulActivity) markMeaningfulActivity();
            meaningfulConfirmationSpeechRef.current = false;
            addDebugMessage(plan.debugMessage);
            if (plan.endAfterResponse) endAfterResponse = true;
            break;
          }
        }
        if (decision.kind !== "wrap-up-end") result = decision.result;
      } else if (route !== "lesson_state") {
        result = unknownToolResult(call.name);
      } else if (lessonCall?.kind === "query") {
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
        result = buildLessonQueryResult(
          queryLessonState(state),
          postResumeQueryReceived,
          continuity,
          teachingPreferencesRef.current,
        );
        const review = nodeReviewRef.current;
        const continuation = decideQueryContinuation({
          purpose: queryPurpose,
          postResumeQueryReceived,
          silentRecoveryPending: silentLessonRecoveryPendingRef.current,
          review,
          reviewResumeGuard: reviewResumeGuardRef.current,
          lessonPlanComplete: isLessonPlanComplete(lessonStateRef.current),
        });
        let assignment: ActiveTeachingBeat | null = null;
        if (continuation === "finish-review") {
          finishNodeReviewAndResume("completed");
        } else if (continuation === "assign-review-beat") {
          assignment = assignNextReviewBeat("", false);
        } else if (continuation === "assign-teaching-beat") {
          assignment = assignNextTeachingBeat("", false);
        }
        if (assignment) assignmentControl = buildTeachingBeatControl(lessonStateRef.current, assignment);
        if (postResumeQueryReceived) {
          addDebugMessage("Post-resume continuity snapshot prepared");
          addDebugMessage("Teaching preferences included in post-resume state");
        }
        addDebugMessage("Lesson state queried");
      } else if (lessonCall?.kind === "review-rejected") {
        addReviewFlowDiagnostic("navigation-rejected-during-review");
        result = reviewActiveRejection(action);
      } else if (lessonCall?.kind === "transition") {
        const moveAction = lessonCall.action;
        invalidateActiveTeachingBeat(`lesson-${moveAction}`);
        audioSession.player?.clear();
        const transition = moveAction === "navigate"
          ? navigateLessonState(lessonStateRef.current, lessonCall.conceptId)
          : skipLessonNode(lessonStateRef.current, lessonCall.conceptId);
        const effects = planLessonTransitionEffects(moveAction, transition.result);
        result = transition.result;
        events = transition.events;
        if (transition.state !== lessonStateRef.current) {
          if (effects.clearWrapUp) lessonWrapUpRef.current = false;
          lessonStateRef.current = transition.state;
          setLessonState(transition.state);
        }
        if (effects.logContractProgress) {
          const active = getCurrentConcept(transition.state);
          if (active?.teaching) {
            addDebugMessage(
              `Teaching contract progress: concept=${active.title}, ` +
              `next=${transition.state.teachingContractProgress[active.id]
                ?.nextTeachingPointIndex ?? 0}, total=${active.teaching.teachingPoints.length}`,
            );
          }
        }
        if (effects.assignNextBeat) {
          const assignment = assignNextTeachingBeat("", false);
          if (assignment) assignmentControl = buildTeachingBeatControl(lessonStateRef.current, assignment);
        }
        if (effects.clearRoadmapPending) {
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
        if (effects.recoveryRequired && !silentLessonRecoveryPendingRef.current) {
          silentLessonRecoveryPendingRef.current = true;
          requestSilentRecovery = true;
        }
      } else {
        const missingConcept = lessonCall?.kind === "invalid" && lessonCall.missingConcept;
        result = invalidLessonStateResult(queryLessonState(lessonStateRef.current), missingConcept);
        if (missingConcept && !silentLessonRecoveryPendingRef.current) {
          silentLessonRecoveryPendingRef.current = true;
          requestSilentRecovery = true;
        }
      }

      if (call.name === "lesson_state" && result && typeof result === "object") {
        result = decorateLessonStateResult(result, teachingPreferencesRef.current, assignmentControl);
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
      const recoveryFollowUp = decideSilentRecoveryFollowUp(recoveryQueryReceived, requestSilentRecovery);
      if (recoveryFollowUp === "complete") {
        silentLessonRecoveryPendingRef.current = false;
        addDebugMessage("Silent lesson-state recovery complete");
      } else if (recoveryFollowUp === "start") {
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
    // Does not resume teaching; see finishNodeReviewAndResume for that path.
    const plan = planExitNodeReview(nodeReviewRef.current);
    if (!plan) return;
    invalidateActiveTeachingBeat("node-review-exited");
    audioSession.player?.clear();
    nodeReviewRef.current = null;
    reviewResumeGuardRef.current = plan.reviewResumeGuard;
    setNodeReview(null);
    presentationBeatRef.current = plan.presentationBeat;
    setPresentationBeat(plan.presentationBeat);
    addDebugMessage(`Node review exited: concept=${plan.review.nodeId}`);
  };

  const startNodeReview = (node: LessonState["nodes"][string]) => {
    if (!canStartNodeReview(node, {
      lessonActive: lessonActiveRef.current,
      restartPending: restartPendingRef.current,
      closingActive: Boolean(closingTurnRef.current),
    })) return;
    invalidateActiveTeachingBeat("node-review-started");
    audioSession.player?.clear();
    const review = createNodeReview(node.id, presentationBeatRef.current);
    nodeReviewRef.current = review;
    reviewResumeGuardRef.current = false;
    setNodeReview(review);
    emitTestEvent("review.started", { nodeId: node.id });
    addDebugMessage(`Node review started: concept=${node.id}`);
    addReviewFlowDiagnostic("review-start");
    assignNextReviewBeat();
  };

  // Page-owned session lifecycle callbacks, named for the session controller. The
  // run/mounted guard on transport state changes stays at its startConversation call site.
  const onTransportStateChange = (state: LiveTransportState) => {
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
      audioSession.player?.clear();
    } else if (state === "active" && reviewRecoveryPendingRef.current) {
      reviewRecoveryPendingRef.current = false;
      addReviewFlowDiagnostic("recovery-complete", "recoveryIncludesReview=false");
    }
    setTransportState(state);
    setAiConnectionStatus(aiConnectionStatusForTransportState(state));
  };

  const canForwardMicrophone = () => !microphoneMutedRef.current && !closingTurnRef.current;

  const resetConversationForStart = () => {
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
  };

  const pauseLessonForStop = () => {
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
    return pauseLessonState(
      lessonStateRef.current,
      checkpointMatchesCurrent && currentBeforeStop
        ? { conceptId: currentBeforeStop.id, resumePoint: checkpoint }
        : undefined,
    );
  };

  const startConversation = async () => {
    emitTestEvent("lesson.start-requested", { lessonId: workspace.savedLessonIdRef.current });
    setUserError("");
    workspace.setPersistenceNotice("");
    if (
      workspace.learningSource?.status !== "ready" ||
      !workspace.preparedSourceRef.current
    ) {
      addDebugMessage("Source grounding failed: a ready learning source is required");
      return;
    }

    lessonStartupPendingRef.current = true;
    workspace.invalidatePendingHydration();

    const activeSource = workspace.learningSource;
    const preparedSource = workspace.preparedSourceRef.current;
    const lessonFocus = workspace.topicInput.trim();
    const lessonTopic = lessonFocus || `Main topics in ${activeSource.name}`;
    const continuingSavedLesson = workspace.resumeExistingLessonRef.current;
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
    workspace.setTopicInput(lessonFocus);
    resetConversationForStart();
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
    lessonStartupRunRef.current = run;
    setMicrophoneStatus("Requesting permission");
    setAiConnectionStatus("Not connected");
    addDebugMessage("Microphone permission requested");

    // Synchronous inside the click: prepare() resumes playback for iOS, then
    // getUserMedia starts in the same tick. Permission is awaited before playerReady.
    const { player, ready: playerReady } = audioSession.createPlayer();

    try {
      const stream = await audioSession.requestMicrophone();
      if (!isMountedRef.current || run !== conversationRunRef.current) {
        stream.getAudioTracks().forEach((track) => track.stop());
        await player.close();
        return;
      }

      audioSession.attachStream(stream, () => {
        if (!isMountedRef.current || run !== conversationRunRef.current) return;
        setUserError("The microphone stopped unexpectedly. Start the lesson again.");
        addDebugMessage("Microphone stream ended unexpectedly");
        conversationRunRef.current += 1;
        setMicrophoneStatus("Not active");
        setAiConnectionStatus("Not connected");
        updateLessonState((current) => ({ ...current, status: "idle" }));
        void disposeResources(false);
      });
      setMicrophoneStatus("Active");
      addDebugMessage("Microphone active");
      await playerReady;
      if (!isMountedRef.current || run !== conversationRunRef.current) return;

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
          onTransportStateChange(state);
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
      emitTestEvent("live.setup-complete");
      addDebugMessage("Live connection established");
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

      const microphoneStreamer = audioSession.createStreamer(stream, (chunk) => {
        if (run !== conversationRunRef.current || transportRef.current !== transport) return;
        const rms = pcm16Rms(chunk);
        noiseFloorRef.current += (rms - noiseFloorRef.current) * NOISE_FLOOR_SMOOTHING;
        if (rms >= Math.max(MIN_ACOUSTIC_RMS, noiseFloorRef.current * ACOUSTIC_ACTIVITY_MULTIPLIER)) {
          if (Date.now() - lastAcousticLogAtRef.current >= ACOUSTIC_LOG_COOLDOWN_MS) {
            lastAcousticLogAtRef.current = Date.now();
            addDebugMessage("Acoustic activity detected");
          }
        }
        if (canForwardMicrophone()) transport.sendAudio(chunk);
      });
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
      workspace.markLessonStarted();
      addDebugMessage("Lesson started");
      lessonActiveRef.current = true;
      lessonStartupPendingRef.current = false;
      beginIdleMonitoring();
      void audioSession.requestWakeLock();
      const startupImperative = planStartupImperative({
        wrapUp: lessonWrapUpRef.current,
        sessionStartMode,
      });
      if (startupImperative === "wrap-up") {
        addDebugMessage("Completed lesson restored in wrap-up");
        transportRef.current?.sendRealtimeInput({ text: LESSON_WRAP_UP_CONTROL });
      } else if (startupImperative === "persisted-resume") {
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
        assignNextTeachingBeat(buildNewLessonStartPrefix(tokenBody.source.name, lessonFocus));
      }
    } catch (error) {
      if (!isMountedRef.current || run !== conversationRunRef.current) return;

      if (isMicrophonePermissionDenied(error)) {
        setMicrophoneStatus("Permission denied");
        setUserError("Microphone permission was denied. Allow access in browser settings and try again.");
        addDebugMessage("Microphone permission denied");
        await disposeResources(false);
        return;
      }

      if (audioSession.hasMicrophoneStream) {
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
      if (lessonStartupRunRef.current === run) lessonStartupPendingRef.current = false;
    }
  };

  const stopConversation = async (reason?: "inactivity" | "confirmed") => {
    conversationRunRef.current += 1;
    const ownedDisposal = captureDisposalOwnership();
    invalidateActiveTeachingBeat("lesson-ended");
    audioSession.player?.clear();
    const hadMicrophone = audioSession.hasMicrophoneStream;
    const hadSession = Boolean(transportRef.current);
    const stoppedLessonState = pauseLessonForStop();
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
    await workspace.persistCurrentLesson(stoppedLessonState);
    await disposeResources(true, ownedDisposal);

    if (reason === "inactivity") {
      setUserError("The lesson ended after no response to the inactivity check.");
    } else if (reason === "confirmed") {
      setUserError("The lesson has ended.");
    }

    if (hadMicrophone) addDebugMessage("Microphone stopped");
    if (hadSession) addDebugMessage("Live connection closed");
  };

  const restartLesson = async () => {
    if (restartPendingRef.current || !workspace.resumeExistingLessonRef.current) return;
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
  const resumableLesson = workspace.savedLessons.find((lesson) => lesson.hasStarted);
  const hasRecentLessons = workspace.savedLessons.some((lesson) => lesson.id !== resumableLesson?.id);
  const selectedSavedLesson = workspace.savedLessonId
    ? workspace.savedLessons.find((lesson) => lesson.id === workspace.savedLessonId)
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
    await workspace.selectSavedLesson(id);
    setAppView("library");
    setLibraryView("lesson");
  };

  const startNewLessonFlow = () => {
    if (!workspace.prepareNewLesson()) return;
    setAppView("library");
    setLibraryView("new");
    addDebugMessage("New lesson setup opened");
  };

  const navigateProduct = (view: AppView) => {
    setAppView(view);
    if (view === "library") setLibraryView("index");
  };

  return (
    <main className={`page-shell${lessonActive ? " teaching-shell" : ""}`}>
      {!lessonActive && <AppNavigation activeView={appView} onNavigate={navigateProduct} />}
      <section className={`tutor-card${lessonActive ? " lesson-active" : ""}`}>
        <PreprocessingDiagnostic jobs={processingQueue.jobs} lessons={workspace.savedLessons} />
        {lessonActive ? <TeachingRoomHeader
          title={workspace.learningSource?.name || "Your lesson"}
          restartDisabled={restartPending || Boolean(closingTurnRef.current)}
          onRequestRestart={() => setRestartConfirmationOpen(true)}
          onEndLesson={() => void stopConversation()}
        /> : null}

        {lessonActive && restartConfirmationOpen && <RestartLessonConfirmation
          idPrefix="active-restart-lesson"
          restartPending={restartPending}
          onCancel={() => setRestartConfirmationOpen(false)}
          onRestart={() => void restartLesson()}
        />}
        {lessonActive && showLessonComplete && <div className="lesson-complete-transition" role="status"><span aria-hidden="true">✓</span><strong>Lesson complete</strong></div>}

        {!lessonActive && !workspace.persistenceHydrated && <div className="loading-state" role="status"><span className="loading-spinner" aria-hidden="true" /> Restoring your learning workspace…</div>}

        {!lessonActive && workspace.persistenceHydrated && appView === "home" && <section className="product-view home-view" aria-labelledby="page-title">
          <div className="home-heading"><p className="eyebrow">Home</p><h1 id="page-title">Continue learning</h1><p>Pick up where you left off or revisit a recent lesson.</p></div>
          {resumableLesson ? <section className="continue-card" aria-labelledby="continue-title"><div><p className="eyebrow">Up next</p><h2 id="continue-title">{resumableLesson.title}</h2><p>{lessonProgress(resumableLesson)}% complete{resumableLesson.lessonState.currentNodeId && resumableLesson.lessonState.nodes[resumableLesson.lessonState.currentNodeId]?.title ? ` · ${resumableLesson.lessonState.nodes[resumableLesson.lessonState.currentNodeId].title}` : ""}</p></div><button className="button-primary" type="button" disabled={workspace.lessonLibraryBusyId !== null} onClick={() => void openLesson(resumableLesson.id)}>Continue</button></section> : <section className="continue-empty" aria-label="Continue learning"><h2>Ready for your next lesson?</h2><p>Your most recent learning will appear here once you begin.</p></section>}
          {hasRecentLessons && <RecentLessons lessons={workspace.savedLessons.slice(0, 5)} activeLessonId={resumableLesson?.id ?? null} busyLessonId={workspace.lessonLibraryBusyId} onContinue={(id) => void openLesson(id)} onDelete={(saved) => void workspace.requestDeleteSavedLesson(saved)} onNewLesson={startNewLessonFlow} />}
          <ProcessingQueue jobs={processingQueue.jobs} lessonActive={lessonActive} onOpen={(id) => void openLesson(id)} onRetry={(job) => void processingQueue.retry(job)} onReselect={(job, files) => void processingQueue.reselect(job, files).catch((error) => workspace.setPersistenceNotice(error instanceof Error ? error.message : "Those files did not match this lesson."))} onDiscard={(job) => void processingQueue.discard(job).catch(() => workspace.setPersistenceNotice("The lesson could not be discarded safely."))} />
          <div className="home-create-footer"><button className="button-secondary" type="button" onClick={startNewLessonFlow}>+ Add New Lesson</button></div>
        </section>}

        <div hidden={lessonActive || !workspace.persistenceHydrated || appView !== "library" || libraryView !== "index"}>
          <LessonLibrary lessons={workspace.savedLessons} processingJobs={processingQueue.jobs} busyLessonId={workspace.lessonLibraryBusyId} onOpen={(lesson) => void openLesson(lesson.id)} onDelete={(lesson) => void workspace.requestDeleteSavedLesson(lesson)} onNewLesson={startNewLessonFlow} />
          {workspace.persistenceNotice && !isRedundantPreparationNotice(workspace.persistenceNotice) && <p className="session-notice" role="status">{workspace.persistenceNotice}</p>}
        </div>

        <div className="product-view profile-view" hidden={lessonActive || !workspace.persistenceHydrated || appView !== "profile"}>
          <div className="view-heading"><div><p className="eyebrow">Your account</p><h1>Profile</h1><p>Manage account access and how your tutor teaches.</p></div></div>
          <CloudAccount
            onDebug={addDebugMessage}
            onAuthResolved={(user: User | null) => {
              const nextUserId = user?.id ?? null;
              workspace.handleAuthResolved(nextUserId);
              setCloudUserId(nextUserId);
              setCloudAuthReady(true);
            }}
            onBeforeSignOut={async () => {
              await workspace.persistCurrentLesson();
            }}
            syncState={workspace.cloudSyncState}
            cloudLessonCount={workspace.cloudLessonCount}
            localOnlyLessonCount={workspace.localOnlyLessonCount}
            onSyncNow={() => void workspace.syncCurrentAccount()}
            onImportLocalLessons={() => void workspace.importLocalLessons()}
          />
          <AppearanceSettings appearance={appearance} onChange={setAppearance} />
          <section className="teaching-style" aria-labelledby="profile-preferences-title"><p className="eyebrow">Teaching preferences</p><h2 id="profile-preferences-title">Make lessons feel right for you</h2><TeachingStyleControls preferences={teachingPreferences} onChange={(update) => applyAuthoritativeTeachingPreferences({ ...teachingPreferencesRef.current, ...update })} /></section>
        </div>

        {!lessonActive && workspace.persistenceHydrated && appView === "library" && libraryView === "new" && <section className="product-view new-lesson-view" aria-labelledby="new-lesson-title">
          <button className="back-button" type="button" onClick={() => setLibraryView("index")}>← Back to Library</button>
          <div className="focused-view-heading"><p className="eyebrow">New lesson</p><h1 id="new-lesson-title">Create New Lesson</h1><p>Turn your learning materials into a focused voice lesson.</p></div>
          <LearningSourceUpload
            disabled={!workspace.persistenceHydrated}
            cloudUserId={cloudUserId}
            onQueueBundle={async (sources, files, title) => {
              await processingQueue.enqueue(sources, files, title);
              setLibraryView("index");
              workspace.setPersistenceNotice("");
            }}
            onDebug={addDebugMessage}
          />
          {userError && <p className="session-error" role="alert">{userError}</p>}
        </section>}

        {!lessonActive && workspace.persistenceHydrated && appView === "library" && libraryView === "lesson" && <LessonDetail
          lesson={selectedSavedLesson}
          topicInput={workspace.topicInput}
          requestingPermission={requestingPermission}
          learningSourceReady={workspace.learningSource?.status === "ready"}
          resumeExistingLesson={workspace.resumeExistingLesson}
          restartable={selectedLessonRestartable}
          restartPending={restartPending}
          restartConfirmationOpen={restartConfirmationOpen}
          libraryBusy={workspace.lessonLibraryBusyId !== null}
          userError={userError}
          onBack={() => setLibraryView("index")}
          onTopicInputChange={workspace.setTopicInput}
          onStart={startConversation}
          onRequestRestart={() => setRestartConfirmationOpen(true)}
          onCancelRestart={() => setRestartConfirmationOpen(false)}
          onRestart={() => void restartLesson()}
          onDelete={(lesson) => void workspace.requestDeleteSavedLesson(lesson)}
        />}

        {lessonActive && <div className="active-learning-grid">
          <SourceVisual
            conceptId={presentedConcept?.id ?? null}
            conceptTitle={presentedConcept?.title}
            contract={presentedConcept?.teaching}
            teachingPointIndexes={presentedTeachingPointIndexes}
            presentationKey={presentationKey}
            sources={workspace.lessonSources}
            lessonId={workspace.savedLessonId}
            cloudOwnerId={cloudUserId}
            authReady={cloudAuthReady}
            onDebug={addDebugMessage}
          />
          <div className="active-learning-sidebar">
          {workspace.learningSource && <ActiveLessonSummary
            sourceName={workspace.learningSource.name}
            conceptTitle={currentConcept?.title}
            teachingPreferences={teachingPreferences}
          />}

          <ActiveTeachingPreferences
            preferences={{ ...teachingPreferences, ...pendingTeachingPreferences }}
            updatePending={preferenceUpdatePending}
            desktopExpanded={desktopTeachingStyleExpanded}
            mobileExpanded={mobileTeachingStyleExpanded}
            onToggleDesktopExpanded={() => setDesktopTeachingStyleExpanded((expanded) => !expanded)}
            onToggleMobileExpanded={() => setMobileTeachingStyleExpanded((expanded) => !expanded)}
            onChange={changeActiveTeachingPreference}
          />

          <ConversationTranscript
            learnerReply={latestLearnerReply}
            tutorTranscript={visibleTutorTranscript}
            mobileExpanded={mobileTranscriptExpanded}
            onToggleMobileExpanded={() => setMobileTranscriptExpanded((expanded) => !expanded)}
          />
          </div>
        </div>}

        {lessonActive && userError && <p className="session-error" role="alert">{userError}</p>}
        {lessonActive && workspace.persistenceNotice && !isRedundantPreparationNotice(workspace.persistenceNotice) && <p className="session-notice" role="status">{workspace.persistenceNotice}</p>}

        {lessonActive && <div className="teaching-controls-stack">
        {lessonActive && <ConversationStatusRow
          microphoneActive={microphoneActive}
          microphoneMuted={microphoneMuted}
          aiConnected={aiConnected}
          farewellFinishing={farewellFinishing}
          transportState={transportState}
          onToggleMute={toggleMicrophoneMute}
        />}

        {lessonActive && (
          <LessonResponseControls
            quickResponseFeedback={quickResponseFeedback}
            typedReply={typedReply}
            typedReplyInputRef={typedReplyInputRef}
            onQuickResponse={sendQuickResponse}
            onTypedReplyChange={setTypedReply}
            onSubmitTypedReply={submitTypedReply}
          />
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
            (!microphoneActive && (!workspace.persistenceHydrated || workspace.learningSource?.status !== "ready"))
          }
        >
          {microphoneActive
            ? "End Lesson"
            : requestingPermission
              ? "Requesting Permission..."
              : workspace.resumeExistingLesson
                ? "Continue Lesson"
                : "Start Conversation"}
        </button>}

        {process.env.NODE_ENV === "development" && <DeveloperDebugPanel
          lessonState={lessonState}
          lessonSources={workspace.lessonSources}
          transportState={transportState}
          engagementState={engagementState}
          lessonActive={lessonActive}
          debugMessages={debugMessages}
          onForceSafeRollover={() => transportRef.current?.requestSafeRolloverForTest()}
          onForceImmediateRollover={() => transportRef.current?.requestImmediateRolloverForTest()}
          onTestRecoveryFallback={() => transportRef.current?.requestImmediateRolloverForTest(true)}
          onTestIdleConfirmation={requestIdleConfirmation}
          onTestInvalidLessonId={() => transportRef.current?.sendRealtimeInput({
            text: "[[APP_CONTROL:TEST_INVALID_ID]]",
          })}
        />}

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
