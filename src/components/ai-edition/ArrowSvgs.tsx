// Inline SVG arrows for 8 directions (pure paths, not icon fonts, so the native
// compositor replicates them identically — cf. `arrow_segments_viewbox` in regions.rs,
// which carries the same numbers and is pinned to them by a test).
//
// Les barbes des quatre DIAGONALES ont été allongées pour égaler celles des cardinales
// (21,2 unités de viewBox contre 15,8 auparavant). À l'origine, une flèche diagonale avait
// une tête ~25 % plus petite que sa voisine horizontale, ce qui se lisait comme une
// déformation — d'autant plus qu'avec un trait épais la tête se fondait dans la hampe.

import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";

type ArrowDirection = NonNullable<AxcutAnnotationRegion["figureData"]>["arrowDirection"];

interface ArrowSvgProps {
	color: string;
	strokeWidth: number;
	className?: string;
}

export function ArrowUp({ color, strokeWidth, className }: ArrowSvgProps) {
	return (
		<svg viewBox="0 0 100 100" className={className} style={{ width: "100%", height: "100%" }}>
			<defs>
				<filter id="arrow-shadow">
					<feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.3" />
				</filter>
			</defs>
			<path
				d="M 50 20 L 50 80 M 50 20 L 35 35 M 50 20 L 65 35"
				stroke={color}
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
				fill="none"
				filter="url(#arrow-shadow)"
			/>
		</svg>
	);
}

export function ArrowDown({ color, strokeWidth, className }: ArrowSvgProps) {
	return (
		<svg viewBox="0 0 100 100" className={className} style={{ width: "100%", height: "100%" }}>
			<defs>
				<filter id="arrow-shadow">
					<feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.3" />
				</filter>
			</defs>
			<path
				d="M 50 20 L 50 80 M 50 80 L 35 65 M 50 80 L 65 65"
				stroke={color}
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
				fill="none"
				filter="url(#arrow-shadow)"
			/>
		</svg>
	);
}

export function ArrowLeft({ color, strokeWidth, className }: ArrowSvgProps) {
	return (
		<svg viewBox="0 0 100 100" className={className} style={{ width: "100%", height: "100%" }}>
			<defs>
				<filter id="arrow-shadow">
					<feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.3" />
				</filter>
			</defs>
			<path
				d="M 80 50 L 20 50 M 20 50 L 35 35 M 20 50 L 35 65"
				stroke={color}
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
				fill="none"
				filter="url(#arrow-shadow)"
			/>
		</svg>
	);
}

export function ArrowRight({ color, strokeWidth, className }: ArrowSvgProps) {
	return (
		<svg viewBox="0 0 100 100" className={className} style={{ width: "100%", height: "100%" }}>
			<defs>
				<filter id="arrow-shadow">
					<feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.3" />
				</filter>
			</defs>
			<path
				d="M 20 50 L 80 50 M 80 50 L 65 35 M 80 50 L 65 65"
				stroke={color}
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
				fill="none"
				filter="url(#arrow-shadow)"
			/>
		</svg>
	);
}

export function ArrowUpRight({ color, strokeWidth, className }: ArrowSvgProps) {
	return (
		<svg viewBox="0 0 100 100" className={className} style={{ width: "100%", height: "100%" }}>
			<defs>
				<filter id="arrow-shadow">
					<feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.3" />
				</filter>
			</defs>
			<path
				d="M 25 75 L 75 25 M 75 25 L 54.9 31.7 M 75 25 L 68.3 45.1"
				stroke={color}
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
				fill="none"
				filter="url(#arrow-shadow)"
			/>
		</svg>
	);
}

export function ArrowUpLeft({ color, strokeWidth, className }: ArrowSvgProps) {
	return (
		<svg viewBox="0 0 100 100" className={className} style={{ width: "100%", height: "100%" }}>
			<defs>
				<filter id="arrow-shadow">
					<feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.3" />
				</filter>
			</defs>
			<path
				d="M 75 75 L 25 25 M 25 25 L 45.1 31.7 M 25 25 L 31.7 45.1"
				stroke={color}
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
				fill="none"
				filter="url(#arrow-shadow)"
			/>
		</svg>
	);
}

export function ArrowDownRight({ color, strokeWidth, className }: ArrowSvgProps) {
	return (
		<svg viewBox="0 0 100 100" className={className} style={{ width: "100%", height: "100%" }}>
			<defs>
				<filter id="arrow-shadow">
					<feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.3" />
				</filter>
			</defs>
			<path
				d="M 25 25 L 75 75 M 75 75 L 68.3 54.9 M 75 75 L 54.9 68.3"
				stroke={color}
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
				fill="none"
				filter="url(#arrow-shadow)"
			/>
		</svg>
	);
}

export function ArrowDownLeft({ color, strokeWidth, className }: ArrowSvgProps) {
	return (
		<svg viewBox="0 0 100 100" className={className} style={{ width: "100%", height: "100%" }}>
			<defs>
				<filter id="arrow-shadow">
					<feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.3" />
				</filter>
			</defs>
			<path
				d="M 75 25 L 25 75 M 25 75 L 31.7 54.9 M 25 75 L 45.1 68.3"
				stroke={color}
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
				fill="none"
				filter="url(#arrow-shadow)"
			/>
		</svg>
	);
}

export function getArrowComponent(direction: ArrowDirection) {
	switch (direction) {
		case "up":
			return ArrowUp;
		case "down":
			return ArrowDown;
		case "left":
			return ArrowLeft;
		case "right":
			return ArrowRight;
		case "up-right":
			return ArrowUpRight;
		case "up-left":
			return ArrowUpLeft;
		case "down-right":
			return ArrowDownRight;
		case "down-left":
			return ArrowDownLeft;
		default:
			return ArrowRight;
	}
}
