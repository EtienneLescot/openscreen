import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * WAV serialization + temp-file hygiene shared by every native STT backend
 * the Electron main process talks to. Engine-agnostic on purpose: the new
 * CTranslate2 server (and any future replacement) reads the same 16-bit LE
 * PCM, 16 kHz, mono format whisper.cpp used to, so we don't pay the cost of
 * a multiplexer here.
 *
 * ponytail: a per-call mkdtemp is genuinely cheap (~1ms on every platform
 * tested) and gives the matching cleanup a self-contained directory to rm —
 * no risk of leaving half-built audio blobs lying under the OS tmp dir if
 * the process dies mid-call. Don't try to be clever with a single shared
 * scratch path; the laziness is the safety.
 */

const SAMPLE_RATE = 16_000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const HEADER_BYTES = 44;

/** Writes a 16-bit PCM mono 16 kHz WAV file and returns its path. */
export async function writeSamplesAsWav(samples: Float32Array): Promise<string> {
	const byteRate = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
	const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
	const dataLength = samples.length * (BITS_PER_SAMPLE / 8);
	const fileLength = HEADER_BYTES + dataLength;

	const buf = Buffer.alloc(HEADER_BYTES + dataLength);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(fileLength - 8, 4);
	buf.write("WAVE", 8);
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(NUM_CHANNELS, 22);
	buf.writeUInt32LE(SAMPLE_RATE, 24);
	buf.writeUInt32LE(byteRate, 28);
	buf.writeUInt16LE(blockAlign, 32);
	buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(dataLength, 40);
	// ponytail: hard-clip to [-1, 1] before the int16 conversion so a
	// malformed upstream sample can't overflow the writer into the next
	// chunk's data.
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
		buf.writeInt16LE(Math.round(s * 32_767), HEADER_BYTES + i * 2);
	}

	const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openscreen-stt-"));
	const outPath = path.join(tmpDir, "audio.wav");
	await writeFile(outPath, buf);
	return outPath;
}

/** Remove the WAV file plus the temporary directory `writeSamplesAsWav` created for it. */
export async function cleanupWav(wavPath: string): Promise<void> {
	await rm(path.dirname(wavPath), { recursive: true, force: true }).catch(() => undefined);
}
