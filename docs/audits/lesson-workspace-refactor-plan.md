# Slice 10: Lesson Workspace Persistence, Hydration and Cloud Orchestration: Implementation Plan

> **Status:** Analysis only. I changed no production code, test, configuration, or dependency to write this document.
> **Branch:** `agent/claude-workspace-analysis`, base `5c139c2` ("Extract audio session lifecycle"). Slice 9 has landed.
> **Companions:**
> - `docs/audits/refactor-plan.md`: §6.9 and §6.11 latent risks, the original Slice 10 proposal in §7, and invariant I16.
> - `docs/audits/audio-lifecycle-refactor-plan.md`: Slice 9. Its latent behaviors L1–L11 are referenced here as "audio L*n*".
> - `docs/audits/current-architecture-gap-analysis.md`.
>
> **Line references** point to `app/page.tsx` at `5c139c2` (2,796 lines), unless another file is named.
>
> **Baseline when this was written:**
> - `npm run type-check` passed.
> - `npm run test:unit` passed: 11 files, 194 tests.
> - `npx playwright test --list` enumerates 25 tests in 6 files. They were not executed, because the run needs a dev server on port 3100.
> - No Gemini, Supabase, or other provider call was made.
>
> **Behavior intentionally changed by Slice 10: NONE.**

---

## 1. Recommendation in one paragraph

Use a **hybrid** of two pieces:

1. **A React hook, `useLessonWorkspace(input)`, in `lib/use-lesson-workspace.ts`.**
   - It owns workspace identity, persistence metadata, library and cloud UI state, the save and upload timers, and the two generation counters.
   - It contains the two existing effects (workspace load and autosave), moved verbatim with **identical dependency arrays**.
   - It is called at **exactly the position of today's workspace-load effect** (line 1333), so mount and cleanup effect order does not change.
   - Its operations are **plain functions recreated on every render, never `useCallback`'d**. That preserves today's render-closure capture of `learningSource`, `lessonSources`, `topicInput` and `cloudUserId` (refactor-plan §6.11).
2. **A small pure module, `lib/lesson-workspace.ts`**, for the decision logic that today is copy-pasted or inline: the hydration-skip reason, library scoping and diagnostics, the library upsert ordering, and the import candidate. Vitest unit-tests it with no IndexedDB and no Supabase.

Ownership stays split as follows:
- **Canonical `LessonState`, teaching preferences, and recent teaching context stay owned by the page.** That is the session runtime, which Slice 11 will move. The workspace reads and writes them only through refs and setters passed in.
- **Auth identity (`cloudUserId`, `cloudAuthReady`) stays in the page**, because `useLessonProcessingQueue` (line 1256) consumes it before the workspace hook runs.
- **Every session/runtime call into the workspace** (startup generation bump, stop/restart persistence, dispose timer clear) **stays at its current statement position**, as a one-line call into the hook's API.

---

## 2. Inventory: every workspace/persistence responsibility in `app/page.tsx`

### 2.1 Storage used

- **IndexedDB `ai-dialog-tutor` v2, through `lib/local-persistence.ts`** (stores `savedLessons`, `appState`, `processingJobs`).
  - All writes (`saveActiveLesson`, `saveSavedLesson`, `setActiveLessonId`, `deleteSavedLesson`, `clearActiveLessonId`, `updateSavedLessonCloudSync`) are serialized through the module-level `mutationQueue`.
  - **Reads (`loadActiveLesson`, `getSavedLesson`, `listSavedLessons`) are not queued.**
  - **`saveActiveLesson` also rewrites the owner's active-lesson pointer on every save** (`local-persistence.ts:86–108`).
- **`window.localStorage`:** the page never touches it. Appearance (`lib/use-appearance.ts`, the `app/layout.tsx` boot script) and the Source Visual debug flag (`components/source-visual.tsx:211`) use it. Both are outside Slice 10.
- **Supabase, through `lib/cloud-sync.ts`:** `reconcileCloudLessons`, `deleteCloudLesson`, `associateCloudLesson`. All are serialized by `cloud-sync.ts`'s own `serialize()` queue.

### 2.2 React state (lines 245–261)

| State | Line | Category | Writers |
|---|---|---|---|
| `persistenceHydrated` | 245 | persistence metadata, gates UI | load effect `finally` (1396) |
| `persistenceNotice` | 246 | UI-only | start (2099), select (998/1018), new (985), delete (1054), load catch (1391), persist catch (860), queue callbacks (1261, 2604, 2649) |
| `savedLessonId` | 247 | lesson identity (render mirror) | hydrate (943), resetIdle (976) |
| `resumeExistingLesson` | 248 | persisted content (`hasStarted`) mirror | hydrate (944), resetIdle (977), reset progress (910), start success (2381) |
| `savedLessons` | 249 | library view-model | persist (846), select (1009), delete (1047), refresh (1239), synced metadata (752) |
| `lessonLibraryBusyId` | 250 | UI-only | select (999/1021), delete (1033/1061) |
| `cloudUserId` | 251 | **auth identity, stays in page** | `onAuthResolved` (2624) |
| `cloudAuthReady` | 252 | **auth identity, stays in page** | `onAuthResolved` (2625) |
| `cloudSyncState` | 253 | UI-only (cloud) | upload (765/768/785/788), sync (1268/1288/1290), import (1299/1328), load (1355/1359/1361/1365) |
| `cloudLessonCount` | 254 | UI-only (cloud) | upload (784), delete (1044), sync (1276), load (1358/1366) |
| `localOnlyLessonCount` | 255 | UI-only (cloud) | refresh (1240) |
| `topicInput` | 256 | persisted content (`lessonFocus`) | hydrate (942), resetIdle (975), start (2175), `LessonDetail` input (2668) |
| `lessonState` | 257 | **canonical, runtime-owned, stays in page** | ≥ 12 runtime sites, plus hydrate (940), resetIdle (973), reset progress (901) |
| `learningSource` | 260 | persisted content (source metadata) | hydrate (937), resetIdle (971) |
| `lessonSources` | 261 | persisted content (`sources`) | hydrate (938), resetIdle (972) |
| `teachingPreferences` | 238 | persisted content, **runtime-shared, stays in page** | `applyAuthoritativeTeachingPreferences` (729), hydrate (941), resetIdle (974) |
| `restartConfirmationOpen` | 263 | UI-only, session | hydrate (926), resetIdle (960), restart (2513), JSX |

### 2.3 Refs (lines 267–285, 308, 326)

| Ref | Line | Category | Notes |
|---|---|---|---|
| `preparedSourceRef` | 267 | persisted content | Read by start (2102/2113) and reset progress (871). Written only by hydrate and resetIdle |
| `savedLessonIdRef` | 268 | lesson identity (sync) | Read by the test bridge (368), start event (2097), reset debug (912), sync (1273/1278/1280), upload (779), persist (841/851), metadata (755) |
| `savedLessonCreatedAtRef` | 269 | persistence metadata | **Also written by the snapshot builder (818)** |
| `savedLessonUpdatedAtRef` | 270 | persistence metadata | Feeds `previousUpdatedAt` |
| `savedLessonContentSignatureRef` | 271 | persistence metadata | Feeds `previousContentSignature` |
| `savedLessonWasPersistedRef` | 272 | persistence metadata | Chooses "Saved lesson created" vs "Lesson autosaved" |
| `resumeExistingLessonRef` | 273 | persisted content (`hasStarted`) | Read by session at 1874, 2116, 2510 |
| `persistenceAvailableRef` | 274 | persistence metadata | One-way latch to `false` (859, 1390) |
| `persistenceHydratedRef` | 275 | persistence metadata | Read by the test bridge (395), snapshot (811), load (1340) |
| `cloudAuthReadyRef`, `cloudUserIdTestRef`, `transportStateTestRef` | 276–278 | test-bridge mirrors | Render-time writes at 401–403. **Stay in page** |
| `workspaceOwnerIdRef` | 279 | persistence metadata (owner scope) | Set only by the load effect (1350) |
| `cloudOwnerIdRef` | 280 | persistence metadata | Goes into the snapshot's `cloudOwnerId` |
| `cloudSyncMetadataRef` | 281 | persistence metadata | Goes into the snapshot's `cloudSync` |
| `cloudUploadTimersRef` | 282 | timers | Cleared only on owner change (2620) |
| `workspaceLoadGenerationRef` | 283 | **generation counter** | Bumped by load (1337) and start (2109) |
| `lessonHydrationGenerationRef` | 284 | **generation counter** | Bumped by select (1000) and start (2110). Read by load (1379) and sync (1279) |
| `workspaceLoadedRef` | 285 | persistence metadata | `true` at 1388. `false` on owner change (2622) |
| `persistenceSaveTimerRef` | 326 | timer | Cleared by dispose (692/698), new (986), select (1002), delete (1035), autosave cleanup (1412) |
| `recentTeachingContextRef` | 308 | persisted content, **runtime-written, stays in page** | Written by `updateRecentTeachingContext` (803), reset (891), hydrate (927), resetIdle (961) |
| `teachingPreferencesRef` | 328 | persisted content, **runtime-shared, stays in page** | Written by 728, hydrate (928), resetIdle (962) |
| `lessonStateRef` | 303 | canonical, **stays in page** | Written by hydrate (923), resetIdle (957), reset (900) |

### 2.4 Functions

