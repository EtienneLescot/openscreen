// Pure argv parser for the OpenScreen CLI. No Electron imports so it can be
// unit-tested under plain vitest.

import path from "node:path";
import type { CliExportRequest, CliRecordRequest, CliRequest } from "../../src/lib/cliContracts";

export interface CliInfoCommand {
	kind: "info";
	projectPath: string;
}

export interface CliHelpCommand {
	kind: "help";
}

export interface CliErrorCommand {
	kind: "error";
	message: string;
}

export type CliCommand = (CliRequest | CliInfoCommand | CliHelpCommand | CliErrorCommand) & {
	/** Machine-readable NDJSON output on stdout instead of human progress. */
	json?: boolean;
};

const SUBCOMMANDS = new Set(["export", "record", "info", "help", "--help", "-h"]);

export const CLI_USAGE = `OpenScreen CLI

Usage:
  openscreen export <project.openscreen> [options]   Render a project to MP4/GIF
  openscreen record [options]                        Record the screen headlessly
  openscreen info <project.openscreen> [--json]      Inspect a project file
  openscreen help                                    Show this help

Export options:
  -o, --out <path>          Output file (.mp4 or .gif). Default: next to the project file
  --format <mp4|gif>        Override the format stored in the project
  --quality <medium|good|source>
                            MP4 quality (default: from project)
  --gif-fps <15|20|25|30>   GIF frame rate (default: from project)
  --gif-size <medium|large|original>
                            GIF size preset (default: from project)
  --preview-size <WxH>      Reference preview box for annotation scaling (default 1280x720)
  --audio <file>            Mix a voiceover audio file into the MP4 (mp3/wav/m4a)
  --audio-mode <mix|replace>
                            Layer over the recording's audio (default) or replace it
  --audio-offset <seconds>  Delay before the voiceover starts (default 0)
  --json                    NDJSON progress/result on stdout

Record options (recording is saved into the app's recordings directory):
  --display <n>             Screen index to record (default 0)
  --window <title>          Record the first window whose title contains <title>
  --mic                     Capture the default microphone
  --mic-device <name>       Microphone device name (implies --mic)
  --system-audio            Capture system audio
  --cursor <editable-overlay|system>
                            Cursor capture mode (default editable-overlay)
  --duration <seconds>      Stop automatically after this long
  --project <out.openscreen>
                            Write a ready-to-export project file when done
  --json                    NDJSON events on stdout

Stopping a recording: send SIGINT/SIGTERM, type "stop" + Enter on stdin,
or pass --duration.
`;

