# STREE · 城市旅行手册

面向中国国内城市的旅行规划应用。选择省份和城市，填写天数、预算、出发地、必去地点和旅行偏好，由 **自定义厂商模型** 生成行程和逐站攻略，再通过 **高德 API** 核验地点、计算实际交通路线并显示地图。

已将原来的 Python / Vue 项目重构为 TypeScript / React。旧北京景点、种子路线、旧推荐与爬取逻辑均不参与新系统。省市目录覆盖全国，景点和酒店按当前目的地实时查询。

## 技术栈

| 层         | 实现                                                           |
| ---------- | -------------------------------------------------------------- |
| 前端       | React 19、TypeScript、Vite、Lucide、AMap JS API 2.0            |
| 后端       | Node.js 22+、TypeScript、Fastify 5                             |
| 数据格式   | 共享 Zod schema，解析表单、AI 展示结果和保存的行程           |
| 规划引擎   | 厂商 Chat Completions、Responses、Anthropic Messages API |
| 地理与交通 | 高德行政区、POI 搜索、公交、步行和驾车 Web 服务                |
| 存储       | 默认本地 JSON 文件、分条调用日志与追加事件；兼容旧 MySQL 数据                  |
| 验证       | Vitest、Playwright 桌面与移动端测试                            |

模型提供方通过厂商 API 提供模型与工具调用。STREE 保存行程、攻略和 AI 任务的输入、输出、调用与事件记录。

## 本地运行

需要 Node.js **22.12+** 和 npm。在“设置”中添加厂商 API、网关或本地服务，并选择规划模型。

```bash
npm install

# 已有配置文件时保留；只在文件不存在时创建。
[ -f backend/.env ] || cp backend/.env.example backend/.env
[ -f frontend/.env.local ] || cp frontend/.env.example frontend/.env.local
```

填写以下高德配置，二者需要不同类型的 Key：

- `backend/.env`：`AMAP_WEB_SERVICE_KEY`，高德「Web 服务」Key。
- `frontend/.env.local`：`VITE_AMAP_KEY`，高德「Web 端 (JS API)」Key；填写对应 `VITE_AMAP_SECURITY_CODE`，并允许本地开发域名。

默认使用 `STORAGE_DRIVER=file`，无需数据库或建表。行程保存在 `backend/.runtime/trips/`，任务和调用日志保存在 `backend/.runtime/ai-runs/`。已有 `.env` 时确认 `STORAGE_DRIVER=file`。

```bash
npm run check:services
npm run dev
```

访问 **http://127.0.0.1:5173**。API 默认在 `127.0.0.1:8000`；开发时 Vite 将 `/api` 代理到后端。`npm run dev` 会先构建共享契约。

配置文件、运行数据和依赖目录已排除在 Git 跟踪之外。已有本地 Key 文件会保留。前端变量会进入浏览器构建，服务端 Web 服务 Key 只由后端使用。

## Docker 生产部署

生产镜像同源提供页面和 API，隐藏设置按钮并关闭设置接口。模型配置、行程和调用记录通过挂载目录持久化。构建和更新步骤见 [Docker 部署说明](deploy/README.md)，当前服务器信息见 [线上部署记录](deploy/DEPLOYMENT.md)。

## 本地文件存储

应用默认使用本地文件，启动和运行不会连接 MySQL。行程采用临时文件加原子替换保存。AI 日志将任务元数据、轻量摘要、每次模型/工具调用和事件分开存储：每次调用独立写入 `calls/<id>.json`，事件追加到 `events/<runId>.jsonl`，历史列表只读取摘要。长任务不会在每次进度更新时重写整份上下文。旧版单文件任务仍可读取，首次修改时保存原始备份再升级。

将旧 MySQL 数据迁移到文件可执行 `npm run db:export-files`。命令先备份已有本地文件，再分批读取全部行程、任务、调用和事件，核对条数后导入；保留时间较新的本地记录，MySQL 原数据不修改。完整导出、旧文件备份和条数清单保存在 `backend/.runtime/backups/mysql-to-files-<时间与ID>/`。完成后将 `.env` 的 `STORAGE_DRIVER` 设为 `file` 并重启服务。

