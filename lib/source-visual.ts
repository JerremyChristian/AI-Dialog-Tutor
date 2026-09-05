import type { AtomicTeachingContract, LessonSource, SourceReference } from "./learning-source";

export type PrimaryVisualReference = {
  source: LessonSource;
  reference: SourceReference;
  reason: "slides-contract-reference" | "notes-contract-reference" | "pdf-contract-reference" | "pdf-document-reference";
};

export function selectPrimaryVisualReference(
  contract: AtomicTeachingContract | undefined,
  sources: LessonSource[],
): PrimaryVisualReference | null {
  const candidates = (contract?.sourceReferences ?? []).flatMap((reference) => {
    const source = sources.find((candidate) => candidate.id === reference.sourceId);
    return source?.mimeType === "application/pdf" ? [{ source, reference }] : [];
  });
  const withPage = candidates.filter(({ reference }) =>
    typeof reference.page === "number" && Number.isInteger(reference.page) && reference.page >= 1
  );
  const slides = withPage.find(({ source }) => source.role === "slides");
  if (slides) return { ...slides, reason: "slides-contract-reference" };
  const notes = withPage.find(({ source }) => source.role === "notes");
  if (notes) return { ...notes, reason: "notes-contract-reference" };
  if (withPage[0]) return { ...withPage[0], reason: "pdf-contract-reference" };
  const documentReference = candidates.find(({ reference }) => reference.page === undefined);
  return documentReference ? { ...documentReference, reason: "pdf-document-reference" } : null;
}
