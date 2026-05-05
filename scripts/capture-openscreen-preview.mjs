import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, _electron as electron } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MAIN_JS = path.join(ROOT, "dist-electron", "main.js");
const TEST_VIDEO = path.join(ROOT, "tests", "fixtures", "sample.webm");
const OUTPUT_DIR =
	process.env.OPENSCREEN_PREVIEW_OUTPUT_DIR ??
	path.join(os.tmpdir(), `openscreen-real-preview-${Date.now()}`);
const FRAME_COUNT = Number(process.env.OPENSCREEN_PREVIEW_FRAME_COUNT ?? 90);
const FPS = Number(process.env.OPENSCREEN_PREVIEW_FPS ?? 30);

function findLatestCursorRecordingData() {
	const explicit = process.env.CURSOR_RECORDING_DATA_PATH;
	if (explicit) {
		if (!fs.existsSync(explicit)) {
			throw new Error(`CURSOR_RECORDING_DATA_PATH does not exist: ${explicit}`);
		}
		return explicit;
	}

	const tempDir = os.tmpdir();
	const candidates = fs
		.readdirSync(tempDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("openscreen-cursor-native-"))
		.map((entry) => path.join(tempDir, entry.name, "cursor-recording-data.json"))
		.filter((candidate) => fs.existsSync(candidate))
		.map((candidate) => ({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs }))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	if (!candidates[0]) {
		throw new Error(
			"No cursor-recording-data.json found. Run npm run test:cursor-native:win first.",
		);
	}

	return candidates[0].path;
}

function findPlaywrightChromiumExecutable(defaultPath) {
	if (fs.existsSync(defaultPath)) {
		return defaultPath;
	}

	const baseDir = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
	if (!baseDir || !fs.existsSync(baseDir)) {
		return defaultPath;
	}

	const candidates = fs
		.readdirSync(baseDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
		.map((entry) => path.join(baseDir, entry.name, "chrome-win64", "chrome.exe"))
		.filter((candidate) => fs.existsSync(candidate))
		.sort()
		.reverse();

	return candidates[0] ?? defaultPath;
}

function ensureBuildExists() {
	if (!fs.existsSync(MAIN_JS)) {
		throw new Error(`Missing ${MAIN_JS}. Run npm run build-vite first.`);
	}
	if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
		throw new Error(`Missing renderer build. Run npm run build-vite first.`);
	}
}

function runNpmBuildViteIfRequested() {
	if (process.env.OPENSCREEN_PREVIEW_SKIP_BUILD === "true") {
		ensureBuildExists();
		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		const child = spawn("cmd.exe", ["/d", "/s", "/c", "npm run build-vite"], {
			cwd: ROOT,
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`npm run build-vite failed with code ${code}`));
		});
	});
}

