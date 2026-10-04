#!/usr/bin/env python3
"""Compare local sonic embedding providers on a labeled, known track set.

The script stores vectors and nearest-neighbor lists as a JSON artifact. It
does not write Rabbit Hole's SQLite database and does not call TIDAL or Roon.
Use a manifest with stable ids and optional ``group`` values to calculate a
simple same-group precision@k signal.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np


def _load_manifest(path):
    manifest_path = Path(path).resolve()
    with manifest_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    tracks = payload.get("tracks", payload) if isinstance(payload, (dict, list)) else []
    if not isinstance(tracks, list):
        raise ValueError("manifest must be an array or an object with a tracks array")

    result = []
    seen = set()
    for index, item in enumerate(tracks):
        if not isinstance(item, dict) or not item.get("file"):
            raise ValueError(f"manifest track {index + 1} needs a file")
        track = dict(item)
        track_id = str(track.get("id") or Path(track["file"]).stem)
        if track_id in seen:
            raise ValueError(f"duplicate manifest id: {track_id}")
        seen.add(track_id)
        file_path = Path(track["file"])
        if not file_path.is_absolute():
            file_path = manifest_path.parent / file_path
        track["id"] = track_id
        track["file"] = str(file_path.resolve())
        result.append(track)
    if len(result) < 2:
        raise ValueError("manifest needs at least two tracks")
    return result


def _source_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _run_worker(python, worker, track, extra_args):
    command = [python, worker, "--file", track["file"], *extra_args]
    started = time.perf_counter()
    result = subprocess.run(command, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    elapsed = time.perf_counter() - started
    stdout = result.stdout.strip().splitlines()
    payload = None
    if stdout:
        try:
            payload = json.loads(stdout[-1])
        except json.JSONDecodeError:
            payload = None
    if result.returncode or not isinstance(payload, dict) or "vector" not in payload:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}"
        raise RuntimeError(detail)
    vector = np.asarray(payload["vector"], dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    if not len(vector) or not np.isfinite(norm) or norm <= 0:
        raise ValueError("worker returned an empty or zero vector")
    return payload, (vector / norm).astype(np.float32), elapsed


def _neighbors(track_ids, vectors, count):
    matrix = np.stack([vectors[track_id] for track_id in track_ids])
    scores = matrix @ matrix.T
    result = {}
    for index, track_id in enumerate(track_ids):
        order = np.argsort(-scores[index], kind="stable")
        result[track_id] = [
            {"id": track_ids[other], "cosine": round(float(scores[index, other]), 6)}
            for other in order
            if other != index
        ][:count]
    return result


def _same_group_precision(tracks, neighbors, count):
    groups = {track["id"]: track.get("group") or track.get("collection") for track in tracks}
    values = []
    for track in tracks:
        group = groups.get(track["id"])
        if not group:
            continue
        rows = neighbors.get(track["id"], [])[:count]
        if not rows:
            continue
        values.append(sum(groups.get(row["id"]) == group for row in rows) / len(rows))
    return round(float(np.mean(values)), 6) if values else None


def _is_positive(track):
    if track.get("relevance") is not None:
        try:
            return float(track.get("relevance")) > 0
        except (TypeError, ValueError):
            pass
    return str(track.get("label") or track.get("rating") or "").strip().lower() in {
        "positive", "love", "like", "good", "up"
    }


def _rank_metrics(ranking, target_ids, count):
    target_ids = set(target_ids)
    candidate_count = len(ranking)
    metrics = {}
    for k in sorted({10, 20, max(1, int(count))}):
        top = ranking[:k]
        hits = sum(item["id"] in target_ids for item in top)
        denominator = min(k, candidate_count) or 1
        precision = hits / denominator
        recall = hits / len(target_ids) if target_ids else None
        first_hit = next((index + 1 for index, item in enumerate(ranking) if item["id"] in target_ids), None)
        dcg = sum(1 / np.log2(index + 2) for index, item in enumerate(top) if item["id"] in target_ids)
        ideal_hits = min(k, len(target_ids))
        idcg = sum(1 / np.log2(index + 2) for index in range(ideal_hits))
        metrics[f"{k}"] = {
            "hits": hits,
            "precision": round(float(precision), 6),
            "recall": round(float(recall), 6) if recall is not None else None,
            "ndcg": round(float(dcg / idcg), 6) if idcg else None,
            "mrr": round(float(1 / first_hit), 6) if first_hit else 0,
            "hitRate": 1 if hits else 0,
        }
    return metrics


def _held_out_positive_evaluation(tracks, vectors, count):
    """Evaluate recovery of held-out positive tracks from positive centroids.

    A manifest may mark tracks with ``relevance: 1`` and ``split: train`` or
    ``split: test``. Training positives form the centroid; test positives are
    ranked against the remaining analyzed tracks. This is intentionally an
    offline diagnostic and never writes Rabbit Hole state.
    """
    if not vectors:
        return None
    by_id = {track["id"]: track for track in tracks}
    train_ids = [track["id"] for track in tracks if track["id"] in vectors and _is_positive(track) and track.get("split") == "train"]
    test_ids = [track["id"] for track in tracks if track["id"] in vectors and _is_positive(track) and track.get("split") == "test"]
    if not train_ids or not test_ids:
        return None

    def evaluate(scope, scoped_train_ids, scoped_test_ids, centroid_groups=None):
        if centroid_groups is None:
            centroid = np.mean(np.stack([vectors[track_id] for track_id in scoped_train_ids]), axis=0)
            norm = float(np.linalg.norm(centroid))
            if not np.isfinite(norm) or norm <= 0:
                return None
            centroid_groups = [("overall", centroid / norm)]
        excluded = set(scoped_train_ids)
        candidate_ids = [track_id for track_id in vectors if track_id not in excluded]
        ranking = sorted(
            (
                {
                    "id": track_id,
                    "cosine": round(float(max(np.dot(centroid, vectors[track_id]) for _, centroid in centroid_groups)), 6),
                }
                for track_id in candidate_ids
            ),
            key=lambda item: (-item["cosine"], item["id"]),
        )
        return {
            "scope": scope,
            "trainPositiveCount": len(scoped_train_ids),
            "testPositiveCount": len(scoped_test_ids),
            "candidateCount": len(candidate_ids),
            "centroidCount": len(centroid_groups),
            "metrics": _rank_metrics(ranking, scoped_test_ids, count),
            "topNeighbors": ranking[: min(20, len(ranking))],
        }

    result = {
        "overall": evaluate("all", train_ids, test_ids),
        "byCollection": {},
    }
    groups = {}
    for track_id in train_ids:
        collection = by_id[track_id].get("collection") or by_id[track_id].get("group")
        if collection:
            groups.setdefault(collection, []).append(track_id)
    centroid_groups = []
    for collection, scoped_train_ids in sorted(groups.items()):
        if len(scoped_train_ids) < 2:
            continue
        centroid = np.mean(np.stack([vectors[track_id] for track_id in scoped_train_ids]), axis=0)
        norm = float(np.linalg.norm(centroid))
        if np.isfinite(norm) and norm > 0:
            centroid_groups.append((collection, centroid / norm))
    if len(centroid_groups) >= 2:
        result["clusterMax"] = evaluate("cluster-max", train_ids, test_ids, centroid_groups)
    collections = sorted({by_id[track_id].get("collection") for track_id in test_ids if by_id[track_id].get("collection")})
    for collection in collections:
        scoped_train = [track_id for track_id in train_ids if by_id[track_id].get("collection") == collection]
        scoped_test = [track_id for track_id in test_ids if by_id[track_id].get("collection") == collection]
        if len(scoped_train) >= 2 and scoped_test:
            result["byCollection"][collection] = evaluate(collection, scoped_train, scoped_test)
    return result


def _jaccard(left, right):
    left_ids = {item["id"] for item in left}
    right_ids = {item["id"] for item in right}
    union = left_ids | right_ids
    return len(left_ids & right_ids) / len(union) if union else 1.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--essentia-worker", default="scripts/sonic-essentia-embed.py")
    parser.add_argument("--essentia-model", default=None)
    parser.add_argument("--mert-worker", default="scripts/sonic-mert-embed.py")
    parser.add_argument("--mert-model", default="m-a-p/MERT-v1-330M")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--providers", default="essentia,mert")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--ffmpeg", default=None)
    args = parser.parse_args()
    if args.count <= 0:
        raise ValueError("--count must be greater than zero")

    tracks = _load_manifest(args.manifest)
    if args.limit > 0:
        tracks = tracks[: args.limit]
    providers = [name.strip().lower() for name in args.providers.split(",") if name.strip()]
    if not providers:
        raise ValueError("--providers must name at least one provider")
    if "essentia" in providers and not args.essentia_model:
        raise ValueError("--essentia-model is required when essentia is selected")

    track_by_id = {track["id"]: track for track in tracks}
    report = {
        "schemaVersion": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "manifest": os.path.abspath(args.manifest),
        "trackCount": len(tracks),
        "neighborCount": args.count,
        "providers": {},
        "comparison": {},
    }
    provider_vectors = {}

    for provider in providers:
        if provider == "essentia":
            worker = args.essentia_worker
            worker_args = ["--model", args.essentia_model, "--model-name", "discogs_multi_embeddings-effnet-bs64"]
            if args.ffmpeg:
                worker_args.extend(["--ffmpeg", args.ffmpeg])
        elif provider == "mert":
            worker = args.mert_worker
            worker_args = ["--model-name", args.mert_model, "--device", args.device]
            if args.ffmpeg:
                worker_args.extend(["--ffmpeg", args.ffmpeg])
        else:
            raise ValueError(f"unsupported provider: {provider}")

        vectors = {}
        metadata = {}
        errors = []
        for track in tracks:
            try:
                payload, vector, elapsed = _run_worker(args.python, worker, track, worker_args)
                vectors[track["id"]] = vector
                metadata[track["id"]] = {
                    "sourceHash": _source_hash(track["file"]),
                    "file": track["file"],
                    "model": payload.get("model"),
                    "modelVersion": payload.get("modelVersion"),
                    "dimensions": len(vector),
                    "elapsedSeconds": round(elapsed, 3),
                    "sampleRate": payload.get("sampleRate"),
                    "durationSeconds": payload.get("durationSeconds"),
                    "metadata": payload.get("metadata", {}),
                }
            except Exception as error:
                errors.append({"id": track["id"], "file": track["file"], "error": str(error)})

        ready_ids = [track["id"] for track in tracks if track["id"] in vectors]
        dimensions = sorted({len(vectors[track_id]) for track_id in ready_ids})
        neighbors = _neighbors(ready_ids, vectors, args.count) if ready_ids else {}
        elapsed_values = [metadata[track_id]["elapsedSeconds"] for track_id in ready_ids]
        provider_vectors[provider] = vectors
        report["providers"][provider] = {
            "worker": os.path.abspath(worker),
            "readyCount": len(ready_ids),
            "errorCount": len(errors),
            "dimensions": dimensions,
            "totalElapsedSeconds": round(float(sum(elapsed_values)), 3),
            "meanElapsedSeconds": round(float(np.mean(elapsed_values)), 3) if elapsed_values else None,
            "sameGroupPrecisionAtK": _same_group_precision(tracks, neighbors, args.count),
            "heldOutPositiveEvaluation": _held_out_positive_evaluation(tracks, vectors, args.count),
            "tracks": metadata,
            "neighbors": neighbors,
            "errors": errors,
        }

    provider_names = list(provider_vectors)
    if len(provider_names) >= 2:
        agreements = []
        left_name = provider_names[0]
        for right_name in provider_names[1:]:
            shared_ids = sorted(set(provider_vectors[left_name]) & set(provider_vectors[right_name]))
            left_neighbors = report["providers"][left_name]["neighbors"]
            right_neighbors = report["providers"][right_name]["neighbors"]
            pair_values = [
                _jaccard(left_neighbors.get(track_id, []), right_neighbors.get(track_id, []))
                for track_id in shared_ids
            ]
            agreements.append({
                "left": left_name,
                "right": right_name,
                "sharedTrackCount": len(shared_ids),
                "meanNeighborJaccard": round(float(np.mean(pair_values)), 6) if pair_values else None,
            })
        report["comparison"]["providerAgreement"] = agreements

    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")
    print(json.dumps({
        "output": str(output_path),
        "trackCount": len(tracks),
        "providers": {
            name: {
                "ready": data["readyCount"],
                "errors": data["errorCount"],
                "dimensions": data["dimensions"],
                "totalElapsedSeconds": data["totalElapsedSeconds"],
                "meanElapsedSeconds": data["meanElapsedSeconds"],
                "sameGroupPrecisionAtK": data["sameGroupPrecisionAtK"],
                "heldOutPositiveEvaluation": data["heldOutPositiveEvaluation"],
            }
            for name, data in report["providers"].items()
        },
        "comparison": report["comparison"],
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"sonic benchmark failed: {error}", file=sys.stderr)
        sys.exit(1)
