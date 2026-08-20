import { createContext, type ReactNode, useContext, useMemo, useRef, useState } from "react";

// Which of the editor chrome's own dialogs is open, lifted out of the component that used to
// own it.
//
// The AI provider dialog used to be a `useState` inside `LeftPanel`'s `ChatStripPanel`, which
// mounts only in Edit mode with the chat panel expanded. Nothing outside that component could
// open the dialog, so the app menu had no way to offer it (issue #420). The surfaces that open
// a dialog and the place it is mounted are on different branches of the tree.
//
// One `section` rather than a boolean per dialog. The settings unification this is the first
// step of ends in a single dialog with a sidebar (General / Shortcuts / AI / Devices / About);
// each section it gains is then a member of this union, not another context, another provider
// wrapped around App.tsx's editor branch and another near-identical file.
//
// Split in two on purpose. The section changes on every open and close, the actions never do.
// `NewEditorShell` owns the timeline, the preview and the transport, and only ever needs to
// *open* a dialog — subscribing it to the section would re-render the whole editor twice per
// dialog interaction, so it takes the actions alone. `isDialogOpen` serves the readers that
// are event handlers rather than renders: it answers from a ref, which is what lets it sit in
// a value whose identity never changes.
export type EditorDialogSection = "providers";

interface EditorDialogsActions {
	openDialog: (section: EditorDialogSection) => void;
	closeDialog: () => void;
	/** A live answer without a subscription — for event handlers, never for rendering. */
	isDialogOpen: () => boolean;
}

// `undefined` is the "no provider above me" marker, so that `null` stays free to mean the real
// state: mounted, nothing open.
const SectionContext = createContext<EditorDialogSection | null | undefined>(undefined);
const ActionsContext = createContext<EditorDialogsActions | null>(null);

export function useEditorDialogSection(): EditorDialogSection | null {
	const section = useContext(SectionContext);
	if (section === undefined) {
		throw new Error("useEditorDialogSection must be used within <EditorDialogsProvider>");
	}
	return section;
}

export function useEditorDialogActions(): EditorDialogsActions {
	const ctx = useContext(ActionsContext);
	if (!ctx) throw new Error("useEditorDialogActions must be used within <EditorDialogsProvider>");
	return ctx;
}

export function EditorDialogsProvider({ children }: { children: ReactNode }) {
	const [section, setSection] = useState<EditorDialogSection | null>(null);
	// Mirrored so `isDialogOpen` can read the current section without the actions value having
	// to depend on it. Written during render rather than from an effect: a keystroke arriving
	// between the state change and the effect would otherwise get the previous answer.
	const sectionRef = useRef(section);
	sectionRef.current = section;

	const actions = useMemo<EditorDialogsActions>(
		() => ({
			openDialog: (next) => setSection(next),
			closeDialog: () => setSection(null),
			isDialogOpen: () => sectionRef.current !== null,
		}),
		[],
	);

	return (
		<ActionsContext.Provider value={actions}>
			<SectionContext.Provider value={section}>{children}</SectionContext.Provider>
		</ActionsContext.Provider>
	);
}
