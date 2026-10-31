import { expect, type Page } from "@playwright/test";

export const QA_LESSON_ID = "qa-session-lifecycle-001";

export type LiveSend = { socketId: number; message: Record<string, unknown> };

const externalRequests = new WeakMap<Page, string[]>();
const tokenRequests = new WeakMap<Page, number>();

export async function installNoExternalNetworkGuard(page: Page) {
  const blocked: string[] = [];
  externalRequests.set(page, blocked);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if ((url.protocol === "http:" || url.protocol === "https:") &&
        url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      blocked.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

export function getExternalRequests(page: Page) {
  return [...(externalRequests.get(page) ?? [])];
}

export async function installFakeLive(page: Page, options: {
  persisted?: boolean;
  reviewReady?: boolean;
  completed?: boolean;
  microphoneFailure?: string;
  persistedCursor?: number;
  persistedStatus?: "idle" | "teaching" | "interrupted";
  resumePoint?: string;
  recentTeachingContext?: Array<{ conceptId: string; excerpt: string }>;
  teachingPreferences?: { explanationDepth: "brief" | "normal" | "detailed"; speakingSpeed: "slow" | "normal" | "fast" };
  schemaVersion?: number;
  cloudOwnerId?: string | null;
  secondLesson?: boolean;
  holdFirstPlayerReady?: boolean;
} = {}) {
  await page.route("**/auth/v1/**", (route) => route.fulfill({
    status: 401, contentType: "application/json", body: JSON.stringify({ message: "Not signed in" }),
  }));
  tokenRequests.set(page, 0);
  await page.route("**/api/gemini-token", (route) => {
    tokenRequests.set(page, (tokenRequests.get(page) ?? 0) + 1);
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ token: "local-test-token", source: { name: "plc-notes.txt", mimeType: "text/plain" } }),
    });
  });
  await page.addInitScript(({ lessonId, persisted, reviewReady, completed, microphoneFailure, persistedCursor, persistedStatus, resumePoint, recentTeachingContext, teachingPreferences, schemaVersion, cloudOwnerId, secondLesson, holdFirstPlayerReady }) => {
    if (holdFirstPlayerReady) {
      const NativeAudioContext = window.AudioContext;
      let firstPlayerContext = true;
      let releaseFirstResume: (() => void) | null = null;
      class GatedAudioContext {
        constructor(options?: AudioContextOptions) {
          const context = new NativeAudioContext(options);
          if (!firstPlayerContext || options?.sampleRate !== 24_000) return context;
          firstPlayerContext = false;
          let held = true;
          const ready = new Promise<void>((resolve) => { releaseFirstResume = resolve; });
          return new Proxy(context, {
            get(target, property) {
              if (property === "state" && held) return "suspended";
              if (property === "resume") return async () => {
                await ready;
                held = false;
                if (target.state === "suspended") await target.resume();
              };
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }
      }
      Object.defineProperty(window, "AudioContext", { configurable: true, value: GatedAudioContext });
      Reflect.set(window, "__QA_PLAYER_READY__", {
        isHeld: () => Boolean(releaseFirstResume),
        release: () => releaseFirstResume?.(),
      });
    }

    const NativeWebSocket = window.WebSocket;
    const sockets: FakeLiveWebSocket[] = [];
    const sends: Array<{ socketId: number; message: Record<string, unknown> }> = [];
    const pcm = btoa(String.fromCharCode(...new Uint8Array(8_000)));

    class FakeLiveWebSocket extends EventTarget {
      static readonly CONNECTING = NativeWebSocket.CONNECTING; static readonly OPEN = NativeWebSocket.OPEN;
      static readonly CLOSING = NativeWebSocket.CLOSING; static readonly CLOSED = NativeWebSocket.CLOSED;
      readonly CONNECTING = NativeWebSocket.CONNECTING; readonly OPEN = NativeWebSocket.OPEN;
      readonly CLOSING = NativeWebSocket.CLOSING; readonly CLOSED = NativeWebSocket.CLOSED;
      binaryType: BinaryType = "blob"; bufferedAmount = 0; extensions = ""; protocol = "";
      readyState: number = NativeWebSocket.CONNECTING; url: string; readonly socketId: number;
      onopen: ((event: Event) => void) | null = null; onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null; onclose: ((event: CloseEvent) => void) | null = null;
      constructor(url: string | URL) {
        super(); this.url = String(url); this.socketId = sockets.length;
        if (!this.url.includes("generativelanguage.googleapis.com")) return new NativeWebSocket(url) as unknown as FakeLiveWebSocket;
        sockets.push(this);
        setTimeout(() => { this.readyState = NativeWebSocket.OPEN; this.onopen?.(new Event("open")); }, 0);
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data !== "string") return;
        const message = JSON.parse(data) as Record<string, unknown>; sends.push({ socketId: this.socketId, message });
        if (message.setup) this.deliver({ setupComplete: {} });
      }
      close(code = 1000, reason = "") { this.closeWith(code, reason, true); }
      closeWith(code: number, reason: string, wasClean: boolean) {
        if (this.readyState === NativeWebSocket.CLOSED) return;
        this.readyState = NativeWebSocket.CLOSED; this.onclose?.(new CloseEvent("close", { code, reason, wasClean }));
      }
      deliver(body: Record<string, unknown>) {
        return new Promise<void>((resolve) => setTimeout(() => {
          try {
            this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(body) }));
          } finally {
            resolve();
          }
        }, 0));
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeLiveWebSocket });
    Reflect.set(window, "__QA_LIVE__", {
      sends: () => structuredClone(sends),
      socketCount: () => sockets.length,
      deliver: (body: Record<string, unknown>, socketId = sockets.length - 1) => sockets[socketId]?.deliver(body),
      failActive: () => sockets.at(-1)?.closeWith(1011, "qa socket failure", false),
      pcm,
    });

    const nativeGetUserMedia = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    if (navigator.mediaDevices && nativeGetUserMedia) {
      let microphoneStream: MediaStream | null = null;
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (microphoneFailure) throw new DOMException(microphoneFailure, "NotAllowedError");
        microphoneStream = await nativeGetUserMedia(constraints);
        return microphoneStream;
      };
      Reflect.set(window, "__QA_MICROPHONE__", {
        hasStream: () => Boolean(microphoneStream),
        endTrack: () => microphoneStream?.getAudioTracks()[0]?.dispatchEvent(new Event("ended")),
      });
    }

    const now = new Date().toISOString();
    const firstNode = {
      id: "what-is-a-plc", title: "What is a PLC?", parentId: null, order: 0, childrenIds: [],
      status: reviewReady || completed ? "taught" : "teaching", teaching: {
        objective: "Define a programmable logic controller.", teachingPoints: ["PLC means programmable logic controller.", "PLCs coordinate industrial inputs and outputs."],
        completionCriteria: ["Explain the role of a PLC."], deliveryUnits: [{ objective: "Introduce the PLC definition and role.", teachingPointIndexes: [0, 1], completionCriteriaIndexes: [0], presentationBeats: [{ teachingPointIndexes: [0] }, { teachingPointIndexes: [1] }] }], type: "definition", importance: "core",
      },
    };
    const secondNode = {
      id: "plc-scan-cycle", title: "PLC scan cycle", parentId: null, order: 1, childrenIds: [], status: "teaching", teaching: {
        objective: "Describe the PLC scan cycle.", teachingPoints: ["A PLC repeatedly reads inputs, executes logic, and updates outputs."],
        completionCriteria: ["Name the scan-cycle stages."], deliveryUnits: [{ objective: "Introduce the scan cycle.", teachingPointIndexes: [0], completionCriteriaIndexes: [0], presentationBeats: [{ teachingPointIndexes: [0] }] }], type: "procedure", importance: "core",
      },
    };
    const lesson = {
      schemaVersion, id: lessonId, title: "PLC Fundamentals", lessonFocus: "PLC fundamentals", hasStarted: persisted || completed,
      source: { metadata: { name: "plc-notes.txt", mimeType: "text/plain", sizeBytes: 128, status: "ready" }, prepared: {
        name: "plc-notes.txt", mimeType: "text/plain", text: "A PLC is a rugged industrial computer used to control machines and processes.",
        lessonTree: [{ id: "what-is-a-plc", title: "What is a PLC?", parentId: null, order: 0, teaching: {
          objective: "Define a programmable logic controller.", teachingPoints: ["PLC means programmable logic controller.", "PLCs coordinate industrial inputs and outputs."],
          completionCriteria: ["Explain the role of a PLC."], deliveryUnits: [{ objective: "Introduce the PLC definition and role.", teachingPointIndexes: [0, 1], completionCriteriaIndexes: [0], presentationBeats: [{ teachingPointIndexes: [0] }, { teachingPointIndexes: [1] }] }], type: "definition", importance: "core",
        } }, ...(reviewReady ? [{ id: "plc-scan-cycle", title: "PLC scan cycle", parentId: null, order: 1, teaching: secondNode.teaching }] : [])] } },
      lessonState: { topic: "PLC fundamentals", objective: "Understand PLC fundamentals.", status: persistedStatus, currentNodeId: reviewReady ? "plc-scan-cycle" : "what-is-a-plc", rootNodeIds: reviewReady ? ["what-is-a-plc", "plc-scan-cycle"] : ["what-is-a-plc"], nodes: {
        "what-is-a-plc": firstNode,
        ...(reviewReady ? { "plc-scan-cycle": secondNode } : {}),
      }, teachingContractProgress: { "what-is-a-plc": { nextTeachingPointIndex: persistedCursor }, ...(reviewReady ? { "plc-scan-cycle": { nextTeachingPointIndex: 0 } } : {}) }, resumePoint, interruptionCount: persistedStatus === "interrupted" ? 1 : 0, lastUserTranscript: "not persisted by snapshots", lastAssistantTranscript: "not persisted by snapshots" },
      recentTeachingContext, teachingPreferences, createdAt: now, updatedAt: now, cloudOwnerId,
    };
    const seedMarker = `__qa_lesson_seeded__:${lessonId}`;
    if (sessionStorage.getItem(seedMarker)) return;
    sessionStorage.setItem(seedMarker, "true");
    const request = indexedDB.open("ai-dialog-tutor", 2);
    request.onupgradeneeded = () => { const db = request.result;
      if (!db.objectStoreNames.contains("savedLessons")) db.createObjectStore("savedLessons", { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
      if (!db.objectStoreNames.contains("appState")) db.createObjectStore("appState", { keyPath: "key" });
      if (!db.objectStoreNames.contains("processingJobs")) db.createObjectStore("processingJobs", { keyPath: "id" }).createIndex("createdAt", "createdAt");
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(["savedLessons", "appState"], "readwrite");
      const lessons = tx.objectStore("savedLessons");
      lessons.put(lesson);
      if (secondLesson) {
        const second = structuredClone(lesson);
        second.schemaVersion = 1;
        second.id = "qa-hydraulics-002";
        second.title = "Hydraulics Basics";
        second.lessonFocus = "hydraulic systems";
        second.source.metadata.name = "hydraulics.txt";
        second.source.prepared.name = "hydraulics.txt";
        second.source.prepared.text = "Hydraulic pressure transmits force through fluid.";
        second.lessonState.topic = "Hydraulic systems";
        second.lessonState.teachingContractProgress["what-is-a-plc"].nextTeachingPointIndex = 0;
        second.lessonState.resumePoint = "hydraulic-only resume point";
        second.recentTeachingContext = [{ conceptId: "what-is-a-plc", excerpt: "Hydraulic-only context" }];
        second.createdAt = new Date(Date.parse(now) - 1_000).toISOString();
        second.updatedAt = second.createdAt;
        lessons.put(second);
      }
      tx.objectStore("appState").put({ key: "activeLessonId:anonymous", value: lessonId });
      tx.oncomplete = () => db.close();
    };
  }, {
    lessonId: QA_LESSON_ID,
    persisted: options.persisted ?? false,
    reviewReady: options.reviewReady ?? false,
    completed: options.completed ?? false,
    microphoneFailure: options.microphoneFailure ?? "",
    persistedCursor: options.persistedCursor ?? (options.reviewReady || options.completed ? 2 : 0),
    persistedStatus: options.persistedStatus ?? "idle",
    resumePoint: options.resumePoint ?? (options.persisted || options.completed ? "after introducing the PLC definition" : ""),
    recentTeachingContext: options.recentTeachingContext ?? (options.persisted ? [{ conceptId: "what-is-a-plc", excerpt: "A PLC is a rugged industrial computer." }] : []),
    teachingPreferences: options.teachingPreferences ?? { explanationDepth: "normal", speakingSpeed: "normal" },
    schemaVersion: options.schemaVersion ?? 1,
    cloudOwnerId: options.cloudOwnerId ?? null,
    secondLesson: options.secondLesson ?? false,
    holdFirstPlayerReady: options.holdFirstPlayerReady ?? false,
  });
}

