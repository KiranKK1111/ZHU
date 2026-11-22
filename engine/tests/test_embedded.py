"""The engine run inside another program's process (embedded.py): start, answer, stop, start again."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from zhu_engine import embedded

TOKEN = "t" * 48


class Host:
    """What the desktop shell does: run the engine on a thread and listen to its reports."""

    def __init__(self, data_dir, token: str = TOKEN):
        self.reports: list[tuple[str, str]] = []
        self.ready = threading.Event()
        self.ended = threading.Event()
        self.thread = threading.Thread(target=embedded.run, args=(token, str(data_dir), self.report), daemon=True)

    def report(self, kind: str, text: str) -> None:
        self.reports.append((kind, text))
        (self.ready if kind == "ready" else self.ended).set()

    def start(self) -> "Host":
        self.thread.start()
        return self

    @property
    def port(self) -> int:
        return int(next(text for kind, text in self.reports if kind == "ready"))


def get(port: int, path: str, token: str = TOKEN):
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


@pytest.fixture
def no_real_keys(monkeypatch):
    # The engine reads API keys from the Windows Credential Manager; tests must not touch the user's.
    import keyring
    from keyring.backends.fail import Keyring

    previous = keyring.get_keyring()
    keyring.set_keyring(Keyring())
    monkeypatch.setenv("ZHU_CUDA_UNPACK", "0")
    yield
    keyring.set_keyring(previous)


def test_it_starts_answers_stops_and_starts_again_in_the_same_process(tmp_path, no_real_keys):
    first = Host(tmp_path).start()
    assert first.ready.wait(60), first.reports
    assert embedded.running()
    assert get(first.port, "/api/health")["status"] == "ok"
    with pytest.raises(urllib.error.HTTPError):
        get(first.port, "/api/health", token="x" * 48)

    assert embedded.request_stop() is True
    assert first.ended.wait(30), first.reports
    first.thread.join(10)
    assert first.reports[-1] == ("stopped", "") and not embedded.running()
    assert embedded.request_stop() is False  # nothing left to stop

    # The same data folder, the same process: everything the first run opened was closed.
    second = Host(tmp_path).start()
    assert second.ready.wait(60), second.reports
    assert get(second.port, "/api/health")["status"] == "ok"
    assert isinstance(get(second.port, "/api/settings"), dict)
    embedded.request_stop()
    assert second.ended.wait(30)
    second.thread.join(10)


def test_a_stop_asked_for_while_starting_is_not_lost(tmp_path, no_real_keys):
    host = Host(tmp_path).start()
    # Straight away: the engine is still importing its modules, there is no server yet.
    deadline = time.monotonic() + 10
    while not embedded.running() and time.monotonic() < deadline:
        time.sleep(0.005)
    assert embedded.request_stop() is True
    assert host.ended.wait(60), host.reports
    host.thread.join(10)
    assert host.reports[-1] == ("stopped", "") and not embedded.running()


def test_one_run_at_a_time(tmp_path, no_real_keys):
    first = Host(tmp_path).start()
    assert first.ready.wait(60), first.reports
    reports: list[tuple[str, str]] = []
    embedded.run(TOKEN, str(tmp_path), lambda kind, text: reports.append((kind, text)))
    assert reports == [("failed", "the engine is already running")]
    assert get(first.port, "/api/health")["status"] == "ok"  # the first one is not disturbed
    embedded.request_stop()
    assert first.ended.wait(30)
    first.thread.join(10)


def test_a_failure_is_reported_and_nothing_escapes(tmp_path, no_real_keys, monkeypatch):
    # No usable token: reported as a failure, not raised.
    host = Host(tmp_path, token="short").start()
    assert host.ended.wait(10)
    assert host.reports == [("failed", "the engine needs a token of at least 32 characters")]

    # Code that tries to end the process (SystemExit) must not get out of run().
    from zhu_engine import __main__ as entry

    def ends_itself(*args, **kwargs):
        raise SystemExit(3)

    monkeypatch.setattr(embedded, "serve", ends_itself)
    reports: list[tuple[str, str]] = []
    embedded.run(TOKEN, str(tmp_path), lambda kind, text: reports.append((kind, text)))
    assert reports == [("failed", "the engine ended itself (exit code 3)")]

    def breaks(*args, **kwargs):
        raise RuntimeError("the audio device vanished")

    monkeypatch.setattr(embedded, "serve", breaks)
    reports.clear()
    embedded.run(TOKEN, str(tmp_path), lambda kind, text: reports.append((kind, text)))
    assert reports == [("failed", "RuntimeError: the audio device vanished")]
    assert not embedded.running() and entry.serve is not breaks


def test_the_native_callback_form(tmp_path, no_real_keys):
    """The shell passes its callback as the address of a C function."""
    import ctypes

    seen: list[tuple[bytes, bytes]] = []
    callback = ctypes.CFUNCTYPE(None, ctypes.c_char_p, ctypes.c_char_p)(lambda kind, text: seen.append((kind, text)))
    address = ctypes.cast(callback, ctypes.c_void_p).value
    embedded.run("short", str(tmp_path), address)
    assert seen == [(b"failed", b"the engine needs a token of at least 32 characters")]
    time.sleep(0)  # keep `callback` alive until here
