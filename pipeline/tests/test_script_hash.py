"""The script hash that ties a recording to the Worker that replays it (see src/script_hash.py)."""
import os
import tempfile
import unittest

import recording_world as rw
import script_hash

REPO = os.path.join(os.path.dirname(__file__), "..", "..")
SCRIPTS = os.path.join(REPO, "scripts")
SRC = os.path.join(os.path.dirname(__file__), "..", "src")


class ScriptHash(unittest.TestCase):
    def test_the_committed_constant_is_the_hash_of_the_scripts(self):
        self.assertEqual(script_hash.SCRIPT_HASH, script_hash.script_hash(SCRIPTS),
                         "scripts/fetch_conditions.py or observation_archive.py changed: set SCRIPT_HASH in pipeline/src/script_hash.py to the output of "
                         "`python scripts/record_run.py --script-hash` (a deploy after that makes older recordings 'superseded' in verify-shadow)")

    def test_the_worker_copies_hash_the_same_as_the_scripts(self):
        self.assertEqual(script_hash.script_hash(SRC), script_hash.script_hash(SCRIPTS))

    def test_the_recorders_function_and_the_workers_are_the_same_function(self):
        self.assertEqual(rw.record_run.script_hash(SCRIPTS), script_hash.script_hash(SCRIPTS))
        self.assertEqual(rw.record_run.SCRIPT_FILES, script_hash.SCRIPT_FILES)

    def test_line_endings_do_not_change_it_but_content_does(self):
        def hash_of(transform):
            with tempfile.TemporaryDirectory() as d:
                for name in script_hash.SCRIPT_FILES:
                    with open(os.path.join(SCRIPTS, name), "rb") as f:
                        data = f.read().replace(b"\r\n", b"\n")
                    with open(os.path.join(d, name), "wb") as f:
                        f.write(transform(data))
                return script_hash.script_hash(d)
        self.assertEqual(hash_of(lambda b: b), hash_of(lambda b: b.replace(b"\n", b"\r\n")))          # a Windows checkout hashes like Actions' Linux one
        self.assertNotEqual(hash_of(lambda b: b), hash_of(lambda b: b + b"# one more comment\n"))

    def test_the_hash_is_stable_text_of_64_hex_digits(self):
        self.assertRegex(script_hash.SCRIPT_HASH, r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
