# 部署与维护

## Docker 启动

安装 Docker Engine / Docker Desktop 和 Compose 插件，按根 README 填写 `.env.product`，执行：

```sh
docker compose --env-file .env.product up --build -d --wait
docker compose --env-file .env.product ps
```

三个服务分别是网页与旅程后端 `trek`、规划运行时 `agent`、外部来源 `sources`。只有网页端口映射到宿主机，默认 `127.0.0.1:3000`。首次构建需要访问依赖与基础镜像源；规划时需访问配置的模型、地点、路线和网页服务。

当前发行配置是**本地单用户部署**，规划会话归属于这个本地使用者。直接改变端口绑定不能获得多用户会话隔离。

## 数据

| 卷 | 内容 |
| --- | --- |
| `trek_data` | 旅程、地点、预算与住宿数据库 |
| `trek_uploads` | 上传文件与图片 |
| `agent_data` | 持久规划会话与子任务 |
| `sources_data` | 来源缓存和引用数据 |

备份时同时保存这些卷与本地配置。`docker compose down` 保留卷；带 `-v` 会删除数据卷。迁移或清理前先保留可恢复备份。

## 更新

等待当前规划完成，备份数据，然后更新源码并重新构建：

```sh
git pull --ff-only
docker compose --env-file .env.product up --build -d --wait
```

更新后刷新浏览器；PWA 若仍显示旧界面，可关闭该应用页面再重新打开并刷新。正常关闭浏览器不会删除持久会话。

## 查看日志与停止

```sh
docker compose --env-file .env.product logs --tail 100 trek agent sources
docker compose --env-file .env.product stop
```

在页面中点击“停止”会停止规划任务；关闭页面只断开查看连接。重新打开旅程可继续原对话。
