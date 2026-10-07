"""Two places where the script's output used to depend on the last bit of a float, so Python 3.11 on Linux (GitHub Actions), desktop Python 3.13 and
Python 3.13 in WebAssembly (the Cloudflare Worker) could disagree on the very same input:

  * the direction filled into a gap in the wind readings (sin/cos/atan2 of two compass points that sit an odd number of steps apart, or opposite:
    an exact midpoint between two compass points, which the last bit decided), and
  * the means in the observation archive (sum() became a compensated sum in Python 3.12, so a mean on a rounding tie such as 10.85 moved 0.1).

The fix keeps every published value exactly as before: the wind answers are a written-down table of what the old code answered, the mean is the
plain left-to-right float addition 3.11's sum() did. These tests pin both. They hold no float trig, so they must pass identically on every Python
version (CI runs them on whichever is installed; run the suite on 3.11 and 3.13 by hand when touching either function)."""
import itertools
import unittest
from unittest import mock

import synth  # noqa: F401  (puts pipeline/src on the path)

import fetch_conditions as fc
import observation_archive as oa

NAMES = list(fc.COMPASS_DEGREES)

# The 14 table entries that are NOT "the counter-clockwise point of the tie" (the 58 others are). They are what the old code answered on LINUX
# CPython (Actions' platform; checked on 3.11, 3.12 and 3.13 with glibc 2.39), by float noise: arbitrary but stable, and live data has been
# published with them. See COMPASS_TIE_RESULTS in fetch_conditions.py.
# DELIBERATE UPDATE: a first table derived on Windows had NE|SSW -> ESE and NE|SW -> SE (both happen to be the counter-clockwise answers); Linux
# gives SE and S, so those two moved into this dict. Windows and Linux libm differ on exactly these two pairs: never regenerate from another OS.
NOT_COUNTER_CLOCKWISE = {
    ("N", "NNE"): "NNE", ("N", "NNW"): "N", ("NNE", "NW"): "N", ("NE", "NNW"): "NNE", ("NE", "WNW"): "N", ("ENE", "W"): "N",
    ("E", "WNW"): "NNE", ("SE", "NNW"): "ENE", ("NNE", "SSW"): "SE", ("ENE", "WSW"): "NNW", ("ESE", "WNW"): "NNE", ("SSE", "NNW"): "ENE",
    ("NE", "SSW"): "SE", ("NE", "SW"): "S",
}