function takeValue(argv: string[], i: number, flag: string): [string, number] {
	const next = argv[i + 1];
	if (next === undefined || next.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return [next, i + 1];
}

function resolvePath(p: string, cwd: string): string {
	return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/**
 * Extracts CLI arguments from process.argv. Returns null when no subcommand is
 * present (normal GUI launch). `firstArgIndex` should be 1 for packaged builds
 * and 2 when running via `electron <app-path> ...`.
 */
export function parseCliArgs(
	argv: string[],
	firstArgIndex: number,
	cwd: string = process.cwd(),
): CliCommand | null {
	const rawArgs = argv.slice(firstArgIndex).filter((a) => !a.startsWith("--inspect"));

	// Skip *leading* Chromium/Electron switches (e.g. the AppImage's required
	// `--no-sandbox`) so `Openscreen --no-sandbox export demo.openscreen` still
	// enters CLI mode. Only leading dash-tokens are skipped — everything after
	// the subcommand belongs to the subcommand parser. `--help`/`-h` are ours.
	let subIndex = 0;
	while (
		subIndex < rawArgs.length &&
		rawArgs[subIndex].startsWith("-") &&
		rawArgs[subIndex] !== "--help" &&
		rawArgs[subIndex] !== "-h"
	) {
		subIndex++;
	}

	const args = rawArgs.slice(subIndex);
	const sub = args[0];
	if (!sub || !SUBCOMMANDS.has(sub)) return null;
	if (sub === "help" || sub === "--help" || sub === "-h") return { kind: "help" };

	try {
		if (sub === "export") return parseExport(args.slice(1), cwd);
		if (sub === "record") return parseRecord(args.slice(1), cwd);
		return parseInfo(args.slice(1), cwd);
	} catch (error) {
		return { kind: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

function parseExport(args: string[], cwd: string): CliCommand {
	const request: CliExportRequest & { json?: boolean } = {
		kind: "export",
		projectPath: "",
		outPath: null,
		format: null,
		quality: null,
		gifFrameRate: null,
		gifSizePreset: null,
		previewWidth: null,
		previewHeight: null,
		audioPath: null,
		audioMode: "mix",
		audioOffsetSec: 0,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "-o":
			case "--out": {
				const [value, next] = takeValue(args, i, arg);
				request.outPath = resolvePath(value, cwd);
				i = next;
				break;
			}
			case "--format": {
				const [value, next] = takeValue(args, i, arg);
				if (value !== "mp4" && value !== "gif") {
					throw new Error(`--format must be mp4 or gif, got "${value}"`);
				}
				request.format = value;
				i = next;
				break;
			}
			case "--quality": {
				const [value, next] = takeValue(args, i, arg);
				if (value !== "medium" && value !== "good" && value !== "source") {
					throw new Error(`--quality must be medium, good or source, got "${value}"`);
				}
				request.quality = value;
				i = next;
				break;
			}
			case "--gif-fps": {
				const [value, next] = takeValue(args, i, arg);
				const fps = Number(value);
				if (fps !== 15 && fps !== 20 && fps !== 25 && fps !== 30) {
					throw new Error(`--gif-fps must be 15, 20, 25 or 30, got "${value}"`);
				}
				request.gifFrameRate = fps;
				i = next;
				break;
			}
			case "--gif-size": {
				const [value, next] = takeValue(args, i, arg);
				if (value !== "medium" && value !== "large" && value !== "original") {
					throw new Error(`--gif-size must be medium, large or original, got "${value}"`);
				}
				request.gifSizePreset = value;
				i = next;
				break;
			}
			case "--preview-size": {
				const [value, next] = takeValue(args, i, arg);
				const match = /^(\d+)x(\d+)$/.exec(value);
				if (!match) throw new Error(`--preview-size must look like 1280x720, got "${value}"`);
				request.previewWidth = Number(match[1]);
				request.previewHeight = Number(match[2]);
				i = next;
				break;
			}
			case "--audio": {
				const [value, next] = takeValue(args, i, arg);
				request.audioPath = resolvePath(value, cwd);
				i = next;
				break;
			}
			case "--audio-mode": {
				const [value, next] = takeValue(args, i, arg);
				if (value !== "mix" && value !== "replace") {
					throw new Error(`--audio-mode must be mix or replace, got "${value}"`);
				}
				request.audioMode = value;
				i = next;
				break;
			}
			case "--audio-offset": {
				const [value, next] = takeValue(args, i, arg);
				const seconds = Number(value);
				if (!Number.isFinite(seconds) || seconds < 0) {
					throw new Error(
						`--audio-offset must be a non-negative number of seconds, got "${value}"`,
					);
				}
				request.audioOffsetSec = seconds;
				i = next;
				break;
			}
			case "--json":
				request.json = true;
				break;
			default:
				if (arg.startsWith("-")) throw new Error(`Unknown export option: ${arg}`);
				if (request.projectPath) throw new Error(`Unexpected extra argument: ${arg}`);
				request.projectPath = resolvePath(arg, cwd);
		}
	}

	if (!request.projectPath) throw new Error("export requires a <project.openscreen> path");
	if (request.audioPath && request.format === "gif") {
		throw new Error("--audio is only supported for MP4 exports");
	}
	if (request.outPath) {
		const ext = path.extname(request.outPath).toLowerCase();
		if (ext !== ".mp4" && ext !== ".gif") {
			throw new Error(`--out must end in .mp4 or .gif, got "${request.outPath}"`);
		}
		const extFormat = ext === ".gif" ? "gif" : "mp4";
		if (request.format && request.format !== extFormat) {
			throw new Error(`--format ${request.format} conflicts with --out extension ${ext}`);
		}
		request.format = extFormat;
	}
	return request;
}

function parseRecord(args: string[], cwd: string): CliCommand {
	const request: CliRecordRequest & { json?: boolean } = {
		kind: "record",
		displayIndex: 0,
		windowTitle: null,
		mic: false,
		micDevice: null,
		systemAudio: false,
		cursorMode: "editable-overlay",
		durationMs: null,
		projectOut: null,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--display": {
				const [value, next] = takeValue(args, i, arg);
				const index = Number(value);
				if (!Number.isInteger(index) || index < 0) {
					throw new Error(`--display must be a non-negative integer, got "${value}"`);
				}
				request.displayIndex = index;
				i = next;
				break;
			}
			case "--window": {
				const [value, next] = takeValue(args, i, arg);
				request.windowTitle = value;
				i = next;
				break;
			}
			case "--mic":
				request.mic = true;
				break;
			case "--mic-device": {
				const [value, next] = takeValue(args, i, arg);
				request.mic = true;
				request.micDevice = value;
				i = next;
				break;
			}
			case "--system-audio":
				request.systemAudio = true;
				break;
			case "--cursor": {
				const [value, next] = takeValue(args, i, arg);
				if (value !== "editable-overlay" && value !== "system") {
					throw new Error(`--cursor must be editable-overlay or system, got "${value}"`);
				}
				request.cursorMode = value;
				i = next;
				break;
			}
			case "--duration": {
				const [value, next] = takeValue(args, i, arg);
				const seconds = Number(value);
				if (!Number.isFinite(seconds) || seconds <= 0) {
					throw new Error(`--duration must be a positive number of seconds, got "${value}"`);
				}
				request.durationMs = Math.round(seconds * 1000);
				i = next;
				break;
			}
			case "--project": {
				const [value, next] = takeValue(args, i, arg);
				if (!value.endsWith(".openscreen")) {
					throw new Error(`--project must end in .openscreen, got "${value}"`);
				}
				request.projectOut = resolvePath(value, cwd);
				i = next;
				break;
			}
			case "--json":
				request.json = true;
				break;
			default:
				throw new Error(`Unknown record option: ${arg}`);
		}
	}
	return request;
}

function parseInfo(args: string[], cwd: string): CliCommand {
	let projectPath = "";
	let json = false;
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown info option: ${arg}`);
		} else if (projectPath) {
			throw new Error(`Unexpected extra argument: ${arg}`);
		} else {
			projectPath = resolvePath(arg, cwd);
		}
	}
	if (!projectPath) throw new Error("info requires a <project.openscreen> path");
	return { kind: "info", projectPath, json };
}
