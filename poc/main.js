// POC: two videos, one layout, three effects, full shader. Standalone.
//
// No Electron, no app code, no old paradigm: decode (mediabunny) → WebGPU →
// encode (mediabunny) → an mp4 you can watch, and one number: fps.
//
// The layout is 40 lines of arithmetic written here, not imported: the point is
// to prove the paradigm reconstructs the product, not to reuse what exists.

import {
	ALL_FORMATS,
	BufferTarget,
	Input,
	Mp4OutputFormat,
	Output,
	UrlSource,
	VideoSampleSink,
} from "mediabunny";

const OUT = { width: 1920, height: 1080, fps: 30 };
const log = (msg) => {
	document.querySelector("#log").textContent += `${msg}\n`;
};
const setStat = (id, value) => {
	document.querySelector(`#${id}`).textContent = value;
};

// ---- evaluate: (scene, t) → the frame's geometry. Written from zero. --------
//
// Pure arithmetic, no GPU, no canvas. Everything the shader needs is decided
// here, so the same function can drive a preview later without a second
// implementation to keep in sync.

const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/** Ramp 0→1→0 across a region, eased in and out over `ramp` seconds. */
function regionStrength(t, start, end, ramp) {
	if (t <= start || t >= end) return 0;
	const inRamp = Math.min(1, (t - start) / ramp);
	const outRamp = Math.min(1, (end - t) / ramp);
	return easeInOut(Math.min(inRamp, outRamp));
}

const lerp = (a, b, t) => a + (b - a) * t;
const clampAbs = (x, m) => Math.max(-m, Math.min(m, x));
const lerpRect = (a, b, t) => ({
	x: lerp(a.x, b.x, t),
	y: lerp(a.y, b.y, t),
	w: lerp(a.w, b.w, t),
	h: lerp(a.h, b.h, t),
});

/** The base layout: recording centred with padding, webcam docked bottom-right. */
function baseLayout(stage, padding) {
	const s = 1 - (padding / 100) * 0.4;
	const w = stage.width * s;
	const h = stage.height * s;
	const screen = { x: (stage.width - w) / 2, y: (stage.height - h) / 2, w, h };
	const size = Math.round(stage.height * 0.22);
	const margin = Math.round(stage.height * 0.04);
	const webcam = {
		x: stage.width - size - margin,
		y: stage.height - size - margin,
		w: size,
		h: size,
	};
	return { screen, webcam };
}

/**
 * The whole timeline of this POC, as data.
 *
 * Two things move, and they are the two the product actually has:
 *  - a ZOOM on the recording: scale + focus point, eased in and out;
 *  - a LAYOUT ANIMATION on the webcam: it grows from the docked bubble to a
 *    large panel and its shape morphs from circle to rounded rect on the way.
 */
function scene(stage, padding) {
	return {
		stage,
		padding,
		zooms: [
			{ start: 1.0, end: 3.2, scale: 1.7, focus: { x: 0.62, y: 0.42 }, ramp: 0.55 },
			{ start: 4.4, end: 6.5, scale: 2.3, focus: { x: 0.3, y: 0.7 }, ramp: 0.5 },
		],
		layoutMoves: [{ start: 2.4, end: 5.0, ramp: 0.6 }],
	};
}

