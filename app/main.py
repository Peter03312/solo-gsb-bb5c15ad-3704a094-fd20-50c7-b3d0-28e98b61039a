"""陶片拼接系统 —— FastAPI 后端。

业务规则：
- 录入毫米制闭合轮廓，自交轮廓整次拒绝；
- 候选拼接需两片各至少 2 处对应边缘标记，标记重合拒绝；
- 采纳拼接仅做平移+旋转：同组对应点误差均 ≤ 1mm，同组轮廓内部不重叠；
- 合并两组时整体移动其中一组，组内相对位姿不变；
- 同组内新增关系（闭环）必须符合已有位姿；
- 任何校验失败整次拒绝，原拼接组不变；
- 撤销关系后按剩余关系重算连通组，孤片恢复独立状态；
- 采纳/撤销携带期望版本号，过期版本返回 409 冲突。
"""
from __future__ import annotations

import math
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import geometry
from .database import DB

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get(
    "DATABASE_PATH", os.path.join(BASE_DIR, "..", "data", "app.db"))
SEED_DEMO_DATA = os.environ.get("SEED_DEMO_DATA", "1") != "0"

db: DB | None = None


def get_db() -> DB:
    assert db is not None
    return db


# ---------------------------------------------------------------- 请求模型

class FragmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    contour: list[list[float]] = Field(min_length=3)


class PreviewIn(BaseModel):
    fragment_a: int
    fragment_b: int
    markers_a: list[list[float]] = Field(default_factory=list)
    markers_b: list[list[float]] = Field(default_factory=list)


class AcceptIn(PreviewIn):
    expected_version: int


class UndoIn(BaseModel):
    expected_version: int


# ---------------------------------------------------------------- 拼接演算

def _pose_of(f: dict) -> tuple[float, float, float]:
    return (f["x"], f["y"], f["theta"])


def _load_pair(d: DB, fa_id: int, fb_id: int):
    if fa_id == fb_id:
        raise HTTPException(400, "不能与同一片陶片建立拼接关系")
    fa, fb = d.get_fragment(fa_id), d.get_fragment(fb_id)
    if fa is None or fb is None:
        missing = fa_id if fa is None else fb_id
        raise HTTPException(404, f"碎片 #{missing} 不存在")
    return fa, fb


def _members(d: DB, frag: dict) -> list[dict]:
    """碎片所在组的全部成员（孤片即自身）。"""
    if frag["group_id"] is None:
        return [frag]
    return d.group_members(frag["group_id"])


def evaluate_proposal(d: DB, fa: dict, fb: dict,
                      markers_a, markers_b) -> dict:
    """计算采纳后的位姿方案（只读，不落库），供预览与采纳共用。"""
    try:
        ma, mb = geometry.validate_markers(markers_a, markers_b)
    except geometry.GeometryError as e:
        return {"ok": False, "relation_type": None, "conflicts": [str(e)],
                "errors": [], "poses": {}, "new_poses": {}, "involved": [],
                "markers": (markers_a, markers_b)}

    members_a, members_b = _members(d, fa), _members(d, fb)
    ga, gb = fa["group_id"], fb["group_id"]
    pose_a, pose_b = _pose_of(fa), _pose_of(fb)
    new_poses: dict[int, tuple] = {}

    if ga is not None and ga == gb:
        # 闭环关系：必须符合已有位姿，不移动任何碎片
        relation_type = "loop"
        involved = {f["id"] for f in members_a}
    else:
        dst = [geometry.apply_pose(m, pose_a) for m in ma]  # A 侧标记的世界坐标
        if ga is None and gb is None:
            relation_type = "new_group"
            new_poses[fb["id"]] = geometry.fit_rigid(mb, dst)
        elif ga is not None and gb is None:
            relation_type = "join"
            new_poses[fb["id"]] = geometry.fit_rigid(mb, dst)
        elif ga is None and gb is not None:
            relation_type = "join"
            src_b = [geometry.apply_pose(m, pose_b) for m in mb]
            new_poses[fa["id"]] = geometry.fit_rigid(ma, src_b)
        else:
            # 合并两组：整体移动 B 组，组内相对位姿不变
            relation_type = "merge"
            src_b = [geometry.apply_pose(m, pose_b) for m in mb]
            T = geometry.fit_rigid(src_b, dst)
            for f in members_b:
                new_poses[f["id"]] = geometry.compose_pose(T, _pose_of(f))
        involved = {f["id"] for f in members_a} | {f["id"] for f in members_b}

    # 采纳后的最终位姿 = 当前位姿 + 本次改动
    by_id = {f["id"]: f for f in members_a + members_b}
    poses = {fid: _pose_of(f) for fid, f in by_id.items()}
    poses.update(new_poses)

    conflicts: list[str] = []
    errors = geometry.pair_errors(ma, mb, poses[fa["id"]], poses[fb["id"]])
    for i, e in enumerate(errors):
        if e > geometry.MAX_ERROR_MM + 1e-9:
            conflicts.append(
                f"误差超限：第 {i + 1} 对对应点误差 {e:.3f} mm，"
                f"超过 {geometry.MAX_ERROR_MM:.0f} mm 限值")

    placed = [
        (fid, by_id[fid]["name"],
         geometry.contour_world(by_id[fid]["contour"], poses[fid]))
        for fid in sorted(involved)
    ]
    for n1, n2, area in geometry.find_overlaps(placed):
        conflicts.append(
            f"碰撞：碎片「{n1}」与「{n2}」轮廓内部重叠 {area:.2f} mm²")

    return {
        "ok": not conflicts,
        "relation_type": relation_type,
        "conflicts": conflicts,
        "errors": errors,
        "poses": poses,
        "new_poses": new_poses,
        "involved": sorted(involved),
        "by_id": by_id,
        "markers": (ma, mb),
    }


