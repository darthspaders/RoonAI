#!/usr/bin/env python3
"""Analyze a manifest of mono float32 PCM files with one EffNet process.

Keeping the TensorFlow graph alive across multiple tracks separates model
startup cost from steady-state inference and lets the resumable local-library
runner reuse one bounded worker per batch.
"""

import argparse
import json
import os
import sys
import time

try:
    import resource
except ImportError:  # pragma: no cover - Windows Python does not expose resource
    resource = None

import numpy as np
from essentia.standard import TensorflowPredictEffnetDiscogs


def worker_peak_rss_mb():
    if resource is None:
        return None
    return round(float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) / 1024, 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, help="JSON file containing [{id, pcmPath, audioDurationMs}]")
    parser.add_argument("--model", required=True, help="Path to a Discogs-EffNet .pb model")
    parser.add_argument("--model-name", default="discogs_track_embeddings-effnet-bs64-1")
    parser.add_argument("--output", default="PartitionedCall:1")
    parser.add_argument("--expected-dimensions", type=int, default=1280)
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--patch-size", type=int, default=128)
    parser.add_argument("--patch-hop-size", type=int, default=62)
    args = parser.parse_args()

    with open(args.manifest, "r", encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)
    if not isinstance(manifest, list) or not manifest:
        raise ValueError("manifest must contain at least one PCM item")
    if args.sample_rate != 16000:
        raise ValueError("Discogs-EffNet requires 16000 Hz PCM")
    if not os.path.isfile(args.model):
        raise FileNotFoundError(args.model)

    model_started = time.perf_counter()
    model = TensorflowPredictEffnetDiscogs(
        graphFilename=args.model,
        output=args.output,
        batchSize=args.batch_size,
        patchSize=args.patch_size,
        patchHopSize=args.patch_hop_size,
        lastBatchMode="same",
        lastPatchMode="discard",
    )
    model_ready_ms = round((time.perf_counter() - model_started) * 1000, 2)

    device = os.environ.get("RABBIT_HOLE_SONIC_ESSENTIA_RUNTIME_DEVICE", "cpu").strip() or "cpu"
    results = []
    for item in manifest:
        pcm_path = item.get("pcmPath", "")
        item_id = item.get("id", pcm_path)
        try:
            if not os.path.isfile(pcm_path):
                raise FileNotFoundError(pcm_path)
            audio = np.fromfile(pcm_path, dtype=np.float32)
            if not len(audio):
                raise ValueError(f"no PCM samples were provided for {item_id}")
            started = time.perf_counter()
            raw = np.asarray(model(audio), dtype=np.float32)
            embedding_ms = round((time.perf_counter() - started) * 1000, 2)
            raw_shape = list(raw.shape)
            if raw.ndim != 2 or raw.shape[-1] != args.expected_dimensions:
                raise ValueError(
                    f"selected output {args.output} returned shape {tuple(raw.shape)}, "
                    f"expected [patches, {args.expected_dimensions}]"
                )
            vector = raw.mean(axis=0).reshape(-1)
            norm = float(np.linalg.norm(vector))
            if vector.size != args.expected_dimensions or not np.isfinite(norm) or norm <= 0:
                raise ValueError(f"invalid embedding returned for {item_id}")
            vector = vector / norm
            results.append({
                "id": item.get("id", ""),
                "embeddingMs": embedding_ms,
                "audioDurationMs": item.get("audioDurationMs"),
                "dimensions": int(vector.size),
                "normAfterL2": round(float(np.linalg.norm(vector)), 6),
                "outputShape": raw_shape,
                "workerPeakRssMb": worker_peak_rss_mb(),
                "vector": vector.tolist(),
            })
        except Exception as error:
            # A bad/unsupported file should not discard successful embeddings
            # already produced by this warm worker. The Node caller records the
            # failure and can safely retry it on a later resumable pass.
            results.append({
                "id": item.get("id", ""),
                "audioDurationMs": item.get("audioDurationMs"),
                "error": str(error),
                "workerPeakRssMb": worker_peak_rss_mb(),
            })

    print(json.dumps({
        "device": device,
        "model": args.model_name,
        "modelVersion": "1",
        "output": args.output,
        "outputPurpose": "embeddings",
        "dimensions": args.expected_dimensions,
        "sampleRate": args.sample_rate,
        "modelReadyMs": model_ready_ms,
        "items": results,
        "failedCount": sum(1 for item in results if item.get("error")),
        "workerPeakRssMb": worker_peak_rss_mb(),
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