export function getTokenRequestCount(page: Page) {
  return tokenRequests.get(page) ?? 0;
}

export async function releaseFirstPlayerReady(page: Page) {
  await page.evaluate(() => {
    const gate = Reflect.get(window, "__QA_PLAYER_READY__") as { release?: () => void } | undefined;
    if (!gate?.release) throw new Error("Player-ready gate was not installed");
    gate.release();
  });
}

export async function openLessonAndStart(page: Page, persisted = false) {
  await page.goto("/");
  await page.waitForFunction((id) => new Promise<boolean>((resolve) => { const r = indexedDB.open("ai-dialog-tutor", 2); r.onsuccess = () => { const db = r.result; const q = db.transaction("savedLessons", "readonly").objectStore("savedLessons").get(id); q.onsuccess = () => { db.close(); resolve(Boolean(q.result)); }; }; }), QA_LESSON_ID);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__AI_TEACHER_TEST__?.getSnapshot().persistenceHydrated ?? false)).toBe(true);
  if (persisted) {
    await page.locator(".continue-card").getByRole("button", { name: "Continue" }).click();
  } else {
    await page.getByRole("button", { name: "Library" }).click();
    const card = page.locator(".lesson-card").filter({ hasText: /PLC Fundamentals|plc-notes\.txt/ });
    await card.getByRole("button", { name: "Start" }).click();
  }
  await page.getByRole("button", { name: persisted ? "Continue Lesson" : "Start Lesson", exact: true }).click();
  await expect.poll(async () => (await getLiveSends(page)).filter((item) => item.message.realtimeInput).length).toBeGreaterThan(0);
}