def _check_version(d: DB, expected: int):
    current = d.version()
    if expected != current:
        raise HTTPException(
            409, f"版本冲突：当前数据版本为 v{current}，"
                 f"您基于 v{expected} 的操作已过期，请刷新后重试")


# ---------------------------------------------------------------- 应用生命周期

def seed_demo(d: DB):
    """初始化演示数据（仅当库为空且未禁用）。"""
    if d.all_fragments():
        return
    demo = [
        ("陶片A-左半", [[0, 0], [35, 0], [38, 15], [33, 30], [37, 45], [34, 60], [0, 60]]),
        ("陶片B-右半", [[1, 0], [4, 15], [-1, 30], [3, 45], [0, 60], [46, 60], [46, 0]]),
        ("陶片C", [[0, 0], [40, 0], [35, 25], [10, 30]]),
        ("陶片D", [[0, 0], [30, 5], [25, 35], [-5, 20]]),
    ]
    with d.lock:
        for name, contour in demo:
            d.insert_fragment(name, contour)
        d.bump_version()
        d.conn.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global db
    db = DB(DB_PATH)
    if SEED_DEMO_DATA:
        seed_demo(db)
    yield
    db.conn.close()


app = FastAPI(title="陶片拼接系统", version="1.0.0", lifespan=lifespan)


# ---------------------------------------------------------------- 碎片 API

@app.post("/api/fragments", status_code=201)
def create_fragment(payload: FragmentIn):
    d = get_db()
    try:
        contour = geometry.validate_contour(payload.contour)
    except geometry.GeometryError as e:
        raise HTTPException(400, str(e))
    with d.lock:
        fid = d.insert_fragment(payload.name.strip(), contour)
        d.bump_version()
        d.conn.commit()
        return {"ok": True, "fragment": d.get_fragment(fid),
                "version": d.version()}


@app.get("/api/fragments")
def list_fragments():
    return get_db().all_fragments()


@app.delete("/api/fragments/{fid}")
def delete_fragment(fid: int, expected_version: int):
    d = get_db()
    with d.lock:
        try:
            d.conn.execute("BEGIN IMMEDIATE")
            _check_version(d, expected_version)
            if d.get_fragment(fid) is None:
                raise HTTPException(404, f"碎片 #{fid} 不存在")
            d.delete_fragment(fid)
            d.recompute_groups()
            d.bump_version()
            d.conn.commit()
        except Exception:
            d.conn.rollback()
            raise
    return {"ok": True, "assembly": d.assembly_state()}


# ---------------------------------------------------------------- 拼接 API

