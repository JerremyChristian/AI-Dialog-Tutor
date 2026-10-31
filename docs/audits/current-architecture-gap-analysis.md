# AI Teacher Project — Current Architecture & Gap Analysis

> Static current-state audit. Repository implementation is the source of truth. Existing application/source/config changes were inspected but not modified by this audit. Development diagnostics are explicitly separated from production behavior.

## 1. Executive Summary

**IMPLEMENTED — PRODUCTION:** The proof of concept supports PDF/plain-text lesson creation, a local lesson library, optional Supabase cloud storage, a Gemini Live spoken tutor, typed fallback input, interruption/barge-in handling, roadmap navigation, review mode, source-page visualisation, teaching preferences, and resumable teaching-point coverage. The strongest design is the explicit audio-drain/beat-commit protocol: interrupted or stale speech does not advance canonical progress (`app/page.tsx — ActiveTeachingBeat; lib/teaching-delivery.ts — isBeatCommitValid`).

**PARTIALLY IMPLEMENTED:** Source processing, cloud synchronization, queue recovery, grounding, reconnect behavior, and user-facing diagnostics work as POC paths but remain browser-led and coarse-grained. Generated references are structurally validated, not fact-checked. Coverage means planned tutor delivery, not learner understanding.

**IMPLEMENTED — DEVELOPMENT/DIAGNOSTIC ONLY:** Source probes, token counting, page probes, compact extraction, single-page compact extraction, and split Stage 1/Stage 2 experiments exist behind development gating. They are not production preprocessing, do not persist artifacts, and do not create lessons (`components/preprocessing-diagnostic.tsx:79-147`; `app/api/lesson-sources/route.ts — diagnosticStage branches`).

**NOT IMPLEMENTED / FUTURE:** Deterministic PDF extraction/OCR, retrieval-backed citation verification, durable server processing jobs, append-only transcript history, assessment evidence, learner mastery, misconception tracking, field-level sync, and a production observability system.

The highest-priority next step is to test and instrument interruption/reconnect sequences while preserving the current state machine. Next, add bounded source artifacts and retrieval, then add transparent learner evidence. A larger database or service decomposition should follow measured need rather than precede it.

## 2. Product Vision

The intended product teaches uploaded course material through natural spoken conversation. A learner should be able to talk while the tutor is speaking; the tutor should stop immediately, answer the interruption, remember the uncompleted explanation, and resume at a useful point. The longer-term vision includes source-grounded teaching, recovery across sessions/devices, and simple evidence-based mastery tracking.

The current implementation protects the first two priorities—realtime conversation and interruption—better than the later priorities. It has a curriculum contract and delivery coverage model, but it does not yet know whether the learner understood a concept. That distinction is central: a node marked `taught` means delivery committed, not mastery.

## 3. What the App Currently Does

1. The learner chooses up to the supported number of PDF/TXT sources, assigns source roles, and optionally signs in.
2. The browser creates a processing job and sends source descriptors plus files to a server route. The route sends the complete source bundle to Gemini, validates structured output, normalizes a lesson tree, and returns generated curriculum.
3. The browser creates a schema-versioned `SavedLesson`, stores it in IndexedDB, and optionally uploads source objects/snapshots to Supabase.
4. The learner opens a lesson roadmap, starts a live session, grants microphone permission, and receives Gemini Live audio.
5. The tutor teaches ordered presentation beats. Learner speech or typed input can interrupt; the active audio batch is cancelled and the uncommitted beat remains due.
6. The learner can ask questions, navigate, skip, change explanation depth/speaking speed, inspect source pages, review a node, pause, resume, or complete the lesson.
7. Local state is periodically saved; authenticated snapshots can be reconciled with cloud state. A full transcript is not retained.

Evidence: `app/page.tsx:1-100` imports the complete client surface; `lib/local-persistence.ts — SavedLesson/IndexedDB`; `lib/use-lesson-processing-queue.ts — queue lifecycle`; `lib/lesson-state.ts — state transitions`.

## 4. Complete User Journey

**Create:** Upload UI accepts only `application/pdf` and `text/plain`; source metadata includes ID, name, size, role, and storage status. The UI shows processing progress and errors. Authenticated users can stage private objects; anonymous users depend on in-memory browser files.

**Prepare:** A browser queue moves jobs through `queued`, `uploading`, `processing`, `saving`, `ready`, `error`, or `needs-source`. The production route may try the configured model fallback chain. The result is rejected if required structured text/tree artifacts are unusable.

**Open:** The library loads a parsed `SavedLesson`, reconstructs runtime nodes and coverage, and selects the current concept. Incompatible schema snapshots are rejected rather than partially migrated.

**Teach:** Start requests an ephemeral Live token, opens a WebSocket, starts microphone PCM capture and audio playback, sends lesson instructions/tools, and begins the current beat. The tutor can call lesson-state/navigation/session tools; application code remains authoritative for progress.

**Interrupt:** Acoustic activity, meaningful learner transcript, or typed input can trigger interruption. The app registers it once per interruption epoch, cancels playback, stores a bounded resume context, and changes state to `interrupted`. Clarification does not advance coverage. A continuation request restarts the uncommitted beat; an accepted naturally drained beat commits.

**Navigate/review:** Roadmap navigation can pause active delivery and select another node. Review starts a node at teaching-point index zero with a temporary cursor; it restores the prior presentation beat and does not mutate canonical progress.

