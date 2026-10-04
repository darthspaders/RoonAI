import unittest
import numpy as np
from sonic_analysis_audio import windows, covered_seconds, normalized, structure_summary


class AudioPolicyTests(unittest.TestCase):
    def test_common_window_is_identical_for_all_short_clip_encoders(self):
        for chunk in [5, 30]:
            self.assertEqual(windows(360, {"windowSeconds": 30, "policy": "center", "maxWindows": 1, "chunkSeconds": chunk}), [(165, 195)])

    def test_long_track_keeps_tail_and_counts_overlap_once(self):
        plan = windows(600, {"windowSeconds": 120, "overlapSeconds": 30, "policy": "overlap", "maxWindows": 8})
        self.assertEqual(plan[0][0], 0)
        self.assertEqual(plan[-1][1], 600)
        self.assertEqual(covered_seconds(plan), 600)
        bounded = windows(1800, {"windowSeconds": 120, "overlapSeconds": 30, "policy": "overlap", "maxWindows": 8})
        self.assertEqual(len(bounded), 8)
        self.assertEqual(bounded[-1][1], 1800)
        self.assertLess(covered_seconds(bounded), 1800)

    def test_short_preview_never_becomes_full_recording_evidence(self):
        self.assertEqual(windows(8, {"windowSeconds": 15, "policy": "spread", "maxWindows": 5}), [(0, 8)])
        self.assertIn((7.5, 22.5), windows(30, {"windowSeconds": 15, "policy": "spread", "maxWindows": 5}))

    def test_nonfinite_and_zero_vectors_fail(self):
        for bad in [[0, 0], [1, float("nan")]]:
            with self.assertRaises(ValueError):
                normalized(bad)
        self.assertAlmostEqual(float(np.linalg.norm(normalized([3, 4]))), 1)

    def test_structure_keeps_estimates_separate_from_taste_and_drop_labels(self):
        summary = structure_summary([{"time": 1, "values": {"structure": "chorus", "melody": [{"pitch": 60}]}}], 30)
        self.assertEqual(summary["sections"][0]["label"], "chorus")
        self.assertTrue(summary["estimated"])
        self.assertNotIn("taste", summary)


if __name__ == "__main__":
    unittest.main()
