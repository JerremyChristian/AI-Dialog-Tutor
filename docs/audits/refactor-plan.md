# Incremental Refactor Plan

> **Status:** Analysis only. No application code, configuration, dependency, or test file was changed to produce this document.
> **Branch:** `agent/claude-refactor-analysis` (base `890733e`).
> **Prerequisite:** The Codex QA/Playwright voice-test harness (`agent/codex-qa`) should merge before Slice 1 begins. At the time of writing, that worktree had no commits or changes beyond `890733e`, so the conflict predictions in §9 are inferred, not observed.
> **Companion:** `docs/audits/current-architecture-gap-analysis.md` describes the current state. This document describes how to change the code safely.

---

## 1. Summary

`app/page.tsx` (3,190 lines, ~150 KB) is a single client component. It holds about **78 `useRef`s** and **45 `useState`s**, makes **146 debug-log calls**, and mutates canonical lesson state from **at least 9 sites** (`setLessonState` plus `updateLessonState`). The `lib/` modules around it are already reasonably cohesive:

- `teaching-delivery`, `lesson-state`, `live-transport-manager`, `gemini-live-websocket`, `realtime-audio`, `local-persistence`, `cloud-sync`, and `use-lesson-processing-queue`.

The orchestration in `page.tsx` is the problem. The most valuable *and* safest first move is **not** to extract a controller or hook. It is to move the pure decision logic for beat assignment and commit out of `page.tsx` into a testable `lib/` module, leaving every side effect where it is. Each later slice then removes one responsibility from the page. The riskiest slices come last: the realtime session controller and the persistence/cloud hook.

Recommended order (details in §7):

| # | Slice | Kind | Risk |
|---|---|---|---|
| 0 | QA harness + unit runner + characterization tests (Codex-owned) | prerequisite | – |
| 1 | Extract pure beat assignment/commit/control logic → `lib/teaching-beat-runtime.ts` | A | Low–Med |
| 2 | Extract pure lesson-snapshot and resume-context builders | A | Low |
| 3 | Remove write-only refs and unused exports (no route deletion) | A | Low |
| 4 | Extract the Live server message normalizer (provider boundary) | A | Medium |
| 5 | Extract tool-call decision tables (`session_control`, preferences, `lesson_state`) | A | Medium |
| 6 | Extract presentational components (teaching room, debug panel, restart dialog) and trivial hooks (appearance, PWA install) | A | Low (but high conflict with QA) |
| 7 | Extract review controller state, on top of Slice 1 | A | Medium |
| 8 | Extract farewell/completion and idle-engagement controllers | A | Medium |
| 9 | Extract audio session lifecycle (mic stream + streamer + player + wake lock) | A | Med–High |
| 10 | Extract `useLessonWorkspace` (persistence, hydration, cloud sync orchestration) | A | High |
| 11 | Extract realtime teaching session controller (start/stop/dispose/transport wiring) | A | High |
| B-n | Behavioral fixes found during analysis (§5), each as its own test-first PR | B | varies |

---

## 2. Method

Every file in `app/`, `lib/`, and `components/` that participates in the realtime path was read: `app/page.tsx` in full, `lib/live-transport-manager.ts`, `lib/gemini-live-websocket.ts`, `lib/realtime-audio.ts`, `lib/teaching-delivery.ts`, and `lib/lesson-state.ts` (transition functions). The persistence, cloud, queue, and Source Visual modules were read at the boundary level. Line references are to commit `890733e`. No provider API was called.

---

## 3. Responsibility map of `app/page.tsx`

| Lines (approx.) | Responsibility | Natural owner |
|---|---|---|
| 102–165 | Local types: `ActiveTeachingBeat`, `PresentationBeat`, `NodeReviewState`, `FarewellTurn`, `ConversationContinuity` | Beat/review/farewell domain module |
| 167–188 | Microphone/realtime error mapping | Audio/session module |
| 190–244 | `TeachingStyleControls` component | `components/` |
| 251–285 | `getPersistedResumeContext`, `createRecentTeachingExcerpt` (pure) | Resume-context module |
| 288–418 | ~120 state/ref declarations | Distributed by later slices |
| 420–449 | Debug logging, review-flow diagnostics | Shared logger (keep simple) |
| 451–479 | Appearance (localStorage + `data-theme`) | `useAppearance` hook |
| 481–497 | `updateLessonState`, `invalidateActiveTeachingBeat` | Beat runtime |
| 499–542 | `buildTeachingBeatControl` (prompt text for a beat) | Beat runtime (pure) |
| 544–651 | `assignNextTeachingBeat`, `assignNextReviewBeat` | Beat runtime + review |
| 653–716 | Farewell: `maybeFinishFarewell`, `beginClosingFarewell` | Completion controller |
| 675–692, 2257–2287 | Review start/exit/finish | Review controller |
| 718–788 | `maybeCommitTeachingBeat` (lesson + review commit) | Beat runtime |
| 790–856 | `disposeResources` (tears down about 40 refs/timers/states) | Session controller |
| 858–885 | Wake lock, engagement state, meaningful activity | Audio session / engagement |
| 887–904, 1236–1274 | Teaching-preference pending/authoritative reconciliation | Preferences controller |
| 906–1039 | Snapshot creation, local persist, cloud upload scheduling | Workspace/persistence |
| 1041–1152 | Reset progress, hydrate saved lesson, reset idle workspace | Workspace/persistence |
| 1154–1234 | Library actions: new, select, delete | Workspace/persistence |
| 1276–1313 | Roadmap navigation (sends learner text, pending timer) | Navigation (session-level) |
| 1315–1347 | Idle detection and confirmation | Engagement controller |
| 1349–1411 | Mute toggle, quick responses | Session input |
| 1413–1508 | Library refresh, processing-queue hook, account sync, local import | Workspace/cloud |
| 1510–1604 | Workspace load effect, autosave effect | Workspace/persistence |
| 1606–1638 | Mount effect: PWA install, visibility, unmount dispose | App shell + audio session |
| 1640–1680 | `handleLearnerInterruption` | Interruption (beat runtime + transport) |
| 1682–1712 | `submitTypedReply` | Session input |
| 1714–1955 | `handleLiveMessage` (provider message → domain effects) | Provider adapter + session controller |
| 1957–2255 | `handleLessonToolCalls` (3 tools, ~300 lines) | Tool dispatcher |
| 2289–2653 | `startConversation` (mic → token → transport → seed → mic stream → imperative) | Session controller |
| 2655–2724 | `stopConversation`, `restartLesson` | Session controller |
| 2726–2786 | Derived view values, open/navigate/install | Page |
| 2788–3190 | JSX: home, library, profile, new lesson, lesson detail, teaching room, debug panel | Components |

