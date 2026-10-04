#!/usr/bin/env python3
"""Emit one normalized Essentia Discogs-EffNet embedding as JSON.

This worker is intentionally separate from the Node app. Run it in WSL/Linux
after installing Essentia and downloading a Discogs-EffNet .pb model. The Node
external-json provider can invoke it without making Python a production
dependency of Rabbit Hole. It accepts either a local audio file or mono
float32 PCM on stdin so the Node pipeline can decode any supported source
before inference.
"""

import argparse
import json
import os
import sys

try:
    import resource
except ImportError:  # pragma: no cover - Windows Python does not expose resource
    resource = None

import numpy as np
from essentia.standard import MonoLoader, TensorflowPredictEffnetDiscogs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file")
    parser.add_argument("--pcm-stdin", action="store_true")
    parser.add_argument("--model", required=True, help="Path to a Discogs-EffNet .pb model")
    parser.add_argument("--model-name", default="discogs_track_embeddings-effnet-bs64-1")
    parser.add_argument("--output", default="PartitionedCall:1")
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--expected-dimensions", type=int, default=1280)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--patch-size", type=int, default=128)
    parser.add_argument("--patch-hop-size", type=int, default=62)
    args = parser.parse_args()

    if bool(args.file) == bool(args.pcm_stdin):
        raise ValueError("provide exactly one of --file or --pcm-stdin")
    if args.sample_rate != 16000:
        raise ValueError("Discogs-EffNet requires 16000 Hz PCM")
    if args.file and not os.path.isfile(args.file):
        raise FileNotFoundError(args.file)
    if not os.path.isfile(args.model):
        raise FileNotFoundError(args.model)

    if args.pcm_stdin:
        audio = np.frombuffer(sys.stdin.buffer.read(), dtype=np.float32)
    else:
        audio = MonoLoader(filename=args.file, sampleRate=16000, resampleQuality=4)()
    if not len(audio):
        raise ValueError("no audio samples were provided")
    model = TensorflowPredictEffnetDiscogs(
        graphFilename=args.model,
        output=args.output,
        batchSize=args.batch_size,
        patchSize=args.patch_size,
        patchHopSize=args.patch_hop_size,
        lastBatchMode="same",
        lastPatchMode="discard",
    )
    raw = np.asarray(model(audio), dtype=np.float32)
    raw_shape = list(raw.shape)
    if raw.ndim == 2 and raw.shape[-1] != args.expected_dimensions:
        raise ValueError(f"selected output {args.output} returned shape {tuple(raw.shape)}, expected final dimension {args.expected_dimensions}")
    if raw.ndim > 1:
        raw = raw.mean(axis=0)
    embedding = raw.reshape(-1)
    if embedding.size != args.expected_dimensions:
        raise ValueError(f"selected output {args.output} returned {embedding.size} values, expected {args.expected_dimensions}")
    norm = float(np.linalg.norm(embedding))
    if not embedding.size or not np.isfinite(norm) or norm <= 0:
        raise ValueError("Essentia returned an empty or zero embedding")
    embedding = (embedding / norm).astype(np.float32)
    device = os.environ.get("RABBIT_HOLE_SONIC_ESSENTIA_RUNTIME_DEVICE", "cpu").strip() or "cpu"
    # Linux/WSL reports ru_maxrss in KiB. Keep this telemetry with the
    # embedding so the Node benchmark can distinguish worker memory from the
    # Windows host process.
    worker_peak_rss_mb = None
    if resource is not None:
        worker_peak_rss_mb = round(float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) / 1024, 1)
    print(json.dumps({
        "model": args.model_name,
        "modelVersion": "1",
        "vector": embedding.tolist(),
        "sampleRate": 16000,
        "audioDurationMs": round(len(audio) / 16000 * 1000),
        "metadata": {
            "provider": "essentia",
            "device": device,
            "workerPeakRssMb": worker_peak_rss_mb,
            "modelName": args.model_name,
            "modelFamily": "Discogs-EffNet",
            "modelPath": args.model,
            "output": args.output,
            "outputPurpose": "embeddings",
            "outputShape": raw_shape,
            "dimensions": int(embedding.size),
            "sampleRate": 16000,
            "channels": 1,
            "patchSize": args.patch_size,
            "patchHopSize": args.patch_hop_size,
            "batchSize": args.batch_size,
            "aggregation": "mean over model output patches"
        }
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
