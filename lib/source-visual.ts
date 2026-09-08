import type { AtomicTeachingContract, LessonSource, SourceReference } from "./learning-source";
import { deriveBeatSourceReferences } from "./teaching-delivery";

export type VisualReferenceCandidate = {
  source: LessonSource;
  reference: SourceReference;
  reason: "slides-point-reference" | "notes-point-reference" | "pdf-point-reference" |
    "pdf-point-document-reference" | "slides-contract-reference" |
    "notes-contract-reference" | "pdf-contract-reference" | "pdf-document-reference";
};

export type VisualReferenceSelection = {
  candidates: VisualReferenceCandidate[];
  primary: VisualReferenceCandidate | null;
  fallbackUsed: boolean;
};

export function selectVisualReferences(
  contract: AtomicTeachingContract | undefined,
  sources: LessonSource[],
  teachingPointIndex?: number,
): VisualReferenceSelection {
  const pointReferences = teachingPointIndex === undefined
    ? []
    : contract?.teachingPointSourceReferences?.[teachingPointIndex] ?? [];
  const pointCandidates = visualCandidates(pointReferences, sources, "point");
  const fallbackUsed = pointCandidates.length === 0;
  const candidates = fallbackUsed
    ? visualCandidates(contract?.sourceReferences ?? [], sources, "contract")
    : pointCandidates;
  return { candidates, primary: candidates[0] ?? null, fallbackUsed };
}

export function selectBeatVisualReferences(
  contract: AtomicTeachingContract | undefined,
  sources: LessonSource[],
  teachingPointIndexes: number[],
): VisualReferenceSelection {
  const pointCandidates = visualCandidates(
    contract ? deriveBeatSourceReferences(contract, teachingPointIndexes) : [],
    sources,
    "point",
  );
  const fallbackUsed = pointCandidates.length === 0;
  const candidates = fallbackUsed
    ? visualCandidates(contract?.sourceReferences ?? [], sources, "contract")
    : pointCandidates;
  return { candidates, primary: candidates[0] ?? null, fallbackUsed };
}

export function selectPrimaryVisualReference(
  contract: AtomicTeachingContract | undefined,
  sources: LessonSource[],
  teachingPointIndex?: number,
): VisualReferenceCandidate | null {
  return selectVisualReferences(contract, sources, teachingPointIndex).primary;
}

function visualCandidates(
  references: SourceReference[],
  sources: LessonSource[],
  level: "point" | "contract",
) {
  const candidates = references.flatMap((reference, order) => {
    const source = sources.find((candidate) => candidate.id === reference.sourceId);
    return source?.mimeType === "application/pdf" ? [{ source, reference, order }] : [];
  }).filter((candidate, index, all) => all.findIndex((other) =>
    other.source.id === candidate.source.id && other.reference.page === candidate.reference.page &&
    other.reference.section === candidate.reference.section
  ) === index);
  return candidates.sort((left, right) => priority(left) - priority(right) || left.order - right.order)
    .map(({ source, reference }): VisualReferenceCandidate => ({
      source,
      reference,
      reason: reasonFor(source, reference, level),
    }));
}

function priority({ source, reference }: { source: LessonSource; reference: SourceReference }) {
  return (reference.page === undefined ? 10 : 0) +
    (source.role === "slides" ? 0 : source.role === "notes" ? 1 : 2);
}

function reasonFor(
  source: LessonSource,
  reference: SourceReference,
  level: "point" | "contract",
): VisualReferenceCandidate["reason"] {
  if (reference.page === undefined) return level === "point"
    ? "pdf-point-document-reference"
    : "pdf-document-reference";
  if (source.role === "slides") return level === "point" ? "slides-point-reference" : "slides-contract-reference";
  if (source.role === "notes") return level === "point" ? "notes-point-reference" : "notes-contract-reference";
  return level === "point" ? "pdf-point-reference" : "pdf-contract-reference";
}
