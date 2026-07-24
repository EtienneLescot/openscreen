// WgslFrameRenderer — the §8b compositor, as a POC.
//
// Drop-in for FrameRenderer: same methods, same canvas out, so the existing
// decode / encode / mux / audio pipeline is untouched and the bench can put the
// two compositors in one interleaved run. That is the whole point of matching the
// interface — a POC that cannot be measured against what it replaces is a demo.
//
// What it is: WebGPU device, four textures, one uniform block, one draw call
// (plus the shadow's own passes). No Pixi, no Canvas2D, no six surfaces, no two GL
// contexts, no per-geometry cache.
//
// Both seams (§8c) stay on the device: the decoded VideoFrame enters as an
// external texture (zero copy), and the composited canvas leaves as
// `new VideoFrame(canvas)` to the encoder. Nothing descends to CPU RAM.
//
// NOT in the POC: captions/annotations (glyph rasterisation — a texture upload,
// cheap to add later), 3D rotation, the cursor. Scoped out with the user, and
// none of them changes the shape of what is measured here.

import type {
	AnnotationRegion,
	CameraFullscreenRegion,
	CropRegion,
	SpeedRegion,
	WebcamMaskShape,
	ZoomRegion,
} from "@/components/video-editor/types";
import type { Size, WebcamLayoutPreset, WebcamSizePreset } from "@/lib/compositeLayout";
import { COMPOSITE_WGSL } from "./wgsl/composite.wgsl";
import {
	createEvaluateMemory,
	type EvaluateLayout,
	type EvaluateMemory,
	type EvaluateScene,
	evaluate,
	evaluateLayout,
	type FrameState,
} from "./wgsl/evaluate";
import {
	boxesForStdDeviation,
	SHADOW_WGSL,
	shadowStages,
	stdDeviationForBlur,
} from "./wgsl/shadowCascade.wgsl";

export interface WgslFrameRenderConfig {
	width: number;
	height: number;
	wallpaper: string;
	zoomRegions: ZoomRegion[];
	cameraFullscreenRegions?: CameraFullscreenRegion[];
	annotationRegions?: AnnotationRegion[];
	speedRegions?: SpeedRegion[];
	showShadow: boolean;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount?: number;
	borderRadius?: number;
	padding?: number;
	cropRegion: CropRegion;
	videoWidth: number;
	videoHeight: number;
	webcamSize?: Size | null;
	webcamLayoutPreset?: WebcamLayoutPreset;
	webcamMaskShape?: WebcamMaskShape;
	webcamMirrored?: boolean;
	webcamReactiveZoom?: boolean;
	webcamSizePreset?: WebcamSizePreset;
	webcamPosition?: { cx: number; cy: number } | null;
	cursorTelemetry?: import("@/components/video-editor/types").CursorTelemetryPoint[];
	platform: string;
}

const MASK_SHAPE_CODE: Record<string, number> = {
	rectangle: 0,
	rounded: 1,
	circle: 2,
	square: 3,
};

/** Uniform block: 28 floats = 112 bytes. §8b budgets ~200; there is room. */
const UNIFORM_FLOATS = 28;

export class WgslFrameRenderer {
	private config: WgslFrameRenderConfig;
	private canvas: HTMLCanvasElement | null = null;
	private context: GPUCanvasContext | null = null;
	private device: GPUDevice | null = null;

	private compositePipeline: GPURenderPipeline | null = null;
	private uniformBuffer: GPUBuffer | null = null;
	private uniformData = new Float32Array(UNIFORM_FLOATS);
	private sampler: GPUSampler | null = null;
	private backgroundTexture: GPUTexture | null = null;
	/** Stands in for an absent webcam: an external texture binding cannot be null. */
	private blankTexture: GPUTexture | null = null;

	private shadow: ShadowPasses | null = null;

	private layout: EvaluateLayout | null = null;
	private layoutHasWebcam: boolean | null = null;
	private memory: EvaluateMemory = createEvaluateMemory();
	/** WebGPU reports validation failures out-of-band: a broken pass draws nothing
	 *  and says nothing, which reads as a fast compositor rendering black. Scoped
	 *  on the first frame only — enough to catch a structural mistake, and the
	 *  popErrorScope sync is not something the steady state should pay for. */
	private firstFrame = true;

	constructor(config: WgslFrameRenderConfig) {
		this.config = config;
	}