## MySQL（仅兼容旧部署，可选）

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
npm run db:migrate
npm run check:services
npm run dev
```

`npm run db:migrate` 会先校验本地行程，并将现有业务表完整备份到 `backend/.runtime/backups/<时间与随机ID>/database.sql`，同时备份本地行程和记录条数。SQL 可恢复到空的 MySQL 数据库；执行恢复的数据库账号需有建表权限。备份目录和文件仅限当前本机用户访问。然后升级 `stree_trips`、在事务中导入本地行程并逐条校验，最后删除当前应用已废弃的 `route_plan_items`、`route_plans`、`hotel_pois`、`pois` 四张表。不会删除其他表。本地原始行程文件保留作为备份，应用切换到 MySQL 后不再读取它们。

迁移使用数据库锁防止重复并发执行；可重复运行，保留数据库中更新的行程，同一时间但内容冲突会中止导入。DDL 会独立提交，部分失败可在排查后重新运行。仅新建表而无需导入和清理时使用 `npm run db:setup`。已有旧版 `stree_trips` 的冗余 `city_code` 字段在备份后删除，城市代码仍保留在 `city.adcode` 和完整行程中。

行程使用 `stree_trips` 表：`id`、`title`、`city`、`days`、`summary`、`payload`、`created_at`、`updated_at`。完整路线、逐日攻略、POI、酒店、交通路径和规划需求保存在经过 Zod 校验的 `payload` JSON 中。城市、标题、天数和摘要用于轻量历史列表，和详情在一次原子 upsert 中同步更新。时间字段使用 UTC 和毫秒精度。

AI 规划过程从任务创建开始持久化，使用三张表：

- `stree_ai_runs`：任务 ID、用户输入、修改前行程 ID、状态、最终结果、行程 ID、错误和时间。
- `stree_ai_calls`：每轮模型请求及工具调用的实际输入、公开输出、提供方、模型、协议、Token 用量（上游返回时）、耗时和错误；工具调用关联触发它的模型调用。长度截断的续写分别记录；新任务不执行行程业务校验重试。
- `stree_ai_events`：按任务内序号保存进度、输出截断、Token 事件和终态（旧任务校验事件仍保留可读）；不受内存中最近 80 条进度的上限影响。

已有数据库只新增 AI 表可运行 `npm run db:ai-setup`，该命令不会导入、删除或修改现有行程。`db:setup` 和 `db:migrate` 也会建立这些表，迁移备份包含已有 AI 表。查询接口为 `GET /api/ai/runs`（最近 50 条摘要）与 `GET /api/ai/runs/:jobId`（完整调用和事件）；成功、失败、取消都保留记录。`GET /api/jobs/:id` 和 SSE 可读取重启前的已完成任务，重启不恢复执行仍在运行的任务。

密码、API 密钥、认证头和模型内部思考内容不写入 AI 记录。数据库故障会明确报告记录保存失败，开始记录失败时不会启动模型请求。文件存储模式使用 `backend/.runtime/ai-runs/` 保存同样的记录；MySQL 模式不会回退到文件。改动前未保存的完整 AI 请求和响应无法从最终行程还原。

AI 数据库读写失败时，页面显示底层错误码及诊断 ID，`backend/.runtime/diagnostics/ai-storage/errors.jsonl` 记录对应操作、表、记录 ID、连接或执行阶段、耗时、参数字节数与脱敏错误信息，不记录原始 SQL 参数或连接凭据。若失败发生在模型或工具调用结束记录写入时，同目录另存 `<callId>.response.json` 保留未能入库的脱敏公开响应，以便复现；不保存模型内部思考，也不会将诊断文件视为已入库或已完成的任务。

历史列表只读取摘要字段，按 `(updated_at, id)` 索引倒序查询最近 30 条；打开行程才按主键读取完整 JSON。连接池默认最多 10 个连接，满载立即返回错误，避免无限排队。连接默认 10 秒超时，单次操作默认 5 秒超时，超时连接销毁。默认启用 MySQL 协议压缩，减少大量坐标和攻略的远程读写流量；可通过 `MYSQL_COMPRESS=false` 关闭。数据库异常返回可展示的 503。AI 记录仅在 SQL 尚未执行的连接获取阶段，对超时或连接丢失重试取连接一次；SQL 已开始后不自动重放读写。

点击顶部导航的“设置”打开移植自 DeepSeek Harness 的设置组件。“规划设置”区域选择并保存规划模型，“模型”区域管理提供方、密钥和模型目录。源码来源与适配范围见 `frontend/src/components/harness-settings/README.md`。添加提供方时填写 Provider ID、显示名称、API 根地址、API 协议和密钥，再获取模型目录或手动添加模型 ID。获取目录后可按模型 ID 或名称搜索、勾选并点击“添加所选”，取消选择不会改变现有目录；已有模型的显示名称保留，每个提供方最多保存 200 个模型。支持 `openai-completions`、`openai-responses` 和 `anthropic-messages`，适用于相应协议的厂商、网关和本地服务；所选模型需支持工具调用。根地址保留 `/v1` 等厂商路径，不包含 `/chat/completions` 或 `/responses`；Anthropic 地址可带或不带尾部 `/v1`。本地无认证服务可留空密钥。高级选项可调整最大输出 Token，并为支持 `response_format` 的 Chat Completions 服务启用 JSON 模式。

创建提供方后，在“模型提供方”和“规划模型”中选择它并点击“保存设置”。每次新规划固定使用当时的提供方、密钥和模型，包含工具调用和长度续写；编辑或删除配置不影响已开始的调用。使用中的提供方需先切换并保存后再删除。模型推理由服务端永久关闭。

提供方和选用配置保存在 `backend/.runtime/provider-settings.json`；重启后保留。密钥存入权限为 `0600` 的本机配置文件，读取接口只返回是否已配置，不返回密钥。编辑时留空保留密钥，填写新值替换，也可明确清除。获取模型目录同样复用该提供方已保存的密钥；新填密钥优先，仅用于本次探测，点击“保存提供方”才会持久化。新增提供方的目录探测只使用表单密钥，不借用相同 ID 的已有凭据。401/403 会展示脱敏后的上游认证原因，需更换对应 API 地址的有效密钥后重试。厂商请求由后端发起，不自动跟随重定向。点击“撤销更改”可恢复为当前保存的配置。旧的本机账户选择会自动改用第一个已配置提供方的首个模型；没有提供方时需先添加。

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

后端测试覆盖高德数据解析、AI 行程原样保存、地图失败仍可交付 AI 建议、厂商 API 协议、工具循环与取消、API 和持久化。浏览器测试使用独立的测试数据和地图 SDK 替身，覆盖省市选择、攻略、地图标记、方案与天数切换、历史、导出、修改和失败恢复；测试数据不进入应用运行代码。

## 规划过程

进入网页标签页时自动请求浏览器定位权限，允许后通过高德坐标转换与逆地理编码识别所在省市，自动选中并排在下拉列表首位，省市选项仅显示名称。打开规划页及重新切回标签页时会自动定位，不展示手动定位按钮和成功后的来源、所在地描述，只在定位过程中或失败时提示状态。原生定位超时或无法获取位置时，改用浏览器中的高德 `Geolocation.getCityInfo` 查询访客网络对应的城市；不会使用后端服务器 IP 判断用户城市，网络出口或代理可能导致估算城市有偏差。拒绝定位权限时不启动备用网络定位。手动切换目的地或开始规划后，后续定位结果只调整展示顺序，不覆盖已选目的地；两种定位都失败时仍可手动选择。定位需要 HTTPS 或 localhost / 127.0.0.1 本机访问；坐标通过 POST 传给后端用于查询，不写入行程或数据库。

“出发地点”和“必去地点”接入高德输入提示，显示地点名称、区域与地址，支持键盘选择。出发地支持全国搜索且单选，必去地点限定目的地城市，最多添加 10 个，仍可输入逗号分隔的名称。切换目的地会清空已选地点；选中的地点保留 POI ID，规划时按 ID 查询高德详情，必去点同时检查城市归属，避免同名地点被重新匹配。已选出发地的详情为空时，后端重新查询高德输入提示，仅使用与已选 ID 完全一致的候选名称、坐标和行政区；不会采用客户端或模型提供的坐标，也不会替换成同名地点。高德两处均无法确认时要求重新选择。

1. 读取全国省级目录，实时获取高德城市目录。直辖市直接作为城市目的地；省直辖县级目的地按高德目录展示。
2. 在所选城市查询出发地、必去点和候选景点。每个地点保留高德 POI ID、坐标与来源；不接受模型自行生成的坐标。
3. 固定当前规划模型配置。向厂商 API 提供旅行需求、JSON 输出 schema 和四个旅行工具：`search_places`、`search_hotels`、`measure_route`、`web_search`（可关闭）。当前规划模型自行生成搜索查询，后端执行公开网页检索并回传真实来源，无需另一个模型或搜索密钥。
4. 模型按片区、节奏和预算组织每日行程，查询酒店与交通，撰写每条路线和每一站的攻略；通过工具调用取得所需事实，直接输出最终行程 JSON。
5. AI 直接生成最终行程，包括每日出发时间、逐站时间、逐段交通方式与选择理由、距离、耗时、费用、总预算和提醒。后端只解析展示所需的 JSON 数据格式，不检查天数、必去点、时间重叠、住宿、交通可行性或预算，不执行行程修正重试。
6. 地图查询仅在 AI 调用工具时执行。公交查无方案作为工具事实提供给 AI，由 AI 决定下一步；最终结果返回后不再逐段重新算路或拦截。AI 可输出明确标注的交通估算，没有地图数据时不伪造导航几何。
7. 直接保存 AI 输出的顺序、时间、交通方式、参考距离与预算，仅绑定地点展示资料和已查询到的地图路径。交通建议使用 `source=ai`，后续用户打开交通面板时独立查询高德导航；导航失败不影响已生成的行程。已移除后端路线可行性、必去点、时间和预算校验及重规划循环。
8. React 用高德 JS API 绘制路径和标记；交通面板按路段切换公交／地铁、驾车与步行，查询最多三条高德真实备选方案，展示上下车站、换乘、步行衔接与道路指引。选中方案在地图高亮，可切换全日概览或在高德打开当前路段；查看交通方式不改动已保存行程的时间和预算。点击站点可联动地图与攻略。修改要求会重新规划并更新原行程。

默认生成一条完整推荐路线，明确要求多方案比较时才生成两至三条，减少重复攻略与等待。发送给模型的交通结果只保留区间 ID、方式、耗时、距离、价格与摘要；完整地图路径仍保存在行程中。返回内容先通过 JSON 语法和展示 schema 检查。仅移除外层代码围栏及模型结束标签；遇到括号损坏或缺少展示字段时，自动要求模型复用当前全部工具结果重新输出完整 JSON，最多恢复两次，期间禁用工具，不重新查询或修改行程业务规则。恢复过程保留在 AI 调用记录中；仍失败时明确报告格式异常。硅基流动提供方启用 JSON 模式后使用服务端 JSON Schema 约束；上游明确报告不支持时降级为 JSON 对象模式并继续本地校验。其他兼容网关保留其 JSON 对象模式选项。

初始候选使用目的地城市限定的“景点”查询，避免使用城市名称时被同名学校占满。模型推理在服务端永久关闭：Chat Completions 发送 `enable_thinking=false`（Qwen 同时关闭聊天模板思考；OpenAI 官方端点使用 `reasoning_effort=none`），Responses 使用 `reasoning.effort=none`，Anthropic 使用 `thinking.type=disabled`。所有新规划、工具循环和续写均使用此策略；若提供方仍返回非空思考内容或非零推理 Token，任务明确失败并要求切换支持非思考模式的模型，不会继续使用推理结果。

成功工具查询按参数内容缓存，参数键顺序、查询词多余空格及 origin 别名不会导致重复请求。最近六次请求中有四次命中缓存，或连续三次工具失败时，使用已有资料进入最终输出。默认最多查询 8 轮或请求 32 次工具，达到任一预算后停止新增查询；同批次剩余工具调用仍收到匹配的结束说明，避免协议断链。模型忽略结束指令时也有最终请求次数上限。上述限制只控制资料查询，不对最终行程执行路线业务校验。

跨城出发的方式、首站、出发与抵达时间均由 AI 决定，后端不预选首站、假定08:00出发或检查抵达时间。地图工具同时接受出发地真实 POI ID 与 origin 别名，查询缓存按起终点和交通方式分别保存。

联网搜索通过当前选定模型的 Function Calling 工具循环执行，适用于现有三种模型协议，不调用额外的 DeepSeek 模型。默认由后端查询必应公开搜索网页，每次工具调用接受 1–4 个查询，合并、去重后最多返回 8 个真实来源。网页读取仅限搜索结果页，未接入文章全文、浏览器登录、图片识别或视频转写；小红书、抖音等平台的命中取决于公开索引，不能保证覆盖站内内容。对 `site:` 查询另外核对实际来源域名，搜索引擎放宽条件时不将外站结果冒充目标平台。公开搜索页面可能因限流、验证或页面结构变化而失败，错误会回传模型并保留在行程提醒中。

提示词要求生成前先检索攻略，网络资料只能作为玩法参考；具体地点仍须取得高德 POI，交通仍以高德为准。网络文本作为不可信资料，不得执行其中的指令。服务端将实际取得的链接、标题、查询、摘录和检索时间保存到行程 `research` 字段，页面和导出攻略均展示“联网攻略来源”。这些是本次检索资料，不代表每条均被最终采用，也不代表已阅读全文。旧行程无此字段仍可读取。失败、关闭、模型未调用搜索和部分失败均如实标记，不伪造来源。

可在 `backend/.env` 设置 `WEB_SEARCH_ENABLED=false` 关闭搜索，`WEB_SEARCH_TIMEOUT_MS` 调整单次工具查询超时。`WEB_SEARCH_ENDPOINT` 默认为 `https://www.bing.com/search`，接受兼容的公开搜索结果页面端点；不携带模型密钥或浏览器 Cookie。只跟随同主机以及必应 www/cn 之间的有限地域跳转。