---

## 4. Runtime protocols as currently implemented (the behavior to preserve)

These descriptions are the reference for "mechanical" in this plan. A refactor is mechanical only if every step below happens in the same order, under the same guards.

### 4.1 Startup protocol (`startConversation`, 2289–2653)

1. Guard: a ready source and a prepared source are required. Set `lessonStartupPendingRef = true` and bump the workspace-load and hydration generations so in-flight hydration is discarded.
2. Build the initial lesson state: a fresh `createLessonState`, or the persisted state when `resumeExistingLessonRef`. Set `lessonWrapUpRef` from `isLessonPlanComplete`.
3. `run = ++conversationRunRef`. Create `PcmAudioPlayer` and call `prepare()` concurrently with `getUserMedia`. After *every* await, the run is checked against `conversationRunRef` and `isMountedRef`.
4. Mic track `ended` → bump the run, dispose, set lesson status to idle.
5. Fetch a token (`/api/gemini-token`) → create `LiveTransportManager` → `connectInitial`. The socket sends `setup` with `initialHistoryInClientContent: true`, and `connect()` resolves only on the first `setupComplete`.
6. Seed: `seedRecoveryContext(... persistedResumeContext ...)` for a persisted resume, otherwise `seedInitialSource`. Both send `clientContent` with `turnComplete: true`, which is history-only and does not trigger generation.
7. Create `MicrophonePcmStreamer` and `start()` it. Chunks are gated on `run` and `transportRef === transport`, and on not-muted and no-farewell.
8. `status = "teaching"`, `resumeExistingLesson = true`, **`lessonActiveRef = true`**, start idle monitoring and the wake lock.
9. **Exactly one** proactive imperative:
   - plan already complete → `LESSON_WRAP_UP_CONTROL` (raw realtime text);
   - persisted resume → `assignNextTeachingBeat(PERSISTED_LESSON_RESUME_CONTROL)`;
   - new lesson → `assignNextTeachingBeat("Begin the source-grounded spoken lesson now…")`.

**Ordering constraints a refactor must keep:**
- (a) Seeding happens before any `realtimeInput`.
- (b) `lessonActiveRef` becomes true before the imperative, because `assignNextTeachingBeat` returns null otherwise.
- (c) Only one imperative is sent.
- (d) The run check comes after each await.

### 4.2 Beat assignment

A beat can be assigned through **two channels**:
- `assignNextTeachingBeat(prefix, sendInstruction = true)` sends the `TEACH_PRESENTATION_BEAT` control as `realtimeInput` text.
- `assignNextTeachingBeat("", false)` returns the beat; the tool dispatcher then embeds `buildTeachingBeatControl(...)` as `teachingAssignment` in the `lesson_state` tool response. Used for `query` with `purpose: "continue"`, and for successful `navigate`/`skip`.

Assignment guards (545–546):
- `lessonActiveRef`
- no active beat
- no farewell
- **no review active**

If the current concept is `taught` and wrap-up has not started, `activateNextSequentialConcept` runs, but that activated state is **committed to React state only after the instruction is sent successfully** (599–603). A failed send invalidates the beat and discards the activation.

Assignment immediately sets `presentationBeat`. Source Visual follows assignment, not commit.

### 4.3 Beat commit (`maybeCommitTeachingBeat`, 718–788)

A beat commits only when all of these hold:
- `generationComplete` arrived (`handleLiveMessage` 1902–1911 sets it on whichever beat is active, then calls `player.completeBatch(epoch)`);
- the player reports natural drain for the same epoch (`PcmAudioPlayer.maybeReportNaturalDrain`: provider complete, had audio, all sources ended, not cancelled);
- `isBeatCommitValid` passes (active lesson, not cancelled, same concept, same start index).

Then `commitDeliveredTeachingBeat` (canonical) runs. If the resulting state is `completed`, `lessonWrapUpRef = true`. A non-final beat in a unit auto-chains the next beat. The final beat of a unit waits for the learner.

In review mode, commit advances only `nodeReview.nextTeachingPointIndex`.

### 4.4 Interruption (`handleLearnerInterruption`, 1640–1680; message ordering 1731–1845)

**Triggers:**
- provider `serverContent.interrupted` *and* current learner activity (`learnerActivityRunRef === conversationRun` and transport utterance active/open);
- a typed reply while the assistant is speaking (marked as a discrete turn).

A provider `interrupted` with no learner activity is ignored.

**Effects:**
- invalidate the active beat (cancel batch, bump epoch);
- `player.clear()`;
- `transport.registerInterruption()` deduplicates per learner utterance, including across rollover.

On the first registration only, and only when not in review:
- `status = "interrupted"`;
- `resumePoint` is derived from the interrupted transcript;
- `interruptionCount++`;
- `resumptionPendingRef = true`.

Review interruptions return early and do not touch canonical state.

**Farewell guard:** during an active farewell for the current run/epoch, interruptions are ignored.

**Message ordering:** `ACTIVITY_START` must update transport gating (`setLearnerSpeaking(true)`) *before* `interrupted` is processed in the same message. A comment at 1728–1730 documents this.

### 4.5 Clarification and resume

After an interruption, the uncommitted beat is gone: `activeTeachingBeatRef` is null and the cursor is unchanged. Learner speech or typed input moves `interrupted → resolving-interruption`. The tutor's answer is free-form and is not a beat, so its `generationComplete` finds no active beat and commits nothing. When audio starts and `resumptionPendingRef` is set, status becomes `resuming`. `generationComplete` resets status to `teaching` (or `completed` in wrap-up) and refreshes `resumePoint` only when the checkpoint concept matches the current concept.

