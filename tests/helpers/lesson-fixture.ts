// Deterministic lesson fixtures shared by fake-Live E2E seeding and Q3 evidence
// tests. Pure data and builders only: no Playwright or browser imports, so unit
// tests can use the same fixtures as the browser runs.

export type FixtureTeaching = {
  objective: string;
  teachingPoints: string[];
  completionCriteria: string[];
  deliveryUnits: Array<{
    objective: string;
    teachingPointIndexes: number[];
    completionCriteriaIndexes: number[];
    presentationBeats: Array<{ teachingPointIndexes: number[] }>;
  }>;
  type: "definition" | "procedure" | "concept" | "overview";
  importance: "core" | "supporting" | "optional";
};

export type FixtureConcept = { id: string; title: string; teaching: FixtureTeaching };

export type LessonFixture = {
  fixtureId: string;
  fixtureVersion: string;
  title: string;
  lessonFocus: string;
  topic: string;
  objective: string;
  sourceName: string;
  sourceText: string;
  concepts: FixtureConcept[];
};

// Q3 fixture: 3 core concepts and 1 optional concept, 7 canonical beats.
// Concept ids must equal the slug of their titles: the app re-derives node ids
// from titles when it normalizes a saved lesson tree.
// The optional concept sits between core concepts so skipping it is a
// meaningful Core Path decision rather than a trailing no-op.
export const PLC_Q3_FIXTURE: LessonFixture = {
  fixtureId: "plc-q3",
  fixtureVersion: "1",
  title: "PLC Fundamentals",
  lessonFocus: "PLC fundamentals",
  topic: "PLC fundamentals",
  objective: "Understand what a PLC is, how it scans, and how it connects to field devices.",
  sourceName: "plc-notes.txt",
  sourceText: "A PLC is a rugged industrial computer used to control machines and processes. " +
    "It repeatedly scans inputs, executes its program, and updates outputs. " +
    "Input and output modules connect the PLC to sensors and actuators. " +
    "PLCs replaced hard-wired relay panels in the late 1960s.",
  concepts: [
    {
      id: "what-is-a-plc", title: "What is a PLC?", teaching: {
        objective: "Define a programmable logic controller.",
        teachingPoints: [
          "PLC means programmable logic controller.",
          "PLCs coordinate industrial inputs and outputs.",
        ],
        completionCriteria: ["Explain the role of a PLC."],
        deliveryUnits: [{
          objective: "Introduce the PLC definition and role.",
          teachingPointIndexes: [0, 1],
          completionCriteriaIndexes: [0],
          presentationBeats: [{ teachingPointIndexes: [0] }, { teachingPointIndexes: [1] }],
        }],
        type: "definition", importance: "core",
      },
    },
    {
      id: "plc-scan-cycle", title: "PLC scan cycle", teaching: {
        objective: "Describe the PLC scan cycle.",
        teachingPoints: [
          "A PLC first reads the state of every input.",
          "It then executes its control program against those inputs.",
          "Finally it updates outputs and repeats the cycle.",
        ],
        completionCriteria: ["Name the scan-cycle stages in order."],
        deliveryUnits: [{
          objective: "Walk through the scan cycle.",
          teachingPointIndexes: [0, 1, 2],
          completionCriteriaIndexes: [0],
          presentationBeats: [{ teachingPointIndexes: [0] }, { teachingPointIndexes: [1, 2] }],
        }],
        type: "procedure", importance: "core",
      },
    },
    {
      id: "plc-history", title: "PLC history", teaching: {
        objective: "Give historical context for PLCs.",
        teachingPoints: ["PLCs replaced hard-wired relay panels because programs are easier to change than wiring."],
        completionCriteria: ["State why relay panels were replaced."],
        deliveryUnits: [{
          objective: "Explain the relay-to-PLC transition.",
          teachingPointIndexes: [0],
          completionCriteriaIndexes: [0],
          presentationBeats: [{ teachingPointIndexes: [0] }],
        }],
        type: "overview", importance: "optional",
      },
    },
    {
      id: "plc-io-modules", title: "PLC IO modules", teaching: {
        objective: "Explain how PLCs connect to field devices.",
        teachingPoints: [
          "Input modules convert sensor signals into values the PLC program can read.",
          "Output modules turn program decisions into signals that drive actuators.",
        ],
        completionCriteria: ["Distinguish input modules from output modules."],
        deliveryUnits: [{
          objective: "Introduce input and output modules.",
          teachingPointIndexes: [0, 1],
          completionCriteriaIndexes: [0],
          presentationBeats: [{ teachingPointIndexes: [0] }, { teachingPointIndexes: [1] }],
        }],
        type: "concept", importance: "core",
      },
    },
  ],
};

export function countFixtureBeats(fixture: LessonFixture) {
  return fixture.concepts.reduce((total, concept) => total + concept.teaching.deliveryUnits
    .reduce((sum, unit) => sum + unit.presentationBeats.length, 0), 0);
}

/**
 * Builds the schema-1 SavedLesson shape the app hydrates from IndexedDB, at the
 * start of a fresh lesson: first concept current, every cursor at zero. Dates
 * are supplied by the caller so the in-browser seed stays deterministic.
 */
export function buildFixtureSavedLesson(
  fixture: LessonFixture,
  lessonId: string,
  options: { now: string; schemaVersion?: number; cloudOwnerId?: string | null } ,
) {
  const [first] = fixture.concepts;
  return {
    schemaVersion: options.schemaVersion ?? 1,
    id: lessonId,
    title: fixture.title,
    lessonFocus: fixture.lessonFocus,
    hasStarted: false,
    source: {
      metadata: { name: fixture.sourceName, mimeType: "text/plain", sizeBytes: fixture.sourceText.length, status: "ready" },
      prepared: {
        name: fixture.sourceName,
        mimeType: "text/plain",
        text: fixture.sourceText,
        lessonTree: fixture.concepts.map((concept, order) => ({
          id: concept.id, title: concept.title, parentId: null, order, teaching: concept.teaching,
        })),
      },
    },
    lessonState: {
      topic: fixture.topic,
      objective: fixture.objective,
      status: "idle",
      currentNodeId: first.id,
      rootNodeIds: fixture.concepts.map((concept) => concept.id),
      nodes: Object.fromEntries(fixture.concepts.map((concept, order) => [concept.id, {
        id: concept.id, title: concept.title, parentId: null, order, childrenIds: [],
        status: concept.id === first.id ? "teaching" : "not-started",
        teaching: concept.teaching,
      }])),
      teachingContractProgress: Object.fromEntries(fixture.concepts
        .map((concept) => [concept.id, { nextTeachingPointIndex: 0 }])),
      resumePoint: "",
      interruptionCount: 0,
      lastUserTranscript: "not persisted by snapshots",
      lastAssistantTranscript: "not persisted by snapshots",
    },
    recentTeachingContext: [],
    teachingPreferences: { explanationDepth: "normal", speakingSpeed: "normal" },
    createdAt: options.now,
    updatedAt: options.now,
    cloudOwnerId: options.cloudOwnerId ?? null,
  };
}

export type FixtureSavedLesson = ReturnType<typeof buildFixtureSavedLesson>;
