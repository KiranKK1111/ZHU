"""NVIDIA Parakeet TDT speech recognition on ONNX Runtime (no PyTorch, no NeMo).

Model files are the ONNX export of nvidia/parakeet-tdt-0.6b-v2 / -v3 published as
``istupakov/parakeet-tdt-0.6b-v{2,3}-onnx`` (CC-BY-4.0, like the original models):

    nemo128.onnx                    log-mel feature extractor (128 bins, 10 ms hop)
    encoder-model.onnx (+ .data)    FastConformer encoder, FP32 (about 2.4 GB)
    decoder_joint-model.onnx        prediction network + joint network, FP32
    encoder-model.int8.onnx         dynamically quantized INT8 encoder (about 0.65 GB)
    decoder_joint-model.int8.onnx
    vocab.txt                       SentencePiece vocabulary, one "<token> <id>" per line

Decoding is greedy Token-and-Duration Transducer (TDT) decoding. For each encoder frame the
joint network predicts a token and a duration (how many frames to advance). The algorithm
follows the reference implementation in onnx-asr (MIT, github.com/istupakov/onnx-asr).

Where it runs (measured on the RTX 5060 laptop, see docs/BENCHMARKS.md):
* GPU: DirectML with the FP32 encoder. INT8 is not used on DirectML because its integer
  operators fall back to the CPU and it ends up slower than plain CPU inference.
* CPU: INT8 encoder.
The feature extractor and the step-by-step decoder always run on the CPU. They are tiny, and
a GPU dispatch per decoding step would cost more than the computation itself.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence

import numpy as np

log = logging.getLogger(__name__)

SR = 16_000
_SPACE = "▁"  # SentencePiece word-boundary marker
REQUIRED_FILES = (
    "nemo128.onnx",
    "encoder-model.onnx",
    "encoder-model.onnx.data",
    "decoder_joint-model.onnx",
    "encoder-model.int8.onnx",
    "decoder_joint-model.int8.onnx",
    "vocab.txt",
)


@dataclass(frozen=True)
class ParakeetWord:
    text: str
    start_s: float
    end_s: float
    probability: float


@dataclass(frozen=True)
class ParakeetResult:
    text: str
    words: tuple[ParakeetWord, ...]


def directml_available() -> bool:
    try:
        import onnxruntime as ort

        return "DmlExecutionProvider" in ort.get_available_providers()
    except Exception:
        return False


def group_words(pieces: Sequence[str], frames: Sequence[int], durations: Sequence[int], logprobs: Sequence[float],
                frame_s: float) -> tuple[str, list[ParakeetWord]]:
    """Join SentencePiece pieces into text and words.

    A piece starting with U+2581 begins a new word; other pieces (sub-words, punctuation)
    attach to the current word. A word spans from its first piece's frame to the end of its
    last piece (frame + predicted duration, at least one frame). Word probability is the mean
    token probability, like faster-whisper's word probability.
    """
    words: list[ParakeetWord] = []
    cur: list[int] = []

    def flush() -> None:
        if not cur:
            return
        text = "".join(pieces[i] for i in cur).replace(_SPACE, "").strip()
        if text:
            start = frames[cur[0]] * frame_s
            end = (frames[cur[-1]] + max(1, durations[cur[-1]])) * frame_s
            prob = float(np.mean(np.exp(np.asarray([logprobs[i] for i in cur], dtype=np.float64))))
            words.append(ParakeetWord(text, round(start, 3), round(end, 3), round(prob, 4)))
        cur.clear()

    for i, p in enumerate(pieces):
        if p.startswith(_SPACE) and cur:
            flush()
        cur.append(i)
    flush()
    text = re.sub(r"\s+", " ", "".join(pieces).replace(_SPACE, " ")).strip()
    return text, words


class ParakeetModel:
    MAX_SYMBOLS_PER_STEP = 10

    def __init__(self, model_dir: Path, device: str = "cpu", precision: str = "int8", cpu_threads: int = 4) -> None:
        import onnxruntime as ort

        self.model_dir = Path(model_dir)
        self.device = device
        self.precision = precision
        cfg_path = self.model_dir / "config.json"
        cfg = json.loads(cfg_path.read_text("utf-8")) if cfg_path.exists() else {}
        self.features_size = int(cfg.get("features_size", 128))
        self.frame_s = 0.01 * int(cfg.get("subsampling_factor", 8))

        def options(threads: int) -> "ort.SessionOptions":
            o = ort.SessionOptions()
            o.log_severity_level = 3
            o.intra_op_num_threads = threads
            o.inter_op_num_threads = 1
            # ONNX Runtime's worker threads busy-wait between runs by default. With several
            # sessions that kept about 10 cores busy in the benchmark; ZHU runs next to video calls.
            o.add_session_config_entry("session.intra_op.allow_spinning", "0")
            return o

        suffix = ".int8" if precision == "int8" else ""
        if device == "directml":
            if not directml_available():
                raise RuntimeError("DirectML is not available in this onnxruntime build")
            enc_opts = options(1)  # only shape computations run on the CPU
            # Required by the DirectML execution provider.
            enc_opts.enable_mem_pattern = False
            enc_opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            # high_performance selects the discrete GPU on hybrid-graphics laptops.
            enc_providers: list = [("DmlExecutionProvider", {"performance_preference": "high_performance", "device_filter": "gpu"}),
                                   "CPUExecutionProvider"]
        elif device == "cpu":
            enc_opts, enc_providers = options(max(1, cpu_threads)), ["CPUExecutionProvider"]
        else:
            raise ValueError(f"unsupported Parakeet device {device!r}")

        # The feature extractor and the per-step decoder are tiny; one thread each avoids
        # thread-pool synchronization on every one of the decoder's many small runs.
        self._pre = ort.InferenceSession(str(self.model_dir / f"nemo{self.features_size}.onnx"), options(1), providers=["CPUExecutionProvider"])
        self._enc = ort.InferenceSession(str(self.model_dir / f"encoder-model{suffix}.onnx"), enc_opts, providers=enc_providers)
        if device == "directml" and self._enc.get_providers()[0] != "DmlExecutionProvider":
            raise RuntimeError("DirectML could not run the Parakeet encoder")
        self._dec = ort.InferenceSession(str(self.model_dir / f"decoder_joint-model{suffix}.onnx"), options(1), providers=["CPUExecutionProvider"])

        self._vocab: dict[int, str] = {}
        for line in (self.model_dir / "vocab.txt").read_text("utf-8").splitlines():
            if line.strip():
                tok, idx = line.rsplit(" ", 1)
                self._vocab[int(idx)] = tok
        self._blank = next(i for i, t in self._vocab.items() if t == "<blk>")
        self._vocab_size = len(self._vocab)
        shapes = {i.name: i.shape for i in self._dec.get_inputs()}
        self._state_shapes = (shapes["input_states_1"], shapes["input_states_2"])

    def close(self) -> None:
        self._pre = self._enc = self._dec = None  # type: ignore[assignment]

    def transcribe(self, audio: np.ndarray) -> ParakeetResult:
        audio = np.ascontiguousarray(audio, dtype=np.float32)
        if audio.size < SR // 10:  # under 100 ms: nothing to recognize
            return ParakeetResult("", ())
        feats, feat_lens = self._pre.run(None, {"waveforms": audio[None, :], "waveforms_lens": np.array([audio.size], dtype=np.int64)})
        enc_out, enc_lens = self._enc.run(["outputs", "encoded_lengths"], {"audio_signal": feats, "length": feat_lens})
        frames_out = enc_out[0].T  # [T, D]
        n_frames = min(int(enc_lens[0]), frames_out.shape[0])

        s1, s2 = self._state_shapes
        state1 = np.zeros((s1[0], 1, s1[2]), dtype=np.float32)
        state2 = np.zeros((s2[0], 1, s2[2]), dtype=np.float32)
        tokens: list[int] = []
        frames: list[int] = []
        durations: list[int] = []
        logprobs: list[float] = []
        t = emitted = 0
        V = self._vocab_size
        while t < n_frames:
            out, new1, new2 = self._dec.run(["outputs", "output_states_1", "output_states_2"], {
                "encoder_outputs": frames_out[t][None, :, None],
                "targets": np.array([[tokens[-1] if tokens else self._blank]], dtype=np.int32),
                "target_length": np.array([1], dtype=np.int32),
                "input_states_1": state1,
                "input_states_2": state2,
            })
            logits = np.squeeze(out)
            tok_logits, dur_logits = logits[:V], logits[V:]
            token = int(tok_logits.argmax())
            step = int(dur_logits.argmax())
            if token != self._blank:
                state1, state2 = new1, new2
                m = float(tok_logits.max())
                logprobs.append(float(tok_logits[token]) - m - float(np.log(np.exp(tok_logits - m).sum())))
                tokens.append(token)
                frames.append(t)
                durations.append(step)
                emitted += 1
            if step > 0:
                t += step
                emitted = 0
            elif token == self._blank or emitted >= self.MAX_SYMBOLS_PER_STEP:
                t += 1
                emitted = 0
        text, words = group_words([self._vocab[i] for i in tokens], frames, durations, logprobs, self.frame_s)
        return ParakeetResult(text, tuple(words))


def model_languages(spec_languages: Optional[Sequence[str]]) -> Optional[str]:
    """Language tag for transcript segments: the single language of an English-only model, else None."""
    return spec_languages[0] if spec_languages and len(spec_languages) == 1 else None