Resumption of structured teaching happens only when the model calls `lesson_state query purpose:"continue"`. That call assigns the next beat, restarting the uncommitted beat from its first point, through the tool response. `reviewResumeGuardRef` blocks this re-assignment immediately after a review finishes until new learner activity occurs.

### 4.6 Review

`startNodeReview`:
- invalidates the beat and clears the player;
- creates `NodeReviewState` with cursor 0 and the current `presentationBeat` as the return target;
- assigns the first review beat.

While review is active:
- lesson assignment is blocked;
- `navigate`/`skip` tools return `review_active`;
- interruptions do not touch canonical state;
- `assistantCheckpointConceptIdRef` is null, so recent teaching context is not updated.

A final review beat sets `complete: true` and waits. Then either `query continue` or a manual exit calls `finishNodeReviewAndResume`, which:
1. restores `returnPresentationBeat`;
2. sends `assignNextTeachingBeat()` as **realtime text**, even inside a tool-call handler before that tool response is sent (2126);
3. sets `reviewResumeGuardRef`.

`exitNodeReview` (from roadmap navigation) does *not* assign a next beat.

Transport recovery invalidates the review beat but **keeps `nodeReviewRef`**. Recovery seeding omits review.

### 4.7 Completion and farewell

1. The final canonical beat's control text includes `LESSON_WRAP_UP_CONTROL` and asks for final questions.
2. A commit that makes the state `completed` sets `lessonWrapUpRef`.
3. `session_control end` during wrap-up → `beginClosingFarewell()`:
   - invalidates the beat and creates a new epoch;
   - creates a farewell batch;
   - stops forwarding the mic (`!closingTurnRef` gate at 2567).
4. `generationComplete` plus natural drain (or zero audio) → `maybeFinishFarewell` → "Lesson complete" overlay → 2 s timer → `stopConversation("confirmed")`.
5. `stopConversation` → `pauseLessonState` → persist → `disposeResources(true)`.

### 4.8 Transport recovery

`LiveTransportManager` has two paths.

**Resume path** (a handle exists): replacement socket with `sessionResumption.handle` → `synchronizing`:
- sends `POST_RESUME_SYNC`;
- suppresses `serverContent`;
- waits for the tool response plus a finished turn;
- then flushes queued learner text, **or** sends `CONTINUE_INTERRUPTED_TUTOR_TURN` when the assistant was speaking (and no learner utterance was open), **or** waits for the learner.

**Fresh path:**
- `recovering` → page invalidates the active beat and clears the player (2459–2472);
- new token → new socket → `seedFreshRecovery` (`clientContent` with `turnComplete: true`, history-only) → flush the handoff audio buffer → flush queued learner text → `active`.

**No startup imperative and no beat assignment** is sent on the fresh path. Teaching resumes only when the learner speaks or the model calls `query continue`.

### 4.9 Teaching preferences — three write paths

1. **Profile view:** `applyAuthoritativeTeachingPreferences` directly. No transport.
2. **Active-lesson controls:** send a natural-language learner text, show a pending overlay, and wait up to 5 s for the tool call.
3. **`update_teaching_preferences` tool:** authoritative. Calls `transport.updateSystemInstruction(...)`, which discards the prepared replacement token.

Pending values clear when the authoritative value catches up (887–904).

### 4.10 Persistence and cloud

**Autosave effect** (1579–1604): a 600 ms debounce over selected lesson-state fields. The snapshot is built from render-closure values (`learningSource`, `lessonSources`, `topicInput`) plus refs.

**Workspace-load effect** (1510–1577): a generation-guarded async load, keyed on auth and owner. Its dependency array includes `aiConnectionStatus` and `microphoneStatus`, which act as re-trigger signals after a lesson ends.

Cloud upload uses a 1.2 s debounce per lesson and calls `reconcileCloudLessons` with `deferDownloadLessonId` when a lesson is active. Hydration is refused while a lesson is active or starting.

---

## 5. Invariant catalog

Each invariant has an ID for use in slice descriptions and test names.

| ID | Invariant | Enforced at | How a test observes it |
|---|---|---|---|
| **I1** | App owns canonical progress; the model can only query/navigate/skip | Tool schema (`gemini-live-websocket.ts:47-115`); only `maybeCommitTeachingBeat` calls `commitDeliveredTeachingBeat` | Fake Live sends any tool or text; cursor changes only after a drained beat |
| **I2** | Coverage is delivery, not mastery | `lesson-state.ts`; no learner-evidence path | Statuses only move via commit/navigate/skip/pause |
| **I3** | Interrupted or unconfirmed beats do not commit | `invalidateActiveTeachingBeat` → `cancelled` + `cancelBatch` + epoch bump | Interrupt mid-beat → `nextTeachingPointIndex` unchanged; the same beat is reassigned later |
| **I4** | Generation completion alone does not commit | `isBeatCommitValid` requires `audioNaturallyDrained` | Send `generationComplete` with audio still scheduled → no commit until playback ends |
| **I5** | Natural audio drain is required (cancel/clear ≠ drain) | `PcmAudioPlayer.maybeReportNaturalDrain` | `clear()` before drain → no callback; no commit |
| **I6** | Review never mutates canonical progress | Review branch in commit; assignment guard; tool `review_active`; interruption early return; checkpoint concept null | Full review of a taught node → `lessonState` deep-equal before/after (except `lastAssistantTranscript`/status) |
| **I7** | Source Visual follows the Presentation Beat | `presentationBeat` set on assignment and restored on review exit; `SourceVisual` keys on `presentationKey` | Assigned beat N → visual shows beat N's page *before* commit; review exit restores the return beat |
| **I8** | Startup does not duplicate proactive generation | Seed with `turnComplete` (history-only) + exactly one imperative | Fake Live counts realtime text imperatives during startup = 1 |
| **I9** | Fresh-socket recovery does not create a duplicate startup/resume imperative | `seedFreshRecovery` sends only `clientContent`; page sends nothing on `active` | Fake socket failure → zero `TEACH_PRESENTATION_BEAT`/resume controls on the new socket until learner/tool |
| **I10** | Clarification does not advance canonical progress | No active beat during the clarification answer | Interrupt → ask → answer drains → cursor unchanged |
| **I11** | Interruption registers once per learner utterance (including across rollover) | `LiveTransportManager.registerInterruption` | Duplicate `interrupted` events → `interruptionCount` +1 |
| **I12** | Stale callbacks are ignored (run, epoch, socket identity) | `conversationRunRef` checks; `activeSocket` identity; epoch checks | Events from a closed socket or an old run do nothing |
| **I13** | Activation of the next concept is committed only after its first beat instruction is sent | `assignNextTeachingBeat` 595–603 | Send failure → `currentNodeId` unchanged |
| **I14** | Farewell completes only after generation complete and (natural drain, or no audio) | `maybeFinishFarewell` | Farewell audio interrupted or still playing → no stop |
| **I15** | Mic audio is not forwarded during farewell or mute | Streamer callback gate; `setMicrophoneForwardingEnabled` | — |
| **I16** | Hydration and workspace reload never overwrite an active or starting lesson | `hydrateSavedLesson` guard; load-effect guards | Cloud sync during a lesson does not replace `lessonState` |
| **I17** | Provider key never reaches the client; only ephemeral tokens | `/api/gemini-token` | Bundle scan |

