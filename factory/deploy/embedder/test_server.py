import hashlib
import tempfile
import unittest
from pathlib import Path

from server import verify

class ChecksumTest(unittest.TestCase):
    def test_matches_and_rejects_changed_or_missing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"fixture")
            digest = hashlib.sha256(b"fixture").hexdigest()
            verify(path, digest)
            path.write_bytes(b"different")
            with self.assertRaises(RuntimeError):
                verify(path, digest)
            path.unlink()
            with self.assertRaises(FileNotFoundError):
                verify(path, digest)

if __name__ == "__main__":
    unittest.main()
