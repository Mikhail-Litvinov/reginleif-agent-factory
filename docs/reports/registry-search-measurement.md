# Registry search measurement (phase 2)

Purpose: pick the local CPU embedding model of the Decision Registry, its vector size (migration 0006, `registry_embeddings.embedding vector(N)`) and the search thresholds (`registry.*` settings). Also measure the degraded mode (no model: full text plus trigram).

This report states what was found, what is emerging and what is unknown. It carries no decision question.

## Method

- Invented set, 40 records (20 ru, 20 en; 35 rules, 3 decisions, 1 fact, 1 permission), each with 3 paraphrased questions: one in the other language (`cross`), one with different wording (`reword`), one short (`short`). That is 120 related questions. Plus 30 unrelated questions that must find nothing: 15 off-domain and 15 in-domain but not covered by any record (hard negatives). Includes deliberate near-duplicate topics (two records on temp files, two on databases). Everything is invented; the raw set is in `E:/ai-models/registry-search/dataset.json` and is not pasted here.
- Passage = `problem + decision + summary` (the `registry_records` fields). Query and passage vectors are L2-normalised; score = cosine similarity (`1 - <=>` with `vector_cosine_ops`). E5 uses the documented `query: ` / `passage: ` prefixes; MiniLM and bge-m3 use none. Plain `sentence-transformers` on CPU, torch 2.15.0+cpu, 4 threads, fp32, batch 1 for latency (150 queries, 5 warm-up calls first).
- "Found" = the right record is in the top 5 AND its score is at or above the threshold. "False hit" = an unrelated question whose top-1 score is at or above the threshold. Ties are ranked pessimistically (a record tied with others takes the worst rank of the tie). Threshold chosen by grid search over all observed scores, maximising `found - false hit`; the plateau of equal optima is reported and the middle is taken.
- Degraded mode ran in a scratch PostgreSQL 16.16 + pgvector container (removed afterwards): generated `tsvector` columns for `russian` and `english` configs with GIN, `pg_trgm` GIN. Questions are OR-ed (`plainto_tsquery` is AND, which makes natural questions fail), ranked with `ts_rank(..., 32)`; trigram uses `similarity` and `word_similarity`.
- Scripts and raw score matrices: `E:/ai-models/registry-search/scripts/` and `.../results/` (`summary.json` holds every number below).

## Machine and load