---

## 6. Observed latent behaviors — do NOT "fix" during mechanical slices

These are the main traps: code that looks wrong or redundant, where changing it is a **behavioral change (B)**. Each should be pinned by a characterization test *as-is* before any extraction, then addressed, if at all, in a separate B-slice with explicit sign-off.

1. **Tautological epoch check in lesson commit.** `maybeCommitTeachingBeat` passes `currentEpoch: activeTeachingBeatRef.current?.generationEpoch`, which is the same object as `active`, so `expectedEpoch === currentEpoch` always holds. Lesson-mode staleness actually relies on the earlier `active.generationEpoch !== epoch` check and on invalidation nulling the ref. Review mode compares against `generationEpochRef` instead. Unifying these changes behavior: some paths bump `generationEpochRef` without an active beat, e.g. `resetCurrentLessonProgress`, which bumps twice. **(B)**
2. **Zero-audio beats never commit.** The player's natural drain requires `hadAudio`. A teaching beat whose generation completes with no audio leaves `activeTeachingBeatRef` set forever. Further assignment is then blocked until interruption, navigation, recovery, or review clears it. The farewell path handles zero audio explicitly; teaching beats do not. **(B)**
3. **`generationComplete` is not epoch-tagged.** Any provider `generationComplete` marks *whatever beat is active* complete, including one assigned through a tool response in the middle of a model turn. The audio-drain gate makes this mostly safe. "Fixing" it requires provider turn correlation. **(B)**
4. **Fresh recovery sends no imperative.** After a fresh-session recovery, the tutor is silent until the learner speaks or the model chooses `query continue`. This looks like a bug but is invariant I9. Adding a "resume teaching" nudge is a product decision. **(B)**
5. **Beat split across a resumed session.** On the *resume* path, `CONTINUE_INTERRUPTED_TUTOR_TURN` continues the unfinished tutor turn on the new socket. The active beat is *not* invalidated (only `recovering` invalidates), so the continuation's `generationComplete` plus drain can commit a beat whose first half was played on the old socket. This is arguably correct, since it was a transport change and not a learner interruption, but it is untested and should be pinned. **(B to change)**
6. **`finishNodeReviewAndResume` sends realtime text inside a tool-call handler** before that call's tool response is sent (2126 → 2233). The ordering of `realtimeInput` before `toolResponse` is provider-sensitive. A refactor that routes this through `teachingAssignment` changes ordering. **(B)**
7. **The preference tool rebuilds the system instruction without `sessionStartMode`** (2012–2016). After a preference change in a persisted-resume session, replacement sockets get "new" guidance. **(B)**
8. **`isLessonPlanComplete` treats `skipped` as complete**, while `withDerivedNodes` sets `completed` status on the same basis. The gap analysis says "all teachable leaves taught". The code says taught *or* skipped. Keep this, and fix the doc wording separately.
9. **Workspace-load effect dependencies include `aiConnectionStatus` and `microphoneStatus`.** They look like lint noise but act as re-trigger signals. Removing them changes when the workspace reloads after a lesson. **(B)**
10. **Two notions of "lesson active".** The render-time `lessonActive` is derived from mic or connection *UI status*. Runtime guards use `lessonActiveRef`. They differ during startup and teardown. Do not unify in a mechanical slice. **(B)**
11. **Autosave snapshot closes over render values.** `createCurrentLessonSnapshot` reads `learningSource`, `lessonSources`, and `topicInput` from the closure but lesson state from a ref. Moving it into a hook with different capture semantics can persist stale titles or sources. **(B risk in a nominally A slice)**
12. **Exit-review paths differ.** A manual exit from the roadmap (`onExitReview`) uses `finishNodeReviewAndResume("manual")` and assigns the next beat. Navigation during review uses `exitNodeReview()` and does not. Merging them changes behavior. **(B)**

---

## 7. Proposed slices

Legend:
- **A** = mechanical/structural (same inputs → same outputs/effects, same order).
- **B** = behavioral.

Size: S < 150 changed lines, M 150–500, L > 500.

### Slice 0 — Safety net (prerequisite; owned by the Codex QA work)

Not a refactor. Listed because every later slice depends on it.
- A unit test runner, chosen by the QA PR. Note: plain `node --test` with type stripping cannot import the extensionless `./module` imports in `lib/`, so a runner such as Vitest or `tsx` is needed.
- Characterization unit tests for the existing pure `lib` functions (list in §13).
- Playwright scenarios against a **fake Live WebSocket and fake audio**, covering I3–I11, I14, and the resume/recovery paths.

### Slice 1 — Extract pure beat runtime logic  ✅ recommended first

