# 陶片拼接系统

面向文物修复人员的陶片拼接 Web 应用：录入毫米制闭合轮廓，基于对应边缘标记
做纯平移 + 旋转的刚体配准，支持预览、采纳、撤销与连通组管理。

## 功能

- **碎片录入**：画布点击或粘贴 JSON 录入毫米制闭合轮廓；自交轮廓整次拒绝。
- **候选拼接**：两片各至少 2 处对应边缘标记（数量一致、同片不重合）。
- **预览**：仅经平移 + 旋转的组合，显示各片位置 (x, y)、角度 (°)、每对
  对应点误差及冲突原因，不落库。
- **采纳校验**（任一不满足即整次拒绝，原拼接组不变）：
  - 同组对应点误差均 ≤ 1 mm；
  - 同组陶片轮廓内部不重叠（允许共边/共点）；
  - 合并两组时整体移动其中一组，组内相对位姿不变；
  - 同组内新增关系（闭环）必须符合已有位姿。
- **撤销**：按剩余有效关系重算连通组，孤片恢复独立状态。
- **试拼编排（多步预演 + 整体确认）**：修复师可基于当前装配版本编排一段
  **非空、有序**的试拼序列（每步「撤销一条现存有效关系」或「以两片陶片及
  成对边缘标记建立关系」）。预演从该版本快照在内存中逐步推演：撤销后按剩余
  关系重算连通组；建立关系沿用现有刚体配准，校验对应点误差 ≤ 1 mm、同组
  轮廓内部不重叠及闭环约束。预演返回**每步结果、最终位姿与分组或首个失败
  原因，且不改任何数据**。确认时按**同一版本和同一操作序列**整体提交：任一
  步失败或版本过期均不写入变化，全部成功**仅递增一次装配版本**。
- **乐观并发**：采纳 / 撤销 / 删除 / 试拼确认携带期望版本号，过期版本返回
  409 冲突提示。

## 一键启动（Docker Compose）

```bash
docker compose up --build
```

构建镜像时自动安装依赖，容器启动时自动初始化 SQLite 表结构与演示数据。

- **访问地址**：http://localhost:8000
- **端口**：`8000`（宿主机映射，可在 `docker-compose.yml` 的 `ports` 中修改）
- **API 文档**：http://localhost:8000/docs

## 本地开发

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

访问 http://localhost:8000 。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_PATH` | `data/app.db`（容器内 `/app/data/app.db`） | SQLite 数据库文件路径 |
| `SEED_DEMO_DATA` | `1` | 首次启动且库为空时写入 4 片演示陶片；设为 `0` 关闭 |

Compose 默认将数据库挂载到命名卷 `pottery-data` 持久化。

## 使用流程

1. **录入碎片**：点击「录入碎片」，在主画布单击添加轮廓顶点（毫米制，
   滚轮缩放、拖拽平移），≥3 个顶点后保存；或直接粘贴坐标 JSON。
2. **新建拼接**：点击「新建拼接」，选择碎片甲 / 乙，在两个小图中点击
   轮廓边缘放置对应标记（每片 ≥2 处、数量一致，按序号一一对应）。
