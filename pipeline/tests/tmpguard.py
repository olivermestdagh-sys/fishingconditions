"""Confine every temporary file these tests create to ONE folder that is deleted when the test process exits.

The script's output folder holds a full copy of a run's output; with the real fixtures that includes private locations. runner.run now removes
its own folder (and tests assert that), but this guard is the belt-and-braces: even a leaked folder lands in a single place that is wiped at exit,
never loose among the OS temp files. Imported by synth.py, recording_world.py and test_parity.py (anything that can create such output).
"""
import atexit
import shutil
import tempfile

_ROOT = tempfile.mkdtemp(prefix="pipeline-tests-")
tempfile.tempdir = _ROOT
atexit.register(shutil.rmtree, _ROOT, ignore_errors=True)