**Finish/recover:** Completion waits for a farewell audio drain where applicable, marks the plan complete only after all teachable nodes are delivered, and persists the snapshot. Refresh/reopen recovers concept and teaching-point progress but not exact audio position or a complete conversation log. Missing local files produce `needs-source` recovery instead of silent processing.

## 5. High-Level System Architecture

```text
Browser / Next.js client
  ├─ upload + IndexedDB jobs/snapshots
  ├─ lesson state, coverage, interruption and review runtime
  ├─ AudioWorklet microphone + Web Audio PCM playback
  └─ Gemini Live WebSocket using ephemeral token
       │
       ├─ /api/gemini-token       server token minting
       ├─ /api/lesson-sources    production + diagnostic preprocessing
       ├─ /api/pdf-source        legacy PDF preprocessing path
       ├─ /api/text-outline      legacy text outline path
       └─ Supabase               optional auth, snapshots, source objects
```

The browser owns active runtime truth; Next.js routes hold the Gemini API key and perform model calls; Supabase is optional persistence. There is no server-side lesson worker or authoritative realtime session service. This is appropriate for a small POC but concentrates races and durability concerns in one client page.

## 6. Frontend Architecture

**IMPLEMENTED — PRODUCTION:** `app/page.tsx` is a client component coordinating view state, microphone lifecycle, transport, transcripts, lesson state, persistence, cloud sync, queue callbacks, preferences, navigation, review, and completion. Components split visible concerns: `LearningSourceUpload`, `ProcessingQueue`, `LessonLibrary`, `LessonRoadmap`, `SourceVisual`, `RecentLessons`, `CloudAccount`, and `AppNavigation`.

Pure-ish domain helpers are separated into `lib/lesson-state.ts`, `lib/teaching-delivery.ts`, `lib/teaching-preferences.ts`, `lib/local-persistence.ts`, and `lib/cloud-sync.ts`. Runtime refs/generation epochs prevent stale callbacks from committing progress.

**Gap:** The page remains a large orchestration boundary with many refs and asynchronous effects. Transport, audio, persistence, and product state are coupled through callbacks. It is testable only with substantial browser mocking; extracting every abstraction now would be premature, but the interruption state machine should gain isolated tests first.

Evidence: `app/page.tsx:128-165` runtime records; `app/page.tsx:350-400` refs/state; `components/*.tsx` visible feature boundaries.

## 7. Backend/API Architecture

| Route | Status and responsibility |
|---|---|
| `/api/lesson-sources` | **IMPLEMENTED — PRODUCTION:** validates descriptors/files, optionally reads private Supabase objects, calls Gemini structured generation, normalizes tree, classifies errors/fallbacks. Also hosts development-only diagnostic stages. |
| `/api/gemini-token` | **IMPLEMENTED — PRODUCTION:** checks server API key and mints an ephemeral Live token for the configured Live model; the provider key remains server-side (`app/api/gemini-token/route.ts`). |
| `/api/pdf-source` | **PARTIALLY IMPLEMENTED / legacy:** separate Gemini PDF preprocessing route with its own model/fallback behavior and request-abort handling; not the primary current queue path. |
| `/api/text-outline` | **PARTIALLY IMPLEMENTED / legacy:** Gemini text outline endpoint; not deterministic extraction. |
| `/api/cloud/status` | **IMPLEMENTED — PRODUCTION:** cloud configuration/status boundary. |
| `/auth/confirm` | **IMPLEMENTED — PRODUCTION:** Supabase auth confirmation callback. |
| `/api/lesson-sources` diagnostics | **IMPLEMENTED — DEVELOPMENT/DIAGNOSTIC ONLY:** gated by development environment and never persisted as production artifacts. |

Routes use Node runtime for provider/file work. There is no API for lesson turns, mastery events, normalized lesson nodes, or server-owned processing jobs.

## 8. Source Processing Pipeline

**Production path:** descriptors and files are validated for supported type, count, names, IDs, sizes, and bundle limits (`lib/learning-source.ts`; `app/api/lesson-sources/route.ts:168-185`). The complete original PDF/TXT bundle is sent to one Gemini request with a structured schema containing `lessonTitle`, `structuredSource`, and a flat tree of structural nodes and atomic contracts (`app/api/lesson-sources/route.ts:198-229`, prompt near the generation call). The server normalizes IDs, hierarchy, contracts, source references, delivery units, and beats (`lib/lesson-outline.ts`). The browser persists the normalized result.

**Important limitation:** despite page-oriented diagnostic names, production does not locally split PDFs, extract text, OCR, or verify page existence. Model-generated `structuredSource` is only required to be non-empty. There is no deterministic extraction artifact, content hash cache, retrieval index, or source-to-claim verifier.

**Supported:** PDF and plain text only. **Unsupported/not implemented:** DOCX, PPTX, HTML/web pages, images as first-class sources, audio/video, scanned-PDF OCR, tables/figures extraction, handwriting, and arbitrary archives. A PDF renderer exists for visual display, not preprocessing extraction (`components/source-visual.tsx`; `pdfjs-dist` usage).

**Diagnostic split:** Stage 1 creates an in-memory source artifact; Stage 2 designs a lesson from that artifact. The artifact is held in React state and is not passed through production queue persistence, not cached, and not used by `buildLesson`.

## 9. Lesson Data Model

The canonical `SavedLesson` is schema version 1 and combines generated curriculum, source metadata, mutable delivery state, preferences, timestamps, ownership, and sync metadata:

```ts
SavedLesson = {
  schemaVersion: 1; id; title; lessonFocus; hasStarted;
  source: { metadata: LearningSource; prepared: PreparedLearningSource };
  sources: LessonSource[]; lessonState: LessonState;
  recentTeachingContext: RecentTeachingContextEntry[];
  teachingPreferences: TeachingPreferences; createdAt; updatedAt;
  cloudOwnerId?; cloudSync?: CloudSyncMetadata;
}
```

`PreparedLearningSource` holds generated structured text and a flat `LessonTreeItem[]`. Leaves contain `AtomicTeachingContract`: objective, 3–7 bounded teaching points, completion criteria, pedagogical type, importance, optional key terms/notation/confidence, and source references. `TeachingDeliveryUnit[]` partition points into `TeachingPresentationBeat[]`.

`LessonState` holds status (`idle`, `teaching`, `interrupted`, `resolving-interruption`, `resuming`, `completed`), current node, ordered node map, coverage status, per-contract `nextTeachingPointIndex`, resume text, interruption count, and latest user/assistant transcripts. `RecentTeachingContextEntry` is capped at three bounded excerpts. Full turn history, assessment evidence, misconceptions, and mastery are absent.

Parser/normalizer rejects incompatible snapshots and normalizes legacy references, but there is no multi-version migration chain. Mixed-source MIME type is copied from the first source. The snapshot is convenient for a POC but mixes immutable curriculum, mutable runtime, preferences, and infrastructure metadata.

Evidence: `lib/local-persistence.ts — SavedLesson, parseSavedLesson, parseLessonState`; `lib/lesson-outline.ts — normalizeLessonTree`; `lib/lesson-state.ts — LessonState`; `lib/teaching-delivery.ts — delivery types`.

## 10. Realtime Teaching Runtime

Startup is browser-led: request microphone permission, obtain an ephemeral token from `/api/gemini-token`, create `LiveTransportManager`, open the Gemini Live WebSocket, create `MicrophonePcmStreamer` and `PcmAudioPlayer`, install message/tool callbacks, seed authoritative client-content history, then stream PCM input. `lib/gemini-live-websocket.ts` owns WebSocket setup and realtime input; `lib/realtime-audio.ts` owns AudioWorklet capture and Web Audio scheduling.

The exact startup protocol is:

1. The socket sends `setup` with the Live model, AUDIO response modality/voice, audio transcriptions, session resumption, sliding-window compression, tools, and `historyConfig.initialHistoryInClientContent: true` (`lib/gemini-live-websocket.ts:26-46`).
2. `connect()` resolves only on the first `setupComplete`; a local `setupComplete` boolean prevents a duplicate setup event from resolving startup or being forwarded as a normal model message (`lib/gemini-live-websocket.ts:124-151`). Setup errors/close before that event reject startup.
3. After setup, the client sends one `clientContent` user turn containing the source identity, lesson tree, initial coverage, and complete generated source text, with `turnComplete: true` (`lib/gemini-live-websocket.ts:187-217`). Because initial history is configured for client content, this completion marker finalizes history without triggering generation.
4. Only after source seeding does the page start the microphone streamer and then send the first `realtimeInput` text imperative through `assignNextTeachingBeat` (`app/page.tsx:2507-2577`, `app/page.tsx:544-604`). This is proactive generation: the app assigns the first presentation beat and asks Gemini to speak it; it does not wait for a learner utterance.
5. On persisted resume, the same authoritative client-content pattern sends recovery source/state, coverage, contract cursor, resume context, and preferences (`app/page.tsx:2518-2552`), followed by the persisted-resume control. The application lesson state remains authoritative; model history is context, not progress truth.

Fresh-socket recovery requests a replacement token, opens a new socket with the same system instruction, calls `seedFreshRecovery` with current authoritative coverage/contract progress/resume point/preferences, flushes queued audio/learner text, and resumes. If a resumable handle exists, the manager first attempts `sessionResumption`; only failure falls back to this fresh-session path (`lib/live-transport-manager.ts:509-606`). Handoff state prevents duplicate rollover/recovery, `activeSocket` identity gates messages, and `GeminiLiveWebSocket.connect` has the setup duplicate guard above.

Each active beat records concept, mode (`lesson`/`review`), generation epoch, generation completion, natural audio drain, and cancellation. Audio is scheduled in batches. A provider-complete signal alone cannot commit; `isBeatCommitValid` additionally requires current concept, live lesson, no cancellation, generation completion, and natural drain. Typed learner input follows the same interruption path.

The tutor has application tools for state query/navigation/session control, but the app—not model prose—commits coverage. Reconnect continuity distinguishes transport rollover from a new session and instructs the tutor not to greet or restart merely because transport changed (`lib/lesson-state.ts — PERSISTED_LESSON_RESUME_CONTROL`).

Known constraints are browser autoplay/microphone permissions, AudioWorklet support, mobile background suspension, WebSocket/provider timing races, and no exact word-level replay position. An interrupted beat restarts from its beginning.

## 11. Coverage & Progress Model

Coverage statuses are `not-started → teaching → partial → taught`, with `skipped` as a separate outcome. Structural parent status is derived from descendants. A leaf's `TeachingContractProgress.nextTeachingPointIndex` identifies the next required point. A beat advances this cursor only after model generation completed, audio drained naturally, the assignment was not cancelled, and concept/generation identity is still current (`lib/teaching-delivery.ts:1-160`; `lib/lesson-state.ts — commitDeliveredTeachingBeat`).

