"""Encrypted, Sources-owned persistence for the browser-verified XHS session."""
from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

from Crypto.Cipher import AES


MAGIC = b'ROAM-XHS-1\0'


def session_file() -> Path:
    return Path(os.getenv('XHS_SESSION_FILE', '/data/xhs/session.enc'))


def session_root() -> Path:
    return session_file().parent


def _write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(data)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def _key() -> bytes:
    path = session_root() / 'session.key'
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        key = path.read_bytes()
    else:
        key = secrets.token_bytes(32)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(key)
        os.chmod(path, 0o600)
    if len(key) != 32:
        raise ValueError('XHS session encryption key is invalid')
    return key


def save_session(cookie: str, user_agent: str) -> None:
    root = session_root()
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    key = _key()
    nonce = secrets.token_bytes(12)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    payload = json.dumps({'cookie': cookie, 'user_agent': user_agent}, ensure_ascii=False).encode('utf-8')
    ciphertext, tag = cipher.encrypt_and_digest(payload)
    _write_private(session_file(), MAGIC + nonce + tag + ciphertext)
    profile_id = secrets.token_hex(16)
    profile = json.dumps({'directory': 'xhs_' + profile_id, 'user_agent': user_agent}, ensure_ascii=False)
    _write_private(root / 'active-profile.json', profile.encode('utf-8'))


def load_session() -> dict | None:
    path = session_file()
    if not path.is_file():
        return None
    stored = path.read_bytes()
    if not stored.startswith(MAGIC):
        raise ValueError('XHS session is not encrypted')
    nonce_start = len(MAGIC)
    nonce, tag, ciphertext = stored[nonce_start:nonce_start + 12], stored[nonce_start + 12:nonce_start + 28], stored[nonce_start + 28:]
    cipher = AES.new(_key(), AES.MODE_GCM, nonce=nonce)
    payload = cipher.decrypt_and_verify(ciphertext, tag)
    return json.loads(payload)


def has_session() -> bool:
    return session_file().is_file()


def delete_session() -> None:
    root = session_root()
    for path in (session_file(), root / 'session.key', root / 'active-profile.json'):
        path.unlink(missing_ok=True)

