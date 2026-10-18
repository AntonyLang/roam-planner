# Roam Planner

把旅行想法聊成可以看、可以改、可以采用的行程。

Roam Planner 是一套可自行部署的旅行规划助手：通过多轮对话确认偏好与限制，把地点、时间、交通和费用放到同一张行程地图上。

![行程地图与多轮规划助手](docs/media/planner-desktop.jpg)

图中为演示行程；未订的交通与住宿保留待确认状态。

- **边聊边确认**：先说目的地和想法，再补日期、同行者、预算、步行能力与偏好；支持规划中补充要求。
- **路线有依据**：地图点直接标注行程序号，高德道路轨迹沿路显示；内含铁路 MCP 查询服务，铁路与航段各用不同示意线，明确区分班次核实情况。
- **先看方案，再采用**：草稿可定位和编辑；采用后继续修改会关联现有日程，保留已有预算与住宿。
- **会话可继续**：刷新页面、关闭浏览器后可回到原旅程；停止规划后可继续对话。
- **在页面完成配置**：首次进入自动引导，支持模型与地图 Key、连接检查和小红书扫码登录；之后可从首页进入服务配置。
- **旅行资料集中管理**：日程、地点、住宿、费用、清单与文件沿用 TREK 的旅行管理能力。

![道路与航段采用不同路线样式](docs/media/route-styles.jpg)

## 快速开始

需要 Git、Docker 和 Docker Compose。使用 Docker Hub 预构建镜像，无需在电脑安装 Node.js、Python 或浏览器依赖。

```sh
git clone https://github.com/AntonyLang/roam-planner.git
cd roam-planner
docker compose pull
docker compose up -d --wait --no-build
```

打开 [http://localhost:3000](http://localhost:3000)，跟随首次引导配置服务，也可点“稍后配置，先使用”管理旅程和查看地图。启用规划助手时填写模型 Key、地址与模型名称并检查连接；地图与小红书也可稍后配置。新建旅行后，在行程页右侧与规划助手交流。当前部署采用本地单用户模式，默认端口仅绑定本机。

镜像：[网页与旅程](https://hub.docker.com/r/antonyaty/roam-planner) · [规划 Agent](https://hub.docker.com/r/antonyaty/roam-planner-agent) · [外部来源](https://hub.docker.com/r/antonyaty/roam-planner-sources)。源码构建、端口与环境变量配置见[部署文档](docs/deployment.md)。

小红书是默认关闭的可选来源，不配置也能使用规划助手；平台可能限制部分容器网络，具体见[配置说明](docs/configuration.md#小红书)。

![首次服务引导，可稍后配置](docs/media/service-setup.png)

可以先试一句：**“想带爸妈去苏州玩两天，轻松一点，你先帮我看看。”** 后续再回答助手对日期、预算和步行能力的询问。

## 文档

[配置模型与高德](docs/configuration.md) · [部署、数据与更新](docs/deployment.md) · [规划与地图使用](docs/usage.md) · [架构与服务职责](docs/architecture.md) · [常见问题](docs/troubleshooting.md)

## 来源与许可证

本项目由 AntonyLang 基于 [TREK 4.3.3](https://github.com/liketrek/TREK/tree/1c05ee4b3ac9523c41ccdd3baad989ba48a7409a) 演进，使用独立的 Roam 名称和标识，沿用 [AGPL-3.0](LICENSE)。源码归属及第三方数据说明见 [NOTICE.md](NOTICE.md)；上游标识政策见 [TRADEMARKS.md](TRADEMARKS.md)。Agent 运行时采用 [Pi Durable](https://github.com/earendil-works/pi)。