@app.post("/api/relations/preview")
def preview_relation(payload: PreviewIn):
    """预览：仅平移+旋转后的组合，返回各片位置、角度及冲突原因，不落库。"""
    d = get_db()
    with d.lock:
        fa, fb = _load_pair(d, payload.fragment_a, payload.fragment_b)
        ev = evaluate_proposal(d, fa, fb, payload.markers_a, payload.markers_b)
        if not ev["involved"]:
            return {"ok": False, "relation_type": None,
                    "conflicts": ev["conflicts"], "errors": [],
                    "max_error_mm": None, "placements": [], "markers_world": None}
        placements = []
        for fid in ev["involved"]:
            f = ev["by_id"][fid]
            x, y, th = ev["poses"][fid]
            placements.append({
                "fragment_id": fid,
                "name": f["name"],
                "x": round(x, 4),
                "y": round(y, 4),
                "theta_deg": round(math.degrees(th), 4),
                "contour_world": geometry.contour_world(f["contour"], (x, y, th)),
            })
        ma, mb = ev["markers"]
        pa, pb = ev["poses"][fa["id"]], ev["poses"][fb["id"]]
        return {
            "ok": ev["ok"],
            "relation_type": ev["relation_type"],
            "conflicts": ev["conflicts"],
            "errors": [round(e, 4) for e in ev["errors"]],
            "max_error_mm": round(max(ev["errors"]), 4) if ev["errors"] else None,
            "placements": placements,
            "markers_world": {
                "a": [geometry.apply_pose(m, pa) for m in ma],
                "b": [geometry.apply_pose(m, pb) for m in mb],
            },
        }


@app.post("/api/relations", status_code=201)
def accept_relation(payload: AcceptIn):
    """采纳拼接：全部校验通过才落库，任一失败整次拒绝、原拼接组不变。"""
    d = get_db()
    with d.lock:
        try:
            d.conn.execute("BEGIN IMMEDIATE")
            _check_version(d, payload.expected_version)
            fa, fb = _load_pair(d, payload.fragment_a, payload.fragment_b)
            ev = evaluate_proposal(d, fa, fb, payload.markers_a, payload.markers_b)
            if not ev["ok"]:
                raise HTTPException(400, detail={
                    "message": "拼接被拒绝，原拼接组不变",
                    "conflicts": ev["conflicts"],
                })
            for fid, pose in ev["new_poses"].items():
                d.update_pose(fid, pose)
            rid = d.insert_relation(fa["id"], fb["id"], ev["markers"][0],
                                    ev["markers"][1], max(ev["errors"]))
            d.recompute_groups()
            d.bump_version()
            d.conn.commit()
        except HTTPException:
            d.conn.rollback()
            raise
        except Exception:
            d.conn.rollback()
            raise HTTPException(500, "内部错误，本次操作未生效")
    return {"ok": True, "relation_id": rid, "assembly": d.assembly_state()}


@app.post("/api/relations/{rid}/undo")
def undo_relation(rid: int, payload: UndoIn):
    """撤销关系：按剩余关系重算连通组，孤片恢复独立状态。"""
    d = get_db()
    with d.lock:
        try:
            d.conn.execute("BEGIN IMMEDIATE")
            _check_version(d, payload.expected_version)
            rel = d.get_relation(rid)
            if rel is None:
                raise HTTPException(404, f"拼接关系 #{rid} 不存在")
            if not rel["active"]:
                raise HTTPException(
                    409, f"版本冲突：拼接关系 #{rid} 已被撤销，请刷新后重试")
            d.undo_relation(rid)
            d.recompute_groups()
            d.bump_version()
            d.conn.commit()
        except HTTPException:
            d.conn.rollback()
            raise
        except Exception:
            d.conn.rollback()
            raise HTTPException(500, "内部错误，本次操作未生效")
    return {"ok": True, "assembly": d.assembly_state()}


@app.get("/api/relations")
def list_relations():
    return get_db().all_relations()


@app.get("/api/assembly")
def get_assembly():
    """当前装配快照：版本号、碎片位姿、连通组、全部关系。"""
    return get_db().assembly_state()


# ---------------------------------------------------------------- 前端静态页

app.mount("/", StaticFiles(directory=os.path.join(BASE_DIR, "static"), html=True),
          name="static")
