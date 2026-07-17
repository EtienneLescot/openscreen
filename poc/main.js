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

	// --- velocity: what the motion blur is for ---
	const cx = screen.x + screen.w / 2;
	const cy = screen.y + screen.h / 2;
	let velocity = 0;
	if (prev) {
		velocity = Math.hypot(cx - prev.cx, cy - prev.cy) + Math.abs(screen.w - prev.w) * 0.5;
	}

	return {
		screen,
		webcam,
		webcamRadius,
		zoomScale,
		motionBlurPx: Math.min(velocity * 0.35, 24),
		memo: { cx, cy, w: screen.w },
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
	document.querySelector("#run").disabled = true;
	log("opening sources…");

	const [screen, webcam] = await Promise.all([
		openVideo("media/screen.mp4"),
		openVideo("media/webcam.mp4"),
	]);
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
	const pipeline = device.createRenderPipeline({
		layout: "auto",
		vertex: { module, entryPoint: "vs" },
		fragment: { module, entryPoint: "fs", targets: [{ format }] },
		primitive: { topology: "triangle-list" },
	});
	const shaderError = await device.popErrorScope();
	if (shaderError) throw new Error(`shader: ${shaderError.message}`);

	const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
	// 5 vec4 = 80 bytes. All-vec4 on purpose: WGSL pads mixed structs and the CPU
	// packing has to reproduce the holes exactly — get one offset wrong and the
	// shader reads a radius where a rect belongs, draws nothing, and reports no
	// error at all.
	const uniforms = new Float32Array(20);
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
	const shadowIntensity = Number(document.querySelector("#shadow").value);
	const bgBlur = Number(document.querySelector("#blur").value);
	const camAspect = webcam.track.displayWidth / webcam.track.displayHeight;
	let memo = null;

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
		// Field n at float 4n — the struct is all-vec4 so this stays true.
		uniforms.set([OUT.width, OUT.height, t, 28], 0); // stage | time | radius
		uniforms.set([f.screen.x, f.screen.y, f.screen.w, f.screen.h], 4);
		uniforms.set([f.webcam.x, f.webcam.y, f.webcam.w, f.webcam.h], 8);
		uniforms.set([shadowIntensity, bgBlur, 18, 42], 12); // intensity | bgBlur | offsetY | spread
		uniforms.set([f.webcamRadius, f.motionBlurPx, camAspect, 0], 16);
		device.queue.writeBuffer(uniformBuffer, 0, uniforms);
		const bind = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sampler },
				{ binding: 2, resource: screenTex },
				{ binding: 3, resource: webcamTex },
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
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bind);
		pass.draw(3);
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
			// A 640px preview every 15 frames. It is OFF the clock — the frame's
			// timer has already stopped — and it never touches the render path.
			preview.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
			await new Promise((r) => setTimeout(r, 0));
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
	setStat("render", `${median(warm.map((f) => f.fence)).toFixed(1)} ms`);
	setStat("decode", `${median(warm.map((f) => f.decode)).toFixed(1)} ms`);
	setStat("encode", `${median(warm.map((f) => f.encode)).toFixed(1)} ms`);

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
	device.destroy();

	document.querySelector("#run").disabled = false;
	return { cruiseMs, cruiseFps, avgFps, instrumented };
}

/**
 * Do the instruments change the answer? Interleaved A/B/A/B, because they can
 * only be compared against drift.
 *
 * Two identical instrumented runs measured 34.8 and 28.3 fps on this machine —
 * 23% apart, which is the size of the effect under test. Back-to-back runs
 * therefore prove nothing: the arms have to alternate so drift shows up as a run
 * disagreeing with its OWN repeat, instead of masquerading as the instruments'
 * cost. Same rule, and same reason, as the app's export bench.
 */
async function compare(rounds = 3) {
	const median = (xs) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
	};
	const spread = (xs) => (Math.max(...xs) - Math.min(...xs)) / median(xs);
	const arms = { INSTRUMENTED: [], CLEAN: [] };

	// Round 0 is thrown away. Both arms climb monotonically across the first
	// rounds — 15.0 → 28.4 → 33.3 and 27.9 → 37.2 → 42.0 — which is the browser
	// and the GPU waking up, not the arms differing. Keeping it put a 64% spread
	// on a 23% effect and voided the comparison by itself.
	for (let r = 0; r <= rounds; r++) {
		for (const [name, instrumented] of [
			["INSTRUMENTED", true],
			["CLEAN", false],
		]) {
			const res = await run({ instrumented });
			if (r > 0) arms[name].push(res.cruiseFps);
		}
	}

	document.querySelector("#log").textContent = "";
	log("=== do the instruments change the answer? (interleaved A/B) ===\n");
	for (const [name, xs] of Object.entries(arms)) {
		log(
			`${name.padEnd(13)} cruise ${median(xs).toFixed(1).padStart(5)} fps   spread ${(spread(xs) * 100).toFixed(0)}%   runs: ${xs.map((x) => x.toFixed(1)).join(" / ")}`,
		);
	}
	const cost = median(arms.CLEAN) - median(arms.INSTRUMENTED);
	const worst = Math.max(spread(arms.CLEAN), spread(arms.INSTRUMENTED)) * 100;
	log(
		`\ninstruments cost: ${cost.toFixed(1)} fps (${((cost / median(arms.CLEAN)) * 100).toFixed(0)}%)`,
	);
	if (worst >= Math.abs((cost / median(arms.CLEAN)) * 100)) {
		log(
			`\n!! VOID: same-arm spread reaches ${worst.toFixed(0)}%, as large as the effect.\n   This run says nothing. Repeat on a steadier machine.`,
		);
	} else {
		log(`\nsame-arm spread ${worst.toFixed(0)}% — smaller than the effect, so the effect is real.`);
	}
	setStat("fps", median(arms.CLEAN).toFixed(1));
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
	document.querySelector("#log").textContent = "comparing, please wait…\n";
	compare().catch((error) => {
		log(`\nFAILED: ${error.message}`);
		console.error(error);
		document.querySelector("#run").disabled = false;
	});
});
