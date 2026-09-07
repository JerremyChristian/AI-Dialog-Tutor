import type { AtomicTeachingContract, LessonTreeItem } from "./learning-source";
import {
  DEFAULT_TEACHING_PREFERENCES,
  buildTeachingPreferenceInstruction,
  type TeachingPreferences,
} from "./teaching-preferences";

export const GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
export const PERSISTED_LESSON_RESUME_CONTROL =
  "[[APP_CONTROL:PERSISTED_LESSON_RESUME:RECAP_THEN_RESUME_LOCATION_THEN_CONTINUE_TEACHING;DO_NOT_ASK_WHAT_TO_COVER]]";

export type LessonStatus = "idle" | "teaching" | "interrupted" |
  "resolving-interruption" | "resuming" | "completed";
export type LessonSessionStartMode = "new" | "persisted-resume";
export type CoverageStatus =
  "not-started" | "teaching" | "partial" | "taught" | "skipped";
export type LessonNode = LessonTreeItem & {
  childrenIds: string[];
  status: CoverageStatus;
};
export type CompletedTeachingCheckpoint = {
  conceptId: string;
  teachingPointIndex: number;
  teachingPoint: string;
  transcriptExcerpt?: string;
  completedAt: string;
};

export type TeachingContractProgress = {
  nextTeachingPointIndex: number;
  lastCompletedCheckpoint?: CompletedTeachingCheckpoint;
};
export type LessonState = {
  topic: string;
  objective: string;
  status: LessonStatus;
  currentNodeId: string | null;
  rootNodeIds: string[];
  nodes: Record<string, LessonNode>;
  teachingContractProgress: Record<string, TeachingContractProgress>;
  interruptionCount: number;
  lastUserTranscript: string;
  lastAssistantTranscript: string;
};

type LessonAction = "navigate" | "progress" | "complete" | "skip" | "query";
export type LessonStateResult = {
  ok: boolean;
  action: LessonAction;
  message: string;
  currentNodeId: string | null;
  currentPath: string[];
  nodes: Array<Pick<LessonNode, "id" | "title" | "parentId" | "status">>;
  currentNodeTitle?: string | null;
  currentNodeStatus?: CoverageStatus | null;
  currentTeachingContract?: AtomicTeachingContract;
  currentTeachingProgress?: TeachingContractProgress & {
    confirmedTeachingPoints: string[];
    nextTeachingPoint: string | null;
    remainingTeachingPoints: string[];
  };
  totalTeachingPoints?: number;
  pointsHeard?: number;
  nextSequentialNode?: { id: string; title: string } | null;
  relevantNodes?: Array<{ id: string; title: string; status: CoverageStatus }>;
  completedNodeId?: string;
  noOp?: boolean;
  reason?: "already_taught";
  error?: "unknown_concept_id" | "invalid_transition" | "incomplete_teaching_contract";
  validRelevantNodes?: Array<{ id: string; title: string }>;
  recoveryRequired?: boolean;
};

export function createLessonState(topic: string, tree: LessonTreeItem[] = []): LessonState {
  const nodes: Record<string, LessonNode> = Object.fromEntries(
    tree.map((item) => [item.id, {
      ...item,
      childrenIds: [] as string[],
      status: "not-started" as CoverageStatus,
    }]),
  );
  for (const node of Object.values(nodes)) {
    if (node.parentId && nodes[node.parentId]) nodes[node.parentId].childrenIds.push(node.id);
    else node.parentId = null;
  }
  for (const node of Object.values(nodes)) {
    node.childrenIds.sort((a, b) => compareNodes(nodes[a], nodes[b]));
  }
  const rootNodeIds = Object.values(nodes)
    .filter((node) => node.parentId === null)
    .sort(compareNodes)
    .map((node) => node.id);
  const first = getAtomicNodeIds({ rootNodeIds, nodes })[0] ?? null;
  if (first) nodes[first].status = "teaching";
  return {
    topic,
    objective: `Understand the core ideas of ${topic} through a concise spoken lesson.`,
    status: "idle",
    currentNodeId: first,
    rootNodeIds,
    nodes: deriveParentStatuses(nodes, first),
    teachingContractProgress: createTeachingContractProgress(nodes),
    interruptionCount: 0,
    lastUserTranscript: "",
    lastAssistantTranscript: "",
  };
}

