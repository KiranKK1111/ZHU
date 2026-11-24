"""Application directories. No hard-coded file-system paths: everything derives
from %LOCALAPPDATA% (or ZHU_DATA_DIR, used for tests and portable installs).

The data root is %LOCALAPPDATA%\\app.zhu.desktop\\data: the Tauri app-data folder for the
bundle identifier. It must NOT be %LOCALAPPDATA%\\ZHU, because that is where the per-user
installer puts the program files (verified with a real install)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AppPaths:
    root: Path

    @property
    def database(self) -> Path:
        return self.root / "zhu.db"

    @property
    def screenshots(self) -> Path:
        return self.root / "screenshots"

    @property
    def thumbnails(self) -> Path:
        return self.root / "screenshots" / "thumbnails"

    @property
    def frozen(self) -> Path:
        return self.root / "cache" / "frozen"

    @property
    def resume(self) -> Path:
        """The resume file as it was uploaded, so it can be shown again (profile.py)."""
        return self.root / "resume"

    @property
    def models(self) -> Path:
        return self.root / "models"

    @property
    def logs(self) -> Path:
        return self.root / "logs"

    @property
    def vocabulary(self) -> Path:
        return self.root / "vocabulary.json"

    @property
    def settings(self) -> Path:
        return self.root / "settings.json"

    def ensure(self) -> "AppPaths":
        for p in (self.root, self.screenshots, self.thumbnails, self.frozen, self.models, self.logs):
            p.mkdir(parents=True, exist_ok=True)
        return self


def default_paths() -> AppPaths:
    override = os.environ.get("ZHU_DATA_DIR")
    if override:
        return AppPaths(Path(override))
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return AppPaths(Path(base) / APP_IDENTIFIER / "data")


APP_IDENTIFIER = "app.zhu.desktop"  # must match "identifier" in apps/desktop/src-tauri/tauri.conf.json
