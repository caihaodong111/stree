# STREE · 城市旅行手册

面向中国国内城市的旅行规划应用。选择省份和城市，填写天数、预算、出发地、必去地点和旅行偏好，由 **Codex App Server** 生成行程和逐站攻略，再通过 **高德 API** 核验地点、计算实际交通路线并显示地图。

已将原来的 Python / Vue 项目重构为 TypeScript / React。旧北京景点、种子路线、旧推荐与爬取逻辑均不参与新系统。省市目录覆盖全国，景点和酒店按当前目的地实时查询。

## 技术栈

| 层         | 实现                                                           |
| ---------- | -------------------------------------------------------------- |
| 前端       | React 19、TypeScript、Vite、Lucide、AMap JS API 2.0            |
| 后端       | Node.js 22+、TypeScript、Fastify 5                             |
| 契约与校验 | 共享 Zod schema，约束表单、AI 结构化结果和保存的行程           |
| 规划引擎   | 本机 Codex CLI 的 `codex app-server`，通过 stdio JSON-RPC 调用 |
| 地理与交通 | 高德行政区、POI 搜索、公交、步行和驾车 Web 服务                |
| 存储       | MySQL + Drizzle；明确可选的本地 JSON 文件存储                  |
| 验证       | Vitest、Playwright 桌面与移动端测试                            |

Codex App Server 提供模型、线程、工具调用与任务生命周期，本身不规定业务数据库。STREE 自己保存行程与攻略。

## 本地运行

需要 Node.js **22.12+**、npm，以及已安装和登录的 Codex CLI。本项目已用 `codex-cli 0.144.5` 验证。动态工具接口属于 App Server experimental API；升级 CLI 后应运行测试和服务检查。

```bash
npm install
npm install -g @openai/codex
codex login

# 已有配置文件时保留；只在文件不存在时创建。
[ -f backend/.env ] || cp backend/.env.example backend/.env
[ -f frontend/.env.local ] || cp frontend/.env.example frontend/.env.local
```

填写以下高德配置，二者需要不同类型的 Key：

- `backend/.env`：`AMAP_WEB_SERVICE_KEY`，高德「Web 服务」Key。
- `frontend/.env.local`：`VITE_AMAP_KEY`，高德「Web 端 (JS API)」Key；填写对应 `VITE_AMAP_SECURITY_CODE`，并允许本地开发域名。

本地示例使用 `STORAGE_DRIVER=file`，行程保存于 `backend/.runtime/trips/`。这是一项明确配置；数据库故障时系统不会静默切换存储。

```bash
npm run check:services
npm run dev
```

访问 **http://127.0.0.1:5173**。API 默认在 `127.0.0.1:8000`；开发时 Vite 将 `/api` 代理到后端。`npm run dev` 会先构建共享契约。

配置文件、运行数据和依赖目录已排除在 Git 跟踪之外。已有本地 Key 文件会保留。前端变量会进入浏览器构建，服务端 Web 服务 Key 只由后端使用。

## MySQL

已有 MySQL 实例时，创建 UTF-8 数据库，例如：

```sql
CREATE DATABASE IF NOT EXISTS stree CHARACTER SET utf8mb4;
```

在 `backend/.env` 设置：

```dotenv
STORAGE_DRIVER=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=stree
MYSQL_PASSWORD=你的数据库密码
MYSQL_DATABASE=stree
```

然后执行：

```bash
npm run db:setup
npm run check:services
npm run dev
```

初始化仅创建新的 `stree_trips` 表。旧 POI、酒店和路线表不会被读取或修改。行程以校验过的 JSON 保存，并保留城市代码、标题和时间用于检索；修改行程会更新原行程记录。

## 构建与检查

```bash
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm start
```

构建后由 Fastify 同时提供 API 和 React 静态资源，访问 **http://127.0.0.1:8000**。默认只监听本机。

后端测试覆盖高德数据解析、未知地点、必去点、时间与预算约束、酒店验证、Codex 动态工具协议、超时与取消、API 和持久化。浏览器测试使用独立的测试数据和地图 SDK 替身，覆盖省市选择、攻略、地图标记、方案与天数切换、历史、导出、修改和失败恢复；测试数据不进入应用运行代码。

## 规划过程

