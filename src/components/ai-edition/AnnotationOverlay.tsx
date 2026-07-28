// Chrome d'édition d'une annotation : cadre de sélection, glissement, poignées de
// redimensionnement. Les PIXELS de l'annotation — texte, image, flèche, flou — sont peints par le
// compositeur natif, aperçu compris.
//
// Ce fichier était le port du `AnnotationOverlay` de l'éditeur v2 : il rendait les quatre types en
// DOM et portait la saisie du tracé libre, soit ~400 lignes qui ne s'exécutaient plus depuis que
// le natif peint l'aperçu. Les garder ne coûtait pas seulement de la lecture : elles décrivaient un
// rendu concurrent, sur une autre horloge, ce qui avait déjà produit le bug des annotations
// affichées en double (une copie collée au curseur, un fantôme resté en place jusqu'au
// relâchement). Le détail reste dans `git log`.

import { useEffect, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import { cn } from "@/lib/utils";

interface AnnotationOverlayProps {
	annotation: AxcutAnnotationRegion;
	isSelected: boolean;
	containerWidth: number;
	containerHeight: number;
	onPositionChange: (id: string, position: { x: number; y: number }) => void;
	onSizeChange: (id: string, size: { width: number; height: number }) => void;
	/** Écriture disque, appelée une fois en fin de geste — le drag/resize ne fait que du live. */
	onCommit?: () => void;
	onClick: (id: string) => void;
	zIndex: number;
	isSelectedBoost: boolean;
}

export function AnnotationOverlay({
	annotation,
	isSelected,
	containerWidth,
	containerHeight,
	onPositionChange,
	onSizeChange,
	onCommit,
	onClick,
	zIndex,
	isSelectedBoost,
}: AnnotationOverlayProps) {
	const committedX = (annotation.position.x / 100) * containerWidth;
	const committedY = (annotation.position.y / 100) * containerHeight;
	const committedWidth = (annotation.size.width / 100) * containerWidth;
	const committedHeight = (annotation.size.height / 100) * containerHeight;
	const blurShape = annotation.type === "blur" ? (annotation.blurData?.shape ?? "rectangle") : null;
	const isDraggingRef = useRef(false);
	const [liveRect, setLiveRect] = useState({
		x: committedX,
		y: committedY,
		width: committedWidth,
		height: committedHeight,
	});

	useEffect(() => {
		setLiveRect({
			x: committedX,
			y: committedY,
			width: committedWidth,
			height: committedHeight,
		});
	}, [committedHeight, committedWidth, committedX, committedY]);

	const { x, y, width, height } = liveRect;

	return (
		<Rnd
			position={{ x, y }}
			size={{ width, height }}
			onDragStart={() => {
				isDraggingRef.current = true;
			}}
			onDrag={(_e, d) => {
				setLiveRect((prev) => ({ ...prev, x: d.x, y: d.y }));
				// Pousse la position PENDANT le geste : c'est le natif qui peint, il doit donc suivre
				// le curseur. `onPositionChange` ne met à jour qu'en mémoire ; l'écriture disque se
				// fait une seule fois, au relâchement (`onCommit`).
				onPositionChange(annotation.id, {
					x: (d.x / containerWidth) * 100,
					y: (d.y / containerHeight) * 100,
				});
			}}
			onDragStop={(_e, d) => {
				setLiveRect((prev) => ({ ...prev, x: d.x, y: d.y }));
				const xPercent = (d.x / containerWidth) * 100;
				const yPercent = (d.y / containerHeight) * 100;
				onPositionChange(annotation.id, { x: xPercent, y: yPercent });
				onCommit?.();
				setTimeout(() => {
					isDraggingRef.current = false;
				}, 100);
			}}
			onResize={(_e, _direction, ref, _delta, position) => {
				setLiveRect({
					x: position.x,
					y: position.y,
					width: ref.offsetWidth,
					height: ref.offsetHeight,
				});
				// Même raison que le drag : le natif doit suivre la poignée en direct.
				onPositionChange(annotation.id, {
					x: (position.x / containerWidth) * 100,
					y: (position.y / containerHeight) * 100,
				});
				onSizeChange(annotation.id, {
					width: (ref.offsetWidth / containerWidth) * 100,
					height: (ref.offsetHeight / containerHeight) * 100,
				});
			}}
			onResizeStop={(_e, _direction, ref, _delta, position) => {
				setLiveRect({
					x: position.x,
					y: position.y,
					width: ref.offsetWidth,
					height: ref.offsetHeight,
				});
				const xPercent = (position.x / containerWidth) * 100;
				const yPercent = (position.y / containerHeight) * 100;
				const widthPercent = (ref.offsetWidth / containerWidth) * 100;
				const heightPercent = (ref.offsetHeight / containerHeight) * 100;
				onPositionChange(annotation.id, { x: xPercent, y: yPercent });
				onSizeChange(annotation.id, { width: widthPercent, height: heightPercent });
				onCommit?.();
			}}
			onClick={() => {
				if (isDraggingRef.current) return;
				onClick(annotation.id);
			}}
			bounds="parent"
			className={cn(
				"cursor-move",
				isSelected &&
					annotation.type !== "blur" &&
					"ring-2 ring-[#34B27B] ring-offset-2 ring-offset-transparent",
			)}
			style={{
				zIndex: isSelectedBoost ? zIndex + 1000 : zIndex,
				pointerEvents: isSelected ? "auto" : "none",
				border:
					isSelected && annotation.type !== "blur" ? "2px solid rgba(52, 178, 123, 0.8)" : "none",
				backgroundColor:
					isSelected && annotation.type !== "blur" ? "rgba(52, 178, 123, 0.1)" : "transparent",
				boxShadow:
					isSelected && annotation.type !== "blur" ? "0 0 0 1px rgba(52, 178, 123, 0.35)" : "none",
			}}
			// Un flou en tracé libre se déplace et se redimensionne comme les autres : ce qui le
			// bloquait, c'était la zone de saisie du tracé qui capturait le pointeur — et elle est
			// partie avec l'outil.
			enableResizing={isSelected}
			disableDragging={!isSelected}
			resizeHandleStyles={{
				topLeft: {
					width: "12px",
					height: "12px",
					backgroundColor: isSelected ? "white" : "transparent",
					border: isSelected ? "2px solid #34B27B" : "none",
					borderRadius: "50%",
					left: "-6px",
					top: "-6px",
					cursor: "nwse-resize",
				},
				topRight: {
					width: "12px",
					height: "12px",
					backgroundColor: isSelected ? "white" : "transparent",
					border: isSelected ? "2px solid #34B27B" : "none",
					borderRadius: "50%",
					right: "-6px",
					top: "-6px",
					cursor: "nesw-resize",
				},
				bottomLeft: {
					width: "12px",
					height: "12px",
					backgroundColor: isSelected ? "white" : "transparent",
					border: isSelected ? "2px solid #34B27B" : "none",
					borderRadius: "50%",
					left: "-6px",
					bottom: "-6px",
					cursor: "nesw-resize",
				},
				bottomRight: {
					width: "12px",
					height: "12px",
					backgroundColor: isSelected ? "white" : "transparent",
					border: isSelected ? "2px solid #34B27B" : "none",
					borderRadius: "50%",
					right: "-6px",
					bottom: "-6px",
					cursor: "nwse-resize",
				},
			}}
		>
			<div
				className={cn(
					"w-full h-full relative",
					annotation.type !== "blur" && "rounded-lg",
					isSelected && annotation.type !== "blur" && "shadow-lg",
				)}
			>
				{/* Le cadre d'un flou sélectionné, à la forme du masque. Les autres types portent le
				    leur sur le `Rnd` lui-même ; un flou n'en a pas, pour ne pas encadrer la zone qu'il
				    est censé cacher — sans ce liseré il n'aurait AUCUN retour de sélection. */}
				{isSelected && annotation.type === "blur" ? (
					<div
						className="absolute inset-0 pointer-events-none border-2 border-[#34B27B]/80"
						style={{ borderRadius: blurShape === "oval" ? "50%" : "8px" }}
					/>
				) : null}
			</div>
		</Rnd>
	);
}
