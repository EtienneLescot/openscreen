import { create } from "zustand";

// Tiny decoupled bus so the preview can draw the caption guide while the Captions
// pane is open, without the pane reaching across the layout to the canvas or the
// canvas importing the inspector.
//
// Same shape and same reason as `useChatPromptBus`. The pane owns the signal because
// it is the thing that knows it is open: `FacetBody` mounts exactly one pane at a
// time, so mounting IS "the user is editing captions" and unmounting is the end of it.

interface CaptionGuideBusState {
	/** True while the Captions pane is mounted. Nothing else may set it. */
	open: boolean;
	setOpen: (open: boolean) => void;
}

export const useCaptionGuideBus = create<CaptionGuideBusState>((set) => ({
	open: false,
	setOpen: (open) => set({ open }),
}));
