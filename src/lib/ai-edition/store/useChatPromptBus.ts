import { create } from "zustand";

// Tiny decoupled bus so non-chat UI (e.g. the timeline's Auto-enhance "AI"
// option) can hand a prompt to the chat panel without reaching into its local
// state. The chat composer (ChatStripPanel) subscribes, prefills + auto-sends
// the pending prompt through its normal send() path (so sessions, checkpoints
// and rewind all keep working), then consume()s it.

interface ChatPromptBusState {
	/** A prompt waiting to be picked up + auto-sent by the chat panel, or null. */
	pending: string | null;
	/** Queue a prompt for the chat panel to send. */
	submit: (text: string) => void;
	/** Called by the chat panel once it has taken ownership of `pending`. */
	consume: () => void;
}

export const useChatPromptBus = create<ChatPromptBusState>((set) => ({
	pending: null,
	submit: (text) => set({ pending: text }),
	consume: () => set({ pending: null }),
}));
