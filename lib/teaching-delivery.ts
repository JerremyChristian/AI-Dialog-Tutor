import type {
  AtomicTeachingContract,
  SourceReference,
  TeachingDeliveryUnit,
} from "./learning-source";

export type ResolvedTeachingBeat = {
  deliveryUnitIndex: number;
  beatIndex: number;
  teachingPointIndexes: number[];
  isFirstBeatInUnit: boolean;
  isFinalBeatInUnit: boolean;
  unit: TeachingDeliveryUnit;
};

export type BeatCommitContext = {
  expectedConceptId: string;
  currentConceptId: string | null;
  expectedEpoch: number;
  currentEpoch: number | null;
  expectedStartIndex: number;
  currentNextTeachingPointIndex: number;
  generationComplete: boolean;
  audioNaturallyDrained: boolean;
  cancelled: boolean;
  lessonActive: boolean;
};

export function normalizeDeliveryUnits(
  value: unknown,
  teachingPointCount: number,
  completionCriteriaCount: number,
): TeachingDeliveryUnit[] | undefined {
  if (!Array.isArray(value) || teachingPointCount < 1) return undefined;
  const units: TeachingDeliveryUnit[] = [];
  let expectedPoint = 0;
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const objective = typeof item.objective === "string" ? item.objective.trim().slice(0, 300) : "";
    const points = integerArray(item.teachingPointIndexes);
    const criteria = integerArray(item.completionCriteriaIndexes);
    if (!objective || !points?.length || !criteria ||
        criteria.some((index) => index < 0 || index >= completionCriteriaCount) ||
        new Set(criteria).size !== criteria.length ||
        !isRange(points, expectedPoint)) return undefined;
    const rawBeats = item.presentationBeats;
    if (!Array.isArray(rawBeats) || !rawBeats.length) return undefined;
    const presentationBeats = [];
    let expectedBeatPoint = points[0];
    for (const rawBeat of rawBeats) {
      if (!isRecord(rawBeat)) return undefined;
      const beatPoints = integerArray(rawBeat.teachingPointIndexes);
      if (!beatPoints?.length || !isRange(beatPoints, expectedBeatPoint) ||
          beatPoints.some((index) => !points.includes(index))) return undefined;
      presentationBeats.push({ teachingPointIndexes: beatPoints });
      expectedBeatPoint = beatPoints.at(-1)! + 1;
    }
    if (expectedBeatPoint !== points.at(-1)! + 1) return undefined;
    units.push({ objective, teachingPointIndexes: points, completionCriteriaIndexes: criteria,
      presentationBeats });
    expectedPoint = points.at(-1)! + 1;
  }
  return expectedPoint === teachingPointCount ? units : undefined;
}

/** Legacy rule: contiguous units of at most three points; adjacent points share a
 * beat unless their non-empty point-reference signatures differ. Beats are also
 * capped at three points. Criteria are associated by ordinal when available. */
export function createLegacyDeliveryUnits(
  contract: Pick<AtomicTeachingContract, "objective" | "teachingPoints" |
    "completionCriteria" | "teachingPointSourceReferences">,
): TeachingDeliveryUnit[] {
  const units: TeachingDeliveryUnit[] = [];
  for (let start = 0; start < contract.teachingPoints.length; start += 3) {
    const points = range(start, Math.min(start + 3, contract.teachingPoints.length));
    const presentationBeats: TeachingDeliveryUnit["presentationBeats"] = [];
    for (const point of points) {
      const previous = presentationBeats.at(-1);
      const previousPoint = previous?.teachingPointIndexes.at(-1);
      const changed = previousPoint !== undefined && distinctReferenceContext(
        contract.teachingPointSourceReferences?.[previousPoint] ?? [],
        contract.teachingPointSourceReferences?.[point] ?? [],
      );
      if (!previous || changed || previous.teachingPointIndexes.length >= 3) {
        presentationBeats.push({ teachingPointIndexes: [point] });
      } else previous.teachingPointIndexes.push(point);
    }
    const unitIndex = units.length;
    units.push({
      objective: unitIndex === 0 ? contract.objective : `Continue ${contract.objective}`,
      teachingPointIndexes: points,
      completionCriteriaIndexes: unitIndex < contract.completionCriteria.length ? [unitIndex] : [],
      presentationBeats,
    });
  }
  return units;
}

export function getDeliveryUnits(contract: AtomicTeachingContract) {
  return contract.deliveryUnits ?? createLegacyDeliveryUnits(contract);
}

export function resolveNextPresentationBeat(
  contract: AtomicTeachingContract,
  nextTeachingPointIndex: number,
): ResolvedTeachingBeat | null {
  if (nextTeachingPointIndex >= contract.teachingPoints.length) return null;
  const units = getDeliveryUnits(contract);
  for (let deliveryUnitIndex = 0; deliveryUnitIndex < units.length; deliveryUnitIndex += 1) {
    const unit = units[deliveryUnitIndex];
    for (let beatIndex = 0; beatIndex < unit.presentationBeats.length; beatIndex += 1) {
      const beat = unit.presentationBeats[beatIndex];
      if (beat.teachingPointIndexes[0] === nextTeachingPointIndex) return {
        deliveryUnitIndex, beatIndex, teachingPointIndexes: [...beat.teachingPointIndexes], unit,
        isFirstBeatInUnit: beatIndex === 0,
        isFinalBeatInUnit: beatIndex === unit.presentationBeats.length - 1,
      };
    }
  }
  return null;
}

export function deriveBeatSourceReferences(
  contract: AtomicTeachingContract,
  teachingPointIndexes: number[],
): SourceReference[] {
  return teachingPointIndexes.flatMap((index) => contract.teachingPointSourceReferences?.[index] ?? [])
    .filter((reference, index, all) => all.findIndex((candidate) =>
      candidate.sourceId === reference.sourceId && candidate.page === reference.page &&
      candidate.section === reference.section) === index);
}

export function computeNextTeachingPointIndexAfterBeat(teachingPointIndexes: number[]) {
  return teachingPointIndexes.length ? teachingPointIndexes.at(-1)! + 1 : 0;
}

export function isBeatCommitValid(context: BeatCommitContext) {
  return context.lessonActive && !context.cancelled && context.generationComplete &&
    context.audioNaturallyDrained && context.expectedConceptId === context.currentConceptId &&
    context.expectedEpoch === context.currentEpoch &&
    context.expectedStartIndex === context.currentNextTeachingPointIndex;
}

function integerArray(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.every(Number.isInteger)) return null;
  return value as number[];
}

function isRange(values: number[], expectedStart: number) {
  return values.every((value, index) => value === expectedStart + index);
}

function range(start: number, end: number) {
  return Array.from({ length: end - start }, (_, index) => start + index);
}

function distinctReferenceContext(left: SourceReference[], right: SourceReference[]) {
  if (!left.length || !right.length) return false;
  return signature(left) !== signature(right);
}

function signature(references: SourceReference[]) {
  return references.map((reference) => `${reference.sourceId}:${reference.page ?? "document"}`)
    .sort().join("|");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
