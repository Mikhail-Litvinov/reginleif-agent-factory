import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL = "BAAI/bge-m3"
REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
HASHES = {
    "Constant_7_attr__value": "cdf16f72c5d07b36484056e601ed9687f78477e5d85cee85a34f2406b7fb5906",
    "model.onnx": "f84251230831afb359ab26d9fd37d5936d4d9bb5d1d5410e66442f630f24435b",
    "model.onnx_data": "1eebfb28493f67bba03ce0ef64bfdc7fc5a3bd9d7493f818bb1d78cd798416b4",
    "tokenizer.json": "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790",
}

def verify(path, expected):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise RuntimeError(f"checksum mismatch: {path.name}")

def main():
    root = Path("/model")
    for name, expected in HASHES.items():
        verify(root / name, expected)
    tokenizer = Tokenizer.from_file(str(root / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=8192)
    tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(root / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
    inputs = {item.name for item in session.get_inputs()}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            try:
                if self.path != "/embed":
                    self.send_error(404); return
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0 or size > 1048576:
                    raise ValueError("invalid request size")
                texts = json.loads(self.rfile.read(size))["texts"]
                if not isinstance(texts, list) or not texts or len(texts) > 128 or any(not isinstance(t, str) for t in texts):
                    raise ValueError("invalid texts")
                encoded = tokenizer.encode_batch(texts)
                feed = {"input_ids": np.asarray([e.ids for e in encoded], dtype=np.int64), "attention_mask": np.asarray([e.attention_mask for e in encoded], dtype=np.int64), "token_type_ids": np.asarray([e.type_ids for e in encoded], dtype=np.int64)}
                hidden = session.run(None, {k: v for k, v in feed.items() if k in inputs})[0]
                vectors = hidden[:, 0, :]
                vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
                body = json.dumps({"model": MODEL, "revision": REVISION, "sha256": HASHES["model.onnx_data"], "vectors": vectors.tolist()}, allow_nan=False).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            except (ValueError, KeyError, TypeError, json.JSONDecodeError):
                self.send_error(400)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()

if __name__ == "__main__":
    main()
