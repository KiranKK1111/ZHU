# Benchmarks

Every number here is measured on the development laptop, not estimated. Raw results: `engine/benchmarks/results/*.json` and `engine/evaluation/*_report.json`. Reproduce with the commands in [TESTING.md](TESTING.md).

**Hardware:** NVIDIA GeForce RTX 5060 Laptop GPU (8 GB, driver 581.34) plus Intel integrated graphics, 16 logical CPUs, Windows 11 Pro 26200, 16 GB RAM · CTranslate2 4.9.0, faster-whisper 1.2.1, cuBLAS 12.9, cuDNN 9.28, onnxruntime-directml 1.24.4 (Parakeet) · measured 2026-11-17, **one process per configuration**.

## Speech-to-text

Test audio is 20 utterances per variant (16 questions, 4 statements), synthesized with the Windows SAPI voices "David" and "Zira". Noise is pink-ish noise mixed at 10 dB and 0 dB SNR. The two-speaker clip has one question by one voice followed by an answer by the other. Final decoding uses beam 5 with word timestamps; partial decoding uses greedy search on 60% of the clip.

| Configuration | Load (incl. warm-up) | VRAM added | VRAM peak (total GPU) | Final decode p50 / max | RTF (clear) | Partial decode p50 / max | Process CPU |
|---|---|---|---|---|---|---|---|
| large-v3-turbo FP16, CUDA | 2.4 s | 2,257 MB | 2,696 MB | 318 / 443 ms | 0.088 | 266 / 327 ms | 107% of 1 core |
| large-v3-turbo INT8/FP16, CUDA | 2.8 s | 1,203 MB | 1,672 MB | 285 / 428 ms | 0.080 | 241 / 298 ms | 117% |
| small INT8/FP16, CUDA | 1.1 s | 499 MB | 872 MB | 171 / 316 ms | 0.047 | 114 / 991 ms | 127% |
| small INT8, CPU (4 threads) | 1.9 s | — | — | 1,336 / 1,671 ms | 0.37 | 1,112 / 2,411 ms | 399% |

### Word error rate

| Configuration | Clear | Fast (rate +4) | 10 dB SNR | 0 dB SNR | Two speakers |
|---|---|---|---|---|---|
| large-v3-turbo FP16 | **0.0%** | 2.5% | 1.5% | **4.5%** | 0.0% |
| large-v3-turbo INT8/FP16 | 0.0% | 2.5% | 1.5% | 4.5% | 0.0% |
| small INT8/FP16 | 1.5% | 2.5% | 1.5% | 11.0% | 0.0% |
| small INT8, CPU | 1.0% | 2.5% | 1.5% | 12.0% | 0.0% |

### Question detection on real STT output

These are the 80 question/statement clips (clear, fast, 10 dB, 0 dB), transcribed and fed to the question engine.

| Configuration | TP | FP | FN | Precision | Recall |
|---|---|---|---|---|---|
| large-v3-turbo (FP16 and INT8/FP16) | 64 | 0 | 0 | 1.00 | 1.00 |
| small (GPU and CPU) | 63 | 0 | 1 | 1.00 | 0.984 |

### End-to-end, real time

A conversation of 8 clips (7 questions and 1 statement, 2.5 s gaps) was fed in real time through the full pipeline (VAD → partial/final STT → question engine) on large-v3-turbo INT8/FP16:

* **7 of 7 questions completed, 0 spurious questions.**
* End of speech → `question.completed`: **p50 587 ms, max 1,398 ms.** Questions are visible as "in progress" while still being spoken; this is the time to finalize.
* STT worker: 48 jobs, 0 partials dropped.

Before two fixes found by this benchmark (see QUESTION_ENGINE.md §3), the same run produced 1 spurious question: a comma pause split "What is a microservice, | why would you use it…" in two. The VAD onset guard added 300 ms to every completion pause (p50 went from 291 to 587 ms) to cover the measured 250 ms speech-confirmation lag.

### Recommendation

**large-v3-turbo** is the default on this GPU. It is far more robust in heavy noise than `small` (4.5% vs 11% WER at 0 dB), its final decodes take about 0.3 s, and FP16 uses about 2.3 GB of VRAM. INT8/FP16 gives identical WER with about 1 GB less VRAM, and the fallback ladder uses it automatically when memory is tight.

