import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

// Open/close state for the AI provider settings dialog, lifted out of the chat panel.
//
// It used to be a `useState` inside `LeftPanel`'s `ChatStripPanel`, which mounts only in Edit
// mode with the chat panel expanded. Nothing outside that component could open the dialog, so
// the app menu had no way to offer it (issue #420). The state lives here for the same reason
// `ShortcutsContext` owns `isConfigOpen`: the surfaces that open a dialog and the place it is
// mounted are on different branches of the tree.
//
// Deliberately just the three members. Everything the dialog itself needs — the provider
// snapshot, the credentials, the save — it reads over the native bridge on open.
interface ProviderSettingsContextValue {
	isProviderSettingsOpen: boolean;
	openProviderSettings: () => void;
	closeProviderSettings: () => void;
}

const ProviderSettingsContext = createContext<ProviderSettingsContextValue | null>(null);

export function useProviderSettings(): ProviderSettingsContextValue {
	const ctx = useContext(ProviderSettingsContext);
	if (!ctx) throw new Error("useProviderSettings must be used within <ProviderSettingsProvider>");
	return ctx;
}

export function ProviderSettingsProvider({ children }: { children: ReactNode }) {
	const [isProviderSettingsOpen, setIsProviderSettingsOpen] = useState(false);

	const openProviderSettings = useCallback(() => setIsProviderSettingsOpen(true), []);
	const closeProviderSettings = useCallback(() => setIsProviderSettingsOpen(false), []);

	const value = useMemo<ProviderSettingsContextValue>(
		() => ({ isProviderSettingsOpen, openProviderSettings, closeProviderSettings }),
		[isProviderSettingsOpen, openProviderSettings, closeProviderSettings],
	);

	return (
		<ProviderSettingsContext.Provider value={value}>{children}</ProviderSettingsContext.Provider>
	);
}
