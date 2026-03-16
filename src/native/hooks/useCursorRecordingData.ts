import { useEffect, useState } from "react";
import type { CursorRecordingData } from "@/native/contracts";
import { nativeBridgeClient } from "../client";

interface UseCursorRecordingDataResult {
	data: CursorRecordingData | null;
	loading: boolean;
	error: string | null;
}

export function useCursorRecordingData(videoPath: string | null): UseCursorRecordingDataResult {
	const [data, setData] = useState<CursorRecordingData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;

		async function loadCursorRecordingData() {
			if (!videoPath) {
				setData(null);
				setLoading(false);
				setError(null);
				return;
			}

			setLoading(true);
			setError(null);

			try {
				const nextData = await nativeBridgeClient.cursor.getRecordingData(videoPath);
				if (!cancelled) {
					setData(nextData);
				}
			} catch (nextError) {
				if (!cancelled) {
					setData(null);
					setError(
						nextError instanceof Error ? nextError.message : "Failed to load cursor recording data",
					);
				}
			} finally {
				if (!cancelled) {
					setLoading(false);
				}
			}
		}

		loadCursorRecordingData();

		return () => {
			cancelled = true;
		};
	}, [videoPath]);

	return {
		data,
		loading,
		error,
	};
}