- **Kind:** A.
- **What moves** to a new `lib/teaching-beat-runtime.ts`:
  - Types `ActiveTeachingBeat`, `PresentationBeat`, `NodeReviewState` (page 128–144).
  - `buildTeachingBeatControl(state, active, prefix)`: currently reads `lessonStateRef`. Becomes a pure function of `(state, active, prefix)` with byte-identical output.
  - `planLessonBeatAssignment(state, { wrapUp })` → `{ concept, resolved, activatedState } | null`: the pure part of 547–560.
  - `planReviewBeatAssignment(state, review)` → `{ concept, resolved } | null`: from 609–613.
  - `createActiveBeat(resolved, conceptId, mode, epoch)`.
  - `evaluateLessonBeatCommit(state, active, lessonActive)` → `{ kind: "not-ready" } | { kind: "rejected" } | { kind: "committed", state, nextIndex, wrapUp, autoChain }`. Wraps the existing `isBeatCommitValid` call, **including the tautological epoch argument (§6.1)**, and `commitDeliveredTeachingBeat`.
  - `evaluateReviewBeatCommit(state, review, active, currentEpoch)` → `{ kind: "not-ready" } | { kind: "committed", review, nextIndex, complete }`.
- **What stays in the page:**
  - every ref read/write, `setState`, `player.beginBatch` / `cancelBatch` / `completeBatch`, `transport.send*`, debug logging, and auto-chain calls;
  - the page functions keep their names and call sites, and become thin shells that call the pure functions.
- **Benefit:** High. The core of the product promise (I3–I6, I10, I13) becomes unit-testable without a browser. All later slices build on it.
- **Risk:** Low–Medium. The control text is model-facing, so any whitespace or wording drift is a behavior change; guard it with a snapshot test. Logic must preserve guard order exactly.
- **Size:** M (~200 lines moved out of the page, ~180 new lines including types, ~25 call-site edits).
- **Files:** `app/page.tsx` (128–144, 499–651, 718–788 only); new `lib/teaching-beat-runtime.ts`; new unit test file. **Not** `lib/teaching-delivery.ts` or `lib/lesson-state.ts`.
- **Invariants at risk:** I1, I3, I4, I6, I10, I13.
- **Protecting tests:**
  - control-text golden snapshots (lesson first/middle/final/only, wrap-up final, review final/non-final);
  - assignment with taught current concept → activation;
  - commit gating matrix (each `BeatCommitContext` flag false → no commit);
  - review commit never alters `LessonState`;
  - Playwright: interrupt mid-beat, then continue → same points reassigned.

### Slice 2 — Extract pure snapshot and resume-context builders

- **Kind:** A.
- **What moves** to a new `lib/lesson-snapshot.ts` (or into `local-persistence.ts`, but a new file avoids a QA conflict):
  - `getPersistedResumeContext` and `createRecentTeachingExcerpt` (already pure, page 251–285);
  - a pure `appendRecentTeachingContext(entries, state, conceptId, transcript)` from 950–965;
  - a pure `buildSavedLessonSnapshot(input)` from 967–1007. Inputs are passed explicitly: `id`, `prepared`, `source`, `lessonSources`, `topicInput`, `hasStarted`, `state`, `recentContext`, `preferences`, `timestamps`, `owner`, `cloudSync`, `previousSignature`, `now`.
- **Benefit:** Medium. Makes snapshot shape and `updatedAt` stability testable and removes ~90 lines.
- **Risk:** Low, provided call sites pass the *same* closure values (§6.11).
- **Size:** S–M.
- **Files:** `app/page.tsx` (251–285, 950–1007), new lib file, tests.
- **Invariants at risk:** transcript fields blanked in persisted state; `updatedAt` stability when the content signature is unchanged; recent-context cap of 3 and 360 characters.
- **Tests:** snapshot builder round-trips through `parseSavedLesson`; identical content → identical `updatedAt`; transcripts stripped.

### Slice 3 — Dead-code removal (low-risk subset)

- **Kind:** A.
- **Remove:** write-only refs `sourceGroundingPendingRef`, `lastAcousticActivityAtRef`, and `lastCandidateLearnerActivityAtRef` (verify: they have no reads), and the unused export `arrayBufferToBase64` in `lib/realtime-audio.ts`.
- **Do not** remove the legacy routes in this slice (see §10).
- **Benefit:** Low–Medium (noise reduction). **Risk:** Low. **Size:** S.
- **Tests:** type-check and build; existing Playwright suite.

### Slice 4 — Live server message normalizer (provider boundary)

- **Kind:** A.
- **What:** add `lib/live-message-events.ts` with `normalizeLiveServerMessage(message): LiveEvent[]`. The event list preserves the *exact processing order* of `handleLiveMessage`:
  1. toolCallCancellation
  2. toolCall (short-circuits)
  3. ACTIVITY_START / ACTIVITY_END gating
  4. inputTranscription / interim
  5. draft close
  6. outputTranscription
  7. interrupted
  8. activity status
  9. audio parts
  10. generationComplete
- `handleLiveMessage` becomes a `switch` over events. Gemini types (`LiveServerMessage`, `FunctionCall`) stop appearing in the page.
- **Benefit:** Medium–High. This is the first real provider/domain seam. It also gives the QA fake server a typed contract.
- **Risk:** Medium. The ordering of ACTIVITY_START before `interrupted` within one message (§4.4), and the early `return` inside the farewell `generationComplete` branch (1913–1914, which skips the transcript/status update that follows), must be reproduced exactly.
- **Size:** M.
- **Files:** `app/page.tsx` (1714–1955), new lib file and tests. `lib/live-transport-manager.ts` is untouched.
- **Invariants at risk:** I3, I4, I10, I11, I12, I14.
- **Tests:** unit tests on the normalizer with combined-field messages; Playwright barge-in with ACTIVITY_START + interrupted in one frame; stale farewell `generationComplete`.

### Slice 5 — Tool-call decision tables

- **Kind:** A.
- **What:**
  - Extract `decideSessionControl(action, ctx)`, a pure function returning `{ result, intents[] }`. Intents include `"begin-farewell"`, `"end-after-response"`, `"restart-after-response"`, `"confirm-continue"`, and similar.
  - Extract `decideLessonStateCall(args, ctx)` → `{ result, transition?, assignmentRequest?, recovery? }`.
  - The preference tool already delegates to `applyTeachingPreferenceUpdate`.
  - The page executes the intents in the same order as today, keeping the tool-result cache, cancellation set, response send, post-resume sync completion, and silent recovery.
