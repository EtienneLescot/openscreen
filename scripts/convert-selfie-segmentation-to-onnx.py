#!/usr/bin/env python3
"""Convert the vendored MediaPipe SelfieSegmentation .tflite to ONNX.

This is the script that produced `selfie_segmentation_landscape.onnx`. It is checked in so
the artifact is reproducible and auditable rather than an opaque binary: the conversion is
NOT a mechanical one-liner, it needs two hand repairs (below), and anyone reviewing the model
needs to be able to see and re-run them.

It is not part of any build. Nothing in the app runs Python; this is provenance tooling, run
by hand on the rare occasion the model is regenerated.

    pip install "numpy<2" "tensorflow==2.13.1" "tf2onnx==1.16.1" "onnx==1.16.2" "protobuf<4"
    python scripts/convert-selfie-segmentation-to-onnx.py landscape

Why the repairs are needed
--------------------------
`tf2onnx` reports success on this model but leaves 12 operators that ONNX Runtime cannot load:

1. **11 x HardSwish emitted into an opset-13 graph.** `HardSwish` is opset 14+, so the graph
   is invalid as declared. Fixed by raising the opset to 16.

2. **1 x TFL_Convolution2DTransposeBias** — a MediaPipe *custom* operator with no ONNX
   equivalent, so tf2onnx passes it through under the default domain where it does not exist.
   It is the last convolution before the output sigmoid: a 2x2 stride-2 transposed
   convolution, 16 channels in, 1 out, plus a bias. Rewritten here as a native
   `ConvTranspose` + bias, with the weights transposed from TFLite's
   `[C_out, kH, kW, C_in]` to ONNX's `[C_in, C_out/group, kH, kW]`.

   tf2onnx also inserts an NHWC `Transpose` to feed that custom node. Since the replacement
   consumes NCHW directly, the transpose is dropped and the layout flip moves after the
   sigmoid (sigmoid is elementwise, so the order is equivalent).

The result passes `onnx.checker.check_model(..., full_check=True)` and, on a real webcam
frame, produces a mask identical between the CPU and DirectML execution providers.

The graph is fully convolutional and resolution-agnostic (every `Reshape` target is
channel-only, every `Resize` uses scales rather than sizes), so the input dimensions can be
rewritten after the fact -- but **both dimensions must be divisible by 16** or the
skip-connection `Add`s fail on mismatched extents.

Source model: `public/mediapipe/selfie_segmentation/*.tflite`, vendored from MediaPipe
(Apache-2.0). This conversion is a derived work of that file; no weights are downloaded.
"""
import argparse
import pathlib
import subprocess
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper, shape_inference

HERE = pathlib.Path(__file__).resolve().parent
MODELS = HERE.parent / "public" / "mediapipe" / "selfie_segmentation"

VARIANTS = {
    "landscape": ("selfie_segmentation_landscape.tflite", "selfie_segmentation_landscape.onnx"),
    "square": ("selfie_segmentation.tflite", "selfie_segmentation.onnx"),
}


def repair(src: pathlib.Path, dst: pathlib.Path) -> None:
    model = onnx.load(str(src))
    graph = model.graph

    for opset in model.opset_import:
        if opset.domain in ("", "ai.onnx"):
            opset.version = 16  # HardSwish is opset 14+

    init = {i.name: numpy_helper.to_array(i) for i in graph.initializer}
    custom = next(n for n in graph.node if n.op_type == "TFL_Convolution2DTransposeBias")
    feed_transpose = next(n for n in graph.node if n.output[0] == custom.input[0])
    source = feed_transpose.input[0]          # NCHW feature map
    sigmoid = next(n for n in graph.node if custom.output[0] in n.input)
    assert sigmoid.op_type == "Sigmoid", sigmoid.op_type

    weights = init[custom.input[1]]           # [C_out, kH, kW, C_in]
    assert weights.shape == (1, 2, 2, 16), weights.shape
    graph.initializer.append(
        numpy_helper.from_array(np.transpose(weights, (3, 0, 1, 2)).copy(), "convT_W")
    )

    out_name = graph.output[0].name
    nodes = [n for n in graph.node if n not in (feed_transpose, custom, sigmoid)]
    nodes += [
        helper.make_node(
            "ConvTranspose", [source, "convT_W", custom.input[2]], ["convT_out"],
            name="conv2d_transpose_native",
            kernel_shape=[2, 2], strides=[2, 2], pads=[0, 0, 0, 0],
        ),
        helper.make_node("Sigmoid", ["convT_out"], ["mask_nchw"], name="segment_sigmoid"),
        helper.make_node("Transpose", ["mask_nchw"], [out_name], name="mask_to_nhwc",
                         perm=[0, 2, 3, 1]),
    ]
    del graph.node[:]
    graph.node.extend(nodes)
    del graph.value_info[:]

    model = shape_inference.infer_shapes(model, strict_mode=True)
    onnx.checker.check_model(model, full_check=True)
    onnx.save(model, str(dst))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("variant", choices=sorted(VARIANTS), nargs="?", default="landscape")
    args = parser.parse_args()

    tflite_name, onnx_name = VARIANTS[args.variant]
    tflite = MODELS / tflite_name
    if not tflite.exists():
        print(f"missing source model: {tflite}", file=sys.stderr)
        return 1

    raw = MODELS / f".{onnx_name}.raw"
    subprocess.run(
        [sys.executable, "-m", "tf2onnx.convert", "--tflite", str(tflite),
         "--output", str(raw), "--opset", "13"],
        check=True,
    )
    # tf2onnx exits 0 while leaving 12 unloadable operators behind -- see the module docstring.
    repair(raw, MODELS / onnx_name)
    raw.unlink(missing_ok=True)

    model = onnx.load(str(MODELS / onnx_name))
    gi, go = model.graph.input[0], model.graph.output[0]
    shape = lambda v: [d.dim_value for d in v.type.tensor_type.shape.dim]
    leftover = [n.op_type for n in model.graph.node if n.domain not in ("", "ai.onnx")]
    print(f"wrote {MODELS / onnx_name}")
    print(f"  input  {gi.name} {shape(gi)}")
    print(f"  output {go.name} {shape(go)}")
    print(f"  nodes  {len(model.graph.node)}   non-standard ops: {leftover or 'none'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
