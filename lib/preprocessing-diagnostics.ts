import type { LessonTreeItem } from "./learning-source";
import type { LessonTreeNormalizationDiagnostics } from "./lesson-outline";

type StructureMetrics = {
  rootCount: number;
  nodeCount: number;
  leafCount: number;
  nodesWithChildren: number;
  maxDepth: number;
  depthDistribution: Record<number, number>;
  nodesWithTeachingContract: number;
  totalTeachingPoints: number;
  totalCompletionCriteria: number;
  nodesWithSourceReferences: number;
  nodesWithPointSourceReferences: number;
  deliveryUnitsPresent: number;
};

export function measureRawLessonTree(value: unknown): StructureMetrics {
  const rawNodeCount = Array.isArray(value) ? value.length : 0;
  const records = Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const ids = new Set(records.flatMap((record) => typeof record.id === "string" && record.id.trim() ? [record.id.trim()] : []));
  const childParentIds = records.flatMap((record) => typeof record.parentId === "string" && ids.has(record.parentId) ? [record.parentId] : []);
  const parents = new Set(childParentIds);
  const depthDistribution: Record<number, number> = {};
  let maxDepth = 0;
  for (const record of records) {
    const depth = rawDepth(record, records, new Set());
    maxDepth = Math.max(maxDepth, depth);
    depthDistribution[depth] = (depthDistribution[depth] ?? 0) + 1;
  }
  return { ...aggregate(records, parents, depthDistribution, maxDepth), nodeCount: rawNodeCount };
}

export function measureNormalizedLessonTree(tree: LessonTreeItem[]) {
  const parents = new Set(tree.flatMap((node) => node.parentId ? [node.parentId] : []));
  const byId = new Map(tree.map((node) => [node.id, node]));
  const depthDistribution: Record<number, number> = {};
  let maxDepth = 0;
  for (const node of tree) {
    let depth = 0;
    let parentId = node.parentId;
    const seen = new Set<string>();
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId); depth += 1; parentId = byId.get(parentId)?.parentId ?? null;
    }
    maxDepth = Math.max(maxDepth, depth);
    depthDistribution[depth] = (depthDistribution[depth] ?? 0) + 1;
  }
  const metrics = aggregate(tree as unknown as Record<string, unknown>[], parents, depthDistribution, maxDepth);
  const canonicalTeachableNodeCount = tree.filter((node) => !parents.has(node.id) && Boolean(node.teaching)).length;
  return {
    ...metrics,
    canonicalTeachableNodeCount,
    structuralNodeCount: tree.filter((node) => parents.has(node.id)).length,
    canonicalIneligibility: {
      hasChildrenOnly: tree.filter((node) => parents.has(node.id)).length,
      noTeachingContract: tree.filter((node) => !parents.has(node.id) && !node.teaching).length,
      emptyTeachingPoints: tree.filter((node) => !parents.has(node.id) && node.teaching?.teachingPoints.length === 0).length,
      invalidContract: 0,
    },
    suspiciouslyShallow: tree.length <= 3 && canonicalTeachableNodeCount <= 1 && maxDepth <= 1,
  };
}

export function formatDepthDistribution(distribution: Record<number, number>) {
  return Object.entries(distribution).map(([depth, count]) => `depth${depth}=${count}`).join(", ") || "none";
}

export function formatNormalizationLoss(rawNodeCount: number, normalizedNodeCount: number, d: LessonTreeNormalizationDiagnostics) {
  return `rawNodes=${rawNodeCount}, normalizedNodes=${normalizedNodeCount}, nodesDropped=${Math.max(0, rawNodeCount - normalizedNodeCount)}, ` +
    `contractsDropped=${d.contractsDropped + d.contractsRemovedFromStructuralNodes}, invalidSourceRefsRemoved=${d.invalidSourceRefsRemoved}, ` +
    `invalidDeliveryUnitsFellBack=${d.invalidDeliveryUnitsFellBack}, malformedNodesRejected=${d.malformedNodesRejected}, ` +
    `reasons={missingTitle:${d.missingTitle},missingParent:${d.missingParentsReparented},cycle:${d.cyclesReparented},` +
    `duplicateId:${d.duplicateRawIds},structuralContractRemoved:${d.contractsRemovedFromStructuralNodes},invalidLeafTreeRejection:${d.invalidLeafCausedTreeRejection}}`;
}

function aggregate(records: Record<string, unknown>[], parents: Set<string>, depthDistribution: Record<number, number>, maxDepth: number): StructureMetrics {
  let nodesWithTeachingContract = 0, totalTeachingPoints = 0, totalCompletionCriteria = 0;
  let nodesWithSourceReferences = 0, nodesWithPointSourceReferences = 0, deliveryUnitsPresent = 0;
  for (const record of records) {
    const teaching = record.teaching && typeof record.teaching === "object" && !Array.isArray(record.teaching)
      ? record.teaching as Record<string, unknown> : undefined;
    if (teaching) nodesWithTeachingContract += 1;
    totalTeachingPoints += Array.isArray(teaching?.teachingPoints) ? teaching.teachingPoints.length : 0;
    totalCompletionCriteria += Array.isArray(teaching?.completionCriteria) ? teaching.completionCriteria.length : 0;
    if ((Array.isArray(record.sourceReferences) && record.sourceReferences.length) ||
        (Array.isArray(teaching?.sourceReferences) && teaching.sourceReferences.length)) nodesWithSourceReferences += 1;
    if (Array.isArray(teaching?.teachingPointSourceReferences) && teaching.teachingPointSourceReferences.some((refs) => Array.isArray(refs) && refs.length)) nodesWithPointSourceReferences += 1;
    deliveryUnitsPresent += Array.isArray(teaching?.deliveryUnits) ? teaching.deliveryUnits.length : 0;
  }
  return { rootCount: records.filter((record) => typeof record.parentId !== "string" || !parents.has(record.parentId)).length,
    nodeCount: records.length, leafCount: records.filter((record) => typeof record.id !== "string" || !parents.has(record.id)).length,
    nodesWithChildren: records.filter((record) => typeof record.id === "string" && parents.has(record.id)).length,
    maxDepth, depthDistribution, nodesWithTeachingContract, totalTeachingPoints, totalCompletionCriteria,
    nodesWithSourceReferences, nodesWithPointSourceReferences, deliveryUnitsPresent };
}

function rawDepth(record: Record<string, unknown>, records: Record<string, unknown>[], seen: Set<string>): number {
  if (typeof record.parentId !== "string") return 0;
  if (seen.has(record.parentId)) return 0;
  const parent = records.find((candidate) => candidate.id === record.parentId);
  if (!parent) return 0;
  seen.add(record.parentId);
  return 1 + rawDepth(parent, records, seen);
}