1. 读取全国省级目录，实时获取高德城市目录。直辖市直接作为城市目的地；省直辖县级目的地按高德目录展示。
2. 在所选城市查询出发地、必去点和候选景点。每个地点保留高德 POI ID、坐标与来源；不接受模型自行生成的坐标。
3. 启动临时 Codex thread，向模型提供旅行需求、结构化输出 schema 和三个动态工具：`search_places`、`search_hotels`、`measure_route`。
4. Codex 按片区、节奏和预算组织每日行程，查询酒店与交通，撰写每条路线和每一站的攻略。
5. 服务端校验天数、必去点、已查询的 POI、酒店类型、时间和预算。不合格输出会获得一次修正机会。
6. 对每个交通段调用高德。公交无方案的短程区间可采用高德确认的步行路径，限制为 3 km / 45 分钟。无法算路的候选方案不会用直线代替。
7. 依据实际交通耗时顺延冲突站点，移除不可行方案，保存行程，通过 SSE 返回进度与结果。
8. React 用高德 JS API 绘制路径和标记；点击站点可联动地图与攻略。修改要求会重新规划并更新原行程。

只调用旅行相关动态工具，关闭 shell、apps、plugins 和 web search，thread 使用 read-only sandbox、空环境和独立运行目录。每次任务结束释放 thread 订阅；取消或超时会中断 turn。应用不读取或展示 Codex 的原始 stderr。

## 数据范围与费用

- 省级目录包含 34 个省级目的地，实际可用城市、POI 与交通取决于高德覆盖及 Key 权限。港澳台目录与交通可能存在覆盖限制，系统会展示提供方返回的错误。
- 当前每份行程规划一个城市，支持 1–7 天。城市包含高德目录中的自治州、地区和省直辖县级目的地。
- 地点、坐标、酒店名称和交通路径来自高德；攻略与门票、餐饮、住宿预算由 AI 生成并标为估算。
- 高德参考消费不是核实过的门票或当天房价。开放、预约、门票与可订状态需要以官方当日信息确认。
- 总预算按每人市内行程估算，住宿按每人分摊房间；不含往返目的地交通。自驾只累计高德返回的已知路桥费，不含油费与停车。
- Codex 使用当前 CLI 登录账户和模型配置；额度与认证取决于账户。高德接口调用也受该 Key 的服务权限和配额限制。

## 配置

| 后端变量                   | 说明                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `CODEX_BIN`                | Codex 可执行文件名或绝对路径，默认 `codex`                     |
| `CODEX_MODEL`              | 留空使用 App Server 返回的默认可用模型                         |
| `CODEX_TIMEOUT_MS`         | 单次模型规划超时，默认 480000 ms                               |
| `AMAP_WEB_SERVICE_KEY`     | 高德 Web 服务 Key                                              |
| `AMAP_REQUEST_INTERVAL_MS` | 高德请求间隔，默认 400 ms；查询结果短期缓存                    |
| `STORAGE_DRIVER`           | `mysql` 或 `file`；未配置时为 `mysql`，本地示例明确使用 `file` |
| `MYSQL_*`                  | MySQL 连接参数                                                 |
| `APP_HOST` / `APP_PORT`    | 默认 `127.0.0.1:8000`                                          |
| `ALLOWED_ORIGINS`          | 允许的开发前端来源，以逗号分隔                                 |

## API 与目录

| 接口                                            | 用途                                         |
| ----------------------------------------------- | -------------------------------------------- |
| `GET /api/health`、`GET /api/status`            | 应用与外部服务状态                           |
| `GET /api/regions/provinces`                    | 省级目的地目录                               |
| `GET /api/regions/cities?provinceCode=330000`   | 指定省份的实时城市目录                       |
| `GET /api/places?cityCode=330100&keyword=西湖`  | 城市 POI 查询                                |
| `POST /api/plans`                               | 提交规划，可带 `previousTripId` 修改已有行程 |
| `GET /api/jobs/:id/events`、`GET /api/jobs/:id` | SSE 进度与断线恢复                           |
| `POST /api/jobs/:id/cancel`                     | 取消任务                                     |
| `GET /api/trips`、`GET /api/trips/:id`          | 历史行程与完整攻略                           |

```text
frontend/src/             React 页面、地图、行程与攻略
backend/src/codex/        App Server JSON-RPC 与动态工具桥接
backend/src/services/     高德 API、全国目的地目录
backend/src/planning/     规划编排、约束校验、任务与进度
backend/src/db/           MySQL / 文件行程存储
packages/shared/src/      跨端类型与 Zod schema
tests/                   后端和浏览器测试
```

接口和规划数据的具体字段见 `packages/shared/src/index.ts`。

官方接口说明：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex 开源实现](https://learn.chatgpt.com/docs/open-source)、[高德 POI 搜索](https://lbs.amap.com/api/webservice/guide/api/search/)、[高德 JS API 安全配置](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)。
