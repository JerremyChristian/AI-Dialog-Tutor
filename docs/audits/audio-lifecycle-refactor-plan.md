# Slice 9 — Audio Session Lifecycle: Implementation Plan

> **Status:** Analysis only. No production code, test, configuration, or dependency was changed to produce this document.
> **Branch:** `agent/claude-audio-analysis` (base `f63f72b`, post-Slice-8 with Slice 6 merged).
> **Companions:** `docs/audits/refactor-plan.md` (§4 protocols, §5 invariants, §7 Slice 9 as originally proposed) and `docs/audits/current-architecture-gap-analysis.md`.
> **Line references** are to `app/page.tsx` (2,823 lines) and `lib/realtime-audio.ts` (224 lines) at `f63f72b`.
> **Baseline at time of writing:** `npm run test:unit`: 9 files, 176 tests, all passed. `npm run type-check` passed. The Playwright suite was not run, because it needs a dev server on port 3100.

---

## 1. Recommendation in one paragraph

Add a **plain, page-lifetime, React-free class** `AudioSession` in `lib/audio-session.ts`. It replaces exactly four page refs: `streamRef`, `microphoneStreamerRef`, `playerRef`, and `wakeLockRef`. It exposes **granular, synchronous-where-today-synchronous steps**, not a single `start()`/`dispose()`, so that `startConversation`, `disposeResources`, `stopConversation`, the mute toggle and the visibility handler keep calling them at the *same positions, under the same guards, in the same order*.

The class knows nothing about conversation runs, epochs, beats, farewell, mute state, transport, or React. All `conversationRunRef`/`isMountedRef` guards, the mic-chunk forwarding gate, the RMS/noise-floor diagnostic, the track-ended *reaction*, the visibility listener, and all audio-batch decisions stay in `app/page.tsx`. The page's 18 `playerRef.current?.…` call sites become `audioSession.player?.…` with optional chaining preserved.

This is a smaller extraction than the original Slice 9 proposal; §8 explains each revision.

---

## 2. Current state inventory (post-Slice-8)

### 2.1 Audio-owning refs in `app/page.tsx`

| Ref | Line | Written | Read |
|---|---|---|---|
| `streamRef: MediaStream \| null` | 290 | 2243 (set), 668 (null) | 667 (stop tracks), 2456 (catch branch selector), 2484 (`hadMicrophone`) |
| `microphoneStreamerRef` | 292 | 2394 (set), 661 (null) | 660 (dispose), 1206 (mute flush) |
| `playerRef: PcmAudioPlayer \| null` | 293 | 2228 (set), 671 (null) | 22 mentions in total: declaration, startup set, 2 in dispose, and 18 `?.` call sites (see 2.2) |
| `wakeLockRef: WakeLockSentinel \| null` | 317 | 725 (set after await), 694 (null) | 693 (release) |
| `noiseFloorRef`, `lastAcousticLogAtRef` | 322–323 | 2385, 2388 | 2385–2387 (diagnostic only) |

**Not audio-owned, but they gate audio:** `conversationRunRef` (296), `isMountedRef` (295), `microphoneMutedRef` (326), `microphoneMuteTransitionRef` (327), `closingTurnRef` (347), `generationEpochRef` (339), `activeTeachingBeatRef` (337), `assistantSpeakingRef` (297), and `transportRef` (291).

### 2.2 `PcmAudioPlayer` call sites (all through `playerRef.current?.`, so all are no-ops when the player is null)

| Operation | Lines | Owner of the decision |
|---|---|---|
| `beginBatch(epoch, onNaturalDrain)` | 468 (lesson beat), 515 (review beat), 588 (farewell) | beat runtime / review / farewell (page) |
| `completeBatch(epoch)` | 1760 (active beat), 1766 (farewell) | `generation-complete` handler (page) |
| `cancelBatch(epoch)` | 440 (invalidate), 612 (review commit), 636 (lesson commit) | beat runtime (page) |
| `clear()` | 565 (finish review), 1128 (roadmap nav), 1479 (barge-in), 1991 (navigate/skip tool), 2087 (exit review), 2103 (start review), 2298 (transport `recovering`), 2483 (stop) | interruption / navigation / review / recovery (page) |
| `play(base64)` | 1746 | `audio-chunk` event (page) |
| `prepare()` | 2229 (startup), 1456 (visibility resume) | startup / visibility (page) |
| `close()` | 672 (dispose), 2239 (stale after gUM, local var), 2473 (mic-error path, local var) | lifecycle |
| `new PcmAudioPlayer()` | 2227 | startup |

### 2.3 `lib/realtime-audio.ts` semantics that the plan depends on