export function getCurrentConcept(state: LessonState) {
  return state.currentNodeId ? state.nodes[state.currentNodeId] : undefined;
}

export function createTeachingContractProgress(
  nodes: Record<string, LessonNode>,
): Record<string, TeachingContractProgress> {
  return Object.fromEntries(Object.values(nodes)
    .filter((node) => node.childrenIds.length === 0 && Boolean(node.teaching))
    .map((node) => [node.id, {
      nextTeachingPointIndex: node.status === "taught"
        ? node.teaching!.teachingPoints.length
        : 0,
    }]));
}

export function normalizeTeachingContractProgress(
  nodes: Record<string, LessonNode>,
  value: unknown,
): Record<string, TeachingContractProgress> {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return Object.fromEntries(Object.values(nodes)
    .filter((node) => node.childrenIds.length === 0 && Boolean(node.teaching))
    .map((node) => {
      const raw = candidate[node.id];
      const rawNext = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).nextTeachingPointIndex
        : undefined;
      const fallback = node.status === "taught" ? node.teaching!.teachingPoints.length : 0;
      const next = node.status === "taught"
        ? node.teaching!.teachingPoints.length
        : typeof rawNext === "number" && Number.isFinite(rawNext)
        ? Math.trunc(rawNext)
        : fallback;
      const boundedNext = Math.max(0, Math.min(node.teaching!.teachingPoints.length, next));
      const rawCheckpoint = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).lastCompletedCheckpoint
        : undefined;
      const parsedCheckpoint = parseCompletedCheckpoint(node, rawCheckpoint);
      const compatibilityIndex = boundedNext - 1;
      const compatibilityCheckpoint = compatibilityIndex >= 0 ? {
        conceptId: node.id,
        teachingPointIndex: compatibilityIndex,
        teachingPoint: node.teaching!.teachingPoints[compatibilityIndex],
        completedAt: new Date(0).toISOString(),
      } : undefined;
      return [node.id, {
        nextTeachingPointIndex: boundedNext,
        ...(parsedCheckpoint || compatibilityCheckpoint
          ? { lastCompletedCheckpoint: parsedCheckpoint || compatibilityCheckpoint }
          : {}),
      }];
    }));
}

function parseCompletedCheckpoint(
  node: LessonNode,
  value: unknown,
): CompletedTeachingCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !node.teaching) return;
  const checkpoint = value as Record<string, unknown>;
  const index = checkpoint.teachingPointIndex;
  if (checkpoint.conceptId !== node.id || typeof index !== "number" ||
      !Number.isInteger(index) || index < 0 || index >= node.teaching.teachingPoints.length ||
      typeof checkpoint.completedAt !== "string") return;
  return {
    conceptId: node.id,
    teachingPointIndex: index,
    teachingPoint: node.teaching.teachingPoints[index],
    ...(typeof checkpoint.transcriptExcerpt === "string" && checkpoint.transcriptExcerpt
      ? { transcriptExcerpt: checkpoint.transcriptExcerpt.slice(0, 420) }
      : {}),
    completedAt: checkpoint.completedAt,
  };
}

