"""Which script this Worker was deployed with.

The shadow replays Actions' recordings with fetch_conditions.py / observation_archive.py, and a recording only means something against the SAME script:
scripts/record_run.py stores script_hash() of the files it ran in every recording, and this Worker stamps SCRIPT_HASH on every replay it writes. verify-shadow
counts a cycle only when the two are equal; anything else is "superseded" (made with an older or newer script), never an unclean cycle.

SCRIPT_HASH is a committed constant (not read from the bundle at run time: whether a Python Worker can read its own source files is not something to rely on).
tests/test_script_hash.py fails when it no longer matches the two files, and prints the new value. Regenerate it with:
    python scripts/record_run.py --script-hash
script_hash() is the same function as in scripts/record_run.py (a test keeps them identical)."""
import hashlib
import os

SCRIPT_FILES = ("fetch_conditions.py", "observation_archive.py")  # everything that decides the output
SCRIPT_HASH = "4bd4bb6948e2060b175df0e50f2ca6beb3f45cfa162cc6b263404cf5ccfaed32"


def script_hash(directory):
    """SHA-256 over "name:sha256(bytes)" lines of SCRIPT_FILES, with CRLF read as LF so a Windows checkout and Actions' Linux one hash the same."""
    lines = []
    for name in sorted(SCRIPT_FILES):
        with open(os.path.join(directory, name), "rb") as f:
            digest = hashlib.sha256(f.read().replace(b"\r\n", b"\n")).hexdigest()
        lines.append(name + ":" + digest)
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()
