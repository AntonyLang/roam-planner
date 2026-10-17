"""Read-only MCP surface for an optional published, immutable travel-guide library."""
import os
from pathlib import Path

import httpx
from pydantic import BaseModel, ConfigDict, Field

from .archive import Archive
from .library_qdrant import CANONICAL_VECTOR_SIZE
from .library_runtime import LibraryRuntime

service_root = Path(__file__).resolve().parents[2]
knowledge_root = Path(os.getenv('KNOWLEDGE_ARCHIVE_ROOT') or service_root / 'data/knowledge')
release_path = os.getenv('KNOWLEDGE_LIBRARY_RELEASE') or None
embedding_base_url = os.getenv('EMBEDDING_BASE_URL', '').rstrip('/')
embedding_api_key = os.getenv('EMBEDDING_API_KEY', '')
qdrant_url = os.getenv('QDRANT_URL', 'http://127.0.0.1:6333')
provider_timeout_seconds = float(os.getenv('PROVIDER_TIMEOUT_SECONDS', '90'))

archive = Archive(knowledge_root)
library_runtime: LibraryRuntime | None = None


async def _library_query_embedding(text: str, model: str, dimensions: int = CANONICAL_VECTOR_SIZE):
    if not embedding_api_key:
        raise ValueError('EMBEDDING_API_KEY is required for dense guide search')
    payload = {'model': model, 'input': [text], 'dimensions': dimensions}
    async with httpx.AsyncClient(timeout=provider_timeout_seconds) as client:
        response = await client.post(
            f'{embedding_base_url}/embeddings',
            json=payload,
            headers={'Authorization': f'Bearer {embedding_api_key}'},
        )
        response.raise_for_status()
    result = response.json()
    rows = result.get('data', [])
    if len(rows) != 1 or rows[0].get('index') != 0:
        raise ValueError('Invalid embedding response count/index')
    vector = rows[0].get('embedding')
    if not isinstance(vector, list) or len(vector) != dimensions:
        raise ValueError('Invalid embedding vector dimensions')
    returned = result.get('model')
    if returned and returned != model:
        raise ValueError('Embedding provider returned a different model')
    return vector

if release_path:
    library_runtime = LibraryRuntime(
        release_path, knowledge_root, _library_query_embedding, qdrant_url,
    )
    if library_runtime.release.get('publication') != 'published':
        raise ValueError('Only a published immutable guide library can be served')
    if library_runtime.mode != 'lexical' and embedding_base_url != library_runtime.embedding_base_url:
        raise ValueError('EMBEDDING_BASE_URL differs from the immutable library embedding endpoint')
    archive = library_runtime.archive


def guides_enabled() -> bool:
    return library_runtime is not None and os.getenv('SOURCES_GUIDES_ENABLED', 'false').lower() == 'true'


class Search(BaseModel):
    model_config = ConfigDict(extra='forbid')
    query: str = Field(min_length=1)
    limit: int = Field(default=5, ge=1, le=10)
    destination: str | None = Field(default=None, description='按文章标题子串过滤，不自动跨语言扩展；与 document_ids 取交集。')
    document_ids: list[str] | None = Field(default=None, description='限定文章：可直接使用搜索返回的版本化 guide:// URI，或来源 URL（无 URL 时为标题）；空列表不检索任何文章。')


class Read(BaseModel):
    model_config = ConfigDict(extra='forbid')
    uri: str
    section_path: list[str] | None = None
    start: int | None = Field(default=None, ge=0)
    length: int | None = Field(default=6000, ge=1,
                               description='默认最多6000个Unicode码点，按next_start续读；显式null可读完整所选范围。')


KNOWLEDGE_TOOLS = {
    'search_guides': ('检索已存档的静态旅游攻略，适合发现候选、比较体验和理解区域与历史经验。返回命中原文及每块的版本化文章 URI、完整章节路径、文章内零起点 Unicode 码点范围（左闭右开）、章节覆盖比例。覆盖比例不是相关性或事实置信度；引用应指向实际支持结论的原文范围。需要更多依据时用 read_guide 或 resources/read 续读。未展开模板的参数可能缺少单位和字段关系，不能从裸数值推断含义。存档不能证明当前票价、余票、开放、天气、海况或预订库存，影响安排的时效事实须通过对应实时工具或官方公告核实。', Search),
    'read_guide': ('按版本化攻略 URI 读取原文。section_path 可选，用完整章节路径定位；如需目录和各节范围，可通过 resources/read 读取文章 URI 后附 /toc 的资源。start 可选，为文章内零起点 Unicode 字符位置（左闭右开），省略时从文章或选定章节开始；length 可选，默认最多6000个码点。返回实际范围及 next_start，可据此续读；完整文章也可通过 resources/read 获取。', Read),
}


async def call_tool(name: str, arguments: dict):
    if name not in KNOWLEDGE_TOOLS:
        raise ValueError('Unknown guide tool')
    model = KNOWLEDGE_TOOLS[name][1].model_validate(arguments)
    if name == 'search_guides':
        if library_runtime is None:
            raise ValueError('Published guide library is not configured')
        return await library_runtime.search(**model.model_dump())
    return archive.read(**model.model_dump())