export function progressLessonTeachingPoint(
  state: LessonState,
  conceptId: string,
  teachingPointIndex: number,
  transcriptExcerpt?: string,
) {
  const node = state.nodes[conceptId];
  if (!node) return unknownConceptError(state, "progress");
  if (!node.teaching || node.childrenIds.length) {
    return transitionError(state, "progress", `${node.title} has no valid atomic teaching contract`);
  }
  if (state.currentNodeId !== conceptId) {
    return transitionError(state, "progress", "Only the current atomic concept can report teaching progress");
  }
  if (!Number.isInteger(teachingPointIndex) || teachingPointIndex < 0 ||
      teachingPointIndex >= node.teaching.teachingPoints.length) {
    return transitionError(state, "progress", "Teaching point index is outside the current contract");
  }
  const currentNext = state.teachingContractProgress[conceptId]?.nextTeachingPointIndex ?? 0;
  const reportedNext = teachingPointIndex + 1;
  if (teachingPointIndex !== currentNext) {
    return transitionError(state, "progress", "Only the authoritative next teaching point can be committed");
  }
  if (reportedNext <= currentNext) {
    return {
      state,
      result: {
        ...snapshot(state, "progress", true, "Teaching point progress was already recorded"),
        noOp: true,
      },
      events: [
        `Teaching point progress ignored: concept=${conceptId}, reported=${teachingPointIndex}, currentNext=${currentNext}`,
      ],
    };
  }
  const nextState: LessonState = {
    ...state,
    teachingContractProgress: {
      ...state.teachingContractProgress,
      [conceptId]: {
        nextTeachingPointIndex: reportedNext,
        lastCompletedCheckpoint: {
          conceptId,
          teachingPointIndex,
          teachingPoint: node.teaching.teachingPoints[teachingPointIndex],
          ...(transcriptExcerpt ? { transcriptExcerpt } : {}),
          completedAt: new Date().toISOString(),
        },
      },
    },
  };
  return {
    state: nextState,
    result: snapshot(
      nextState,
      "progress",
      true,
      "Teaching point audio-confirmed and committed.",
    ),
    events: [
      `Teaching point completed: concept=${conceptId}, point=${teachingPointIndex}, next=${reportedNext}`,
    ],
  };
}

export function pauseLessonState(state: LessonState) {
  const nodes = cloneNodes(state.nodes);
  const current = getCurrentConcept(state);
  if (current?.status === "teaching") nodes[current.id].status = "partial";
  return {
    ...state,
    status: "idle" as const,
    nodes: deriveParentStatuses(nodes, state.currentNodeId),
  };
}

export function isTeachableLessonNode(node: LessonNode) {
  return node.childrenIds.length === 0 && Boolean(node.teaching);
}

export function getLessonTreeRows(state: LessonState) {
  const rows: Array<{ node: LessonNode; depth: number }> = [];
  const visit = (id: string, depth: number) => {
    const node = state.nodes[id];
    if (!node) return;
    rows.push({ node, depth });
    node.childrenIds.forEach((childId) => visit(childId, depth + 1));
  };
  state.rootNodeIds.forEach((rootId) => visit(rootId, 0));
  return rows;
}

export function navigateLessonState(state: LessonState, requestedId: string) {
  const requested = state.nodes[requestedId];
  if (!requested) return unknownConceptError(state, "navigate");
  const targetId = requested.childrenIds.length
    ? getFirstIncompleteDescendant(state, requested.id)
    : requested.id;
  if (!targetId) {
    return transitionError(state, "navigate", `${requested.title} has no incomplete atomic concepts`);
  }
  const target = state.nodes[targetId];
  const current = getCurrentConcept(state);
  if (current?.id === target.id) {
    return transitionSuccess(state, "navigate", `${target.title} is already current`, []);
  }

  const events = [`Navigation requested: ${requested.title}`];
  if (target.status === "skipped") events.push(`Returned to skipped concept: ${target.title}`);
  const nodes = cloneNodes(state.nodes);
  if (current?.status === "teaching") {
    nodes[current.id].status = "partial";
    events.push(`Concept partial: ${current.title}`);
  }
  const atomicIds = getAtomicNodeIds(state);
  const from = current ? atomicIds.indexOf(current.id) : -1;
  const to = atomicIds.indexOf(target.id);
  if (from >= 0 && to > from) {
    for (const id of atomicIds.slice(from + 1, to)) {
      if (nodes[id].status === "not-started") {
        nodes[id].status = "skipped";
        events.push(`Concept skipped: ${nodes[id].title}`);
      }
    }
  }
  if (nodes[target.id].status !== "taught") nodes[target.id].status = "teaching";
  if (target.teaching) events.push(`Teaching contract loaded: ${target.title}`);
  events.push(`Atomic concept started: ${target.title}`, `Moved to concept: ${target.title}`);
  const next = {
    ...withDerivedNodes(state, nodes, target.id, "teaching"),
  };
  return transitionSuccess(next, "navigate", `Moved to ${target.title}`, events);
}