### Host-memory finding

When less than about 3 GB of commit charge was free, both turbo and even `small` failed to **load**, with `mkl_malloc: failed to allocate memory` or a misleading `CUDA failed with error out of memory`, while 7.8 GB of VRAM was free. This happened repeatedly on the 16 GB laptop while other development servers were running. ZHU now checks host memory before loading, explains the problem, and falls back to cheaper configurations; see TROUBLESHOOTING.md.

### Limitations of these measurements

* Synthetic speech is cleaner and more regular than human speech, so these WER figures are a **lower bound**.
* Accented English is **not measured**, because only two en-US voices are installed.
* GPU temperature and utilization are reported live in the app (NVML) but were not aggregated here.

## Speech-to-text: NVIDIA Parakeet TDT 0.6B

Same audio, same scoring, same machine, one process per configuration, measured 2026-11-17 with onnxruntime-directml 1.24.4. Models: the ONNX exports `istupakov/parakeet-tdt-0.6b-v2-onnx` and `-v3-onnx`. GPU runs use DirectML with the FP32 encoder; CPU runs use the INT8 encoder with 4 threads. Decoding is greedy (Parakeet has no beam search), so "final" and "partial" are the same decode. Raw results: `engine/benchmarks/results/stt_parakeet_threads.json` (final settings), `stt_parakeet.json` (first run, with Whisper small on the CPU for comparison), `e2e_parakeet-v2-cpu.json`, `e2e_parakeet-v2-dml.json`.

| Configuration | Load (incl. warm-up) | VRAM added / peak added | Process commit peak | Final decode p50 / max (clear) | RTF (clear) | Partial p50 / max | Process CPU |
|---|---|---|---|---|---|---|---|
| Parakeet v2, DirectML FP32 | 4.6 s | 2,445 / 2,625 MB | 3,545 MB | 253 / 358 ms | 0.069 | 232 / 299 ms | 98% of 1 core |
| Parakeet v2, CPU INT8 | 2.3 s | — | 1,517 MB | 125 / 362 ms | 0.035 | 85 / 220 ms | 223% |
| Parakeet v3, DirectML FP32 | 4.8 s | 2,445 / 2,625 MB | 3,568 MB | 262 / 410 ms | 0.074 | 249 / 308 ms | 97% |
| Parakeet v3, CPU INT8 | 2.3 s | — | 1,528 MB | 126 / 375 ms | 0.035 | 88 / 223 ms | 223% |
| *Whisper small INT8, CPU (same session)* | 2.1 s | — | 3,020 MB | 1,424 / 1,758 ms | 0.39 | 1,113 / 2,651 ms | 397% |

| Configuration | Clear | Fast | 10 dB SNR | 0 dB SNR | Two speakers | Questions on STT output (TP/FP/FN) |
|---|---|---|---|---|---|---|
| Parakeet v2, DirectML FP32 | 0.5% | 2.5% | 2.5% | **3.0%** | 0.0% | 64 / 0 / 0 |
| Parakeet v2, CPU INT8 | 2.0% | 3.5% | 3.0% | 4.5% | 0.0% | 64 / 0 / 0 |
| Parakeet v3, DirectML FP32 | 0.5% | 3.5% | 1.0% | 3.0% | 0.0% | 64 / 0 / 0 |
| Parakeet v3, CPU INT8 | 0.0% | 3.5% | 3.0% | 5.0% | 0.0% | 64 / 0 / 0 |
| *Whisper small INT8, CPU* | 1.0% | 2.5% | 1.5% | 12.0% | 0.0% | 63 / 0 / 1 |
| *large-v3-turbo FP16 (table above)* | 0.0% | 2.5% | 1.5% | 4.5% | 0.0% | 64 / 0 / 0 |

Most Parakeet errors are the same few technical words: "Kubernetes" (→ "Covernets", "QWovernance"), "MongoDB" (→ "Mongod"), "redirects" (→ "reader recs", which Whisper small also produces), and "HashMap" written as "hash map" (two WER errors, same meaning). The INT8 encoder writes "hash map" more often than FP32.

**End-to-end, real time** (same 8-clip conversation as above): Parakeet v2 on the CPU (INT8) and on DirectML both completed **7 of 7 questions with 0 spurious questions**, end of speech → `question.completed` p50 **600 ms** (CPU) and **604 ms** (DirectML), max 1.37 s. That matches large-v3-turbo (587 / 1,398 ms): the time is dominated by the question engine's completion pause, not by transcription.