	async initialize(): Promise<void> {
		if (!navigator.gpu) {
			throw new Error("WebGPU unavailable: navigator.gpu is missing (needs a secure context)");
		}
		const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
		if (!adapter) throw new Error("WebGPU unavailable: no adapter");
		const device = await adapter.requestDevice();
		this.device = device;
		// A device lost mid-export must not surface as a black frame or a silent
		// hang: it is a failed export and must say so.
		device.lost.then((info) => {
			console.error(`[wgsl] GPU device lost: ${info.reason} — ${info.message}`);
		});

		const canvas = document.createElement("canvas");
		canvas.width = this.config.width;
		canvas.height = this.config.height;
		this.canvas = canvas;

		const context = canvas.getContext("webgpu");
		if (!context) throw new Error("WebGPU unavailable: canvas has no webgpu context");
		this.context = context;
		context.configure({
			device,
			format: navigator.gpu.getPreferredCanvasFormat(),
			alphaMode: "opaque",
			// The composited texture is read back by `new VideoFrame(canvas)` — the
			// encoder seam. Without COPY_SRC that read is illegal.
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
		});

		this.sampler = device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		this.uniformBuffer = device.createBuffer({
			size: UNIFORM_FLOATS * 4,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});

		const module = device.createShaderModule({ code: COMPOSITE_WGSL, label: "composite" });
		this.compositePipeline = device.createRenderPipeline({
			label: "composite",
			layout: "auto",
			vertex: { module, entryPoint: "vs" },
			fragment: {
				module,
				entryPoint: "fs",
				targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
			},
			primitive: { topology: "triangle-list" },
		});

		this.blankTexture = device.createTexture({
			size: [1, 1],
			format: "rgba8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});

		await this.loadBackground();

		this.shadow = new ShadowPasses(device, this.config.width, this.config.height);
	}

	/**
	 * The wallpaper, blurred ONCE at init.
	 *
	 * This is not the 2D cache in disguise: the wallpaper is a still image, so
	 * blurring it per frame would be recomputing a constant. The shadow is not a
	 * constant — it follows the camera — which is exactly why it is not cached.
	 */
	private async loadBackground(): Promise<void> {
		const device = this.device;
		if (!device) return;
		const { width, height } = this.config;

		const surface = document.createElement("canvas");
		surface.width = width;
		surface.height = height;
		const ctx = surface.getContext("2d");
		if (!ctx) throw new Error("2d context unavailable for wallpaper preparation");

		const wallpaper = this.config.wallpaper;
		if (wallpaper && !wallpaper.startsWith("#") && !wallpaper.includes("gradient")) {
			const url =
				wallpaper.startsWith("/") || wallpaper.includes("://")
					? wallpaper
					: `/wallpapers/${wallpaper}`;
			try {
				const image = await loadImage(url);
				if (this.config.showBlur) ctx.filter = "blur(6px)";
				ctx.drawImage(image, 0, 0, width, height);
				ctx.filter = "none";
			} catch (error) {
				console.warn(`[wgsl] wallpaper ${url} failed to load, falling back to flat:`, error);
				ctx.fillStyle = "#1e1e1e";
				ctx.fillRect(0, 0, width, height);
			}
		} else {
			ctx.fillStyle = wallpaper || "#1e1e1e";
			ctx.fillRect(0, 0, width, height);
		}

		this.backgroundTexture = device.createTexture({
			size: [width, height],
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.RENDER_ATTACHMENT,
		});
		device.queue.copyExternalImageToTexture(
			{ source: surface },
			{ texture: this.backgroundTexture },
			[width, height],
		);
	}

	setSource(source: {
		videoWidth: number;
		videoHeight: number;
		webcamSize?: Size | null;
		zoomRegions?: ZoomRegion[];
		annotationRegions?: AnnotationRegion[];
		speedRegions?: SpeedRegion[];
		cursorRecordingData?: unknown;
		cursorScale?: number;
	}): void {
		this.config = {
			...this.config,
			videoWidth: source.videoWidth,
			videoHeight: source.videoHeight,
			webcamSize: source.webcamSize ?? null,
			zoomRegions: source.zoomRegions ?? this.config.zoomRegions,
			annotationRegions: source.annotationRegions ?? this.config.annotationRegions,
			speedRegions: source.speedRegions ?? this.config.speedRegions,
		};
		// A new segment is a new source: geometry must be recomputed, and the
		// spring must not integrate across the cut.
		this.layout = null;
		this.layoutHasWebcam = null;
		this.memory = createEvaluateMemory();
	}

	setCropRegion(crop: CropRegion): void {
		this.config = { ...this.config, cropRegion: crop };
		this.layout = null;
	}

	private scene(): EvaluateScene {
		return {
			outputSize: { width: this.config.width, height: this.config.height },
			videoSize: { width: this.config.videoWidth, height: this.config.videoHeight },
			webcamSize: this.config.webcamSize ?? null,
			cropRegion: this.config.cropRegion,
			padding: this.config.padding ?? 0,
			borderRadius: this.config.borderRadius ?? 0,
			shadowIntensity: this.config.showShadow ? this.config.shadowIntensity : 0,
			motionBlurAmount: this.config.motionBlurAmount ?? 0,
			zoomRegions: this.config.zoomRegions,
			cameraFullscreenRegions: this.config.cameraFullscreenRegions ?? [],
			webcamLayoutPreset: this.config.webcamLayoutPreset ?? "picture-in-picture",
			webcamSizePreset: this.config.webcamSizePreset ?? 25,
			webcamMaskShape: this.config.webcamMaskShape ?? "rectangle",
			webcamPosition: this.config.webcamPosition ?? null,
			webcamMirrored: this.config.webcamMirrored ?? false,
			webcamReactiveZoom: this.config.webcamReactiveZoom ?? true,
			cursorTelemetry: this.config.cursorTelemetry,
		};
	}

	async renderFrame(
		videoFrame: VideoFrame,
		timestampUs: number,
		webcamFrame?: VideoFrame | null,
	): Promise<void> {
		const device = this.device;
		const context = this.context;
		const pipeline = this.compositePipeline;
		if (!device || !context || !pipeline || !this.uniformBuffer || !this.sampler) {
			throw new Error("Renderer not initialized");
		}

		const scene = this.scene();
		const hasWebcam = !!webcamFrame;
		if (!this.layout || this.layoutHasWebcam !== hasWebcam) {
			this.layout = evaluateLayout(scene, hasWebcam);
			this.layoutHasWebcam = hasWebcam;
		}
		if (!this.layout) throw new Error("Layout could not be evaluated");

		const timeMs = timestampUs / 1000;
		const state = evaluate(scene, this.layout, timeMs, this.memory);
		if (this.firstFrame) {
			device.pushErrorScope("validation");
			console.warn(
				`[wgsl] frame 0 @${timeMs.toFixed(0)}ms: stage ${this.config.width}x${this.config.height}` +
					` · padding ${scene.padding} · preset ${scene.webcamLayoutPreset}` +
					` · maskRect ${fmtRect(this.layout.maskRect)}` +
					` · camera scale=${state.camera.scale.toFixed(3)} x=${state.camera.x.toFixed(0)} y=${state.camera.y.toFixed(0)}` +
					` · videoRect ${fmtRect(state.cameraRect)} r=${state.cameraBorderRadius.toFixed(1)}` +
					` · shadow ${state.shadowIntensity} · webcam ${
						state.webcamRect ? fmtRect(state.webcamRect) : "none"
					}`,
			);
		}

		// Seam S1: the decoded frame becomes a texture without leaving the device.
		// External textures are valid for this task only — imported per frame, by
		// design, and free.
		const videoTex = device.importExternalTexture({ source: videoFrame });
		const webcamTex = webcamFrame ? device.importExternalTexture({ source: webcamFrame }) : null;

		const encoder = device.createCommandEncoder({ label: "frame" });

		let shadowView: GPUTextureView;
		if (state.shadowIntensity > 0 && this.shadow) {
			shadowView = this.shadow.encode(encoder, state);
		} else {
			shadowView = this.shadow!.outputTexture.createView();
		}

		this.writeUniforms(state, hasWebcam);
		device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

		const bindGroup = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.uniformBuffer } },
				{ binding: 1, resource: this.sampler },
				{ binding: 2, resource: videoTex },
				{
					binding: 3,
					resource: webcamTex ?? device.importExternalTexture({ source: blankFrame() }),
				},
				{ binding: 4, resource: this.backgroundTexture!.createView() },
				{ binding: 5, resource: shadowView },
			],
		});

		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: context.getCurrentTexture().createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bindGroup);
		pass.draw(3);
		pass.end();

		device.queue.submit([encoder.finish()]);

		if (this.firstFrame) {
			this.firstFrame = false;
			const error = await device.popErrorScope();
			if (error) console.error(`[wgsl] VALIDATION ERROR on frame 0: ${error.message}`);
			else console.warn("[wgsl] frame 0 submitted with no validation error");
		}
	}

	/**
	 * Pack the uniform block. Field n lives at float 4n — the struct is all vec4f
	 * precisely so this can be true (see composite.wgsl.ts).
	 */
	private writeUniforms(state: FrameState, hasWebcam: boolean): void {
		const u = this.uniformData;
		const w = state.webcamRect;
		// Motion blur, in pixels, along the camera's direction of travel. The 2D
		// path drives a Pixi filter from the same velocity; same input, same look.
		const blurPx = state.velocity * (state.motionBlurAmount ?? 0) * 400;

		// a: stage.xy | videoRadius | shadowIntensity
		u[0] = this.config.width;
		u[1] = this.config.height;
		u[2] = state.cameraBorderRadius;
		u[3] = state.shadowIntensity;
		// videoRect
		u[4] = state.cameraRect.x;
		u[5] = state.cameraRect.y;
		u[6] = state.cameraRect.width;
		u[7] = state.cameraRect.height;
		// crop
		u[8] = state.crop.x;
		u[9] = state.crop.y;
		u[10] = state.crop.width;
		u[11] = state.crop.height;
		// webcamRect
		u[12] = w?.x ?? 0;
		u[13] = w?.y ?? 0;
		u[14] = w?.width ?? 0;
		u[15] = w?.height ?? 0;
		// b: webcamRadius | motionBlur.xy | unused. Blur runs along x: the camera's
		// travel is dominated by the pan, and a single axis is what the 2D filter
		// applies too.
		u[16] = w?.borderRadius ?? 0;
		u[17] = blurPx;
		u[18] = 0;
		u[19] = 0;
		// flags: shape | mirrored | hasWebcam | hasShadow — floats, not u32, so the
		// whole block is one Float32Array with no type interleaving.
		u[20] = w ? (MASK_SHAPE_CODE[w.shape] ?? 0) : 0;
		u[21] = state.webcamMirrored ? 1 : 0;
		u[22] = hasWebcam && w ? 1 : 0;
		u[23] = state.shadowIntensity > 0 ? 1 : 0;
		// webcamSrc: the largest centred sub-rect of the camera with the BOX's aspect
		// ratio — `object-fit: cover`, computed here because the box's ratio is not the
		// camera's (a block layout hands it a column slot; Full Camera walks it out to
		// the whole frame) and the shader would otherwise stretch the face into it.
		const src = this.config.webcamSize;
		const boxAspect = w && w.height > 0 ? w.width / w.height : 1;
		const srcAspect = src && src.width > 0 && src.height > 0 ? src.width / src.height : boxAspect;
		const cropW = srcAspect > boxAspect ? boxAspect / srcAspect : 1;
		const cropH = srcAspect > boxAspect ? 1 : srcAspect / boxAspect;
		u[24] = (1 - cropW) / 2;
		u[25] = (1 - cropH) / 2;
		u[26] = cropW;
		u[27] = cropH;
	}

	getCanvas(): HTMLCanvasElement {
		if (!this.canvas) throw new Error("Renderer not initialized");
		return this.canvas;
	}

	/** Gate G0's fence, for arm parity with the Canvas2D renderer. */
	finishGpuWork(): void {
		// onSubmittedWorkDone is the device's own fence; the caller awaits nothing
		// here because the encoder's VideoFrame(canvas) is the real sync point.
		void this.device?.queue.onSubmittedWorkDone();
	}

	/** No cache to report. Kept so the exporter can treat both renderers alike. */
	shadowCacheStats(): { hits: number; misses: number } {
		return { hits: 0, misses: 0 };
	}

	destroy(): void {
		this.backgroundTexture?.destroy();
		this.blankTexture?.destroy();
		this.shadow?.destroy();
		this.uniformBuffer?.destroy();
		this.device?.destroy();
		this.device = null;
		this.context = null;
		this.canvas = null;
	}
}