function evaluate(sc, t, prev) {
	const base = baseLayout(sc.stage, sc.padding);

	// --- zoom: strongest region wins, eased ---
	let zoomScale = 1;
	let focus = { x: 0.5, y: 0.5 };
	let strength = 0;
	for (const z of sc.zooms) {
		const s = regionStrength(t, z.start, z.end, z.ramp);
		if (s > strength) {
			strength = s;
			zoomScale = lerp(1, z.scale, s);
			focus = z.focus;
		}
	}
	// Scale about the focus point, then keep the recording covering the stage:
	// a zoom that reveals the background behind the video is a bug, not a look.
	const fx = base.screen.x + base.screen.w * focus.x;
	const fy = base.screen.y + base.screen.h * focus.y;
	const screen = {
		x: fx - (fx - base.screen.x) * zoomScale,
		y: fy - (fy - base.screen.y) * zoomScale,
		w: base.screen.w * zoomScale,
		h: base.screen.h * zoomScale,
	};

	// --- layout animation: the webcam grows into a panel and un-rounds ---
	let move = 0;
	for (const m of sc.layoutMoves) {
		move = Math.max(move, regionStrength(t, m.start, m.end, m.ramp));
	}
	const panelW = Math.round(sc.stage.width * 0.34);
	const panelH = Math.round(panelW * 0.75);
	const margin = Math.round(sc.stage.height * 0.04);
	const panel = {
		x: sc.stage.width - panelW - margin,
		y: sc.stage.height - panelH - margin,
		w: panelW,
		h: panelH,
	};
	const webcam = lerpRect(base.webcam, panel, move);
	// Circle when docked (radius = half the bubble), rounded rect when grown.
	const webcamRadius = lerp(Math.min(base.webcam.w, base.webcam.h) / 2, 26, move);

	// --- motion blur: a VECTOR, along the camera's real travel ---
	// The recording smears along how its centre moved since last frame, plus a
	// term for the zoom scaling the content outward. A pan is diagonal; a
	// horizontal-only smear would be wrong for most of what a screen demo does.
	const cx = screen.x + screen.w / 2;
	const cy = screen.y + screen.h / 2;
	const wcx = webcam.x + webcam.w / 2;
	const wcy = webcam.y + webcam.h / 2;
	let screenBlur = { x: 0, y: 0 };
	let webcamBlur = { x: 0, y: 0 };
	if (prev) {
		const k = 0.9;
		screenBlur = {
			x: clampAbs((cx - prev.cx) * k, 22),
			y: clampAbs((cy - prev.cy) * k, 22),
		};
		webcamBlur = {
			x: clampAbs((wcx - prev.wcx) * k, 18),
			y: clampAbs((wcy - prev.wcy) * k, 18),
		};
	}

	return {
		screen,
		webcam,
		webcamRadius,
		zoomScale,
		screenBlur,
		webcamBlur,
		memo: { cx, cy, wcx, wcy },
	};
}

// ---- the cursor: from the recorded trace, drawn synthetically ---------------
//
// The real product records positions + clicks and draws the cursor each frame
// from that data — never baked into the video. This loads a REAL trace (the one
// shipped with the screen recording) so the POC exercises the actual shape of the
// data: normalised positions at irregular timestamps, and click/mouseup events.

async function loadCursor(url) {
	const doc = await (await fetch(url)).json();
	// Dedup by timestamp (the trace repeats samples) and sort.
	const byTime = new Map();
	for (const s of doc.samples) byTime.set(s.timeMs, s);
	const samples = [...byTime.values()].sort((a, b) => a.timeMs - b.timeMs);
	const clicks = doc.samples.filter((s) => s.interactionType === "click").map((s) => s.timeMs);
	return { samples, clicks };
}

/** Position (normalised to the recording) and click bounce at time t. */
function cursorAt(trace, timeMs) {
	const s = trace.samples;
	if (s.length === 0) return null;
	// Linear scan is fine at ~290 samples; a binary search is the same code later.
	let i = 0;
	while (i < s.length - 1 && s[i + 1].timeMs <= timeMs) i++;
	const a = s[i];
	const b = s[Math.min(i + 1, s.length - 1)];
	const span = b.timeMs - a.timeMs;
	const f = span > 0 ? Math.max(0, Math.min(1, (timeMs - a.timeMs) / span)) : 0;

	// Click bounce: the pointer dips to 0.82 and springs back over ~140 ms after a
	// real click — the same cue the app gives, driven by the recorded event.
	let clickScale = 1;
	for (const c of trace.clicks) {
		const dt = timeMs - c;
		if (dt >= 0 && dt < 140) {
			const p = dt / 140;
			clickScale = 1 - 0.18 * Math.sin(p * Math.PI);
		}
	}

	return {
		cx: lerp(a.cx, b.cx, f),
		cy: lerp(a.cy, b.cy, f),
		visible: a.visible !== false,
		clickScale,
	};
}

// ---- decode ----------------------------------------------------------------

async function openVideo(url) {
	const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error(`no video track in ${url}`);
	const sink = new VideoSampleSink(track);
	return { input, track, sink };
}

// ---- run -------------------------------------------------------------------

