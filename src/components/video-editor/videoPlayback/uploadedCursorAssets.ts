import crosshairUrl from "../../../assets/cursors/Cursor=Cross.svg";
import arrowUrl from "../../../assets/cursors/Cursor=Default.svg";
import closedHandUrl from "../../../assets/cursors/Cursor=Hand-(Grabbing).svg";
import openHandUrl from "../../../assets/cursors/Cursor=Hand-(Open).svg";
import pointerUrl from "../../../assets/cursors/Cursor=Hand-(Pointing).svg";
import resizeNsUrl from "../../../assets/cursors/Cursor=Resize-North-South.svg";
import resizeEwUrl from "../../../assets/cursors/Cursor=Resize-West-East.svg";
import textUrl from "../../../assets/cursors/Cursor=Text-Cursor.svg";
import type { CursorTelemetryPoint } from "../types";

type CursorAssetKey = NonNullable<CursorTelemetryPoint["cursorType"]>;

export type UploadedCursorAsset = {
	url: string;
	trim: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	fallbackAnchor: {
		x: number;
		y: number;
	};
};

export const UPLOADED_CURSOR_SAMPLE_SIZE = 1024;

export const uploadedCursorAssets: Partial<Record<CursorAssetKey, UploadedCursorAsset>> = {
	arrow: {
		url: arrowUrl,
		trim: { x: 480, y: 435, width: 333, height: 553 },
		fallbackAnchor: { x: 0.18, y: 0.1 },
	},
	text: {
		url: textUrl,
		trim: { x: 404, y: 192, width: 247, height: 596 },
		fallbackAnchor: { x: 0.5, y: 0.5 },
	},
	pointer: {
		url: pointerUrl,
		trim: { x: 352, y: 441, width: 466, height: 583 },
		fallbackAnchor: { x: 0.37, y: 0.08 },
	},
	crosshair: {
		url: crosshairUrl,
		trim: { x: 288, y: 288, width: 480, height: 480 },
		fallbackAnchor: { x: 0.5, y: 0.5 },
	},
	"open-hand": {
		url: openHandUrl,
		trim: { x: 288, y: 188, width: 512, height: 580 },
		fallbackAnchor: { x: 0.5, y: 0.28 },
	},
	"closed-hand": {
		url: closedHandUrl,
		trim: { x: 344, y: 365, width: 432, height: 403 },
		fallbackAnchor: { x: 0.5, y: 0.28 },
	},
	"resize-ew": {
		url: resizeEwUrl,
		trim: { x: 187, y: 384, width: 669, height: 270 },
		fallbackAnchor: { x: 0.5, y: 0.5 },
	},
	"resize-ns": {
		url: resizeNsUrl,
		trim: { x: 376, y: 178, width: 271, height: 669 },
		fallbackAnchor: { x: 0.5, y: 0.5 },
	},
};
