import { expect, type Page } from "@playwright/test";

export const QA_LESSON_ID = "qa-session-lifecycle-001";

export type LiveSend = { socketId: number; message: Record<string, unknown> };

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
} = {}) {
  await page.route("**/auth/v1/**", (route) => route.fulfill({
    status: 401, contentType: "application/json", body: JSON.stringify({ message: "Not signed in" }),
  }));
  await page.route("**/api/gemini-token", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ token: "local-test-token", source: { name: "plc-notes.txt", mimeType: "text/plain" } }),
  }));
  await page.addInitScript(({ lessonId, persisted, reviewReady, completed, microphoneFailure, persistedCursor, persistedStatus, resumePoint, recentTeachingContext, teachingPreferences }) => {
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
      schemaVersion: 1, id: lessonId, title: "PLC Fundamentals", lessonFocus: "PLC fundamentals", hasStarted: persisted || completed,
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
      recentTeachingContext, teachingPreferences, createdAt: now, updatedAt: now,
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
    request.onsuccess = () => { const db = request.result; const tx = db.transaction(["savedLessons", "appState"], "readwrite"); tx.objectStore("savedLessons").put(lesson); tx.objectStore("appState").put({ key: "activeLessonId:anonymous", value: lessonId }); tx.oncomplete = () => db.close(); };
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
    const card = page.locator(".lesson-card").filter({ hasText: "PLC Fundamentals" });
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
export function textOf(message: Record<string, unknown>) { return JSON.stringify(message); }
