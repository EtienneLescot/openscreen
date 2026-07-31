/**
 * Unit conversions between the editor's settings and the native compositor's
 * params.
 *
 * These two constants used to live inside the panels that pushed them — one
 * declared inside `VideoEffectsPane`'s body, the other at RightPanes module
 * scope. They are here because `pushAllNativeParams` needs the same numbers,
 * and a second copy of a conversion factor is a silent divergence waiting to
 * happen: the preview would drift from the panel by exactly the ratio between
 * the two values, which is the kind of bug nobody attributes to a constant.
 */

/**
 * The fixture's screen corner radius at 1920 wide. The native `roundness` param
 * is a SCALE on it, so dividing the UI's pixel value by the same base makes the
 * rendered corner match the pixels shown (dividing by 64, as an earlier version
 * did, capped it at ~24px).
 */
export const NATIVE_SCREEN_BASE_RADIUS_PX = 24;

/**
 * The fixture's webcam width as a percentage of the frame (a_side = 320px @1920
 * ≈ 16.7%). `webcamSizePreset / this` is the native size scale, 1 meaning the
 * shipped default, so the slider reads as a direct multiplier.
 */
export const NATIVE_WEBCAM_BASE_PCT = 16.7;
