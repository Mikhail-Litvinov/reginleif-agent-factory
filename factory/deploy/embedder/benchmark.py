"""Run against the real container, never as part of the ordinary test suite.

python benchmark.py DATASET_JSON CONTAINER_ID [URL]
Requires Docker CLI and the original measurement set; reports ONNX versus torch.
"""
import json
import math
import statistics
import subprocess
import sys
import time
import urllib.request

dataset = json.load(open(sys.argv[1], encoding="utf-8"))
container = sys.argv[2]
url = sys.argv[3] if len(sys.argv) > 3 else "http://127.0.0.1:8088/embed"

def embed(texts):
    request = urllib.request.Request(url, json.dumps({"texts": texts}).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(request) as response:
        result = json.load(response)
    assert result["revision"] == "5617a9f61b028005a4858fdac845db406aefb181"
    assert result["model"] == "BAAI/bge-m3"
    assert result["sha256"] == "1eebfb28493f67bba03ce0ef64bfdc7fc5a3bd9d7493f818bb1d78cd798416b4"
    assert len(result["vectors"]) == len(texts)
    return result["vectors"]

records = dataset["records"]
passages = [" ".join(r.get(k) or "" for k in ("problem", "decision", "summary")) for r in records]
vectors = []
for i in range(0, len(passages), 8):
    vectors.extend(embed(passages[i:i + 8]))
questions = [(r[k], i, k) for i, r in enumerate(records) for k in ("q_cross", "q_reword", "q_short")]
questions += [(r["q"], None, r["type"]) for r in dataset["unrelated"]]
for q, _, _ in questions[:5]:
    embed([q])
latencies, ranks, found, false = [], [], 0, 0
for q, expected, _ in questions:
    start = time.perf_counter()
    vector = embed([q])[0]
    latencies.append((time.perf_counter() - start) * 1000)
    scores = [sum(a * b for a, b in zip(vector, passage)) for passage in vectors]
    if expected is None:
        false += max(scores) >= 0.47
    else:
        rank = sum(score >= scores[expected] for score in scores)
        ranks.append(rank)
        found += rank <= 5 and scores[expected] >= 0.47
memory = subprocess.check_output(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", container], text=True).strip()
latencies.sort()
report = {"memory_note": "Container memory is a docker stats snapshot; torch memory is peak process working set. These figures are not comparable.", "onnx": {"recall_at_1": sum(r <= 1 for r in ranks) / len(ranks), "recall_at_3": sum(r <= 3 for r in ranks) / len(ranks), "recall_at_5": sum(r <= 5 for r in ranks) / len(ranks), "found_at_047": found / len(ranks), "false_hit_at_047": false / len(dataset["unrelated"]), "median_ms": statistics.median(latencies), "p95_ms": latencies[math.ceil(len(latencies) * .95) - 1], "container_memory": memory}, "torch_report": {"recall_at_1": .850, "recall_at_3": .967, "recall_at_5": .975, "found_at_047": .88, "false_hit_at_047": .033, "median_ms": 110.5, "p95_ms": 139.6, "peak_process_gb": 2.31}}
print(json.dumps(report, indent=2))