- **Benefit:** Medium–High (~300 lines of branching become testable).
- **Risk:** Medium. Side-effect order inside the loop matters:
  - `invalidateActiveTeachingBeat` before navigate;
  - assignment after transition;
  - roadmap pending cleared after navigate;
  - `finishNodeReviewAndResume` sending text before the tool response (§6.6).
- **Size:** M–L. Consider splitting into 5a (`session_control`) and 5b (`lesson_state`).
- **Files:** `app/page.tsx` (1957–2255), new `lib/lesson-tool-decisions.ts`, tests.
- **Invariants at risk:** I1, I6, I13, I14, wrap-up/restart confirmation semantics.
- **Tests:**
  - decision tables for every `session_control` action × {idle-confirming, wrap-up, normal, restart-pending};
  - `navigate`/`skip` during review → `review_active`;
  - `query continue` during post-resume sync → no assignment;
  - duplicate tool ID → cached response.

### Slice 6 — Presentational extraction and trivial hooks

- **Kind:** A.
- **What:**
  - Move `TeachingStyleControls`, the duplicated restart-confirmation dialog (2795 and 2872), the teaching-room status/controls block, the lesson detail view, and the developer debug panel (3018–3176) into `components/`.
  - Extract `useAppearance` (451–479) and a `usePwaInstall` piece of the mount effect.
- **Benefit:** Medium (about −500 lines from the page, clearer render). **Risk:** Low for behavior, **high for merge conflicts** with QA (`data-testid`s, debug buttons used by tests). Do this only after QA merges, and preserve every selector the harness uses.
- **Size:** L in line count, but trivial in logic.
- **Invariants at risk:** none at runtime. Accessibility labels and test selectors must stay byte-identical.

### Slice 7 — Review controller

- **Kind:** A.
- **What:** a small `lib/review-controller.ts` (plain functions over `NodeReviewState`). It holds `start`, `exit` (no resume), `finishAndResume` (resume), and the `reviewResumeGuard` rule, building on Slice 1's `evaluateReviewBeatCommit`. The page keeps refs and effects.
- **Benefit:** Medium (I6 is concentrated in one place). **Risk:** Medium (§6.12: two exit semantics must stay distinct). **Size:** S–M.
- **Files:** `app/page.tsx` (675–692, 2257–2287, review-guard sites), new lib file.
- **Invariants at risk:** I6, I7, I3.
- **Tests:**
  - Playwright full review of a taught node → canonical state unchanged;
  - review interrupted → no `interruptionCount` change;
  - review exit restores the visual;
  - navigate during review → exit without auto-assign;
  - transport recovery during review → review persists, canonical unchanged.

### Slice 8 — Completion/farewell and idle-engagement controllers

- **Kind:** A.
- **What:**
  - A pure `isFarewellReadyToFinish(farewell, run, epoch)` predicate plus the farewell record factory.
  - An idle-engagement reducer (`active → possibly-idle → confirming → ended`) with timers left in the page or a tiny hook.
- **Benefit:** Medium. **Risk:** Medium (2 s animation timer, mic gating during farewell, interruption suppression). **Size:** S–M.
- **Invariants at risk:** I14, I15.
- **Tests:** farewell with audio (drain required), zero audio, interrupted farewell (ignored), idle confirm continue/end/unclear.

### Slice 9 — Audio session lifecycle

- **Kind:** A.
- **What:** a `lib/audio-session.ts` class owning `MediaStream`, `MicrophonePcmStreamer`, `PcmAudioPlayer`, the wake lock, the RMS/noise-floor tracker, the track-ended callback, and the visibility resume. It exposes `start(onChunk)`, `player`, `flushPending()`, and `dispose()`. `disposeResources` delegates the audio part to it.
- **Benefit:** Medium–High (separates the browser-audio platform from lesson logic; it can be faked wholesale in tests). **Risk:** Medium–High:
  - player `prepare()` runs concurrently with `getUserMedia` (needed for the iOS user gesture);
  - the run check follows each await;
  - mic start comes *after* seeding (§4.1 a);
  - dispose order: streamer → transport → tracks → player.
- **Size:** M.
- **Files:** `app/page.tsx` (790–866, 1606–1638 visibility part, 2396–2433, 2556–2575), `lib/realtime-audio.ts` (read-only use), new lib file.
- **Invariants at risk:** I5, I12, I15, startup ordering, iOS autoplay.
- **Tests:** Playwright with a fake `getUserMedia` (permission denied, track ended, device error); background/visibility resume; mute flush.

### Slice 10 — `useLessonWorkspace` (persistence + hydration + cloud orchestration)

- **Kind:** A, but with a high behavioral-drift risk.
- **What:** move the snapshot refs, `persistLessonSnapshot`, `scheduleCloudUpload`, hydrate/reset, select/delete/new, `refreshScopedLibrary`, `syncCurrentAccount`, `importLocalLessons`, the workspace-load effect, and autosave into a hook. The hook exposes guarded operations plus `isHydrationBlocked()`, which the session controller sets.
- **Benefit:** High (≈ −700 lines; persistence becomes independent of the realtime path).
- **Risk:** High:
  - effect dependency semantics (§6.9);
  - closure capture (§6.11);
  - generation counters shared with startup (`startConversation` bumps the workspace-load and hydration generations);
  - cloud-owner switching;
  - the `onAuthResolved` timer clearing.
- **Size:** L.
- **Files:** `app/page.tsx` (906–1234, 1413–1604, `CloudAccount` callbacks), new `lib/use-lesson-workspace.ts`. Should **not** require editing `lib/local-persistence.ts` or `lib/cloud-sync.ts`.
- **Invariants at risk:** I16, persisted `updatedAt` stability, cloud defer-while-active, owner scoping.
- **Tests:** IndexedDB fake (or a real browser) for hydrate during an active lesson (refused), autosave debounce, sign-in/sign-out owner switch, delete current lesson, cloud sync with a deferred active lesson, incompatible-schema handling.

