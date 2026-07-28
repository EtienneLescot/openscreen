import * as Popover from "@radix-ui/react-popover";
import Colorful from "@uiw/react-color-colorful";
import { useEffect, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";

/**
 * Un champ de couleur : une pastille qui ouvre le sélecteur.
 *
 * Les présélections vivent DANS le sélecteur, pas alignées à côté du champ. Une rangée de pastilles
 * posée dans le panneau donne à croire que le choix se limite à ce que quelqu'un d'autre a décidé,
 * elle mange la largeur d'une ligne de réglage, et chaque fonctionnalité finit par se recopier sa
 * propre rangée. Ici il n'y a qu'un contrôle à réutiliser : roue, valeur hexadécimale et
 * présélections, les mêmes partout.
 *
 * Le sélecteur est rendu dans un portail, donc il déborde librement du panneau — celui-ci découpe
 * son contenu (coins arrondis + flou), un popover en flux y serait tronqué.
 */

/** Présélections communes : quatre neutres puis les teintes vives, deux rangées de huit. */
export const COLOR_PRESETS: readonly string[] = [
	"#ffffff",
	"#bcc0c6",
	"#6b7280",
	"#16171d",
	"#0f172a",
	"#10b981",
	"#22c55e",
	"#3b82f6",
	"#0ea5e9",
	"#6366f1",
	"#8b5cf6",
	"#ec4899",
	"#f43f5e",
	"#ef4444",
	"#f97316",
	"#f59e0b",
];

const HEX_COMPLETE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

/** Ce que la roue sait afficher : tout le reste (dont `"transparent"`) retombe sur du noir. */
function wheelColor(value: string): string {
	return HEX_COMPLETE.test(value) ? value : "#000000";
}

interface ColorFieldProps {
	value: string;
	/** Appelé en continu pendant le glissement — au site d'appel de regrouper les écritures. */
	onChange: (next: string) => void;
	/** Fin de geste : fermeture du sélecteur, ou clic sur une présélection. */
	onCommit?: () => void;
	/** Nom du réglage (« Couleur du texte »…), pour le lecteur d'écran. */
	label: string;
	disabled?: boolean;
	presets?: readonly string[];
}

export function ColorField({
	value,
	onChange,
	onCommit,
	label,
	disabled,
	presets = COLOR_PRESETS,
}: ColorFieldProps) {
	const ts = useScopedT("settings");
	const te = useScopedT("editor");
	const [open, setOpen] = useState(false);
	const [hexDraft, setHexDraft] = useState(value);
	// La valeur peut changer sous nos pieds (présélection, annulation, autre annotation
	// sélectionnée) : le brouillon suit, sauf pendant que l'utilisateur tape dessus.
	useEffect(() => {
		setHexDraft(value);
	}, [value]);

	const pick = (next: string) => {
		onChange(next);
		onCommit?.();
	};

	return (
		<Popover.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				// Une seule écriture disque par ouverture : la roue émet en continu, et committer à
				// chaque événement rendait le contrôle inutilisable.
				if (!next) onCommit?.();
			}}
		>
			<Popover.Trigger asChild>
				<button
					type="button"
					aria-label={label}
					disabled={disabled}
					style={{
						width: 40,
						height: 28,
						padding: 3,
						borderRadius: 8,
						border: "1px solid var(--border-hi)",
						background: "var(--surface)",
						cursor: disabled ? "default" : "pointer",
						opacity: disabled ? 0.5 : 1,
					}}
				>
					<span
						style={{
							display: "block",
							width: "100%",
							height: "100%",
							borderRadius: 5,
							background: value,
							boxShadow: "inset 0 0 0 1px rgb(0 0 0 / 0.25)",
						}}
					/>
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					side="left"
					align="start"
					sideOffset={10}
					collisionPadding={12}
					style={{
						zIndex: 60,
						width: 216,
						display: "flex",
						flexDirection: "column",
						gap: 10,
						padding: 12,
						borderRadius: 14,
						border: "1px solid var(--border)",
						background: "var(--surface-1)",
						boxShadow: "var(--elev-pop)",
						backdropFilter: "blur(18px)",
					}}
				>
					<Colorful
						color={wheelColor(value)}
						disableAlpha
						onChange={(next) => onChange(next.hex)}
						style={{ width: "100%", borderRadius: 10 }}
					/>
					<input
						type="text"
						aria-label={ts("annotation.colorWheel")}
						value={hexDraft}
						spellCheck={false}
						onChange={(e) => {
							// `#` implicite : on tape rarement le dièse, et l'exiger fait échouer une saisie
							// par ailleurs valide.
							const raw = e.target.value.trim();
							const normalised = raw !== "" && /^[0-9A-Fa-f]/.test(raw) ? `#${raw}` : raw;
							setHexDraft(normalised);
							if (HEX_COMPLETE.test(normalised)) onChange(normalised);
						}}
						onBlur={() => onCommit?.()}
						style={{
							height: 30,
							padding: "0 8px",
							borderRadius: 8,
							border: "1px solid var(--border)",
							background: "var(--surface)",
							color: "var(--fg)",
							font: "500 12px var(--font-mono, ui-monospace), monospace",
							textTransform: "lowercase",
						}}
					/>
					<div
						aria-label={ts("annotation.colorPalette")}
						style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 5 }}
					>
						{presets.map((preset) => (
							<button
								key={preset}
								type="button"
								title={preset}
								aria-label={te("inspector.setColor", { color: preset })}
								aria-pressed={value.toLowerCase() === preset.toLowerCase()}
								onClick={() => pick(preset)}
								style={{
									height: 18,
									borderRadius: 5,
									background: preset,
									border:
										value.toLowerCase() === preset.toLowerCase()
											? "2px solid var(--accent)"
											: "1px solid var(--border-hi)",
									cursor: "pointer",
								}}
							/>
						))}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
