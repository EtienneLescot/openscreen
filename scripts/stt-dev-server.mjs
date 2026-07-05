/**
 * Dev-mode fallback STT server for when the CTranslate2 C++ binary hasn't been
 * built yet. Listens on a configurable port and responds to /inference with
 * mock transcription data so the renderer and IPC pipeline can be tested end-to-end.
 *
 * Usage:
 *   node scripts/stt-dev-server.mjs --port 20199
 *
 * Then set OPENSCREEN_CT2_SERVER_EXE to a script that spawns this,
 * or copy the binary name to electron/native/bin/win32-x64/ctranslate2-server-cpu.exe
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PORT = parseInt(
	process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ??
		process.argv[process.argv.indexOf("--port") + 1] ??
		"20199",
	10,
);

function htmlResponse(res, status, body, contentType = "application/json") {
	res.writeHead(status, { "Content-Type": contentType });
	res.end(body);
}

function parseMultipartBoundary(contentType) {
	const match = contentType?.match(/boundary=(?:"([^"]+)"|([^;]+))/);
	return match ? match[1] || match[2] : null;
}

function parseMultipart(body, boundary) {
	if (!boundary) return {};
	const parts = {};
	const delimiter = `--${boundary}`;
	const sections = body.split(delimiter).filter((s) => s.includes("Content-Disposition"));
	for (const section of sections) {
		const nameMatch = section.match(/name="([^"]+)"/);
		if (!nameMatch) continue;
		const name = nameMatch[1];
		// Extract content after the blank line
		const contentStart = section.indexOf("\r\n\r\n");
		if (contentStart === -1) continue;
		let content = section.slice(contentStart + 4);
		// Remove trailing CRLF + boundary delimiter artifacts
		content = content.replace(/\r\n--$/, "");
		parts[name] = content;
	}
	return parts;
}

// Generate mock transcription segments with realistic timestamps
function generateMockTranscript(audioDurationSec, language) {
	const sampleWords = [
		"Hello",
		"and",
		"welcome",
		"to",
		"this",
		"screen",
		"recording",
		"today",
		"we",
		"are",
		"going",
		"to",
		"demonstrate",
		"the",
		"feature",
		"this",
		"is",
		"a",
		"test",
		"of",
		"the",
		"speech",
		"to",
		"text",
		"system",
		"using",
		"the",
		"new",
		"CTranslate2",
		"backend",
	];

	const segments = [];
	const wordSegments = [];
	let currentTime = 0.0;
	let wordIndex = 0;

	// Split into segments of 3-7 words each
	let _segStart = 0;
	let segId = 0;

	while (wordIndex < sampleWords.length && currentTime < audioDurationSec) {
		const wordsInSegment = 3 + (wordIndex % 5);
		const segText = [];
		const segWords = [];
		let segStartTime = currentTime;

		for (let w = 0; w < wordsInSegment && wordIndex < sampleWords.length; w++) {
			const word = sampleWords[wordIndex++];
			const wordDuration = 0.2 + Math.random() * 0.3;

			segText.push(word);
			segWords.push({
				word: " " + word,
				start: Math.round(currentTime * 100) / 100,
				end: Math.round((currentTime + wordDuration) * 100) / 100,
				probability: 0.85 + Math.random() * 0.14,
			});

			wordSegments.push({
				word,
				startSec: Math.round(currentTime * 100) / 100,
				endSec: Math.round((currentTime + wordDuration) * 100) / 100,
			});

			currentTime += wordDuration + 0.05;
		}

		const segEnd = currentTime;
		segments.push({
			id: segId++,
			text: " " + segText.join(" "),
			start: Math.round(segStartTime * 100) / 100,
			end: Math.round(segEnd * 100) / 100,
			words: segWords,
		});
	}

	return {
		language,
		detected_language: language,
		segments,
	};
}

const server = createServer((req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);

	if (req.method === "GET" && url.pathname === "/") {
		return htmlResponse(res, 200, "ok\n", "text/plain");
	}

	if (req.method === "POST" && url.pathname === "/inference") {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks);
			const boundary = parseMultipartBoundary(req.headers["content-type"]);
			const fields = boundary ? parseMultipart(raw.toString("latin1"), boundary) : {};

			const language = fields.language || "auto";
			const lang = language === "auto" ? "en" : language;

			// Determine audio duration from mock WAV data
			const wavData = fields.file;
			const audioDurationSec = wavData
				? Math.max(2, Math.round((wavData.length - 44) / 2 / 16000))
				: 5;

			const result = generateMockTranscript(Math.min(audioDurationSec, 120), `<|${lang}|>`);

			htmlResponse(res, 200, JSON.stringify(result));
		});
		return;
	}

	htmlResponse(res, 404, JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
	process.stdout.write(`[stt-dev-server] listening on 127.0.0.1:${PORT}\n`);
});
