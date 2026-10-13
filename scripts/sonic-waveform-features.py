#!/usr/bin/env python3
"""Private, bounded CPU descriptors; never inferred taste, mood, or beat labels.

Run with the existing MERT2 Python/numpy and ffmpeg, no package installation.
Manifest v1: items[{identityKey,sourceSha256,sourceType,audioPath,spans:[[s,e]],
durationSeconds,sourceSnapshotKey?}], at most 224 exact sources. Output is fresh
NDJSON, one source-bound record per item; no paths or source audio are emitted.

Spectral novelty and lag autocorrelation follow the primary FMP explanations:
https://www.audiolabs-erlangen.de/resources/MIR/FMP/C6/C6S1_NoveltySpectral.html
https://www.audiolabs-erlangen.de/resources/MIR/FMP/C6/C6S2_TempogramAutocorrelation.html
Tempo octave ambiguity is retained, not resolved using musical assumptions:
https://www.audiolabs-erlangen.de/resources/MIR/FMP/C6/C6S2_TempoBeat.html
This deliberately simple whole-excerpt descriptor is not a beat tracker or a
local tempogram implementation. All thresholds are declared engineering gates,
not calibrated confidence or probabilities of musical correctness.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

# Bound BLAS implementations before importing numpy. FFT work is sequential.
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_name] = "2"
import numpy as np

RATE, FRAME, HOP = 24000, 2048, 240
MIN_SECONDS, MAX_SECONDS, MAX_ITEMS = 8, 30, 224
MAX_SOURCE_BYTES, MAX_TOTAL_SOURCE_BYTES = 1024 ** 3, 16 * 1024 ** 3
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
SPEC = {
    "key": "sonic-waveform-v2-24k-n2048-h240", "version": 2,
    "method": "gain-normalized-multiband-log-spectral-flux-autocorrelation",
    "sampleRate": RATE, "frameSize": FRAME, "hopSize": HOP,
    "window": "hann-symmetric", "bandsHz": [[40, 200], [200, 2000], [2000, 10000]],
    "tempoRangeBpm": [40, 240], "tempoGridBpm": [40, 240, 1],
    "logCompression": 100, "noveltyLocalMeanFrames": 21,
    "onsetPeakMinimum": 0.1, "onsetRefractorySeconds": 0.1,
    "phaseBins": 16, "maximumTempoAlternatives": 5,
    "autocorrelation": "overlap-normalized-centered-novelty; negative-values-zero",
    "levelNormalization": "whole-excerpt-peak; no level-based preference",
    "minimumSeconds": MIN_SECONDS, "maximumSeconds": MAX_SECONDS,
    "decodeSampleTolerance": 1,
    "inputFormats": ["flac", "dsf", "mp3", "wav"],
    "fullScaleExceedance": "diagnostic-only; abs(sample)>1; no clipping inference",
}
GATES = {"version": "waveform-gates-v2", "minimumOnsets": 8,
         "minimumPeriodicity": 0.1,
         "silencePeakMaximum": 1e-7, "silenceRmsMaximum": 1e-8}


class ExtractionError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_item(item):
    if not isinstance(item, dict):
        raise ExtractionError("INVALID_ITEM", "A source item must be an object.")
    allowed = {"identityKey", "sourceSha256", "sourceType", "audioPath", "spans", "durationSeconds", "sourceSnapshotKey"}
    if set(item) - allowed:
        raise ExtractionError("INVALID_ITEM", "Unexpected source item fields.")
    key, sha = item.get("identityKey"), item.get("sourceSha256")
    if not isinstance(key, str) or not key.strip() or len(key) > 1000 or any(ord(c) < 32 for c in key):
        raise ExtractionError("INVALID_IDENTITY", "A nonempty exact identity is required.")
    if not isinstance(sha, str) or not re.fullmatch(r"[a-f0-9]{64}", sha):
        raise ExtractionError("INVALID_HASH", "An exact lowercase SHA256 is required.")
    if item.get("sourceType") not in ("verified-local-file", "beatport-preview"):
        raise ExtractionError("INVALID_SOURCE_TYPE", "An explicit supported source type is required.")
    snapshot = item.get("sourceSnapshotKey")
    if snapshot is not None and (not isinstance(snapshot, str) or not re.fullmatch(r"sonic-source-v1-[a-f0-9]{64}", snapshot)):
        raise ExtractionError("INVALID_SNAPSHOT", "Invalid source snapshot key.")
    if item["sourceType"] == "beatport-preview" and snapshot is None:
        raise ExtractionError("INVALID_SNAPSHOT", "A preview source must retain its frozen snapshot key.")
    duration, spans = item.get("durationSeconds"), item.get("spans")
    if not _finite(duration) or not 0 < duration <= 7200:
        raise ExtractionError("INVALID_DURATION", "Source duration must be finite and bounded.")
    if not isinstance(spans, list) or len(spans) != 1 or not isinstance(spans[0], list) or len(spans[0]) != 2:
        raise ExtractionError("INVALID_SPAN", "Exactly one frozen excerpt is required.")
    start, end = spans[0]
    if not all(_finite(v) for v in (start, end)) or start < 0 or end > duration + 0.000002 or not MIN_SECONDS <= end - start <= MAX_SECONDS + 0.000002:
        raise ExtractionError("INVALID_SPAN", "The frozen excerpt must be 8 to 30 seconds within its source.")
    filename = item.get("audioPath")
    if not isinstance(filename, str) or not filename or len(filename) > 4096 or "\x00" in filename or re.match(r"^[a-z]+://", filename, re.I):
        raise ExtractionError("INVALID_PATH", "A regular local source file is required.")
    return item


def source_hash(filename):
    try:
        file_stat = Path(filename).stat()
        if not stat.S_ISREG(file_stat.st_mode) or not 0 < file_stat.st_size <= MAX_SOURCE_BYTES:
            raise ExtractionError("INVALID_SOURCE_FILE", "Source must be a bounded regular file.")
        digest, total = hashlib.sha256(), 0
        with open(filename, "rb") as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_SOURCE_BYTES:
                    raise ExtractionError("INVALID_SOURCE_FILE", "Source exceeds the byte bound.")
                digest.update(chunk)
        if total != file_stat.st_size:
            raise ExtractionError("SOURCE_CHANGED", "Source byte length changed during hashing.")
        return digest.hexdigest(), total
    except OSError:
        raise ExtractionError("SOURCE_UNAVAILABLE", "The frozen source file is unavailable.") from None


def decode_excerpt(filename, start, end, ffmpeg):
    # Keep MERT's input-before-output-seek ordering and conversion. Protocols
    # are local only, and stdout can contain at most a bounded 30 s waveform.
    command = [ffmpeg, "-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "1",
               "-protocol_whitelist", "file,pipe", "-format_whitelist", ",".join(SPEC["inputFormats"]),
               "-i", str(Path(filename).resolve()),
               "-ss", str(start), "-t", str(end - start), "-map", "0:a:0", "-vn", "-sn", "-dn",
               "-ac", "1", "-ar", str(RATE), "-f", "f32le", "pipe:1"]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ExtractionError("DECODE_FAILED", "Bounded local audio decoding failed.") from None
    maximum_bytes = (MAX_SECONDS * RATE + SPEC["decodeSampleTolerance"]) * 4
    if result.returncode or not result.stdout or len(result.stdout) > maximum_bytes or len(result.stdout) % 4:
        raise ExtractionError("DECODE_FAILED", "Decoded audio is missing, malformed or exceeds its bound.")
    audio = np.frombuffer(result.stdout, dtype="<f4").copy()
    if not np.isfinite(audio).all():
        raise ExtractionError("NONFINITE_AUDIO", "Decoded waveform contains nonfinite samples.")
    expected = round((end - start) * RATE)
    if abs(len(audio) - expected) > SPEC["decodeSampleTolerance"]:
        raise ExtractionError("INCOMPLETE_DECODE", "Decoded sample count differs from the frozen excerpt.")
    return audio, {"sampleRate": RATE, "channels": 1, "samples": len(audio), "expectedSamples": expected,
                   "durationSeconds": len(audio) / RATE, "requestedDurationSeconds": end - start,
                   "sampleCountDifference": len(audio) - expected, "complete": True,
                   "pcmSpanSeconds": [[start, start + len(audio) / RATE]],
                   "pcmSpanInterpretation": "logical output interval with quantized sample count",
                   "samplePeriodSeconds": 1 / RATE, "sampleCountTolerance": SPEC["decodeSampleTolerance"],
                   "seekPolicy": "input-then-output-seek; ffmpeg-accurate-seek", "threads": 2}


def _novelty(magnitude, mask):
    compressed = np.log1p(SPEC["logCompression"] * magnitude[:, mask])
    values = np.zeros(len(magnitude), dtype=np.float64)
    values[1:] = np.maximum(np.diff(compressed, axis=0), 0).sum(axis=1)
    local = np.convolve(values, np.ones(21) / 21, mode="same")
    values = np.maximum(values - local, 0)
    values[:2] = values[-2:] = 0
    maximum = float(values.max())
    return values / maximum if maximum > 1e-12 else np.zeros_like(values)


def _autocorrelation(values):
    centered = values - values.mean()
    bpms = np.arange(40, 241, dtype=np.float64)
    lags = np.arange(25, 152)
    correlations = []
    for lag in lags:
        left, right = centered[:-lag], centered[lag:]
        denominator = float(np.sqrt(np.dot(left, left) * np.dot(right, right)))
        correlations.append(max(0.0, min(1.0, float(np.dot(left, right) / denominator))) if denominator > 1e-12 else 0.0)
    return np.interp(60 * (RATE / HOP) / bpms, lags, correlations)


def _peaks(values):
    candidates = np.where((values[1:-1] > values[:-2]) & (values[1:-1] >= values[2:]) & (values[1:-1] >= 0.1))[0] + 1
    selected = []
    for index in sorted(candidates, key=lambda i: (-float(values[i]), int(i))):
        if all(abs(index - previous) >= 10 for previous in selected):
            selected.append(int(index))
    return np.array(sorted(selected), dtype=np.int64)


def _cross_alignment(left, right):
    # Correlation at zero and strongest +/- quarter-second novelty lag. Positive
    # lag means high-band novelty follows low-band novelty; not syncopation truth.
    left, right = left - left.mean(), right - right.mean()
    scores = []
    for lag in range(-25, 26):
        a, b = (left[:-lag], right[lag:]) if lag > 0 else ((left[-lag:], right[:lag]) if lag < 0 else (left, right))
        denominator = float(np.sqrt(np.dot(a, a) * np.dot(b, b)))
        scores.append(float(np.clip(np.dot(a, b) / denominator, -1, 1)) if denominator > 1e-12 else 0.0)
    best = min(range(len(scores)), key=lambda i: (-scores[i], abs(i - 25), i))
    return scores[25], (best - 25) * HOP / RATE


def describe_waveform(audio):
    """Pure calculation over mono 24 kHz samples; does not mutate the input."""
    samples = np.asarray(audio, dtype=np.float64)
    if samples.ndim != 1 or not MIN_SECONDS * RATE <= samples.size <= MAX_SECONDS * RATE + SPEC["decodeSampleTolerance"] or not np.isfinite(samples).all():
        raise ExtractionError("INVALID_WAVEFORM", "A finite bounded mono 24 kHz excerpt is required.")
    peak, rms = float(np.max(np.abs(samples))), float(np.sqrt(np.mean(samples ** 2)))
    silent = peak <= GATES["silencePeakMaximum"] or rms <= GATES["silenceRmsMaximum"]
    # FFmpeg's MERT-matching -ac 1 float downmix is not clamped integer PCM.
    # Correlated channels or resampling can exceed 1 without clipping. Preserve
    # the observation, never use it as a validity or musical-preference gate.
    # https://www.ffmpeg.org/ffmpeg-resampler.html (rematrix_maxval/volume)
    exceedance = float(np.mean(np.abs(samples) > 1.0))
    diagnostics = {"silent": silent, "fullScaleExceedanceFraction": exceedance,
                   "fullScaleInterpretation": "floating-point mono may exceed full scale; not clipping proof",
                   "level": {"rmsDbfs": float(20 * math.log10(rms)) if rms > 0 else None,
                             "peakDbfs": float(20 * math.log10(peak)) if peak > 0 else None}}
    reliability = {"usable": False, "rhythmUsable": False, "dynamicsUsable": False,
                   "flags": [], "calibrated": False, "gateVersion": GATES["version"], "gates": dict(GATES)}
    if silent:
        reliability["flags"].append("silent-or-near-silent")
        return {"descriptors": None, "reliability": reliability, "diagnostics": diagnostics}
    normalized = samples / peak
    frames = np.lib.stride_tricks.sliding_window_view(normalized, FRAME)[::HOP]
    window = np.hanning(FRAME)
    magnitude = np.empty((len(frames), FRAME // 2 + 1), dtype=np.float32)
    rms_frames = np.empty(len(frames), dtype=np.float64)
    for offset in range(0, len(frames), 128):
        chunk = frames[offset:offset + 128]
        magnitude[offset:offset + len(chunk)] = np.abs(np.fft.rfft(chunk * window, axis=1)) / window.sum()
        rms_frames[offset:offset + len(chunk)] = np.sqrt(np.mean(chunk ** 2, axis=1))
    frequencies = np.fft.rfftfreq(FRAME, 1 / RATE)
    masks = [(frequencies >= low) & (frequencies < high) for low, high in SPEC["bandsHz"]]
    power = magnitude.astype(np.float64) ** 2
    energy = np.array([float(power[:, mask].sum()) for mask in masks])
    balance = energy / energy.sum() if energy.sum() > 0 else np.full(3, 1 / 3)
    curves = [_novelty(magnitude, mask) if share > 1e-6 else np.zeros(len(frames)) for mask, share in zip(masks, balance)]
    novelty = np.mean(curves, axis=0)
    if novelty.max() > 0:
        novelty /= novelty.max()
    acf, low_acf, high_acf = _autocorrelation(novelty), _autocorrelation(curves[0]), _autocorrelation(curves[2])
    maxima = [i for i in range(len(acf)) if acf[i] > 0 and (i == 0 or acf[i] >= acf[i - 1]) and (i == len(acf) - 1 or acf[i] > acf[i + 1])]
    alternatives = []
    for index in sorted(maxima, key=lambda i: (-round(float(acf[i]), 12), -(i + 40))):
        bpm = index + 40
        if all(abs(bpm - alt["bpm"]) >= 4 for alt in alternatives):
            alternatives.append({"bpm": bpm, "autocorrelation": float(acf[index])})
        if len(alternatives) == 5:
            break
    periodicity = float(acf.max())
    ambiguity = min(1.0, alternatives[1]["autocorrelation"] / alternatives[0]["autocorrelation"]) if len(alternatives) > 1 else 0.0
    octave = any(min(abs(a["bpm"] / b["bpm"] - 2), abs(b["bpm"] / a["bpm"] - 2)) <= 0.05
                 and min(a["autocorrelation"], b["autocorrelation"]) >= 0.8 * periodicity
                 for i, a in enumerate(alternatives) for b in alternatives[i + 1:])
    peaks = _peaks(novelty)
    intervals = np.diff(peaks) * HOP / RATE
    interval_cv = float(intervals.std() / intervals.mean()) if len(intervals) >= 2 and intervals.mean() > 0 else None
    profile, concentration = np.full(16, 1 / 16), 0.0
    if alternatives and novelty.sum() > 0:
        period_frames = (RATE / HOP) * 60 / alternatives[0]["bpm"]
        phases = np.mod(np.arange(len(novelty)) / period_frames, 1)
        profile = np.bincount(np.floor(phases * 16).astype(int), weights=novelty, minlength=16)
        profile /= profile.sum()
        concentration = float(abs(np.sum(novelty * np.exp(2j * np.pi * phases))) / novelty.sum())
    cross, lag = _cross_alignment(curves[0], curves[2])
    frame_db = 20 * np.log10(np.maximum(rms_frames, 1e-6))
    centroid = float((power * frequencies).sum() / power.sum()) if power.sum() > 0 else 0.0
    rhythm = {"tempoAlternatives": alternatives, "tempoAutocorrelation": acf.tolist(),
              "periodicityPeak": periodicity, "tempoAmbiguityRatio": ambiguity, "octaveAmbiguous": bool(octave),
              "onsetCount": len(peaks), "onsetRateHz": len(peaks) / (len(samples) / RATE),
              "intervalCv": interval_cv, "phaseConcentration": concentration, "phaseProfile": profile.tolist(),
              "lowPulseStrength": float(low_acf.max()), "highPulseStrength": float(high_acf.max()),
              "lowHighOnsetCorrelation": cross, "lowHighPeakLagSeconds": lag}
    dynamics = {"crestFactorDb": max(0.0, float(20 * math.log10(peak / rms))),
                "rmsVariationDb": float(frame_db.std()), "rmsRangeDb": float(np.percentile(frame_db, 95) - np.percentile(frame_db, 10)),
                "brightnessHz": centroid, "bandBalance": balance.tolist()}
    reliability["rhythmUsable"] = len(peaks) >= GATES["minimumOnsets"] and periodicity >= GATES["minimumPeriodicity"] and interval_cv is not None
    reliability["dynamicsUsable"] = True
    reliability["usable"] = reliability["rhythmUsable"] or reliability["dynamicsUsable"]
    if len(peaks) < GATES["minimumOnsets"]:
        reliability["flags"].append("too-few-detected-onsets")
    if periodicity < GATES["minimumPeriodicity"]:
        reliability["flags"].append("weak-periodicity")
    if octave:
        reliability["flags"].append("tempo-octave-ambiguity")
    diagnostics["frameCount"] = len(frames)
    return {"descriptors": {"rhythm": rhythm, "dynamics": dynamics}, "reliability": reliability, "diagnostics": diagnostics}


def extract_item(item, ffmpeg="ffmpeg"):
    validate_item(item)
    before, byte_length = source_hash(item["audioPath"])
    if before != item["sourceSha256"]:
        raise ExtractionError("SOURCE_HASH_MISMATCH", "Original audio differs from its frozen SHA256.")
    start, end = item["spans"][0]
    audio, decode = decode_excerpt(item["audioPath"], start, end, ffmpeg)
    described = describe_waveform(audio)
    after, after_length = source_hash(item["audioPath"])
    if after != before or after_length != byte_length:
        raise ExtractionError("SOURCE_CHANGED", "Original audio changed during extraction.")
    decode.update({"sourceByteLength": byte_length, "hashVerifiedPrePost": True})
    result = {"version": 1, "status": "ok" if described["reliability"]["usable"] else "unusable",
              "identityKey": item["identityKey"], "sourceSha256": before, "sourceType": item["sourceType"],
              "spans": [list(item["spans"][0])], "spec": dict(SPEC), "decode": decode, **described}
    if item.get("sourceSnapshotKey") is not None:
        result["sourceSnapshotKey"] = item["sourceSnapshotKey"]
    return result


def load_manifest(filename):
    path = Path(filename)
    if not path.is_file() or path.stat().st_size > MAX_MANIFEST_BYTES:
        raise ExtractionError("INVALID_MANIFEST", "A bounded local manifest is required.")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError, UnicodeError):
        raise ExtractionError("INVALID_MANIFEST", "The manifest is invalid JSON.") from None
    if not isinstance(manifest, dict) or set(manifest) != {"version", "items"} or type(manifest["version"]) is not int or manifest["version"] != 1 or not isinstance(manifest["items"], list) or not 1 <= len(manifest["items"]) <= MAX_ITEMS:
        raise ExtractionError("INVALID_MANIFEST", "Manifest v1 must contain one to 224 source items.")
    identities, total_bytes = set(), 0
    for item in manifest["items"]:
        validate_item(item)
        if item["identityKey"] in identities:
            raise ExtractionError("DUPLICATE_IDENTITY", "Duplicate exact identities are not allowed.")
        identities.add(item["identityKey"])
        try:
            source_stat = Path(item["audioPath"]).stat()
            if stat.S_ISREG(source_stat.st_mode):
                total_bytes += source_stat.st_size
        except OSError:
            pass  # Emit a source-specific, unusable error record during the run.
        if total_bytes > MAX_TOTAL_SOURCE_BYTES:
            raise ExtractionError("SOURCE_BUDGET_EXCEEDED", "The manifest exceeds its total original-source byte budget.")
    return manifest["items"]


def preflight_sources(items):
    """Only local stat checks; no hashing, decoding, or output-file creation."""
    total = 0
    for item in items:
        validate_item(item)
        try:
            source_stat = Path(item["audioPath"]).stat()
        except OSError:
            raise ExtractionError("SOURCE_UNAVAILABLE", "A frozen source is unavailable in this runtime.") from None
        if not stat.S_ISREG(source_stat.st_mode) or not 0 < source_stat.st_size <= MAX_SOURCE_BYTES:
            raise ExtractionError("INVALID_SOURCE_FILE", "Each frozen source must be a bounded regular file.")
        total += source_stat.st_size
        if total > MAX_TOTAL_SOURCE_BYTES:
            raise ExtractionError("SOURCE_BUDGET_EXCEEDED", "The sources exceed their total original-source byte budget.")
    return {"sourceCount": len(items), "sourceBytes": total, "valid": True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--print-spec", action="store_true")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--manifest")
    parser.add_argument("--output")
    parser.add_argument("--ffmpeg", default=os.environ.get("SONIC_ANALYSIS_FFMPEG", "ffmpeg"))
    args = parser.parse_args(argv)
    if args.print_spec:
        if args.manifest or args.output or args.preflight:
            raise ExtractionError("INVALID_ARGUMENTS", "Print-spec is separate from extraction.")
        print(json.dumps({"version": 1, "spec": SPEC, "gates": GATES,
                          "bounds": {"maximumItems": MAX_ITEMS, "maximumSourceBytes": MAX_SOURCE_BYTES,
                                     "maximumTotalSourceBytes": MAX_TOTAL_SOURCE_BYTES,
                                     "maximumManifestBytes": MAX_MANIFEST_BYTES},
                          "calibrated": False, "productionApplied": False}, sort_keys=True, allow_nan=False))
        return 0
    if args.preflight:
        if not args.manifest or args.output:
            raise ExtractionError("INVALID_ARGUMENTS", "Preflight requires only a manifest, with no output file.")
        print(json.dumps(preflight_sources(load_manifest(args.manifest)), sort_keys=True), flush=True)
        return 0
    if not args.manifest or not args.output:
        raise ExtractionError("INVALID_ARGUMENTS", "Extraction requires manifest and fresh output arguments.")
    items = load_manifest(args.manifest)
    output = Path(args.output).resolve()
    if output == Path(args.manifest).resolve() or any(output == Path(item["audioPath"]).resolve() for item in items):
        raise ExtractionError("INVALID_OUTPUT", "Output must be separate from source and manifest files.")
    failures = 0
    with open(output, "x", encoding="utf-8", newline="\n") as stream:
        for item in items:
            try:
                record = extract_item(item, args.ffmpeg)
            except ExtractionError as error:
                failures += 1
                record = {"version": 1, "status": "error", "identityKey": item["identityKey"],
                          "sourceSha256": item["sourceSha256"], "sourceType": item["sourceType"], "spans": item["spans"],
                          "spec": dict(SPEC), "error": {"code": error.code, "message": str(error)},
                          "descriptors": None, "reliability": {"usable": False, "rhythmUsable": False,
                          "dynamicsUsable": False, "calibrated": False, "flags": [error.code], "gateVersion": GATES["version"]}}
                if item.get("sourceSnapshotKey") is not None:
                    record["sourceSnapshotKey"] = item["sourceSnapshotKey"]
            stream.write(json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n")
            stream.flush()
            print(json.dumps({"identityKey": item["identityKey"], "status": record["status"]}, separators=(",", ":")), flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ExtractionError, OSError) as error:
        # No raw decoder stderr, private filenames, URLs, or credentials.
        print(str(error) if isinstance(error, ExtractionError) else "Private manifest/output file access failed.", file=sys.stderr)
        sys.exit(2)
