import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clamp } from "@/utils/math";

/* ---------- icons ---------- */
const PlusIcon = () => (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none">
		<path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
	</svg>
);

const MinusIcon = () => (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none">
		<path d="M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
	</svg>
);

const RingsIcon = () => (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none">
		<circle cx="8" cy="9" r="5" stroke="currentColor" strokeWidth="1.6" />
		<circle cx="16" cy="9" r="5" stroke="currentColor" strokeWidth="1.6" />
		<circle cx="12" cy="16" r="5" stroke="currentColor" strokeWidth="1.6" />
	</svg>
);

const MAX_COLORS = 3;
const MAIN_ID = "main";
const MAIN_MAX_RADIUS = 40;

/* ---------- color-wheel harmony math ---------- */
type ColorHarmony = {
	type: HarmonyType;
	count: number;
	angles: number[];
};

type HarmonyType = "complementary" | "analogous" | "splitComplementary" | "triadic" | "square";

const colorHarmonies: ColorHarmony[] = [
	{ type: "complementary", count: 1, angles: [180] },
	{ type: "analogous", count: 1, angles: [35] },
	{ type: "splitComplementary", count: 2, angles: [150, 210] },
	{ type: "triadic", count: 2, angles: [120, 240] },
	{ type: "square", count: 2, angles: [90, 270] },
];

function getEligibleHarmonies(secondaryCount: number): ColorHarmony[] {
	return colorHarmonies.filter((h) => h.count === secondaryCount);
}

function getHarmonyAngles(secondaryCount: number, harmonyType: HarmonyType): number[] {
	const eligible = getEligibleHarmonies(secondaryCount);
	if (eligible.length === 0) return [];
	return (eligible.find((h) => h.type === harmonyType) || eligible[0]).angles;
}

function computeSecondaryPositions(
	mainAngle: number,
	mainRadius: number,
	secondaries: { id: string }[],
	harmonyType: HarmonyType,
): { id: string; x: number; y: number; color: string }[] {
	const angles = getHarmonyAngles(secondaries.length, harmonyType);
	return secondaries.map((p, i) => {
		const angle = mainAngle + (angles[i] ?? 0);
		const rad = (angle * Math.PI) / 180;
		const x = clamp(50 + mainRadius * Math.cos(rad), 5, 95);
		const y = clamp(50 + mainRadius * Math.sin(rad), 5, 95);
		return { id: p.id, x, y, color: colorFromPolar(angle, mainRadius) };
	});
}