### Findings that shaped the implementation

* **CUDA vs DirectML.** onnxruntime-gpu 1.27 and later target CUDA 13, while CTranslate2 uses CUDA 12; 1.26 is the last CUDA 12 build. Its CUDA provider DLL (about 190 MB) plus cuFFT and cuRAND would push the 1.78 GB frozen engine past the installer's 2 GB limit. The DirectML build adds about 20 MB.
* **INT8 on DirectML is slower than on the CPU** (330–410 ms flat in a prototype run versus 100–380 ms on the CPU), because the dynamic-quantization operators fall back to the CPU. INT8 therefore always runs on the CPU.
* **DirectML has a fixed cost of about 200 ms** per encoder run regardless of input length (measured 172–242 ms for 2.0–4.8 s inputs, repeated shapes included), so the CPU INT8 path has lower latency on short utterances. 479 graph nodes (shape computations) run on the CPU.
* **Busy-waiting threads.** With ONNX Runtime's default spinning thread pools, the three sessions kept about 10 cores busy during back-to-back decodes (997% CPU). With one thread for the feature extractor and decoder and spinning disabled: 223% (CPU mode) and 98% (DirectML), with equal or lower latency and identical WER.
* **Host memory.** A DirectML FP32 load needs about 3.5 GB of process commit. Under memory pressure (other applications running; 2.3 GB free shortly afterwards) it failed with `E_OUTOFMEMORY`, and one load crashed with an access violation while about 3.4 GB was free. ZHU therefore runs Parakeet on the GPU only with at least 4 GB of commit free, and otherwise uses the CPU (1.5 GB).
* **Hybrid graphics.** This laptop has Intel graphics (display) and the RTX 5060. DirectML's default adapter can be the integrated GPU; `performance_preference=high_performance` selected the RTX 5060, confirmed by the 2.4 GB VRAM increase reported by `nvidia-smi`.

### Which to use

* **large-v3-turbo stays the default recommendation**: 0.0% WER on clear speech, 99 languages, half the download (1.6 GB vs 3.2 GB).
* **Parakeet v2** is an equally strong choice for English interviews: better in heavy noise (3.0% vs 4.5% at 0 dB on the GPU), and it runs well on the CPU when memory is tight (125 ms per utterance, about 2 cores while decoding). **Parakeet v3** behaves the same and adds 24 European languages with automatic detection.
* Without a usable GPU, Parakeet on the CPU is about 10× faster than Whisper small and far more robust in noise (4.5% vs 12% at 0 dB); clean-speech WER is similar. The automatic CPU fallback prefers an installed Parakeet model when it supports the configured language.

## Question engine (text level)

| Set | Items | Detection P / R / F1 | Kind | Category | Exact format | Follow-up resolution |
|---|---|---|---|---|---|---|
| Development (`question_dataset.json`, used for tuning) | 65 (62 questions) | 1.00 / 1.00 / 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| **Held-out, first run** (`question_heldout_report_first_run.json`) | 25 (23 questions) | **1.00 / 0.957 / 0.978** | 1.00 | **0.864** | **0.864** | 1.00 |
| Held-out, current | 25 | 1.00 / 1.00 / 1.00 | 1.00 | 0.957 | 1.00 | 1.00 |

The **first-run held-out numbers are the honest generalization estimate.** After that run, the bugs it exposed were fixed: generic words in topic lists, the indirect-cue precedence, and "my question is". Two labels were corrected: a wrong capitalization, and the article in a resolved follow-up after article-preserving resolution was added. The current held-out row is therefore no longer independent.

Ingest latency is 0.4–0.5 ms p50 per segment, with a 2.4 ms maximum on the CPU.

### Classification confidence calibration (development set)

| Heuristic score | n | Observed accuracy |
|---|---|---|
| 0.3 | 5 | 0.40 |
| 0.7 | 16 | 0.88 |
| 0.8 | 12 | 0.83 |
| 0.9 | 22 | 1.00 |

These scores are monotonic but uncalibrated (`calibrated: false`), so the UI shows them as "topic confidence", not as a probability. The table above is from the first development run; `evaluate.py` regenerates it.