i7-13700KF (24 logical cores), 64 GB RAM, Windows 11, model on CPU with 4 threads. The machine was not idle: Windows Defender (`MsMpEng`, 0.6 GB), WSL VM (`vmmemWSL`, 2.7 GB, running the scratch Postgres and the owner's other containers), `claude`, two `ChatGPT` processes, `docker backend`, `chrome`, `steamwebhelper`, `LM Studio` (all idle-ish, each 0.25 to 0.5 GB). Total CPU use sampled for 2 s just before each model load: e5-small 1.8 %, MiniLM 3.9 %, e5-base 7.4 %, bge-m3 13.5 %. Latencies are therefore an upper-ish bound for an idle server but not a clean benchmark; the 13.5 % background during bge-m3 may add some milliseconds to its number.

## Results per model

| | multilingual-e5-small | multilingual-e5-base | paraphrase-multilingual-MiniLM-L12-v2 | bge-m3 |
|---|---|---|---|---|
| Vector size | 384 | 768 | 384 | 1024 |
| Weights on disk | 471 MB | 1112 MB | 471 MB | 2271 MB |
| Max sequence | 512 | 512 | 128 | 8192 |
| recall@1 | 0.567 | 0.667 | 0.650 | **0.850** |
| recall@3 | 0.758 | 0.842 | 0.808 | **0.967** |
| recall@5 | 0.850 | 0.917 | 0.875 | **0.975** |
| recall@5 cross-language / reword / short | 0.68 / 0.93 / 0.95 | 0.75 / 1.00 / 1.00 | 0.93 / 0.72 / 0.97 | 1.00 / 0.95 / 0.97 |
| recall@1 cross-language / reword / short | 0.23 / 0.70 / 0.78 | 0.33 / 0.82 / 0.85 | 0.70 / 0.40 / 0.85 | 0.78 / 0.82 / 0.95 |
| Unrelated top-1 score: median / max | 0.785 / 0.834 | 0.767 / 0.805 | 0.231 / 0.499 | 0.365 / 0.496 |
| Right record score when in top 5: p10 / median | 0.794 / 0.828 | 0.788 / 0.815 | 0.332 / 0.532 | 0.474 / 0.557 |
| Best threshold (plateau) | 0.813 (0.812 to 0.814) | 0.787 (0.786 to 0.787) | 0.391 (0.390 to 0.391) | 0.4735 (0.464 to 0.4735) |
| Found / false hit at best | 0.59 / 0.10 | 0.83 / 0.17 | 0.73 / 0.10 | **0.88 / 0.033** |
| (false hit off-domain / in-domain) | 0.00 / 0.20 | 0.00 / 0.33 | 0.00 / 0.20 | 0.00 / 0.067 |
| Zero false hits: threshold, found | 0.834, 0.40 | 0.805, 0.58 | 0.499, 0.575 | 0.496, **0.81** |
| At most 5 % false hits: threshold, found | 0.819, 0.49 | 0.803, 0.61 | 0.478, 0.60 | 0.464, **0.88** |
| Query latency, batch 1, 4 threads: median / p95 | 13.4 / 17.1 ms | 34.1 / 43.1 ms | 15.3 / 20.4 ms | 110.5 / 139.6 ms |
| Peak working set of the process | 1.32 GB | 1.98 GB | 1.23 GB | 2.31 GB |
| Embedding the 40 passages (batch 8) | 0.5 s | 1.8 s | 0.5 s | 6.4 s |
| Model load | 2.6 s | 2.9 s | 1.4 s | 2.4 s |
| Download (cold) | 14 s | 26 s | 18 s | 57 s |
| HF revision | `614241f622f53c4eeff9890bdc4f31cfecc418b3` | `d128750597153bb5987e10b1c3493a34e5a4502a` | `e8f8c211226b894fcb81acc59f3b34ba3efd5f42` | `5617a9f61b028005a4858fdac845db406aefb181` |
| Weight file, sha256 | `model.safetensors` `1a55775f...c98477` | `model.safetensors` `a18a44fa...de09a7` | `model.safetensors` `eaa086f0...55917b` | `pytorch_model.bin` `b5e0ce34...6aad38` |

Full sha256 values: e5-small `1a55775f53449dac10a2bcbc312469fac40b96d53198c407081a831f81c98477`; e5-base `a18a44fad1d0b46ded15928144138cff1135d5cc8233bdd90be5f18822de09a7`; MiniLM `eaa086f0ffee582aeb45b36e34cdd1fe2d6de2bef61f8a559a1bbc9bd955917b`; bge-m3 `b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38`.

Downloads in total about 4.4 GB (weights 4.3 GB; cap 6 GB). They sit in the HF cache `E:/ai-models/hf`, which also holds other models that are not part of this measurement.

## Degraded mode (PostgreSQL full text and trigram, no model)

| Signal | recall@1 / @3 / @5 | recall@5 cross / reword / short | Unrelated top-1 median / max | Threshold | Found / false hit |
|---|---|---|---|---|---|
| `ts_rank` russian, OR-ed | 0.43 / 0.52 / 0.53 | 0.12 / 0.78 / 0.68 | 0.006 / 0.027 | 0.0201 | 0.38 / 0.067 |
| `ts_rank` english, OR-ed | 0.37 / 0.43 / 0.45 | 0.10 / 0.57 / 0.68 | 0.014 / 0.036 | 0.0252 | 0.29 / 0.033 |
| max of the two `ts_rank` | 0.43 / 0.49 / 0.51 | 0.12 / 0.70 / 0.70 | 0.015 / 0.036 | 0.0252 | 0.33 / 0.033 |
| trigram `similarity` | 0.39 / 0.46 / 0.50 | 0.00 / 0.80 / 0.70 | 0.139 / 0.240 | 0.1846 | 0.19 / 0.10 |
| trigram `word_similarity` | 0.40 / 0.48 / 0.51 | 0.07 / 0.75 / 0.70 | 0.245 / 0.465 | 0.3636 (plateau 0.364 to 0.467; at 0.465 found 0.22, false 0) | 0.25 / 0.033 |
| max `ts_rank` + `word_similarity` | 0.42 / 0.48 / 0.50 | 0.07 / 0.72 / 0.70 | 0.250 / 0.501 | 0.3668 | 0.26 / 0.033 |

Found: roughly half of the right records reach the top 5, and about a third survive a threshold that keeps unrelated questions out. Cross-language questions are almost never found (the text rankings share no words across languages; the few hits come from Latin technical terms and file names that appear in both). Reword and short questions reach the top 5 in 57 to 80 % of cases before the threshold. Trigram adds nothing over full text in recall; its only use is a cheap guard against typos, which this set does not exercise. The full-text rank is tiny and unitless (0.01 to 0.08), so its threshold depends on the document length and the normalisation flag (32 here).

Chosen text threshold: max of the russian and english `ts_rank` (flag 32, OR-ed query) at least `0.025`: found 0.33, false hit 0.033. Trigram stays out of the ranking path (it is available through the `pg_trgm` index if the spec wants a typo fallback).

## Chosen model

BAAI/bge-m3, revision `5617a9f61b028005a4858fdac845db406aefb181`, weight file `pytorch_model.bin` (the repo has no safetensors), sha256 above, **vector size 1024** (migration 0006: `vector(1024)`, `model_version` is the revision above; the `hnsw` limit for `vector` is 2000 dimensions, so 1024 is indexable).

Reason: with the same set it is far ahead on every question type, in particular cross-language (recall@5 1.00 against 0.68 to 0.93) and on false hits (3.3 % at the best threshold against 10 to 17 %; the other three put the right and the wrong scores in a narrow overlapping band). It is the only model where a threshold exists that lets through 81 to 88 % of the right records and passes 0 to 1 of 30 unrelated questions. The cost is 110 ms per query at 4 threads (p95 140 ms), 2.3 GB of RAM and 2.3 GB of disk; one query is a few tenths of a second at worst, which is small against the gate path (`registry.gateTimeoutMs`). The runner-up on cost, multilingual-e5-small (13 ms, 1.3 GB), is not usable as a filter: its right and unrelated score bands overlap (unrelated up to 0.834, right records from 0.759).

Vector threshold (cosine similarity, `1 - (embedding <=> query)`):
- recommended `0.47` (cosine distance at most `0.53`): found 0.88, false hit 0.033 (1 of 15 in-domain hard negatives, 0 of 15 off-domain);
- strict alternative `0.50`: found 0.81, false hit 0.00 (the highest unrelated score seen is 0.496, so `0.50` has no margin on this set).

Scores of the other models are not comparable: e5 compresses everything into 0.68 to 0.90 (known with its low temperature), MiniLM spreads 0.04 to 0.77.

## What is emerging

- The ranking is strongest for cross-language questions only with bge-m3 and MiniLM; e5 needs the same language in question and record.
- Off-domain unrelated questions are cleanly rejected by every model (0 % false hits at their best thresholds); every false hit is an in-domain hard negative (a question on a nearby topic the registry does not cover). The threshold mostly decides how nearby topics are treated.
- recall@5 is high but recall@1 is not (bge-m3 0.85): the near-duplicate topics (temp files, databases) are where the right record is rank 2 to 5. The gate should therefore show several candidates, not decide on the single top hit.
- The degraded mode is clearly weaker than the model path and cannot bridge languages.

## What is unknown

- The set is 40 invented records and 150 questions. The grid-searched thresholds rest on one false hit in 30 (granularity 3.3 %); the 95 % interval of a rate of 1 of 30 is roughly 0 to 17 %. Treat `0.47` as a starting value; it needs re-measurement on the real registry once it has records (not done here: no real content was read, by design).
- Real records are likely longer, more technical and more homogeneous than the invented ones; score distributions may shift, most of all the in-domain false-hit rate.
- Latency was measured on a busy desktop, not on the production host; the container CPU limit, the core count it will get and the effect of concurrent queries (the 4 threads used here would be shared) were not measured. ONNX/int8 and `torch.compile` variants of bge-m3 were not tried; they could cut latency and memory but would change the scores slightly and need their own check.
- bge-m3 ships its weights as a pickle (`pytorch_model.bin`); the loader must use safe loading and the file must be pinned by the sha256 above. No safetensors variant was verified.
- Embedding long records (the 8192-token maximum of bge-m3) was not exercised; record length of the real registry is unknown.
- Whether `ts_rank` thresholds hold on records of other lengths is not known; the text threshold is the least reliable number in this report.
- Latency of the degraded mode (PostgreSQL side) was not measured; at 40 records it is not informative.

## ONNX re-measurement

Conditions: the production container (`factory/deploy/embedder`): python 3.12-slim, onnxruntime 1.20.1 on CPU, 4 intra-op threads, tokenizers 0.21.0, numpy 2.2.1; ONNX export from `BAAI/bge-m3` revision `5617a9f61b028005a4858fdac845db406aefb181` (`onnx/` only, fp32 with external weights). All pinned sha256 values in the server matched the downloaded files. Same dataset as above (40 records, 120 related and 30 unrelated questions), same passage rule, the same pessimistic tie ranking. Queries went through the host, the loopback relay and the internal network (HTTP, batch 1); the desktop was again not idle. Scripts: `factory/deploy/embedder/benchmark.py` for the vector numbers, `factory/tests/registry-search-embedder.test.ts` for the complete search.

| | torch (above) | ONNX container |
|---|---|---|
| recall@1 / @3 / @5 | 0.850 / 0.967 / 0.975 | 0.850 / 0.967 / 0.975 |
| Found / false hit at 0.47 | 0.88 / 0.033 | 0.883 / 0.033 |
| Unrelated top-1 median / max | 0.365 / 0.496 | 0.367 / 0.496 |
| Right record in top 5, score p10 / median | 0.474 / 0.557 | 0.4735 / 0.557 |
| Best threshold (plateau) | 0.4735 (0.464 to 0.4735) | 0.4735 (0.464 to 0.4735) |
| Strict 0.50: found / false hit | 0.81 / 0.00 | 0.80 / 0.00 |
| Query latency, batch 1: median / p95 | 110.5 / 139.6 ms | 38.1 / 49.3 ms (includes HTTP and the relay) |
| Memory | 2.31 GB peak process | 1.43 GB container (`docker stats` snapshot; not the same measure) |

The quality is the same as with torch on every number; the 0.47 vector threshold holds without change. Latency is about three times lower. Memory is not strictly comparable (peak working set against a container snapshot).

Complete search (`createRegistrySearch`: vector and both full-text configs merged, the real database, default thresholds): the right record is found for 0.883 of the 120 related questions, and 0.067 (2 of 30) of the unrelated questions return at least one item, in line with the vector-only 0.033 plus the full-text 0.033 measured above. The degraded mode (no embedding) returned `degraded: true` for every question. A first run of the code merged trigram hits at the `similarity` threshold 0.1846 in the normal path and gave 0.90 found and 0.133 false hits; that contradicted the decision above (trigram stays out of the ranking path), so the code was changed: trigram now runs only in degraded mode, as the typo fallback, and the 0.067 is the measurement of the corrected code.
