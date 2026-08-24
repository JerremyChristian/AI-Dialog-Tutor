import type {
  AtomicTeachingContract,
  LessonTreeItem,
  TeachingImportance,
  TeachingNodeType,
} from "./learning-source";

type Candidate = {
  originalId: string;
  title: string;
  parentId: string | null;
  order: number;
  sourceReference?: string;
  teaching?: AtomicTeachingContract;
};

const NODE_TYPES = new Set<TeachingNodeType>([
  "overview", "concept", "definition", "procedure", "worked-example",
  "comparison", "summary",
]);
const IMPORTANCE_LEVELS = new Set<TeachingImportance>([
  "core", "supporting", "optional",
]);

export function normalizeLessonTree(value: unknown): LessonTreeItem[] {
  if (!Array.isArray(value)) return [];
  const candidates = value.flatMap((item, index): Candidate[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) return [];
    return [{
      originalId:
        typeof record.id === "string" && record.id.trim()
          ? record.id.trim()
          : `node-${index + 1}`,
      title,
      parentId:
        typeof record.parentId === "string" && record.parentId.trim()
          ? record.parentId.trim()
          : null,
      order:
        typeof record.order === "number" && Number.isFinite(record.order)
          ? record.order
          : index + 1,
      sourceReference:
        typeof record.sourceReference === "string" && record.sourceReference.trim()
          ? record.sourceReference.trim()
          : undefined,
      teaching: normalizeTeachingContract(record.teaching),
    }];
  });

  const byOriginalId = new Map(candidates.map((item) => [item.originalId, item]));
  const usedIds = new Set<string>();
  const normalizedIds = new Map<string, string>();

  function resolveId(candidate: Candidate, visiting = new Set<string>()): string {
    const cached = normalizedIds.get(candidate.originalId);
    if (cached) return cached;
    if (visiting.has(candidate.originalId)) candidate.parentId = null;
    visiting.add(candidate.originalId);
    const parent = candidate.parentId ? byOriginalId.get(candidate.parentId) : undefined;
    const parentId = parent ? resolveId(parent, visiting) : null;
    const segment = slugify(candidate.title) || "concept";
    const baseId = parentId ? `${parentId}.${segment}` : segment;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    usedIds.add(id);
    normalizedIds.set(candidate.originalId, id);
    return id;
  }

  const parentOriginalIds = new Set(
    candidates.flatMap((candidate) => candidate.parentId ? [candidate.parentId] : []),
  );
  if (candidates.some(
    (candidate) => !parentOriginalIds.has(candidate.originalId) && !candidate.teaching,
  )) return [];

  return candidates.map((candidate) => {
    const parent = candidate.parentId ? byOriginalId.get(candidate.parentId) : undefined;
    return {
      id: resolveId(candidate),
      title: candidate.title,
      parentId: parent ? resolveId(parent) : null,
      order: candidate.order,
      sourceReference: candidate.sourceReference,
      teaching: parentOriginalIds.has(candidate.originalId)
        ? undefined
        : candidate.teaching,
    };
  });
}

function normalizeTeachingContract(value: unknown): AtomicTeachingContract | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const objective = cleanString(record.objective, 300);
  const type = cleanString(record.type, 40) as TeachingNodeType;
  const importance = cleanString(record.importance, 40) as TeachingImportance;
  const teachingPoints = cleanStringList(record.teachingPoints, 7);
  const completionCriteria = cleanStringList(record.completionCriteria, 5);
  if (
    !objective || !NODE_TYPES.has(type) || !IMPORTANCE_LEVELS.has(importance) ||
    teachingPoints.length === 0 || completionCriteria.length === 0
  ) return undefined;

  const sourceConfidence = record.sourceConfidence === "uncertain"
    ? "uncertain"
    : record.sourceConfidence === "clear"
      ? "clear"
      : undefined;
  const uncertaintyNote = sourceConfidence === "uncertain"
    ? cleanString(record.uncertaintyNote, 300)
    : undefined;
  return {
    objective,
    teachingPoints,
    completionCriteria,
    type,
    importance,
    sourceReferences: optionalList(record.sourceReferences, 6),
    keyTerms: optionalList(record.keyTerms, 12),
    notation: optionalList(record.notation, 12),
    sourceConfidence,
    uncertaintyNote,
  };
}

function optionalList(value: unknown, limit: number) {
  const items = cleanStringList(value, limit);
  return items.length ? items : undefined;
}

function cleanStringList(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const cleaned = cleanString(item, 300);
    return cleaned ? [cleaned] : [];
  }).slice(0, limit);
}

function cleanString(value: unknown, limit: number) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
