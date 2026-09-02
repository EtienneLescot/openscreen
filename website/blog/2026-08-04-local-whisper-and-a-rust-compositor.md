---
title: v1.8.0, local whisper and a Rust compositor
description: Export went from about 8 fps to about 126 fps, and the profile that explains why says the encoder was never the bottleneck. Plus an AI editing layer that runs on your own machine and stays off unless you turn it on.
authors: [etienne]
tags: [release, ai, rendering]
image: /img/og-image.png
---

Exporting a 1080p60 project with full effects used to run at about 8 fps. The same project now exports at about 126 fps on the same laptop. The bottleneck was never the encoder, which is the part of this worth writing down.

[v1.8.0](https://github.com/getopenscreen/openscreen/releases/tag/v1.8.0) shipped that on August 4, alongside an optional AI editing layer that transcribes and edits entirely on your own machine.

<!-- truncate -->

## The AI layer

It is off by default. If you never turn it on, nothing downloads, no model is contacted, and you have exactly the 1.7.0 feature set. That was in the roadmap from week one and I don't intend to change it.

Turn it on and you get four things.

**Transcription on your machine.** Whisper via whisper.cpp, with Metal on Apple Silicon, Vulkan on Windows and Linux, CPU everywhere else. DTW word timestamps. Nothing is uploaded and it works offline.

**Editing through the transcript.** Select words, delete them, the span is cut from playback and export. Word boundaries get re-anchored against the audio so the cut lands where the word actually starts.

**Captions derived from the transcript**, instead of generated once and then maintained by hand. Restyle or regroup them with no regeneration step. Translation into 15 languages if you want it.

**Editing by chat.** Describe an edit in plain language and an agent applies real timeline operations: cuts, zooms, speed ramps, annotations, camera framing. `Ctrl/Cmd + Z` undoes an agent edit the same way it undoes yours, with per-message rewind.

The chat uses your own LLM key. Anthropic, OpenAI, Google, Mistral, OpenRouter, MiniMax, or anything OpenAI-compatible. Keys go in your OS credential store and requests go from your machine straight to the provider. There is no OpenScreen server in the middle, because there is no OpenScreen server.

1.8.0 also *removed* the ChatGPT and GitHub Copilot sign-in options the pre-fork codebase had. Using someone's existing subscription there meant shipping GitHub's and OpenAI's own client IDs against endpoints they reserve for their own clients, from inside a signed installer. I didn't want to be in that position. If those vendors open a sanctioned surface, the integrations come back.

## The compositor

Export at 1080p60 with full effects ran at roughly 8 fps. The same project now runs at roughly 126 fps on the same laptop, an AMD Ryzen 5 7520U with its passive integrated Radeon. That machine is deliberately weak. Your number will be different. The order of magnitude is the point.

It is one GPU-resident chain with no CPU readback between stages:

```text
demux -> hardware decode -> GPU composite -> RGB to NV12 -> hardware encode -> MP4 mux
```

I didn't set out to rewrite it. I first rebuilt the Canvas2D compositor to cache by what invalidates a cache instead of by layer. That was worth about 2x, and I verified it byte-identical (SSIM 1.000000 across all 1418 frames of the reference export). What it really did was make the profile readable: compositing was 79% of the time, encoding was 4.5%. The bottleneck was the compositor, running on the CPU inside a browser.

Preview and export now both consume the same `SceneDescription` the app builds, so there is no second renderer to drift. The frame in the editor is the frame that gets written.

## Three backends

| Backend | Stack |
| --- | --- |
| Windows | Direct3D 11, HLSL, D3D11VA decode, hardware encode |
| macOS | Metal (all nine shader entry points ported to MSL), VideoToolbox decode/encode, CoreText text rasterizer |
| Linux | wgpu/WGSL, software H.264 encode, MP4 mux with AAC audio |

There is a CPU backend too, software render and decode, picked automatically when there is no usable GPU. The UI tells you when you are on it, so a slow export has a visible reason.

### The macOS decode detour

Profiling the first working Metal export showed 74% of wall time in decode. The compositor was at 0.2 ms/frame. The hardware decoder pays a fixed per-frame latency, and OpenScreen's own capture writes Constrained Baseline H.264, which software decodes in a few hundred microseconds.

So the decoder is picked by profile now. Baseline goes to software, which came out 2.4x faster end-to-end on the test export (182 fps against 76). High, HEVC and 4K go to VideoToolbox, where the arbitration flips the other way.

## Still open

Hardware encode on Linux. It is correct today and slower for being software. And every number above comes from one weak laptop, so discrete GPUs and Intel QSV still need real measurements.

Next: v1.9.0 through v1.9.6 in twelve days, and v1.10.0.