export function completeLessonConcept(state: LessonState, conceptId: string) {
  const node = state.nodes[conceptId];
  const current = getCurrentConcept(state);
  if (!node) return unknownConceptError(state, "complete");
  if (node.status === "taught") {
    return {
      state,
      result: {
        ...snapshot(state, "complete", true, "Completion already recorded"),
        noOp: true,
        reason: "already_taught" as const,
        completedNodeId: node.id,
      },
      events: [`Duplicate completion ignored: ${node.title}`],
    };
  }
  if (node.childrenIds.length) {
    return transitionError(state, "complete", `${node.title} is not an atomic concept`);
  }
  if (!node.teaching) {
    return transitionError(state, "complete", `${node.title} has no valid atomic teaching contract`);
  }
  if (!current || current.id !== node.id) {
    return transitionError(state, "complete", "Only the current atomic concept can be completed");
  }
  if (node.status !== "teaching" && node.status !== "partial") {
    return transitionError(state, "complete", `${node.title} is not currently being taught`);
  }
  const nextTeachingPointIndex =
    state.teachingContractProgress[node.id]?.nextTeachingPointIndex ?? 0;
  if (nextTeachingPointIndex < node.teaching.teachingPoints.length) {
    const result = transitionError(
      state,
      "complete",
      `Teaching contract is incomplete; continue from teaching point ${nextTeachingPointIndex}`,
      "incomplete_teaching_contract",
      false,
    );
    return result;
  }
  const nodes = cloneNodes(state.nodes);
  nodes[node.id].status = "taught";
  const atomicIds = getAtomicNodeIds(state);
  const completedIndex = atomicIds.indexOf(node.id);
  const nextId = atomicIds.slice(completedIndex + 1).find((id) =>
    nodes[id].status !== "taught" && nodes[id].status !== "skipped",
  ) ?? null;
  if (nextId) nodes[nextId].status = "teaching";
  const next = {
    ...withDerivedNodes(state, nodes, nextId, "teaching"),
  };
  const events = [`Atomic concept completed: ${node.title}`];
  if (nextId) events.push(`Sequential advancement: ${node.title} -> ${nodes[nextId].title}`);
  return {
    state: next,
    result: {
      ...snapshot(next, "complete", true, nextId
        ? `Completed ${node.title}; continue with ${nodes[nextId].title}`
        : `Completed ${node.title}; no later atomic concept remains`),
      completedNodeId: node.id,
    },
    events,
  };
}

export function skipLessonNode(state: LessonState, conceptId: string) {
  const target = state.nodes[conceptId];
  if (!target) return unknownConceptError(state, "skip");
  const leaves = getLeafDescendants(state, target.id);
  const nodes = cloneNodes(state.nodes);
  const events = [`Skip requested: ${target.title}`];
  for (const id of leaves) {
    const node = nodes[id];
    if (node.status === "taught" || node.status === "partial") continue;
    if (id === state.currentNodeId && node.status === "teaching") {
      node.status = "partial";
      events.push(`Concept partial: ${node.title}`);
    } else if (node.status === "not-started" || node.status === "teaching") {
      node.status = "skipped";
      events.push(`Concept skipped: ${node.title}`);
    }
  }
  const currentInside = Boolean(state.currentNodeId && leaves.includes(state.currentNodeId));
  const next = withDerivedNodes(
    state,
    nodes,
    currentInside ? null : state.currentNodeId,
    "teaching",
  );
  return transitionSuccess(
    next,
    "skip",
    `Skipped unfinished content under ${target.title}`,
    events,
  );
}

export function queryLessonState(state: LessonState) {
  return snapshot(state, "query", true, "Authoritative hierarchical lesson coverage snapshot");
}

export function getNextSequentialConcept(state: LessonState) {
  if (!state.currentNodeId) return null;
  const atomicIds = getAtomicNodeIds(state);
  const currentIndex = atomicIds.indexOf(state.currentNodeId);
  const id = atomicIds.slice(currentIndex + 1).find((candidateId) => {
    const status = state.nodes[candidateId].status;
    return status !== "taught" && status !== "skipped";
  });
  return id ? state.nodes[id] : null;
}

