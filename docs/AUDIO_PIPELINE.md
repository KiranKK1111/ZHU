# Audio and Transcription Pipeline

```text
WASAPI device (PortAudio callback, 20 ms blocks, float32)
  └─► bounded queue (200 blocks ≈ 4 s; drops OLDEST when full, counted in dropped_blocks)
        └─► capture worker thread
              Preprocessor: down-mix → soxr HQ resample to 16 kHz → 80 Hz one-pole high-pass → optional soft noise gate
              └─► Segmenter (per source): Silero VAD v6 (onnxruntime, CPU provider, 32 ms chunks, recurrent state)
                    hysteresis start 0.50 / end 0.35 · min speech 250 ms · min silence 550 ms · pre-roll 300 ms
                    max segment 25 s (split at the quietest recent chunk)
                    ├─ on_start  → QuestionEngine.on_speech_start (loop thread)
                    ├─ on_audio  → every 700 ms: partial job (greedy, no timestamps)
                    └─ on_end    → final job (beam search, word timestamps) + QuestionEngine.on_speech_end
                          └─► Transcriber (ONE thread owns the model — Whisper or Parakeet; finals first; partials coalesced; ≤ 8 pending)
                                └─► loop.call_soon_threadsafe → transcript.partial/final events → QuestionEngine.ingest_segment
```

## Sources

* **Microphone**: the WASAPI input device (Windows default, or the device chosen in Settings → Listening).
* **System audio**: WASAPI **loopback** of a render endpoint, which captures everything playing on that output. A loopback endpoint delivers no packets while nothing plays; the capture worker synthesizes silence so timestamps stay continuous.
* Both sources can run at once, or one of them (**Listen to**: system audio and microphone, system audio only, microphone only; `audio.system_enabled` / `audio.microphone_enabled`). A change while listening starts the newly chosen source on the session's audio clock, so timestamps and question timing line up, and then stops the one no longer chosen (what it was saying is finished first); the session, its timer and its questions go on. Each source has its own VAD and segment stream, labeled by source. The labels ("Microphone" and "System audio" by default) are configurable. ZHU never assumes system audio is "the interviewer".
* Device IDs are stable (`<kind>:<device name>`). An unplugged or failed device triggers reconnection with exponential backoff (0.5 → 5 s), falling back to the current default device. Each capture thread initializes COM (multithreaded) before it opens a stream: PortAudio's WASAPI backend sets up COM only on the thread that initializes it, so a microphone opened while system audio was already capturing (chosen during listening, or reconnecting) failed with "Unanticipated host error" on every try. The status appears in `listening.status.sources`.

## Streaming semantics

Whisper is a 30-second-window encoder–decoder, **not** a native streaming model, and ZHU runs Parakeet the same way. ZHU approximates streaming:

1. Partial results come from re-decoding the growing VAD segment every `partial_interval_ms` (700 ms default). They may change between revisions and are shown as provisional (muted) text.
2. The final result is decoded once at end of speech with beam search and word timestamps, and it replaces the provisional text (same `segment_id`, higher `revision`).
3. Segments are cut by VAD and never overlap, so no words are duplicated. For forced splits of long monologues, the first words of the next segment are de-duplicated against the end of the previous one.
4. Timestamps are milliseconds on the **session clock** (since the session started), consistent across sources and across pause/resume.
5. Whisper only: the last ~200 characters of the previous final text are passed as `initial_prompt` for continuity. Distinctive vocabulary terms are passed as `hotwords`.

## Speech back ends

| Back end | Models | Runtime | GPU | CPU |
|---|---|---|---|---|
| `whisper` | large-v3-turbo, large-v3, distil-large-v3, medium, small, base | faster-whisper / CTranslate2 | CUDA 12, FP16 or INT8/FP16 | INT8 |
| `parakeet` | NVIDIA Parakeet TDT 0.6B v2 (English), v3 (25 European languages) | ONNX Runtime (`stt/parakeet.py`), no PyTorch or NeMo | DirectML, FP32 encoder | INT8 encoder |

Parakeet differs from Whisper in ways the pipeline accounts for:

* It is a transducer (FastConformer encoder + TDT decoder), not an encoder–decoder with a 30 s window. ZHU decodes it greedily; partial and final decodes are the same decode on the growing segment.
* It has no prompt, hotwords, or beam search, so `initial_prompt`, vocabulary hints, and the performance profile do not apply. The question engine's vocabulary normalization still applies to detected questions.
* Word timings come from the frames at which tokens are emitted (80 ms resolution) plus the predicted durations. Word probability is the mean token probability, so low-confidence words are underlined just like Whisper's.
* It does not hallucinate text on silence in the tests (empty output), but the energy-based guard below runs for both back ends.
* Why DirectML and not CUDA: onnxruntime-gpu releases after 1.26 target CUDA 13, while CTranslate2 uses CUDA 12. The CUDA execution provider would also add its own DLL (about 190 MB) plus cuFFT and cuRAND, which pushes the frozen engine past the installer's 2 GB limit. The DirectML build adds about 20 MB and needs no CUDA libraries. On DirectML the INT8 encoder is slower than on the CPU (its integer operators fall back to the CPU), so INT8 always runs on the CPU. `performance_preference=high_performance` makes DirectML pick the discrete GPU on hybrid-graphics laptops; this was verified by the VRAM increase on the NVIDIA GPU.

## Model selection and GPU budget

`stt/models.select_model` chooses the best installed model that fits `min(vram_budget_mb, free VRAM − 768 MB reserve)`, using the planning estimates in `CATALOG`: FP16 first, then INT8/FP16, then smaller models, then CPU INT8. Fallback models must support the configured language (Parakeet v2 and Distil-Whisper are English only).

For a **preferred Parakeet model**: DirectML FP32 if an NVIDIA GPU is detected, DirectML is available, the VRAM estimate fits, and at least 4 GB of commit charge is free (`GPU_LOAD_COMMIT_MB`; a DirectML load peaks at about 3.5 GB of process commit). Otherwise, or with precision set to INT8, the same model runs on the CPU with INT8 weights (peak about 1.5 GB). The selection reason says which condition decided it. On a machine without a usable GPU, an installed Parakeet model is also preferred over Whisper `small` as the CPU fallback when it supports the language.

If loading fails anyway, `SessionService` walks a **fallback ladder**: same model INT8/FP16 → smaller models on GPU → CPU. For Parakeet: DirectML → the same model on the CPU (INT8) → Whisper small/base on the CPU. This matters because CTranslate2 can report a host-RAM / commit-charge allocation failure as `CUDA failed with error out of memory`, and DirectML reports it as `E_OUTOFMEMORY`. That was observed on this machine; see BENCHMARKS.md.

## Hallucination guard

Whisper emits phrases such as "Thank you." for silence and noise. A short segment whose text matches a known hallucination is dropped if either the decoder's `no_speech_prob > 0.5` **or** the audio is quieter than −50 dBFS. The energy check exists because a measurement here showed `no_speech_prob = 0.0` on pure silence.

## Noise reduction

The optional noise gate is a soft downward expander that tracks the noise floor. It reduces steady hiss between words. It is **not** a spectral denoiser. In the benchmarks, robustness to noise comes mainly from Whisper itself (see BENCHMARKS.md, 10 dB and 0 dB SNR results).
