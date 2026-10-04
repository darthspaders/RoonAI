"""Bounded original-source decoding and timestamp policies shared by analyzers."""
import math
import os
import subprocess
import numpy as np


def windows(duration, spec):
    if not math.isfinite(duration) or duration <= 0 or duration > 7200:
        raise ValueError("Audio duration must be between zero and two hours")
    width = min(duration, float(spec["windowSeconds"]))
    last = duration - width
    maximum = int(spec["maxWindows"])
    if spec["policy"] == "center" or last <= 0:
        starts = [last / 2]
    elif spec["policy"] == "spread":
        count = min(maximum, max(1, math.ceil(duration / width)))
        if count % 2 == 0 and count < maximum:
            count += 1  # Include the documented center crop as well as the ends.
        starts = [last / 2] if count == 1 else np.linspace(0, last, count).tolist()
    else:
        hop = width - float(spec.get("overlapSeconds", 0))
        if hop <= 0:
            raise ValueError("Overlap must be smaller than the window")
        count = math.ceil(last / hop) + 1
        # Keep the end of long mixes even when the runtime budget limits windows.
        starts = np.linspace(0, last, maximum).tolist() if count > maximum else [min(i * hop, last) for i in range(count)]
    return [(round(start, 6), round(start + width, 6)) for start in sorted(set(starts))]


def covered_seconds(spans):
    total, covered_end = 0.0, 0.0
    for start, end in sorted(spans):
        total += max(0.0, end - max(start, covered_end))
        covered_end = max(covered_end, end)
    return total


def duration_seconds(file):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], capture_output=True, timeout=30, check=True)
    return float(result.stdout.strip())


def decode(file, start, end, rate=24000):
    # Decode the original compressed/local source, never the reduced EffNet PCM.
    result = subprocess.run([os.environ.get("SONIC_ANALYSIS_FFMPEG", "ffmpeg"), "-nostdin", "-v", "error", "-threads", "2", "-i", file,
                             "-ss", str(start), "-t", str(end - start), "-vn", "-ac", "1", "-ar", str(rate), "-f", "f32le", "pipe:1"],
                            capture_output=True, timeout=120, check=True)
    audio = np.frombuffer(result.stdout, dtype="<f4").copy()
    if not audio.size or not np.isfinite(audio).all():
        raise ValueError("Decoded audio is empty or nonfinite")
    return audio


def normalized(vector):
    value = np.asarray(vector, dtype=np.float32)
    norm = np.linalg.norm(value)
    if not np.isfinite(value).all() or not np.isfinite(norm) or norm <= 0:
        raise ValueError("Invalid embedding")
    return value / norm


def structure_summary(events, seconds):
    beats, chords, sections, notes = [], [], [], 0
    for event in events:
        values = event.get("values", {})
        rhythm = values.get("rhythm", {})
        if "eighth_position" in rhythm:
            beats.append(float(event["time"]))
        if "chord" in values:
            chords.append(values["chord"])
        if "structure" in values:
            sections.append({"time": event["time"], "label": values["structure"]})
        notes += len(values.get("melody", []))
    intervals = np.diff(beats)
    changes = sum(a != b for a, b in zip(chords, chords[1:]))
    return {"melodyNoteOnsetsPerSecond": notes / seconds,
            "chordChangesPerMinute": changes * 60 / seconds,
            "beatIntervalCV": float(np.std(intervals) / np.mean(intervals)) if len(intervals) > 2 and np.mean(intervals) > 0 else None,
            "sections": sections, "estimated": True, "sectionVocabulary": "publisher-labels-not-EDM-drop-labels"}