| Function | Lines | Responsibility | Moves? |
|---|---|---|---|
| `applySyncedLessonMetadata` | 751–758 | Cloud metadata into library and the current ref | Yes |
| `scheduleCloudUpload` | 760–793 | Per-lesson 1.2 s debounced reconcile; post-sync reset of a missing lesson | Yes |
| `updateRecentTeachingContext` | 795–808 | Runtime append of a teaching excerpt | **No** (runtime writer of a page ref) |
| `createCurrentLessonSnapshot` | 810–836 | Snapshot construction (delegates to `buildSavedLessonSnapshot`) | Yes |
| `persistLessonSnapshot` | 838–863 | IndexedDB write, metadata refs, library upsert, logs, cloud schedule | Yes |
| `persistCurrentLesson` | 865–868 | Build + persist | Yes (exposed) |
| `resetCurrentLessonProgress` | 870–914 | **Mostly session resets**, then persist | **No.** Calls `workspace.markLessonNotStarted()` and `workspace.persistCurrentLesson()` |
| `hydrateSavedLesson` | 916–952 | Guarded workspace replacement | Yes. Session/UI lines go through a callback (§7.1) |
| `resetIdleLessonWorkspace` | 954–981 | Blank workspace | Yes. Same callback |
| `startNewLessonFlow` | 983–994 | Flush outgoing, reset, navigate | Split. Workspace part moves; `setAppView`/`setLibraryView`/debug stay in a page wrapper |
| `selectSavedLesson` | 996–1023 | Flush outgoing, load, pointer, hydrate | Yes |
| `requestDeleteSavedLesson` | 1025–1063 | Cloud + local delete, reset if current | Yes. `setLibraryView("index")` goes through a callback |
| `refreshScopedLibrary` | 1236–1254 | Owner-scoped library + diagnostics | Yes |
| `syncCurrentAccount` | 1265–1293 | Manual sync, re-hydrate current | Yes |
| `importLocalLessons` | 1295–1331 | Legacy import, then sync | Yes |
| `CloudAccount.onAuthResolved` body | 2617–2626 | Owner-change timer clear and `workspaceLoadedRef` reset, then auth state | Split. Lines 2619–2623 become `workspace.handleAuthResolved(nextUserId)`. The `setCloudUserId`/`setCloudAuthReady` lines stay |
| `CloudAccount.onBeforeSignOut` | 2627–2629 | Persist before sign-out | Becomes `() => workspace.persistCurrentLesson()` |
| `openLesson`, `acknowledgeReadyLessonNotifications` | 2549–2571 | Queue acknowledgement, selection, view | **No** (page navigation). Calls `workspace.selectSavedLesson` |

### 2.5 Effects

| Effect | Lines | Deps | Moves? |
|---|---|---|---|
| Workspace load | 1333–1400 | `[aiConnectionStatus, cloudAuthReady, cloudUserId, microphoneStatus]` | Yes, verbatim, same deps (§10) |
| Autosave | 1402–1427 | `[persistenceHydrated, savedLessonId, learningSource, lessonSources, lessonState.currentNodeId, lessonState.nodes, lessonState.teachingContractProgress, lessonState.resumePoint, lessonState.status, teachingPreferences, topicInput]` | Yes, verbatim, same deps |
| Test bridge | 362–399 | `[]` | **No.** It must read workspace data through **stable ref objects** returned by the hook (§10, H-W5) |
| Mount/visibility/unmount | 1431–1454 | `[]` | **No** |

### 2.6 Session/runtime call sites into the workspace (these stay in place)

| Site | Line | Call |
|---|---|---|
| `disposeResources` timer clear | 692 + 698 | Becomes `workspace.cancelScheduledSave()` at line 692. Line 698 is folded into it (§7.2) |
| `startConversation` reads | 2097, 2099, 2101–2102, 2113–2116, 2123 | `savedLessonIdRef`, `setPersistenceNotice("")`, `learningSource`, `preparedSourceRef`, `topicInput`, `resumeExistingLessonRef`, page `recentTeachingContextRef` |
| `startConversation` generation bump | 2108–2110 | `lessonStartupPendingRef = true` (page), then `workspace.invalidatePendingHydration()`, which bumps load then hydration, in that order |
| `startConversation` topic | 2175 | `workspace.setTopicInput(lessonFocus)` |
| `startConversation` success | 2380–2381 | `workspace.markLessonStarted()` |
| Preference tool | 1857–1859 | Reads `topicInput` and `learningSource` from the **Start-render closure** (§6.11) |
| Session control | 1874 | `workspace.resumeExistingLessonRef.current` |
| `stopConversation` | 2496 | `await workspace.persistCurrentLesson(stoppedLessonState)` |
| `restartLesson` guard | 2510 | `workspace.resumeExistingLessonRef.current` |
| Source Visual props | 2683–2686 | `lessonSources`, `savedLessonId` (workspace); `cloudUserId`, `cloudAuthReady` (page) |
| Processing queue | 1256–1263 | `ownerId: cloudUserId` (page); `onLessonReady` calls `workspace.refreshScopedLibrary(workspace.workspaceOwnerIdRef.current, "processing-ready")` and `workspace.setPersistenceNotice(...)` |

---

## 3. Authoritative state boundary

| Class | Members | Owner after Slice 10 |
|---|---|---|
| **Canonical lesson state** | `LessonState`: `topic`, `nodes` (coverage status), `rootNodeIds`, `currentNodeId`, `status`, `teachingContractProgress` (delivery cursor), `resumePoint`, `interruptionCount`, and the transcript fields, which are **blanked in snapshots** | Page/session runtime (`lessonState` + `lessonStateRef`). The workspace **snapshots** it (reads the ref or an override) and **replaces** it on hydrate/reset through the passed ref and setter |
| **Persisted lesson content outside `LessonState`** | `preparedSource`, `learningSource` metadata, `lessonSources`, `topicInput` (`lessonFocus`), `hasStarted` (`resumeExistingLesson`) | **Workspace** |
| **Persisted content, runtime-written** | `recentTeachingContext`, `teachingPreferences` | **Page.** Their refs, plus the preference state and setter, are passed into the hook |
| **Lesson identity** | `savedLessonId` + `savedLessonIdRef` | Workspace |
| **Persistence metadata** | `createdAt`/`updatedAt`/signature/`wasPersisted` refs, `persistenceAvailableRef`, `persistenceHydrated` + ref, `workspaceOwnerIdRef`, `cloudOwnerIdRef`, `cloudSyncMetadataRef`, `workspaceLoadedRef`, both generation refs, the save timer, the upload-timer map | Workspace |
| **Workspace UI state** | `savedLessons`, `lessonLibraryBusyId`, `persistenceNotice`, `cloudSyncState`, `cloudLessonCount`, `localOnlyLessonCount` | Workspace |
| **Auth identity** | `cloudUserId`, `cloudAuthReady` | Page (inputs to the hook) |
| **Page navigation UI** | `appView`, `libraryView`, `restartConfirmationOpen` | Page. The workspace reaches them only through callbacks |
| **Session runtime, never persisted** | `lessonActiveRef`, `lessonStartupPendingRef`, `conversationRunRef`, `generationEpochRef`, the active/presentation beat, `nodeReviewRef`, `lessonWrapUpRef` (re-derived on start), `closingTurnRef`, transcript refs, engagement, mute, transport, `AudioSession` | Page. The workspace **reads** `lessonActiveRef` and `lessonStartupPendingRef` and writes none of these |

**Hydration blocking (I16)** is the rule that the workspace refuses to replace the lesson while `lessonActiveRef || lessonStartupPendingRef`. Both refs are session-owned. Pass the two ref objects, not booleans and not an `isHydrationBlocked()` closure: the skip-reason string distinguishes them, and the read must happen at the same instant as today.

---

## 4. Every async operation and its stale-work guard

Notation: "guard" means a check performed before continuing. "Unguarded" means the continuation runs whatever happened in between.

### 4.1 Workspace load effect (1333–1400)

| Step | Await | Guard before | Guard after | Latent behavior to preserve |
|---|---|---|---|---|
| entry | — | `cloudAuthReady && !lessonActiveRef && !lessonStartupPendingRef`, then `!(workspaceLoadedRef && workspaceOwnerIdRef === cloudUserId)`, then `generation = ++workspaceLoadGenerationRef` | — | Guards read **refs** at effect time. The deps are re-trigger signals only (§6.9) |
| a1 | `persistLessonSnapshot(outgoing)` (only if `persistenceHydratedRef`) | — | generation, active, startup → log `Stale workspace hydration skipped: reason=…` and return | When `persistenceHydratedRef` is false there is **no await**: the whole prefix up to a3 runs synchronously inside the effect (see H-W1) |
| sync | — | — | — | `resetIdleLessonWorkspace()`, then `workspaceOwnerIdRef = ownerId`, `cloudOwnerIdRef = ownerId`, `cloudSyncMetadataRef = undefined` |
| a2 | `reconcileCloudLessons({ userId })` (owner only; own try/catch) | — | **none**. Sets `cloudLessonCount` and `cloudSyncState` (`"synced"` regardless of `deferred`) | LW5: a stale load still writes cloud UI state |
| check | — | — | generation only. **Silent** return (no log) | — |
| a3 | `Promise.all([loadActiveLesson(ownerId), refreshScopedLibrary(ownerId, "workspace-restore")])` | — | none for the library: `refreshScopedLibrary` writes `savedLessons` and `localOnlyLessonCount` inside itself. `"IndexedDB opened"` is logged unguarded | LW5 |
| a4 | `clearActiveLessonId(ownerId)` (incompatible schema) | — | none | LW5 |
| hydrate | — | `hydrationGeneration` is captured **after** a3, then generation, owner, active and startup are checked, then `hydrateSavedLesson(lesson, hydrationGeneration)` | — | LW4: the late capture does not protect against a selection made during a1–a3 |
| end | — | — | `workspaceLoadedRef = true`, **even when the restored branch was skipped as stale** | LW5 |
| catch | — | — | `persistenceAvailableRef = false`, notice, debug | — |
| finally | — | — | `if (generation === current) { persistenceHydratedRef = true; setPersistenceHydrated(true) }` | — |

