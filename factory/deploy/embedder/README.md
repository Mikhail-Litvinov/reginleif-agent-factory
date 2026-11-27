# CPU embedder

Stage the `onnx` directory from `BAAI/bge-m3` revision `5617a9f61b028005a4858fdac845db406aefb181` outside this repository. Set `AF_EMBEDDER_MODEL_DIR` to that directory and start this compose file. The graph, external weights, external constant and tokenizer are checked before the HTTP listener starts. The image never loads PyTorch weights. The internal Docker network has no external route; the published endpoint binds to loopback.

POST `/embed` with `{"texts":["text"]}` returns the model, revision, external weights SHA-256, and normalized vectors. The service uses CPU execution and four intra-op threads, matching the measurement configuration. The model directory must be readable by UID 65532.

Run `benchmark.py DATASET_JSON CONTAINER_ID [URL]` against the running container to compare ONNX with the report's torch measurements. Run `factory/tests/registry-search-embedder.test.ts` with `REGISTRY_MEASUREMENT_DATASET` set to the same dataset through the repository's disposable database bench to measure actual search and degraded mode. The factory test script includes this test and requires the running embedder and dataset.

Run the Python checksum test from this directory with `python -m unittest test_server.py`, in an environment with the image's Python dependencies installed.
