"""非空有序试拼编排：从装配快照构建内存态，逐步推演撤销 / 建立关系。

推演全程只读真实库（SimState 是 GET /api/assembly 快照的内存副本）：
- 撤销一步：关系必须现存且有效；重复撤销（含序列内撤销同一条）明确报错，
  随后按剩余有效关系重算连通组，孤片恢复独立状态，位姿不变；
- 建立一步：以两片陶片及成对边缘标记沿用当前刚体配准（最小二乘平移+旋转），
  校验对应点误差 ≤ 1mm、同组轮廓内部不重叠、闭环必须符合已有位姿；
  任一项不满足，该步失败，推演在首个失败步终止。

确认（commit）阶段在真实库上按同一序列重放同一套演算：
任一步失败或版本过期则整体回滚，全部成功仅递增一次装配版本。
"""
from __future__ import annotations

import math

from . import geometry
from .database import compute_groups


class StepError(Exception):
    """试拼某一步失败（不落库）。

    code 与单条接口的 HTTP 语义对齐：
    not_found=对象缺失(404)，invalid_markers=无效标记(400)，
    conflict=重复撤销/几何冲突(400)。
    """

    def __init__(self, step: int, code: str, message: str,
                 conflicts: list[str] | None = None, step_result: dict | None = None):
        super().__init__(message)
        self.step = step
        self.code = code
        self.message = message
        self.conflicts = conflicts or []
        self.step_result = step_result


# ---------------------------------------------------------------- 配准演算

def _pose_of(f: dict) -> tuple[float, float, float]:
    return (f["x"], f["y"], f["theta"])


def _members(state, frag: dict) -> list[dict]:
    """碎片所在组的全部成员（孤片即自身）。"""
    if frag["group_id"] is None:
        return [frag]
    return state.group_members(frag["group_id"])


def evaluate_proposal(state, fa: dict, fb: dict,
                      markers_a, markers_b) -> dict:
    """计算建立关系后的位姿方案（只读，不落库），预览 / 采纳 / 试拼共用。

    state 只需提供 group_members()（DB 与 SimState 均满足）。
    """
    try:
        ma, mb = geometry.validate_markers(markers_a, markers_b)
    except geometry.GeometryError as e:
        return {"ok": False, "relation_type": None, "conflicts": [str(e)],
                "errors": [], "poses": {}, "new_poses": {}, "involved": [],
                "markers": (markers_a, markers_b)}

    members_a, members_b = _members(state, fa), _members(state, fb)
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

    # 建立后的最终位姿 = 当前位姿 + 本次改动
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


# ---------------------------------------------------------------- 内存态

class SimState:
    """装配快照的内存副本，接口与 DB 同构，供试拼逐步推演。"""

    def __init__(self, snapshot: dict):
        self.fragments = {f["id"]: dict(f) for f in snapshot["fragments"]}
        self.relations = [dict(r) for r in snapshot["relations"]]
        self.version = snapshot["version"]
        self._next_rid = -1  # 试拼中的临时关系使用负数 id

    # ---- 与 DB 对齐的查询接口（evaluate_proposal 复用）

    def get_fragment(self, fid: int) -> dict | None:
        return self.fragments.get(fid)

    def group_members(self, group_id: int) -> list[dict]:
        return [f for f in self.fragments.values() if f["group_id"] == group_id]

    def get_relation(self, rid: int) -> dict | None:
        for r in self.relations:
            if r["id"] == rid:
                return r
        return None

    # ---- 写入（仅内存）

    def update_pose(self, fid: int, pose):
        f = self.fragments[fid]
        f["x"], f["y"], f["theta"] = pose

    def insert_relation(self, fa: int, fb: int, markers_a, markers_b,
                        max_error: float) -> int:
        rid = self._next_rid
        self._next_rid -= 1
        self.relations.append({
            "id": rid, "fragment_a": fa, "fragment_b": fb,
            "markers_a": markers_a, "markers_b": markers_b,
            "max_error": max_error, "active": True,
            "created_at": None, "undone_at": None, "temporary": True,
        })
        return rid

    def undo_relation(self, rid: int):
        self.get_relation(rid)["active"] = False

    def recompute_groups(self):
        gid_of = compute_groups(
            list(self.fragments.keys()),
            [(r["fragment_a"], r["fragment_b"])
             for r in self.relations if r["active"]])
        for fid, gid in gid_of.items():
            self.fragments[fid]["group_id"] = gid

    # ---- 快照输出（结构与 DB.assembly_state 一致）

    def assembly_state(self) -> dict:
        groups: dict[int, list[int]] = {}
        for f in self.fragments.values():
            if f["group_id"] is not None:
                groups.setdefault(f["group_id"], []).append(f["id"])
        return {
            "version": self.version,
            "fragments": [dict(f) for f in
                          sorted(self.fragments.values(), key=lambda x: x["id"])],
            "groups": [{"id": gid, "fragment_ids": sorted(ids)}
                       for gid, ids in sorted(groups.items())],
            "relations": [dict(r) for r in sorted(self.relations,
                                                  key=lambda x: x["id"])],
        }


