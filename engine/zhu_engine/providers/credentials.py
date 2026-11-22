"""API keys in Windows Credential Manager (via keyring's WinVaultKeyring backend).

Keys are never written to SQLite, settings files, or logs, and they are never
returned to the front end. The UI only learns whether a key is configured.
"""

from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger(__name__)
SERVICE = "ZHU"


def _keyring():
    import keyring

    return keyring


def set_api_key(provider_id: str, key: str) -> None:
    _keyring().set_password(SERVICE, f"provider:{provider_id}", key.strip())


def get_api_key(provider_id: str) -> Optional[str]:
    try:
        return _keyring().get_password(SERVICE, f"provider:{provider_id}")
    except Exception as exc:
        log.warning("credential store unavailable: %s", exc)
        return None


def delete_api_key(provider_id: str) -> None:
    try:
        _keyring().delete_password(SERVICE, f"provider:{provider_id}")
    except Exception:
        pass  # PasswordDeleteError when absent: nothing to delete


def has_api_key(provider_id: str) -> bool:
    return bool(get_api_key(provider_id))


def mask(key: Optional[str]) -> Optional[str]:
    if not key:
        return None
    return f"…{key[-4:]}" if len(key) > 8 else "set"