This is delivery coverage, not mastery. Optional/core importance does not alter progress weighting. Clarifications, recaps, examples, review, and conversational responses do not advance the canonical cursor. An interrupted beat restarts, preventing partial audio from being counted as complete. Lesson completion means all canonical teachable leaves are `taught`; it does not mean the learner can recall or apply them.

## 12. Review Mode

Review is **IMPLEMENTED — PRODUCTION** as a temporary overlay. `NodeReviewState` records a node, temporary teaching-point index, return presentation beat, and completion. Review resolves the same delivery units/beats from index zero, but commit validation advances only the review cursor. On exit it restores the normal lesson context; canonical coverage and contract progress remain unchanged (`app/page.tsx:139-144`; review handlers in `app/page.tsx`).

This is a good isolation choice, but review is ephemeral: refresh, reconnect, or a second tab cannot restore a review session. There is no learner-generated quiz, spaced repetition, review history, or evidence that review improved mastery.

## 13. Source Visual / Grounding

`SourceVisual` selects a PDF page or text section from the active teaching point first, then contract/node references, and renders the original PDF page or source context (`components/source-visual.tsx`; `lib/source-visual.ts`). It gives the learner a useful visual anchor and supports one-based physical PDF page references.

**Exact spoken-page attribution limitation:** the app can display the page associated with generated metadata, but it does not prove that the spoken sentence came from that page. The model generates references; server normalization removes unknown source IDs, malformed pages, and duplicates, but does not verify page existence or entailment. There is no extracted passage, quote span, retrieval score, or per-sentence citation. A displayed page is therefore provenance/navigation, not a verified citation.

The live tutor receives generated lesson context and selected references rather than independently retrieved source chunks. This is source-aware prompting, not strict retrieval-augmented generation. Unsupported model knowledge may appear alongside source-looking metadata.

## 14. Persistence & Cloud Architecture

**Local:** IndexedDB stores `savedLessons`, active lesson IDs, and processing jobs (`lib/local-persistence.ts`). `SavedLesson` is a version-1 JSON aggregate. Browser `File` objects are not durable; local queued work can become `needs-source` after reload. Snapshot parsing is strict and rejects incompatible structures; no migration chain exists for multiple historical schema versions.

**Cloud:** Authenticated lessons use Supabase `public.lessons.snapshot` plus metadata and `public.lesson_sources` rows; original objects reside in a private `lesson-sources` bucket. RLS uses `auth.uid()` ownership checks and storage folder ownership (`supabase/migrations/20260903000000_cloud_foundation.sql:4-14,17-39,57-139`).

**Sync:** `lib/cloud-sync.ts` reconciles whole snapshots using timestamps/content signatures. It detects conflicts but has no field-level merge, operation log, version vector, or multi-device queue. Local and cloud records can overwrite at aggregate granularity. There are no normalized cloud rows for nodes, beats, coverage events, transcript turns, review sessions, or mastery evidence.

## 15. Processing Queue

`useLessonProcessingQueue` is a browser-orchestrated state machine. It persists job metadata and generation counters, uploads cloud source objects when applicable, calls the processing route, validates the response, saves the lesson, and reports `ready`/`error`/`needs-source` (`lib/use-lesson-processing-queue.ts`). There is exactly one upload worker and one preprocessing worker per browser/owner scope: `uploadRunningRef` and `processingRunningRef` gate the two effects (`lib/use-lesson-processing-queue.ts:53-61,180-195,290-316`). Source uploads within one job are sequential (`lib/use-lesson-processing-queue.ts:197-249`).

The browser sets a 315,000 ms (315 s) abort timer around preprocessing fetches (`lib/use-lesson-processing-queue.ts:343-364`). The production route’s Gemini SDK timeout is 180,000 ms (180 s), its operation abort timeout is 300,000 ms (300 s), and Next.js declares `maxDuration = 300` (`app/api/lesson-sources/route.ts:21-28,785-850`). These are browser JavaScript workers/effects, not service-worker or server workers: the page’s JavaScript must remain alive for upload and preprocessing workers to make progress. Closing/suspending the page can stop them; persisted metadata supports recovery/reselection, not background execution.

There is no hard queue-count limit and no hard lesson-count/account-wide limit in the current queue or persistence code. Limits are per enqueued lesson/job; queued jobs are selected one at a time and remain in IndexedDB until ready, error, deletion, or recovery.

The queue is acceptable for one active browser. Closing the tab can lose raw files and an in-flight request. Large bundles remain one provider operation, so a failure repeats the whole operation. A future server job should be justified by observed loss/latency, not added merely for architectural fashion.

## 16. Authentication & Security

The Gemini API key is read only in server routes. `/api/gemini-token` issues an ephemeral Live token so browser WebSocket traffic does not expose the provider key (`app/api/gemini-token/route.ts`). Supabase auth uses server/client helpers, callback confirmation, and optional sign-in. Database grants exclude `anon`; lessons and source rows have owner-based RLS; storage paths are scoped by first path segment to the authenticated user (`supabase/migrations/20260903000000_cloud_foundation.sql:57-139`).

The browser necessarily holds source bytes, generated curriculum, transcripts, and ephemeral credentials and is not a trust boundary. Server validation checks IDs, sizes, MIME types, and snapshot shape, but there is no documented rate limit, per-user cost budget, malware scan, content moderation policy, or server audit log. Provider retention, deletion, consent, and sensitive/copyrighted material policy are not represented in the product.

## 17. Current Limits & Quotas

The exact current lesson/source limits are:

- Maximum sources per lesson: **6** (`MAX_LESSON_SOURCES = 6`).
- Maximum bytes per source: **20 MiB** (`MAX_SOURCE_BYTES = 20 * 1024 * 1024`).
- Signed-out/new-local lesson bundle: **4 MiB** (`MAX_SOURCE_BUNDLE_BYTES`).
- Signed-in/cloud-staged lesson bundle: **40 MiB** (`MAX_CLOUD_SOURCE_BUNDLE_BYTES`).
- These bundle and source limits are checked for the sources in each newly enqueued lesson/job (`lib/use-lesson-processing-queue.ts:146-169`; `app/api/lesson-sources/route.ts:546-551`). They are **not cumulative/account-wide** limits; no account aggregate byte calculation exists.
- Upload worker concurrency: **1** per browser/owner queue; uploads within a job are sequential (`lib/use-lesson-processing-queue.ts:57,180-249`).
- Preprocessing worker concurrency: **1** per browser/owner queue (`lib/use-lesson-processing-queue.ts:58,290-316`).
- Browser processing timeout: **315,000 ms / 315 seconds** abort timer (`lib/use-lesson-processing-queue.ts:343-347`).
- Gemini provider/SDK timeout: **180,000 ms / 180 seconds** (`app/api/lesson-sources/route.ts:25-28,786`).
- Route/max operation duration: **300,000 ms / 300 seconds** for the abort operation timer and Next.js `maxDuration = 300` (`app/api/lesson-sources/route.ts:21-28,785-791`).

There is **no hard lesson-count limit** and **no hard queue-count limit** in the current code. IndexedDB can contain multiple jobs/lessons subject to browser storage, but the active queue workers process one upload and one preprocessing job at a time. Supabase’s bucket also declares a 20 MiB per-object limit (`supabase/migrations/20260903000000_cloud_foundation.sql:95-106`), consistent with the per-source cap. Structured contracts cap teaching points/criteria and recent context is capped at three excerpts.

The processing route uses one SDK attempt per model and a finite fallback list. There is no per-user daily quota, token budget, or cost ceiling in the application; shared provider quota remains a material operational risk.

## 18. Gemini Integration & Model Strategy

The active production `/api/lesson-sources` preprocessing order is exactly: **`gemini-3.6-flash` → `gemini-3.7-flash` → `gemini-3.5-flash`** (`app/api/lesson-sources/route.ts:25-28`). It uses low thinking, structured JSON output, a 180-second model timeout, one SDK attempt per model, and advances only on a classified retryable failure. The Live tutor uses `GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview"` (`lib/lesson-state.ts`).

The legacy `/api/pdf-source` route is a different pool: **`gemini-3.6-flash` → `gemini-3.7-flash` → `gemini-3.5-flash` → `gemini-3.5-flash-lite`** (`app/api/pdf-source/route.ts:14-21`). The legacy pool must not be reported as the active `/api/lesson-sources` production order.

Error classification distinguishes quota/exhaustion (`429`, `RESOURCE_EXHAUSTED`) from temporary overload (`503`, `UNAVAILABLE`) and timeout/cancellation (`499`, abort, deadline), returning retryability and safe provider metadata (`app/api/lesson-sources/route.ts:46-61,63-161`). A 429 is a shared quota/cost signal and should not be blindly retried forever; a 503 is transient availability and can reasonably try the next model. Current fallback is request-scoped and has no global circuit breaker or budget governor.

Development diagnostics let an operator manually choose one model and deliberately avoid the production fallback chain. They are useful for comparing model behavior but do not establish a production model guarantee.

## 19. Error Handling & Observability

Routes return normalized error codes such as quota exhausted, temporary unavailable, processing timeout, or unknown; provider messages are sanitized for keys/tokens and selected status/request/quota fields are logged (`app/api/lesson-sources/route.ts:63-161`). The client maps microphone DOM exceptions to useful messages, displays queue/connection errors, and exposes development debug messages.

The user-facing distinction between 429 and 503 is not yet a complete recovery UX: both can surface as processing failure/retry guidance, while quota exhaustion requires waiting/account action and overload usually merits a short retry. Live connection/audio failures have status and fallback controls but no durable incident record.

There is no production telemetry pipeline, correlation ID spanning queue/provider/WebSocket/audio, metrics dashboard, sampled event log, or privacy-conscious trace store. Static logs report elapsed time, model, token usage when available, node counts, fallback, and provider details, but cannot establish end-to-end interruption latency or commit correctness at population scale.

## 20. Development Diagnostic Tooling

**IMPLEMENTED — DEVELOPMENT/DIAGNOSTIC ONLY:** When `NODE_ENV === "development"` and `?enable=1`, `PreprocessingDiagnostic` exposes source probe, input-token count, page probe, single-page compact extraction, compact source extraction, Stage 1 source artifact, and Stage 2 artifact-only lesson design (`components/preprocessing-diagnostic.tsx:79-147`). The route returns 404 for diagnostic-stage requests outside development.

Single-page and compact diagnostics still retrieve/send the complete original source bundle and ask Gemini to constrain output; they do not locally split a PDF. Stage 1 creates a versioned artifact in component state; Stage 2 consumes it without original bytes. Results report elapsed time, token/error metadata, artifact counts, and tree normalization measurements but are not persisted, passed into production `buildLesson`, or used for coverage.

**NOT IMPLEMENTED:** deterministic extraction POC, OCR, durable compact artifacts, chunk index, or production staged preprocessing. These experiments must not be described as production architecture.

## 21. UI / Responsive Design