### Slice 11 — Realtime teaching session controller

- **Kind:** A.
- **What:** a `TeachingSession` (class or hook) owning:
  - `conversationRun`, transport creation, token fetch, seeding, the startup imperative choice, `stop`/`dispose`/`restart`, transport state mapping, and `seedFreshRecovery`;
  - the composition of the beat runtime (S1), message normalizer (S4), tool decisions (S5), review (S7), farewell (S8), and audio session (S9).
- The page becomes a view over controller state plus the workspace hook.
- **Benefit:** Very High (the end state). **Risk:** High. It touches every invariant, and the ~40-field teardown in `disposeResources` must stay complete. **Size:** L.
- **Prerequisites:** S1, S4, S5, S7, S8, and S9 merged, plus the full Playwright suite green.
- **Invariants at risk:** all of I1–I16.
- **Tests:** the entire QA suite. Add a startup/recovery imperative-count assertion (I8, I9) if one is not already present.

### B-slices (behavioral; each separate, test-first, with explicit approval)

| ID | Change | Why | Risk |
|---|---|---|---|
| B1 | Zero-audio teaching beat handling (§6.2) | Prevents a silent stall | Medium |
| B2 | Make the lesson-commit epoch check meaningful (§6.1) | Defense in depth against stale commits | Medium |
| B3 | Preserve `sessionStartMode` on preference-driven instruction rebuilds (§6.7) | Correct guidance on replacement sockets | Low |
| B4 | Decide the post-fresh-recovery resume policy (§6.4) | Product/UX choice | High (I9) |
| B5 | Decide the split-beat-on-resume policy (§6.5) | Coverage honesty | Medium |
| B6 | Delete the legacy `/api/pdf-source` and `/api/text-outline` routes (§10) | Remove drift and cost surface | Low (no in-repo callers) but outward-facing |

---

## 8. Recommended order and rationale

```
Slice 0 (QA harness)  ──►  S1 beat runtime  ──►  S2 snapshot builders  ──►  S3 dead code
                                │
                                ├──►  S4 message normalizer  ──►  S5 tool decisions
                                │
                                └──►  S7 review  ──►  S8 farewell/idle
S6 presentational (any time after QA merge; coordinate selectors)
S9 audio session  ──►  S10 workspace hook  ──►  S11 session controller
B-slices: only after the A-slice covering that code has landed, one per PR
```

- **S1 first:** the highest benefit-to-risk ratio. Pure logic, no React/effect semantics, and it directly protects the product's core promise.
- **S2 and S3 next:** small, low-risk wins that shrink the page without touching realtime ordering.
- **S4 and S5:** isolate provider-specific shapes from domain decisions. This is the main provider/product separation.
- **S7 and S8:** build on S1, concentrating review and completion rules.
- **S9–S11 last:** they move *lifetimes* (refs, timers, effects), which is where mechanical refactors most often change behavior.

---

## 9. Conflicts with the Codex QA harness

