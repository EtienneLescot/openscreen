export const NOTES_TELEPROMPTER_STORAGE_KEY = "notesTeleprompterSettings";

export const MIN_TELEPROMPTER_SPEED = 10;
export const MAX_TELEPROMPTER_SPEED = 100;
export const TELEPROMPTER_SPEED_STEP = 10;

export const MIN_NOTES_FONT_SIZE = 14;
export const MAX_NOTES_FONT_SIZE = 48;
export const NOTES_FONT_SIZE_STEP = 2;

export const MAX_TELEPROMPTER_FRAME_MS = 100;

export type NotesTeleprompterSettings = {
	speed: number;
	fontSize: number;
	mirrored: boolean;
};

export const DEFAULT_NOTES_TELEPROMPTER_SETTINGS: NotesTeleprompterSettings = {
	speed: 40,
	fontSize: 16,
	mirrored: false,
};

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}

	return Math.min(maximum, Math.max(minimum, value));
}

export function clampTeleprompterSpeed(value: number): number {
	return clampNumber(
		value,
		DEFAULT_NOTES_TELEPROMPTER_SETTINGS.speed,
		MIN_TELEPROMPTER_SPEED,
		MAX_TELEPROMPTER_SPEED,
	);
}

export function clampNotesFontSize(value: number): number {
	return clampNumber(
		value,
		DEFAULT_NOTES_TELEPROMPTER_SETTINGS.fontSize,
		MIN_NOTES_FONT_SIZE,
		MAX_NOTES_FONT_SIZE,
	);
}

export function normalizeNotesTeleprompterSettings(value: unknown): NotesTeleprompterSettings {
	if (!value || typeof value !== "object") {
		return { ...DEFAULT_NOTES_TELEPROMPTER_SETTINGS };
	}

	const candidate = value as Partial<NotesTeleprompterSettings>;
	return {
		speed: clampTeleprompterSpeed(candidate.speed ?? Number.NaN),
		fontSize: clampNotesFontSize(candidate.fontSize ?? Number.NaN),
		mirrored:
			typeof candidate.mirrored === "boolean"
				? candidate.mirrored
				: DEFAULT_NOTES_TELEPROMPTER_SETTINGS.mirrored,
	};
}

export function loadNotesTeleprompterSettings(
	storage: ReadableStorage = localStorage,
): NotesTeleprompterSettings {
	try {
		const stored = storage.getItem(NOTES_TELEPROMPTER_STORAGE_KEY);
		return stored
			? normalizeNotesTeleprompterSettings(JSON.parse(stored))
			: { ...DEFAULT_NOTES_TELEPROMPTER_SETTINGS };
	} catch {
		return { ...DEFAULT_NOTES_TELEPROMPTER_SETTINGS };
	}
}

export function saveNotesTeleprompterSettings(
	settings: NotesTeleprompterSettings,
	storage: WritableStorage = localStorage,
): boolean {
	try {
		storage.setItem(
			NOTES_TELEPROMPTER_STORAGE_KEY,
			JSON.stringify(normalizeNotesTeleprompterSettings(settings)),
		);
		return true;
	} catch {
		return false;
	}
}

export function loadInitialNotesContent(storage: ReadableStorage = localStorage): string {
	let stored: string | null;
	try {
		stored = storage.getItem("notes");
	} catch {
		return "";
	}

	if (!stored) {
		return "";
	}

	// Notes saved before Tiptap were plain text; wrap so StarterKit can parse them.
	if (!stored.trim().startsWith("<")) {
		const escaped = stored.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		return `<p>${escaped.replace(/\n/g, "</p><p>")}</p>`;
	}

	return stored;
}

export function saveNotesContent(html: string, storage: WritableStorage = localStorage): boolean {
	try {
		storage.setItem("notes", html);
		return true;
	} catch {
		return false;
	}
}

export type TeleprompterFrame = {
	elapsedMs: number;
	nextTimestamp: number | null;
};

export function getTeleprompterFrame(
	previousTimestamp: number | null,
	currentTimestamp: number,
): TeleprompterFrame {
	if (!Number.isFinite(currentTimestamp)) {
		return { elapsedMs: 0, nextTimestamp: null };
	}

	if (
		previousTimestamp === null ||
		!Number.isFinite(previousTimestamp) ||
		currentTimestamp <= previousTimestamp
	) {
		return { elapsedMs: 0, nextTimestamp: currentTimestamp };
	}

	return {
		elapsedMs: Math.min(currentTimestamp - previousTimestamp, MAX_TELEPROMPTER_FRAME_MS),
		nextTimestamp: currentTimestamp,
	};
}

export function getNextTeleprompterScrollTop(
	currentScrollTop: number,
	speed: number,
	elapsedMs: number,
	maxScrollTop: number,
): number {
	const safeCurrent = Number.isFinite(currentScrollTop) ? Math.max(0, currentScrollTop) : 0;
	const safeMaximum = Number.isFinite(maxScrollTop) ? Math.max(0, maxScrollTop) : 0;
	const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
	const distance = (clampTeleprompterSpeed(speed) * safeElapsed) / 1_000;

	return Math.min(safeMaximum, safeCurrent + distance);
}
