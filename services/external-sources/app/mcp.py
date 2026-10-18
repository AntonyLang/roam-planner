"""Stateless Streamable HTTP MCP endpoint; the provider service owns its contracts."""
import asyncio
import json
import logging
from contextlib import nullcontext
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from .mcp_contracts import SOURCE_SCHEMAS, SOURCE_MODELS, model_projection
from .providers import amap, open_meteo, railway, routing, xhs, web_search, web_fetch, venues
from .providers.errors import UpstreamError
from .runtime_config import get_effective_config, use_config
from .knowledge.mcp_runtime import KNOWLEDGE_TOOLS, archive, call_tool as knowledge_call_tool, guides_enabled

router = APIRouter()
META = 'io.liketrek.agent'
DISCONNECT_CANCELLABLE_CAPABILITIES = frozenset({'venues', 'places', 'routes', 'weather', 'transport', 'web', 'web_fetch'})
logger = logging.getLogger(__name__)


class _ClientDisconnected(Exception):
    pass


async def _wait_for_http_disconnect(receive):
    while True:
        message = await receive()
        if message.get('type') == 'http.disconnect':
            return


async def _call_provider_until_disconnect(request, provider, tool_name):
    provider_task = asyncio.create_task(provider, name=f'mcp-provider:{tool_name}')
    disconnect_task = asyncio.create_task(
        _wait_for_http_disconnect(request.receive), name=f'mcp-disconnect:{tool_name}',
    )
    try:
        done, _ = await asyncio.wait(
            (provider_task, disconnect_task), return_when=asyncio.FIRST_COMPLETED,
        )
        # A completed provider wins a tie, including one that finished as the
        # disconnect notification was being delivered.
        if provider_task in done or provider_task.done():
            return await provider_task

        await disconnect_task
        if provider_task.done():
            return await provider_task

        logger.info('MCP HTTP client disconnected while provider was active (tool=%s)', tool_name)
        cancellation_requested = provider_task.cancel()
        # Await the child so cleanup completes and any provider error that
        # raced with cancellation still reaches the existing JSON-RPC handler.
        try:
            result = await provider_task
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                raise
            raise _ClientDisconnected from None
        if not cancellation_requested:
            return result
        # A provider that suppresses cancellation may finish, but the peer is
        # already gone; do not turn that into a fabricated JSON-RPC success.
        raise _ClientDisconnected
    finally:
        disconnect_task.cancel()
        if not provider_task.done():
            provider_task.cancel()
        await asyncio.gather(provider_task, disconnect_task, return_exceptions=True)