# ---------------------------------------------------------------- 逐步推演

def _simulate_undo(state: SimState, step: dict, index: int) -> dict:
    rid = step["relation_id"]
    rel = state.get_relation(rid)
    if rel is None:
        raise StepError(index, "not_found",
                        f"第 {index + 1} 步失败：拼接关系 #{rid} 不存在")
    if not rel["active"]:
        if rid in state._undone_steps:
            at = state._undone_steps.index(rid) + 1
            reason = f"已在本次试拼第 {at} 步被撤销"
        else:
            reason = "此前已撤销"
        raise StepError(
            index, "conflict",
            f"第 {index + 1} 步失败：重复撤销，拼接关系 #{rid} {reason}，"
            f"不能再次撤销")
    state.undo_relation(rid)
    state.recompute_groups()
    state._undone_steps.append(rid)
    return {
        "index": index,
        "action": "undo",
        "ok": True,
        "relation_id": rid,
        "groups": state.assembly_state()["groups"],
    }


def _simulate_create(state: SimState, step: dict, index: int) -> dict:
    fa_id, fb_id = step["fragment_a"], step["fragment_b"]
    if fa_id == fb_id:
        raise StepError(index, "conflict",
                        f"第 {index + 1} 步失败：不能与同一片陶片建立拼接关系")
    fa, fb = state.get_fragment(fa_id), state.get_fragment(fb_id)
    if fa is None or fb is None:
        missing = fa_id if fa is None else fb_id
        raise StepError(index, "not_found",
                        f"第 {index + 1} 步失败：碎片 #{missing} 不存在")

    markers_a, markers_b = step["markers_a"], step["markers_b"]
    try:
        ma, mb = geometry.validate_markers(markers_a, markers_b)
    except geometry.GeometryError as e:
        raise StepError(index, "invalid_markers",
                        f"第 {index + 1} 步失败：无效标记 —— {e}")

    ev = evaluate_proposal(state, fa, fb, ma, mb)
    result = {
        "index": index,
        "action": "create",
        "ok": ev["ok"],
        "relation_type": ev["relation_type"],
        "fragment_a": fa_id,
        "fragment_b": fb_id,
        "conflicts": ev["conflicts"],
        "errors": [round(e, 4) for e in ev["errors"]],
        "max_error_mm": round(max(ev["errors"]), 4) if ev["errors"] else None,
        "placements": [],
    }
    for fid in ev["involved"]:
        f = ev["by_id"][fid]
        x, y, th = ev["poses"][fid]
        result["placements"].append({
            "fragment_id": fid,
            "name": f["name"],
            "x": round(x, 4),
            "y": round(y, 4),
            "theta_deg": round(math.degrees(th), 4),
            "contour_world": geometry.contour_world(f["contour"], (x, y, th)),
        })
    if not ev["ok"]:
        raise StepError(
            index, "conflict",
            f"第 {index + 1} 步失败：" + "；".join(ev["conflicts"]),
            conflicts=ev["conflicts"], step_result=result)

    for fid, pose in ev["new_poses"].items():
        state.update_pose(fid, pose)
    rid = state.insert_relation(fa_id, fb_id, ma, mb, max(ev["errors"]))
    state.recompute_groups()
    result["relation_id"] = rid
    result["temporary"] = True
    result["groups"] = state.assembly_state()["groups"]
    return result


def run_rehearsal(snapshot: dict, steps: list[dict]) -> dict:
    """从快照逐步推演有序操作序列（非空由调用方保证），全程不改真实数据。

    返回 {"ok", "steps", "failed_at", "error", "conflicts", "assembly"}：
    全部成功时 assembly 为推演后快照；任一步失败时停在该步，
    assembly 为失败前最后状态，failed_at/error 给出首个失败原因。
    """
    state = SimState(snapshot)
    state._undone_steps = []  # 序列内已撤销的关系 id，用于重复撤销报错
    results: list[dict] = []
    try:
        for i, step in enumerate(steps):
            if step["action"] == "undo":
                results.append(_simulate_undo(state, step, i))
            else:
                results.append(_simulate_create(state, step, i))
    except StepError as e:
        if e.step_result is not None:
            results.append(e.step_result)
        return {
            "ok": False,
            "steps": results,
            "failed_at": e.step,
            "error": e.message,
            "error_code": e.code,
            "conflicts": e.conflicts,
            "assembly": state.assembly_state(),
        }
    return {
        "ok": True,
        "steps": results,
        "failed_at": None,
        "error": None,
        "error_code": None,
        "conflicts": [],
        "assembly": state.assembly_state(),
    }