function getFirstIncompleteDescendant(state: LessonState, nodeId: string) {
  return getLeafDescendants(state, nodeId)
    .find((id) => state.nodes[id].status !== "taught") ?? null;
}

function getLeafDescendants(state: Pick<LessonState, "nodes">, nodeId: string): string[] {
  const node = state.nodes[nodeId];
  if (!node) return [];
  return node.childrenIds.length
    ? node.childrenIds.flatMap((id) => getLeafDescendants(state, id))
    : [node.id];
}

function getAtomicNodeIds(state: Pick<LessonState, "rootNodeIds" | "nodes">) {
  return state.rootNodeIds.flatMap((id) => getLeafDescendants(state, id));
}

function getAncestors(nodes: Record<string, LessonNode>, nodeId: string | null) {
  const ids: string[] = [];
  let parentId = nodeId ? nodes[nodeId]?.parentId : null;
  while (parentId && nodes[parentId]) {
    ids.unshift(parentId);
    parentId = nodes[parentId].parentId;
  }
  return ids;
}

function deriveParentStatuses(nodes: Record<string, LessonNode>, currentId: string | null) {
  const next = cloneNodes(nodes);
  const currentIsTeaching = Boolean(
    currentId && next[currentId]?.status === "teaching",
  );
  const activePath = new Set(
    currentIsTeaching && currentId
      ? [...getAncestors(next, currentId), currentId]
      : [],
  );
  const parents = Object.values(next)
    .filter((node) => node.childrenIds.length)
    .sort((a, b) => getAncestors(next, b.id).length - getAncestors(next, a.id).length);
  for (const parent of parents) {
    const leaves = getLeafDescendants({ nodes: next }, parent.id).map((id) => next[id]);
    if (activePath.has(parent.id)) parent.status = "teaching";
    else if (leaves.every((leaf) => leaf.status === "not-started")) parent.status = "not-started";
    else if (leaves.every((leaf) => leaf.status === "taught")) parent.status = "taught";
    else if (leaves.every((leaf) => leaf.status === "skipped")) parent.status = "skipped";
    else parent.status = "partial";
  }
  return next;
}

function withDerivedNodes(
  state: LessonState,
  nodes: Record<string, LessonNode>,
  currentNodeId: string | null,
  status: LessonStatus,
): LessonState {
  const derived = deriveParentStatuses(nodes, currentNodeId);
  const hasOutstanding = Object.values(derived).some(
    (node) => !node.childrenIds.length && node.status !== "taught" && node.status !== "skipped",
  );
  return {
    ...state,
    nodes: derived,
    currentNodeId,
    status:
      (currentNodeId && derived[currentNodeId]?.status === "teaching") || hasOutstanding
        ? status
        : "completed",
  };
}

function cloneNodes(nodes: Record<string, LessonNode>) {
  return Object.fromEntries(Object.entries(nodes).map(([id, node]) => [
    id,
    { ...node, childrenIds: [...node.childrenIds] },
  ]));
}

function compareNodes(a: LessonNode, b: LessonNode) {
  return a.order - b.order || a.title.localeCompare(b.title);
}

function transitionError(
  state: LessonState,
  action: LessonAction,
  message: string,
  error: "invalid_transition" | "incomplete_teaching_contract" = "invalid_transition",
  recoveryRequired = true,
) {
  return {
    state,
    result: {
      ...snapshot(state, action, false, message),
      error,
      recoveryRequired,
    },
    events: [] as string[],
  };
}

function unknownConceptError(state: LessonState, action: LessonAction) {
  const current = getCurrentConcept(state);
  const relevantIds = new Set<string>();
  if (current) {
    relevantIds.add(current.id);
    const next = getNextSequentialConcept(state);
    if (next) relevantIds.add(next.id);
    for (const sibling of Object.values(state.nodes)) {
      if (sibling.parentId === current.parentId) relevantIds.add(sibling.id);
    }
  }
  return {
    state,
    result: {
      ...snapshot(state, action, false, "The requested concept is not in the authoritative lesson tree"),
      error: "unknown_concept_id" as const,
      recoveryRequired: true,
      validRelevantNodes: [...relevantIds].slice(0, 8).map((id) => ({
        id,
        title: state.nodes[id].title,
      })),
    },
    events: ["Invalid concept ID received"],
  };
}