- `PcmAudioPlayer.prepare()` creates a **new** `AudioContext` whenever `context` is null *or closed*, then `resumeAudioContext`. It calls `context.resume()` **synchronously before its first await** when the state is `suspended`, which is what makes the iOS user-gesture unlock work. `resumeAudioContext` only resumes `suspended`. Any other non-`running` state (for example Safari's `interrupted`) throws `"Audio could not start. Tap Start Conversation again."`.
- `beginBatch` cancels any previous batch. `completeBatch`/`cancelBatch` are epoch-filtered. `clear()` cancels the batch and then stops all sources. `close()` calls `clear()` and then closes the context. Natural drain fires once, only when the batch is not cancelled, the provider has completed, audio was received, and every batch source has ended (`maybeReportNaturalDrain`). A source's `onended` only reports if `this.batch === batch`.
- `MicrophonePcmStreamer.start()` creates its **own** capture `AudioContext` (after several awaits, outside the user gesture), resumes it twice, and loads `/pcm-recorder-worklet.js`. `stop()` resolves pending flushes, nulls the worklet `onmessage`, disconnects, nulls fields, then awaits `context.close()`. If `stop()` runs while `start()` is suspended in an await, `start()` resumes with `this.context === null` and throws a `TypeError`.
- `flushPendingAudio()` resolves on the worklet's `flush-complete` or after 250 ms.

---

## 3. What can move safely into the audio-session abstraction

Each item below moves **with byte-identical behavior and debug strings**.

| Moves | From | Notes |
|---|---|---|
| Ownership of the four slots: stream, streamer, player, wake-lock sentinel | refs 290, 292, 293, 317 | Kept as nullable fields on one page-lifetime instance, so the read points are identical to today's ref reads (see §6, H8) |
| `new PcmAudioPlayer()` + slot assignment + `prepare()` | 2227–2229 | One **synchronous** method returning `{ player, ready }`. Slot assigned before `prepare()` is called, as today |
| `getUserMedia` support check and call | 2232–2236 | A **non-async** method that throws synchronously when unsupported and otherwise returns the `getUserMedia` promise. A non-async method adds no microtask hop, and the throw still lands in the page's `try` |
| Stream slot assignment + attaching the track `ended` listener (`{ once: true }`) with a **page-supplied callback** | 2243–2256 | The class only registers the listener. The callback body (guards, run bump, UI state, `disposeResources`) stays in the page |
| Streamer construction + slot assignment | 2382, 2394 | The page passes the **local** `stream` and its `onChunk` closure, then awaits `streamer.start()` itself so the guard placement is unchanged |
| `flushPendingAudio()` passthrough | 1206 | `audioSession.flushPendingMicrophoneAudio()` |
| Dispose sub-steps: stop streamer (take, null, await), stop tracks (stop, null), close player (take, null, await), release wake lock (await, null) | 660–672, 693–694 | Exposed **as four separate methods** so `disposeResources` keeps transport close *between* streamer stop and track stop, and keeps the wake-lock release *after* the synchronous resets (§5.3) |
| `requestWakeLock` (visibility check, request, debug strings `"Screen wake lock active"` / `"Screen wake lock unavailable"`) | 722–730 | Debug sink injected at construction (`addDebugMessage`, a stable `useCallback`) |
| `hasMicrophoneStream` getter | 2456, 2484 | Replaces `Boolean(streamRef.current)` |
| `player` getter (`PcmAudioPlayer \| null`) | 18 sites | Call sites keep `?.` exactly |

**Optional, and not recommended for Slice 9:** moving `getMicrophoneErrorMessage` (194–211) next to the class. It is pure and safe, but it adds diff noise without reducing risk.

---

## 4. What MUST remain in `app/page.tsx` (session orchestration)

| Stays | Lines | Why |
|---|---|---|
| Every `isMountedRef` / `conversationRunRef` guard and every run bump | 2237, 2247–2250, 2263, 2278, 2284, 2323–2328, 2335, 2383, 2397, 2442, 1469, 2481 | The run counter is shared by transport callbacks, farewell (`createFarewellTurn(run, epoch)`), `learnerActivityRunRef`, and the mic gate. The guards interleave with token, transport, and seeding steps that are not audio (I12) |
| Startup sequencing: gUM → `await playerReady` → token → transport → seed → streamer start → `lessonActiveRef = true` → wake lock → one imperative | 2222–2440 | Ordering constraints §4.1 (a)–(d) of the refactor plan |
| The streamer `onChunk` body: run + `transportRef === transport` guard → RMS/noise floor → `!microphoneMutedRef && !closingTurnRef` → `transport.sendAudio` | 2382–2393 | The gate reads mute, farewell, run, and transport identity (I15). RMS is engagement diagnostics, not audio lifecycle |
| `noiseFloorRef`, `lastAcousticLogAtRef` and the `"Acoustic activity detected"` log | 322–323, 2384–2391 | Same reason. A later pure helper in `lib/engagement.ts` is possible, but not in this slice |
| The track-ended **reaction** (`setUserError`, debug, run bump, statuses, `status: "idle"`, `void disposeResources(false)`) | 2247–2254 | Lesson/session state. Note that it does **not** persist (unlike `stopConversation`) |
| The `visibilitychange` listener registration, the `lessonActiveRef` guard, `transport.ensureHealthy()`, and the user-error text for a failed resume | 1449–1472 | Lives in the mount effect whose cleanup bumps the run and disposes. Splitting it changes effect and cleanup order |
| `disposeResources` itself (sequence, ~40 resets, timers, React state) | 655–720 | It is the session's teardown. Only the four audio sub-steps delegate |
| `stopConversation` (run bump → invalidate → `player.clear()` → persist → dispose) | 2480–2534 | Persistence and lesson state |
| Mute toggle: transition lock, *conditional* flush (only when `learnerUtteranceOpen`), `microphoneMutedRef`, `transport.setMicrophoneForwardingEnabled`, UI | 1198–1218 | Two gates (the page ref and the transport flag) plus utterance continuity are transport and session concerns |
| All `beginBatch` / `completeBatch` / `cancelBatch` / `clear` / `play` **decisions** and their natural-drain callbacks | §2.2 | Epochs belong to the beat runtime (S1), review (S7), and farewell (S8). The callbacks close over page refs. Wrapping the batch API in the session would move lesson semantics into the audio layer |
| `generationEpochRef`, `activeTeachingBeatRef`, `closingTurnRef`, `assistantSpeakingRef`, and `transport.setAssistantSpeaking` | — | Domain state |
| The startup `catch` classification (permission denied vs realtime error vs mic error) and its UI text | 2441–2474 | UI/session policy. It uses `hasMicrophoneStream` as its selector |
| Local-variable cleanup on stale paths (`stream.getAudioTracks().forEach(stop)`, `player.close()`, `microphoneStreamer.stop()` on the **local** instances) | 2238–2239, 2398, 2473 | These intentionally act on the local instance, not the slot (see H8 and L3) |

---

## 5. Exact construction, start, and dispose order to preserve

### 5.1 Startup (`startConversation`, 2114–2478)

```
[sync, inside the click handler — NO await may be introduced before step 5]
 1. guards; lessonStartupPendingRef = true; bump workspace/hydration generations   (2117–2128)
 2. build initial lesson state, wrap-up flag, transcript resets, debug logs         (2130–2220)
 3. run = ++conversationRunRef                                                      (2222)
 4. setMicrophoneStatus("Requesting permission"); debug "Microphone permission requested"
 5. player = new PcmAudioPlayer(); playerRef = player; playerReady = player.prepare()   (2227–2229)
      ↳ prepare() synchronously creates the AudioContext and calls resume() → iOS gesture unlock
 6. try { if (!navigator.mediaDevices?.getUserMedia) throw "...not supported..." ; gUM({audio:true}) called synchronously
[async]
 A1 await getUserMedia ─► guard(mounted, run) else: stop LOCAL tracks; await LOCAL player.close(); return
 7. streamRef = stream; track[0].addEventListener("ended", <page closure>, {once:true})
 8. setMicrophoneStatus("Active"); debug "Microphone active"
 A2 await playerReady           ─► NO GUARD (L1)
 9. setAiConnectionStatus("Connecting")
 A3 await requestFreshToken()   ─► guard else: return (no cleanup)
10. build instruction; new LiveTransportManager(...); transportRef = transport
 A4 await transport.connectInitial(token) ─► guard else: transport.close(false); return
11. seedRecoveryContext | seedInitialSource          (clientContent, history-only)
12. streamer = new MicrophonePcmStreamer(stream /*local*/, onChunk); microphoneStreamerRef = streamer
 A5 await streamer.start()      ─► guard else: await LOCAL streamer.stop(); return
13. status teaching; resumeExisting; lessonActiveRef = true; lessonStartupPendingRef = false
14. beginIdleMonitoring(); void requestWakeLock()
15. exactly one imperative (wrap-up raw text | persisted-resume beat | new-lesson beat)
 catch: guard(mounted, run) else return;
        NotAllowed/Security → "Permission denied" → await disposeResources(false)
        else if streamRef (has stream) → realtime error → await disposeResources(false) → mic "Not active", lesson idle (no guard after the await, L5)
        else → mic error → await LOCAL player.close()   (playerRef left pointing at the closed player, L3)
 finally: lessonStartupPendingRef = false   (unconditional, L2)
```

**Constraints that Slice 9 must not break:**

- **S-1 (iOS gesture).** Steps 3–6 stay synchronous inside the click handler. `createPlayer()` must construct the player, assign the slot, and call `prepare()` without any intervening `await` or `async` wrapper whose first statement awaits. The `getUserMedia` call is also issued in that tick, *after* `prepare()` is called. Do not swap them: creating the playback context before the capture permission is the current, tested order.
- **S-2.** `playerReady` is awaited **after** gUM and **after** the A1 guard, never via `Promise.all` (refactor-plan §12).
- **S-3.** The stream slot is assigned **before** the track listener is attached and before `setMicrophoneStatus("Active")`. The catch branch uses "a stream exists" to tell a realtime error from a mic error.
- **S-4.** The streamer is created **after** seeding (I8 / §4.1a). It receives the local `stream`, not a re-read slot.
- **S-5.** The streamer slot is assigned **before** `await start()`, so a concurrent `disposeResources` can stop it mid-start (H9).
- **S-6.** `lessonActiveRef = true` comes before `requestWakeLock()` and before the imperative.

### 5.2 Visibility resume (mount effect, 1452–1463)

On `visible` with `lessonActiveRef` set, the handler runs `void requestWakeLock()`, then `transportRef.current?.ensureHealthy()`, then `void playerRef.current?.prepare().catch(→ user error + debug)`. On `hidden` with the lesson active, it only writes a debug line. All three steps must keep this order. `prepare()` must still go through the **current** player slot. After dispose that slot is null, which is why dispose must null the slot *before* awaiting `close()` (H7).

### 5.3 Dispose (`disposeResources`, 655–720)

```
 1. invalidateActiveTeachingBeat("resources-disposed")   ← uses player.cancelBatch: player must still be in the slot
 2. tokenRequestRef abort + null
 3. s = streamerSlot; streamerSlot = null; await s?.stop()            D1 (no guard)
 4. transportRef.current?.close(sendAudioStreamEnd); transportRef = null   ← audioStreamEnd after mic capture stopped
 5. streamSlot?.getAudioTracks().forEach(stop); streamSlot = null
 6. p = playerSlot; playerSlot = null; await p?.close()               D2 (no guard; slot re-read AFTER D1, H8)
 7. ~25 synchronous ref/state resets (assistantSpeaking, lessonActiveRef=false, closingTurnRef=null, …)
 8. completion timer clear
 9. await wakeLockSlot?.release().catch(noop); wakeLockSlot = null   D3 (slot read AFTER D2)
10. timers + remaining resets (engagement, mute=false, transport state "closed", …)
```

The new class must expose steps 3, 5, 6 and 9 as **four separate calls**, invoked from exactly these positions. Each "take, null, then await" must keep that micro-order. A single `audioSession.dispose()` cannot be used without reordering transport close (4) and the synchronous resets (7) relative to the audio steps.

### 5.4 Stop (`stopConversation`, 2480–2534)

The order is: run bump (sync, first) → invalidate → `player.clear()` → `hadMicrophone = hasMicrophoneStream` → pause/persist (**await**) → `await disposeResources(true)` → messages.

During the persist await, the streamer is still running and the player is still open. Chunks and provider messages are dropped **only** because the run was bumped first. This order must not change.

### 5.5 Other teardown entry points (all bump the run before disposing)

| Entry point | Lines | Notes |
|---|---|---|
| Track ended | 2246–2255 | `void`-ed dispose, no persist |
| `onFatalError` | 2322–2330 | Same pattern |
| Unmount cleanup | 1466–1471 | `isMountedRef = false`, run bump, `void disposeResources(false)` |
| Farewell completion | 548–552 | Reaches dispose through `stopConversation("confirmed")` after the 2 s timer |
| Session-control end / restart | 2076–2078 | Via a 250 ms `setTimeout` |

---

## 6. Every await, its guard, and callback/stale-callback hazards

### 6.1 Await table

| ID | Await | Line | Guard afterwards | Stale behavior |
|---|---|---|---|---|
| A1 | `getUserMedia` | 2236 | mounted + run | Stops local tracks, closes the local player, returns |
| A2 | `playerReady` | 2259 | **none** | Continues to `setAiConnectionStatus("Connecting")` and **issues a token request** for a stale run (L1) |
| A3 | `requestFreshToken()` | 2262 | mounted + run | Returns silently. Relies on whoever bumped the run having disposed |
| A4 | `transport.connectInitial` | 2333 | mounted + run | Closes **only** the transport. Stream and player are left to the disposer |
| A5 | `streamer.start()` | 2395 | mounted + run | Awaits the local `streamer.stop()` |
| A6 | `disposeResources` inside catch | 2452, 2464 | none | 2464 then sets mic "Not active" and lesson `idle` without a guard (L5) |
| A7 | `player.close()` in the mic-error path | 2473 | n/a (last statement) | Slot not nulled (L3) |
| A8 | `persistCurrentLesson` in stop | 2523 | run already bumped | Mic and player still alive. Chunks and messages are dropped by run guards |
| D1–D3 | streamer stop, player close, wake-lock release inside dispose | 662, 672, 693 | none | Dispose is not re-entrancy-safe (H8) |
| W1 | `navigator.wakeLock.request` | 725 | none | The sentinel is stored even after dispose released (H6) |
| M1 | `flushPendingAudio()` in mute | 1206 | none | After ≤ 250 ms, writes the mute ref and calls `transportRef.current` (possibly a new run's transport) (L6) |
| V1 | `player.prepare()` on visibility | 1456 | none (fire-and-forget `.catch`) | The error text can appear after the lesson ended |

The `catch` block (2442) has a mounted + run guard and returns silently when stale. The `finally` (2476) has **no** guard (L2).

### 6.2 Callback ownership after Slice 9

| Callback | Registered by (after S9) | Body owned by | Stale protection |
|---|---|---|---|
| Natural drain: lesson beat (468) | page via `audioSession.player?.beginBatch` | page | Player batch identity + `activeTeachingBeatRef.generationEpoch === epoch` |
| Natural drain: review beat (515) | page | page | Same as the lesson beat |
| Natural drain: farewell (588) | page | page | `isFarewellDrainCurrent(farewell, run, epoch, generationEpochRef)` |
| `source.onended` | `PcmAudioPlayer` | `PcmAudioPlayer` | `this.batch === batch`. `clear()` cancels first |
| Worklet `port.onmessage` → `onChunk` | `MicrophonePcmStreamer` | page closure | `onmessage = null` on stop. The page checks run + `transportRef === transport` |
| Flush resolvers | streamer | streamer | Resolved on stop or after the 250 ms timeout |
| Track `ended` | `AudioSession.attachStream` | page closure | `{ once: true }`, page mounted + run guard. `track.stop()` does not fire `ended` per spec |
| `visibilitychange` | page mount effect | page | `lessonActiveRef` |
| Wake-lock request completion | `AudioSession` | `AudioSession` | none today (H6) |

### 6.3 Stale-callback hazards to keep exactly as they are

- **H1.** The drain callbacks close over *refs*, not values. Keep the callbacks defined at their current page sites. Do not create them inside the class, where they would capture a different scope.
- **H2.** `player.close()` → `clear()` → `cancelBatch()` happens before any `onended` from `source.stop()` can report a drain. The class's `closePlayer()` must call `close()` and must not hand-roll context teardown.
- **H3.** The streamer chunk path after a run bump is dropped by the page guard. After `stop()`, `onmessage` is nulled.
- **H4.** Mute flush promises resolve on `stop()`, so a mute in progress cannot hang across dispose.
- **H5.** The track-ended listener is never removed. Disposal stops the track (no event fires), and the run guard is the backstop. If the class instead removes the listener on dispose, that is fine behaviorally but is a change; keep it unremoved in Slice 9.
- **H6. Wake-lock leak (latent).** `requestWakeLock` stores the sentinel after an unguarded await. A request in flight when dispose runs leaves a live sentinel in the slot. The browser auto-releases it on hide, and the next dispose releases it. Preserve the behavior; log it as a B-candidate.
- **H7.** `prepare()` **re-creates** a closed `AudioContext`. A visibility resume must never reach a disposed player. Today that holds because dispose nulls the slot before awaiting `close()`. The class must keep "take → null → await".
- **H8. Dispose re-reads slots after awaits.** `disposeResources` reads `playerRef` after awaiting the streamer stop, and reads `wakeLockRef` after awaiting the player close. A `startConversation` triggered during those awaits (for example the user clicks Start right after a track-ended `void disposeResources`, which has already set mic "Not active") gets its **new** player closed and its wake lock released by the old dispose. A page-lifetime instance with mutable slots reproduces this exactly. A per-run instance would silently fix it, which is a behavior change. **Keep the page-lifetime instance in Slice 9** and list the fix as B-candidate B-A4.
- **H9.** `disposeResources` during `streamer.start()` makes `start()` throw a `TypeError`. The page catch sees a stale run and returns. This depends on the slot being assigned before `start()` (S-5).
- **H10.** The farewell mic gate checks only that `closingTurnRef` exists, not its run or epoch. `closingTurnRef` is reset in dispose (685) and in `resetCurrentLessonProgress` (897). This stays unchanged in the page.
- **H11. React StrictMode (dev).** Next's App Router enables StrictMode by default, and `next.config` does not override it. The mount effect runs mount → cleanup (bump run, `void disposeResources`) → mount. The audio-session instance **must not have a terminal `disposed` state**: every dispose step must leave it reusable by the next `startConversation`.

---

## 7. Latent behaviors found in the lifecycle — preserve in Slice 9 (do not fix)

Each is a candidate B-slice. Pin it with a test only where that is cheap.

| ID | Behavior | Where | Proposed B-slice |
|---|---|---|---|
| L1 | No run/mounted guard after `await playerReady`, so a stale run still flips to "Connecting" and issues a token request | 2259–2262 | B-A1: add a guard |
| L2 | `finally { lessonStartupPendingRef = false }` runs for stale runs and can clear a newer run's startup-pending flag (weakens I16 hydration blocking) | 2475–2477 | B-A2 |
| L3 | The mic-error path closes the local player but leaves `playerRef` pointing at it. `playerReady` is never awaited on that path, so a rejecting `prepare()` becomes an unhandled rejection | 2473 | B-A3 |
| L4 | Dispose re-reads slots after awaits (H8) | 655–694 | B-A4: capture at entry |
| L5 | After `await disposeResources(false)` in the realtime-error branch, status writes have no guard | 2464–2467 | B-A5 |
| L6 | The mute toggle applies after an unguarded ≤ 250 ms flush, possibly to a new run's transport | 1206–1210 | B-A6 |
| L7 | The wake-lock sentinel leaks if the request resolves after dispose (H6). The `release` event is not observed | 722–730 | B-A7 |
| L8 | **iOS:** the restart paths (`restartLesson` after `await stopConversation`; the conversational restart through a 250 ms `setTimeout`) call `startConversation` outside a user gesture, so `prepare()` may not unlock audio | 2542–2543, 2078 | B-A8: product/platform decision |
| L9 | **iOS:** `MicrophonePcmStreamer` creates its capture `AudioContext` after several awaits, outside the gesture. It works today because active capture permits it; do not "fix" by sharing contexts in this slice | `realtime-audio.ts:22` | — (document) |
| L10 | `resumeAudioContext` resumes only `suspended`. Safari's `interrupted` (for example after a phone call) throws, leading to the "Audio was suspended…" user error | `realtime-audio.ts:208–213` | B-A9: platform limitation |
| L11 | A track-ended teardown does not persist progress (`stopConversation` does) | 2246–2255 | product question |

---

## 8. Revisions to the original Slice 9 plan (refactor-plan §7)

| Original proposal | Revision | Reason |
|---|---|---|
| A class owning "…the RMS/noise-floor tracker" | **Keep RMS in the page.** | The computation sits between the run/transport guard and the mute/farewell forwarding gate in a single callback. Moving it splits the gate or drags page refs into the class |
| "the track-ended callback" owned by the class | The class **registers** the listener. The **reaction** stays in the page. | The reaction bumps the run, mutates lesson state, sets UI errors, and disposes |
| "the visibility resume" owned by the class | Only `player.prepare()` (via the `player` getter) and `requestWakeLock()` are reachable through the class. The listener, the guard, `ensureHealthy`, and the error text stay in the page's mount effect. | Effect cleanup order (unmount bumps the run, then disposes) must not change |
| API `start(onChunk)` | Split into `createPlayer()` (sync), `requestMicrophone()` (sync throw / promise), `attachStream()`, and `createStreamer()`. | gUM and streamer start are separated by three awaits, token fetch, transport connect, and seeding, each guarded (§5.1) |
| API `dispose()` | Four step methods: `stopStreamer()`, `stopTracks()`, `closePlayer()`, `releaseWakeLock()`. | Transport close sits between streamer stop and track stop, and the wake-lock release happens after the synchronous resets (§5.3) |
| `flushPending()` | Keep, as `flushPendingMicrophoneAudio()`. The *condition* (open utterance) stays in the page. | — |
| "dispose order: streamer → transport → tracks → player" | Confirmed, with an amendment: invalidate the beat **first** (it needs the live player), and release the wake lock **last**, after the synchronous resets. | — |
| Line refs 790–866, 1606–1638, 2396–2433, 2556–2575 | Now 655–730, 1449–1472, 2222–2259, 2382–2400, 2441–2477, 2480–2534. | Slices 1–8 moved code |
| Size **M** | **S–M**: ~110 new lib lines, ~70–90 changed page lines. | The batch and epoch logic already moved out with S1/S7/S8 and is *not* in scope |
| Tests: "Playwright with fake gUM; visibility; mute flush" | Expanded in §10. The Slice 0 item "PcmAudioPlayer batch semantics with fake AudioContext" **was never added** and is now a hard prerequisite. | — |
| Slice 3: delete `arrayBufferToBase64` from `realtime-audio.ts` | Already done. `realtime-audio.ts` no longer exports it. `lastAcousticActivityAtRef` is also gone. | — |
| Risk **Med–High** | **Medium**, given the narrower shape. The remaining risk is concentrated in S-1 (gesture tick) and §5.3 (dispose order). | — |

Slice 9 remains independent of Slice 10. It should land before Slice 11, which will own `conversationRun` and can then hold the `AudioSession` instance.

---

## 9. Class vs hook vs plain controller

| Shape | Risks | Verdict |
|---|---|---|
| **React hook (`useAudioSession`)** | It invites moving the visibility listener and cleanup into the hook's own effect. Hook effects and cleanups then run in declaration order, separately from the page's mount effect, so audio could be torn down before or after the run bump and transport close in a different order (breaks §5.3 and H11). Returned objects or callbacks change identity across renders, which risks stale closures in long-lived callbacks (the drain callbacks and the transport `onMessage` live for the whole run). StrictMode double-invokes hook effects. It adds React semantics to something that today is synchronous ref access. | **Reject** |
| **Per-run class instance** (`new AudioSession()` in each `startConversation`) | Fixes H8 (dispose closing a newer run's player) silently, which is a behavior change in an A-slice. It needs a holder ref anyway. Every `playerRef.current?.` site would need `sessionRef.current?.player?.`, with double null-paths. Teardown must still be split into four steps. | Defer to Slice 11 or B-A4 |
| **Page-lifetime plain class with nullable slots** | Mirrors today's four refs one-for-one, so read and write points, nulling order, and races are preserved exactly. It has no React dependency, can be unit-tested in Vitest's node environment with `vi.stubGlobal` fakes, and follows the house idiom (`PcmAudioPlayer`, `MicrophonePcmStreamer`, `LiveTransportManager` are classes). Risk: someone adds a `disposed` flag or a combined `dispose()` later. Document both prohibitions in the class's header comment. | **Recommended** |
| **Plain object of closures (factory)** | Behaviorally equivalent to the class, but less consistent with `lib/realtime-audio.ts` and `lib/live-transport-manager.ts`. | Acceptable, not preferred |

### 9.1 Proposed API (`lib/audio-session.ts`)

```ts
// Browser audio resources for the teaching page: one microphone stream, its
// PCM streamer, the tutor playback player and the screen wake lock. The page
// owns conversation runs, guards, epochs, batches and every ordering decision;
// this class only holds the resources and performs each step it is asked to.
// It has no terminal disposed state (React StrictMode re-mounts), and teardown
// is deliberately split so disposeResources keeps its existing order.
export class AudioSession {
  constructor(private readonly debug: (text: string) => void) {}

  get player(): PcmAudioPlayer | null;
  get hasMicrophoneStream(): boolean;

  // Must run synchronously inside the user gesture (iOS audio unlock).
  createPlayer(): { player: PcmAudioPlayer; ready: Promise<void> };
  // Not async: throws synchronously when unsupported; otherwise returns the gUM promise.
  requestMicrophone(): Promise<MediaStream>;
  attachStream(stream: MediaStream, onTrackEnded: () => void): void;
  createStreamer(stream: MediaStream, onChunk: (chunk: ArrayBuffer) => void): MicrophonePcmStreamer;
  flushPendingMicrophoneAudio(): Promise<void>;

  requestWakeLock(): Promise<void>;   // same visibility check and debug strings

  // Teardown steps, called from disposeResources in its existing order.
  stopStreamer(): Promise<void>;      // take → null → await stop()
  stopTracks(): void;                 // stop audio tracks → null
  closePlayer(): Promise<void>;       // take → null → await close()
  releaseWakeLock(): Promise<void>;   // await release().catch(noop) → null
}
```

Instantiate the class once, after `addDebugMessage`, using a lazy ref: `audioSessionRef.current ??= new AudioSession(addDebugMessage)`. Do not use `useRef(new AudioSession(...))`, which constructs an instance on every render.

---

## 10. Tests that must be green before implementation

### 10.1 Existing (must pass unchanged before and after)

- `npm run type-check`, `npm run build`.
- `npm run test:unit`: 9 files and 176 tests at baseline (`farewell-controller`, `idle-engagement`, `lesson-runtime-characterization`, `lesson-snapshot`, `lesson-tool-decisions`, `live-message-events`, `review-controller`, `teaching-beat-runtime`, `use-appearance`).
- `npm run test:e2e`: `session-lifecycle` (4: startup ordering I8, persisted resume, fresh recovery I9, clarification I10), `voice-interruption` (1: barge-in I3/I11), `review-regression` (5: I6, review drain commit), `farewell-idle-regression` (6: I14, zero-audio farewell, idle), `teaching-room-ui` (3: includes the mute toggle UI and restart).

### 10.2 Gaps to close first, in a separate test-only PR

**Unit (Vitest, node environment, hand-written fakes via `vi.stubGlobal`; no new dependency).** New file `tests/unit/realtime-audio.test.ts`, characterizing current `PcmAudioPlayer` and `MicrophonePcmStreamer` behavior:

1. Natural drain fires once, only after `completeBatch(epoch)` **and** all batch sources have ended, in either order.
2. `cancelBatch()` / `cancelBatch(epoch)` / `clear()` before the sources end → no drain. `cancelBatch(otherEpoch)` → no effect.
3. Zero audio + `completeBatch` → no drain (pins refactor-plan §6.2).
4. `beginBatch(e2)` while `e1` is pending → `e1` never drains, even when its sources end later.
5. `close()` → `play()` is a no-op. `prepare()` after `close()` **creates a new context** (pins H7).
6. `prepare()` calls `resume()` synchronously when the state is `suspended` (pins S-1). It throws the "Tap Start Conversation again" error when the state stays non-running.
7. Streamer: `flushPendingAudio()` resolves on `flush-complete` and on the 250 ms timeout. `stop()` resolves pending flushes. `stop()` during `start()` makes `start()` reject (pins H9).

**Browser (Playwright, `tests/e2e/audio-lifecycle.spec.ts`, reusing `tests/helpers/fake-live.ts`; audio frames are visible as `realtimeInput.audio` in `__QA_LIVE__.sends()`).**

8. **Permission denied:** an init script makes `getUserMedia` reject with `NotAllowedError`. Expect the "Permission denied" message, **zero** token requests, zero Live sockets, and `lessonActive` false.
9. **Device error:** `NotFoundError` → "No microphone was found", no socket, and Start works again afterwards.
10. **Track ended mid-lesson:** wrap `getUserMedia` to stash the track, then dispatch `ended`. Expect the "microphone stopped unexpectedly" error, `lessonActive` false, the socket closed, no further audio frames, and a successful subsequent Start (exactly one new imperative on the new socket).
11. **Stop:** End lesson → exactly one `audioStreamEnd` on the active socket, **no audio frames after it**, `lessonActive` false.
12. **Mute:** audio frames are being sent → mute → after a settle period, no new audio frames → unmute → frames resume. Pins I15 for mute.
13. **Farewell:** after `session_control end` in wrap-up, no new audio frames are sent (I15 farewell gate).
14. **Wake lock:** stub `navigator.wakeLock.request` with counters. Expect 1 request after start and 1 release after stop. Hidden → visible re-requests the lock and produces no "Audio was suspended" error.
15. **Lesson-mode natural drain (I4/I5, currently only covered for review):** deliver audio, then `generationComplete` → no `beat.commit` until `tutor.audio-ended` → then one `beat.commit` with `mode: "lesson"`.

Unmount teardown and the H8 race are not practical to pin in e2e. Document them; do not test them.

---

## 11. Implementation steps for Slice 9 (after §10 is green)

1. **Add `lib/audio-session.ts`** with the class from §9.1. Bodies are moved verbatim:
   - `createPlayer` = 2227–2229;
   - `requestMicrophone` = 2232–2236, with the same error text;
   - `attachStream` = 2243–2256 without the callback body;
   - `createStreamer` = 2382 + 2394;
   - `requestWakeLock` = 722–730;
   - teardown steps = 660–662, 667–668, 670–672, 693–694.

   Import from `./realtime-audio`, with no React import.
2. **`tests/unit/audio-session.test.ts`:** slot lifecycle (take → null → await for each teardown step; reusable after teardown, H11), `createPlayer` calls `prepare` synchronously, `requestMicrophone` throws synchronously when unsupported, the track listener uses `{ once: true }`, and wake-lock visibility skip and debug strings.
3. **Page: instantiate** the class after `addDebugMessage` (line ~362) with a lazy ref. Delete `streamRef`, `microphoneStreamerRef`, `playerRef`, and `wakeLockRef` (290, 292, 293, 317). Keep `noiseFloorRef` and `lastAcousticLogAtRef`.
4. **Page: mechanical rename** of the 18 `playerRef.current?.X` sites (17 here plus the visibility site in step 9) to `audioSession.player?.X`, keeping optional chaining (§2.2). Do not touch any drain-callback body.
5. **Page: `startConversation`.**
   - Replace 2227–2229 with `const { player, ready: playerReady } = audioSession.createPlayer();`.
   - Replace 2232–2236 with `const stream = await audioSession.requestMicrophone();`.
   - Replace 2243–2256 with `audioSession.attachStream(stream, () => { /* unchanged body 2247–2254 */ });`.
   - Replace 2382 + 2394 with `const microphoneStreamer = audioSession.createStreamer(stream, (chunk) => { /* unchanged 2383–2392 */ });`.
   - Leave every guard, every local-variable cleanup (2238–2239, 2398, 2473), the catch, and the finally untouched.
   - Replace `streamRef.current` at 2456 with `audioSession.hasMicrophoneStream`.
6. **Page: `disposeResources`.** Replace 660–662 with `await audioSession.stopStreamer();`, 667–668 with `audioSession.stopTracks();`, 670–672 with `await audioSession.closePlayer();`, and 693–694 with `await audioSession.releaseWakeLock();`. Every other line stays in place.
7. **Page: `stopConversation`.** Replace 2484 with `const hadMicrophone = audioSession.hasMicrophoneStream;`.
8. **Page: wake lock call sites.** Make 1454 and 2413 call `void audioSession.requestWakeLock()` and delete the page's `requestWakeLock` (722–730).
9. **Page: visibility handler.** At 1456, `void audioSession.player?.prepare().catch(…)`. The listener, guard, `ensureHealthy`, and messages are unchanged.
10. **Page: mute.** At 1206, `await audioSession.flushPendingMicrophoneAudio();`. The condition and everything else are unchanged.
11. **Imports.** `app/page.tsx` should no longer need `MicrophonePcmStreamer` or `PcmAudioPlayer` (it may keep a type import of `PcmAudioPlayer` if any annotation needs it).
12. **Verify:**
    - `npm run type-check`, `npm run test:unit`, `npm run build`, `npm run test:e2e` (all of §10).
    - Grep the diff for unchanged debug strings: "Microphone permission requested", "Microphone active", "Microphone streaming started", "Microphone stream ended unexpectedly", "Screen wake lock active/unavailable", "Audio context could not resume after backgrounding", "Microphone forwarding muted/unmuted", "Acoustic activity detected".
    - Confirm the fake-Live send transcript is identical on the scripted scenarios.
13. **Review checklist (blocking):**
    - no `await` before `createPlayer()` in `startConversation`;
    - no `Promise.all`;
    - `disposeResources` statement order identical except for the four substitutions;
    - no `disposed` flag in the class;
    - no run, epoch, mute, or farewell knowledge in the class;
    - no drain callback created in the class.

---

## 12. Files expected to change

| File | Change |
|---|---|
| `lib/audio-session.ts` | **New** (~110 lines) |
| `app/page.tsx` | Edited (~70–90 lines): 4 refs removed, 18 `player` site renames, startup/dispose/stop/visibility/mute/wake-lock substitutions, imports |
| `tests/unit/audio-session.test.ts` | **New** |
| `tests/unit/realtime-audio.test.ts` | **New**, in the prerequisite test-only PR |
| `tests/e2e/audio-lifecycle.spec.ts` | **New**, in the prerequisite test-only PR. May add small helpers to `tests/helpers/fake-live.ts` (gUM override, track stash, wake-lock stub) |

**Not expected to change:**
- `lib/realtime-audio.ts`: read-only; any fix is a B-slice;
- `lib/live-transport-manager.ts`, `lib/gemini-live-websocket.ts`, `lib/farewell-controller.ts`, `lib/teaching-beat-runtime.ts`, `lib/engagement.ts`;
- `public/pcm-recorder-worklet.js`, `package.json`, configs.

---

## 13. Open questions for the user

1. Should H8/L4 (dispose closing a newer run's player) and L1/L2 (missing guards after `playerReady`, and an unconditional `finally`) be scheduled as B-slices right after Slice 9? They are small, but each changes behavior and needs its own test.
2. For iOS restart (L8): is a restart required to preserve audio unlock? If so, the fix is a product/UX change (for example, reusing the prepared player across restart, or requiring a tap), not part of Slice 9.
3. Should a track-ended teardown persist progress like `stopConversation` does (L11)?