3. **预览**：查看组合后的各片位置、角度、每对误差与冲突原因。
4. **采纳**：校验全部通过才落库；任何冲突整次拒绝，原拼接组不变。
5. **撤销**：在「查看装配」页对有效关系点「撤销」，连通组自动重算。
6. **试拼编排**：切换到「试拼编排」页，按顺序添加步骤（撤销现存关系 / 以
   两片陶片 + 成对边缘标记建立关系，可随时编辑、删除），点「预演」查看逐步
   结果与画布上的最终位姿、分组；全部通过后点「确认整段试拼」整体提交，版本
   仅递增一次。任一步失败时停在该步并给出原因，预演与失败确认都不落库。

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/fragments` | 录入碎片（自交轮廓 400 拒绝） |
| `GET` | `/api/fragments` | 碎片列表 |
| `DELETE` | `/api/fragments/{id}?expected_version=N` | 删除碎片及其关系 |
| `POST` | `/api/relations/preview` | 预览拼接（不落库） |
| `POST` | `/api/relations` | 采纳拼接（携带 `expected_version`） |
| `POST` | `/api/relations/{id}/undo` | 撤销关系（携带 `expected_version`） |
| `GET` | `/api/relations` | 关系列表（含已撤销历史） |
| `GET` | `/api/assembly` | 装配快照：版本、位姿、连通组、关系 |
| `POST` | `/api/rehearsal/preview` | 有序试拼预演（只读，逐步结果 / 首个失败原因） |
| `POST` | `/api/rehearsal/commit` | 同版本同序列整体确认（原子，成功仅递增一次版本） |

错误约定：`400` 校验拒绝（轮廓自交 / 标记重合 / 误差超限 / 碰撞 /
重复撤销 / 空序列），`404` 对象不存在，`409` 版本冲突（过期版本的采纳 /
撤销 / 删除 / 试拼确认或预演）。预演接口对**步骤内**的对象缺失、无效标记与
几何冲突不使用 HTTP 错误码，而是在响应体中返回 `ok:false`、`failed_at`、
`error`、`error_code`（`not_found` / `invalid_markers` / `conflict`）与
`conflicts`；确认接口对同类步骤失败返回 `400/404` 的结构化 detail。

## 试拼编排 API

两个端点接收同一份请求体：`expected_version` 为所依据的装配版本，
`steps` 为**非空有序**操作序列，元素二选一：

```jsonc
// 撤销一步：relation_id 必须是现存且仍有效的关系
{ "action": "undo", "relation_id": 3 }

// 建立一步：两片陶片 + 成对边缘标记（每片 ≥2 处、数量一致、同片不重合）
{ "action": "create", "fragment_a": 1, "fragment_b": 2,
  "markers_a": [[35, 0], [34, 60]], "markers_b": [[1, 0], [0, 60]] }
```

预演（只读，不改数据）：

```bash
curl -s -X POST http://localhost:8000/api/rehearsal/preview \
  -H 'Content-Type: application/json' \
  -d '{
    "expected_version": 1,
    "steps": [
      { "action": "undo", "relation_id": 2 },
      { "action": "create", "fragment_a": 1, "fragment_b": 3,
        "markers_a": [[0, 0], [0, 50]], "markers_b": [[40, 0], [40, 50]] }
    ]
  }'
```

成功响应（节选）：`steps[]` 给出每步结果（建立步含关系类型、最大误差、
涉及碎片的最终放置与步后分组；撤销步含步后分组），`assembly` 为推演终态
快照（位姿 / 连通组 / 关系，试拼中新建的关系带 `"temporary": true` 和负数
临时 id），`final_version_preview` 为确认成功后的预期版本：

```jsonc
{ "ok": true, "base_version": 1, "final_version_preview": 2,
  "steps": [ {"index": 0, "action": "undo", "ok": true, "relation_id": 2, "groups": [...]},
             {"index": 1, "action": "create", "ok": true, "relation_type": "merge",
              "max_error_mm": 0.0, "placements": [...], "groups": [...]} ],
  "failed_at": null, "error": null, "conflicts": [],
  "assembly": { "version": 1, "fragments": [...], "groups": [...], "relations": [...] } }
```

任一步失败时停在该步：`ok:false`，`failed_at` 为首个失败步下标（从 0 起），
`steps` 中保留此前各步与失败步（失败步带 `conflicts`），`assembly` 为失败前
最后状态；重复撤销会明确指出该关系此前已撤销或在本次试拼第几步被撤销。

确认（原子提交；成功仅递增一次版本）：

```bash
curl -s -X POST http://localhost:8000/api/rehearsal/commit \
  -H 'Content-Type: application/json' \
  -d '{ "expected_version": 1, "steps": [ /* 与预演完全相同的序列 */ ] }'
```

- 成功：`200 {"ok": true, "committed_steps": N, "version": 新版本,
  "assembly": {...}}`；
- 任一步失败：`400/404`，detail 含 `failed_at` 与原因，**整段回滚不写入**；
- 版本过期：`409`，不写入；空序列：`400`。

## 项目结构

```
app/
  main.py          # FastAPI 路由、拼接演算接线、试拼预演/确认、版本控制
  rehearsal.py     # 试拼内存态（SimState）、逐步推演与刚体配准校验
  geometry.py      # 刚体配准（最小二乘）、轮廓校验、重叠检测
  database.py      # SQLite 持久化、连通组重算
  static/          # 浏览器二维画布前端（原生 JS）
Dockerfile
docker-compose.yml
requirements.txt
```
