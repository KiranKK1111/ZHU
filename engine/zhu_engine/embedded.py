"""Running the engine inside the desktop app's own process.

The desktop shell (apps/desktop/src-tauri/src/embedded.rs) loads a Python runtime into
``zhu.exe`` and calls ``run`` on a thread of its own. The app and the engine still talk over the
local connection (127.0.0.1, token), so nothing else in the app depends on where the engine runs.

Rules that follow from living in somebody else's process:

  * ``run`` never raises, and never lets ``SystemExit`` out. To the host, an escaped
    ``SystemExit`` means "end the process", which would close the whole application.
  * Everything is reported through one callback (``report(kind, text)``): ``ready`` with the
    port, then either ``stopped`` (an orderly end) or ``failed`` with the reason.
  * ``request_stop`` asks the running engine to stop, from any thread. A request that arrives
    while the engine is still starting is kept and carried out as soon as the server exists.
  * One run at a time. A run closes what it opened (``serve`` sees to that), so the engine can
    be started again in the same process.

What this cannot do: survive a crash inside a native library (speech recognition, graphics):
that ends the process it happens in. See engine.rs for what the shell does about it.
"""

from __future__ import annotations

import ctypes
import gc
import logging
import os
import threading
import traceback
from typing import Callable, Optional

from .__main__ import EngineStartError, serve

Report = Callable[[str, str], None]

_lock = threading.Lock()
_active = False  # a run is in progress, from its start to its end
_stop: Optional[Callable[[], None]] = None  # the running server's stop, once the server exists
_stop_wanted = False  # a stop was asked for before the server existed


def running() -> bool:
    with _lock:
        return _active


def request_stop() -> bool:
    """Ask the running engine to stop. True when there is a run to ask."""
    global _stop_wanted
    with _lock:
        if not _active:
            return False
        stop = _stop
        if stop is None:
            _stop_wanted = True
            return True
    stop()
    return True


def _hold(stop: Optional[Callable[[], None]]) -> None:
    """Called by ``serve`` with the server's stop once it exists, and with None when it is gone."""
    global _stop
    with _lock:
        _stop = stop
        now = stop is not None and _stop_wanted
    if now:
        stop()


def _native_report(address: int) -> Report:
    """The shell's callback, given as the address of a C function ``void(const char*, const char*)``."""
    function = ctypes.CFUNCTYPE(None, ctypes.c_char_p, ctypes.c_char_p)(address)

    def report(kind: str, text: str) -> None:
        function(kind.encode("utf-8"), text.encode("utf-8", "replace"))

    return report


def run(token: str, data_dir: Optional[str] = None, report: Report | int | None = None, log_level: Optional[str] = None) -> None:
    """Run the engine until ``request_stop``. Blocks. See the rules at the top of this file."""
    global _active, _stop, _stop_wanted
    if isinstance(report, int):
        report = _native_report(report) if report else None
    tell: Report = report or (lambda kind, text: None)
    with _lock:
        if _active:
            tell("failed", "the engine is already running")
            return
        _active, _stop, _stop_wanted = True, None, False
    try:
        serve(token, port=0, data_dir=data_dir, log_level=log_level or os.environ.get("ZHU_LOG_LEVEL", "INFO"),
              on_ready=lambda port: tell("ready", str(port)), on_server=_hold)
        tell("stopped", "")
    except EngineStartError as exc:
        tell("failed", str(exc))
    except SystemExit as exc:
        tell("failed", f"the engine ended itself (exit code {exc.code})")
    except BaseException as exc:  # noqa: BLE001 - nothing may escape into the host
        try:
            logging.getLogger("zhu").error("the engine stopped with an error:\n%s", traceback.format_exc())
        except Exception:  # noqa: BLE001
            pass
        tell("failed", f"{type(exc).__name__}: {exc}"[:500])
    finally:
        with _lock:
            _active, _stop, _stop_wanted = False, None, False
        # What the run held (speech model, graphics memory) goes now, not at some later collection.
        gc.collect()