TOOLS = {
    'query_venues': ('venues', '根据城市、区域、地点或类别发现景点、餐馆和住宿候选。返回候选名称、地址、坐标与来源；用于比较位置和接驳，价格、营业及库存按任务需要另查。'),
    'web_fetch': ('web_fetch','用于读取已知公开网页的原始内容，核实搜索摘要背后的完整依据。直接 HTTP 读取，默认提取标题、段落和链接；需要原始 HTML/文本时选 raw。长文携带 content_id 和 next_offset 续读，版本过期从头重读，不把未读取部分当作依据。保留原始链接、获取时间和范围；不执行 JavaScript、不登录，不支持图片和 PDF。'),
    'web_search': ('web', '用于查证公开网页中的旅行事实、官方公告、营业与季节限制、交通政策及站外攻略，补充专门来源未覆盖的信息。查询词须包含目的地与具体问题，可加官方机构名或 site:域名，优先原始官方来源。默认按配置选择一个已启用来源，仅服务失败时有限切换，成功但无结果不会换源；也可指定 provider。返回标题、链接、发布时间与搜索摘要，需要完整依据用 web_fetch 读取原文。摘要不是实时库存或预订保证；不要把作者经验或过期信息当作当前事实。小红书体验发现用 search_xhs，地点坐标与路线仍用专门工具。'),
    'query_places': ('places', '用于在指定城市按具体名称定位或消除地点歧义，回答“这个名字对应哪里”，例如“青岛站”“栈桥”或某家酒店的完整分店名。返回名称匹配项的地址、城市、区县及坐标；多个匹配项是名称歧义候选，不是按附近类别推荐的场所。车站须查完整名称，城市名不能代表所有车站。尚未选定场所、要发现某一区域的景点或附近餐饮住宿时用query_venues；其候选已有足够清楚的名称、地址、坐标时直接使用，不必重复查本工具。当前来源为高德，面向其覆盖地区；不能将境外无结果解释成地点不存在。返回坐标为GCJ02，保留坐标系，不直接混用WGS84。地点存在不证明当日开放、价格或库存，体验与季节条件需另查；查询不会修改旅程。'),
    'query_routes': ('routes', '用于比较市内接驳便利性和验证相邻地点的实际转场。按SOURCES_ROUTES_PROVIDER配置使用高德（步行、公交、驾车）或Geoapify（步行、驾车路网估时，不含实时拥堵、排队和等候，不提供公交班次）。铁路规划中用它比较酒店→候选出发站、候选到达站→目的地的接驳时间与步行负担；站间列车时刻用 query_transport，不能拿公路路线代替铁路。只把实际选用方向和方式的路线加入草稿，比较路线留作依据。坐标须注明坐标系，完整几何供地图展示；来源和估时依据随结果返回。'),
    'query_weather': ('weather', '用于决定户外活动时段、避晒避雨及备用安排，查询目的地相关日期的天气，并把结果用于修改日程。气温不能证明海水温度、浴场开放或救生服务；重要体验的季节限制需另外查证。须注明坐标系；预报最多未来16天，历史均值不是预报。'),
    'query_transport': ('transport', '用于确定跨城铁路方案：真实车站、车次、出发到达时刻和可用票价。先按住宿与目的地位置筛选车站，再查有竞争力的站对；不要默认城市主站最方便。用departure_after/before、arrival_after/before筛选当地时刻，站对与窗口筛选后再按limit截取；默认10班并不代表全天仅有10班，不要反复用相同参数期待出现晚班。到达时刻不表示到达日期，跨夜需结合运行时长。与两端市内接驳、候车缓冲一起比较门到门耗时和步行负担，选定后在草稿分别保留出发站和到达站，并关联该车次来源。不能用驾车或普通公交替代铁路依据。本工具不查航班；无结果和服务故障分别处理。'),
    'search_xhs': ('xhs', '用于旅行经验发现和候选比较：围绕目的地、同行者偏好及关键限制搜索攻略，例如季节游泳条件、轻松路线、避晒休息、住宿区域和餐饮避坑。缺少相关经验依据时先发现候选，再核实具体地点；不要仅凭熟悉景点直接排程。限定目的地和具体问题，默认3条帖子卡片；卡片不含正文，用 read_xhs_note 读最相关1–3篇再采用经验。来源为小红书站内搜索；本来源默认关闭、可选；未启用、未登录或平台受限时，用其他可用来源继续规划，不要求用户先配置。仅用户明确要求小红书内容时提示启用或登录，禁止循环重试。'),
    'read_xhs_note': ('xhs_note', '用于核实搜索卡片背后的完整攻略，提取能改变候选选择和安排的具体体验、限制及理由，保留来源并落实到地点说明或行程。按搜索返回的note_id读取正文；标题不能当作完整证据。作者经验不能代替当前价格、营业、海况或班次核实，注意发布时间与季节；图片未OCR时内容未知。')
}


