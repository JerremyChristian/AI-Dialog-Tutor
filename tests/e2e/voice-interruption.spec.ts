import { expect, test, type Page, type TestInfo } from "@playwright/test";

const LESSON_ID = "qa-voice-interrupt-001";

type TestBridge = {
  getSnapshot(): Record<string, unknown>;
  getEvents(): Array<{ name: string; timestamp: number; detail?: Record<string, unknown> }>;
  clearEvents(): void;
};

test.beforeEach(async ({ page }) => {
  await installConsoleCapture(page);
  await page.route("**/auth/v1/**", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Not signed in" }) });
  });
  await page.addInitScript(({ lessonId }) => {
    const OriginalWebSocket = window.WebSocket;
    const pcm = btoa(String.fromCharCode(...new Uint8Array(32_000)));

    class FakeLiveWebSocket extends EventTarget {
      static readonly CONNECTING = OriginalWebSocket.CONNECTING;
      static readonly OPEN = OriginalWebSocket.OPEN;
      static readonly CLOSING = OriginalWebSocket.CLOSING;
      static readonly CLOSED = OriginalWebSocket.CLOSED;
      readonly CONNECTING = OriginalWebSocket.CONNECTING;
      readonly OPEN = OriginalWebSocket.OPEN;
      readonly CLOSING = OriginalWebSocket.CLOSING;
      readonly CLOSED = OriginalWebSocket.CLOSED;
      binaryType: BinaryType = "blob";
      bufferedAmount = 0;
      extensions = "";
      protocol = "";
      readyState: number = OriginalWebSocket.CONNECTING;
      url: string;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      private teachingStarted = false;
      private interruptionSent = false;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        if (!this.url.includes("generativelanguage.googleapis.com")) {
          return new OriginalWebSocket(url) as unknown as FakeLiveWebSocket;
        }
        setTimeout(() => {
          this.readyState = OriginalWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        }, 0);
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data !== "string") return;
        const message = JSON.parse(data) as Record<string, unknown>;
        if (message.setup) {
          this.deliver({ setupComplete: {} });
          return;
        }
        const realtimeInput = message.realtimeInput as { text?: string; audio?: unknown } | undefined;
        if (realtimeInput?.text?.includes("APP_CONTROL:TEACH_PRESENTATION_BEAT")) {
          this.teachingStarted = true;
          this.deliver({
            serverContent: {
              modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] },
              outputTranscription: { text: "A programmable logic controller coordinates industrial equipment." },
            },
          });
          return;
        }
        if (this.teachingStarted && realtimeInput?.audio && !this.interruptionSent) {
          this.interruptionSent = true;
          setTimeout(() => {
            this.deliver({
              voiceActivity: { voiceActivityType: "ACTIVITY_START" },
              serverContent: { interrupted: true },
            });
            this.deliver({
              serverContent: {
                inputTranscription: { text: "Wait, what exactly is a PLC?", finished: true },
                turnComplete: true,
              },
            });
          }, 250);
        }
      }

      close(code = 1000, reason = "") {
        this.readyState = OriginalWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code, reason, wasClean: true }));
      }

      private deliver(body: Record<string, unknown>) {
        setTimeout(() => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(body) })), 0);
      }
    }

    Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeLiveWebSocket });

    const now = new Date().toISOString();
    const lesson = {
      schemaVersion: 1,
      id: lessonId,
      title: "PLC Fundamentals",
      lessonFocus: "PLC fundamentals",
      hasStarted: false,
      source: {
        metadata: { name: "plc-notes.txt", mimeType: "text/plain", sizeBytes: 128, status: "ready" },
        prepared: {
          name: "plc-notes.txt",
          mimeType: "text/plain",
          text: "A PLC is a rugged industrial computer used to control machines and processes.",
          lessonTree: [{
            id: "what-is-a-plc",
            title: "What is a PLC?",
            parentId: null,
            order: 0,
            teaching: {
              objective: "Define a programmable logic controller.",
              teachingPoints: ["PLC means programmable logic controller.", "PLCs coordinate industrial inputs and outputs."],
              completionCriteria: ["Explain the role of a PLC."],
              deliveryUnits: [{
                objective: "Introduce the PLC definition and role.",
                teachingPointIndexes: [0, 1],
                completionCriteriaIndexes: [0],
                presentationBeats: [{ teachingPointIndexes: [0] }, { teachingPointIndexes: [1] }],
              }],
              type: "definition",
              importance: "core",
            },
          }],
        },
      },
      lessonState: {
        topic: "PLC fundamentals",
        objective: "Understand PLC fundamentals.",
        status: "idle",
        currentNodeId: "what-is-a-plc",
        rootNodeIds: ["what-is-a-plc"],
        nodes: {
          "what-is-a-plc": {
            id: "what-is-a-plc", title: "What is a PLC?", parentId: null, order: 0,
            childrenIds: [], status: "teaching",
            teaching: {
              objective: "Define a programmable logic controller.",
              teachingPoints: ["PLC means programmable logic controller.", "PLCs coordinate industrial inputs and outputs."],
              completionCriteria: ["Explain the role of a PLC."],
              deliveryUnits: [{ objective: "Introduce the PLC definition and role.", teachingPointIndexes: [0, 1], completionCriteriaIndexes: [0], presentationBeats: [{ teachingPointIndexes: [0] }, { teachingPointIndexes: [1] }] }],
              type: "definition", importance: "core",
            },
          },
        },
        teachingContractProgress: { "what-is-a-plc": { nextTeachingPointIndex: 0 } },
        resumePoint: "", interruptionCount: 0, lastUserTranscript: "", lastAssistantTranscript: "",
      },
      recentTeachingContext: [],
      teachingPreferences: { explanationDepth: "normal", speakingSpeed: "normal" },
      createdAt: now,
      updatedAt: now,
    };

    const request = indexedDB.open("ai-dialog-tutor", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("savedLessons")) {
        db.createObjectStore("savedLessons", { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains("appState")) db.createObjectStore("appState", { keyPath: "key" });
      if (!db.objectStoreNames.contains("processingJobs")) {
        db.createObjectStore("processingJobs", { keyPath: "id" }).createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(["savedLessons", "appState"], "readwrite");
      tx.objectStore("savedLessons").put(lesson);
      tx.objectStore("appState").put({ key: "activeLessonId:anonymous", value: lessonId });
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    };
  }, { lessonId: LESSON_ID });

  await page.route("**/api/gemini-token", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: "local-test-token", source: { name: "plc-notes.txt", mimeType: "text/plain" } }),
    });
  });
});