/**
 * The shadow's passes: silhouette → 3 cascade stages, each a gaussian (3 box
 * blurs, separable) then a composite → strip the silhouette.
 *
 * Six textures, allocated once. Two of them exist for a reason worth stating: a
 * pass may not read and write the same texture, and a cascade stage reads BOTH
 * its source and that source's blur. So the blur chain ping-pongs in its own pair
 * (blurA/blurB) and never touches the stage's pair (stageA/stageB) — a single
 * shared ping-pong silently overwrites the stage's source on the blur's second
 * pass, which is a black shadow and a long afternoon.
 */
class ShadowPasses {
	readonly outputTexture: GPUTexture;
	private device: GPUDevice;
	private width: number;
	private height: number;
	private silhouette: GPUTexture;
	private blurA: GPUTexture;
	private blurB: GPUTexture;
	private stageA: GPUTexture;
	private stageB: GPUTexture;
	private silhouettePipeline: GPURenderPipeline;
	private boxPipeline: GPURenderPipeline;
	private stagePipeline: GPURenderPipeline;
	private stripPipeline: GPURenderPipeline;
	private sampler: GPUSampler;
	private silhouetteBuffer: GPUBuffer;
	private stripBuffer: GPUBuffer;
	private boxBuffers: GPUBuffer[] = [];
	private stageBuffers: GPUBuffer[] = [];
	private boxCursor = 0;
	private stageCursor = 0;

