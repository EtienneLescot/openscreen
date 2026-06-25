import { Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { nativeBridgeClient } from "@/native/client";
import type { AiEditionChatMessage } from "@/native/contracts";

export function ChatPanel() {
	const projectId = useProjectStore((s) => s.projectId);
	const [messages, setMessages] = useState<AiEditionChatMessage[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const scrollRef = useRef<HTMLDivElement | null>(null);

	const loadHistory = useCallback(async () => {
		if (!projectId) return;
		try {
			const history = await nativeBridgeClient.aiEdition.chatHistory(projectId);
			setMessages(history);
		} catch {
			// ponytail: silent
		}
	}, [projectId]);

	useEffect(() => {
		void loadHistory();
	}, [loadHistory]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
	}, []);

	const handleSend = useCallback(async () => {
		if (!projectId || !input.trim() || busy) return;
		const text = input.trim();
		setInput("");
		setBusy(true);
		try {
			const result = await nativeBridgeClient.aiEdition.chatRun(projectId, text);
			if (result.success && result.assistantMessage) {
				setMessages((prev) => [...prev, result.assistantMessage!]);
			} else {
				toast.error(result.error ?? "Chat failed");
			}
		} catch (err) {
			toast.error("Chat failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	}, [projectId, input, busy]);

	return (
		<aside className="w-full h-full flex flex-col overflow-hidden">
			<header className="px-4 py-3 border-b border-white/[0.06]">
				<h2 className="text-[10px] font-semibold tracking-[0.1em] uppercase text-white/40">
					AI Chat
				</h2>
			</header>
			<div
				ref={scrollRef}
				className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-2 custom-scrollbar"
			>
				{messages.length === 0 && (
					<div className="flex flex-col items-center gap-3 text-center py-6">
						<div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-white/[0.05] ring-1 ring-white/10">
							<Send className="h-5 w-5 text-white/40" />
						</div>
						<p className="text-[12px] text-white/45 max-w-[220px] leading-relaxed">
							Ask the AI to edit your video — e.g. "remove silences" or "cut the first 10 seconds".
						</p>
					</div>
				)}
				{messages.map((msg) => (
					<div
						key={msg.id}
						className={`max-w-[90%] px-3 py-2 rounded-xl text-[12.5px] leading-relaxed ${
							msg.role === "user"
								? "self-end bg-[#34B27B] text-white rounded-br-sm"
								: "self-start bg-white/[0.06] text-white/90 rounded-bl-sm"
						}`}
					>
						{msg.content}
					</div>
				))}
			</div>
			<div className="px-3 py-2 border-t border-white/[0.06] flex items-center gap-1.5">
				<input
					className="flex-1 px-3 py-2 rounded-md bg-white/[0.04] border border-white/[0.06] text-[12px] text-white/85 placeholder:text-white/30 outline-none focus:border-[#34B27B]/50 focus:bg-white/[0.06]"
					placeholder="Type a message…"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void handleSend();
						}
					}}
					disabled={busy || !projectId}
				/>
				<button
					type="button"
					className="flex items-center justify-center w-8 h-8 rounded-md bg-[#34B27B] hover:bg-[#2d9e6c] active:bg-[#27885c] text-white transition-colors disabled:opacity-40"
					onClick={handleSend}
					disabled={busy || !input.trim() || !projectId}
					title="Send"
				>
					<Send size={14} />
				</button>
			</div>
		</aside>
	);
}