export async function getLiveSends(page: Page): Promise<LiveSend[]> { return page.evaluate(() => Reflect.get(window, "__QA_LIVE__").sends()); }
export async function deliverLive(page: Page, body: Record<string, unknown>, socketId?: number) {
  await page.evaluate(({ value, targetSocket }) =>
    Reflect.get(window, "__QA_LIVE__").deliver(value, targetSocket),
  { value: body, targetSocket: socketId });
}
export async function endMicrophoneTrack(page: Page) {
  await page.evaluate(() => Reflect.get(window, "__QA_MICROPHONE__")?.endTrack());
}
export async function failActiveSocket(page: Page) { await page.evaluate(() => Reflect.get(window, "__QA_LIVE__").failActive()); }
export async function readTestState(page: Page) { return page.evaluate(() => ({ snapshot: window.__AI_TEACHER_TEST__!.getSnapshot(), events: window.__AI_TEACHER_TEST__!.getEvents() })); }
export async function readSavedLesson<T = Record<string, unknown>>(page: Page, id = QA_LESSON_ID): Promise<T | undefined> {
  return page.evaluate((lessonId) => new Promise<T | undefined>((resolve, reject) => {
    const request = indexedDB.open("ai-dialog-tutor", 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction("savedLessons", "readonly").objectStore("savedLessons").get(lessonId);
      get.onerror = () => { db.close(); reject(get.error); };
      get.onsuccess = () => { db.close(); resolve(get.result as T | undefined); };
    };
  }), id);
}
export async function readAppState<T = unknown>(page: Page, key = "activeLessonId:anonymous"): Promise<T | undefined> {
  return page.evaluate((stateKey) => new Promise<T | undefined>((resolve, reject) => {
    const request = indexedDB.open("ai-dialog-tutor", 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction("appState", "readonly").objectStore("appState").get(stateKey);
      get.onerror = () => { db.close(); reject(get.error); };
      get.onsuccess = () => { db.close(); resolve(get.result?.value as T | undefined); };
    };
  }), key);
}
export async function holdSavedLessonWrites(page: Page) {
  await page.evaluate((lessonId) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("ai-dialog-tutor", 2);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("savedLessons", "readwrite");
      const store = transaction.objectStore("savedLessons");
      let held = true;
      const keepAlive = () => {
        if (!held) return;
        const request = store.get(lessonId);
        request.onsuccess = keepAlive;
        request.onerror = () => reject(request.error);
      };
      Reflect.set(window, "__QA_RELEASE_SAVED_LESSON_WRITES__", () => { held = false; });
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => reject(transaction.error);
      keepAlive();
      resolve();
    };
  }), QA_LESSON_ID);
}
export async function releaseSavedLessonWrites(page: Page) {
  await page.evaluate(() => {
    const release = Reflect.get(window, "__QA_RELEASE_SAVED_LESSON_WRITES__") as (() => void) | undefined;
    if (!release) throw new Error("Saved-lesson write gate was not installed");
    release();
  });
}
export function textOf(message: Record<string, unknown>) { return JSON.stringify(message); }