真实网络验证（会调用配置的模型并产生正常 API 费用）：

```bash
# 当前选中的模型，验证普通攻略及小红书、抖音公开内容命中，再验证模型工具闭环
npm run check:web-search
# 使用某个已配置的提供方首个模型，不修改默认选择；同时验证真实高德行程及来源持久化
npm run check:web-search -- --provider=siliconflow --plan
# 只检索公开网页，不调用模型
npm run check:web-search -- --search-only
```

验证记录保存到 `output/web-search-verification-*.json`，只含公开检索资料、模型回答和验证结果，不含密钥。`--plan` 的测试行程保存在独立的 `backend/.runtime/verification/trips/`，不写入用户的行程历史。

只向模型提供旅行相关工具，用户取消会中断当前模型请求。应用不设置工具调用次数、对话轮数、模型规划总时长或模型响应大小的硬上限，模型持续运行直到完成、上游返回错误或用户取消；相同旅行工具查询的成功结果在本次规划中复用，失败结果允许重试。进度显示本次模型生成的累计工具调用次数。OpenAI 兼容协议的输出 Token 上限默认留空，不向模型服务发送该参数；Anthropic Messages 协议要求显式填写该参数，有效范围由上游模型决定。模型输出被单次长度截断时，保留已有 JSON 和推理并自动续写；已完整的 JSON 直接进入展示数据解析和保存。续写最多八次；格式恢复后重新从完整对象开始，不把新文档拼接到损坏片段上。整个生成默认最多 10 分钟，单次模型请求最多 4 分钟，超时和用户取消分别提示。截断诊断（Token 用量、输出与推理字符数）记录在 backend/.runtime/model-runs/，不记录密钥或推理原文；后端不再执行路线业务校验；格式解析、工具或存储错误仍明确显示。上游 HTTP 错误和生成失败显示脱敏后的接口原因。