### 4.2 The other operations

| ID | Operation | Await points | Guard(s) | Latent behavior to preserve |
|---|---|---|---|---|
| W2 | Autosave timer (1407) | Timer 600 ms, then `persistLessonSnapshot` | The snapshot is built **at effect time** from that render's values (1404). No guard at fire time | LW9, LW11, LW13 |
| W3 | `persistLessonSnapshot` | `saveActiveLesson` | After the await: `savedLessonIdRef === snapshot.id` before updating `updatedAt`/signature/`wasPersisted`; `snapshot.cloudOwnerId === workspaceOwnerIdRef` (read **now**) before the library upsert. `scheduleCloudUpload` uses the **closure** `cloudUserId` | Errors latch `persistenceAvailableRef = false` (LW19) |
| W4 | `scheduleCloudUpload` timer (1.2 s per id) | Timer, `reconcileCloudLessons`, `getSavedLesson`, `clearActiveLessonId`, `refreshScopedLibrary` | Entry: `ownerId && ownerId === cloudUserId` (closure). At fire: `deferDownloadLessonId = lessonActiveRef ? id : null`. Reset branch: `!lessonActiveRef && !lessonStartupPendingRef && savedLessonIdRef === id`. **No generation or owner guard** | LW12, LW20. Not cleared on unmount (LW11) |
| W5 | `selectSavedLesson` | Persist outgoing, `getSavedLesson`, `setActiveLessonId` | Entry: `!lessonActiveRef && !lessonLibraryBusyId` (render state). `hydrationGeneration = ++…` is captured **before** the awaits; `hydrateSavedLesson` checks it plus active/startup | LW2, LW3 |
| W6 | `requestDeleteSavedLesson` | `window.confirm` (sync), `deleteCloudLesson`, `deleteSavedLesson` | Entry only: `!lessonActiveRef && !lessonLibraryBusyId`, then cloud-owner check against the closure `cloudUserId`. **After the awaits, `resetIdleLessonWorkspace()` runs without re-checking active/startup** | LW1, LW20 |
| W7 | `syncCurrentAccount` | `persistCurrentLesson`, reconcile, `refreshScopedLibrary`, `getSavedLesson`, `clearActiveLessonId` | Entry: `ownerId (ref) && ownerId === cloudUserId (closure)`. `hydrationGeneration` is captured just before `getSavedLesson`. Reset branch checks active/startup. No owner or load-generation guard | LW12, LW22 |
| W8 | `importLocalLessons` | `listSavedLessons`, then per lesson `associateCloudLesson`, `saveSavedLesson`, `deleteSavedLesson`, then `clearActiveLessonId(null)`, then W7 | Entry: owner, `!lessonActiveRef`, `window.confirm` | LW15 |
| W9 | `onBeforeSignOut` | `persistCurrentLesson` | none | Uses `cloudOwnerIdRef` (the current owner) |
| W10 | Queue `onLessonReady` | `refreshScopedLibrary(workspaceOwnerIdRef)` | none | LW16 |
| W11 | `startNewLessonFlow` | `void persistLessonSnapshot(outgoing)` (**not awaited**) | Entry: `!lessonActiveRef` | LW8 |
| W12 | `stopConversation` persist | `persistCurrentLesson(stoppedLessonState)` | The run was already bumped (session) | Mic and player are still alive during this await (audio §5.4) |
| W13 | `resetCurrentLessonProgress` persist | `persistCurrentLesson(freshState)` | none | Persists `hasStarted: false` |

**Generation and ordering mechanisms involved:**
- `workspaceLoadGenerationRef`.
- `lessonHydrationGenerationRef`.
- `lessonActiveRef` / `lessonStartupPendingRef` (session, I16).
- `local-persistence`'s `mutationQueue` (write order = call order).
- `cloud-sync`'s `serialize()` queue.
- `useLessonProcessingQueue`'s private `ownerEpochRef` (not touched).

`conversationRunRef` is **not** used by any workspace operation, and Slice 10 must not introduce it there.

---

## 5. Exact hydration ordering

### 5.1 Mount (production, Supabase not configured, which is also the e2e setup)

```
render 1: cloudAuthReady = true (initial !isSupabaseConfigured()), cloudUserId = null, persistenceHydrated = false
effects, in declaration order:
  1. test bridge install (362)
  2. useAppearance effects (423)
  3. pending-preference sync (732)
  4. useLessonProcessingQueue owner effect (1256 → use-lesson-processing-queue.ts:83) → listProcessingJobs(null)
  5. workspace load (1333): generation=1; persistenceHydratedRef=false → NO await →
       resetIdleLessonWorkspace(); owner refs = null; setCloudSyncState("local-only"); setCloudLessonCount(0);
       Promise.all(loadActiveLesson(null), refreshScopedLibrary(null,"workspace-restore"))   ← first await
  6. autosave (1402): returns early (persistenceHydrated false)
  7. usePwaInstall effects (1429)
  8. mount effect (1431): isMountedRef = true, visibilitychange listener
async:
  a3 resolves → "IndexedDB opened" → restored → hydrate(lesson, hydrationGen) → "Restored saved lesson: <id>"
  → workspaceLoadedRef = true → finally: persistenceHydrated = true
render: autosave effect runs (persistenceHydrated, savedLessonId, learningSource… changed) → snapshot built now →
  600 ms → persistLessonSnapshot (same content ⇒ updatedAt kept) → "Lesson autosaved" → scheduleCloudUpload (no-op: no owner)   [LW7]
```

**The hook must be called where line 1333 is now.** Effect step 5 must stay after the queue effect (4) and before autosave (6), the PWA effects (7) and the mount effect (8).

### 5.2 Mount in development (React StrictMode: mount → cleanup → mount)

Next's App Router enables StrictMode, and `next.config.ts` is `{}`. The e2e suite runs `npm run dev`, so **every e2e run exercises this path**.

1. Run 1 executes step 5 synchronously up to the a3 `await` (generation 1).
2. StrictMode cleanup: the load effect has none. The autosave cleanup clears a null timer. The mount cleanup runs `isMountedRef = false`, `conversationRunRef += 1`, `void disposeResources(false)`.
3. Run 2: `workspaceLoadedRef` is still false, so generation becomes 2. It does a second `resetIdleLessonWorkspace`, a second `refreshScopedLibrary` (a second "Library refreshed: reason=workspace-restore" log), and a second `loadActiveLesson`.
4. Run 1's a3 resolves: "IndexedDB opened", then "Stale workspace hydration skipped: reason=request-stale", then `workspaceLoadedRef = true`. Its `finally` does nothing.
5. Run 2's a3 resolves: hydrate, "Restored saved lesson", then `persistenceHydrated = true`.

This double run is the current dev behavior (LW6). **Do not add an effect cleanup or a `cancelled` flag.** Either would change the log stream and the stale-run side effects.

### 5.3 Mount with Supabase configured

- `cloudAuthReady` starts `false`, so the load effect returns at entry and the spinner (2598) stays up.
- `CloudAccount`'s effect calls `supabase.auth.getUser()`. On resolve it calls `authResolvedRef.current(user)`, the page callback from the **latest committed render** (`cloud-account.tsx:59–62, 83–86`).
- The callback runs: `workspaceOwnerIdRef (null) !== userId` ⇒ clear upload timers and set `workspaceLoadedRef = false`. Then `setCloudUserId`, then `setCloudAuthReady(true)`.
- Re-render ⇒ the load effect runs: reset, owner refs, a2 initial reconciliation (network), generation check, a3, hydrate.
- **`CloudAccount` must stay mounted while hidden** (2613 uses `hidden`, not conditional rendering). Otherwise auth never resolves and the workspace never loads.

### 5.4 Owner switch (sign-in or sign-out after hydration)

1. `onAuthResolved(next)`: if `workspaceOwnerIdRef !== next`, clear upload timers and set `workspaceLoadedRef = false`. Then set the auth state.
2. Load effect: `persistenceHydratedRef` is true ⇒ **a1: persist the outgoing lesson under the old `cloudOwnerIdRef`**. Guard (generation/active/startup). Reset. Owner refs = next. a2 (if signed in). Generation check. a3. Hydrate the new owner's active lesson, or leave it blank.
3. `persistenceHydrated` **stays true** throughout (LW17). The previous owner's library stays visible and interactive until a3 replaces it.

### 5.5 Lesson selection (`openLesson` → `selectSavedLesson`)

```
openLesson: acknowledgeReadyLessonNotifications(id) (void discards of ready jobs)
selectSavedLesson:
  1. guard !lessonActiveRef && !lessonLibraryBusyId(render)          [LW2]
  2. setPersistenceNotice(""); setLessonLibraryBusyId(id)
  3. hydrationGeneration = ++lessonHydrationGenerationRef
  4. clear autosave timer
  5. outgoing = createCurrentLessonSnapshot()  (closure values) → await persistLessonSnapshot(outgoing)
        ↳ also rewrites the active pointer to the OUTGOING id, then logs "Lesson autosaved", then scheduleCloudUpload(outgoing)
  6. saved = await getSavedLesson(id) → missing/owner mismatch ⇒ setUserError + drop from list + return
  7. await setActiveLessonId(id, workspaceOwnerIdRef)                [LW3: written before hydration can refuse]
  8. hydrateSavedLesson(saved, hydrationGeneration) → false ⇒ return silently (the skip was logged inside)
  9. "Saved lesson selected: id", "Active lesson changed: id", window.scrollTo
  finally: setLessonLibraryBusyId(null)
openLesson: setAppView("library"); setLibraryView("lesson")   (even on failure/refusal)  [LW3]
render → autosave effect → 600 ms → re-save of the hydrated lesson                         [LW7]
```

