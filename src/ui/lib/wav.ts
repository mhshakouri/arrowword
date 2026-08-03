/* The pure half of voice capture: resampling, WAV encoding, and base64.

   Split out of voice.ts in B1 for the reason pending.ts gives: this is where a
   mistake is silent. A wrong byte in a 44-byte header produces a clip that
   records without complaint, sends without complaint, and will not decode on
   the other end, and the only symptom is somebody hearing nothing. Nothing in
   the acceptance suite can catch that, because no check in this repository can
   hear anything. Pure functions can at least be checked.

   No imports, no browser globals beyond btoa and atob, which Node has too. */

export const TARGET_SAMPLE_RATE = 16000;

/* Box-average decimation. Not a windowed resampler: speech at 16 kHz through a
   phone speaker does not reward one, and every extra millisecond of main-thread
   work here happens while somebody is waiting to be heard. */
export function downsample(input: Float32Array, from: number): Float32Array {
  if (from <= TARGET_SAMPLE_RATE) return input;
  const ratio = from / TARGET_SAMPLE_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j] ?? 0;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

export function encodeWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1)
      view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  /* 1 is uncompressed PCM, 1 channel. */
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  /* Byte rate and block align, both for 16-bit mono. */
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i += 1) {
    /* Clamp before scaling: a sample slightly outside -1..1 is legal float
       audio and wraps to the opposite extreme as a signed 16-bit integer,
       which is heard as a click rather than as clipping. */
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(
      44 + i * 2,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  }
  return bytes;
}

/* Chunked because `String.fromCharCode(...bytes)` on a quarter of a megabyte
   overflows the argument stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
