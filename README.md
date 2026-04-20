# STREE 北京旅游路线推荐项目

这是一个基于 `FastAPI + Vue 3 + Vite` 的北京旅游路线推荐 MVP，目标是为用户提供结合预算、偏好、起点位置和景点丰富度的路线建议。

## 当前范围

- 城市：北京
- 场景：一日游 / 两日游
- 输入：起点、预算、可用时长、偏好模式、兴趣标签
- 输出：3 条候选路线，包含预算、时长、路线理由和景点顺序
- AI：保留接入 `DeepSeek / 智谱` 的编排层，当前先用启发式解析兜底

## 技术选型

- 后端：FastAPI
- 前端：Vue 3 + Vite + TypeScript
- 数据库：MySQL
- 数据层：后续接景区官网、北京开放数据、授权 API，爬虫作为补充

## 目录结构

```text
backend/
  app/
    api/
    core/
    data/
    models/
    planners/
    repositories/
    schemas/
    services/
    tasks/
  init_db.py
  seed_pois.py
frontend/
  src/
README.md
```

## 后端启动

1. 创建虚拟环境并安装依赖：

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. 初始化数据库环境变量：

`.env` 已按你提供的 MySQL 信息写入，如需调整可编辑 `backend/.env`。

3. 初始化表：

```bash
cd backend
python init_db.py
```

4. 导入北京 POI 种子数据：

```bash
cd backend
python seed_pois.py
```

如需用种子数据覆盖同名景点，可执行：

```bash
cd backend
python seed_pois.py --replace
```

如需从北京市文化和旅游局官方景区目录和北京旅游网详情页批量同步更完整的官方景区数据，可执行：

```bash
cd backend
python sync_official_pois.py --replace
```

首次联调可先跑一个小样本：

```bash
cd backend
python sync_official_pois.py --limit 10
```

5. 启动服务：

```bash
cd backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## 前端启动

```bash
cd frontend
npm install
npm run dev
```

默认访问 `http://localhost:5173`。

开发环境下前端默认通过 Vite 代理将 `/api` 转发到 `http://127.0.0.1:8000`，这样本地联调不需要额外处理 CORS。

如需显示高德真实地图，请在 `frontend/.env.local` 中配置：

```bash
VITE_AMAP_KEY=你的高德Web端Key
VITE_AMAP_SECURITY_CODE=你的安全密钥
```

可先复制 `frontend/.env.example` 为 `frontend/.env.local` 再填写。

如需由后端调用高德 Web Service 进行步行 / 驾车 / 公交换乘路径规划，请在 `backend/.env` 中配置：

```bash
AMAP_WEB_SERVICE_KEY=你的高德Web服务Key
AMAP_TRANSIT_CITY=北京
```

## API 概览

- `GET /api/health`
- `POST /api/recommendations/routes`
- `POST /api/ai/plan`

## 推荐引擎设计

当前推荐逻辑以“规则过滤 + 启发式路径构建 + 多目标加权排序”为主：

- 过滤条件：预算、行政区、景点类别、单段通勤上限
- 候选生成：基于起点和偏好策略选择景点组合
- 排序目标：
  - 时间效率
  - 景点丰富度
  - 地理紧凑度
  - 预算匹配度
  - 用户偏好匹配度

后续建议接入：

- 地图服务：高德/百度的真实路线耗时
- 官方/开放数据：景区开放时间、门票、饱和度
- 酒店与门票授权 API
- 大模型：意图解析、路线解释、替换景点、对话式改写

## 后续扩展建议

- 增加采集任务调度和数据清洗
- 增加用户收藏、历史行程和个性化推荐
- 接入真实 LLM Provider 和 Tool Calling
- 引入地图矩阵和 OR-Tools 做更精细的路线优化