## 数据范围与费用

- 省级目录包含 34 个省级目的地，实际可用城市、POI 与交通取决于高德覆盖及 Key 权限。港澳台目录与交通可能存在覆盖限制，系统会展示提供方返回的错误。
- 当前每份行程规划一个城市，支持 1–7 天。城市包含高德目录中的自治州、地区和省直辖县级目的地。
- 地点、坐标、酒店名称和交通路径来自高德；攻略与门票、餐饮、住宿预算由 AI 生成并标为估算。
- 高德参考消费不是核实过的门票或当天房价。开放、预约、门票与可订状态需要以官方当日信息确认。
- 填写出发地后，以该地址作为旅途起点（支持跨城），出发路段的时间、距离和费用一并纳入 AI 行程及每人参考总预算；不填写则从目的地市中心开始。预算按已安排的路段估算，不默认包含未安排的返程。住宿按每人分摊房间；自驾油费、停车费等未知费用由 AI 明确标注估算或待确认。
- 模型 API 额度与认证取决于所配置的提供方。高德接口调用也受该 Key 的服务权限和配额限制。

## 配置

| 后端变量                   | 说明                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `AMAP_WEB_SERVICE_KEY`     | 高德 Web 服务 Key                                              |
| `AMAP_REQUEST_INTERVAL_MS` | 高德请求间隔，默认 400 ms；查询结果短期缓存                    |
| `STORAGE_DRIVER`           | `file` 或 `mysql`；默认 `file`，运行不依赖数据库 |
| `MYSQL_CONNECTION_LIMIT` | 连接池大小，默认 10；满载不排队 |
| `MYSQL_CONNECT_TIMEOUT_MS` / `MYSQL_QUERY_TIMEOUT_MS` | 默认 10000 / 5000 毫秒 |
| `MYSQL_COMPRESS` | 默认 `true`，压缩数据库协议流量 |
| `MYSQL_*`                  | MySQL 连接参数                                                 |
| `APP_HOST` / `APP_PORT`    | 默认 `127.0.0.1:8000`                                          |
| `ALLOWED_ORIGINS`          | 允许的开发前端来源，以逗号分隔                                 |
| `MODEL_MAX_TOOL_ROUNDS` / `MODEL_MAX_TOOL_CALLS` | 查询预算，默认 8 轮 / 32 次，达到后使用现有资料输出 |
| `MODEL_TIMEOUT_MS` / `MODEL_REQUEST_TIMEOUT_MS` | 生成总时限 / 单次接口时限，默认 600000 / 240000 毫秒 |

