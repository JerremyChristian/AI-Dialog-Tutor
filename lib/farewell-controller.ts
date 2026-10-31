// Pure closing-farewell decisions. The page owns the farewell ref, the player
// batch, the transport, the completion timer and stopConversation, and applies
// these predicates in its existing order. A farewell belongs to exactly one
// conversation run and generation epoch; any event from another run or epoch
// (a cancelled, interrupted or superseded farewell) is ignored.

export type FarewellTurn = {
  conversationRun: number;
  generationEpoch: number;
  generationComplete: boolean;
  audioReceived: boolean;
  audioNaturallyDrained: boolean;
  completionStarted: boolean;
};

export function createFarewellTurn(conversationRun: number, generationEpoch: number): FarewellTurn {
  return {
    conversationRun,
    generationEpoch,
    generationComplete: false,
    audioReceived: false,
    audioNaturallyDrained: false,
    completionStarted: false,
  };
}

// True while the farewell still owns the current run and epoch. Used to
// suppress learner interruption, attribute audio chunks, and accept
// generation-complete for the farewell.
export function isCurrentFarewell(
  farewell: FarewellTurn | null,
  conversationRun: number,
  generationEpoch: number,
): farewell is FarewellTurn {
  return farewell !== null && farewell.conversationRun === conversationRun &&
    farewell.generationEpoch === generationEpoch;
}

// The player's natural-drain callback reports the epoch of the batch that
// drained; it counts only if that batch is the farewell's and still current.
export function isFarewellDrainCurrent(
  farewell: FarewellTurn | null,
  conversationRun: number,
  drainedEpoch: number,
  currentGenerationEpoch: number,
): farewell is FarewellTurn {
  return isCurrentFarewell(farewell, conversationRun, drainedEpoch) &&
    drainedEpoch === currentGenerationEpoch;
}

// Completion requires provider generation complete and, when any farewell
// audio arrived, its natural drain. Zero-audio farewells finish on generation
// complete alone. Completion starts at most once.
export function isFarewellReadyToFinish(
  farewell: FarewellTurn | null,
  conversationRun: number,
  generationEpoch: number,
): farewell is FarewellTurn {
  return isCurrentFarewell(farewell, conversationRun, generationEpoch) &&
    !farewell.completionStarted &&
    farewell.generationComplete &&
    (!farewell.audioReceived || farewell.audioNaturallyDrained);
}

export function farewellCompletionDiagnostic(farewell: Pick<FarewellTurn, "audioReceived">) {
  return farewell.audioReceived
    ? "FAREWELL_FLOW audio-drained"
    : "FAREWELL_FLOW zero-audio";
}
