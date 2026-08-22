#!/usr/bin/env bash
# Fetch MediaPipe assets for background blur / virtual background, and place them
# under public/mediapipe/ so they are served from YOUR OWN origin.
#
# Why self-host instead of using the library defaults?
# @livekit/track-processors loads its wasm from jsdelivr and the segmentation model
# from storage.googleapis.com. Both are unreachable from mainland China, which would
# make the background feature hang forever for those participants. Serving the assets
# from your own domain is the only reliable fix. The app always points at these local
# paths (there is a regression test that pins this).
#
# Usage:  npm run setup:assets      (or: bash scripts/fetch-mediapipe-assets.sh)
# Re-run this after upgrading @mediapipe/tasks-vision so the wasm matches the package.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_SRC="$ROOT/node_modules/@mediapipe/tasks-vision/wasm"
DEST="$ROOT/public/mediapipe"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"

if [ ! -d "$WASM_SRC" ]; then
  echo "error: $WASM_SRC not found. Run 'npm install' first." >&2
  exit 1
fi

mkdir -p "$DEST/wasm"
cp "$WASM_SRC"/* "$DEST/wasm/"
echo "copied wasm runtime -> public/mediapipe/wasm ($(du -sh "$DEST/wasm" | cut -f1))"

if [ -s "$DEST/selfie_segmenter.tflite" ]; then
  echo "model already present, skipping download"
else
  echo "downloading segmentation model..."
  curl -fsSL -o "$DEST/selfie_segmenter.tflite" "$MODEL_URL"
  echo "downloaded model -> public/mediapipe/selfie_segmenter.tflite ($(du -h "$DEST/selfie_segmenter.tflite" | cut -f1))"
fi

echo "done. Background effects are ready to use."