## API 与目录

| 接口                                            | 用途                                         |
| ----------------------------------------------- | -------------------------------------------- |
| `GET /api/health`、`GET /api/status`            | 应用与外部服务状态                           |
| `GET /api/settings/model`、`PUT /api/settings/model` | 获取模型目录与配置、保存模型和思考强度 |
| `POST /api/settings/providers`、`PUT /api/settings/providers/:id` | 新增、编辑提供方和模型目录；密钥留空保留 |
| `DELETE /api/settings/providers/:id` | 删除未使用的提供方 |
| `POST /api/settings/providers/discover` | 使用表单或已保存凭据获取厂商模型目录 |
| `GET /api/regions/provinces`                    | 省级目的地目录                               |
| `GET /api/regions/cities?provinceCode=330000`   | 指定省份的实时城市目录                       |
| `POST /api/regions/locate`                     | 将浏览器 GPS 坐标解析为目录中的所在省市       |
| `POST /api/regions/locate-city`                | 将浏览器网络定位返回的行政区代码匹配到可用省市 |
| `GET /api/places?cityCode=330100&keyword=西湖`  | 城市 POI 查询                                |
| `GET /api/places/suggest?cityCode=330100&keyword=西湖` | 城市地点输入提示，返回名称、地址与 POI ID |
| `POST /api/plans`                               | 提交规划，可带 `previousTripId` 修改已有行程 |
| `GET /api/jobs/:id/events`、`GET /api/jobs/:id` | SSE 进度与断线恢复                           |
| `POST /api/jobs/:id/cancel`                     | 取消任务                                     |
| `GET /api/trips`、`GET /api/trips/:id`          | 历史行程与完整攻略                           |

```text
frontend/src/             React 页面、地图、行程与攻略
backend/src/models/       厂商配置、凭据持久化与三种 API 协议工具循环
backend/src/services/     高德 API、全国目的地目录
backend/src/planning/     AI 工具接入、结果保存、任务与进度
backend/src/db/           MySQL / 文件行程存储
packages/shared/src/      跨端类型与 Zod schema
tests/                   后端和浏览器测试
```

接口和规划数据的具体字段见 `packages/shared/src/index.ts`。

官方接口说明：[OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)、[DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)、[高德 POI 搜索](https://lbs.amap.com/api/webservice/guide/api/search/)、[高德 JS API 安全配置](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)。
