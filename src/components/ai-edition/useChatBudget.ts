import { useEffect, useMemo, useRef, useState } from "react";
import { nativeBridgeClient } from "@/native/client";
import { type ChatBudget, computeBudget, type RenderableChatMessage } from "./chatBudget";

interface NativeBudgetState {
	sessionKey: string;
	budget: ChatBudget;
}

export function useChatBudget(options: {
	projectId: string | null;
	sessionId: string | null;
	messages: readonly RenderableChatMessage[];
}): ChatBudget {
	const { projectId, sessionId, messages } = options;
	const fallback = useMemo(() => computeBudget(messages), [messages]);
	const sessionKey = projectId && sessionId ? `${projectId}\0${sessionId}` : null;
	const [nativeState, setNativeState] = useState<NativeBudgetState | null>(null);
	const requestIdRef = useRef(0);

	useEffect(() => {
		const requestId = ++requestIdRef.current;
		if (!projectId || !sessionId || !sessionKey) {
			setNativeState(null);
			return;
		}

		void nativeBridgeClient.aiEdition
			.chatBudget(projectId, sessionId)
			.then((budget) => {
				if (requestIdRef.current !== requestId) return;
				setNativeState({ sessionKey, budget: budget ?? fallback });
			})
			.catch(() => {
				if (requestIdRef.current !== requestId) return;
				setNativeState({ sessionKey, budget: fallback });
			});

		return () => {
			if (requestIdRef.current === requestId) requestIdRef.current++;
		};
	}, [projectId, sessionId, sessionKey, fallback]);

	return nativeState?.sessionKey === sessionKey ? nativeState.budget : fallback;
}
