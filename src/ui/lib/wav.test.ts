/* The encoding path C1 depends on and no acceptance test can reach.

   A clip that will not decode is silent, and silence is indistinguishable from
   the blocked network this whole feature was built for. That ambiguity is the
   reason these exist: if somebody reports hearing nothing, the header should
   already be ruled out. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  downsample,
  encodeWav,
  fromBase64,
  TARGET_SAMPLE_RATE,
  toBase64,
} from "./wav.ts";

const text = (bytes: Uint8Array, at: number, len: number) =>
  String.fromCharCode(...bytes.subarray(at, at + len));

const u32 = (bytes: Uint8Array, at: number) =>
  new DataView(bytes.buffer).getUint32(at, true);

const u16 = (bytes: Uint8Array, at: number) =>
  new DataView(bytes.buffer).getUint16(at, true);

const i16 = (bytes: Uint8Array, at: number) =>
  new DataView(bytes.buffer).getInt16(at, true);

/* ---- The header, byte by byte, because one wrong field is silence ---- */

test("the header is RIFF/WAVE with a fmt chunk", () => {
  const wav = encodeWav(new Float32Array(4));
  assert.equal(text(wav, 0, 4), "RIFF");
  assert.equal(text(wav, 8, 4), "WAVE");
  assert.equal(text(wav, 12, 4), "fmt ");
  assert.equal(text(wav, 36, 4), "data");
});

test("the format is uncompressed 16-bit mono at the target rate", () => {
  const wav = encodeWav(new Float32Array(4));
  assert.equal(u16(wav, 20), 1, "PCM");
  assert.equal(u16(wav, 22), 1, "one channel");
  assert.equal(u32(wav, 24), TARGET_SAMPLE_RATE);
  assert.equal(u16(wav, 34), 16, "bits per sample");
});

/* Byte rate and block align are derived, and a decoder that trusts them will
   play at the wrong speed if they disagree with the rest of the header. */
test("byte rate and block align agree with the format", () => {
  const wav = encodeWav(new Float32Array(4));
  const channels = u16(wav, 22);
  const bits = u16(wav, 34);
  assert.equal(u32(wav, 28), (TARGET_SAMPLE_RATE * channels * bits) / 8);
  assert.equal(u16(wav, 32), (channels * bits) / 8);
});

/* The two length fields are the ones most likely to be wrong by a constant, and
   a decoder reading a length past the buffer truncates or refuses the clip. */
test("both declared lengths match the actual payload", () => {
  const wav = encodeWav(new Float32Array(100));
  assert.equal(wav.length, 44 + 200);
  assert.equal(u32(wav, 40), 200, "data chunk size");
  assert.equal(u32(wav, 4), 36 + 200, "riff size counts everything after it");
  assert.equal(u32(wav, 4), wav.length - 8);
});

test("an empty clip is a valid header with no samples", () => {
  const wav = encodeWav(new Float32Array(0));
  assert.equal(wav.length, 44);
  assert.equal(u32(wav, 40), 0);
});

/* ---- Sample conversion ---- */

test("silence encodes as zero", () => {
  const wav = encodeWav(new Float32Array([0, 0]));
  assert.equal(i16(wav, 44), 0);
  assert.equal(i16(wav, 46), 0);
});

test("full scale maps to the ends of the 16-bit range", () => {
  const wav = encodeWav(new Float32Array([1, -1]));
  assert.equal(i16(wav, 44), 32767);
  assert.equal(i16(wav, 46), -32768);
});

/* The clamp is the whole reason positive and negative scale by different
   constants. Without it a sample of 1.2 wraps to a large negative number, which
   is heard as a click rather than as clipping. */
test("samples beyond full scale clamp instead of wrapping", () => {
  const wav = encodeWav(new Float32Array([1.5, -1.5, 99, -99]));
  assert.equal(i16(wav, 44), 32767);
  assert.equal(i16(wav, 46), -32768);
  assert.equal(i16(wav, 48), 32767);
  assert.equal(i16(wav, 50), -32768);
});

test("no encoded sample ever wraps sign", () => {
  const input = new Float32Array(200);
  for (let i = 0; i < input.length; i += 1) input[i] = (i / 100) * 2 - 2;
  const wav = encodeWav(input);
  for (let i = 0; i < input.length; i += 1) {
    const encoded = i16(wav, 44 + i * 2);
    const source = input[i] ?? 0;
    if (source > 0) assert.ok(encoded >= 0, `sample ${i} flipped sign`);
    if (source < 0) assert.ok(encoded <= 0, `sample ${i} flipped sign`);
  }
});

/* ---- Downsampling ---- */

test("a rate at or below the target passes through untouched", () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);
  assert.equal(downsample(input, TARGET_SAMPLE_RATE), input);
  assert.equal(downsample(input, 8000), input);
});

test("48 kHz decimates to a third of the samples", () => {
  const input = new Float32Array(300);
  assert.equal(downsample(input, 48000).length, 100);
});

test("44.1 kHz decimates without producing a fractional length", () => {
  const out = downsample(new Float32Array(441), 44100);
  assert.equal(Number.isInteger(out.length), true);
  assert.equal(out.length, 160);
});

test("a constant signal survives decimation unchanged", () => {
  const input = new Float32Array(300).fill(0.5);
  for (const sample of downsample(input, 48000)) {
    assert.ok(Math.abs(sample - 0.5) < 1e-6);
  }
});

test("downsampling averages rather than dropping, so it never reads undefined", () => {
  const input = new Float32Array([1, 1, 1, -1, -1, -1]);
  const out = downsample(input, TARGET_SAMPLE_RATE * 3);
  assert.equal(out.length, 2);
  assert.ok(Math.abs((out[0] ?? 0) - 1) < 1e-6);
  assert.ok(Math.abs((out[1] ?? 0) + 1) < 1e-6);
});

test("an empty buffer downsamples to an empty buffer", () => {
  assert.equal(downsample(new Float32Array(0), 48000).length, 0);
});

/* ---- base64, which carries the clip over the WebSocket ---- */

test("base64 round-trips every byte value", () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) bytes[i] = i;
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

/* The chunking exists because spreading a quarter of a megabyte into
   String.fromCharCode overflows the argument stack. A clip at the section 7 cap
   is larger than one chunk, so this is the case that would have crashed. */
test("a clip larger than one chunk round-trips", () => {
  const bytes = new Uint8Array(0x8000 * 2 + 1234);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
  const round = fromBase64(toBase64(bytes));
  assert.equal(round.length, bytes.length);
  assert.deepEqual(round, bytes);
});

test("an encoded clip stays under the section 7 cap at full length", () => {
  /* Eight seconds at the target rate, the longest clip the client will send. */
  const wav = encodeWav(new Float32Array(TARGET_SAMPLE_RATE * 8));
  assert.ok(
    toBase64(wav).length <= 350 * 1024,
    `${toBase64(wav).length} exceeds the 350 KB cap the server enforces`,
  );
});

test("a whole clip survives encode and base64 together", () => {
  const input = new Float32Array(48000);
  for (let i = 0; i < input.length; i += 1) input[i] = Math.sin(i / 20) * 0.8;
  const wav = encodeWav(downsample(input, 48000));
  assert.deepEqual(fromBase64(toBase64(wav)), wav);
  assert.equal(text(fromBase64(toBase64(wav)), 0, 4), "RIFF");
});