/* ---------- position -> color ---------- */
function hueToRgb(p: number, q: number, t: number): number {
	let tt = t;
	if (tt < 0) tt += 1;
	if (tt > 1) tt -= 1;
	if (tt < 1 / 6) return p + (q - p) * 6 * tt;
	if (tt < 1 / 2) return q;
	if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
	return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	let r: number;
	let g: number;
	let b: number;
	if (s === 0) {
		r = g = b = l;
	} else {
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		r = hueToRgb(p, q, h + 1 / 3);
		g = hueToRgb(p, q, h);
		b = hueToRgb(p, q, h - 1 / 3);
	}
	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function colorFromPolar(angleDeg: number, radiusPct: number): string {
	const hue = ((angleDeg % 360) + 360) % 360;
	const saturation = clamp(radiusPct / MAIN_MAX_RADIUS, 0, 1);
	const [r, g, b] = hslToRgb(hue / 360, saturation, 0.5);
	return `rgb(${r}, ${g}, ${b})`;
}

/* ---------- wavy-slider path ---------- */
const LINE_PATH = `M 51.373 27.395 L 367.037 27.395`;
const SINE_PATH = `M 51.373 27.395 C 60.14 -8.503 68.906 -8.503 77.671 27.395 C 86.438 63.293 95.205 63.293 103.971 27.395 C 112.738 -8.503 121.504 -8.503 130.271 27.395 C 139.037 63.293 147.803 63.293 156.57 27.395 C 165.335 -8.503 174.101 -8.503 182.868 27.395 C 191.634 63.293 200.4 63.293 209.167 27.395 C 217.933 -8.503 226.7 -8.503 235.467 27.395 C 244.233 63.293 252.999 63.293 261.765 27.395 C 270.531 -8.503 279.297 -8.503 288.064 27.395 C 296.83 63.293 305.596 63.293 314.363 27.395 C 323.13 -8.503 331.896 -8.503 340.662 27.395 M 314.438 27.395 C 323.204 -8.503 331.97 -8.503 340.737 27.395 C 349.503 63.293 358.27 63.293 367.037 27.395`;

type PathPoint =
	| { type: "M"; x: number; y: number }
	| { type: "L"; x: number; y: number }
	| { type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number };

function parseSinePath(pathStr: string): PathPoint[] {
	const points: PathPoint[] = [];
	const commands = pathStr.match(/[MCL]\s*[\d\s.\-,]+/g);
	if (!commands) return points;

	for (const command of commands) {
		const type = command.charAt(0);
		const coords = command
			.slice(1)
			.trim()
			.split(/[\s,]+/)
			.map(Number);

		if (type === "M") {
			points.push({ type: "M", x: coords[0], y: coords[1] });
		} else if (type === "C") {
			if (coords.length >= 6 && coords.length % 6 === 0) {
				for (let i = 0; i < coords.length; i += 6) {
					points.push({
						x1: coords[i],
						y1: coords[i + 1],
						x2: coords[i + 2],
						y2: coords[i + 3],
						x: coords[i + 4],
						y: coords[i + 5],
						type: "C",
					});
				}
			}
		} else if (type === "L") {
			points.push({ type: "L", x: coords[0], y: coords[1] });
		}
	}
	return points;
}

const SINE_POINTS = parseSinePath(SINE_PATH);

function getInterpolatedWavePath(progress: number): string {
	const referenceY = 27.395;
	if (SINE_POINTS.length === 0) return progress < 0.5 ? LINE_PATH : SINE_PATH;
	if (progress <= 0.001) return LINE_PATH;
	if (progress >= 0.999) return SINE_PATH;

	const t = progress;
	let d = "";
	for (const p of SINE_POINTS) {
		if (p.type === "M") {
			d += `M ${p.x} ${referenceY + (p.y - referenceY) * t} `;
		} else if (p.type === "C") {
			const y1 = referenceY + (p.y1 - referenceY) * t;
			const y2 = referenceY + (p.y2 - referenceY) * t;
			const y = referenceY + (p.y - referenceY) * t;
			d += `C ${p.x1} ${y1} ${p.x2} ${y2} ${p.x} ${y} `;
		} else if (p.type === "L") {
			d += `L ${p.x} ${p.y} `;
		}
	}
	return d.trim();
}

/* ---------- exported state ---------- */
export type GradientEditorState = {
	points: { id: string; x: number; y: number; color: string }[];
	mainX: number;
	mainY: number;
	mainColor: string;
	brightness: number;
	angle: number;
	harmonyType: HarmonyType;
};

type GradientEditorProps = {
	onChange?: (state: GradientEditorState) => void;
};

export default function GradientEditor({ onChange }: GradientEditorProps) {
	const [mainAngle, setMainAngle] = useState(-35);
	const [mainRadius, setMainRadius] = useState(20);
	const idCounter = useRef(1);
	const [orbitPoints, setOrbitPoints] = useState<{ id: string }[]>(() => [
		{ id: `o${idCounter.current++}` },
		{ id: `o${idCounter.current++}` },
	]);
	const [harmonyType, setHarmonyType] = useState<HarmonyType>("splitComplementary");
	const [brightness, setBrightness] = useState(55);
	const [angle, setAngle] = useState(135);

	const canvasRef = useRef<HTMLDivElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const draggingMain = useRef(false);
	const mountedRef = useRef(false);
	const dragCleanup = useRef<(() => void) | null>(null);

	useEffect(() => {
		return () => {
			dragCleanup.current?.();
			dragCleanup.current = null;
		};
	}, []);

	const totalColors = 1 + orbitPoints.length;

	/* ---------- derived visuals ---------- */
	const mainX = 50 + mainRadius * Math.cos((mainAngle * Math.PI) / 180);
	const mainY = 50 + mainRadius * Math.sin((mainAngle * Math.PI) / 180);
	const mainColor = colorFromPolar(mainAngle, mainRadius);

	const allPoints = useMemo(() => {
		const secondaries = computeSecondaryPositions(
			mainAngle,
			mainRadius,
			orbitPoints,
			harmonyType,
		).map((p) => ({ ...p, size: 20 }));

		return [{ id: MAIN_ID, x: mainX, y: mainY, color: mainColor, size: 64 }, ...secondaries];
	}, [mainX, mainY, mainColor, orbitPoints, mainAngle, mainRadius, harmonyType]);

	/* ---------- emit state ---------- */
	const onChangeRef = useRef(onChange);
	useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	useEffect(() => {
		const cb = onChangeRef.current;
		if (!cb) return;
		if (!mountedRef.current) {
			mountedRef.current = true;
			return;
		}

		cb({
			points: allPoints.map((p) => ({ id: p.id, x: p.x, y: p.y, color: p.color })),
			mainX,
			mainY,
			mainColor,
			brightness,
			harmonyType,
			angle,
		});
	}, [allPoints, mainX, mainY, mainColor, brightness, harmonyType, angle]);

	/* ---------- main point drag ---------- */
	const updateMainFromPointer = useCallback((clientX: number, clientY: number) => {
		const el = canvasRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const dx = clientX - cx;
		const dy = clientY - cy;
		const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
		const radius = clamp((Math.hypot(dx, dy) / (rect.width / 2)) * 50, 0, MAIN_MAX_RADIUS);

		setMainAngle(angle);
		setMainRadius(radius);
	}, []);

	const onMainPointerDown = (e: ReactPointerEvent) => {
		e.stopPropagation();
		draggingMain.current = true;
		dragCleanup.current?.();
		const onUp = () => {
			draggingMain.current = false;
			window.removeEventListener("pointermove", onMainPointerMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			dragCleanup.current = null;
		};
		dragCleanup.current = onUp;
		window.addEventListener("pointermove", onMainPointerMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	};

	const onMainPointerMove = useCallback(
		(e: PointerEvent) => {
			if (!draggingMain.current) return;
			updateMainFromPointer(e.clientX, e.clientY);
		},
		[updateMainFromPointer],
	);

	/* ---------- add / remove / harmony ---------- */
	const addPoint = () => {
		if (totalColors >= MAX_COLORS) return;
		const id = `o${idCounter.current++}`;
		setOrbitPoints((prev) => [...prev, { id }]);
	};

	const removePoint = () => {
		if (totalColors <= 1) return;
		setOrbitPoints((prev) => prev.slice(0, -1));
	};

	const eligibleHarmonies = getEligibleHarmonies(orbitPoints.length);

	const cycleHarmony = () => {
		if (eligibleHarmonies.length <= 1) return;
		const idx = eligibleHarmonies.findIndex((h) => h.type === harmonyType);
		const next = eligibleHarmonies[(idx + 1) % eligibleHarmonies.length];
		setHarmonyType(next.type);
	};

	/* ---------- brightness slider ---------- */
	const setBrightnessFromClientX = (clientX: number) => {
		const el = trackRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const pct = clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
		setBrightness(pct);
	};

	/* visual clamp so thumb stays on the visible wave path */
	const WAVE_START_PCT = (51.373 / 420) * 100;
	const WAVE_END_PCT = (367.037 / 420) * 100;
	const clampedBrightness = clamp(brightness, WAVE_START_PCT, WAVE_END_PCT);

	const onSliderPointerDown = (e: ReactPointerEvent) => {
		setBrightnessFromClientX(e.clientX);
		dragCleanup.current?.();
		const move = (ev: PointerEvent) => setBrightnessFromClientX(ev.clientX);
		const onUp = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			dragCleanup.current = null;
		};
		dragCleanup.current = onUp;
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	};

	/* ---------- angle knob ---------- */
	// Angle knob
	const angleKnobRef = useRef<HTMLDivElement>(null);
	const angleKnobAngle = ((angle % 360) / 360) * 360;
	const setAngleFromClientPos = (clientX: number, clientY: number) => {
		const el = angleKnobRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		let a = (Math.atan2(-(clientY - cy), clientX - cx) * 180) / Math.PI;
		if (a < 0) a += 360;
		setAngle(Math.round(a));
	};
	const onAngleKnobPointerDown = (e: ReactPointerEvent) => {
		e.stopPropagation();
		setAngleFromClientPos(e.clientX, e.clientY);
		dragCleanup.current?.();
		const move = (ev: PointerEvent) => setAngleFromClientPos(ev.clientX, ev.clientY);
		const onUp = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			dragCleanup.current = null;
		};
		dragCleanup.current = onUp;
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	};

	// Preview brightness must match the per-channel multiplier in
	// applyBrightness so the wheel is WYSIWYG.
	const brightnessFilter = `brightness(${brightness / 100})`;

	const wavePath = useMemo(() => getInterpolatedWavePath(brightness / 100), [brightness]);

	/* ---------- keyboard handlers ---------- */
	const onMainKeyDown = useCallback((e: React.KeyboardEvent) => {
		const step = e.shiftKey ? 10 : 5;
		if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
			e.preventDefault();
			setMainAngle((a) => a - step);
		} else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
			e.preventDefault();
			setMainAngle((a) => a + step);
		}
	}, []);

	const onSliderKeyDown = useCallback((e: React.KeyboardEvent) => {
		const step = e.shiftKey ? 10 : 2;
		if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
			e.preventDefault();
			setBrightness((b) => clamp(b - step, 0, 100));
		} else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
			e.preventDefault();
			setBrightness((b) => clamp(b + step, 0, 100));
		}
	}, []);

	const onAngleKeyDown = useCallback((e: React.KeyboardEvent) => {
		const step = e.shiftKey ? 15 : 5;
		if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
			e.preventDefault();
			setAngle((a) => (a - step + 360) % 360);
		} else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
			e.preventDefault();
			setAngle((a) => (a + step) % 360);
		}
	}, []);

	return (
		<div className="w-[240px] max-w-full mx-auto rounded-[18px] p-[10px] box-border font-sans text-[#f2f2f2] select-none">
			{/* Color Wheel Canvas */}
			<div
				ref={canvasRef}
				className="relative w-full aspect-square rounded-[18px] overflow-hidden bg-[#141414]
                   [background-image:radial-gradient(#ffffff0c_1px,transparent_1px)] bg-[16px_16px]"
			>
				{/* Center marker */}
				<div className="absolute left-1/2 top-1/2 w-1 h-1 rounded-full bg-white/25 -translate-x-1/2 -translate-y-1/2 pointer-events-none" />

				{/* Points container with brightness filter */}
				<div
					className="absolute inset-0 transition-[filter] duration-75"
					style={{ filter: brightnessFilter }}
				>
					{/* Secondary points */}
					{allPoints
						.filter((p) => p.id !== MAIN_ID)
						.map((p) => (
							<div
								key={p.id}
								className="absolute w-5 h-5 rounded-full shadow-[0_3px_10px_rgba(0,0,0,0.35)] transition-all z-[2]"
								style={{
									left: `${p.x}%`,
									top: `${p.y}%`,
									transform: "translate(-50%, -50%)",
									background: p.color,
								}}
							/>
						))}

					{/* Main draggable point */}
					<div
						onPointerDown={onMainPointerDown}
						onKeyDown={onMainKeyDown}
						tabIndex={0}
						role="slider"
						aria-label="Color hue"
						aria-valuemin={0}
						aria-valuemax={360}
						aria-valuenow={Math.round(((mainAngle % 360) + 360) % 360)}
						className="absolute w-11 h-11 rounded-full cursor-grab shadow-[0_0_0_4px_#f5f5f5,0_4px_14px_rgba(0,0,0,0.35)] transition-shadow z-10 active:cursor-grabbing focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
						style={{
							left: `${mainX}%`,
							top: `${mainY}%`,
							transform: "translate(-50%, -50%)",
							background: mainColor,
						}}
					/>
				</div>

				{/* Controls on canvas */}
				<div className="absolute left-3.5 bottom-3 flex gap-3">
					<button
						type="button"
						onClick={addPoint}
						disabled={totalColors >= MAX_COLORS}
						className={`w-6 h-6 rounded-full flex items-center justify-center border-none bg-transparent transition-all text-white/80 hover:text-white ${
							totalColors >= MAX_COLORS
								? "opacity-40 cursor-not-allowed"
								: "hover:bg-white/10 cursor-pointer"
						}`}
						title="Add color"
					>
						<PlusIcon />
					</button>

					<button
						type="button"
						onClick={removePoint}
						disabled={totalColors <= 1}
						className={`w-6 h-6 rounded-full flex items-center justify-center border-none bg-transparent transition-all text-white/80 hover:text-white ${
							totalColors <= 1
								? "opacity-40 cursor-not-allowed"
								: "hover:bg-white/10 cursor-pointer"
						}`}
						title="Remove color"
					>
						<MinusIcon />
					</button>

					<button
						type="button"
						onClick={cycleHarmony}
						disabled={eligibleHarmonies.length <= 1}
						className={`w-6 h-6 rounded-full flex items-center justify-center border-none bg-transparent transition-all text-white/80 hover:text-white ${
							eligibleHarmonies.length <= 1
								? "opacity-40 cursor-not-allowed"
								: "hover:bg-white/10 cursor-pointer"
						}`}
						title="Cycle harmony"
					>
						<RingsIcon />
					</button>
				</div>
			</div>

			{/* Bottom controls: Brightness + Angle */}
			<div className="flex items-center gap-3.5 mt-3.5">
				{/* Brightness wavy slider. Its thumb/track are colored for the dark
				    canvas above, so it needs its own dark backing here too — this row
				    otherwise sits directly on the (theme-dependent) popover background,
				    where the light thumb disappears in light mode. */}
				<div
					ref={trackRef}
					onPointerDown={onSliderPointerDown}
					onKeyDown={onSliderKeyDown}
					tabIndex={0}
					role="slider"
					aria-label="Brightness"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(brightness)}
					className="relative flex-1 h-10 flex items-center cursor-pointer bg-[#141414] rounded-full focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
				>
					<svg
						width="100%"
						height="30"
						viewBox="0 -15 420 80"
						preserveAspectRatio="none"
						className="absolute left-0 right-0"
					>
						<path
							d={wavePath}
							fill="none"
							stroke="rgba(255,255,255,0.22)"
							strokeWidth="6"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>

					<div
						className="absolute w-3 h-[30px] rounded-[7px] bg-[#f5f5f5] shadow-[0_2px_8px_rgba(0,0,0,0.3)] transition-all"
						style={{
							left: `${clampedBrightness}%`,
							top: "50%",
							transform: "translate(-50%, -50%)",
						}}
					/>
				</div>

				{/* Angle knob */}
				<div
					ref={angleKnobRef}
					onPointerDown={onAngleKnobPointerDown}
					onKeyDown={onAngleKeyDown}
					tabIndex={0}
					role="slider"
					aria-label="Gradient angle"
					aria-valuemin={0}
					aria-valuemax={360}
					aria-valuenow={angle}
					className="relative w-[42px] h-[42px] rounded-full bg-[radial-gradient(circle_at_35%_30%,#2b2b2b,#0c0c0c)] shadow-[0_3px_10px_rgba(0,0,0,0.4)] cursor-grab flex-shrink-0 active:cursor-grabbing focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
					title="Gradient angle"
				>
					<div className="absolute inset-0" style={{ transform: `rotate(${angleKnobAngle}deg)` }}>
						<div className="absolute top-[5px] left-1/2 w-[2px] h-[9px] bg-[#e8e8e8] translate-x-[-50%] rounded" />
					</div>
				</div>
			</div>
		</div>
	);
}
