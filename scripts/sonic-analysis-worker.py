#!/usr/bin/env python3
"""Warm, offline-only, pinned analysis workers. NDJSON in/out; logs on stderr."""
import argparse
import contextlib
import gc
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import time
import traceback
import numpy as np
from sonic_analysis_audio import windows, covered_seconds, duration_seconds, decode, normalized, structure_summary

CATALOG = json.loads((Path(__file__).resolve().parents[1] / "config/sonic-analyzers.json").read_text())
CODE_HASHES = json.loads((Path(__file__).resolve().parents[1] / "config/sonic-model-code-sha256.json").read_text())


def validated_spec(proposed):
    spec = next(dict(x, schemaVersion=CATALOG["schemaVersion"], preprocessing=f'ffmpeg-mono-{x["sampleRate"]}-v1') for x in CATALOG["analyzers"] if x["id"] == proposed["id"])
    spec["key"] = "analysis-v1-" + hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()[:24]
    if spec != proposed:
        raise ValueError("Analyzer specification differs from the pinned registry")
    return spec


class ResourceBusy(RuntimeError):
    pass


class Analyzer:
    def __init__(self, device="cuda"):
        self.device = device
        self.model = None
        self.processor = None
        self.loaded = None

    def load(self, spec):
        signature = (spec["repo"], spec["revision"])
        if signature == self.loaded:
            return 0
        started = time.monotonic()
        self.model = self.processor = self.loaded = None
        gc.collect()
        if "torch" in sys.modules and sys.modules["torch"].cuda.is_available():
            sys.modules["torch"].cuda.empty_cache()
        if spec["runtime"] == "effnet":
            from essentia.standard import TensorflowPredictEffnetDiscogs
            graph = Path.home() / "rabbit-hole-sonic-models/discogs_track_embeddings-effnet-bs64-1.pb"
            if hashlib.sha256(graph.read_bytes()).hexdigest() != spec["revision"]:
                raise ValueError("Discogs baseline graph hash mismatch")
            self.model = TensorflowPredictEffnetDiscogs(graphFilename=str(graph), output="PartitionedCall:1", batchSize=64, patchSize=128, patchHopSize=62, lastBatchMode="same", lastPatchMode="discard")
            self.loaded = signature
            return time.monotonic() - started
        from huggingface_hub import snapshot_download
        snapshot = snapshot_download(spec["repo"], revision=spec["revision"], local_files_only=True)
        reviewed = CODE_HASHES[spec["repo"]]
        if reviewed["revision"] != spec["revision"]:
            raise ValueError("Model code revision has not been reviewed")
        for filename, expected in reviewed["files"].items():
            if hashlib.sha256((Path(snapshot) / filename).read_bytes()).hexdigest() != expected:
                raise ValueError(f"Model code integrity mismatch: {filename}")
        if spec["kind"] == "emotion":
            import onnxruntime as ort
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 2
            opts.inter_op_num_threads = 1
            self.model = ort.InferenceSession(str(Path(snapshot) / "mert_emotion_int8.onnx"), sess_options=opts, providers=["CPUExecutionProvider"])
        else:
            import torch
            from transformers import AutoFeatureExtractor, AutoModel
            torch.set_num_threads(2)
            if self.device == "cuda":
                if not torch.cuda.is_available():
                    raise ResourceBusy("CUDA unavailable; optional analysis remains queued")
                torch.cuda.empty_cache()
                free, total = torch.cuda.mem_get_info()
                if free < 6 * 1024 ** 3:
                    raise ResourceBusy("Less than 6 GiB GPU memory available; optional analysis deferred")
                # Bound our allocator; never evict another application's model.
                torch.cuda.set_per_process_memory_fraction(min(.35, (free - 2 * 1024 ** 3) / total))
                torch.cuda.reset_peak_memory_stats()
            options = dict(revision=spec["revision"], code_revision=spec["revision"], trust_remote_code=True, local_files_only=True, torch_dtype=torch.float32)
            if spec["runtime"] != "mert1":
                options["attn_implementation"] = "sdpa"
            # SheetSage's loader merges its pinned adapters in FP32 before moving.
            self.model = AutoModel.from_pretrained(spec["repo"], **options).eval().to(self.device)
            if spec["kind"] == "embedding":
                self.processor = AutoFeatureExtractor.from_pretrained(spec["repo"], revision=spec["revision"], code_revision=spec["revision"], trust_remote_code=True, local_files_only=True)
        self.loaded = signature
        return time.monotonic() - started

    def embedding(self, audio, spec):
        import torch
        chunks, weights = [], []
        size = round(spec.get("chunkSeconds", spec["windowSeconds"]) * spec["sampleRate"])
        for start in range(0, len(audio), size):
            piece = audio[start:start + size]
            inputs = self.processor(piece, sampling_rate=spec["sampleRate"], return_tensors="pt")
            inputs = {k: v.to(self.device) for k, v in inputs.items()}
            layer = spec["layer"]
            intermediate = layer != self.model.config.num_hidden_layers
            with torch.inference_mode():
                out = self.model(**inputs, output_hidden_states=intermediate)
                frames = out.last_hidden_state if not intermediate else out.hidden_states[layer if spec["runtime"] == "mert1" else layer - 1]
                mask = getattr(out, "feature_attention_mask", None)
                if mask is None and "attention_mask" in inputs:
                    mask = self.model._get_feature_vector_attention_mask(frames.shape[1], inputs["attention_mask"])
                if mask is None:
                    pooled = frames.mean(1)
                else:
                    mask = mask[..., None].to(frames.dtype)
                    pooled = (frames * mask).sum(1) / mask.sum(1).clamp_min(1)
                chunks.append(normalized(pooled[0].float().cpu().numpy()))
                weights.append(len(piece))
            del out, frames, inputs
        return normalized(np.average(chunks, axis=0, weights=weights))

    def analyze(self, file, spec):
        start = time.monotonic()
        duration = duration_seconds(file)
        plan = windows(duration, spec)
        load_seconds = self.load(spec)
        segments, vectors, events = [], [], []
        for begin, end in plan:
            audio = decode(file, begin, end, spec["sampleRate"])
            end = min(end, begin + len(audio) / spec["sampleRate"])
            segment = {"start": begin, "end": end}
            if spec["kind"] == "embedding":
                vector = normalized(np.asarray(self.model(audio)).mean(axis=0)) if spec["runtime"] == "effnet" else self.embedding(audio, spec)
                vectors.append(vector)
                segment["vector"] = vector.tolist()
            elif spec["kind"] == "emotion":
                # The documented model consumes exactly 15 s. Preserve estimates
                # before clipping; they are regressions, not probabilities.
                target = spec["sampleRate"] * 15
                audio = np.pad(audio[:target], (0, max(0, target - len(audio))))
                output = self.model.run(["valence_arousal"], {"audio_waveform": audio[None].astype(np.float32)})[0].reshape(-1)
                if output.shape != (2,) or not np.isfinite(output).all():
                    raise ValueError("Invalid valence/arousal output")
                segment.update(valence=float(output[0]), arousal=float(output[1]))
            else:
                result = self.model.transcribe(audio, sampling_rate=spec["sampleRate"], dtype="fp32")
                for event in result["events"]:
                    event = json.loads(json.dumps(event))
                    event["time"] += begin
                    for note in event.get("values", {}).get("melody", []):
                        if "end_time" in note:
                            note["end_time"] += begin
                    events.append(event)
                if len(events) > 5000:
                    raise ValueError("Structural event limit exceeded")
            segments.append(segment)
        analyzed = covered_seconds([(x["start"], x["end"]) for x in segments])
        result = dict(specKey=spec["key"], revision=spec["revision"], sampleRate=spec["sampleRate"], audioDurationSeconds=duration,
                      analyzedSeconds=analyzed, sourceCoverage=min(1, analyzed / duration), segments=segments,
                      timings={"loadSeconds": load_seconds, "totalSeconds": time.monotonic() - start})
        if vectors:
            result["vector"] = normalized(np.average(vectors, axis=0, weights=[x["end"] - x["start"] for x in segments])).tolist()
        elif spec["kind"] == "emotion":
            center = min(segments, key=lambda x: abs((x["start"] + x["end"]) / 2 - duration / 2))
            result["estimates"] = {"centerValence": center["valence"], "centerArousal": center["arousal"], "estimated": True}
        else:
            result["events"] = events
            result["estimates"] = structure_summary(events, analyzed)
        if spec["kind"] != "emotion" and spec["runtime"] != "effnet":
            import torch
            result["timings"]["peakGpuBytes"] = torch.cuda.max_memory_allocated() if self.device == "cuda" else 0
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    args = parser.parse_args()
    analyzer = Analyzer(args.device)
    print(json.dumps({"ready": True, "pid": os.getpid()}), flush=True)
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("Analysis exceeded eight minutes")))
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            spec = validated_spec(request["spec"])
            signal.alarm(480)
            with contextlib.redirect_stdout(sys.stderr):
                result = analyzer.analyze(request["file"], spec)
            message = {"id": request["id"], "result": result}
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            message = {"id": request.get("id"), "error": {"message": str(exc), "code": "SONIC_RESOURCE_BUSY" if isinstance(exc, ResourceBusy) else "SONIC_ANALYSIS_FAILED"}}
        finally:
            signal.alarm(0)
        print(json.dumps(message, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
