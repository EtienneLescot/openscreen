// @vitest-environment jsdom
// `isModalOpen` is only as good as the attribute it looks for, and that attribute lives in two
// components rather than in this module. So the contract is asserted against the real ones:
// `ModalShell` (every modal in the ai-edition tree — Export, Open project, New project, Edit
// clip, the unsaved-changes prompt, the AI providers dialog) and `ui/dialog`'s Radix content
// (the shortcuts dialog and the drop-error dialog). Radix 1.1.15 emits `role="dialog"` and no
// `aria-modal` of its own, which is why `dialog.tsx` states it.

import "@testing-library/jest-dom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

import { ModalShell } from "@/components/ai-edition/Modals";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { isModalOpen } from "./modalGuard";

afterEach(cleanup);

const noop = () => {
	/* nothing to close in these tests */
};

describe("isModalOpen", () => {
	it("is false with nothing on screen", () => {
		render(<div>the editor</div>);

		expect(isModalOpen()).toBe(false);
	});

	it("is true while a ModalShell is open, false once it closes", () => {
		const { rerender } = render(
			<ModalShell open onClose={noop} title="Export">
				<button type="button">Start export</button>
			</ModalShell>,
		);
		expect(isModalOpen()).toBe(true);

		rerender(
			<ModalShell open={false} onClose={noop} title="Export">
				<button type="button">Start export</button>
			</ModalShell>,
		);
		expect(isModalOpen()).toBe(false);
	});

	it("is true while a ui/dialog content is open", () => {
		render(
			<Dialog open>
				<DialogContent aria-label="Keyboard shortcuts">
					<button type="button">Reset</button>
				</DialogContent>
			</Dialog>,
		);

		expect(isModalOpen()).toBe(true);
	});
});