### 5.6 Hydration inside `syncCurrentAccount` and after a cloud upload

- **Sync** (W7): after reconciliation and the library refresh, if `!lessonActiveRef && savedLessonIdRef`, capture the generation, `getSavedLesson`, then hydrate if the owner matches, otherwise run the guarded reset plus `clearActiveLessonId`. It re-hydrates **even when nothing changed** (LW22).
- **Upload** (W4): the upload never hydrates. It only updates `cloudSync` metadata (`applySyncedLessonMetadata`), or runs the guarded reset when the lesson disappeared.

### 5.7 `hydrateSavedLesson` internal order (916–952)

1. Guard, then the skip log.
2. Refs: `preparedSourceRef`, `lessonStateRef`, then [**session**: `lessonWrapUpRef = false`, `conversationalRestartConfirmationRef = false`, `setRestartConfirmationOpen(false)`], then `recentTeachingContextRef`, `teachingPreferencesRef`, the `savedLesson*` refs, `cloudOwnerIdRef`, `cloudSyncMetadataRef`, `resumeExistingLessonRef`.
3. Setters: `setLearningSource`, `setLessonSources`. Then one "Source restored from cloud metadata: source=…" log per source. Then `setLessonState`, `setTeachingPreferences`, `setTopicInput`, `setSavedLessonId`, `setResumeExistingLesson`.
4. [**session**: `presentationBeatRef = null`, `setPresentationBeat(null)`], then `setUserError("")`.
5. "Restored resume teaching context: entries=N". Return `true`.

`resetIdleLessonWorkspace` (954–981) follows the same shape. It has no logs, and it sets `cloudOwnerIdRef = workspaceOwnerIdRef` (the **old** owner when called from the load effect; the load effect overwrites it two lines later).

---

## 6. Exact persistence ordering

### 6.1 Normal progress during a lesson

1. Runtime commit: `lessonStateRef = s; setLessonState(s)`.
2. Render. The autosave effect cleanup clears the previous timer. The new run builds the snapshot **now**: it calls `createCurrentLessonSnapshot()`, which can initialize `savedLessonCreatedAtRef`, and schedules 600 ms.
3. The timer fires: `persistLessonSnapshot` → `saveActiveLesson` (record + pointer) → metadata refs → library upsert (sorted by `updatedAt` descending) → "Lesson autosaved" → `scheduleCloudUpload`.
4. With a signed-in owner equal to the closure `cloudUserId`: `cloudSyncState = "pending"`. After 1.2 s, reconcile with `deferDownloadLessonId = id` (lesson active), then `getSavedLesson`, then `applySyncedLessonMetadata`, then `refreshScopedLibrary`, then the counts, then `"pending"` if deferred, otherwise `"synced"`.

Autosave triggers are exactly the 11 dependencies listed in §2.5.
- Review never changes them: the review cursor is session-only.
- `resumeExistingLesson` is not a dependency, but `status → "teaching"` at startup is, so `hasStarted: true` lands through that.

### 6.2 `stopConversation` (2453–2507)

1. Run bump, invalidate the beat, `player.clear()`.
2. Checkpoint, then `updateRecentTeachingContext`, then `pauseLessonState`. Set mic and AI status. Write `lessonStateRef`, call `setLessonState`. Log debug.
3. **`await persistCurrentLesson(stoppedLessonState)`**. The snapshot uses the **closure** `learningSource`/`lessonSources`/`topicInput` of whichever render created this `stopConversation`. For farewell, idle and session-control ends, that is the Start render, through the transport closure.
   - While this await is pending, React renders. The autosave effect schedules **another** save of the same paused content, and the load effect re-runs on the status changes but returns early, because `lessonActiveRef` is still true (LW14).
4. **`await disposeResources(true)`**. After three awaits (streamer stop, player close, wake-lock release) it clears `persistenceSaveTimerRef` (692/698). Whether the duplicate autosave from step 3 is cancelled or written (same content, so `updatedAt` is unchanged and a "Lesson autosaved" log appears) depends on timing. Preserve.

### 6.3 Lesson switch (selection)

See §5.5. The outgoing lesson is persisted and **awaited** before the incoming one is read.

### 6.4 New lesson flow

`!lessonActiveRef`, then `setPersistenceNotice("")`, clear the timer, `void persistLessonSnapshot(outgoing)` (**not awaited**), `resetIdleLessonWorkspace()`, then the page's `setAppView("library")`, `setLibraryView("new")`, and "New lesson setup opened".

When the outgoing write lands, `savedLessonIdRef` is already null, so the metadata refs are not updated. Because the snapshot carries the old owner, the library upsert still happens, and the **active pointer now names the outgoing lesson** (LW8).

### 6.5 Restart and reset (`restartLesson`, 2509–2521; conversational restart through `restartActiveLessonRef` + 250 ms, 2060)

1. `restartPendingRef`, then close the confirmation.
2. If active: `await stopConversation()` (all of §6.2).
3. `await resetCurrentLessonProgress()`:
   - session resets;
   - `recentTeachingContextRef = []`;
   - `lessonStateRef`/`setLessonState(fresh)`;
   - `resumeExistingLessonRef = false` + `setResumeExistingLesson(false)`;
   - **`await persistCurrentLesson(freshState)`**, which persists `hasStarted: false` and the fresh state;
   - "Completed lesson progress reset: lesson=…".
4. `await startConversation()`: generation bumps, then `setTopicInput(trimmed)`, then on success `markLessonStarted`. The autosave then persists `hasStarted: true` / `status: "teaching"`.

`resetCurrentLessonProgress` returns `false` (no start) when `preparedSourceRef` is null.

### 6.6 Delete (current lesson)

1. Confirm. Busy flag.
2. If current: clear the autosave timer. **The cloud upload timer is not cleared** (LW20).
3. If the lesson is cloud-owned: check `cloudOwnerId !== cloudUserId` (closure) ⇒ throw; otherwise `await deleteCloudLesson` and decrement the count.
4. `await deleteSavedLesson` (record + every pointer to it).
5. Library filter.
6. If current: `resetIdleLessonWorkspace()` + `setLibraryView("index")` (LW1: no re-check of `lessonActiveRef`).
7. Log.

### 6.7 Unmount

Cleanups run in declaration order:
- Autosave cleanup **clears the pending save without flushing** (LW11).
- Mount cleanup: `isMountedRef = false`, run bump, `void disposeResources(false)`, which clears the timer again.
- **Cloud upload timers are not cleared.** A pending reconcile fires after unmount (LW11).
- In-flight IndexedDB promises still resolve. Their `setState` calls are no-ops on an unmounted component, and `addDebugMessage` is gated by `isMountedRef`.

### 6.8 Cloud synchronization

| Trigger | Sequence |
|---|---|
| Initial / owner switch | Load effect a2 (§4.1). `"synced"` on success even when deferred > 0 |
| Every local save (owner signed in) | W4 (§6.1 step 4) |
| "Sync now" | W7: persist current, reconcile (`defer = lessonActive ? currentId : null`), count, refresh, re-hydrate current or reset, then `"pending"`/`"synced"` |
| Import | W8, then W7 |
| Sign-out | W9 `persistCurrentLesson`, then `supabase.auth.signOut()`, then `onAuthStateChange(null)`, then §5.4 |

---

## 7. What moves and what must stay

### 7.1 Moves into `useLessonWorkspace` (verbatim bodies, same debug strings)

- **State:** `persistenceHydrated`, `persistenceNotice`, `savedLessonId`, `resumeExistingLesson`, `savedLessons`, `lessonLibraryBusyId`, `cloudSyncState`, `cloudLessonCount`, `localOnlyLessonCount`, `topicInput`, `learningSource`, `lessonSources`.
- **Refs:** `preparedSourceRef`, `savedLessonIdRef`, `savedLessonCreatedAtRef`, `savedLessonUpdatedAtRef`, `savedLessonContentSignatureRef`, `savedLessonWasPersistedRef`, `resumeExistingLessonRef`, `persistenceAvailableRef`, `persistenceHydratedRef`, `workspaceOwnerIdRef`, `cloudOwnerIdRef`, `cloudSyncMetadataRef`, `cloudUploadTimersRef`, `workspaceLoadGenerationRef`, `lessonHydrationGenerationRef`, `workspaceLoadedRef`, `persistenceSaveTimerRef`.
- **Functions:**
  - `applySyncedLessonMetadata`, `scheduleCloudUpload`, `createCurrentLessonSnapshot`, `persistLessonSnapshot`, `persistCurrentLesson`, `hydrateSavedLesson`, `resetIdleLessonWorkspace`;
  - the workspace half of `startNewLessonFlow`;
  - `selectSavedLesson`, `requestDeleteSavedLesson`, `refreshScopedLibrary`, `syncCurrentAccount`, `importLocalLessons`;
  - the `onAuthResolved` owner-change block.
- **Effects:** workspace load and autosave, in that order, with their dependency arrays copied character for character.

**Session/UI lines inside `hydrateSavedLesson`/`resetIdleLessonWorkspace`** (`lessonWrapUpRef`, `conversationalRestartConfirmationRef`, `setRestartConfirmationOpen`, `presentationBeatRef`, `setPresentationBeat`) become one call, `input.onWorkspaceReplaced()`. That is the **only** permitted reordering in the slice. It is unobservable because:
- hydrate is fully synchronous;
- nothing reads those refs between the writes;
- the React setters batch into one render;
- no debug message sits between the old and new positions.

