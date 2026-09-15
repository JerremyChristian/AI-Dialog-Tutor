import type {
  AtomicTeachingContract,
  LessonTreeItem,
  TeachingImportance,
  TeachingNodeType,
  SourceReference,
} from "./learning-source";
import { createLegacyDeliveryUnits, normalizeDeliveryUnits } from "./teaching-delivery";

type Candidate = {
  originalId: string;
  title: string;
  parentId: string | null;
  order: number;
  sourceReferences?: SourceReference[];
  teaching?: AtomicTeachingContract;
};

export type LessonTreeNormalizationDiagnostics = {
  rawNodeCount: number;
  candidateNodeCount: number;
  malformedNodesRejected: number;
  missingTitle: number;
  contractsDropped: number;
  contractsRemovedFromStructuralNodes: number;
  invalidSourceRefsRemoved: number;
  invalidDeliveryUnitsFellBack: number;
  validDeliveryUnitCount: number;
  fallbackDeliveryUnitCount: number;
  missingParentsReparented: number;
  cyclesReparented: number;
  duplicateRawIds: number;
  invalidLeafCausedTreeRejection: number;
};

export function createLessonTreeNormalizationDiagnostics(): LessonTreeNormalizationDiagnostics {
  return {
    rawNodeCount: 0, candidateNodeCount: 0, malformedNodesRejected: 0, missingTitle: 0,
    contractsDropped: 0, contractsRemovedFromStructuralNodes: 0, invalidSourceRefsRemoved: 0,
    invalidDeliveryUnitsFellBack: 0, validDeliveryUnitCount: 0, fallbackDeliveryUnitCount: 0,
    missingParentsReparented: 0, cyclesReparented: 0, duplicateRawIds: 0,
    invalidLeafCausedTreeRejection: 0,
  };
}

const NODE_TYPES = new Set<TeachingNodeType>([
  "overview", "concept", "definition", "procedure", "worked-example",
  "comparison", "summary",
]);
const IMPORTANCE_LEVELS = new Set<TeachingImportance>([
  "core", "supporting", "optional",
]);

export function normalizeLessonTree(
  value: unknown,
  allowedSourceIds?: ReadonlySet<string>,
  diagnostics?: LessonTreeNormalizationDiagnostics,
): LessonTreeItem[] {
  if (!Array.isArray(value)) return [];
  if (diagnostics) diagnostics.rawNodeCount = value.length;
  const candidates = value.flatMap((item, index): Candidate[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      if (diagnostics) diagnostics.malformedNodesRejected += 1;
      return [];
    }
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) {
      if (diagnostics) {
        diagnostics.malformedNodesRejected += 1;
        diagnostics.missingTitle += 1;
      }
      return [];
    }
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
      sourceReferences: normalizeSourceReferences(record.sourceReferences, allowedSourceIds, diagnostics),
      teaching: normalizeTeachingContract(record.teaching, allowedSourceIds, diagnostics),
    }];
  });

  if (diagnostics) {
    diagnostics.candidateNodeCount = candidates.length;
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate.originalId)) diagnostics.duplicateRawIds += 1;
      seen.add(candidate.originalId);
    }
  }

  const byOriginalId = new Map(candidates.map((item) => [item.originalId, item]));
  const usedIds = new Set<string>();
  const normalizedIds = new Map<string, string>();

  function resolveId(candidate: Candidate, visiting = new Set<string>()): string {
    const cached = normalizedIds.get(candidate.originalId);
    if (cached) return cached;
    if (visiting.has(candidate.originalId)) {
      candidate.parentId = null;
      if (diagnostics) diagnostics.cyclesReparented += 1;
    }
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
  if (diagnostics) {
    diagnostics.missingParentsReparented = candidates.filter(
      (candidate) => candidate.parentId && !byOriginalId.has(candidate.parentId),
    ).length;
    diagnostics.contractsRemovedFromStructuralNodes = candidates.filter(
      (candidate) => parentOriginalIds.has(candidate.originalId) && Boolean(candidate.teaching),
    ).length;
  }
  if (candidates.some(
    (candidate) => !parentOriginalIds.has(candidate.originalId) && !candidate.teaching,
  )) {
    if (diagnostics) diagnostics.invalidLeafCausedTreeRejection = 1;
    return [];
  }

  return candidates.map((candidate) => {
    const parent = candidate.parentId ? byOriginalId.get(candidate.parentId) : undefined;
    return {
      id: resolveId(candidate),
      title: candidate.title,
      parentId: parent ? resolveId(parent) : null,
      order: candidate.order,
      sourceReferences: candidate.sourceReferences,
      teaching: parentOriginalIds.has(candidate.originalId)
        ? undefined
        : candidate.teaching,
    };
  });
}