async function encodeFramesToWebm(framePaths, outputPath) {
	const frameData = framePaths.map((framePath) => ({
		src: `data:image/png;base64,${fs.readFileSync(framePath).toString("base64")}`,
	}));
	const html = `<!doctype html>
<html>
<body>
<canvas id="canvas" width="1280" height="800"></canvas>
<script>
const frames = ${JSON.stringify(frameData)};
const fps = ${FPS};
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
function load(src) {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.src = src;
	});
}
window.__encode = async function() {
	const images = [];
	for (const frame of frames) images.push(await load(frame.src));
	canvas.width = images[0].naturalWidth;
	canvas.height = images[0].naturalHeight;
	const stream = canvas.captureStream(fps);
	const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
	const chunks = [];
	recorder.ondataavailable = (event) => {
		if (event.data.size > 0) chunks.push(event.data);
	};
	const done = new Promise((resolve) => {
		recorder.onstop = resolve;
	});
	recorder.start();
	for (const image of images) {
		ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
		await new Promise((resolve) => setTimeout(resolve, 1000 / fps));
	}
	recorder.stop();
	await done;
	const blob = new Blob(chunks, { type: "video/webm" });
	const buffer = await blob.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
};
</script>
</body>
</html>`;

	const browser = await chromium.launch({
		executablePath: findPlaywrightChromiumExecutable(chromium.executablePath()),
		headless: true,
	});
	try {
		const page = await browser.newPage();
		await page.setContent(html);
		const base64 = await page.evaluate(() => window.__encode());
		fs.writeFileSync(outputPath, Buffer.from(base64, "base64"));
	} finally {
		await browser.close();
	}
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const cursorRecordingDataPath = findLatestCursorRecordingData();
const fixtureVideoPath = path.join(OUTPUT_DIR, "openscreen-preview-fixture.webm");
const outputVideoPath = path.join(OUTPUT_DIR, "openscreen-preview.webm");
fs.copyFileSync(TEST_VIDEO, fixtureVideoPath);
fs.copyFileSync(cursorRecordingDataPath, `${fixtureVideoPath}.cursor.json`);

await runNpmBuildViteIfRequested();

const app = await electron.launch({
	args: [MAIN_JS, "--no-sandbox", "--enable-unsafe-swiftshader"],
	env: {
		...process.env,
		HEADLESS: "false",
	},
});

app.process().stdout?.on("data", (data) => process.stdout.write(`[electron] ${data}`));
app.process().stderr?.on("data", (data) => process.stderr.write(`[electron] ${data}`));

const framesDir = path.join(OUTPUT_DIR, "frames");
fs.mkdirSync(framesDir, { recursive: true });

try {
	const hudWindow = await app.firstWindow({ timeout: 60_000 });
	await hudWindow.waitForLoadState("domcontentloaded");
	await hudWindow.evaluate(async () => {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			try {
				await window.electronAPI.getCurrentRecordingSession();
				await window.electronAPI.getCurrentVideoPath();
				return;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		throw new Error("Timed out waiting for OpenScreen IPC handlers.");
	});

	try {
		await hudWindow.evaluate(async (videoPath) => {
			await window.electronAPI.setCurrentVideoPath(videoPath);
			await window.electronAPI.switchToEditor();
		}, fixtureVideoPath);
	} catch {
		// switchToEditor closes the HUD page before the evaluate promise can always resolve.
	}

	const editorWindow = await app.waitForEvent("window", {
		predicate: (window) => window.url().includes("windowType=editor"),
		timeout: 30_000,
	});
	await editorWindow.waitForLoadState("domcontentloaded");
	await editorWindow.waitForSelector("video", { state: "attached", timeout: 30_000 });
	await editorWindow.waitForSelector("canvas", { state: "attached", timeout: 30_000 });

	await editorWindow.setViewportSize({ width: 1280, height: 800 });
	await editorWindow.evaluate(async () => {
		await document.fonts.ready;
		for (const video of [...document.querySelectorAll("video")]) {
			video.muted = true;
			video.currentTime = 0;
			video.dispatchEvent(new Event("timeupdate"));
		}
	});
	await editorWindow.waitForTimeout(1000);

	const framePaths = [];
	for (let index = 0; index < FRAME_COUNT; index += 1) {
		const timeSec = index / FPS;
		await editorWindow.evaluate((time) => {
			for (const video of [...document.querySelectorAll("video")]) {
				video.currentTime = Math.min(time, Math.max(0, video.duration || time));
				video.dispatchEvent(new Event("timeupdate"));
			}
		}, timeSec);
		await editorWindow.waitForTimeout(40);
		const framePath = path.join(framesDir, `frame-${String(index).padStart(4, "0")}.png`);
		await editorWindow.screenshot({ path: framePath });
		framePaths.push(framePath);
	}

	await encodeFramesToWebm(framePaths, outputVideoPath);

	const report = {
		outputDir: OUTPUT_DIR,
		sourceCursorRecordingDataPath: cursorRecordingDataPath,
		fixtureVideoPath,
		outputVideoPath,
		frameCount: framePaths.length,
		fps: FPS,
	};
	fs.writeFileSync(path.join(OUTPUT_DIR, "report.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
} finally {
	await app.close();
}