**Likely QA changes (inferred):**
- `package.json` and the lockfile (Playwright, maybe Vitest), `playwright.config.*`, `tests/**` or `e2e/**`;
- a fake Live WebSocket server or URL override (likely touching `lib/gemini-live-websocket.ts`'s `LIVE_WEBSOCKET_URL`, or an injected socket factory);
- fake token handling (`app/api/gemini-token/route.ts`) or a test-mode env flag;
- browser audio fakes (`getUserMedia`, `AudioContext`, `AudioWorklet`), possibly via `public/pcm-recorder-worklet.js`;
- `data-testid`s or test hooks in `app/page.tsx` JSX, and possible use of the existing debug buttons (`requestSafeRolloverForTest`, `requestImmediateRolloverForTest`, `TEST_INVALID_ID`) and debug-log text as assertions.

**Do not touch until QA is merged:**
- `app/page.tsx`: all of it, including the JSX (testids) and the debug panel (test buttons).
- `lib/gemini-live-websocket.ts`, `lib/live-transport-manager.ts`, `lib/realtime-audio.ts` (likely fake-injection points).
- `app/api/gemini-token/route.ts`.
- `package.json`, the lockfile, `tsconfig.json`, `next.config.ts`.
- `public/pcm-recorder-worklet.js`.

**Debug-log strings are a hidden contract.** If the harness asserts on `addDebugMessage` text (for example "Teaching beat committed:", "FAREWELL_FLOW", "Interruption registered"), every slice must preserve those strings verbatim. Recommendation to QA: prefer structured test hooks over log text. If log text is used, record the asserted strings in the QA PR so refactor slices can grep for them.

**Safe to do in parallel (docs only):** this plan, and test-case design.

---

## 10. Dead and legacy code candidates

| Candidate | Evidence | Recommendation |
|---|---|---|
| `/api/pdf-source` (377 lines) | No caller in `app/`, `components/`, `lib/`; separate model pool | B6: delete with user approval; it is a public route, so treat it as outward-facing |
| `/api/text-outline` (104 lines) | No in-repo caller | B6, same as above |
| `sourceGroundingPendingRef` | Written 4×, never read | Slice 3 |
| `lastAcousticActivityAtRef` | Written, never read | Slice 3. Keep the RMS/noise-floor computation, which feeds the "Acoustic activity detected" debug log |
| `lastCandidateLearnerActivityAtRef` | Written 5×, never read | Slice 3 |
| `arrayBufferToBase64` export in `lib/realtime-audio.ts` | No importer; the transport has its own private copy | Slice 3 (delete the unused export; do not merge the copies yet) |
| `completeLessonConcept`, `progressLessonTeachingPoint` *exports* | Only used inside `lesson-state.ts` | Keep. They are good test seams. Note: `LessonAction` still includes `progress`/`complete`, which are no longer model-exposed |
| `reviewRecoveryPendingRef`, `persistedResumeFirstResponseLoggedRef` | Diagnostic-only | Keep (QA may use their logs) |
| Dev test buttons and `requestSafeRolloverForTest` / `requestImmediateRolloverForTest` | Dev-only | **Keep.** Likely QA hooks |
| `PreprocessingDiagnostic` (480 lines) | Dev-gated diagnostics | Keep; out of scope |

---

## 11. Abstractions that would be premature

- A generic state-machine library (XState or similar) for lesson/interruption state. The current transitions are few and explicit. A library would obscure the commit guards.
- A provider-agnostic "LLM realtime adapter" interface with plug-in providers. Only Gemini Live exists. Slice 4's normalizer is enough of a seam until a second provider is real.
- An event bus or pub/sub between controllers. Direct calls preserve ordering, which is the most important property here.
- A global store (Redux/Zustand/Context) for lesson state. Ref + state mirroring is deliberate: callbacks read refs synchronously. A store adds async-render semantics around commits.
- A repository layer over IndexedDB and Supabase, or normalizing the `SavedLesson` aggregate. That is out of scope for a refactor, and AGENTS.md says to avoid premature persistence design.
- A server-side session gateway or server-owned processing jobs. That is architecture, not refactor (see gap-analysis §33).
- Splitting `lesson-state.ts` into many files. It is cohesive at 689 lines.

---

## 12. Refactors that look attractive but risk changing behavior

| Tempting change | Why it is risky |
|---|---|
| Replace `lessonStateRef` + `setLessonState` with `useReducer` | Callbacks read the ref synchronously within one message. A reducer delays visibility until render, which breaks same-tick commit/auto-chain and the tool-response assembly |
| Merge `assignNextTeachingBeat` and `assignNextReviewBeat` into one function | Different guards (review blocks lesson assignment), different default prefixes, different debug logs, and lesson activation-after-send only in lesson mode |
| Route all beat assignments through the tool response (or all through realtime text) | Changes provider-visible ordering and when generation starts (§6.6) |
| Unify `exitNodeReview` and `finishNodeReviewAndResume` | Different auto-assign semantics (§6.12) |
| Fix the `useEffect` dependency arrays to satisfy exhaustive-deps | Changes the workspace re-load triggers (§6.9) and autosave cadence |
| Fold `disposeResources` into many per-controller `dispose()` calls early | Easy to drop one of ~40 resets, leaving leaked state into the next run (e.g. `typedInterruptionHandledRef`, `roadmapNavigationPendingRef`) |
| Move interruption de-duplication from the transport into the page or domain | Dedup state (utterance IDs spanning rollover) lives with handoff timing. Separating them risks double `interruptionCount` across rollover (I11) |
| Debounce or coalesce `addDebugMessage` | QA may rely on log ordering. It also changes re-render timing during audio |
| Make `handleLiveMessage` async or split it across microtasks | Same-message ordering (ACTIVITY_START before interrupted) and synchronous commit chains depend on synchronous handling |
| Replace natural-language preference/navigation requests with direct state writes | Product behavior change. The model is meant to acknowledge in conversation |
| Wrap `startConversation` steps in `Promise.all` | The ordering constraints in §4.1 are deliberate |

---

## 13. Slice 1 in detail

**Goal:** move pure beat logic out of `app/page.tsx` without changing a single provider-visible byte or the order of side effects.

**Files likely involved:**
- `app/page.tsx`: types at 128–144; `buildTeachingBeatControl` 499–542; `assignNextTeachingBeat` 544–605; `assignNextReviewBeat` 607–651; `maybeCommitTeachingBeat` 718–788.
- New `lib/teaching-beat-runtime.ts`.
- New unit test file, at the location and runner the QA PR establishes.
- Read-only dependencies: `lib/teaching-delivery.ts`, `lib/lesson-state.ts`.

**Tests that should exist before Slice 1 starts:**

*Unit (characterization of existing pure code):*
1. `isBeatCommitValid`: a truth table where each of the 7 conditions independently blocks a commit.
2. `resolveNextPresentationBeat`: first/middle/final beats, legacy delivery units, out-of-range index → null.
3. `commitDeliveredTeachingBeat`: a non-final beat advances the cursor only; the final beat marks the node `taught`; a beat for a non-current concept is rejected; a duplicate commit is a no-op.
4. `activateNextSequentialConcept`, `isLessonPlanComplete` (including the skipped-counts-as-complete case), `navigateLessonState`, `skipLessonNode`, `pauseLessonState`.
5. `PcmAudioPlayer` batch semantics with a fake `AudioContext`: drain fires only after provider complete *and* all sources end; `cancelBatch`/`clear` suppress drain; zero audio → no drain (pins §6.2).

*Browser (Playwright + fake Live + fake audio):*
6. Startup sends exactly one beat imperative after the `clientContent` seed (I8), for both a new lesson and a persisted resume.
7. Beat commit only after `generationComplete` + playback end; `generationComplete` with playback still pending → no roadmap progress (I4, I5).
8. Barge-in mid-beat (ACTIVITY_START + interrupted in one frame) → cursor unchanged, `interruptionCount` +1, then `query continue` reassigns the same points (I3, I10, I11).
9. Typed reply while speaking behaves the same as barge-in.
10. Non-final beat auto-chains; final-unit beat waits.
11. Review of a taught node leaves canonical progress unchanged and restores the Source Visual on exit (I6, I7).
12. Fresh-socket recovery sends no new imperative (I9).
13. Golden capture of the `TEACH_PRESENTATION_BEAT` control text for lesson-first, lesson-final-with-wrap-up, and review-final. This is the guard against wording drift in Slice 1.

**Acceptance for Slice 1:**
- All of the above pass unchanged.
- `npm run type-check` and `npm run build` pass.
- The fake-Live transcript of sent frames is identical before and after on the scripted scenarios.
- Debug-log strings used by QA are unchanged.

---

## 14. Open questions for the user

1. Should the legacy routes `/api/pdf-source` and `/api/text-outline` be deleted (B6), or kept for some external use?
2. For §6.4 (silence after fresh recovery) and §6.5 (beat split across a resumed socket): are these intended behaviors to pin, or bugs to schedule as B-slices?
3. Does the QA harness assert on debug-log text? If so, those strings become a frozen contract for every slice.
4. Which unit test runner will the QA PR adopt (Vitest / `tsx` + `node:test`)? Slice 1 will follow it rather than add a second runner.