The UI is organized as a home/library/new-lesson flow with roadmap, lesson transcript, source visual, controls, queue, cloud account, and recent lessons. CSS provides light/dark/system appearance, responsive layouts, touch-sized controls, mobile transcript expansion, compact navigation, and an install prompt. The processing queue and teaching controls remain visible enough to expose state rather than hiding all work behind a spinner (`app/page.tsx`; `app/globals.css:126-174` and responsive rules later in the file).

Mobile and tablet behavior is constrained by microphone permission, AudioWorklet/autoplay, screen/background suspension, and narrow transcript/source layouts. The app logs when backgrounding may suspend audio, but it cannot guarantee uninterrupted teaching. There is no native mobile shell, offline provider mode, or deterministic speech-rate transform; speaking speed is a prompt preference. Accessibility appears considered in labels/pressed states and keyboard controls, but there is no automated accessibility audit.

## 22. Current Product Differentiation

The strongest present differentiator is the combination of spoken tutoring and explicit interruption recovery: the learner can barge in without falsely marking a concept complete, then resume a bounded teaching beat. Delivery contracts and source-page context provide more structure than a generic voice chat. Review mode deliberately avoids corrupting canonical progress, and teaching preferences persist across transitions.

These are implementation differentiators, not yet a durable moat. Other AI study tools can add voice, summaries, or citations. The current app lacks verified source evidence, longitudinal mastery, learner-specific adaptation, and a corpus/interaction dataset that improves teaching quality over time.

## 23. Architecture Gaps

- Browser ownership of processing and active truth makes refresh, tab closure, device changes, and cross-device recovery fragile.
- One aggregate snapshot mixes curriculum, runtime state, preferences, source metadata, and sync infrastructure.
- No server job/worker, durable intermediate source artifact, source hash cache, or resumable provider operation exists.
- The production path has no deterministic extraction, chunk index, retrieval layer, or citation verifier.
- The monolithic client page coordinates transport, audio, model tools, persistence, and UI with many asynchronous refs.
- Snapshot sync is coarse and cannot merge concurrent field edits.
- Schema version 1 has strict rejection but no historical migration chain.
- Full transcript, turn timestamps, assessment evidence, and mastery events are absent.
- Provider fallback has no global quota governor, circuit breaker, or model-quality evaluation loop.

## 24. Product Gaps

- No lesson editing, source correction, regeneration of one failed concept, or teacher-authored override.
- No durable cross-device processing status or clear account-level job history.
- No complete transcript export, search, or privacy/retention controls.
- No learner-facing understanding dashboard, goal setting, or evidence-based recommendations.
- No robust support for common course formats such as PPTX/DOCX, scans, diagrams, tables, audio, or video.
- No collaborative classroom, instructor authoring, assignment, or cohort workflow.
- Error recovery is functional but not yet differentiated between quota, overload, invalid content, and missing local files.

## 25. Learning/Pedagogy Gaps

The generated contract specifies what the tutor should say, not what the learner demonstrated. Completion criteria are tutor-facing delivery requirements, not scored questions. There are no learner answers, confidence reports, misconception records, item difficulty, spaced repetition, forgetting curves, mastery calibration, or evidence-linked remediation.

The tutor can ask conversational checks, but responses are not converted into durable assessment evidence. “Taught” can therefore overstate learning. The next pedagogical layer should be transparent: attach a small response/check record to teaching points, show why a learner state changed, and preserve tutor delivery coverage separately.

## 26. Source/Content Gaps

Production supports PDF and plain text only. PDF handling depends on Gemini understanding the complete bundle; there is no local OCR or reliable extraction for scans, tables, charts, equations, or layout. Generated structured text can be incomplete while passing non-empty validation. Source references are model-produced and structurally filtered, not verified against extracted page content.

Mixed-source lessons copy the first source’s MIME type into aggregate prepared metadata. There is no source deduplication/hash, versioned source replacement, content change detection, quote span, or claim-level attribution. Copyright/retention policy for uploaded course material is not surfaced.

## 27. Reliability Gaps

Critical untested sequences include barge-in during each audio phase, duplicate provider interruption events, learner speech arriving with `ACTIVITY_START`, reconnect during tool calls, stale generation callbacks, farewell audio drain, microphone track loss, browser backgrounding, IndexedDB upgrade blockage, and cloud conflict during an active lesson.

The code has useful cancellation, epochs, abort controllers, and commit guards, but rare timing bugs can still escape without deterministic event tests. Queue retries repeat whole provider work. A reconnect restores concept/point-level context, not exact audio/sentence position. There is no synthetic provider or audio clock harness.

## 28. Scalability & Cost

**1 user:** The current browser-led architecture is viable for a small lesson and one active Live session. Provider latency and browser audio are the main constraints.

**10 users:** Shared Gemini quota, bursty preprocessing, and Live session concurrency become visible. A small rate limiter, per-user budget, structured logs, and retry backoff are needed; the architecture can remain otherwise unchanged.

**100 users:** Whole-bundle preprocessing and browser queues create cost spikes, duplicate retries, and support difficulty. Add server-owned jobs, object-backed source artifacts, source-hash caching, bounded chunks, queue concurrency limits, and metrics before scaling feature breadth.

**1,000 active students:** Do not scale the current client as the system of record. Use a server job queue/workers, object storage for immutable source/artifact versions, a relational lesson/learner-event store, retrieval index, token/cost governor, provider circuit breakers, and a realtime session gateway or carefully managed ephemeral-token service. Keep browser audio/session state lightweight and keep the beat-commit semantics.

