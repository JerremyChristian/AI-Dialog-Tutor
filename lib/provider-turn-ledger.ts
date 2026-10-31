// Provider turn ownership for tutor audio. Live audio carries no generation
// identity, so ownership is kept as sequences: every audible generation root
// takes the next request id, and provider boundaries close requests strictly
// oldest first. The provider answers requests in order; a normal turn ends
// generationComplete > turnComplete, an interrupted one interrupted >
// turnComplete. A boundary therefore can never close a newer request, which a
// single open/closed flag could not express once requests overlap.
//
// Requests 1..requested exist. Those up to generationsClosed produce no more
// output; those up to turnsClosed are fully over (turnsClosed <= generationsClosed).
export class ProviderTurnLedger {
  private requested = 0;
  private generationsClosed = 0;
  private turnsClosed = 0;
  // Closed while an interrupted request is still open: every audio chunk is
  // that request's until its turn closes.
  private audioGate: { through: number; rejectedChunks: number } | null = null;

  request() {
    this.requested += 1;
  }

  // The newest request whose generation is still open, or null when only local
  // playback (if anything) remains.
  outstandingThrough() {
    return this.requested > this.generationsClosed ? this.requested : null;
  }

  // Output with no open generation came from a root that was not marked, so it
  // opens one; otherwise it belongs to the oldest open generation.
  noteOutput() {
    if (this.outstandingThrough() === null) this.requested += 1;
  }

  generationComplete() {
    if (this.outstandingThrough() !== null) this.generationsClosed += 1;
  }

  // Closes every request whose generation already completed (its trailing
  // turnComplete may be this one) plus the oldest open request. Returns the
  // rejected chunk count when this boundary reopens audio.
  turnComplete(): number | null {
    this.turnsClosed = Math.min(this.generationsClosed + 1, this.requested);
    this.generationsClosed = Math.max(this.generationsClosed, this.turnsClosed);
    const gate = this.audioGate;
    if (!gate || this.turnsClosed < gate.through) return null;
    this.audioGate = null;
    return gate.rejectedChunks;
  }

  closeAudioThrough(through: number) {
    if (this.audioGate) this.audioGate.through = Math.max(this.audioGate.through, through);
    else this.audioGate = { through, rejectedChunks: 0 };
  }

  admitAudio() {
    if (!this.audioGate) return true;
    this.audioGate.rejectedChunks += 1;
    return false;
  }

  // The socket that owed these boundaries is gone (handoff, recovery, reset).
  retireAll() {
    this.generationsClosed = this.requested;
    this.turnsClosed = this.requested;
    this.audioGate = null;
  }
}
