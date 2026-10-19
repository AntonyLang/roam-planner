# 部署与维护

## Docker Hub 镜像启动

安装 Docker Engine / Docker Desktop 与 Compose 插件。无需 Git 或完整源码：在一个固定部署目录下载根目录的 [compose.yaml](https://raw.githubusercontent.com/AntonyLang/roam-planner/main/compose.yaml)，下载命令见 [README 的 Docker Hub 入口](../README.md#方式一docker-hub-预构建镜像推荐)。然后在该目录执行：

```sh
docker compose pull
docker compose up -d --wait --no-build
```

打开 `http://localhost:3000`，按首次引导配置服务。默认版本 `0.2.2`，当前发布平台为 Linux amd64。镜像在 `antonyaty/roam-planner`、`antonyaty/roam-planner-agent`、`antonyaty/roam-planner-sources`；Sources 已包含扫码所需 Chromium，无需在宿主机安装浏览器。

四个服务分别是网页与旅程后端 `trek`、规划运行时 `agent`、外部来源 `sources`、铁路查询 MCP `railway`。铁路镜像使用固定摘要的第三方 `drfccv/mcp-server-12306`，默认启动，无需额外 Key；Sources 等待它健康后启动。只有网页端口映射到宿主机，默认 `127.0.0.1:3000`。规划时需要访问所用模型、地图与来源服务。

当前发行配置为本地单用户部署，规划会话归属于这个本地使用者。直接改变端口绑定不能获得多用户会话隔离。

## 端口与源码构建

需要自定义端口或首次环境默认值时，下载或复制根目录的 [product.env.example](../product.env.example) 为 `.env.product` 并按[配置文档](configuration.md)填写，然后给每条 Compose 命令增加 `--env-file .env.product`。只在页面配置服务时无需这个文件。

源码渠道需要 Git。先拉取完整仓库，再在仓库目录自行构建：

```sh
git clone https://github.com/AntonyLang/roam-planner.git
cd roam-planner
docker compose build
docker compose up -d --wait --no-build
```

构建需访问依赖和基础镜像源；Sources 的 Chromium 下载会增加构建时间与镜像体积。

## 数据与备份

| 卷 | 内容 |
| --- | --- |
| `trek_data` | 旅程数据库、加密服务配置、实例加密密钥 |
| `trek_uploads` | 上传文件与图片 |
| `agent_data` | 持久规划会话与子任务 |
| `sources_data` | 来源缓存、加密小红书 session 与其加密密钥 |
| `service_access` | 容器间配置访问凭据，浏览器不可读取 |

备份时同时保存这些卷和使用中的本地配置。加密数据及其密钥都在对应私有数据卷内，备份仍需保密。`docker compose down` 保留卷，带 `-v` 会删除数据卷；清理前保留可恢复备份。

## 更新与停止

等待当前规划结束并备份数据，保留原来的部署目录、Compose 项目名与本地配置，以继续使用原有数据卷。

Docker Hub 渠道：下载新版 `compose.yaml` 替换部署文件；如果在 `.env.product` 中固定了 `ROAM_VERSION`，同时更新该值。保留自定义端口等本地设置，再执行：

```sh
docker compose pull
docker compose up -d --wait --no-build
docker compose ps
```

源码渠道：在仓库目录更新并重新构建，不需要拉取产品预构建镜像：

```sh
git pull --ff-only
docker compose build
docker compose up -d --wait --no-build
docker compose ps
```

使用 `.env.product` 的部署须在上述每条 Compose 命令中带上 `--env-file .env.product`，例如 `docker compose --env-file .env.product up -d --wait --no-build`。

更新后刷新浏览器，PWA 若仍显示旧界面，可关闭应用页面后重新打开。正常关闭浏览器不会删除持久会话。

```sh
docker compose logs --tail 100 trek agent sources railway
docker compose stop
```

页面中的“停止”用于停止规划任务，关闭页面只断开查看连接。重新打开旅程可继续原对话。
