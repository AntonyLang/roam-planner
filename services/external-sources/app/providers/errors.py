"""来源适配层共用的错误类型。

调用失败必须与「成功但无结果」严格区分：
  - 无结果 → 返回空 result + missing 说明，HTTP 200，error 为 null
  - 失败   → 抛 UpstreamError，由 main.py 转成外层 error 与 5xx
"""
from __future__ import annotations


class UpstreamError(Exception):
    """来源调用失败。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message
