/**
 * Whether a word nobody said can be added to a transcript.
 *
 * DEV-only until there is TTS and frame generation. What an insertion creates today is a test
 * pattern over noise — real media, in the right place, for the right length, but nobody says
 * the sentence. Shipping that to a release would put a mire in someone's film.
 *
 * One definition, read by every gate: the transcript pane hides the gesture, and the shell
 * refuses again at the point every renderer path reaches the document, so an entry point
 * added later is refused by default rather than by whoever remembers.
 *
 * A plain runtime refusal, deliberately. The bundler does fold `import.meta.env.DEV` and will
 * usually drop the guarded bodies, but that is an optimisation and not the protection — the
 * refusal has to hold on its own, whatever the minifier decides.
 *
 * A function, not a constant: read at the moment of the gesture, so the gate is something a
 * test can actually drive. A module-level constant is captured at import and silently makes
 * `vi.stubEnv` a no-op — the one check that proves a release refuses would pass by not
 * running.
 *
 * ponytail: drop the flag and every reader when TTS and frame generation land.
 */
export function insertionsEnabled(): boolean {
	return import.meta.env.DEV;
}
