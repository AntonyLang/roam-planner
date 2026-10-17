"""采集侧持久化（SQLite）。

按工作包约定，**采集侧的落库由本模块负责**。仓库 `.gitignore` 已经预留
`data/crawled/`（还有 `data/raw/`、`data/cache/`、`data/ocr-output/`），
这里就把库放在 `data/crawled/` 下。

特性：
  - 重复采集按 `record_id` **去重**（upsert）
  - 落库内容**重启后可读**
  - 用 SQLite 单文件，零额外依赖；查询列单独抽出来做索引，完整成果存 JSON

路径可用 `SOURCES_STORE_PATH` 覆盖（Docker 里需要挂卷并设置该变量）。
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

_PARENTS = Path(__file__).resolve().parents
# 源码检出时写到仓库 data/；镜像只复制 app/，从 /app 运行。
REPO_ROOT = _PARENTS[3] if len(_PARENTS) > 3 else Path.cwd()
STORED_COLUMNS = ("record_id", "note_id", "keyword", "published_at", "collected_at", "title")

_lock = threading.Lock()
_schema_ready = False


def store_path() -> Path:
    configured = os.getenv("SOURCES_STORE_PATH")
    return Path(configured) if configured else REPO_ROOT / "data" / "crawled" / "sources.sqlite"


def _connect() -> sqlite3.Connection:
    global _schema_ready
    path = store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    if not _schema_ready:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS records (
                record_id    TEXT PRIMARY KEY,
                note_id      TEXT,
                keyword      TEXT,
                published_at TEXT,
                collected_at TEXT,
                title        TEXT,
                payload      TEXT NOT NULL
            )
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_records_keyword ON records(keyword)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_records_published ON records(published_at)")
        # 轻量迁移：老库补 keywords 列（一个笔记可能被多个关键词命中）
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(records)")}
        if "keywords" not in columns:
            connection.execute("ALTER TABLE records ADD COLUMN keywords TEXT")
        connection.commit()
        _schema_ready = True
    return connection


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    """提交或回滚事务，并真正关闭连接。"""
    connection = _connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def upsert(records: list[dict[str, Any]]) -> dict[str, int]:
    """按 record_id 去重写入；返回新增/更新条数。"""
    inserted = updated = 0
    with _lock, _connection() as connection:
        for record in records:
            record_id = record.get("record_id")
            if not record_id:
                continue
            previous = connection.execute(
                "SELECT payload FROM records WHERE record_id = ?", (record_id,)
            ).fetchone()
            normalized = record.get("normalized") or {}
            source = dict(record.get("source") or {})
            if previous:
                old_source = (json.loads(previous["payload"]).get("source") or {})
                source["keywords"] = list(dict.fromkeys(
                    [*(old_source.get("keywords") or []), *(source.get("keywords") or [])]
                ))
                source["keyword"] = next(iter(source["keywords"]), None)
                record = {**record, "source": source}
            connection.execute(
                """
                INSERT INTO records (record_id, note_id, keyword, keywords, published_at, collected_at, title, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(record_id) DO UPDATE SET
                    note_id=excluded.note_id, keyword=excluded.keyword, keywords=excluded.keywords,
                    published_at=excluded.published_at, collected_at=excluded.collected_at,
                    title=excluded.title, payload=excluded.payload
                """,
                (
                    record_id,
                    normalized.get("note_id"),
                    source.get("keyword"),
                    json.dumps(source.get("keywords") or [], ensure_ascii=False),
                    normalized.get("published_at"),
                    source.get("collected_at"),
                    normalized.get("title"),
                    json.dumps(record, ensure_ascii=False),
                ),
            )
            if previous:
                updated += 1
            else:
                inserted += 1
    return {"inserted": inserted, "updated": updated}


def _summarize(row: sqlite3.Row) -> dict[str, Any]:
    payload = json.loads(row["payload"])
    normalized = payload.get("normalized") or {}
    return {
        "record_id": row["record_id"],
        "normalized": {
            "platform": normalized.get("platform"),
            "note_id": normalized.get("note_id"),
            "title": normalized.get("title"),
            "tags": normalized.get("tags"),
            "counts": normalized.get("counts"),
            "published_at": normalized.get("published_at"),
            "ocr_chars": normalized.get("ocr_chars"),
        },
        "source": payload.get("source"),
        "media_count": len(payload.get("media") or []),
        "ocr_images": len(payload.get("ocr") or []),
    }


def _keyword_pattern(keyword: str) -> str:
    """按「命中的任一关键词」过滤：keywords 列存的是 JSON 数组文本。

    注意不能只看 keyword 列 —— 一篇笔记可能被多个关键词同时命中，
    只存第一个会让另一个关键词查不到它（实测 40 行 -> 33 篇）。
    """
    safe = keyword.replace("%", "").replace("_", "").replace('"', "")
    return '%"' + safe + '"%'



def list_records(keyword: str | None = None, limit: int = 20, offset: int = 0,
                 brief: bool = False) -> list[dict[str, Any]]:
    with _connection() as connection:
        if keyword:
            rows = connection.execute(
                "SELECT * FROM records WHERE keywords LIKE ? "
                "ORDER BY published_at DESC, record_id DESC LIMIT ? OFFSET ?",
                (_keyword_pattern(keyword), limit, offset),
            ).fetchall()
        else:
            rows = connection.execute(
                "SELECT * FROM records ORDER BY published_at DESC, record_id DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
    if brief:
        return [_summarize(row) for row in rows]
    return [json.loads(row["payload"]) for row in rows]


def get_record(record_id: str) -> dict[str, Any] | None:
    with _connection() as connection:
        row = connection.execute("SELECT payload FROM records WHERE record_id = ?", (record_id,)).fetchone()
    return json.loads(row["payload"]) if row else None


def count(keyword: str | None = None) -> int:
    with _connection() as connection:
        if keyword:
            row = connection.execute(
                "SELECT COUNT(*) AS n FROM records WHERE keywords LIKE ?", (_keyword_pattern(keyword),)
            ).fetchone()
        else:
            row = connection.execute("SELECT COUNT(*) AS n FROM records").fetchone()
    return int(row["n"])


def keywords() -> list[dict[str, Any]]:
    """展开 keywords 列统计：一篇笔记可能同时计入多个关键词。"""
    tally: dict[str, int] = {}
    with _connection() as connection:
        rows = connection.execute("SELECT keywords FROM records").fetchall()
    for row in rows:
        try:
            values = json.loads(row["keywords"] or "[]")
        except ValueError:
            values = []
        for value in values:
            tally[str(value)] = tally.get(str(value), 0) + 1
    return [
        {"keyword": key, "count": value}
        for key, value in sorted(tally.items(), key=lambda item: -item[1])
    ]


def stats() -> dict[str, Any]:
    path = store_path()
    with _connection() as connection:
        ocr_row = connection.execute(
            "SELECT COUNT(*) AS n FROM records WHERE payload LIKE '%\"ocr_text\": \"%'"
        ).fetchone()
    return {
        "path": str(path),
        "exists": path.exists(),
        "records": count(),
        "with_ocr_text": int(ocr_row["n"]),
        "keywords": keywords(),
    }