def counter_clockwise(a, b):
    i1, i2 = NAMES.index(a), NAMES.index(b)
    if abs(i2 - i1) == 8:
        return NAMES[min(i1, i2) + 4]
    return NAMES[(i1 + ((i2 - i1 + 8) % 16 - 8) // 2) % 16]


def ring(i, j):
    return min((i - j) % 16, (j - i) % 16)


class CompassMidpoint(unittest.TestCase):
    def test_table_covers_every_odd_and_opposite_pair_exactly_once(self):
        want = {(NAMES[i], NAMES[j]) for i in range(16) for j in range(i + 1, 16) if ring(i, j) % 2 == 1 or ring(i, j) == 8}
        self.assertEqual(set(fc.COMPASS_TIE_RESULTS), want)
        self.assertEqual(len(fc.COMPASS_TIE_RESULTS), 72)
        self.assertTrue(all(v in NAMES for v in fc.COMPASS_TIE_RESULTS.values()))

    def test_table_is_counter_clockwise_except_the_fourteen_documented_pairs(self):
        for (a, b), got in fc.COMPASS_TIE_RESULTS.items():
            want = NOT_COUNTER_CLOCKWISE.get((a, b), counter_clockwise(a, b))
            self.assertEqual(got, want, f"{a}|{b}")
        self.assertEqual(sum(1 for k in fc.COMPASS_TIE_RESULTS if k in NOT_COUNTER_CLOCKWISE), 14)

    def test_the_ties_the_platforms_used_to_disagree_on_keep_the_published_answer(self):
        self.assertEqual(fc.compass_midpoint("N", "NNE"), "NNE")  # Actions: NNE (Pyodide said N)
        self.assertEqual(fc.compass_midpoint("E", "ESE"), "E")  # Actions: E (Pyodide said ESE)
        self.assertEqual(fc.compass_midpoint("NNW", "N"), "N")

    def test_an_odd_step_tie_is_always_one_of_the_two_points_beside_the_midpoint(self):
        for (a, b), got in fc.COMPASS_TIE_RESULTS.items():
            i1, i2 = NAMES.index(a), NAMES.index(b)
            if ring(i1, i2) == 8:
                continue
            step = (i2 - i1 + 8) % 16 - 8
            low = (i1 + step // 2) % 16  # step is odd: the midpoint is between these two
            self.assertIn(got, (NAMES[low], NAMES[(low + 1) % 16]), f"{a}|{b}")

    def test_an_even_gap_is_the_exact_middle_point_including_across_north(self):
        for a, b, want in [("N", "E", "NE"), ("NNW", "NNE", "N"), ("W", "N", "NW"), ("W", "NE", "NNW"), ("SSE", "WSW", "SSW"), ("E", "E", "E")]:
            self.assertEqual(fc.compass_midpoint(a, b), want, f"{a}|{b}")

    def test_order_never_matters(self):
        for a, b in itertools.product(NAMES, NAMES):
            self.assertEqual(fc.compass_midpoint(a, b), fc.compass_midpoint(b, a), f"{a}|{b}")

    def test_unknown_or_blank_directions_give_none_and_case_and_spaces_are_ignored(self):
        self.assertIsNone(fc.compass_midpoint("N", None))
        self.assertIsNone(fc.compass_midpoint("", "E"))
        self.assertIsNone(fc.compass_midpoint("N", "NNNE"))
        self.assertEqual(fc.compass_midpoint(" n ", "nne"), "NNE")

    def test_fill_wind_gaps_uses_no_floating_point_trig(self):
        def boom(*a, **k):
            raise AssertionError("fill_wind_gaps must not use sin/cos/atan2: their last bit differs between platforms")
        rows = [{"Wind Forecast Dir": d, "Wind Forecast (km/h)": s} for d, s in
                [("N", 10.0), (None, None), (None, None), ("NNE", 20.0), ("E", 12.0), (None, None), ("ESE", 14.0), ("NNW", 5.0), (None, None), ("N", 5.0)]]
        with mock.patch.object(fc.math, "sin", boom), mock.patch.object(fc.math, "cos", boom), mock.patch.object(fc.math, "atan2", boom):
            fc.fill_wind_gaps(rows)
        self.assertEqual([r["Wind Forecast Dir"] for r in rows], ["N", "NNE", "NNE", "NNE", "E", "E", "ESE", "NNW", "N", "N"])
        # a multi-hour gap gets one flat value from the ORIGINAL neighbours (unchanged behaviour); the speed fill is untouched
        self.assertEqual([r["Wind Forecast (km/h)"] for r in rows][1:3], [15.0, 15.0])

    def test_fill_wind_gaps_leaves_a_gap_outside_the_real_readings_alone(self):
        rows = [{"Wind Forecast Dir": d, "Wind Forecast (km/h)": 1.0} for d in [None, "N", None]]
        fc.fill_wind_gaps(rows)
        self.assertEqual([r["Wind Forecast Dir"] for r in rows], [None, "N", None])


class ArchiveMean(unittest.TestCase):
    @staticmethod
    def left_to_right(values, digits):
        total = 0.0
        for v in values:
            total += v
        return round(total / len(values), digits)

    def test_mean_is_plain_left_to_right_addition_not_sum(self):
        cases = [([0.1] * 10, 3), ([10.8, 10.9], 1), ([14.05, 14.15, 14.1], 1), ([1e16, 1.0, -1e16, 1.0], 2), ([3.3, 3.4, 3.35], 2),
                 ([10.9, 10.8, 10.8, 10.9, 10.8, 10.9], 1), ([0.1, 0.2, 0.3], 1), ([14.1, 14.2, 14.15, 14.05], 1)]
        for values, digits in cases:
            self.assertEqual(oa._mean(values, digits), self.left_to_right(values, digits), (values, digits))

    def test_mean_order_is_the_order_given_so_the_result_is_reproducible(self):
        # the accumulation is not order independent (that is what 3.11 did and what published data used); it IS identical on every Python
        self.assertEqual(oa._mean([1e16, 1.0, -1e16, 1.0], 2), 0.25)  # (1e16+1.0) rounds back to 1e16, so only the last 1.0 survives
        self.assertEqual(oa._mean([1.0, 1.0, 1e16, -1e16], 2), 0.5)  # 1+1 first, so both survive

    def test_mean_ignores_missing_readings_and_is_none_when_there_are_none(self):
        self.assertEqual(oa._mean([None, 10.0, None, 11.0], 1), 10.5)
        self.assertIsNone(oa._mean([None, None], 1))
        self.assertIsNone(oa._mean([], 1))


if __name__ == "__main__":
    unittest.main()
