# 配置

从根目录的 [product.env.example](../product.env.example) 复制出 `.env.product`。所有真实密钥只填写在本地文件中；修改后重新执行 Compose 启动命令。

| 配置 | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 模型服务凭据，启动 Agent 必填 |
| `DEEPSEEK_BASE_URL` | 默认官方 DeepSeek 地址；也可填兼容的 Chat Completions 服务地址 |
| `AGENT_MODEL` | 服务实际支持的模型 ID，默认 `deepseek-flash` |
| `AGENT_THINKING_LEVEL` | 默认 `high`，由所用模型适配器解释 |
| `AMAP_API_KEY` | 高德中国地点、步行、驾车和公共交通查询 |
| `SOURCES_ROUTES_PROVIDER` | `amap` 或 `geoapify`，显式选择路网来源 |
| `GEOAPIFY_API_KEY` | 选择 Geoapify 时填写，支持步行和驾车路网估时 |
| `TREK_PORT` | 本机访问端口，默认 3000 |
| `RAILWAY_MCP_URL` | 可选铁路查询服务的 MCP 地址 |
| `WEB_SEARCH_PROVIDERS` | 默认 `exa`，公开网页检索来源 |
| `EXA_MCP_URL` | Exa MCP 服务地址 |

## 高德 Key

在[高德控制台](https://lbs.amap.com/api/mcp-server/create-project-and-key)创建 **Web 服务** 类型 Key，填写 `AMAP_API_KEY`。当前地图数据由后端 REST 适配器获取，坐标转换后交给页面绘制。

```sh
docker compose --env-file .env.product up -d --wait
```

高德官方 MCP 可提供地点查询和高德端链接；本项目保留 REST 路网适配以取得地图所需完整轨迹。改变 Key 无需修改源码。

## 兼容模型服务

模型连接使用 DeepSeek 的 Chat Completions 适配器。自定义服务须兼容该协议及工具调用；仅修改地址并不意味着支持所有供应商特性。容器访问宿主机服务时，Docker Desktop 可使用 `http://host.docker.internal:端口/v1`，不能用指向容器自身的 `127.0.0.1`。

默认模型名称已按 [DeepSeek 官方文档](https://api-docs.deepseek.com/quick_start/pricing/)核对（2026-10-18）。计费以所用服务为准，本地模型用量报告不等同于供应商账单。

## 可选铁路查询

将 `RAILWAY_MCP_URL` 设为 `http://railway:8000/mcp` 后启用附带服务：

```sh
docker compose --env-file .env.product --profile railway up --build -d --wait
```

铁路查询用于核实车次和时刻；未查询或未匹配的班次仍以未核实示意呈现。当前没有实时航班检索或出票能力。