Place the call where the first of those lines is today (after `lessonStateRef`), and keep `setUserError("")` and the `presentationBeat` writes inside the callback, in that same relative order.

### 7.2 Must stay in `app/page.tsx`

| Stays | Why |
|---|---|
| `lessonState`/`lessonStateRef`/`updateLessonState`, `teachingPreferences` + ref + `applyAuthoritativeTeachingPreferences`, `pendingTeachingPreferences` effect, `recentTeachingContextRef` + `updateRecentTeachingContext` | Runtime-owned and written synchronously inside `handleLiveMessage`. Moving them changes same-tick commit visibility (refactor-plan §12) and is Slice 11's job |
| `cloudUserId`/`cloudAuthReady` state, `cloudAuthReadyRef`/`cloudUserIdTestRef` render mirrors (401–402) | `useLessonProcessingQueue` (1256) needs `cloudUserId` before the workspace hook runs. Calling the workspace hook earlier would reorder mount effects (§5.1) |
| Test bridge effect (362) | `[]` deps. It reads `workspace.savedLessonIdRef` and `workspace.persistenceHydratedRef` (stable ref objects) |
| `startConversation` lines 2108–2110 | `lessonStartupPendingRef = true` **then** `workspace.invalidatePendingHydration()`, which must do `workspaceLoadGenerationRef += 1` then `lessonHydrationGenerationRef += 1`. Same position, synchronous, before any await (audio S-1) |
| `startConversation` 2380–2384 | `workspace.markLessonStarted()` (ref then setter), then "Lesson started", then `lessonActiveRef = true`, then `lessonStartupPendingRef = false`. Order unchanged |
| `startConversation` `finally { lessonStartupPendingRef = false }` | Session (audio L2) |
| `disposeResources` 692/698 | Replace with one `workspace.cancelScheduledSave()` at line 692 (`if (t) clearTimeout(t); ref = null`). It must stay **after** `await audioSession.releaseWakeLock()` and before the engagement resets, so LW13 timing is unchanged |
| `stopConversation` (whole) | Session ordering (audio §5.4). Only line 2496 becomes `workspace.persistCurrentLesson(...)` |
| `resetCurrentLessonProgress` (whole) | ~30 session resets. Only 909–911 become `workspace.markLessonNotStarted(); await workspace.persistCurrentLesson(freshState);` |
| `restartLesson`, `restartActiveLessonRef` | Session |
| `openLesson`, `acknowledgeReadyLessonNotifications`, `navigateProduct`, the `startNewLessonFlow` wrapper, `appView`/`libraryView` | Page navigation |
| `useLessonProcessingQueue` call (1256) | Unchanged position and options |
| `CloudAccount` element, always mounted under `hidden` | §5.3 |

---

## 8. Use of `lib/lesson-snapshot.ts`

- `buildSavedLessonSnapshot` stays the **only** place that defines the snapshot shape, transcript stripping, ready-metadata forcing, deep cloning, and `updatedAt` stability. The hook's `createCurrentLessonSnapshot` keeps doing only three things:
  1. the guards: `persistenceAvailableRef`, `persistenceHydratedRef`, id/prepared/source-ready;
  2. the `createdAt` initialization side effect (`savedLessonCreatedAtRef = createdAt`);
  3. the input assembly.
- The hook must call **`getSavedLessonContentSignature`** from `local-persistence.ts` exactly where it is called today (843 after persist, 932 in hydrate). Do not compute signatures inside the snapshot module or in the pure workspace module.
- `getPersistedResumeContext`/`createRecentTeachingExcerpt`/`appendRecentTeachingContext` are session-side (startup, runtime) and are not touched.
- **Do not** add a second "snapshot from workspace" helper to `lesson-snapshot.ts`, or a variant that reads refs. Inputs stay explicit.

---

## 9. Cloud/local separation, and testing without Supabase

1. **Imports stay at module level in the hook:**
   - `local-persistence` (`clearActiveLessonId`, `deleteSavedLesson`, `getSavedLesson`, `getSavedLessonContentSignature`, `listSavedLessons`, `loadActiveLesson`, `saveActiveLesson`, `saveSavedLesson`, `setActiveLessonId`);
   - `cloud-sync` (`associateCloudLesson`, `createCloudCompatibleLessonId`, `deleteCloudLesson`, `isUuid`, `reconcileCloudLessons`).

   Neither library file changes.
2. **Every cloud call is already behind an owner check.** `scheduleCloudUpload`, `syncCurrentAccount` and `importLocalLessons` require a non-null owner equal to `cloudUserId`. The load effect calls reconcile only `if (ownerId)`. Delete calls cloud only for a lesson with a `cloudOwnerId`.
   - The e2e config blanks `NEXT_PUBLIC_SUPABASE_*`, so `cloudUserId` is always null in e2e and **no cloud function is reachable**.
   - Add an e2e guard that fails on any non-same-origin request (§13 P12) to pin this.
3. **Extract the pure cloud decisions** into `lib/lesson-workspace.ts` and unit-test them in Vitest (node), with no mocks of Supabase:
   - `upsertLibraryLesson(current, snapshot)`: the filter, prepend and `updatedAt` descending sort from 846–849;
   - `scopeLibrary(library, ownerId)`, returning `{ scoped, localOnlyCount }` (1238–1242);
   - `libraryRefreshDiagnostics(scoped, reason)`, returning the exact ordered debug strings (1243–1252);
   - `cloudSyncStateAfterSummary(summary)`, returning `deferred > 0 ? "pending" : "synced"`. Use it **only** at 785 and 1288. The initial reconciliation (1359) keeps its unconditional `"synced"`;
   - `createImportCandidate(lesson, ownerId, newId)` (1304–1310);
   - `workspaceHydrationSkipReason(lessonActive, startupPending)`, returning `"lesson-active" | "startup-pending" | "request-stale"`. It replaces the three copies at 919, 1346, 1383; each caller keeps its own `Stale workspace hydration skipped: reason=${…}` template.
4. **Optional, not recommended in Slice 10:** an injectable `io` parameter that defaults to the real modules. A hook cannot be unit-tested in this repo without adding `@testing-library/react` + `jsdom` (new dependencies, against AGENTS.md), so injection would add API surface with no test using it. Revisit in Slice 11, if the session controller becomes a plain class that composes a workspace controller.
5. **Cloud orchestration is not covered by any automated test today.** The review checklist (§14, step 11) is the safeguard for the cloud branches. A user-run manual pass against a real Supabase project is listed as optional QA. I did not run it.

---

## 10. StrictMode and effect-cleanup hazards

- **H-W1. Synchronous prefix of the load IIFE.** When `persistenceHydratedRef` is false, the IIFE runs reset, owner refs, and the cloud-state writes **synchronously inside the effect**. Any refactor that adds an `await` before that point (for example, `await` on a helper, or making the guard async) changes the StrictMode interleaving and the log stream in §5.2.
- **H-W2. No new cleanups.** The load effect has no cleanup. Adding one (abort, `cancelled = true`) would fix LW5/LW6, which is a behavior change. The autosave cleanup must remain "clear the timer, null the ref", with no flush.
- **H-W3. Dependency arrays are contracts.** Copy them verbatim, including `aiConnectionStatus`/`microphoneStatus` (refactor-plan §6.9) and the five individual `lessonState.*` fields, not `lessonState`. Using the whole object would add autosaves on transcript-only changes. No lint rule enforces this (there is no ESLint in the repo), so review must.
- **H-W4. Hook call position.** The hook must be called after `useLessonProcessingQueue` and before `usePwaInstall`/the mount effect. Calling it earlier would move its effects ahead of the queue's owner effect, `useAppearance` and the preference sync. That reorders IndexedDB opens and debug lines on mount and owner change.
- **H-W5. Stable identities.**
  - The test bridge has `[]` deps, and `CloudAccount` stores `onAuthResolved` in a ref that is updated **in an effect**, so it calls the previous committed render's closure. Everything those long-lived consumers read must be a ref object returned by the hook (`savedLessonIdRef`, `persistenceHydratedRef`, `workspaceOwnerIdRef`) or a function that reads only refs (`handleAuthResolved`).
  - `handleAuthResolved` reads only refs (`workspaceOwnerIdRef`, `cloudUploadTimersRef`, `workspaceLoadedRef`), so a stale closure is harmless, exactly as today.
- **H-W6. Do not memoize operations.** `useCallback`/`useMemo` on `persistCurrentLesson`, `createCurrentLessonSnapshot`, `scheduleCloudUpload`, `syncCurrentAccount`, `requestDeleteSavedLesson`, `importLocalLessons` or `selectSavedLesson` would change which render's `learningSource`/`lessonSources`/`topicInput`/`cloudUserId`/`lessonLibraryBusyId` they capture (LW10).
  - Long-lived session closures, such as the transport `onMessage` created in `startConversation`, must keep calling the workspace object **of the render that created them**. That happens naturally if the page reads `workspace.x` inside those closures, because `workspace` is a per-render `const`.
- **H-W7. Do not mirror render values into refs** (for example `learningSourceRef.current = learningSource` during render) to make operations "fresher". That is the §6.11 behavior change.
- **H-W8. TDZ is safe but non-obvious.** Page functions defined above the hook call (`disposeResources` at 653, `resetCurrentLessonProgress` at 870, the test bridge at 362) will reference the later-declared `const workspace`. That is valid because each is invoked only after render completes. **Nothing may call into `workspace` during the render body above the hook call.**
- **H-W9. Timers survive StrictMode.** The upload-timer map and the save-timer ref live in `useRef` and persist across StrictMode's simulated unmount, as today. Do not move them to module scope.
- **H-W10. `isMountedRef`** stays in the page. The hook's `addDebugMessage` input is the page's callback, which already checks `isMountedRef`. The hook must not add its own mounted flag.

