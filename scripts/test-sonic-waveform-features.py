#!/usr/bin/env python3
"""Synthetic-only CPU tests. No catalogue, runtime database, or listening audio."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import wave

spec = importlib.util.spec_from_file_location("waveform_features", Path(__file__).with_name("sonic-waveform-features.py"))
feature = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feature)
np = feature.np


def pulses(times, seconds=30, rate=24000):
    audio = np.zeros(round(seconds * rate), dtype=np.float64)
    t = np.arange(round(0.09 * rate)) / rate
    pulse = 0.35 * np.sin(2 * np.pi * 80 * t) * np.exp(-t / 0.022)
    pulse += 0.10 * np.sin(2 * np.pi * 4000 * t) * np.exp(-t / 0.011)
    for start in times:
        first = round(float(start) * rate)
        if 0 <= first < len(audio):
            count = min(len(pulse), len(audio) - first)
            audio[first:first + count] += pulse[:count]
    return audio


def write_wave(path, audio, rate=24000, stereo=False):
    pcm = np.round(np.clip(audio, -1, 1) * 32767).astype("<i2")
    if stereo:
        pcm = np.column_stack([pcm, pcm]).ravel()
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2 if stereo else 1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(pcm.tobytes())


def item_for(path, spans=None, source_type="verified-local-file", identity="text:synthetic-pulse"):
    item = {"identityKey": identity, "sourceSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "sourceType": source_type, "audioPath": str(path), "spans": spans or [[0, 30]], "durationSeconds": 30}
    if source_type == "beatport-preview":
        item["sourceSnapshotKey"] = "sonic-source-v1-" + "a" * 64
    return item


class DescriptorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.regular = pulses(np.arange(0.3, 29.8, 0.5))
        rng = np.random.default_rng(12451)
        cls.irregular = pulses(np.cumsum(rng.uniform(0.22, 1.18, 60)))
        cls.regular_result = feature.describe_waveform(cls.regular)
        cls.irregular_result = feature.describe_waveform(cls.irregular)

    def test_regular_and_irregular_timing_have_different_measured_regularity(self):
        regular = self.regular_result["descriptors"]["rhythm"]
        irregular = self.irregular_result["descriptors"]["rhythm"]
        self.assertGreaterEqual(regular["onsetCount"], 50)
        self.assertLess(regular["intervalCv"], 0.05)
        self.assertGreater(irregular["intervalCv"], 0.25)
        self.assertGreater(regular["periodicityPeak"], 0.95)
        self.assertLess(irregular["periodicityPeak"], 0.65)
        self.assertTrue(self.regular_result["reliability"]["rhythmUsable"])

    def test_tempo_alternatives_keep_half_time_and_octave_ambiguity(self):
        rhythm = self.regular_result["descriptors"]["rhythm"]
        bpms = [item["bpm"] for item in rhythm["tempoAlternatives"]]
        self.assertTrue(any(abs(bpm - 120) <= 2 for bpm in bpms))
        self.assertTrue(any(abs(bpm - 60) <= 2 for bpm in bpms))
        self.assertTrue(rhythm["octaveAmbiguous"])
        half = feature.describe_waveform(pulses(np.arange(0.3, 29.8, 1.0)))["descriptors"]["rhythm"]
        self.assertTrue(any(abs(item["bpm"] - 60) <= 2 for item in half["tempoAlternatives"]))
        self.assertLess(half["onsetRateHz"], rhythm["onsetRateHz"] * 0.6)
        self.assertEqual(len(rhythm["tempoAutocorrelation"]), 201)
        self.assertGreaterEqual(rhythm["tempoAmbiguityRatio"], 0.8)

    def test_measured_shape_and_dynamics_are_gain_invariant(self):
        before = self.regular.copy()
        gain = 0.137
        quiet = feature.describe_waveform(self.regular * gain)
        for family in ("rhythm", "dynamics"):
            left, right = self.regular_result["descriptors"][family], quiet["descriptors"][family]
            for key, value in left.items():
                if key == "tempoAlternatives":
                    self.assertEqual(value, right[key])
                elif isinstance(value, (list, float)):
                    np.testing.assert_allclose(value, right[key], rtol=1e-7, atol=1e-7, err_msg=key)
                else:
                    self.assertEqual(value, right[key])
        delta = quiet["diagnostics"]["level"]["rmsDbfs"] - self.regular_result["diagnostics"]["level"]["rmsDbfs"]
        self.assertAlmostEqual(delta, 20 * math.log10(gain), places=8)
        np.testing.assert_array_equal(before, self.regular)

    def test_phase_and_band_shares_have_declared_normalizations(self):
        descriptors = self.regular_result["descriptors"]
        phase, bands = descriptors["rhythm"]["phaseProfile"], descriptors["dynamics"]["bandBalance"]
        self.assertEqual(len(phase), 16); self.assertEqual(len(bands), 3)
        for values in (phase, bands):
            self.assertAlmostEqual(sum(values), 1, places=8)
            self.assertTrue(all(math.isfinite(value) and 0 <= value <= 1 for value in values))
        self.assertGreaterEqual(descriptors["dynamics"]["crestFactorDb"], 0)
        self.assertGreaterEqual(descriptors["dynamics"]["rmsRangeDb"], 0)
        self.assertLessEqual(descriptors["dynamics"]["brightnessHz"], 12000)
        self.assertFalse(self.regular_result["reliability"]["calibrated"])

    def test_low_high_alignment_changes_when_high_band_onsets_shift(self):
        times = np.arange(0.3, 29.8, 0.5)
        audio = np.zeros(30 * feature.RATE)
        t = np.arange(round(0.09 * feature.RATE)) / feature.RATE
        low = 0.3 * np.sin(2 * np.pi * 80 * t) * np.exp(-t / .022)
        high = .1 * np.sin(2 * np.pi * 4000 * t) * np.exp(-t / .011)
        for time in times:
            for delay, pulse in ((0, low), (.15, high)):
                first = round((time + delay) * feature.RATE)
                audio[first:first + len(pulse)] += pulse[:len(audio) - first]
        shifted = feature.describe_waveform(audio)["descriptors"]["rhythm"]
        aligned = self.regular_result["descriptors"]["rhythm"]
        self.assertLess(abs(aligned["lowHighPeakLagSeconds"]), .03)
        self.assertAlmostEqual(shifted["lowHighPeakLagSeconds"], .15, delta=.025)
        self.assertLess(shifted["lowHighOnsetCorrelation"], aligned["lowHighOnsetCorrelation"])

    def test_silence_is_unusable_and_float_exceedance_is_diagnostic_only(self):
        silent = feature.describe_waveform(np.zeros(30 * feature.RATE))
        self.assertIsNone(silent["descriptors"])
        self.assertFalse(silent["reliability"]["usable"])
        self.assertTrue(silent["diagnostics"]["silent"])
        self.assertIsNone(silent["diagnostics"]["level"]["rmsDbfs"])
        floating = feature.describe_waveform(self.regular * 6)
        self.assertTrue(floating["reliability"]["dynamicsUsable"])
        self.assertTrue(floating["reliability"]["rhythmUsable"])
        self.assertGreater(floating["diagnostics"]["fullScaleExceedanceFraction"], 0)
        self.assertNotIn("clipped-waveform", floating["reliability"]["flags"])
        self.assertNotIn("maximumClippingFraction", floating["reliability"]["gates"])
        encoded = json.dumps(floating, allow_nan=False)
        for forbidden in ('"genre"', '"mood"', '"confidence"', '"energyPreference"'):
            self.assertNotIn(forbidden, encoded)

    def test_short_nonfinite_multichannel_and_oversized_waveforms_reject(self):
        bad = [np.zeros(7 * feature.RATE), np.zeros(31 * feature.RATE), np.zeros((8 * feature.RATE, 2)),
               np.full(8 * feature.RATE, np.nan), np.full(8 * feature.RATE, np.inf)]
        for audio in bad:
            with self.assertRaises(feature.ExtractionError):
                feature.describe_waveform(audio)


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.audio = self.directory / "synthetic.wav"
        write_wave(self.audio, pulses(np.arange(.3, 29.8, .5)))
        self.item = item_for(self.audio)
        self.ffmpeg = os.environ.get("SONIC_ANALYSIS_FFMPEG") or shutil.which("ffmpeg")

    def test_manifest_bounds_identity_uniqueness_and_strict_provenance(self):
        bad = [dict(self.item, sourceSha256="not-a-hash"), dict(self.item, sourceType="local"),
               dict(self.item, spans=[[0, 31]]), dict(self.item, spans=[[0, 4]]),
               dict(self.item, spans=[[0, 15], [15, 30]]), dict(self.item, durationSeconds=True),
               dict(self.item, audioPath="https://example.com/audio"), dict(self.item, mood="driving"),
               dict(self.item, sourceType="beatport-preview"), dict(self.item, sourceSnapshotKey="fake-key")]
        for item in bad:
            with self.assertRaises(feature.ExtractionError):
                feature.validate_item(item)
        filename = self.directory / "manifest.json"
        for manifest in ({"version": 1, "items": [self.item, self.item]}, {"version": 1, "items": [self.item] * 225},
                         {"version": 1, "items": []}, {"version": 1, "items": [self.item], "fitLabels": []}):
            filename.write_text(json.dumps(manifest))
            with self.assertRaises(feature.ExtractionError):
                feature.load_manifest(filename)

    def test_decode_binds_exact_span_hash_mono_rate_and_quantized_sample_count(self):
        if not self.ffmpeg:
            self.skipTest("Existing ffmpeg is unavailable")
        audio48 = self.directory / "stereo48.wav"
        write_wave(audio48, pulses(np.arange(3.3, 11, .5), rate=48000), rate=48000, stereo=True)
        item = item_for(audio48, [[3, 11]], "beatport-preview", "tidal:123")
        before = copy.deepcopy(item)
        record = feature.extract_item(item, self.ffmpeg)
        self.assertEqual(record["spans"], [[3, 11]])
        self.assertEqual(record["sourceSha256"], item["sourceSha256"])
        self.assertEqual(record["sourceSnapshotKey"], item["sourceSnapshotKey"])
        self.assertEqual(record["identityKey"], "tidal:123")
        self.assertEqual(record["decode"]["sampleRate"], 24000)
        self.assertEqual(record["decode"]["channels"], 1)
        self.assertEqual(record["decode"]["samples"], 8 * 24000)
        self.assertEqual(record["decode"]["pcmSpanSeconds"], [[3, 11]])
        self.assertTrue(record["decode"]["complete"])
        self.assertTrue(record["decode"]["hashVerifiedPrePost"])
        self.assertGreaterEqual(record["descriptors"]["rhythm"]["onsetCount"], 12)
        self.assertNotIn(str(self.directory), json.dumps(record))
        self.assertEqual(before, item)

    def test_source_and_aggregate_byte_budgets_fail_before_decoding(self):
        with patch.object(feature, "MAX_SOURCE_BYTES", 100):
            with self.assertRaisesRegex(feature.ExtractionError, "bounded"):
                feature.source_hash(self.audio)
        filename = self.directory / "manifest.json"
        filename.write_text(json.dumps({"version": 1, "items": [self.item]}))
        with patch.object(feature, "MAX_TOTAL_SOURCE_BYTES", 100):
            with self.assertRaisesRegex(feature.ExtractionError, "budget"):
                feature.load_manifest(filename)

    def test_correlated_stereo_float_downmix_overs_preserve_gain_invariant_descriptors(self):
        if not self.ffmpeg:
            self.skipTest("Existing ffmpeg is unavailable")
        raw = pulses(np.arange(.3, 29.8, .5))
        raw *= .9 / np.max(np.abs(raw))
        mono_path, stereo_path = self.directory / "mono.wav", self.directory / "correlated-stereo.wav"
        write_wave(mono_path, raw)
        write_wave(stereo_path, raw, stereo=True)
        mono, _ = feature.decode_excerpt(mono_path, 0, 30, self.ffmpeg)
        stereo_mono, _ = feature.decode_excerpt(stereo_path, 0, 30, self.ffmpeg)
        self.assertLess(np.max(np.abs(mono)), 1)
        self.assertGreater(np.max(np.abs(stereo_mono)), 1)
        decoded = feature.describe_waveform(stereo_mono)
        original = feature.describe_waveform(mono)
        self.assertTrue(decoded["reliability"]["rhythmUsable"])
        self.assertTrue(decoded["reliability"]["dynamicsUsable"])
        self.assertGreater(decoded["diagnostics"]["fullScaleExceedanceFraction"], 0)
        self.assertGreater(decoded["diagnostics"]["level"]["peakDbfs"], 0)
        for family in ("rhythm", "dynamics"):
            for key, value in original["descriptors"][family].items():
                actual = decoded["descriptors"][family][key]
                if key == "tempoAlternatives":
                    self.assertEqual([alt["bpm"] for alt in value], [alt["bpm"] for alt in actual])
                    np.testing.assert_allclose([alt["autocorrelation"] for alt in value], [alt["autocorrelation"] for alt in actual], atol=1e-5)
                elif isinstance(value, (list, float)):
                    np.testing.assert_allclose(value, actual, rtol=1e-5, atol=1e-5, err_msg=key)
                else:
                    self.assertEqual(value, actual)

    def test_preflight_only_checks_accessible_regular_sources_and_never_creates_output(self):
        filename = self.directory / "manifest.json"
        filename.write_text(json.dumps({"version": 1, "items": [self.item]}))
        with contextlib.redirect_stdout(io.StringIO()) as stdout, patch.object(feature, "decode_excerpt") as decoder, patch.object(feature, "source_hash") as hasher:
            self.assertEqual(feature.main(["--preflight", "--manifest", str(filename)]), 0)
            decoder.assert_not_called(); hasher.assert_not_called()
        self.assertEqual(json.loads(stdout.getvalue()), {"sourceCount": 1, "sourceBytes": self.audio.stat().st_size, "valid": True})
        unavailable = dict(self.item, audioPath=str(self.directory / "not-mounted.wav"))
        filename.write_text(json.dumps({"version": 1, "items": [self.item, dict(unavailable, identityKey="text:missing-source")]}))
        with self.assertRaisesRegex(feature.ExtractionError, "unavailable"):
            feature.main(["--preflight", "--manifest", str(filename)])
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()), ["manifest.json", "synthetic.wav"])

    def test_wrong_hash_source_change_and_truncated_decode_fail_closed(self):
        if not self.ffmpeg:
            self.skipTest("Existing ffmpeg is unavailable")
        with self.assertRaisesRegex(feature.ExtractionError, "SHA256"):
            feature.extract_item(dict(self.item, sourceSha256="b" * 64), self.ffmpeg)
        original_decode = feature.decode_excerpt
        def changing_decode(*args):
            result = original_decode(*args)
            with self.audio.open("ab") as stream:
                stream.write(b"changed")
            return result
        with patch.object(feature, "decode_excerpt", changing_decode):
            with self.assertRaisesRegex(feature.ExtractionError, "changed"):
                feature.extract_item(self.item, self.ffmpeg)
        tiny = self.directory / "tiny.wav"
        write_wave(tiny, np.zeros(4 * feature.RATE))
        # Forged claimed duration cannot rescue the actual short decoded file.
        with self.assertRaises(feature.ExtractionError):
            feature.extract_item(item_for(tiny), self.ffmpeg)

    def test_fresh_ndjson_has_safe_complete_records_and_never_overwrites(self):
        if not self.ffmpeg:
            self.skipTest("Existing ffmpeg is unavailable")
        filename, output = self.directory / "manifest.json", self.directory / "features.ndjson"
        invalid_hash = dict(self.item, identityKey="text:wrong-hash", sourceSha256="c" * 64)
        filename.write_text(json.dumps({"version": 1, "items": [self.item, invalid_hash]}))
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            code = feature.main(["--manifest", str(filename), "--output", str(output), "--ffmpeg", self.ffmpeg])
        self.assertEqual(code, 1)
        records = [json.loads(line) for line in output.read_text().splitlines()]
        self.assertEqual([record["status"] for record in records], ["ok", "error"])
        self.assertEqual(records[1]["error"]["code"], "SOURCE_HASH_MISMATCH")
        self.assertFalse(records[1]["reliability"]["usable"])
        self.assertNotIn(str(self.directory), output.read_text())
        self.assertEqual(len(stdout.getvalue().splitlines()), 2)
        before = output.read_bytes()
        with self.assertRaises(FileExistsError):
            feature.main(["--manifest", str(filename), "--output", str(output), "--ffmpeg", self.ffmpeg])
        self.assertEqual(output.read_bytes(), before)

    def test_playlist_indirection_cannot_replace_hashed_audio(self):
        if not self.ffmpeg:
            self.skipTest("Existing ffmpeg is unavailable")
        playlist = self.directory / "indirect.ffconcat"
        playlist.write_text("ffconcat version 1.0\nfile 'synthetic.wav'\n")
        # The manifest hash covers only playlist text, not referenced WAV bytes.
        # Reject it even though ffmpeg could otherwise decode a local playlist.
        with self.assertRaises(feature.ExtractionError):
            feature.extract_item(item_for(playlist), self.ffmpeg)

    def test_print_spec_needs_no_files_and_is_deterministic(self):
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(feature.main(["--print-spec"]), 0)
        exported = json.loads(stdout.getvalue())
        self.assertEqual(exported["spec"], feature.SPEC)
        self.assertEqual(exported["gates"], feature.GATES)
        self.assertFalse(exported["calibrated"])
        self.assertEqual(exported["spec"]["version"], 2)
        self.assertEqual(exported["spec"]["key"], "sonic-waveform-v2-24k-n2048-h240")
        self.assertEqual(exported["gates"]["version"], "waveform-gates-v2")
        self.assertNotIn("maximumClippingFraction", exported["gates"])
        self.assertEqual(exported["spec"]["decodeSampleTolerance"], 1)
        self.assertEqual(exported["spec"]["inputFormats"], ["flac", "dsf", "mp3", "wav"])
        self.assertEqual(exported["bounds"]["maximumSourceBytes"], 1024 ** 3)
        self.assertEqual(exported["bounds"]["maximumTotalSourceBytes"], 16 * 1024 ** 3)


if __name__ == "__main__":
    unittest.main()
