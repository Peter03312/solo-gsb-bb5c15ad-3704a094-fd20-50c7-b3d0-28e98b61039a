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
- **有序试拼**：基于当前装配版本快照编排**非空有序**的操作序列（每步为
  「撤销一条现存有效关系」或「以两片陶片 + 成对边缘标记建立关系」），
  在内存快照上逐步推演预演，返回每步结果、最终位姿与分组（或首个失败
  原因），全程不改数据；确认时按同一版本与同一序列整体提交，任一步失败
  或版本过期均不写入任何变化，成功仅递增一次装配版本。
- **乐观并发**：采纳 / 撤销 / 删除 / 试拼确认携带期望版本号，过期版本返回 409 冲突提示。

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
6. **有序试拼**（多步预演 + 一次确认）：
   - 在「新建拼接」页放好两片标记后点「**加入试拼**」，或在「查看装配」页
     点有效关系旁的「**试拼撤销**」，把操作排入序列；
   - 侧栏「有序试拼」自动向服务器预演，逐步显示可执行 / 冲突原因，主画布
     以蓝色展示预演后的最终位姿与连通组（此时数据未改变）；
   - 全部步骤通过后点「**确认整组提交**」：按当前版本与整个序列原子写入，
     版本只 +1；任一步失败或版本过期则没有任何变化，按提示刷新后重试。

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
| `POST` | `/api/trials/rehearse` | 有序试拼预演（不落库） |
| `POST` | `/api/trials/commit` | 有序试拼整组确认（原子，版本只 +1） |

错误约定：`400` 校验拒绝（轮廓自交 / 标记重合 / 误差超限 / 碰撞 / 空序列 /
撤销目标非法），`404` 对象不存在（碎片或关系缺失），`409` 版本冲突或重复
撤销，`422` 请求体结构不合法。

## 有序试拼 API

两个端点请求体相同：`expected_version`（所基于的装配版本）+ 非空 `steps`。
每个 step 通过 `action` 区分：

```jsonc
// 建立关系：两片陶片 + 成对边缘标记（每片 ≥2 处、数量一致、同片不重合）
{ "action": "relate", "fragment_a": 1, "fragment_b": 2,
  "markers_a": [[35,0],[38,15]], "markers_b": [[1,0],[4,15]],
  "client_id": "s1" }          // 可选，序列内唯一，供后续撤销步引用

// 撤销：relation_id 撤销已落库关系；client_id 撤销序列内前序新建关系
{ "action": "undo", "relation_id": 3 }
{ "action": "undo", "client_id": "s1" }
```

### 预演（不落库）

```bash
curl -X POST http://localhost:8000/api/trials/rehearse \
  -H 'Content-Type: application/json' \
  -d '{
    "expected_version": 1,
    "steps": [
      {"action":"relate","fragment_a":1,"fragment_b":2,
       "markers_a":[[35,0],[38,15],[33,30]],
       "markers_b":[[1,0],[4,15],[-1,30]],"client_id":"s1"},
      {"action":"undo","client_id":"s1"},
      {"action":"relate","fragment_a":1,"fragment_b":2,
       "markers_a":[[35,0],[38,15]],
       "markers_b":[[1,0],[4,15]],"client_id":"s2"}
    ]
  }'
```

成功响应：`ok=true`，`steps[]` 含每步类型、对应点误差、涉及碎片位姿、
当步后的连通组；`assembly` 为最终位姿 / 分组 / 关系快照（预演新建关系使用
负的临时 id，`assembly.version` 仍为所基于的版本）。

任一步失败时 HTTP 仍为 `200`，但 `ok=false`：`failed_at` 与 `failure`
给出首个失败步、错误码（如 `relation_inactive` / `fragment_missing` /
`relation_not_found` / `client_relation_not_found` / `rejected`）、人类可读
原因与冲突明细；`steps[]` 只含失败步之前的成功步，`assembly` 为失败前一刻
快照。版本过期返回 `409`。

### 确认（整体提交）

```bash
curl -X POST http://localhost:8000/api/trials/commit \
  -H 'Content-Type: application/json' \
  -d '{"expected_version":1,"steps":[
    {"action":"relate","fragment_a":1,"fragment_b":2,
     "markers_a":[[35,0],[38,15]],"markers_b":[[1,0],[4,15]],
     "client_id":"s1"}
  ]}'
# 201: {"ok":true,"version":2,"committed_steps":1,
#       "relation_ids":{"s1":1},"assembly":{...}}
```

- 全部步骤通过 → `201`，返回新版本号、`client_id → 真实关系 id` 映射和
  最新装配快照，整个序列只递增一次版本；
- 任一步失败 → `400/404/409`，`detail` 含 `failed_at / step / action /
  code / message`，**不写入任何变化**；
- `expected_version` 过期 → `409`，同样不写入。

明确的报错约定：重复撤销（关系已失效）→ `409 relation_inactive`；碎片缺失
→ `404 fragment_missing`；关系 id 缺失 → `404 relation_not_found`；撤销
未知 `client_id` → `404 client_relation_not_found`；同片建立关系、标记数量
不足 / 重合、误差 >1mm、轮廓内部重叠、闭环不符位姿 → `400 rejected`
（冲突明细在 `conflicts[]`）；空序列 / 撤销同时给或不给目标 /
`client_id` 重复 → `400`。

## 项目结构

```
app/
  main.py          # FastAPI 路由、单条拼接、版本控制、试拼端点
  trial.py         # 有序试拼：内存快照逐步推演 + 整组提交 + 位姿演算
  geometry.py      # 刚体配准（最小二乘）、轮廓校验、重叠检测
  database.py      # SQLite 持久化、连通组重算
  static/          # 浏览器二维画布前端（原生 JS）
Dockerfile
docker-compose.yml
requirements.txt
```
