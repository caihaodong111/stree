# Docker 部署

使用 Node.js 22 多阶段镜像，Fastify 同源提供前端和 `/api`，默认发布到主机 80 端口。生产构建隐藏设置按钮，生产服务默认不注册任何 `/api/settings/*` 接口；规划仍从运行目录读取模型配置。

部署前准备以下文件（均已排除在 Git 和镜像构建上下文之外）：

- `deploy/backend.env`：`AMAP_WEB_SERVICE_KEY`、`ALLOWED_ORIGINS`，以及可选的网页搜索配置。
- `deploy/frontend.env`：`VITE_API_BASE=/api`、`VITE_AMAP_KEY` 和 `VITE_AMAP_SECURITY_CODE`。该文件作为构建 secret 读取；其中的浏览器配置会进入前端产物。
- `deploy/runtime/provider-settings.json`：从已验证的本地模型配置复制公网可达的提供方和对应 `selection`。服务端 API 密钥仅保存在此文件。

```bash
mkdir -p deploy/runtime
chmod 600 deploy/backend.env deploy/frontend.env deploy/runtime/provider-settings.json
chown -R 1000:1000 deploy/runtime
STREE_IMAGE=stree:release-id docker compose build
STREE_IMAGE=stree:release-id docker compose up -d --wait
curl -f http://127.0.0.1/api/health
curl -f http://127.0.0.1/api/status
```

运行数据持久化在 `deploy/runtime`，容器重建不会清空行程、模型配置和调用记录。更新前备份此目录，保留上一版镜像；回滚时使用之前的 `STREE_IMAGE` 执行 `docker compose up -d --wait`。默认使用文件存储，不依赖开发机的 MySQL 或内网模型。

线上更新模型时，通过 SSH 修改 `deploy/runtime/provider-settings.json` 后执行 `docker compose restart app`。高德 Web Key 与 JS Key 类型不同；JS Key 的域名限制需要允许实际访问地址。容器内置健康检查，Docker 服务开机启动后会自动恢复应用。
