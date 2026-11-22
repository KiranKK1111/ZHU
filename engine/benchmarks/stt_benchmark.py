"""Speech-to-text benchmark on the local GPU/CPU (Master Prompt, sections 6, 16, 20).

    python benchmarks/stt_benchmark.py --models-dir benchmarks/models [--configs turbo-fp16,turbo-int8,small-fp16,small-cpu] [--e2e]
    python benchmarks/stt_benchmark.py --configs parakeet-v2-dml,parakeet-v2-cpu,parakeet-v3-dml,parakeet-v3-cpu,small-cpu \
        --e2e --e2e-config parakeet-v2-cpu --out benchmarks/results/stt_parakeet.json

Test audio is synthesized with the Windows SAPI voices installed on this machine
(clear, fast, noisy at 10 dB and 0 dB SNR, two-speaker). Synthetic speech is cleaner than real
human speech, so the WER figures are a lower bound on real-world error. Accented
English is NOT covered because no accented voices are installed. Everything is
measured. Nothing is estimated or invented.

Measures per configuration: model load time (including warm-up), VRAM delta (NVML),
peak VRAM during decoding, per-clip final-decode latency, real-time factor,
partial-decode latency, WER, CPU time, and question detection on the STT output.
--e2e also runs the full streaming pipeline in real time (VAD -> partial/final STT ->
question engine) and measures end-of-speech -> question.completed latency.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from zhu_engine.system.gpu import GpuMonitor, register_cuda_dlls  # noqa: E402

CLIPS = [
    ("q-di", "can you explain what dependency injection is and how spring boot manages beans", True),
    ("q-eq", "what is the difference between double equals and triple equals in javascript", True),
    ("q-ll", "write a program to reverse a linked list", True),
    ("q-lru", "implement an LRU cache", True),
    ("q-hm", "what is HashMap in Java", True),
    ("q-micro", "what is a microservice, why would you use it, and how would you handle distributed transactions", True),
    ("q-sql", "write a query to find the second highest salary from the employee table", True),
    ("q-k8s", "what is kubernetes and how is it different from docker", True),
    ("q-math", "what is twenty percent of five hundred", True),
    ("q-scen", "suppose your application receives one million requests per second. how would you design the architecture", True),
    ("q-behav", "tell me about a time you handled a production incident", True),
    ("q-react", "how does react decide when to re-render a component", True),
    ("q-pg", "why would you choose postgres over mongodb for a payments system", True),
    ("q-kafka", "how does kafka guarantee message ordering within a partition", True),
    ("q-short", "what is polymorphism", True),
    ("q-long", "imagine you are designing a url shortener that must handle billions of links. explain how you would generate unique keys, store the mappings, and keep redirects fast under heavy load", True),
    ("s-thanks", "okay, thank you, that makes sense", False),
    ("s-exp", "i worked on a payments platform for three years", False),
    ("s-time", "we have about ten minutes left", False),
    ("s-good", "great answer, let's move on", False),
]
VARIANTS = {
    "clear": {"voice": "Microsoft David Desktop", "rate": 0, "snr_db": None},
    "fast": {"voice": "Microsoft Zira Desktop", "rate": 4, "snr_db": None},
    "noisy10": {"voice": "Microsoft David Desktop", "rate": 0, "snr_db": 10.0},
    "noisy0": {"voice": "Microsoft Zira Desktop", "rate": 0, "snr_db": 0.0},
}
CONFIGS = {
    "turbo-fp16": ("large-v3-turbo", "cuda", "float16"),
    "turbo-int8": ("large-v3-turbo", "cuda", "int8_float16"),
    "small-fp16": ("small", "cuda", "float16"),
    "small-int8": ("small", "cuda", "int8_float16"),
    "small-cpu": ("small", "cpu", "int8"),
    "parakeet-v2-dml": ("parakeet-tdt-0.6b-v2", "directml", "float32"),
    "parakeet-v2-cpu": ("parakeet-tdt-0.6b-v2", "cpu", "int8"),
    "parakeet-v3-dml": ("parakeet-tdt-0.6b-v3", "directml", "float32"),
    "parakeet-v3-cpu": ("parakeet-tdt-0.6b-v3", "cpu", "int8"),
}


def process_commit_mb() -> tuple[int, int]:
    """(current, peak) commit charge of this process in MB (Windows)."""
    import ctypes
    from ctypes import wintypes

    class PMC(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (n, ctypes.c_size_t) for n in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
                                           "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]

    c = PMC()
    c.cb = ctypes.sizeof(c)
    k32, psapi = ctypes.WinDLL("kernel32"), ctypes.WinDLL("psapi")
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
    psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(c), c.cb)
    return c.PagefileUsage >> 20, c.PeakPagefileUsage >> 20

_PS = r"""
Add-Type -AssemblyName System.Speech
$jobs = Get-Content -Raw -Path $args[0] | ConvertFrom-Json
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($j in $jobs) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice($j.voice); $s.Rate = [int]$j.rate
  $s.SetOutputToWaveFile($j.path, $fmt); $s.Speak($j.text); $s.Dispose()
}
"""


def synthesize(out_dir: Path) -> dict[str, dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    jobs, meta = [], {}
    for variant, v in VARIANTS.items():
        for cid, text, is_q in CLIPS:
            path = out_dir / f"{variant}-{cid}.wav"
            meta[f"{variant}-{cid}"] = {"path": path, "text": text, "is_question": is_q, "variant": variant, "snr_db": v["snr_db"]}
            if not path.exists():
                jobs.append({"path": str(path if v["snr_db"] is None else path.with_suffix(".clean.wav")), "text": text, "voice": v["voice"], "rate": v["rate"]})
    # Two-speaker clip: question by one voice, answer by the other.
    two = out_dir / "two-speakers.wav"
    if not two.exists():
        jobs += [{"path": str(out_dir / "two-a.wav"), "text": "what is the difference between a process and a thread", "voice": "Microsoft David Desktop", "rate": 0},
                 {"path": str(out_dir / "two-b.wav"), "text": "a process has its own memory space while threads share memory within a process", "voice": "Microsoft Zira Desktop", "rate": 0}]
    if jobs:
        with tempfile.TemporaryDirectory() as td:
            jf, sf = Path(td) / "jobs.json", Path(td) / "tts.ps1"
            jf.write_text(json.dumps(jobs), "utf-8")
            sf.write_text(_PS, "utf-8")
            subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(sf), str(jf)], check=True)
    rng = np.random.default_rng(1234)
    for key, m in meta.items():
        if m["snr_db"] is not None and not m["path"].exists():
            clean = read_wav(m["path"].with_suffix(".clean.wav"))
            power = np.mean(clean**2)
            # Pink-ish noise: integrated white noise, high-passed by subtracting a moving average.
            white = rng.standard_normal(clean.size + 64)
            pink = np.convolve(white, np.ones(8) / 8, mode="same")[: clean.size]
            noise = pink / np.sqrt(np.mean(pink**2)) * np.sqrt(power / (10 ** (m["snr_db"] / 10)))
            write_wav(m["path"], np.clip(clean + noise, -1, 1).astype(np.float32))
            m["path"].with_suffix(".clean.wav").unlink(missing_ok=True)
    if not two.exists():
        a, b = read_wav(out_dir / "two-a.wav"), read_wav(out_dir / "two-b.wav")
        write_wav(two, np.concatenate([a, np.zeros(8000, np.float32), b]))
    meta["two-speakers"] = {"path": two, "text": "what is the difference between a process and a thread a process has its own memory space while threads share memory within a process",
                            "is_question": True, "variant": "two-speakers", "snr_db": None}
    return meta


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def write_wav(path: Path, x: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())


_NUM = {"twenty": "20", "five": "5", "hundred": "100", "one": "1", "million": "1000000", "ten": "10", "three": "3"}


def norm_words(text: str) -> list[str]:
    t = text.lower().replace("-", " ").replace("%", " percent")
    t = re.sub(r"[^a-z0-9' ]", " ", t)
    out = []
    for w in t.split():
        out.append(_NUM.get(w, w))
    joined = " ".join(out)
    joined = re.sub(r"\b(\d+) (\d+)\b", lambda m: str(int(m.group(1)) * int(m.group(2))) if m.group(2) in ("100", "1000000") else m.group(0), joined)
    return joined.split()


def wer(ref: str, hyp: str) -> tuple[int, int]:
    r, h = norm_words(ref), norm_words(hyp)
    d = np.zeros((len(r) + 1, len(h) + 1), dtype=np.int32)
    d[:, 0] = np.arange(len(r) + 1)
    d[0, :] = np.arange(len(h) + 1)
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i, j] = min(d[i - 1, j] + 1, d[i, j - 1] + 1, d[i - 1, j - 1] + (r[i - 1] != h[j - 1]))
    return int(d[len(r), len(h)]), len(r)


class VramSampler(threading.Thread):
    def __init__(self, gpu: GpuMonitor) -> None:
        super().__init__(daemon=True)
        self.gpu, self.peak, self._stop = gpu, 0, threading.Event()

    def run(self) -> None:
        while not self._stop.wait(0.05):
            info = self.gpu.info()
            if info.vram_used_mb:
                self.peak = max(self.peak, info.vram_used_mb)

    def stop(self) -> int:
        self._stop.set()
        self.join(1)
        return self.peak


def detect_questions(texts: list[tuple[str, str]]) -> list:
    from zhu_engine.questions import AudioSource, QuestionEngine, TechnicalVocabulary, TranscriptSegment

    vocab = TechnicalVocabulary.load()
    results = []
    for key, text in texts:
        eng = QuestionEngine("bench", vocab)
        eng.ingest_segment(TranscriptSegment("s", 1, text, 0, 3000, True, AudioSource.SYSTEM))
        eng.tick(10_000)
        qs = [q for q in eng.questions.values() if q.state.value != "DISCARDED"]
        results.append((key, qs))
    return results


def bench_config(name: str, models_dir: Path, clips: dict[str, dict], gpu: GpuMonitor) -> dict:
    from zhu_engine.stt.models import CATALOG

    model_name, device, compute = CONFIGS[name]
    parakeet = CATALOG[model_name].backend == "parakeet"
    register_cuda_dlls()
    before = gpu.info().vram_used_mb or 0
    commit_before, _ = process_commit_mb()
    t0 = time.perf_counter()
    try:
        if parakeet:
            from zhu_engine.stt.parakeet import ParakeetModel

            model = ParakeetModel(models_dir / model_name, device=device, precision=compute, cpu_threads=4)
            model.transcribe(np.zeros(16000, np.float32))

            def final_text(audio: np.ndarray) -> str:
                return model.transcribe(audio).text

            def partial_decode(audio: np.ndarray) -> None:
                model.transcribe(audio)  # Parakeet partials are the same greedy decode
        else:
            from faster_whisper import WhisperModel

            model = WhisperModel(str(models_dir / model_name), device=device, compute_type=compute, cpu_threads=4 if device == "cpu" else 0)
            list(model.transcribe(np.zeros(16000, np.float32), language="en", beam_size=1)[0])

            def final_text(audio: np.ndarray) -> str:
                segs, _ = model.transcribe(audio, language="en", beam_size=5, word_timestamps=True, condition_on_previous_text=False, vad_filter=False)
                return " ".join(s.text.strip() for s in segs).strip()

            def partial_decode(audio: np.ndarray) -> None:
                list(model.transcribe(audio, language="en", beam_size=1, temperature=0.0, without_timestamps=True, condition_on_previous_text=False, vad_filter=False)[0])
    except Exception as exc:  # recorded as a result: it is a real finding on this machine
        import ctypes

        class MEMSTAT(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                        ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        ms = MEMSTAT(); ms.dwLength = ctypes.sizeof(ms); ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
        return {"config": name, "model": model_name, "device": device, "compute_type": compute, "load_error": repr(exc)[:300],
                "host_ram_free_mb": ms.ullAvailPhys // 2**20, "host_commit_free_mb": ms.ullAvailPageFile // 2**20, "vram_used_mb": gpu.info().vram_used_mb}
    load_s = time.perf_counter() - t0
    after = gpu.info().vram_used_mb or 0
    commit_after_load, _ = process_commit_mb()
    sampler = VramSampler(gpu)
    sampler.start()
    rows = []
    cpu0 = time.process_time()
    wall0 = time.perf_counter()
    for key, m in clips.items():
        audio = read_wav(m["path"])
        dur = audio.size / 16000
        t = time.perf_counter()
        text = final_text(audio)
        final_ms = (time.perf_counter() - t) * 1000
        part = audio[: int(audio.size * 0.6)]
        t = time.perf_counter()
        partial_decode(part)
        partial_ms = (time.perf_counter() - t) * 1000
        errs, n = wer(m["text"], text)
        rows.append({"clip": key, "variant": m["variant"], "duration_s": round(dur, 2), "final_ms": round(final_ms), "partial_ms": round(partial_ms),
                     "rtf": round(final_ms / 1000 / dur, 3), "errors": errs, "words": n, "hypothesis": text, "reference": m["text"], "is_question": m["is_question"]})
    cpu_s = time.process_time() - cpu0
    wall_s = time.perf_counter() - wall0
    peak = sampler.stop()
    _, commit_peak = process_commit_mb()
    del model

    by_variant: dict[str, dict] = {}
    for r in rows:
        v = by_variant.setdefault(r["variant"], {"errors": 0, "words": 0, "final_ms": [], "rtf": []})
        v["errors"] += r["errors"]
        v["words"] += r["words"]
        v["final_ms"].append(r["final_ms"])
        v["rtf"].append(r["rtf"])
    summary = {}
    for v, s in by_variant.items():
        lat = sorted(s["final_ms"])
        summary[v] = {"wer": round(s["errors"] / s["words"], 4), "final_ms_p50": lat[len(lat) // 2], "final_ms_max": lat[-1], "rtf_mean": round(float(np.mean(s["rtf"])), 3)}
    det = detect_questions([(r["clip"], r["hypothesis"]) for r in rows if r["variant"] in ("clear", "fast", "noisy10", "noisy0")])
    truth = {r["clip"]: r["is_question"] for r in rows}
    tp = sum(1 for k, qs in det if qs and truth[k])
    fp = sum(1 for k, qs in det if qs and not truth[k])
    fn = sum(1 for k, qs in det if not qs and truth[k])
    partial = sorted(r["partial_ms"] for r in rows)
    return {
        "config": name, "model": model_name, "device": device, "compute_type": compute,
        "load_s": round(load_s, 2), "vram_before_mb": before, "vram_after_load_mb": after, "vram_model_delta_mb": after - before if device != "cpu" else None,
        "vram_peak_mb": peak if device != "cpu" else None,
        "process_commit_model_mb": commit_after_load - commit_before, "process_commit_peak_mb": commit_peak,
        "cpu_utilization_pct_of_one_core": round(100 * cpu_s / wall_s, 1),
        "partial_ms_p50": partial[len(partial) // 2], "partial_ms_max": partial[-1],
        "by_variant": summary,
        "question_detection_on_stt": {"tp": tp, "fp": fp, "fn": fn, "precision": round(tp / (tp + fp), 3) if tp + fp else None, "recall": round(tp / (tp + fn), 3) if tp + fn else None},
        "clips": rows,
    }


def run_e2e(models_dir: Path, clips: dict[str, dict], report_results: list, config: str | None = None) -> dict:
    """Feed a conversation through the real streaming pipeline in real time and time
    end-of-speech -> question.completed for each question."""
    import asyncio

    from zhu_engine.questions import AudioSource, QuestionEngine, TechnicalVocabulary
    from zhu_engine.stt.models import Selection
    from zhu_engine.stt.transcriber import SttOptions, Transcriber
    from zhu_engine.vad.segmenter import Segmenter, VadConfig

    keys = ["clear-q-di", "clear-q-eq", "clear-q-ll", "clear-q-micro", "clear-s-thanks", "clear-q-scen", "clear-q-kafka", "clear-q-short"]
    gap = np.zeros(int(16000 * 2.5), np.float32)
    pieces, ends = [], []
    pos = 0
    for k in keys:
        a = read_wav(clips[k]["path"])
        pieces += [a, gap]
        pos += a.size
        ends.append((k, pos))
        pos += gap.size
    stream = np.concatenate(pieces)

    loop = asyncio.new_event_loop()
    eng = QuestionEngine("e2e", TechnicalVocabulary.load())
    completed: list[tuple[str, float, str]] = []
    t_start = [0.0]

    def clock_ms() -> int:
        return int((time.perf_counter() - t_start[0]) * 1000)

    def handle(evs):
        for e in evs:
            if e.event_type.value == "question.completed":
                completed.append((e.question.formatted_text, time.perf_counter(), e.question.question_id))

    open_seg = {}

    def on_seg(seg, meta):
        loop.call_soon_threadsafe(lambda: handle(eng.ingest_segment(seg)))

    if config:
        selection = Selection(*CONFIGS[config], "bench")
    else:
        ok = [r for r in report_results if "load_error" not in r and "process_error" not in r and r.get("model") == "large-v3-turbo"]
        selection = Selection("large-v3-turbo", "cuda", ok[0]["compute_type"] if ok else "int8_float16", "bench")
    sel = selection.compute_type
    tr = Transcriber(models_dir, selection, SttOptions(beam_size_final=3), on_seg, lambda m: print("STT error", m))
    tr.start()
    tr.ready.wait(300)

    def on_start(seg):
        open_seg["id"], open_seg["rev"], open_seg["last"] = f"e{seg.index}", 0, 0.0
        loop.call_soon_threadsafe(lambda: handle(eng.on_speech_start(AudioSource.SYSTEM, seg.start_sample // 16)))

    def on_audio(seg):
        now = time.perf_counter()
        if now - open_seg["last"] >= 0.7:
            open_seg["last"] = now
            open_seg["rev"] += 1
            tr.submit(open_seg["id"], AudioSource.SYSTEM, seg.samples(), seg.start_sample // 16, False, open_seg["rev"])

    def on_end(seg):
        tr.submit(open_seg["id"], AudioSource.SYSTEM, seg.samples(), seg.start_sample // 16, True, 1000)
        loop.call_soon_threadsafe(lambda: handle(eng.on_speech_end(AudioSource.SYSTEM, (seg.end_sample or 0) // 16)))

    segm = Segmenter("system", VadConfig(), on_start, on_audio, on_end)

    async def ticker():
        while True:
            await asyncio.sleep(0.05)
            handle(eng.tick(clock_ms()))

    def feeder():
        block = 320
        t_start[0] = time.perf_counter()
        for i in range(0, stream.size, block):
            target = t_start[0] + i / 16000
            delay = target - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            segm.feed(stream[i : i + block], i)
        time.sleep(4)
        loop.call_soon_threadsafe(loop.stop)

    tick_task = loop.create_task(ticker())
    threading.Thread(target=feeder, daemon=True).start()
    loop.run_forever()
    tick_task.cancel()
    loop.run_until_complete(asyncio.gather(tick_task, return_exceptions=True))
    tr.stop()
    results = []
    for (k, end_sample), _ in zip(ends, range(len(ends))):
        if not clips[k]["is_question"]:
            continue
        speech_end = t_start[0] + end_sample / 16000
        match = next((c for c in completed if c[1] >= speech_end and c[1] - speech_end < 10), None)
        results.append({"clip": k, "completed": match is not None, "latency_ms": round((match[1] - speech_end) * 1000) if match else None,
                        "text": match[0] if match else None})
        if match:
            completed.remove(match)
    lat = sorted(r["latency_ms"] for r in results if r["latency_ms"] is not None)
    return {"model": selection.model, "device": selection.device, "compute_type": sel, "questions": len(results), "completed": len(lat), "extra_questions": len(completed),
            "speech_end_to_question_completed_ms": {"p50": lat[len(lat) // 2] if lat else None, "max": lat[-1] if lat else None},
            "per_question": results, "stt_stats": tr.stats}


def _child(args) -> None:
    """Run exactly one measurement in this (fresh) process and write it as JSON."""
    clips = synthesize(Path(args.audio_dir))
    models_dir = Path(args.models_dir)
    if args.only == "e2e":
        prior = json.loads(Path(args.prior).read_text("utf-8")) if args.prior else []
        result = run_e2e(models_dir, clips, prior, args.e2e_config)
    else:
        result = bench_config(args.only, models_dir, clips, GpuMonitor())
    Path(args.out).write_text(json.dumps(result), "utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models-dir", default=str(Path(__file__).parent / "models"))
    ap.add_argument("--audio-dir", default=str(Path(__file__).parent / "audio"))
    ap.add_argument("--configs", default="turbo-int8,turbo-fp16,small-int8,small-fp16,small-cpu")
    ap.add_argument("--e2e", action="store_true")
    ap.add_argument("--e2e-config", default=None, help="configuration for --e2e (default: large-v3-turbo, best measured compute type)")
    ap.add_argument("--out", default=str(Path(__file__).parent / "results" / "stt_results.json"))
    ap.add_argument("--only", help=argparse.SUPPRESS)
    ap.add_argument("--prior", help=argparse.SUPPRESS)
    args = ap.parse_args()
    if args.only:
        return _child(args)
    synthesize(Path(args.audio_dir))
    info = GpuMonitor().info()
    report = {"measured_at": time.strftime("%Y-%m-%d %H:%M:%S"), "gpu": info.to_dict(), "isolation": "one process per configuration", "results": []}
    out_dir = Path(args.out).parent
    out_dir.mkdir(parents=True, exist_ok=True)

    def child(only: str, prior: str | None = None) -> dict:
        tmp = out_dir / f".{only}.json"
        cmd = [sys.executable, __file__, "--only", only, "--out", str(tmp), "--models-dir", args.models_dir, "--audio-dir", args.audio_dir]
        if prior:
            cmd += ["--prior", prior]
        if args.e2e_config:
            cmd += ["--e2e-config", args.e2e_config]
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if not tmp.exists():
            return {"config": only, "process_error": (proc.stderr or proc.stdout)[-800:]}
        data = json.loads(tmp.read_text("utf-8"))
        tmp.unlink()
        return data

    for name in [c for c in args.configs.split(",") if c and c != "none"]:
        print(f"== {name}", flush=True)
        r = child(name)
        report["results"].append(r)
        print(json.dumps({k: v for k, v in r.items() if k != "clips"}, indent=1), flush=True)
    if args.e2e:
        print("== end-to-end (real time)", flush=True)
        prior = out_dir / ".prior.json"
        prior.write_text(json.dumps([{k: v for k, v in r.items() if k != "clips"} for r in report["results"]]), "utf-8")
        report["e2e"] = child("e2e", str(prior))
        prior.unlink(missing_ok=True)
        print(json.dumps(report["e2e"], indent=1), flush=True)
    Path(args.out).write_text(json.dumps(report, indent=1), "utf-8")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
