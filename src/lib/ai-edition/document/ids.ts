import { v4 as uuidv4 } from "uuid";

// ponytail: stable id format `${prefix}_${uuid}` — readable in stored documents
// and grep-friendly. Replacement for axcut's packages/axcut-schema ids helper
// until the full schema package lands in-tree.
export function createId(prefix: string): string {
	return `${prefix}_${uuidv4()}`;
}
