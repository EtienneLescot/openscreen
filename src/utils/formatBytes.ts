// Binary file sizes (1 KB = 1024 B), as the media panes have always shown them.
//
// Deliberately not Intl.NumberFormat's `unit: "byte"` + `notation: "compact"`:
// that formats in DECIMAL units (1 kB = 1000 B) and localises the unit name, so
// a French locale renders 1 GiB as "1,1 Mdo". Wrong magnitude, unreadable label.

/** `—` for missing/invalid input, else e.g. `512 B`, `840 KB`, `12 MB`, `1.4 GB`. */
export function formatBytes(bytes: number | undefined): string {
	if (!bytes || !Number.isFinite(bytes)) return "—";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