---

## 11. Interactions

| Area | Interaction | Slice 10 rule |
|---|---|---|
| **Slice 9 `AudioSession`** | None directly. `disposeResources` clears the autosave timer only after `stopStreamer`, `closePlayer` and `releaseWakeLock` | Keep `cancelScheduledSave()` at line 692's position (LW13) |
| **`conversationRunRef`** | Not used by the workspace. `stopConversation` bumps it before persisting | Do not add run guards to workspace operations |
| **Session startup** | Reads workspace values from the Start render. Sets `lessonStartupPendingRef`, then bumps both generations. `setTopicInput(trimmed)`. `markLessonStarted` on success. `finally` clears startup-pending even for stale runs (audio L2), which can unblock hydration for a newer pending startup (weakens I16) | Keep call order. Do not move `lessonStartupPendingRef` into the hook |
| **Recovery** | `seedFreshRecovery` uses `preparedSource`/`lessonFocus` **captured at startup**, plus `lessonStateRef`/`teachingPreferencesRef`. Hydration is refused while active, so these cannot diverge | No change |
| **Review** | The review cursor is not persisted, and canonical state does not change, so autosave does not fire. Stop during review persists canonical state. Dispose resets `nodeReviewRef` | No change. The hydrate callback does not touch review |
| **Restart lesson** | §6.5. Persist paused state, then persist fresh state (`hasStarted: false`), then start. iOS gesture loss on restart (audio L8) is unrelated to the workspace | Keep both awaits in `restartLesson`/`resetCurrentLessonProgress` |
| **Source Visual** | Props: `sources = lessonSources` (workspace state; identity changes only on hydrate/reset), `lessonId = savedLessonId`, `cloudOwnerId = cloudUserId` (**auth user, not the lesson owner**, LW16), `authReady = cloudAuthReady` | Return `lessonSources` by identity; never copy or memo-wrap it. Prop wiring unchanged |
| **Lesson processing queue** | `ownerId = cloudUserId` (page). `onLessonReady` calls `refreshScopedLibrary(workspaceOwnerIdRef.current, "processing-ready")` and sets the notice. `ProcessingQueue` UI callbacks call `setPersistenceNotice`. `openLesson` acknowledges ready jobs, then selects | Queue hook position and options unchanged. Callbacks call `workspace.*` |
| **I16** | Hydrate refuses while active or starting. Load, sync and upload-reset paths check active/startup. **Delete does not** (LW1) | Preserve exactly, including the gap |

---

## 12. Latent behaviors found. PRESERVE all of these in Slice 10.

Each item is a candidate B-slice. None may be fixed inside Slice 10.

| ID | Behavior | Where | Candidate |
|---|---|---|---|
| **LW1** | Delete re-runs `resetIdleLessonWorkspace()` after its awaits with no `lessonActiveRef`/startup re-check. "Start Lesson" in `LessonDetail` is **not** disabled by `libraryBusy` (`components/lesson-detail.tsx:58`), so starting the current lesson while a cloud delete is in flight can blank the workspace (and `preparedSourceRef`) under an active or starting lesson | 1046–1051 | B-W1 (high value) |
| **LW2** | The selection/delete busy guard reads render state `lessonLibraryBusyId`. Two activations in one render both pass, and the later hydration-generation bump makes the first selection refuse ("request-stale") after it already wrote its active pointer | 997, 1026 | B-W2 |
| **LW3** | `setActiveLessonId` is written before hydration can refuse. `openLesson` switches to the lesson-detail view even when selection failed or was refused | 1012–1013, 2566–2571 | B-W3 |
| **LW4** | The load effect captures `lessonHydrationGenerationRef` **after** its awaits, so it does not detect a selection made during an owner-switch reload (when the library is visible, LW17) and can overwrite the selected lesson | 1379 | B-W4 |
| **LW5** | Stale load generations still write `cloudSyncState`/`cloudLessonCount` (a2), `savedLessons`/`localOnlyLessonCount` (a3 via `refreshScopedLibrary`), "IndexedDB opened", `clearActiveLessonId` (incompatible), and `workspaceLoadedRef = true` (restored-but-stale branch). Only hydration and `persistenceHydrated` are generation-guarded | 1357–1388 | B-W5 |
| **LW6** | In dev (StrictMode), every mount runs two resets and two library refreshes, and logs one "Stale workspace hydration skipped: reason=request-stale" | §5.2 | Document only |
| **LW7** | Every hydration (mount restore, selection, sync) triggers an autosave 600 ms later. The content is identical, so `updatedAt` is kept, but it rewrites the active pointer, logs "Lesson autosaved", and, when signed in, schedules a 1.2 s cloud reconcile | 1402–1427 | B-W6 |
| **LW8** | `saveActiveLesson` always rewrites the owner's active pointer. The new-lesson flow's un-awaited outgoing save re-points it to the outgoing lesson, so a reload restores that lesson rather than a blank setup | 989, `local-persistence.ts:86` | B-W7 |
| **LW9** | The autosave snapshot is built eagerly at effect time. `createCurrentLessonSnapshot` has a side effect: it initializes `savedLessonCreatedAtRef` | 818, 1404 | Document only |
| **LW10** | Render-closure capture: `createCurrentLessonSnapshot` reads `learningSource`/`lessonSources`/`topicInput`; `scheduleCloudUpload`, `syncCurrentAccount`, `importLocalLessons` and delete read `cloudUserId`; selection and delete read `lessonLibraryBusyId`; the preference tool reads `topicInput`/`learningSource`. All from the closure. Session ends driven by the transport (farewell, idle, session control) persist with the **Start render's** values | §2.6 | refactor-plan §6.11 |
| **LW11** | Unmount clears a pending autosave without flushing (up to 600 ms of progress lost) and does not clear cloud upload timers, so a reconcile can fire after unmount | 1411–1414, 1448–1453 | B-W8 |
| **LW12** | Cloud upload completion and `syncCurrentAccount` have no owner or generation guard. After an owner switch they can `refreshScopedLibrary(previousOwner)`, briefly showing the previous owner's library | 783, 1277 | B-W9 |
| **LW13** | `disposeResources` clears the autosave timer only after three awaits. Status writes on track-ended/fatal-error (`status: "idle"`) and on stop schedule an autosave that may or may not be cancelled, depending on timing. This complements audio L11 (a track-ended teardown does not persist explicitly) | 692/698 | Product question |
| **LW14** | The load-effect re-trigger dependencies (`aiConnectionStatus`/`microphoneStatus`) usually change **while `lessonActiveRef` is still true** (stop sets them before its awaits; track-ended and fatal error set them before `void dispose`). A load deferred by an auth change during a lesson may therefore not run when the lesson ends, only at a later dependency change with the lesson idle. Derived from code reading; not verified by test | 1334, 2478–2479 | refactor-plan §6.9 |
| **LW15** | `importLocalLessons` clears the anonymous active pointer even when some imports failed | 1324 | B-W10 |
| **LW16** | Source Visual gets `cloudUserId` (auth user) as `cloudOwnerId`, not the lesson's owner. The processing queue is keyed on `cloudUserId`, while library refreshes use `workspaceOwnerIdRef`. The two differ during the owner-switch window | 2685, 1257, 1260 | Document |
| **LW17** | `persistenceHydrated` never returns to false on an owner switch. The old owner's library stays visible and actionable during the reload | 1394–1397 | B-W4 |
| **LW18** | Autosave writes `status: "teaching"` mid-lesson. After a crash or reload, the restored lesson has `status: "teaching"` while inactive | autosave | Document |
| **LW19** | `persistenceAvailableRef` is a one-way latch. After one IndexedDB write failure, no snapshot is created for the rest of the page lifetime, while reads and selection still run | 859, 1390 | Document |
| **LW20** | Deleting a lesson does not cancel its pending cloud upload timer | 1035–1038 | B-W11 |
| **LW21** | Hydrate logs "Source restored from cloud metadata" for every source, including local-only lessons | 939 | Wording; document |
| **LW22** | "Sync now" re-hydrates the current lesson even when it is unchanged, which also triggers LW7 | 1278–1283 | B-W6 |
| **LW23** | Cross-reference to audio L2: the unconditional `finally { lessonStartupPendingRef = false }` can clear startup-pending for a newer run, which weakens hydration blocking (I16) | 2449 | B-A2 |

---

## 13. Tests that must be green before implementation

### 13.1 Existing (must pass unchanged before and after)

- `npm run type-check`, `npm run build`.
- `npm run test:unit`: 11 files, 194 tests (baseline at `5c139c2`). This includes `lesson-snapshot.test.ts`: round-trip, transcript stripping, `updatedAt` stability, infrastructure-only signature changes, and owner/cloud metadata.
- `npm run test:e2e`: 25 tests in 6 files:
  - `audio-lifecycle` (6), including the permission failure and both restart paths;
  - `farewell-idle-regression` (6), whose idle end and confirmed end go through `stopConversation` persistence;
  - `review-regression` (5);
  - `session-lifecycle` (4), including persisted resume, which depends on mount hydration;
  - `teaching-room-ui` (3), including restart;
  - `voice-interruption` (1).

  Every e2e test depends on mount hydration (`openLessonAndStart` waits for `persistenceHydrated`), so the suite is a strong smoke test of §5.1/§5.2. **However, no existing test asserts what is written to IndexedDB.**

### 13.2 Gaps to close first, in a separate test-only PR