test.afterEach(async ({ page }, testInfo) => {
  await attachDiagnostics(page, testInfo);
});

test("TC-VOICE-INTERRUPT-001 preserves canonical progress during voice barge-in", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.waitForFunction((lessonId) => new Promise<boolean>((resolve) => {
    const request = indexedDB.open("ai-dialog-tutor", 2);
    request.onsuccess = () => {
      const db = request.result;
      const lookup = db.transaction("savedLessons", "readonly").objectStore("savedLessons").get(lessonId);
      lookup.onsuccess = () => { db.close(); resolve(Boolean(lookup.result)); };
      lookup.onerror = () => { db.close(); resolve(false); };
    };
    request.onerror = () => resolve(false);
  }), LESSON_ID);
  await page.reload();
  await expect.poll(() => page.evaluate(() =>
    window.__AI_TEACHER_TEST__?.getSnapshot().persistenceHydrated ?? false,
  ), { timeout: 10_000 }).toBe(true);
  await page.getByRole("button", { name: "Library" }).click();
  const card = page.locator(".lesson-card").filter({ hasText: "PLC Fundamentals" });
  await card.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("heading", { name: "plc-notes.txt" })).toBeVisible();
  const before = await readBridge(page);
  await testInfo.attach("before-snapshot", {
    body: JSON.stringify(before.snapshot, null, 2),
    contentType: "application/json",
  });
  await page.getByRole("button", { name: /start lesson/i }).click();

  await expect.poll(async () => (await readBridge(page)).events.map((event) => event.name))
    .toContain("interruption.accepted");

  const result = await readBridge(page);
  await testInfo.attach("after-snapshot", {
    body: JSON.stringify(result.snapshot, null, 2),
    contentType: "application/json",
  });
  const names = result.events.map((event) => event.name);
  expect(names).toContain("learner.activity-detected");
  expect(names).toContain("interruption.accepted");
  expect(names).not.toContain("beat.commit");
  expect(result.snapshot.currentNodeId).toBe("what-is-a-plc");
  expect(result.snapshot.deliveryCursor).toBe(0);
  expect((result.snapshot.coverage as Record<string, string>)["what-is-a-plc"]).toBe("teaching");
  expect(result.snapshot.interruptionCount).toBe(1);
  expect(result.snapshot.lessonActive).toBe(true);
  expect(["active", "rollover-ready"]).toContain(result.snapshot.connectionState);
});

async function readBridge(page: Page) {
  return page.evaluate(() => {
    const bridge = window.__AI_TEACHER_TEST__ as TestBridge | undefined;
    if (!bridge) throw new Error("Test observability bridge is unavailable");
    return { snapshot: bridge.getSnapshot(), events: bridge.getEvents() };
  });
}

async function installConsoleCapture(page: Page) {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`[pageerror] ${error.stack ?? error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) messages.push(`[response ${response.status()}] ${response.url()}`);
  });
  Reflect.set(page, "__consoleMessages", messages);
}

async function attachDiagnostics(page: Page, testInfo: TestInfo) {
  const messages = Reflect.get(page, "__consoleMessages") as string[] | undefined;
  await testInfo.attach("browser-console", { body: (messages ?? []).join("\n"), contentType: "text/plain" });
  const diagnostics = await page.evaluate(() => ({
    snapshot: window.__AI_TEACHER_TEST__?.getSnapshot() ?? null,
    events: window.__AI_TEACHER_TEST__?.getEvents() ?? [],
  })).catch(() => ({ snapshot: null, events: [] }));
  await testInfo.attach("test-observability", {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: "application/json",
  });
}