@router.post('/mcp')
async def mcp(request: Request):
    try: body = await request.json()
    except ValueError: return JSONResponse({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Invalid JSON'}}, status_code=400)
    if not isinstance(body, dict) or body.get('jsonrpc') != '2.0':
        return JSONResponse({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid request'}}, status_code=400)
    ident, method = body.get('id'), body.get('method')
    if ident is None: return Response(status_code=202)
    def reply(result): return JSONResponse({'jsonrpc': '2.0', 'id': ident, 'result': result})
    if method == 'initialize':
        offered = body.get('params', {}).get('protocolVersion')
        protocol = offered if offered in ('2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25') else '2025-11-25'
        capabilities={'tools': {'listChanged': False}}
        if guides_enabled():capabilities['resources']={'listChanged':False}
        return reply({'protocolVersion': protocol, 'capabilities': capabilities,
                      'serverInfo': {'name': 'travel-external-sources', 'version': '1.0.0'}})
    if method == 'ping': return reply({})
    if method == 'tools/list':
        # Keep the catalog stable across live configuration changes. Provider
        # calls enforce enabled/login state, so enabling XHS needs no reconnect.
        return reply({'tools': [{'name': name, 'description': description, 'inputSchema': SOURCE_SCHEMAS[capability],
                                'annotations': {'readOnlyHint': True, 'openWorldHint': True}}
                               for name, (capability, description) in sorted(TOOLS.items())
                              ] +
                              [{'name': name, 'description': description, 'inputSchema': model.model_json_schema(),
                                'annotations': {'readOnlyHint': True, 'openWorldHint': False}}
                               for name, (description, model) in KNOWLEDGE_TOOLS.items() if guides_enabled()]})
    if method in ('resources/list','resources/read') and not guides_enabled():
        return JSONResponse({'jsonrpc':'2.0','id':ident,'error':{'code':-32601,'message':'攻略资源读取已停用'}})
    if method == 'resources/list':
        return reply(archive.list_resources(body.get('params', {}).get('cursor')))
    if method == 'resources/read':
        try:
            return reply(archive.read_resource(body['params']['uri']))
        except ValueError as exc:
            return JSONResponse({'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32002, 'message': str(exc)}})
    if method != 'tools/call':
        return JSONResponse({'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32601, 'message': 'Method not found'}})
    params = body.get('params') or {}
    name, arguments = params.get('name'), params.get('arguments', {})
    try:
        if name in KNOWLEDGE_TOOLS and guides_enabled():
            value = await knowledge_call_tool(name, arguments)
            return reply({'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}], 'structuredContent': value})
        if name not in TOOLS: raise ValueError('Unknown tool')
        capability = TOOLS[name][0]
        # The HTTP service already validates all provider inputs; these schemas
        # also reject unknown fields before dispatch, without a new dependency.
        validated = SOURCE_MODELS[capability].model_validate(arguments)
        functions = {'places': amap.query_places, 'routes': routing.query_routes, 'weather': open_meteo.query_weather,
                     'transport': railway.query_transport, 'xhs': xhs.query, 'xhs_note': xhs.query, 'web':web_search.query,'web_fetch':web_fetch.query}
        functions['venues'] = venues.query_venues
        query = validated if capability in ('xhs','xhs_note','web','web_fetch','venues') else validated.model_dump(mode='json', exclude_none=True)
        needs_config = capability in ('places', 'routes', 'venues', 'web', 'xhs', 'xhs_note')
        config = await get_effective_config(request.app.state.http) if needs_config else None
        with use_config(config) if config is not None else nullcontext():
            provider = functions[capability](request.app.state.http, query)
            if capability in DISCONNECT_CANCELLABLE_CAPABILITIES:
                original = await _call_provider_until_disconnect(request, provider, name)
            else:
                original = await provider
        projected = model_projection(capability, original)
        return reply({'content': [{'type': 'text', 'text': json.dumps(projected, ensure_ascii=False)}], 'structuredContent': projected,
                      '_meta': {META + '/original': original, META + '/events': [{'kind': 'source_available', 'payload': {'capability': capability, 'data': original}}]}})
    except _ClientDisconnected:
        return Response(status_code=499)
    except (UpstreamError, ValueError) as error:
        details = {'error': {'code': getattr(error, 'code', 'INVALID_ARGUMENTS'), 'message': str(getattr(error, 'message', error))},
                   'needs_user_action': getattr(error, 'code', '') in ('XHS_USER_ACTION_REQUIRED', 'XHS_SESSION_EXPIRED')}
        if getattr(error,'attempts',None):details['attempts']=error.attempts
        return reply({'isError': True, 'content': [{'type': 'text', 'text': json.dumps(details, ensure_ascii=False)}], 'structuredContent': details})