**Browser:** `tests/e2e/workspace-persistence.spec.ts`. It is provider-free and reuses `installFakeLive`, with Supabase blank. Add small IndexedDB read helpers to `tests/helpers/fake-live.ts`, or a new `tests/helpers/workspace-db.ts`, that read `savedLessons` and `appState` by key.

| # | Scenario | Pins |
|---|---|---|
| P1 | Cold mount restores the seeded active lesson: `persistenceHydrated`, bridge `lessonId`, Continue card title | §5.1 |
| P2 | Incompatible schema (seed `schemaVersion: 999` + pointer): hydrated, no lesson restored, `activeLessonId:anonymous` removed | §4.1 a4 |
| P3 | Autosave debounce: after a lesson-mode `beat.commit`, the IndexedDB record is unchanged at ~300 ms and shows the new cursor by ~1 s, with `updatedAt` advanced | §6.1 |
| P4 | Stop persists: after End Lesson, the record has `status: "idle"` (`pauseLessonState`; `"completed"` stays `"completed"`), `hasStarted: true`, the cursor, and empty `lastUserTranscript`/`lastAssistantTranscript` | §6.2 |
| P5 | Reload after stop continues as a persisted resume, with the `RECOVERED_APPLICATION_CONTEXT` seed | §6.2 + §5.1 |
| P6 | Selection flushes the outgoing lesson: seed lessons A and B, open A, edit the topic, open B within 600 ms. A's record has the new `lessonFocus`, the pointer is B, and the bridge `lessonId` is B | §5.5 |
| P7 | Restart persists fresh progress: after a confirmed restart, the record cursor is 0 before the new run's first commit | §6.5 |
| P8 | New lesson flow re-points the active lesson to the outgoing one: edit the topic, click "+ Add New Lesson", read the pointer, reload, and the outgoing lesson is restored | LW8 |
| P9 | Delete the current lesson: workspace blank, library index shown, record and pointer gone | §6.6 |
| P10 | `updatedAt` is stable across hydration: open a lesson, wait 1.5 s, and `updatedAt` is unchanged (re-save happened, content identical) | LW7 + §8 |
| P11 | Owner scoping (local only): a seeded lesson with `cloudOwnerId` = some UUID is not listed for the anonymous owner, and opening it by id is refused with "unavailable or incompatible" | §5.5 step 6 |
| P12 | No external network: `page.on("request")` fails on any request not to the test origin, across P1–P11 | §9 |

**Not practical in e2e (document; do not test):**
- I16 during an active lesson: the library is hidden while active.
- LW1/LW2/LW4 races.
- Unmount flush (LW11).
- Every cloud path, because Supabase is disabled.

**Unit:** `tests/unit/lesson-workspace.test.ts` is written **in Slice 10** together with the new pure module (§9.3). The functions are new extractions, so they are characterized by porting today's inline expressions with the exact strings, for example `Library refreshed: reason=…, activeLessonHydrated=no`.

**Optional manual QA (user-run, against a real Supabase project; not run for this analysis):**
- sign in and see the initial reconciliation;
- edit, then see one upload about 1.2 s later;
- Sync now;
- sign out (persist, then the anonymous workspace);
- import local lessons;
- delete a cloud lesson.

Compare the debug-panel log sequences before and after Slice 10.

---

## 14. Recommended abstraction shape and API

### 14.1 Shape comparison

| Shape | Assessment | Verdict |
|---|---|---|
| **React hook** | Keeps both effects as React effects with identical deps and identical cleanup semantics. Operations defined per render reproduce today's closure capture exactly (H-W6). Called at line 1333's position, it preserves effect order (H-W4). Risks: someone memoizes operations, reorders the call, or "fixes" deps. Cannot be unit-tested without new dependencies | **Recommended (outer layer)** |
| **Plain controller/class** | The class cannot own the load and autosave triggers, which are React effects keyed on render values, so ownership would be split between the class and page effects. It would have to read `learningSource`/`lessonSources`/`topicInput`/`cloudUserId` from refs (a §6.11 behavior change) or take them on every call (a large signature at about 10 call sites). It needs about 15 injected React setters. Testable in Vitest node | Reject for Slice 10. Reconsider in Slice 11 |
| **Pure module + page effects** | Lowest risk, but it moves only about 60 lines. All orchestration, timers and generations stay in the page, so the Slice 10 goal (persistence independent of the realtime page body) is not met | Insufficient alone. **Used as the inner layer** |
| **Hybrid (hook + pure module)** | Hook for lifetimes, effects and React state. Pure module for decisions and diagnostic strings, unit-tested | **Recommended** |

### 14.2 API (`lib/use-lesson-workspace.ts`)

```ts
// Lesson workspace: the selected lesson's source/identity, IndexedDB persistence,
// hydration and Supabase sync orchestration. Canonical LessonState, teaching
// preferences and recent teaching context stay owned by the page/session runtime
// and are passed in; the workspace snapshots and replaces them but never decides
// lesson progress. Operations are intentionally recreated each render (not
// memoized) so they capture the same render values as before the extraction,
// and the two effects keep their original dependency arrays.
export type LessonWorkspaceInput = {
  // Session-owned refs, read only (I16 hydration blocking, cloud defer).
  lessonActiveRef: RefObject<boolean>;
  lessonStartupPendingRef: RefObject<boolean>;
  // Canonical lesson content owned by the page/runtime.
  lessonState: LessonState;                       // autosave deps only
  lessonStateRef: RefObject<LessonState>;
  setLessonState: (state: LessonState) => void;
  recentTeachingContextRef: RefObject<RecentTeachingContextEntry[]>;
  teachingPreferences: TeachingPreferences;       // autosave deps only
  teachingPreferencesRef: RefObject<TeachingPreferences>;
  setTeachingPreferences: (preferences: TeachingPreferences) => void;
  // Auth identity owned by the page (CloudAccount).
  cloudUserId: string | null;
  cloudAuthReady: boolean;
  // Workspace-load re-trigger signals (refactor-plan §6.9); deps only.
  aiConnectionStatus: string;
  microphoneStatus: string;
  addDebugMessage: (text: string) => void;
  setUserError: (message: string) => void;
  // Session/UI resets that used to be inline in hydrate/resetIdle.
  onWorkspaceReplaced: () => void;
  // setLibraryView("index") after deleting the current lesson.
  onCurrentLessonDeleted: () => void;
};

export function useLessonWorkspace(input: LessonWorkspaceInput): {
  // Render state
  persistenceHydrated: boolean;
  persistenceNotice: string;
  setPersistenceNotice: (notice: string) => void;
  savedLessonId: string | null;
  resumeExistingLesson: boolean;
  savedLessons: SavedLesson[];
  lessonLibraryBusyId: string | null;
  cloudSyncState: CloudSyncState;
  cloudLessonCount: number;
  localOnlyLessonCount: number;
  topicInput: string;
  setTopicInput: (topic: string) => void;
  learningSource: LearningSource | null;
  lessonSources: LessonSource[];
  // Stable refs (test bridge, session reads, processing queue)
  savedLessonIdRef: RefObject<string | null>;
  preparedSourceRef: RefObject<PreparedLearningSource | null>;
  resumeExistingLessonRef: RefObject<boolean>;
  persistenceHydratedRef: RefObject<boolean>;
  workspaceOwnerIdRef: RefObject<string | null>;
  // Operations (per render; never memoized)
  persistCurrentLesson: (stateOverride?: LessonState) => Promise<void>;
  cancelScheduledSave: () => void;            // disposeResources, at line 692's position
  invalidatePendingHydration: () => void;     // startConversation: load gen += 1, then hydration gen += 1
  markLessonStarted: () => void;              // ref = true; setResumeExistingLesson(true)
  markLessonNotStarted: () => void;           // ref = false; setResumeExistingLesson(false)
  prepareNewLesson: () => boolean;            // workspace half of startNewLessonFlow; false if lesson active
  selectSavedLesson: (id: string) => Promise<void>;
  requestDeleteSavedLesson: (saved: SavedLesson) => Promise<void>;
  refreshScopedLibrary: (ownerId: string | null, reason?: string) => Promise<SavedLesson[]>;
  syncCurrentAccount: () => Promise<void>;
  importLocalLessons: () => Promise<void>;
  handleAuthResolved: (nextUserId: string | null) => void; // owner-change timer clear + workspaceLoadedRef
};
```

Use `MutableRefObject` or `RefObject` to match the React 19 types already in use. The hook declares its effects **load first, then autosave**.

### 14.3 Pure module (`lib/lesson-workspace.ts`)

The functions are `workspaceHydrationSkipReason`, `scopeLibrary`, `libraryRefreshDiagnostics`, `upsertLibraryLesson`, `cloudSyncStateAfterSummary`, and `createImportCandidate`. The module has no React, no IndexedDB, and no Supabase. It may import types from `local-persistence` and `cloud-sync`.

---

## 15. Implementation steps for Slice 10 (after §13.2 is green)

1. **Add `lib/lesson-workspace.ts`** with the six pure functions. Bodies are lifted from 919/1346/1383, 1238–1252, 846–849, 785/1288, 1304–1310. Add **`tests/unit/lesson-workspace.test.ts`**:
   - the skip-reason precedence (active wins over startup);
   - scoping null vs owner, and the local-only count being 0 when the owner is null;
   - the exact diagnostic strings and their order, including the same-title line only for duplicates;
   - upsert de-duplicates, prepends, and sorts by `updatedAt` descending;
   - `deferred` mapping;
   - the import candidate keeps a UUID id, replaces a non-UUID id, sets the owner, and clears `cloudSync`, without mutating the input.