	constructor(device: GPUDevice, width: number, height: number) {
		this.device = device;
		this.width = width;
		this.height = height;

		const make = (label: string) =>
			device.createTexture({
				label,
				size: [width, height],
				format: "rgba8unorm",
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
			});
		this.silhouette = make("shadow-silhouette");
		this.blurA = make("shadow-blur-a");
		this.blurB = make("shadow-blur-b");
		this.stageA = make("shadow-stage-a");
		this.stageB = make("shadow-stage-b");
		this.outputTexture = make("shadow-out");

		const module = device.createShaderModule({ code: SHADOW_WGSL, label: "shadow" });
		const target: GPUColorTargetState[] = [{ format: "rgba8unorm" }];
		const makePipeline = (entry: string, label: string) =>
			device.createRenderPipeline({
				label,
				layout: "auto",
				vertex: { module, entryPoint: "vs" },
				fragment: { module, entryPoint: entry, targets: target },
				primitive: { topology: "triangle-list" },
			});
		this.silhouettePipeline = makePipeline("fsSilhouette", "shadow-silhouette");
		this.boxPipeline = makePipeline("fsBox", "shadow-box");
		this.stagePipeline = makePipeline("fsStage", "shadow-stage");
		this.stripPipeline = makePipeline("fsStrip", "shadow-strip");

		this.sampler = device.createSampler({
			magFilter: "nearest",
			minFilter: "nearest",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});
		this.silhouetteBuffer = device.createBuffer({
			size: 32,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.stripBuffer = device.createBuffer({
			size: 32,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
	}

	private boxBuffer(): GPUBuffer {
		// One buffer per box pass per frame: a bind group must not read a buffer
		// that a later pass in the same submit has overwritten.
		if (this.boxCursor >= this.boxBuffers.length) {
			this.boxBuffers.push(
				this.device.createBuffer({
					size: 16,
					usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				}),
			);
		}
		return this.boxBuffers[this.boxCursor++];
	}

	private stageBuffer(): GPUBuffer {
		if (this.stageCursor >= this.stageBuffers.length) {
			this.stageBuffers.push(
				this.device.createBuffer({
					size: 16,
					usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				}),
			);
		}
		return this.stageBuffers[this.stageCursor++];
	}

	encode(encoder: GPUCommandEncoder, state: FrameState): GPUTextureView {
		this.boxCursor = 0;
		this.stageCursor = 0;
		const device = this.device;
		const rect = state.cameraRect;
		const radius = state.cameraBorderRadius;

		// a: stage.xy | radius | unused, then rect — vec4 each, no holes.
		const geom = new Float32Array(8);
		geom[0] = this.width;
		geom[1] = this.height;
		geom[2] = radius;
		geom[3] = 0;
		geom[4] = rect.x;
		geom[5] = rect.y;
		geom[6] = rect.width;
		geom[7] = rect.height;
		device.queue.writeBuffer(this.silhouetteBuffer, 0, geom);
		device.queue.writeBuffer(this.stripBuffer, 0, geom);

		// 1. The silhouette.
		this.drawInto(encoder, this.silhouettePipeline, this.silhouette, [
			{ binding: 0, resource: { buffer: this.silhouetteBuffer } },
		]);

		// 2. The cascade. Each stage blurs its input's alpha and composites the
		//    input back over it — so stage k+1 shadows stage k's shadow. That
		//    recursion is the falloff; it cannot collapse into one blur.
		let current = this.silhouette;
		let stageIndex = 0;
		for (const stage of shadowStages(state.shadowIntensity)) {
			const blurred = this.blur(encoder, current, stdDeviationForBlur(stage.blur));
			// Alternating stage textures: dest is never `current` (the previous
			// stage's output) and never `blurred` (which lives in the blur pair).
			const dest = stageIndex % 2 === 0 ? this.stageA : this.stageB;

			const buffer = this.stageBuffer();
			const data = new Float32Array(4);
			data[0] = stage.offsetY / this.height;
			data[1] = stage.alpha;
			device.queue.writeBuffer(buffer, 0, data);

			this.drawInto(encoder, this.stagePipeline, dest, [
				{ binding: 0, resource: { buffer } },
				{ binding: 1, resource: this.sampler },
				{ binding: 2, resource: current.createView() },
				{ binding: 3, resource: blurred.createView() },
			]);
			current = dest;
			stageIndex++;
		}

		// 3. Remove the silhouette; the recording covers that area itself.
		this.drawInto(encoder, this.stripPipeline, this.outputTexture, [
			{ binding: 0, resource: { buffer: this.stripBuffer } },
			{ binding: 1, resource: this.sampler },
			{ binding: 2, resource: current.createView() },
		]);
		return this.outputTexture.createView();
	}

	/**
	 * One gaussian = three box blurs, per the SVG filter spec. Separable, so a
	 * d x d box costs 2d taps rather than d².
	 *
	 * Ping-pongs strictly inside (blurA, blurB): `src` belongs to the caller and
	 * is read again by the cascade stage after this returns, so it must survive.
	 */
	private blur(encoder: GPUCommandEncoder, src: GPUTexture, stdDeviation: number): GPUTexture {
		const boxes = boxesForStdDeviation(stdDeviation);
		if (boxes.length === 0) return src;
		let current = src;
		let pass = 0;
		for (const box of boxes) {
			for (const axis of [0, 1]) {
				const dest = pass % 2 === 0 ? this.blurA : this.blurB;
				const buffer = this.boxBuffer();
				const data = new ArrayBuffer(16);
				const f = new Float32Array(data, 0, 2);
				const i = new Int32Array(data, 8, 2);
				f[0] = axis === 0 ? 1 / this.width : 0;
				f[1] = axis === 0 ? 0 : 1 / this.height;
				i[0] = box.width;
				i[1] = box.offset;
				this.device.queue.writeBuffer(buffer, 0, data);
				this.drawInto(encoder, this.boxPipeline, dest, [
					{ binding: 0, resource: { buffer } },
					{ binding: 1, resource: this.sampler },
					{ binding: 2, resource: current.createView() },
				]);
				current = dest;
				pass++;
			}
		}
		return current;
	}

	private drawInto(
		encoder: GPUCommandEncoder,
		pipeline: GPURenderPipeline,
		target: GPUTexture,
		entries: GPUBindGroupEntry[],
	): void {
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: target.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(
			0,
			this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
		);
		pass.draw(3);
		pass.end();
	}

	destroy(): void {
		this.silhouette.destroy();
		this.blurA.destroy();
		this.blurB.destroy();
		this.stageA.destroy();
		this.stageB.destroy();
		this.outputTexture.destroy();
		this.silhouetteBuffer.destroy();
		this.stripBuffer.destroy();
		for (const b of this.boxBuffers) b.destroy();
		for (const b of this.stageBuffers) b.destroy();
	}
}

const fmtRect = (r: { x: number; y: number; width: number; height: number }) =>
	`${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)}`;

function loadImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.crossOrigin = "anonymous";
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(`failed to load ${url}`));
		image.src = url;
	});
}

let blank: VideoFrame | null = null;
/** An external texture binding cannot be null, so an absent webcam gets 1x1 of nothing. */
function blankFrame(): VideoFrame {
	if (!blank) {
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		blank = new VideoFrame(canvas, { timestamp: 0 });
	}
	return blank;
}
