# MediaPipe JavaScript Solutions

MediaPipe offers out of the box solutions to use our ML technology with live and streaming media.

Visit us as [mediapipe.dev]()

See live demos of our JavaScript solutions at [code.mediapipe.dev/codepen]()

For more information on each of the solutions and how to use them, visit https://google.github.io/mediapipe/getting_started/javascript.


---

## `selfie_segmentation_landscape.onnx` — derived, not vendored

The `.onnx` beside the `.tflite` files is **generated from them**, by
[`scripts/convert-selfie-segmentation-to-onnx.py`](../../../scripts/convert-selfie-segmentation-to-onnx.py).
No weights were downloaded; it is a derived work of the MediaPipe model already vendored here
(Apache-2.0).

It exists because the realtime path runs inference through ONNX Runtime rather than the
MediaPipe JS solution. Regenerate with:

```
pip install "numpy<2" "tensorflow==2.13.1" "tf2onnx==1.16.1" "onnx==1.16.2" "protobuf<4"
python scripts/convert-selfie-segmentation-to-onnx.py landscape
```

**The conversion is not mechanical.** `tf2onnx` exits 0 while leaving 12 operators that ONNX
Runtime cannot load — 11 `HardSwish` emitted into an opset-13 graph, and MediaPipe's custom
`TFL_Convolution2DTransposeBias`. The script repairs both; the reasoning is in its docstring.
If you regenerate, re-check the mask on a real frame rather than trusting the exit code.

| | |
|---|---|
| input | `input_1` `[1, 144, 256, 3]` float32, **NHWC**, RGB scaled to 0..1 |
| output | `segment_back` `[1, 144, 256, 1]` float32, already sigmoid-activated |
| feeds | the compositor's `t3` mask slot (256x144 R8) |

The graph is fully convolutional and resolution-agnostic, so the input dimensions can be
rewritten in place — but **both dimensions must be divisible by 16**, or the skip-connection
`Add`s fail on mismatched extents. Measured quality below 192x112 degrades visibly on a
full-screen camera, and at 64x48 the model stops producing a mask at all.

> **Packaging:** this file currently sits under `public/`, which is bundled into `app.asar`.
> Anything that resolves a filesystem path for native code cannot read it from there — see
> `scripts/before-pack.cjs` and the compositor's asset handling. Whoever wires the loader
> should decide whether it moves to `extraResources` or is read through the renderer.