2. **Add `lib/use-lesson-workspace.ts`** with the API in §14.2:
   - Move state and refs from 245–256, 260–261, 267–275, 279–285, 326.
   - Move function bodies 751–793, 810–868, 916–1063 (minus page navigation), 1236–1254, 1265–1331, and the load and autosave effects 1333–1427, **verbatim**.
   - Substitutions:
     - `lessonActiveRef` → `input.lessonActiveRef`, and the same for every other input;
     - the session/UI lines in hydrate/resetIdle → `input.onWorkspaceReplaced()` (§7.1);
     - `setLibraryView("index")` → `input.onCurrentLessonDeleted()`;
     - inline expressions → the pure helpers.
   - **No `useCallback`, no `useMemo`, no new effect, no cleanup changes, no dependency changes.**
3. **Page: delete** the moved state and refs. Keep `cloudUserId`, `cloudAuthReady`, `lessonState`, `teachingPreferences`, `recentTeachingContextRef`, `teachingPreferencesRef`, `lessonStateRef`, `restartConfirmationOpen`, and the bridge mirrors.
4. **Page: call the hook** at line 1333's position: after `useLessonProcessingQueue`, before `usePwaInstall`.

   ```ts
   const workspace = useLessonWorkspace({ …, onWorkspaceReplaced: () => { lessonWrapUpRef.current = false; conversationalRestartConfirmationRef.current = false; setRestartConfirmationOpen(false); presentationBeatRef.current = null; setPresentationBeat(null); }, onCurrentLessonDeleted: () => setLibraryView("index") })
   ```

   Keep the original relative order of the five resets inside the callback.
5. **Page: test bridge (368, 395).** Change these to `workspace.savedLessonIdRef.current` and `workspace.persistenceHydratedRef.current`. The `[]` deps stay.
6. **Page: `disposeResources`.** Replace 692 and 698 with a single `workspace.cancelScheduledSave();` at 692's position.
7. **Page: `startConversation`.**
   - 2097 → `workspace.savedLessonIdRef.current`.
   - 2099 → `workspace.setPersistenceNotice("")`.
   - 2101/2112 → `workspace.learningSource`.
   - 2102/2113 → `workspace.preparedSourceRef.current`.
   - 2114 → `workspace.topicInput`.
   - 2116 → `workspace.resumeExistingLessonRef.current`.
   - 2109–2110 → `workspace.invalidatePendingHydration()`, placed immediately after 2108.
   - 2175 → `workspace.setTopicInput(lessonFocus)`.
   - 2380–2381 → `workspace.markLessonStarted()`.

   Nothing else changes (audio S-1 still holds: there is no new await).
8. **Page: other session sites.**
   - The preference tool, 1857–1858 → `workspace.topicInput` / `workspace.learningSource`.
   - 1874, 2510 → `workspace.resumeExistingLessonRef.current`.
   - 2496 → `await workspace.persistCurrentLesson(stoppedLessonState)`.
   - `resetCurrentLessonProgress` 871 → `workspace.preparedSourceRef.current`; 909–911 → `workspace.markLessonNotStarted(); await workspace.persistCurrentLesson(freshState);`; 912 → `workspace.savedLessonIdRef.current`.
9. **Page: navigation and JSX.**
   - Replace `startNewLessonFlow` with `if (!workspace.prepareNewLesson()) return; setAppView("library"); setLibraryView("new"); addDebugMessage("New lesson setup opened");`.
   - `openLesson` → `workspace.selectSavedLesson`.
   - Processing queue `onLessonReady` → `workspace.refreshScopedLibrary(workspace.workspaceOwnerIdRef.current, "processing-ready")` and `workspace.setPersistenceNotice(…)`.
   - `CloudAccount`: `onAuthResolved = (user) => { const nextUserId = user?.id ?? null; workspace.handleAuthResolved(nextUserId); setCloudUserId(nextUserId); setCloudAuthReady(true); }`, `onBeforeSignOut = async () => { await workspace.persistCurrentLesson(); }`, `onSyncNow`/`onImportLocalLessons` → `workspace.*`.
   - JSX reads of `savedLessons`, `lessonLibraryBusyId`, `persistenceHydrated`, `persistenceNotice`, `cloudSyncState`, `cloudLessonCount`, `localOnlyLessonCount`, `topicInput`, `setTopicInput`, `learningSource`, `lessonSources`, `savedLessonId`, `resumeExistingLesson` → `workspace.*`. **`CloudAccount` stays mounted under `hidden`.**
10. **Imports.** Remove the now-unused `local-persistence`/`cloud-sync` imports from the page. Keep `type RecentTeachingContextEntry`, `type SavedLesson` and `type CloudSyncState` if they are still referenced. Keep `isSupabaseConfigured` (initial `cloudAuthReady`).
11. **Verify:**
    - Run `npm run type-check`, `npm run test:unit`, `npm run build`, and `npm run test:e2e` (all 25 existing tests plus P1–P12).
    - Grep the diff to confirm these debug strings are byte-identical:
      - `Stale workspace hydration skipped: reason=`, `Restored saved lesson: `, `Restored resume teaching context: entries=`, `Source restored from cloud metadata: source=`
      - `Saved lesson created: `, `Lesson autosaved`, `Local persistence unavailable`
      - `Library refreshed: reason=`, `Saved lesson library loaded: `, `Recent Lessons cache: scopedUniqueLessons=`, `Recent Lessons same-title IDs: `
      - `Saved lesson selected: `, `Active lesson changed: `, `Saved lesson deleted: `, `New lesson setup opened`
      - `IndexedDB opened`, `Saved lesson schema incompatible`
      - `Cloud sync failed: category=` (lesson-upload, lesson-delete, reconciliation, local-import, initial-reconciliation)
      - `Legacy import: localId=`, `Local lessons imported: `, `Completed lesson progress reset: lesson=`
    - In dev, compare the debug-panel log sequence for mount (including the StrictMode `request-stale` line), open lesson, edit topic, start, commit, stop, reload, and restart before and after.
12. **Blocking review checklist:**
    - the hook call position is unchanged relative to the queue hook and the mount effect;
    - both dependency arrays are character-identical;
    - no `useCallback`/`useMemo` around operations;
    - no new effect cleanup, `cancelled` flag, mounted flag, or run guard;
    - no render-value-to-ref mirroring;
    - `cancelScheduledSave` is at line 692's position, after `releaseWakeLock`;
    - `invalidatePendingHydration` is immediately after `lessonStartupPendingRef = true`;
    - `hydrateSavedLesson` is still synchronous;
    - `selectSavedLesson` step order matches §5.5;
    - delete still lacks the active re-check (LW1);
    - the load IIFE still has no await before reset when not hydrated (H-W1);
    - `lessonSources` is returned by identity;
    - `CloudAccount` stays always-mounted;
    - no edits to `lib/local-persistence.ts`, `lib/cloud-sync.ts`, `lib/lesson-snapshot.ts` or `components/*`.

---

## 16. Files expected to change, and conflict hotspots

| File | Change |
|---|---|
| `lib/use-lesson-workspace.ts` | **New** (~430 lines) |
| `lib/lesson-workspace.ts` | **New** (~70 lines) |
| `tests/unit/lesson-workspace.test.ts` | **New** |
| `app/page.tsx` | About −420 / +60 lines: state/ref removal, the moved functions and effects, about 30 call-site substitutions, the `CloudAccount` callbacks, imports |
| `tests/e2e/workspace-persistence.spec.ts` | **New**, in the prerequisite test-only PR |
| `tests/helpers/fake-live.ts` (or new `tests/helpers/workspace-db.ts`) | IndexedDB read helpers and an optional second-lesson seed, in the prerequisite PR |

**Not expected to change:**
- `lib/local-persistence.ts`, `lib/cloud-sync.ts`, `lib/lesson-snapshot.ts`, `lib/use-lesson-processing-queue.ts`, `lib/audio-session.ts`, `lib/test-observability.ts`;
- `components/cloud-account.tsx`, `components/source-visual.tsx`, `components/lesson-detail.tsx`;
- `package.json`, configs.

**Conflict hotspots in `app/page.tsx`:**

| Lines | Reason |
|---|---|
| 245–285, 326 | State/ref block. Any branch adding state here conflicts |
| 362–403 | Test bridge and render mirrors. QA branches often extend the bridge snapshot |
| 653–712 | `disposeResources`. Slice 11 will restructure it |
| 751–1063 | Bulk move region. Any fix to selection or delete conflicts wholesale |
| 1236–1427 | Library, queue, sync, import, load and autosave. The processing-queue call sits in the middle (1256) and must not move |
| 2096–2175, 2380–2384, 2453–2521 | Start, stop, restart. **Slice 11 owns these**, so Slice 10 must land first, or Slice 11 must rebase onto the substitutions |
| 2598–2674 | JSX workspace reads and `CloudAccount` callbacks. UI or presentational branches conflict here |

**Sequencing:** the Slice 10 prerequisite test PR, then Slice 10, then Slice 11. B-W* slices only after Slice 10, one per PR, each test-first.

---

## 17. Open questions for the user

1. **LW1** (delete can blank the workspace under a starting or active lesson) is the most consequential latent bug found. Schedule B-W1 immediately after Slice 10?
2. **LW7/LW22:** should hydration-triggered re-saves (and the cloud reconcile they cause) be suppressed, or are they a useful "touch" of the active pointer?
3. **LW8:** after "+ Add New Lesson", should a reload restore the previous lesson (current behavior) or a blank setup?
4. **LW11/LW13:** should unmount and track-ended teardown flush pending progress? This is a product decision shared with audio L11.
5. Is a manual Supabase QA pass (§13.2, optional) available before and after Slice 10? The cloud branches have no automated coverage.
