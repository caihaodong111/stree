# 线上部署记录

- 更新日期：2026-10-16（北京时间）。
- 访问地址：http://115.190.55.138/ （当前使用 HTTP，未配置域名及 HTTPS）。
- 当前镜像：`stree:20261016-1756`。
- 镜像 ID：`sha256:4f9d4f0044360ac7d68ce99e32a8df830da3ac40f08e9125a5d7c47e2c3d3f53`。
- 当前发布：`/opt/stree/current` → `/opt/stree/releases/20261016-1756`。
- 配置与持久化数据：`/opt/stree/shared`；生产配置不进入镜像，模型密钥文件权限为 0600。
- 规划模型：硅基流动 `zai-org/GLM-5.2`，关闭推理，开启 JSON 输出约束，单次最多 8192 Token。
- 生产页面隐藏设置按钮，服务端关闭全部设置 API。本地开发保留设置。
- 文件存储、非 root 容器、只读根文件系统、健康检查、日志轮转和自动重启已启用。

## 本次修复

1. 返回内容以 JSON 语法及展示 schema 校验。查询阶段保留 Function Calling，最终成稿/恢复阶段启用已验证的服务端 JSON Schema 约束。上游明确不支持时才降级为 JSON 对象，并继续本地校验。
2. 清理外层代码围栏及模型结束标签。续写时仅在完整拼接文档可解析的条件下修复已知分段边界漏引号，不猜测一般括号或内容。
3. 语法损坏时至多两次格式恢复，复用现有资料并禁用工具。少量展示字段缺失时，只允许更新 schema 指出的精确字段路径；其他日期、景点和内容保持不变。每次原始响应、修正调用及恢复事件均保留。
4. 成功查询按参数内容缓存。最近六次中四次重复、连续三次失败、达到八轮或 32 次工具请求预算时，使用已有资料完成输出。每个已请求的工具调用均收到对应回复，避免批量调用中断协议。
5. 生成总时限十分钟、单次请求时限四分钟、长度续写至多八次，取消与超时分别提示。
6. 出发地的完整高德 POI 被保留用于首尾停靠点展示；兼容真实 ID 与 `origin` 别名。自动补全仅提供基础信息时，未知营业信息保持 null，避免保存缺少 POI 的行程。
7. 服务关闭先在 `preClose` 取消任务，再释放 SSE 和存储连接，避免实时进度连接阻塞关闭。

## 验证

- 169 项自动化测试、类型检查和生产构建通过，包括三种模型协议、异常格式恢复、续写边界、限定字段更新、跨城首尾站点和 SSE 关闭。
- 原始异常输出回放触发真实模型格式恢复；续写故障回放保留三天内容，仅补缺失标题，其他字段逐值不变，新增工具调用为零，真实字段恢复约两秒。
- 对真实北京三日游模型响应进行完整流程回放，重新执行高德/搜索工具并成功保存；三天、五个已选必去 ID、两晚酒店及太原南站首尾停靠点均保留。
- 恢复任务：`6a502729-1f79-487f-b10f-0003adc3a8ab`；恢复行程：`ee937c2b-4399-4dea-a6c1-dbc601f3b2ee`。
- 行程标题：北京3日经典文化人文行：故宫胡同+海淀高校科技园。
- 公网读取验证：TripSchema 合格、任务完成、历史可读、出发站 POI 绑定正确、设置 API 返回 404。
- 本地报告：`output/json-fix-verification-20261016.json`、`output/json-boundary-replay-20261016.json`、`output/json-fault-replay-20261016.json`。
- 原始失败任务与记录保留；回放记录通过 `response_replayed` / `fault_response_replayed` 事件注明来源，不冒充新的上游响应。

## 运维

```bash
cd /opt/stree/current
docker compose ps
docker compose logs --tail=100 app
docker compose restart app
curl -f http://127.0.0.1/api/health
curl -f http://127.0.0.1/api/status
```

`/opt/stree/current/.env` 固定当前镜像标签。更新前备份 `/opt/stree/shared/runtime`；保留旧发布目录和镜像，回滚进入旧发布目录执行 `docker compose up -d --wait` 后切换 `current` 链接。回滚镜像不回滚持久化数据。

修复前数据备份：`/opt/stree/backups/runtime-before-json-fix-20261016-1718.tar.gz`。模型配置变更前另有 `providers-before-deepseek-20261016-1730.json` 和 `providers-before-glm52-20261016-1748.json`，均仅允许 root 读取。