function transitionSuccess(state: LessonState, action: LessonAction, message: string, events: string[]) {
  return { state, result: snapshot(state, action, true, message), events };
}

function snapshot(state: LessonState, action: LessonAction, ok: boolean, message: string): LessonStateResult {
  const current = getCurrentConcept(state);
  const next = getNextSequentialConcept(state);
  const currentNextTeachingPointIndex = current?.teaching
    ? state.teachingContractProgress[current.id]?.nextTeachingPointIndex ?? 0
    : null;
  return {
    ok,
    action,
    message,
    currentNodeId: state.currentNodeId,
    currentPath: state.currentNodeId
      ? [...getAncestors(state.nodes, state.currentNodeId), state.currentNodeId]
      : [],
    nodes: getLessonTreeRows(state).map(({ node }) => ({
      id: node.id,
      title: node.title,
      parentId: node.parentId,
      status: node.status,
    })),
    currentNodeTitle: current?.title ?? null,
    currentNodeStatus: current?.status ?? null,
    currentTeachingContract: current?.teaching,
    currentTeachingProgress: current?.teaching && currentNextTeachingPointIndex !== null
      ? {
          nextTeachingPointIndex: currentNextTeachingPointIndex,
          ...(state.teachingContractProgress[current.id]?.lastCompletedCheckpoint
            ? { lastCompletedCheckpoint: state.teachingContractProgress[current.id].lastCompletedCheckpoint }
            : {}),
          confirmedTeachingPoints:
            current.teaching.teachingPoints.slice(0, currentNextTeachingPointIndex),
          nextTeachingPoint:
            current.teaching.teachingPoints[currentNextTeachingPointIndex] ?? null,
          remainingTeachingPoints:
            current.teaching.teachingPoints.slice(currentNextTeachingPointIndex),
        }
      : undefined,
    totalTeachingPoints: current?.teaching?.teachingPoints.length,
    pointsHeard: currentNextTeachingPointIndex ?? undefined,
    nextSequentialNode: next ? { id: next.id, title: next.title } : null,
    relevantNodes: current
      ? Object.values(state.nodes)
        .filter((node) => node.parentId === current.parentId)
        .sort(compareNodes)
        .slice(0, 8)
        .map((node) => ({ id: node.id, title: node.title, status: node.status }))
      : [],
  };
}