async function run(override = {}) {
	const started = performance.now();
	// A hidden tab is a throttled tab. Chromium de-prioritises everything in one —
	// the GPU work included — and clamps chained timers to a second. Measured
	// here: the same code that cruises at 58 fps visible reports 6.0 fps hidden,
	// on BOTH arms, with a 401% spread. Every number taken from a background tab
	// is fiction, so this refuses rather than reports.
	if (document.hidden) {
		throw new Error(
			"tab is hidden — Chromium throttles background tabs. Bring it to the front and re-run.",
		);
	}
	document.querySelector("#run").disabled = true;
	log("opening sources…");

	const [screen, webcam, cursor] = await Promise.all([
		openVideo("media/screen.mp4"),
		openVideo("media/webcam.mp4"),
		loadCursor("media/cursor.json"),
	]);
	log(`cursor: ${cursor.samples.length} samples, ${cursor.clicks.length} clicks`);
	const seconds = Number(document.querySelector("#seconds").value);
	const screenDuration = await screen.track.computeDuration();
	const duration = Math.min(seconds, screenDuration);
	const totalFrames = Math.floor(duration * OUT.fps);
	log(
		`screen ${screen.track.displayWidth}x${screen.track.displayHeight} · ${screenDuration.toFixed(1)}s`,
	);
	log(`webcam ${webcam.track.displayWidth}x${webcam.track.displayHeight}`);
	log(`rendering ${totalFrames} frames @ ${OUT.fps}fps (${duration.toFixed(1)}s)`);

	// ---- GPU ----
	if (!navigator.gpu) throw new Error("WebGPU unavailable");
	const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
	// timestamp-query is the only honest way to price the shader: a CPU timer
	// around submit() measures SUBMISSION, and the work lands on whoever syncs
	// next. These are counters the GPU writes itself, around the pass.
	const canTimestamp = adapter.features.has("timestamp-query");
	const device = await adapter.requestDevice({
		requiredFeatures: canTimestamp ? ["timestamp-query"] : [],
	});
	const info = adapter.info ?? {};
	log(`gpu: ${info.vendor ?? "?"} ${info.architecture ?? ""} · timestamps: ${canTimestamp}`);

	const querySet = canTimestamp ? device.createQuerySet({ type: "timestamp", count: 2 }) : null;
	const resolveBuffer = canTimestamp
		? device.createBuffer({
				size: 16,
				usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
			})
		: null;
	const readBuffer = canTimestamp
		? device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
		: null;

	// OffscreenCanvas: no document, no presentation, no compositor.
	//
	// This is a measurement decision, not a detail. A canvas in the page is
	// PRESENTED every frame — the browser composites 2 Mpx into the layout and the
	// swapchain waits on the display's refresh. Measured here: 34.9 ms/frame of
	// fixed cost with every effect switched OFF, eight times the effects
	// themselves. An export presents nothing to anyone, so a measurement that pays
	// for presentation is measuring a different program.
	const canvas = new OffscreenCanvas(OUT.width, OUT.height);
	const ctx = canvas.getContext("webgpu");
	const format = navigator.gpu.getPreferredCanvasFormat();
	ctx.configure({ device, format, alphaMode: "opaque" });

	const previewCanvas = document.querySelector("#stage");
	previewCanvas.width = 640;
	previewCanvas.height = 360;
	const preview = previewCanvas.getContext("2d");

	const code = await (await fetch("composite.wgsl")).text();
	const module = device.createShaderModule({ code });
	device.pushErrorScope("validation");

	// One explicit layout for every pass, so a shader that happens not to sample
	// bgTex does not silently get a different bind group. `auto` derives the
	// layout from what the entry point USES, which makes the layout an accident of
	// dead-code elimination.
	const bindGroupLayout = device.createBindGroupLayout({
		entries: [
			{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
			{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
			{ binding: 2, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
			{ binding: 3, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
			{ binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
		],
	});
	const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

	// Straight-alpha "over": the compositor's only blend.
	const OVER = {
		color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
		alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
	};
	const makePass = (vs, fs, blend) =>
		device.createRenderPipeline({
			label: fs,
			layout: pipelineLayout,
			vertex: { module, entryPoint: vs },
			fragment: { module, entryPoint: fs, targets: [{ format, ...(blend ? { blend } : {}) }] },
			primitive: { topology: "triangle-list" },
		});

	// Five passes, each a quad sized to its element. The rasterizer clips whatever
	// leaves the stage — which, during a zoom, is most of the recording.
	const passes = {
		background: makePass("vsFull", "fsBackground", null),
		screenShadow: makePass("vsScreenShadow", "fsScreenShadow", OVER),
		screen: makePass("vsScreen", "fsScreen", OVER),
		webcamShadow: makePass("vsWebcamShadow", "fsWebcamShadow", OVER),
		webcam: makePass("vsWebcam", "fsWebcam", OVER),
		cursor: makePass("vsCursor", "fsCursor", OVER),
	};

	// The bake runs before any video exists, so it gets a layout of its own: the
	// uniforms and nothing else.
	const bakeLayout = device.createBindGroupLayout({
		entries: [
			{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
		],
	});
	const bgPipeline = device.createRenderPipeline({
		label: "bake",
		layout: device.createPipelineLayout({ bindGroupLayouts: [bakeLayout] }),
		vertex: { module, entryPoint: "vsFull" },
		fragment: { module, entryPoint: "fsBake", targets: [{ format: "rgba8unorm" }] },
		primitive: { topology: "triangle-list" },
	});
	const bgTexture = device.createTexture({
		size: [OUT.width, OUT.height],
		format: "rgba8unorm",
		usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
	});
	const shaderError = await device.popErrorScope();
	if (shaderError) throw new Error(`shader: ${shaderError.message}`);

	const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
	// 5 vec4 = 80 bytes. All-vec4 on purpose: WGSL pads mixed structs and the CPU
	// packing has to reproduce the holes exactly — get one offset wrong and the
	// shader reads a radius where a rect belongs, draws nothing, and reports no
	// error at all.
	const uniforms = new Float32Array(32);
	const uniformBuffer = device.createBuffer({
		size: uniforms.byteLength,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});

	// ---- encode ----
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const { CanvasSource, QUALITY_HIGH } = await import("mediabunny");
	const source = new CanvasSource(canvas, { codec: "avc", bitrate: QUALITY_HIGH });
	output.addVideoTrack(source, { frameRate: OUT.fps });
	await output.start();

	const sc = scene(OUT, Number(document.querySelector("#padding").value));
	// effectsOn === false forces the effects OFF (not just absent) so the "effects
	// on vs off" comparison isolates their cost against the same everything-else.
	const effectsOn = override.effectsOn ?? true;
	const shadowIntensity = effectsOn ? Number(document.querySelector("#shadow").value) : 0;
	const bgBlur = effectsOn ? Number(document.querySelector("#blur").value) : 0;
	const camAspect = webcam.track.displayWidth / webcam.track.displayHeight;
	let memo = null;
	let curMemo = null;

	// Bake the background. Once, here — not 210 times inside the loop.
	uniforms.set([OUT.width, OUT.height, 0, 0], 0);
	uniforms.set([shadowIntensity, bgBlur, 16, 22], 12);
	device.queue.writeBuffer(uniformBuffer, 0, uniforms);
	{
		const enc = device.createCommandEncoder();
		const pass = enc.beginRenderPass({
			colorAttachments: [
				{
					view: bgTexture.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		pass.setPipeline(bgPipeline);
		pass.setBindGroup(
			0,
			device.createBindGroup({
				layout: bakeLayout,
				entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
			}),
		);
		pass.draw(3);
		pass.end();
		device.queue.submit([enc.finish()]);
	}

	// ---- decode: forward streams, not seeks ----
	// getSample(t) per frame is a random-access SEEK per frame: on a long-GOP
	// screen recording that means re-decoding from the last keyframe, every time.
	// Measured at 122 ms/frame — 3x the cost of everything else combined. These
	// videos are read start to end, so read them start to end: two generators,
	// each advanced to the frame the output clock is asking for.
	const screenStream = screen.sink.samples(0, duration);
	const webcamStream = webcam.sink.samples(0, duration);
	const nextFrom = async (stream, holder, t) => {
		// Advance while the NEXT sample still starts at or before t.
		while (
			!holder.done &&
			(!holder.current || holder.current.timestamp + holder.current.duration <= t)
		) {
			const { value, done } = await stream.next();
			if (done) {
				holder.done = true;
				break;
			}
			holder.current?.close();
			holder.current = value;
		}
		return holder.current ?? null;
	};
	const screenHolder = { current: null, done: false };
	const webcamHolder = { current: null, done: false };

	// ---- the loop ----
	// Every phase is timed on its own, and the whole frame is recorded, because
	// two questions need different data: "what does a frame cost once warm" is a
	// distribution, not a mean, and "where does the frame go" is a breakdown.
	//
	// INSTRUMENTED vs CLEAN, because the instruments are not free and two of them
	// change the very thing they measure:
	//   - onSubmittedWorkDone() per frame is a FENCE. It is the only way to bill
	//     the GPU honestly, and it also forbids decode/composite/encode from ever
	//     overlapping — a cost the real loop would not pay.
	//   - mapAsync() to read the timestamps is a GPU→CPU sync, per frame.
	// So the clean pass keeps the same work and drops both, and fps is compared
	// across the two. If they disagree, the breakdown describes a program that
	// only exists while being measured.
	const instrumented = override.instrumented ?? document.querySelector("#instrument").checked;
	const optimised = override.optimised ?? document.querySelector("#optimise").checked;
	const frames = [];
	const t0 = performance.now();
	let rendered = 0;

	for (let i = 0; i < totalFrames; i++) {
		const t = i / OUT.fps;
		const fStart = performance.now();
		const p = {};
		const mark = () => (instrumented ? performance.now() : 0);

		let m = mark();
		const screenSample = await nextFrom(screenStream, screenHolder, t);
		const webcamSample = await nextFrom(webcamStream, webcamHolder, t);
		p.decode = mark() - m;
		if (!screenSample) break;

		// toVideoFrame + importExternalTexture: the decode→GPU seam. Timed apart
		// because "zero copy" is a claim, and this is where it would fail.
		m = mark();
		const screenFrame = screenSample.toVideoFrame();
		const webcamFrame = webcamSample ? webcamSample.toVideoFrame() : null;
		const screenTex = device.importExternalTexture({ source: screenFrame });
		const webcamTex = device.importExternalTexture({ source: webcamFrame ?? screenFrame });
		p.import = mark() - m;

		m = mark();
		const f = evaluate(sc, t, memo);
		memo = f.memo;

		// The cursor: interpolate the recorded trace, then place it in the SCREEN's
		// coordinate space, so it rides the zoom for free — its position is carried
		// through the same rect the recording is.
		const cur = cursorAt(cursor, t * 1000);
		const curX = f.screen.x + (cur?.cx ?? 0) * f.screen.w;
		const curY = f.screen.y + (cur?.cy ?? 0) * f.screen.h;
		const curSize = OUT.height * 0.05;
		let curBlurX = 0;
		let curBlurY = 0;
		if (cur && curMemo) {
			curBlurX = clampAbs((curX - curMemo.x) * 0.8, 30);
			curBlurY = clampAbs((curY - curMemo.y) * 0.8, 30);
		}
		curMemo = cur ? { x: curX, y: curY } : null;
		const curVisible = !!cur && cur.visible;

		// Field n at float 4n — the struct is all-vec4 so this stays true.
		uniforms.set([OUT.width, OUT.height, t, 28], 0); // stage | time | radius
		uniforms.set([f.screen.x, f.screen.y, f.screen.w, f.screen.h], 4);
		uniforms.set([f.webcam.x, f.webcam.y, f.webcam.w, f.webcam.h], 8);
		uniforms.set([shadowIntensity, bgBlur, 16, 22], 12); // intensity | bgBlur | shadowOffsetY | sigma
		uniforms.set([f.webcamRadius, 0, camAspect, optimised ? 1 : 0], 16); // radius | - | coverScale | opt
		uniforms.set([f.screenBlur.x, f.screenBlur.y, f.webcamBlur.x, f.webcamBlur.y], 20); // mb
		uniforms.set([curX, curY, curSize, curVisible ? 1 : 0], 24); // cursor
		uniforms.set([curBlurX, curBlurY, cur?.clickScale ?? 1, 0], 28); // cursorFx
		device.queue.writeBuffer(uniformBuffer, 0, uniforms);
		const bind = device.createBindGroup({
			layout: bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sampler },
				{ binding: 2, resource: screenTex },
				{ binding: 3, resource: webcamTex },
				{ binding: 4, resource: bgTexture.createView() },
			],
		});
		p.evaluate = mark() - m;

		m = mark();
		const encoder = device.createCommandEncoder();
		const view = ctx.getCurrentTexture().createView();
		p.acquire = mark() - m;

		m = mark();
		const useQueries = instrumented && querySet;
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" },
			],
			...(useQueries
				? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
				: {}),
		});
		// CULLING, on the CPU, before anything is submitted.
		//
		// The cheapest fragment is the one never dispatched. Two tests, both from
		// the rects evaluate() already produced:
		//  - the recording covers the stage (every zoom does): nothing underneath
		//    can show, so the background and its shadow are not drawn at all. The
		//    test insets by the corner radius, because a rounded corner is where
		//    the background WOULD peek through.
		//  - the webcam is entirely off-stage: it and its shadow are not drawn.
		const r = f.screen;
		const rad = 28;
		const screenCoversStage =
			optimised &&
			r.x + rad <= 0 &&
			r.y + rad <= 0 &&
			r.x + r.w - rad >= OUT.width &&
			r.y + r.h - rad >= OUT.height;
		const w = f.webcam;
		const webcamVisible =
			!optimised || (w.x < OUT.width && w.y < OUT.height && w.x + w.w > 0 && w.y + w.h > 0);

		pass.setBindGroup(0, bind);
		if (!screenCoversStage) {
			pass.setPipeline(passes.background);
			pass.draw(6);
			pass.setPipeline(passes.screenShadow);
			pass.draw(6);
		}
		pass.setPipeline(passes.screen);
		pass.draw(6);
		if (webcamVisible) {
			pass.setPipeline(passes.webcamShadow);
			pass.draw(6);
			pass.setPipeline(passes.webcam);
			pass.draw(6);
		}
		// The cursor, on top of everything — drawn each frame from the trace, culled
		// when the recorded position is off-stage.
		if (curVisible && curX > -curSize && curY > -curSize && curX < OUT.width && curY < OUT.height) {
			pass.setPipeline(passes.cursor);
			pass.draw(6);
		}
		pass.end();
		if (useQueries) {
			encoder.resolveQuerySet(querySet, 0, 2, resolveBuffer, 0);
			if (readBuffer.mapState === "unmapped")
				encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, 16);
		}
		device.queue.submit([encoder.finish()]);
		p.submit = mark() - m;

		// The fence: everything above only QUEUED work, this is where it executes.
		// Instrumented only — it is what makes the breakdown honest, and it is also
		// what stops the pipeline from overlapping anything.
		if (instrumented) {
			m = performance.now();
			await device.queue.onSubmittedWorkDone();
			p.fence = performance.now() - m;

			// What the GPU says about itself: the pass's duration in ns, written by
			// the GPU around the pass. mapAsync is a GPU→CPU sync, so this too only
			// exists while measuring.
			if (querySet && readBuffer.mapState === "unmapped") {
				await readBuffer.mapAsync(GPUMapMode.READ);
				const ts = new BigUint64Array(readBuffer.getMappedRange().slice(0));
				readBuffer.unmap();
				p.gpuPass = Number(ts[1] - ts[0]) / 1e6;
			}
		}

		m = mark();
		await source.add(t, 1 / OUT.fps);
		p.encode = mark() - m;

		// The VideoFrames are ours; the samples belong to the streams, which close
		// them when they advance.
		screenFrame.close();
		webcamFrame?.close();

		p.total = performance.now() - fStart;
		frames.push(p);
		rendered++;
		if (i % 15 === 0) {
			setStat("progress", `${i}/${totalFrames}`);
			// A 640px preview every 15 frames. OFF the clock — the frame's timer has
			// already stopped — and it never touches the render path.
			preview.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
			// Yield through a MessageChannel, not setTimeout: a chained setTimeout is
			// clamped to 1000 ms in a background tab, which would put eight seconds of
			// pure waiting into a four-second export's wall.
			await new Promise((r) => {
				const ch = new MessageChannel();
				ch.port1.onmessage = () => r();
				ch.port2.postMessage(0);
			});
		}
	}

	const wallMs = performance.now() - t0;
	await output.finalize();

	// ---- report ----
	//
	// Average fps answers "how long did THIS export take". Cruise fps answers "how
	// fast does it run" — the number that compares across exports. A short export
	// amortises the first frames' one-off costs (pipeline warm-up, first
	// allocations, JIT) over few frames, so the mean drags. Both are reported, and
	// the gap between them IS the startup cost.
	const median = (xs) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
	};
	const totals = frames.map((f) => f.total);
	// Cruise = the steady state: drop the first quarter, then take the MEDIAN, so
	// one scheduler hiccup cannot move the number.
	const warm = frames.slice(Math.ceil(frames.length / 4));
	const cruiseMs = median(warm.map((f) => f.total));
	const cruiseFps = 1000 / cruiseMs;
	const avgFps = rendered / (wallMs / 1000);

	setStat("fps", cruiseFps.toFixed(1));
	setStat("progress", `${rendered}/${totalFrames}`);
	setStat("perframe", `${cruiseMs.toFixed(1)} ms`);
	// `?? 0`: the clean pass has no phase timers by construction — that is what
	// makes it clean. Reading them back as undefined is not an error, it is the
	// point.
	setStat("render", instrumented ? `${median(warm.map((f) => f.fence ?? 0)).toFixed(1)} ms` : "—");
	setStat("decode", instrumented ? `${median(warm.map((f) => f.decode ?? 0)).toFixed(1)} ms` : "—");
	setStat("encode", instrumented ? `${median(warm.map((f) => f.encode ?? 0)).toFixed(1)} ms` : "—");

	log(
		`\n=== [${instrumented ? "INSTRUMENTED" : "CLEAN"}] cruise ${cruiseFps.toFixed(1)} fps — ${cruiseMs.toFixed(1)} ms/frame (median of the last ${warm.length}) ===`,
	);
	log(
		`average ${avgFps.toFixed(1)} fps over all ${rendered} frames (${(wallMs / 1000).toFixed(2)}s wall)`,
	);
	log(
		`first frames: ${totals
			.slice(0, 4)
			.map((x) => `${x.toFixed(0)}ms`)
			.join(" · ")}`,
	);
	const drag = totals.reduce((a, b) => a + b, 0) - cruiseMs * totals.length;
	log(
		`one-off cost inside the loop: ${drag.toFixed(0)} ms total → ${(drag / rendered).toFixed(1)} ms/frame of drag on this export`,
	);
	log(
		`setup before the loop: ${((t0 - started) / 1000).toFixed(2)}s (open sources, decoder init, pipeline, encoder)`,
	);

	if (!instrumented) {
		log("\n(clean pass: no fence, no timestamp readback, no phase timers.");
		log(" fps is the only number this pass can honestly report — and it is the");
		log(" one that says what the loop actually does when nobody is watching.)");
	} else {
		log("\n--- where a cruise frame goes (median ms) ---");
		for (const k of ["decode", "import", "evaluate", "acquire", "submit", "fence", "encode"]) {
			const v = median(warm.map((f) => f[k] ?? 0));
			const pct = (v / cruiseMs) * 100;
			log(
				`${k.padEnd(9)}${v.toFixed(1).padStart(6)} ms  ${"█".repeat(Math.round(pct / 2)).padEnd(50)}${pct.toFixed(0)}%`,
			);
		}
		if (frames[0]?.gpuPass !== undefined) {
			const gpu = median(warm.map((f) => f.gpuPass ?? 0));
			log(`\nGPU pass itself: ${gpu.toFixed(2)} ms — measured BY the GPU, around the pass.`);
			log(
				`${(cruiseMs - gpu).toFixed(1)} ms of the ${cruiseMs.toFixed(1)} ms frame is not the shader.`,
			);
		}
		log("\nNOTE: this pass paid for its own instruments — a fence and a buffer map");
		log("per frame. Re-run with `instrumenté` off: if the fps moves, the breakdown");
		log("above describes a program that only exists while being measured.");
	}

	const blob = new Blob([output.target.buffer], { type: "video/mp4" });
	const url = URL.createObjectURL(blob);
	const player = document.querySelector("#result");
	player.src = url;
	player.hidden = false;
	const dl = document.querySelector("#download");
	dl.href = url;
	dl.download = "poc.mp4";
	dl.hidden = false;

	// On disk too: a blob URL dies with the tab, and the output has to be
	// watchable outside this page.
	const written = await fetch("/save?name=poc.mp4", { method: "POST", body: blob }).then((r) =>
		r.text(),
	);
	log(`output: ${(blob.size / 1e6).toFixed(1)} MB → ${written}`);

	// Give it ALL back. A run that leaks its device is a run that poisons the next
	// one: six back-to-back runs kept six GPU devices, six decoder pipelines and
	// six encoders alive, and the rate decayed 19.9 → 8.6 → 7.5 fps across an
	// interleaved comparison. That decay is not the machine drifting, it is this
	// function forgetting — and it invalidated the very A/B it was there to serve.
	screenHolder.current?.close();
	webcamHolder.current?.close();
	await screenStream.return?.();
	await webcamStream.return?.();
	screen.input.dispose();
	webcam.input.dispose();
	bgTexture.destroy();
	device.destroy();

	document.querySelector("#run").disabled = false;
	return { cruiseMs, cruiseFps, avgFps, instrumented };
}

/**
 * Interleaved A/B/A/B, because an effect can only be told apart from drift.
 *
 * Two identical runs measured 34.8 and 28.3 fps on this machine — 23% apart,
 * which is the size of the effects under test. Sequential arms therefore prove
 * nothing: they alternate so drift shows up as a run disagreeing with its OWN
 * repeat instead of masquerading as the change. Same rule, and same reason, as
 * the app's export bench.
 *
 * Both shader variants live in the same module, chosen by a uniform, so the two
 * arms differ by that uniform and nothing else — no reload, no recompile, no
 * second session.
 */
// Every A/B this POC can run, each naming EXACTLY the two things it compares and
// what one run() override turns one arm into the other. Each holds everything
// else fixed, so the difference is the named lever and nothing else.
const COMPARISONS = {
	perf: {
		title: "Perf : optimisé vs naïf",
		a: { label: "optimisé", over: { optimised: true, instrumented: false } },
		b: { label: "naïf", over: { optimised: false, instrumented: false } },
		note: "fond cuit + culling, vs fond recalculé + tout dessiné. Même image.",
	},
	effects: {
		title: "Effets : activés vs coupés",
		a: { label: "effets ON", over: { effectsOn: true, optimised: true, instrumented: false } },
		b: { label: "effets OFF", over: { effectsOn: false, optimised: true, instrumented: false } },
		note: "ombre + flou de fond présents, vs à zéro. Le prix des effets eux-mêmes.",
	},
	instruments: {
		title: "Mesure : instrumenté vs propre",
		a: { label: "instrumenté", over: { instrumented: true, optimised: true } },
		b: { label: "propre", over: { instrumented: false, optimised: true } },
		note: "fence + lecture des timestamps par image, vs rien. Le coût de la mesure.",
	},
};

/**
 * Interleaved A/B/A/B, because an effect can only be told apart from drift.
 *
 * Two identical runs measured 34.8 and 28.3 fps on this machine — 23% apart,
 * which is the size of the effects under test. Sequential arms therefore prove
 * nothing: they alternate so drift shows up as a run disagreeing with its OWN
 * repeat instead of masquerading as the change. Same rule, and same reason, as
 * the app's export bench. The shader variants all live in one module, chosen by a
 * uniform, so an arm differs from its pair by that uniform and nothing else.
 */
async function compare(rounds = 3) {
	const spec = COMPARISONS[document.querySelector("#compareMode").value] ?? COMPARISONS.perf;
	const median = (xs) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
	};
	const spread = (xs) => (Math.max(...xs) - Math.min(...xs)) / median(xs);
	const arms = [
		{ ...spec.a, runs: [] },
		{ ...spec.b, runs: [] },
	];

	// Round 0 is thrown away. Both arms climb monotonically across the first
	// rounds — 15.0 → 28.4 → 33.3 — which is the browser and the GPU waking up,
	// not the arms differing. Keeping it put a 64% spread on a 23% effect and
	// voided the comparison by itself.
	for (let r = 0; r <= rounds; r++) {
		for (const arm of arms) {
			const res = await run(arm.over);
			if (r > 0) arm.runs.push(res.cruiseFps);
		}
	}

	document.querySelector("#log").textContent = "";
	log(`=== ${spec.title} — A/B interleavé, ${rounds} tours + 1 chauffe ===`);
	log(`${spec.note}\n`);
	for (const arm of arms) {
		log(
			`${arm.label.padEnd(13)} croisière ${median(arm.runs).toFixed(1).padStart(5)} fps   spread ${(spread(arm.runs) * 100).toFixed(0)}%   ${arm.runs.map((x) => x.toFixed(1)).join(" / ")}`,
		);
	}
	const [A, B] = arms;
	const gain = median(A.runs) - median(B.runs);
	const gainPct = (gain / median(B.runs)) * 100;
	const worst = Math.max(spread(A.runs), spread(B.runs)) * 100;
	log(
		`\n${A.label} vs ${B.label}: ${gain > 0 ? "+" : ""}${gain.toFixed(1)} fps (${gainPct.toFixed(0)}%)`,
	);
	if (worst >= Math.abs(gainPct)) {
		log(
			`\n!! VOID : spread intra-bras ${worst.toFixed(0)}%, aussi grand que l'effet.\n   Ce run ne dit rien — refaire sur une machine calme.`,
		);
	} else {
		log(`\nspread intra-bras ${worst.toFixed(0)}% < l'effet — le résultat tient.`);
	}
	setStat("fps", median(A.runs).toFixed(1));
}

document.querySelector("#run").addEventListener("click", () => {
	document.querySelector("#log").textContent = "";
	run().catch((error) => {
		log(`\nFAILED: ${error.message}`);
		console.error(error);
		document.querySelector("#run").disabled = false;
	});
});

document.querySelector("#compare").addEventListener("click", () => {
	document.querySelector("#log").textContent = "comparaison en cours, patientez…\n";
	compare().catch((error) => {
		log(`\nFAILED: ${error.message}`);
		console.error(error);
		document.querySelector("#run").disabled = false;
	});
});

// Show the selected comparison's plain-language note next to the dropdown.
const modeSelect = document.querySelector("#compareMode");
const updateNote = () => {
	document.querySelector("#compareNote").textContent = COMPARISONS[modeSelect.value]?.note ?? "";
};
modeSelect.addEventListener("change", updateNote);
updateNote();
