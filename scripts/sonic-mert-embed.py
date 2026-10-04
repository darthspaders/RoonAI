#!/usr/bin/env python3
"""Compatibility CLI for the shared pinned Sonic analysis adapter.

Use the mert1 environment for v1-330M; mert2 for v2. Custom extraction settings
need a separate registry specification so incompatible vectors cannot collide.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--file", required=True)
parser.add_argument("--model-name", default="m-a-p/MERT-v1-330M")
parser.add_argument("--spec")
parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
parser.add_argument("--revision")
parser.add_argument("--layer", type=int, default=-1)
parser.add_argument("--chunk-seconds", type=float)
parser.add_argument("--max-seconds", type=float)
parser.add_argument("--ffmpeg")
args = parser.parse_args()
if args.ffmpeg:
    os.environ["SONIC_ANALYSIS_FFMPEG"] = args.ffmpeg
module = runpy.run_path(str(Path(__file__).with_name("sonic-analysis-worker.py")), run_name="sonic_analysis_adapter")
catalog = module["CATALOG"]
spec = next((x for x in catalog["analyzers"] if (x["id"] == args.spec if args.spec else x["repo"] == args.model_name)), None)
if not spec or spec["kind"] != "embedding" or not spec["repo"].startswith("m-a-p/MERT"):
    parser.error("Select a pinned MERT spec from config/sonic-analyzers.json; the old unpinned 95M default is retired.")
spec = dict(spec, schemaVersion=catalog["schemaVersion"], preprocessing=f'ffmpeg-mono-{spec["sampleRate"]}-v1')
spec["key"] = "analysis-v1-" + hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:24]
if (args.revision and args.revision != spec["revision"]) or args.layer not in (-1, spec["layer"]) or (args.chunk_seconds and args.chunk_seconds != spec.get("chunkSeconds", spec["windowSeconds"])) or (args.max_seconds and args.max_seconds != spec["windowSeconds"]):
    parser.error("Settings differ from the pinned spec. Add a registry spec for a new experiment.")
device = args.device
if device == "auto":
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
with contextlib.redirect_stdout(sys.stderr):
    result = module["Analyzer"](device).analyze(args.file, module["validated_spec"](spec))
print(json.dumps(dict(result, model=spec["repo"], modelVersion=spec["key"], durationSeconds=result["audioDurationSeconds"],
                      metadata={"revision": spec["revision"], "analysisSpec": spec, "analyzedSeconds": result["analyzedSeconds"]}), allow_nan=False))
