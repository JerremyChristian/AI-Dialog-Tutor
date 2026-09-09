type TranscriptToken = {
  normalized: string;
  end: number;
};

function transcriptTokens(value: string): TranscriptToken[] {
  return Array.from(value.matchAll(/[\p{L}\p{N}]+/gu), (match) => ({
    normalized: match[0].toLocaleLowerCase(),
    end: (match.index ?? 0) + match[0].length,
  }));
}

/** Merge mixed cumulative hypotheses and incremental ASR chunks within one voice turn. */
export function mergeLearnerTranscript(current: string, update: string) {
  const next = update.trim();
  if (!next) return current;
  if (!current) return next;

  const currentTokens = transcriptTokens(current);
  const nextTokens = transcriptTokens(next);
  if (!currentTokens.length || !nextTokens.length) return next;

  const currentWords = currentTokens.map((token) => token.normalized);
  const nextWords = nextTokens.map((token) => token.normalized);
  const sharedPrefixLength = Math.min(currentWords.length, nextWords.length);
  const sameBeginning = currentWords
    .slice(0, sharedPrefixLength)
    .every((word, index) => word === nextWords[index]);

  if (sameBeginning) {
    return nextWords.length >= currentWords.length ? next : current;
  }

  if (currentWords.length >= nextWords.length) {
    const repeatedAt = currentWords.findIndex((_, index) =>
      nextWords.every((word, offset) => currentWords[index + offset] === word),
    );
    if (repeatedAt >= 0) return current;
  }

  const maximumOverlap = Math.min(currentWords.length, nextWords.length);
  for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
    const currentSuffix = currentWords.slice(-overlap);
    if (!currentSuffix.every((word, index) => word === nextWords[index])) continue;
    const remainder = next.slice(nextTokens[overlap - 1].end).trimStart();
    if (!remainder) return current;
    return `${current}${/\s$/.test(current) || /^[.,!?;:]/.test(remainder) ? "" : " "}${remainder}`;
  }

  return `${current}${/\s$/.test(current) || /^[.,!?;:]/.test(next) ? "" : " "}${next}`;
}
