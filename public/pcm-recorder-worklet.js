class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions;
    this.inputSampleRate = config.inputSampleRate;
    this.targetSampleRate = config.targetSampleRate;
    this.chunkSamples = config.chunkSamples;
    this.inputBuffer = [];
    this.outputBuffer = [];
    this.resamplePosition = 0;
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0];
    const output = outputs[0]?.[0];

    if (output) {
      output.fill(0);
    }

    if (!inputChannels?.[0]?.length) {
      return true;
    }

    for (let index = 0; index < inputChannels[0].length; index += 1) {
      let monoSample = 0;
      for (const channel of inputChannels) {
        monoSample += channel[index];
      }
      this.inputBuffer.push(monoSample / inputChannels.length);
    }

    const step = this.inputSampleRate / this.targetSampleRate;
    while (this.resamplePosition + 1 < this.inputBuffer.length) {
      const leftIndex = Math.floor(this.resamplePosition);
      const fraction = this.resamplePosition - leftIndex;
      const left = this.inputBuffer[leftIndex];
      const right = this.inputBuffer[leftIndex + 1];
      const sample = left + (right - left) * fraction;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.outputBuffer.push(
        clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767),
      );
      this.resamplePosition += step;

      if (this.outputBuffer.length === this.chunkSamples) {
        const pcm = Int16Array.from(this.outputBuffer);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.outputBuffer = [];
      }
    }

    const consumedSamples = Math.floor(this.resamplePosition);
    if (consumedSamples > 0) {
      this.inputBuffer = this.inputBuffer.slice(consumedSamples);
      this.resamplePosition -= consumedSamples;
    }

    return true;
  }
}

registerProcessor("pcm-recorder", PcmRecorderProcessor);
