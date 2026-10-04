#!/usr/bin/env python3
"""Download only registry-pinned checkpoints. Inference never downloads code."""
import argparse
import hashlib
import json
from pathlib import Path
from huggingface_hub import snapshot_download

parser = argparse.ArgumentParser()
parser.add_argument("--models", default="mert-fullsong,mert-30s,mert-330m,emotion,sheetsage")
args = parser.parse_args()
catalog = json.loads((Path(__file__).resolve().parents[1] / "config/sonic-analyzers.json").read_text())
for name in args.models.split(","):
    spec = next(x for x in catalog["analyzers"] if x["id"] == name)
    directory = Path(snapshot_download(spec["repo"], revision=spec["revision"], allow_patterns=["*.py", "*.json", "*.safetensors", "pytorch_model.bin", "*.onnx", "LICENSE*", "THIRD_PARTY_NOTICES*"], max_workers=3))
    code = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.glob("*.py")}
    print(json.dumps({"model": name, "revision": spec["revision"], "snapshot": str(directory), "codeSha256": code}), flush=True)
