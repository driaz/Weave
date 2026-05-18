/**
 * VAD worklet processor for Weave Voice v2.
 *
 * Lives in /public so Vite serves it as a static asset (AudioWorklet
 * modules must be fetched, not bundled). Pairs with vadController.ts in
 * src/services/voice/.
 *
 * Protocol — keep this in sync with the controller:
 *   Outbound:
 *     { type: 'ready', sampleRate }
 *     { type: 'speech_started', timestamp, rms }
 *     { type: 'silence_started', timestamp, rms }
 *     { type: 'audio_chunk', samples (transferable Float32Array),
 *         isPreRoll, sequence }
 *     { type: 'error', message, fatal }
 *   Inbound:
 *     { type: 'configure', rmsThreshold, minSpeechDurationMs,
 *         minSilenceDurationMs, preRollMs }
 *     { type: 'start' }
 *     { type: 'stop' }
 *
 * Gating model:
 *   - isArmed   — set true by 'start', false by 'stop'. While false, the
 *                 ring buffer fills and EMA updates but no events fire.
 *   - isSpeaking — true between the speech_started edge and the next
 *                  silence_started edge. Debounced symmetrically by
 *                  minSpeechDurationMs on the rising edge and
 *                  minSilenceDurationMs on the falling edge.
 *   - isStreaming — true from speech_started through the next 'stop'.
 *                   Drives per-quantum accumulation into speakingBuffer
 *                   so we keep capturing audio across brief silence dips
 *                   without re-arming.
 */

const RING_BUFFER_SIZE = 16384;
const SPEAKING_BUFFER_SIZE = 2400;
const EMA_TIME_CONSTANT_MS = 20;
const QUANTUM_SIZE = 128;
const PROCESSOR_NAME = 'vad-processor';

class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.ringBuffer = new Float32Array(RING_BUFFER_SIZE);
    this.writePos = 0;

    const quantumDurationMs = (QUANTUM_SIZE / sampleRate) * 1000;
    this.emaAlpha = 1 - Math.exp(-quantumDurationMs / EMA_TIME_CONSTANT_MS);
    this.rmsEma = 0;

    this.configured = false;
    this.linearThreshold = 0;
    this.minSpeechSamples = 0;
    this.minSilenceSamples = 0;

    this.isArmed = false;
    this.isSpeaking = false;
    this.isStreaming = false;
    this.aboveThresholdSampleCount = 0;
    this.belowThresholdSampleCount = 0;

    this.speakingBuffer = new Float32Array(SPEAKING_BUFFER_SIZE);
    this.speakingBufferPos = 0;
    this.speakingSequence = 0;

    this.port.onmessage = (event) => this.handleMessage(event.data);

    this.port.postMessage({ type: 'ready', sampleRate });
  }

  handleMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'configure': {
        if (
          typeof msg.rmsThreshold !== 'number' ||
          typeof msg.minSpeechDurationMs !== 'number' ||
          typeof msg.minSilenceDurationMs !== 'number'
        ) {
          this.port.postMessage({
            type: 'error',
            message: 'configure message missing required numeric fields',
            fatal: true,
          });
          return;
        }
        this.linearThreshold = msg.rmsThreshold;
        this.minSpeechSamples = Math.max(
          1,
          Math.ceil((msg.minSpeechDurationMs / 1000) * sampleRate),
        );
        this.minSilenceSamples = Math.max(
          1,
          Math.ceil((msg.minSilenceDurationMs / 1000) * sampleRate),
        );
        this.configured = true;
        break;
      }
      case 'start': {
        if (!this.configured) {
          this.port.postMessage({
            type: 'error',
            message: 'start received before configure',
            fatal: true,
          });
          return;
        }
        this.isArmed = true;
        this.isSpeaking = false;
        this.isStreaming = false;
        this.aboveThresholdSampleCount = 0;
        this.belowThresholdSampleCount = 0;
        this.speakingBufferPos = 0;
        this.speakingSequence = 0;
        break;
      }
      case 'stop': {
        this.isArmed = false;
        this.isSpeaking = false;
        this.isStreaming = false;
        this.aboveThresholdSampleCount = 0;
        this.belowThresholdSampleCount = 0;
        this.speakingBufferPos = 0;
        break;
      }
      default:
        break;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    const len = channel.length;
    const size = RING_BUFFER_SIZE;

    // Always copy into ring buffer + maintain EMA, even when not armed —
    // so the pre-roll is meaningful the instant speech is detected.
    for (let i = 0; i < len; i++) {
      this.ringBuffer[(this.writePos + i) % size] = channel[i];
    }
    this.writePos += len;

    let sumSq = 0;
    for (let i = 0; i < len; i++) sumSq += channel[i] * channel[i];
    const quantumRms = Math.sqrt(sumSq / len);
    this.rmsEma =
      this.emaAlpha * quantumRms + (1 - this.emaAlpha) * this.rmsEma;

    if (!this.configured || !this.isArmed) return true;

    if (this.rmsEma > this.linearThreshold) {
      this.belowThresholdSampleCount = 0;
      if (!this.isSpeaking) {
        this.aboveThresholdSampleCount += len;
        if (this.aboveThresholdSampleCount >= this.minSpeechSamples) {
          this.isSpeaking = true;
          this.isStreaming = true;
          this.speakingBufferPos = 0;

          this.port.postMessage({
            type: 'speech_started',
            timestamp: currentTime * 1000,
            rms: this.rmsEma,
          });

          // Linearize the ring buffer (oldest sample is at writePos % size).
          const preroll = new Float32Array(size);
          const start = this.writePos % size;
          let idx = 0;
          for (let i = start; i < size; i++) preroll[idx++] = this.ringBuffer[i];
          for (let i = 0; i < start; i++) preroll[idx++] = this.ringBuffer[i];
          const seq = this.speakingSequence++;
          this.port.postMessage(
            {
              type: 'audio_chunk',
              samples: preroll,
              isPreRoll: true,
              sequence: seq,
            },
            [preroll.buffer],
          );
        }
      }
    } else {
      this.aboveThresholdSampleCount = 0;
      if (this.isSpeaking) {
        this.belowThresholdSampleCount += len;
        if (this.belowThresholdSampleCount >= this.minSilenceSamples) {
          const debouncedForMs =
            (this.belowThresholdSampleCount / sampleRate) * 1000;
          this.isSpeaking = false;
          this.port.postMessage({
            type: 'silence_started',
            timestamp: currentTime * 1000,
            rms: this.rmsEma,
            debouncedForMs,
          });
        }
      }
    }

    if (this.isStreaming) {
      for (let i = 0; i < len; i++) {
        this.speakingBuffer[this.speakingBufferPos++] = channel[i];
        if (this.speakingBufferPos >= SPEAKING_BUFFER_SIZE) {
          // Transfer a fresh copy so the worklet retains its own buffer.
          const chunk = new Float32Array(this.speakingBuffer);
          const seq = this.speakingSequence++;
          this.port.postMessage(
            {
              type: 'audio_chunk',
              samples: chunk,
              isPreRoll: false,
              sequence: seq,
            },
            [chunk.buffer],
          );
          this.speakingBufferPos = 0;
        }
      }
    }

    return true;
  }
}

registerProcessor(PROCESSOR_NAME, VadProcessor);