All users share provider quota and potentially the same project billing. A single oversized upload or retry storm can affect everyone. Token counting exists only as a diagnostic; there is no production reservation or cost admission control.

## 29. Security & Privacy Gaps

RLS and private storage are good foundations, but client-delivered lesson IDs, references, and snapshots remain untrusted inputs. The server must continue enforcing ownership and never infer authorization from browser state. Ephemeral Live tokens need short lifetime/scope monitoring and should not be logged.

Missing controls include explicit data-retention/deletion settings, provider processing disclosure, transcript consent, sensitive-content handling, abuse/rate limits, per-user cost caps, malware scanning, source copyright guidance, audit events, and account-wide export/delete semantics. Recent excerpts and latest transcripts may contain personal material even though a full transcript is not stored.

## 30. Testing Gaps

No automated unit, integration, browser, accessibility, load, or provider-contract suite is defined in `package.json`; only `type-check` and `build` scripts are present. Highest-value tests are pure tests for tree normalization, delivery partitioning, beat commit validity, interruption transitions, resume derivation, source-reference filtering, snapshot parsing, and cloud conflict decisions.

Browser tests should cover microphone denial/device loss, typed and voice barge-in, mobile/background handling, reconnect, review isolation, queue refresh/reselect, cloud sign-in, RLS failures, and 429/503 UX. Contract fixtures should include malformed model JSON, missing pages, mixed sources, oversized bundles, and fallback exhaustion. Load tests should measure preprocessing concurrency, Live sessions, IndexedDB/cloud sync, and provider quota behavior.

## 31. Technical Debt

- `app/page.tsx` is a high-coupling orchestration module with many refs, effects, and provider-specific branches.
- Legacy `/api/pdf-source` and `/api/text-outline` coexist with the current `/api/lesson-sources` path, increasing behavioral drift.
- Schema version 1 parsing includes legacy reference compatibility but no explicit migration framework.
- Structured source text is an opaque string beside a structured tree, so independent revision/diffing is difficult.
- Provider model names, limits, and prompt contracts are embedded in route/domain code rather than centrally versioned.
- Whole-snapshot cloud sync and local persistence duplicate state and create coarse conflict boundaries.
- Diagnostic UI is untracked development work in the inspected tree and should not be mistaken for a committed product contract.
- Debug messages are useful for local diagnosis but are not a privacy-reviewed observability channel.

## 32. Risks

| Risk | Likelihood | Impact | Current mitigation | Residual concern |
|---|---|---|---|---|
| Provider quota exhaustion/429 | High as usage grows | High | classify and expose retryable quota error; finite fallback | shared quota affects all users; no budget governor |
| Provider overload/503 | Medium | Medium/High | retryable classification and fallback | fallback may repeat expensive whole-bundle work |
| Model emits incomplete/incorrect source structure | Medium/High | High | schema validation and normalization | shape checks do not prove fidelity |
| Learner speech fails to interrupt audio promptly | Medium | Critical to product promise | activity gating, cancellation, epochs | browser/provider timing is untested |
| Stale callback commits wrong concept | Low/Medium | High | generation/concept/current checks | no automated race harness |
| Refresh loses queued source bytes | Medium | High | `needs-source` state and reselect UX | no durable server job or cross-device recovery |
| Unsupported/scanned content grounds poorly | High for real courses | High | PDF/TXT validation and uncertainty fields | no OCR/extraction/retrieval |
| Snapshot conflict overwrites progress/preferences | Medium | Medium/High | content signatures and conflict state | no field-level merge |
| Sensitive source/transcript exposure | Medium | High | server key boundary, private RLS storage | no retention/consent/deletion policy |
| Cost spike from large bundles/retries | Medium | High | byte limits, model fallback list | no per-user admission control |
| Mobile background suspends audio | Medium | Medium/High | debug notice and resume state | no native/background audio guarantee |
| No learner mastery evidence | Certain | Product-critical long-term | delivery contracts are explicit | progress can be mistaken for learning |

## 33. Future Architecture Options

**Option A — Harden the current POC:** Keep browser orchestration, add pure state tests, structured events, explicit retry UX, source hashes, and deterministic extraction for text PDFs. Lowest complexity; still limited durability and scale.

**Option B — Server-owned preparation:** Upload immutable source objects, enqueue a server job, run extraction/model stages in workers, persist versioned artifacts, and let the browser subscribe/poll. Best next architecture once refresh/loss or latency is demonstrated; preserves current Live client.

**Option C — Retrieval and learning platform:** Add artifact/page/chunk tables or object manifests, lexical/semantic retrieval, citation evidence, learner-event records, mastery projections, and analytics. Required for credible course grounding and 1,000 students, but should follow Option B and product evidence.

**Option D — Realtime session gateway:** Proxy or broker Live sessions for policy, quotas, observability, and reconnect control. Valuable at high concurrency, but adds latency/complexity and should not replace the current beat state machine until direct browser Live behavior is measured.

Recommended sequence: A now, B when durability/scale requires it, C for the learning moat, and D only when provider/session operations justify the gateway.

## 34. Prioritized Roadmap

**NOW (protect the core):** Add deterministic unit tests for beat commit/interruption/reconnect; add correlation IDs and metrics for interruption latency, natural drain, stale-callback rejection, provider status, and queue outcomes; improve distinct 429 versus 503 messaging; document privacy/retention and deletion behavior.

**NEXT (make source evidence reliable):** Prototype deterministic text-PDF/page extraction and bounded artifacts behind a feature flag; cache by source hash; retrieve page chunks for live context; show verified excerpts and uncertainty; add server-side rate/cost limits if multiple users are invited.