function normalizeTeachingContract(
  value: unknown,
  allowedSourceIds?: ReadonlySet<string>,
  diagnostics?: LessonTreeNormalizationDiagnostics,
): AtomicTeachingContract | undefined {
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
  ) {
    if (diagnostics) diagnostics.contractsDropped += 1;
    return undefined;
  }

  const sourceConfidence = record.sourceConfidence === "uncertain"
    ? "uncertain"
    : record.sourceConfidence === "clear"
      ? "clear"
      : undefined;
  const uncertaintyNote = sourceConfidence === "uncertain"
    ? cleanString(record.uncertaintyNote, 300)
    : undefined;
  const contract: AtomicTeachingContract = {
    objective,
    teachingPoints,
    teachingPointSourceReferences: normalizeTeachingPointSourceReferences(
      record.teachingPointSourceReferences,
      teachingPoints.length,
      allowedSourceIds,
      diagnostics,
    ),
    completionCriteria,
    type,
    importance,
    sourceReferences: normalizeSourceReferences(record.sourceReferences, allowedSourceIds, diagnostics),
    keyTerms: optionalList(record.keyTerms, 12),
    notation: optionalList(record.notation, 12),
    sourceConfidence,
    uncertaintyNote,
  };
  const normalizedDeliveryUnits = normalizeDeliveryUnits(
    record.deliveryUnits,
    teachingPoints.length,
    completionCriteria.length,
  );
  if (normalizedDeliveryUnits) {
    contract.deliveryUnits = normalizedDeliveryUnits;
    if (diagnostics) diagnostics.validDeliveryUnitCount += normalizedDeliveryUnits.length;
  } else {
    contract.deliveryUnits = createLegacyDeliveryUnits(contract);
    if (diagnostics) {
      diagnostics.invalidDeliveryUnitsFellBack += 1;
      diagnostics.fallbackDeliveryUnitCount += contract.deliveryUnits.length;
    }
  }
  return contract;
}

function normalizeTeachingPointSourceReferences(
  value: unknown,
  teachingPointCount: number,
  allowedSourceIds?: ReadonlySet<string>,
  diagnostics?: LessonTreeNormalizationDiagnostics,
): SourceReference[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const references = Array.from({ length: Math.min(value.length, teachingPointCount) }, (_, index) =>
    normalizeSourceReferences(value[index], allowedSourceIds, diagnostics) ?? []
  );
  return references.some((items) => items.length) ? references : undefined;
}

function normalizeSourceReferences(
  value: unknown,
  allowedSourceIds?: ReadonlySet<string>,
  diagnostics?: LessonTreeNormalizationDiagnostics,
): SourceReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const references = value.flatMap((item): SourceReference[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      if (diagnostics) diagnostics.invalidSourceRefsRemoved += 1;
      return [];
    }
    const record = item as Record<string, unknown>;
    const sourceId = cleanString(record.sourceId, 64);
    if (!sourceId || (allowedSourceIds && !allowedSourceIds.has(sourceId))) {
      if (diagnostics) diagnostics.invalidSourceRefsRemoved += 1;
      return [];
    }
    const hasPage = Object.prototype.hasOwnProperty.call(record, "page");
    if (hasPage && (typeof record.page !== "number" || !Number.isInteger(record.page) || record.page < 1)) {
      if (diagnostics) diagnostics.invalidSourceRefsRemoved += 1;
      return [];
    }
    const page = hasPage ? record.page as number : undefined;
    const section = cleanString(record.section, 200) || undefined;
    return [{ sourceId, ...(page ? { page } : {}), ...(section ? { section } : {}) }];
  });
  const unique = references.filter((reference, index) => references.findIndex((candidate) =>
    candidate.sourceId === reference.sourceId && candidate.page === reference.page &&
    candidate.section === reference.section
  ) === index).slice(0, 8);
  if (diagnostics) diagnostics.invalidSourceRefsRemoved += references.length - unique.length;
  return unique.length ? unique : undefined;
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
