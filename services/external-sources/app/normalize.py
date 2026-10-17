"""采集侧标准化：把爬虫原始记录变成契约要求的 `normalized` 结构。

实测踩到的坑（见工作包记录第 3 节）：
  - **数量字段是中文串**：`'3.9万'` / `'2万'` / `'569'` / `''`，必须归一化成整数
  - **`image_list` / `tag_list` / `video_url` 是逗号分隔的字符串**，不是数组
  - **`desc` 里混着话题标记**：`#旅游攻略[话题]#`，要还原成 `#旅游攻略`
  - **`time` 是毫秒时间戳**
  - **`nickname` 已被平台脱敏**（`'暴***版'`），只能靠 `creator_hash` 关联创作者
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

PLATFORM = "xiaohongshu"
RECORD_PREFIX = "xhs_"

# 中文数量单位
COUNT_UNITS = (("亿", 100_000_000), ("万", 10_000))

# 小红书的话题标记：#旅游攻略[话题]#
TOPIC_MARKER = re.compile(r"#([^#\[\]]+)\[话题\]#")


def parse_count(value: Any) -> int | None:
    """`'3.9万'` -> 39000；`'569'` -> 569；空值或非数量 -> None。"""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    factor = 1
    for suffix, multiplier in COUNT_UNITS:
        if text.endswith(suffix):
            factor = multiplier
            text = text[: -len(suffix)]
            break
    try:
        return int(round(float(text) * factor))
    except ValueError:
        return None


def clean_text(value: Any) -> str:
    """把话题标记还原成普通话题；顺手压掉多余空白。"""
    if not value:
        return ""
    text = TOPIC_MARKER.sub(r"#\1", str(value))
    return re.sub(r"\s+", " ", text).strip()


def split_list(value: Any) -> list[str]:
    """逗号分隔字符串 -> 去空去重的列表。"""
    if not value:
        return []
    parts = [item.strip() for item in str(value).split(",")]
    seen: list[str] = []
    for item in parts:
        if item and item not in seen:
            seen.append(item)
    return seen


def ms_to_iso(value: Any) -> str | None:
    """毫秒时间戳 -> ISO 字符串（带时区）。"""
    try:
        milliseconds = int(value)
    except (TypeError, ValueError):
        return None
    if milliseconds <= 0:
        return None
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat()


def merge_ocr_lines(rows: list[dict[str, Any]]) -> str:
    """把一张张图的 OCR 结果按顺序拼成整篇文本。"""
    chunks: list[str] = []
    for row in rows:
        lines = [line for line in (row.get("text") or []) if line]
        if lines:
            chunks.append("\n".join(lines))
    return "\n".join(chunks)


def build_record(
    raw: dict[str, Any],
    media: list[dict[str, Any]],
    ocr: list[dict[str, Any]],
    collected_at: str,
    crawler: str = "MediaCrawler",
) -> dict[str, Any]:
    """组装一条契约形状的采集成果。"""
    note_id = str(raw.get("note_id") or "").strip()
    images = split_list(raw.get("image_list"))
    desc = clean_text(raw.get("desc"))
    ocr_text = merge_ocr_lines(ocr)

    return {
        "record_id": RECORD_PREFIX + note_id,
        "raw": raw,
        "normalized": {
            "platform": PLATFORM,
            "note_id": note_id,
            "note_type": clean_text(raw.get("type")) or None,
            "title": clean_text(raw.get("title")) or None,
            "text": desc or None,
            "tags": split_list(raw.get("tag_list")),
            "counts": {
                "liked": parse_count(raw.get("liked_count")),
                "collected": parse_count(raw.get("collected_count")),
                "commented": parse_count(raw.get("comment_count")),
                "shared": parse_count(raw.get("share_count")),
            },
            "published_at": ms_to_iso(raw.get("time")),
            "published_at_local_ms": raw.get("time"),
            "author": {
                "hash": clean_text(raw.get("creator_hash")) or None,
                "nickname": clean_text(raw.get("nickname")) or None,
                "nickname_masked": True,
            },
            "image_urls": images,
            "video_urls": split_list(raw.get("video_url")),
            # 文字来源清楚标注：正文来自 desc，图片里的文字来自 OCR
            "text_sources": ["desc"] + (["ocr"] if ocr_text else []),
            "ocr_text": ocr_text or None,
            "ocr_chars": len(ocr_text),
        },
        "media": media,
        "ocr": ocr,
        "source": {
            "type": PLATFORM,
            "keyword": clean_text(raw.get("source_keyword")) or None,
            "url": clean_text(raw.get("note_url")) or None,
            "xsec_token": clean_text(raw.get("xsec_token")) or None,
            "crawler": crawler,
            "collected_at": collected_at,
        },
    }