**LATER (make learning measurable):** Add opt-in learner checks, response/evidence records, misconception/remediation links, transparent mastery indicators, durable transcript retention controls, and server-owned resumable jobs.

**OPTIONAL:** Field-level cloud merge, normalized analytics, collaboration/classroom tools, native mobile shell, session gateway, and broad multimodal ingestion after demand and measurements justify them.

## 35. What We Should NOT Build Yet

Do not add a large microservice fleet, generalized agent framework, custom vector database, opaque mastery score, collaborative editing, native apps, broad multimodal ingestion, or a realtime proxy merely to appear scalable. Do not replace the current interruption/beat semantics with provider transcript heuristics. Do not call development diagnostics production preprocessing. Do not normalize every lesson field into tables before the snapshot model demonstrates a real bottleneck. Do not build a full teacher marketplace or social layer before source trust and learner outcomes work.

## 36. Current Differentiation vs Potential Future Moat

| Today’s differentiator | Why it matters | Potential moat if developed |
|---|---|---|
| Barge-in with explicit uncommitted-beat recovery | Feels conversational and avoids false coverage | A reliable interruption/session state machine measured across devices and providers |
| Contracted, source-aware teaching beats | Controls what must be taught and when delivery commits | A corpus of contract-to-outcome evidence for adaptive teaching |
| Review isolated from canonical progress | Supports safe revisit without corrupting lesson state | Learner-specific review scheduling tied to demonstrated misconceptions |
| Source visual context | Connects speech to course material | Verified claim-to-page excerpts and auditable explanations |
| Persistent teaching preferences | Allows depth/speed personalization | Longitudinal preference and learning-response adaptation |

The future moat is not “uses Gemini voice.” It is trustworthy, interruption-safe teaching that can prove what source evidence was used and adapt from learner evidence over time.

## 37. Top 10 Highest-Priority Improvements

| Rank | Improvement | Why | Impact | Complexity | Horizon |
|------|-------------|-----|--------|------------|---------|
| 1 | Automated interruption/reconnect/beat-commit tests | Protects the core realtime promise from race regressions | Critical | M | NOW |
| 2 | Production event telemetry with correlation IDs | Makes latency, stale commits, failures, and recovery measurable | Critical | M | NOW |
| 3 | Distinct 429/503/quota UX plus per-user cost guard | Prevents retry storms and explains actionable failures | High | M | NOW |
| 4 | Deterministic PDF text/page extraction experiment | Reduces context risk and improves page fidelity | High | L | NEXT |
| 5 | Versioned source artifacts and source-hash caching | Enables bounded retries, reproducibility, and cheaper regeneration | High | M | NEXT |
| 6 | Retrieved excerpts with verified source attribution | Converts source metadata into trustworthy grounding | Critical | L | NEXT |
| 7 | Server-owned resumable processing jobs | Prevents refresh loss and supports multi-device recovery | High | L | LATER |
| 8 | Learner response/evidence model separate from coverage | Makes mastery claims honest and actionable | Critical | L | LATER |
| 9 | Retention, deletion, consent, and transcript controls | Reduces privacy/copyright exposure before broader rollout | High | M | NOW |
| 10 | Contract, snapshot, queue, and accessibility test suites | Stabilizes persistence and user-facing behavior | High | M | NEXT |

## 38. Final Assessment

1. **Strongest part today:** The realtime teaching state machine, especially interruption cancellation and commit-after-natural-audio-drain. It treats barge-in as a state transition rather than a UI event.
2. **Weakest part today:** Source trust and learning measurement. The app can generate and deliver a plausible lesson without proving page-level support or learner understanding.
3. **Biggest technical risk:** Browser-owned asynchronous orchestration combined with shared Gemini quota and no production event telemetry. Rare timing failures or retry storms will be difficult to diagnose and can affect all users.
4. **Biggest product risk:** Learners may mistake “taught” coverage and source-looking pages for actual understanding and verified grounding, reducing trust and educational value.
5. **Fix before inviting more users:** Add interruption/reconnect/queue tests, structured telemetry, distinct quota/overload recovery, privacy/retention disclosures and deletion controls, and a conservative per-user cost/rate guard.
6. **What would make it genuinely differentiated:** Verified source excerpts tied to each spoken explanation, interruption-safe continuation, and transparent adaptation from learner responses/misconceptions—not voice alone.
7. **Recommended architecture for 1,000 active students:** Server-owned upload/job workers with immutable source/artifact storage and caching; relational lesson/learner-event metadata; retrieval index with citation evidence; provider quota/cost governor and circuit breakers; optional realtime session gateway; thin browser Live/audio client retaining the current beat-commit protocol.
8. **Choices to preserve:** Explicit interruption states, generation epochs, natural-drain commit guards, review isolation, server-side provider keys, private storage/RLS, schema validation, and simple snapshot persistence while the product remains a POC.
9. **Choices likely temporary:** Whole-bundle Gemini preprocessing, browser-owned processing queue, monolithic page orchestration, opaque structured-source string, first-source MIME shortcut, coarse snapshot sync, legacy duplicate routes, and absence of durable learner events.
10. **Next major milestone:** “Trustworthy interrupted tutoring”: prove the realtime path with automated tests/telemetry, then ship bounded deterministic source artifacts and verified page excerpts before expanding mastery or scale infrastructure.

**Audit status:** COMPLETE. This document is a consolidated 38-section report. No application/source/config file was modified by this continuation.