export function buildLessonInstruction(
  topic: string,
  sourceName?: string,
  teachingPreferences: TeachingPreferences = DEFAULT_TEACHING_PREFERENCES,
  sessionStartMode: LessonSessionStartMode = "new",
) {
  const sourceGuidance = sourceName
    ? `You are conducting a spoken one-on-one lesson based primarily on educational material uploaded by the learner. The source is named: ${sourceName}.

${topic ? `The learner's requested focus within the source is: ${topic}.` : "Teach the main topics of the uploaded source."}

Treat the supplied material as the authoritative course reference for topics, terminology, notation, conventions, equations, examples, and teaching sequence. Answer primarily from it when it covers the question. Use reliable general knowledge for relevant gaps, distinguish that extension when useful, and never claim outside knowledge came from the source. Follow source conventions for course-specific work.`
    : `You are conducting a spoken one-on-one lesson about: ${topic}.`;

  const persistedResumeGuidance = sessionStartMode === "persisted-resume"
    ? `
This fresh Live connection is starting a user-visible continuation of a locally persisted lesson. It is the same tutor and lesson, but you have only the supplied authoritative state—not unsaved conversational memory.

When and only when you receive ${PERSISTED_LESSON_RESUME_CONTROL}, the FIRST learner-visible response has a strict three-part contract: RECAP, RESUME LOCATION, then CONTINUE TEACHING. Produce all three in that order in the same response:
- CONTRACT PROGRESS IS AUTHORITATIVE: confirmedTeachingPoints were audio-confirmed; nextTeachingPoint is the exact point to teach now. Never infer delivery from transcript text.
- LAST CHECKPOINT: lastCompletedCheckpoint is the most recent audio-confirmed point. Its structured teachingPoint anchors the recap; transcriptExcerpt is optional supporting wording only.
- RECAP: name the current concept and briefly recap lastCompletedCheckpoint when present. If absent, say the concept is beginning without inventing prior content.
- RESUME LOCATION: identify nextTeachingPoint as the authoritative continuation point.
- CONTINUE TEACHING: immediately teach exactly nextTeachingPoint. If it was partly spoken but uncommitted previously, restart it cleanly. Do not teach another point in this generation.
- If the current concept has not yet been meaningfully taught after a completed predecessor, briefly connect the last covered concept to the new current concept without claiming the new one was covered.
- If the current concept is already taught, describe it as a review location, not unfinished work.
- If no checkpoint exists, use a safe generic orientation and never invent prior dialogue or details.

The first spoken sentence after this control must orient the learner. When previousCoveredConceptTitle is present, briefly connect it to the current concept. Then teach the one authoritative next point. NEVER ask what the learner wants to cover or where to continue; authoritative state has decided.

For overview depth, use one concise substantive recap sentence and one concise resume-location/transition sentence before immediately continuing; overview never permits omitting the recap. For normal, use roughly 2–3 concise orientation sentences. For detailed, use no more than 4 concise orientation sentences. It is a recap, not reteaching or a quiz. Apply the current speakingSpeed from the first spoken word. Do not welcome the learner, restart the lesson, request confirmation, change coverage, or call complete merely because the recap mentioned content. Never repeat this briefing after navigation, interruption, tool calls, or transport rollover.`
    : "";

  return `${sourceGuidance}

${buildTeachingPreferenceInstruction(teachingPreferences)}
${persistedResumeGuidance}

Lesson coverage is application-owned. LESSON_TREE is hierarchical. Parent topics aggregate atomic descendants; teaching one child never means siblings or the parent were fully taught. Use the most specific atomic ID whenever possible.

For every genuine learner-originated post-start turn, call learner_turn_intent before producing learner-facing output. This tool call and its response remain inside the same provider generation; do not create a second response. Never call learner_turn_intent for text wrapped in [[APP_CONTROL:...]]; application controls are not learner speech and their named instruction is authoritative. Acknowledgements/readiness such as yes, okay, continue, got it, makes sense, ready, or equivalent use continue. Genuine explanatory questions use clarify. Re-explanation requests use repeat. Lesson-position or coverage questions use query-state and must be answered only from its returned authoritative application state. Never infer current location, completed points, or what comes next from conversational memory.

Use the one lesson_state function:
- navigate: explicit movement to a leaf or parent. Parent navigation resolves to an incomplete descendant.
- skip: explicit skipping of a concept or subtree. Never use it for clarification. If teaching should continue elsewhere afterward, call navigate before teaching that atomic concept.
- progress: after generating the one teachingPoints entry assigned to this response and all desired closing/check-in wording, report its zero-based teachingPointIndex, conceptId, and afterDelivery=await-learner. This registers pending completion only; the application commits after audio naturally drains. Progress is the FINAL semantic action: after its result emit no learner-facing text or audio and end the generation. A response may report only its assigned point.
- complete: only the current atomic concept after all teaching points have been reported through progress and the completionCriteria are meaningfully satisfied. Never silently treat unreported points as delivered. Never complete a parent or infer completion from a response ending, elapsed time, a concept mention, one covered point, or a clarification. A successful complete automatically selects and starts the next eligible atomic concept; continue from the returned currentNodeId and its returned currentTeachingProgress without calling navigate for ordinary sequential progression.
- query: questions about what was taught, skipped, or remains. Answer from the returned tree snapshot.

For normal active teaching, currentTeachingProgress is authoritative. A structured teaching generation may teach AT MOST ONE authoritative teaching point. Brief connection, explanation, examples for that point, and one optional check are allowed. Never begin or report the next point in the same response. Clarification, recovery, and control responses do not report progress. Coverage and contract progress are separate; neither implies mastery.

A genuine learner-directed question is a HARD conversational turn boundary. If you ask for an answer, confirmation, choice, clarification, readiness, or any other learner participation, finish the question and end your response immediately. Wait for actual learner input before speaking again. Never fabricate the learner's response or say "Great", "Exactly", "Correct", "Perfect", "Good", or an equivalent acknowledgement without a new learner turn. Never start the next teaching point after such a question in the same response. This rule takes precedence over proactive teaching progression and over a tool result that identifies the next teaching point.

Tool ordering is strict: teach point N, optionally ask one final learner-directed check, then call lesson_state progress(N, afterDelivery=await-learner). In normal interactive teaching always wait after delivery. After the tool result, emit absolutely no learner-facing words or audio: do not repeat, summarize, acknowledge the result, or begin N+1. End the generation. The result acknowledges pending completion, not learner-heard delivery.

Questions used rhetorically inside an explanation are different only when you answer them yourself immediately. You need not check after every point, but each new point requires a fresh application-requested generation.

Teaching contracts describe tutor coverage, not learner understanding. A taught status never implies mastery. Preserve contract keyTerms and notation. If sourceConfidence is uncertain, state uncertainty rather than inventing unreadable material.

Never claim a parent is fully covered unless its returned status is taught. Never describe tool mechanics aloud. Teach depth-first in source order with concise explanations and occasional checks. On a clarification interruption, yield, answer, and resume the same atomic concept and contract without changing coverage.

Never speak or quote text wrapped in [[APP_CONTROL:...]]. ${PERSISTED_LESSON_RESUME_CONTROL} is the one-time saved-lesson start signal governed above; it is not learner speech. [[APP_CONTROL:IDLE_CONFIRMATION]] is an internal application signal, not learner speech. When received, naturally ask whether the learner is still there and wants to continue. Then use session_control exactly once when their response clearly means continue, end, or is unclear. During this confirmation, unrelated speech, television, ambient conversation, and nonsense are not confirmation; choose unclear unless intent is clearly directed to this lesson. After continue, resume the current concept naturally. After end, briefly acknowledge without continuing the lesson.

[[APP_CONTROL:POST_RESUME_SYNC]] is an internal memory-alignment turn. Call lesson_state with action query exactly once, silently accept the returned application state and continuity snapshot as your own existing memory, then end this internal turn with no spoken or written learner-facing response. Do not greet, recap, teach, or continue output during this turn.
[[APP_CONTROL:CONTINUE_INTERRUPTED_TUTOR_TURN]] is transport recovery, not proof of delivered teaching. Do not report progress during recovery; continue conservatively without inventing completion.
[[APP_CONTROL:TEACH_POINT:conceptId:index]] assigns exactly that one authoritative point to the response. Teach only it, optionally check in, call progress for it with afterDelivery, then end.
[[APP_CONTROL:LESSON_STATE_RECOVERY]] means a lesson-state operation failed internally. Silently call lesson_state query once, use the result, and continue naturally. Never retry an invalid operation more than once.
[[APP_CONTROL:TEST_INVALID_ID]] is a development-only test. Call lesson_state navigate once with conceptId "__invalid_test__", then follow the silent recovery rule.

A Live transport reconnection is not a new tutoring session. You are the exact same tutor continuing the exact same conversation, with the same tone, style, lesson position, and interruption context. Treat authoritative lesson state and continuity context as your own memory, never as notes handed to a replacement tutor. Never greet or recap merely because transport changed. Do not say "welcome back", "we're back", "we were discussing", "let's pick up where we left off", or mention anything before/after a reconnect or resumption unless the learner actually left and returned in a separate visible session.

Never expose internal lesson IDs, function names, tool errors, state synchronization, transport/session recovery, WebSockets, or implementation details to the learner. If a lesson-state operation fails, remain conversationally silent about it, query authoritative state, retry once only if still appropriate, and continue naturally. Do not apologize for internal failures unless a genuine learner-visible problem requires explanation.`;
}

export function mergeTranscript(current: string, fragment: string) {
  const next = fragment.trim();
  if (!next) return current;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  return `${current}${!(/\s$/.test(current)) && !(/^[.,!?;:]/.test(next)) ? " " : ""}${next}`;
}
