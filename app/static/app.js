/* 陶片拼接系统前端：Canvas 二维视图 + 录入 + 拼接 */
'use strict';

// ---------------------------------------------------------------- 状态
const S = {
  version: 0,
  fragments: [],
  groups: [],
  relations: [],
  mode: 'view',                       // view | draw | relate | rehearse
  cam: { scale: 6, ox: 0, oy: 0 },    // 像素/毫米 + 原点偏移
  draw: { name: '', points: [] },
  relate: { aId: null, bId: null, markersA: [], markersB: [], preview: null },
  rehearse: {
    steps: [],                        // {action, relation_id|fragment_a,...}
    result: null,                     // /api/rehearsal/preview 响应
    editor: null,                     // 正在编辑的步骤序号（null=追加新步）
  },
  camInit: false,
};

const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
                 '#42a4f4', '#f032e6', '#9acd32', '#469990', '#9A6324'];
const groupColor = gid => gid == null ? '#a89f93' : PALETTE[gid % PALETTE.length];

const $ = sel => document.querySelector(sel);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');

// ---------------------------------------------------------------- API
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('api error');
    err.status = res.status;
    err.detail = data.detail;
    throw err;
  }
  return data;
}

function detailText(detail) {
  if (!detail) return '请求失败';
  if (typeof detail === 'string') return detail;
  if (detail.conflicts && detail.conflicts.length)
    return detail.message + '：' + detail.conflicts.join('；');
  return detail.message || JSON.stringify(detail);
}

let msgTimer = null;
function setMessage(text, kind = 'ok') {
  const el = $('#message');
  el.textContent = text;
  el.className = kind;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.textContent = ''; }, 8000);
}

async function loadAssembly() {
  const data = await api('/api/assembly');
  S.version = data.version;
  S.fragments = data.fragments;
  S.groups = data.groups;
  S.relations = data.relations;
  $('#versionBadge').textContent = `版本 v${S.version}`;
  renderPanel();
  renderMain();
}

function handleConflict(err) {
  setMessage(detailText(err.detail), 'err');
  if (S.mode === 'rehearse') { S.rehearse.result = null; S.rehearse.editor = null; }
  loadAssembly();   // 版本冲突：刷新到最新状态
}

// ---------------------------------------------------------------- 坐标变换
function toScreen(x, y) { return [x * S.cam.scale + S.cam.ox, -y * S.cam.scale + S.cam.oy]; }
function toWorld(px, py) { return [(px - S.cam.ox) / S.cam.scale, -(py - S.cam.oy) / S.cam.scale]; }

function applyPose(p, f) {
  const c = Math.cos(f.theta), s = Math.sin(f.theta);
  return [c * p[0] - s * p[1] + f.x, s * p[0] + c * p[1] + f.y];
}
const worldContour = f => f.contour.map(p => applyPose(p, f));

function drawRelationsMarkers(rels, byId) {
  for (const r of rels) {
    const fa = byId[r.fragment_a], fb = byId[r.fragment_b];
    if (!fa || !fb) continue;
    r.markers_a.forEach((m, i) => {
      drawMarkerPair(applyPose(m, fa), applyPose(r.markers_b[i], fb), i);
    });
  }
}

function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

// ---------------------------------------------------------------- 主画布
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!S.camInit && w > 0) {
    S.cam.ox = w / 2; S.cam.oy = h / 2; S.camInit = true;
  }
  return [w, h];
}

function drawGrid(w, h) {
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  let step = steps.find(s => s * S.cam.scale >= 30) || 1000;
  const labelEvery = Math.ceil(50 / (step * S.cam.scale));
  const [x0, yA] = toWorld(0, 0), [x1, yB] = toWorld(w, h);
  const yMin = Math.min(yA, yB), yMax = Math.max(yA, yB);
  ctx.lineWidth = 1;
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#9a8f7d';
  let i = Math.floor(x0 / step);
  for (let x = i * step; x <= x1; x += step, i++) {
    const [sx] = toScreen(x, 0);
    ctx.strokeStyle = i % 5 === 0 ? '#d8cfbc' : '#ece5d5';
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
    if (i % labelEvery === 0) ctx.fillText(`${+x.toFixed(1)}`, sx + 2, h - 4);
  }
  let j = Math.floor(yMin / step);
  for (let y = j * step; y <= yMax; y += step, j++) {
    const [, sy] = toScreen(0, y);
    ctx.strokeStyle = j % 5 === 0 ? '#d8cfbc' : '#ece5d5';
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
    if (j % labelEvery === 0) ctx.fillText(`${+y.toFixed(1)}`, 2, sy - 2);
  }
}

function pathOf(pts) {
  const p = new Path2D();
  pts.forEach((pt, i) => {
    const [sx, sy] = toScreen(pt[0], pt[1]);
    i === 0 ? p.moveTo(sx, sy) : p.lineTo(sx, sy);
  });
  p.closePath();
  return p;
}

function drawFragment(f, opts = {}) {
  const wc = opts.contour || worldContour(f);
  const color = opts.color || groupColor(f.group_id);
  const path = pathOf(wc);
  ctx.globalAlpha = opts.faint ? 0.25 : 1;
  ctx.fillStyle = color + '55';
  ctx.fill(path);
  ctx.strokeStyle = opts.highlight ? '#d35400' : color;
  ctx.lineWidth = opts.highlight ? 2.5 : 1.5;
  ctx.stroke(path);
  const [cx, cy] = centroid(wc);
  const [sx, sy] = toScreen(cx, cy);
  ctx.fillStyle = '#4a3f30';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(f.name || opts.name || '', sx, sy);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
}

function drawMarkerPair(wa, wb, idx, errText) {
  const [ax, ay] = toScreen(wa[0], wa[1]);
  const [bx, by] = toScreen(wb[0], wb[1]);
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = '#c0392b';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#c0392b';
  ctx.beginPath(); ctx.arc(ax, ay, 4, 0, 7); ctx.fill();
  ctx.strokeStyle = '#c0392b';
  ctx.beginPath(); ctx.arc(bx, by, 4, 0, 7); ctx.stroke();
  ctx.fillStyle = '#c0392b';
  ctx.font = '10px sans-serif';
  ctx.fillText(`#${idx + 1}${errText || ''}`, (ax + bx) / 2 + 5, (ay + by) / 2 - 4);
}

function renderMain() {
  const [w, h] = resizeCanvas();
  ctx.clearRect(0, 0, w, h);
  drawGrid(w, h);

  // 试拼编排预演：成功 → 叠加展示推演终态；失败 → 展示冲突步的放置
  if (S.mode === 'rehearse') {
    const R = S.rehearse;
    if (R.result && R.result.ok) {
      const sim = {};
      for (const f of R.result.assembly.fragments) {
        const color = f.group_id == null ? '#a89f93'
          : PALETTE[f.group_id % PALETTE.length];
        drawFragment({ id: f.id, name: f.name, group_id: f.group_id, contour: [] },
          { contour: worldContour(f), color, highlight: true, name: f.name });
        sim[f.id] = f;
      }
      drawRelationsMarkers(R.result.assembly.relations.filter(r => r.active), sim);
      return;
    }
    if (R.result && R.result.failed_at != null) {
      for (const f of S.fragments) drawFragment(f, { faint: true });
      const failed = R.result.steps[R.result.failed_at];
      if (failed && failed.placements && failed.placements.length) {
        for (const pl of failed.placements) {
          drawFragment({ id: pl.fragment_id, name: pl.name, group_id: 1, contour: [] },
            { contour: pl.contour_world, highlight: true, color: '#c0392b', name: pl.name });
        }
      }
      return;
    }
    for (const f of S.fragments) drawFragment(f);
    return;
  }

  const pv = S.mode === 'relate' ? S.relate.preview : null;
  const pvIds = pv ? new Set(pv.placements.map(p => p.fragment_id)) : new Set();

  for (const f of S.fragments) {
    if (pvIds.has(f.id)) continue;
    drawFragment(f, { faint: S.mode === 'draw' });
  }

  // 预览：仅平移+旋转后的组合
  if (pv) {
    for (const pl of pv.placements) {
      drawFragment({ id: pl.fragment_id, name: pl.name, group_id: 1, contour: [] },
                   { contour: pl.contour_world, highlight: true, color: pv.ok ? '#2e86c1' : '#c0392b', name: pl.name });
    }
    if (pv.markers_world) {
      pv.markers_world.a.forEach((wa, i) => {
        const wb = pv.markers_world.b[i];
        const err = pv.errors[i] != null ? ` ${pv.errors[i].toFixed(2)}mm` : '';
        drawMarkerPair(wa, wb, i, err);
      });
    }
  }

  // 已有关系的标记（查看模式 / 试拼终态）
  if (S.mode === 'view') {
    drawRelationsMarkers(S.relations.filter(r => r.active),
      Object.fromEntries(S.fragments.map(f => [f.id, f])));
  }

  // 录入中的多边形
  if (S.mode === 'draw' && S.draw.points.length) {
    const pts = S.draw.points;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const [sx, sy] = toScreen(p[0], p[1]);
      i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
    });
    ctx.strokeStyle = '#c89b5a'; ctx.lineWidth = 2; ctx.stroke();
    pts.forEach((p, i) => {
      const [sx, sy] = toScreen(p[0], p[1]);
      ctx.fillStyle = '#c89b5a';
      ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, 7); ctx.fill();
      ctx.fillStyle = '#6b5433'; ctx.font = '10px sans-serif';
      ctx.fillText(`${i + 1}`, sx + 5, sy - 5);
    });
  }
}

// ---------------------------------------------------------------- 侧栏面板
const fragById = id => S.fragments.find(f => f.id === id);
const fmt = (v, n = 2) => (+v).toFixed(n);
const deg = r => (r * 180 / Math.PI).toFixed(2);

function renderPanel() {
  const el = $('#panel');
  if (S.mode === 'view') el.innerHTML = viewPanelHTML();
  else if (S.mode === 'draw') el.innerHTML = drawPanelHTML();
  else if (S.mode === 'rehearse') el.innerHTML = rehearsePanelHTML();
  else el.innerHTML = relatePanelHTML();
  bindPanelEvents();
  if (S.mode === 'relate') drawMinis();
  if (S.mode === 'rehearse') drawRehearseMinis();
  $('#hint').textContent = {
    view: '拖拽平移 · 滚轮缩放 · 单位：毫米',
    draw: '单击画布添加顶点（≥3 个）· 拖拽平移 · 滚轮缩放 · 保存时自动闭合',
    relate: '在左侧两个小图中点击轮廓边缘放置对应标记（每片 ≥2 处、数量一致），然后预览/采纳',
    rehearse: '编排非空有序操作序列：撤销现存关系或以两片陶片+成对标记建立关系；预演不落库，确认整体提交',
  }[S.mode];
}

function viewPanelHTML() {
  const active = S.relations.filter(r => r.active);
  const undone = S.relations.filter(r => !r.active);
  const fragCards = S.fragments.map(f => `
    <div class="card">
      <div class="row">
        <span><span class="dot" style="background:${groupColor(f.group_id)}"></span><b>#${f.id} ${esc(f.name)}</b></span>
        <span class="spacer"></span>
        <button class="act danger" data-del-frag="${f.id}">删除</button>
      </div>
      <div class="sub">${f.group_id == null ? '独立碎片' : `拼接组 G${f.group_id}`} ·
        位置 (${fmt(f.x)}, ${fmt(f.y)}) mm · 角度 ${deg(f.theta)}° · ${f.contour.length} 顶点</div>
    </div>`).join('') || '<div class="small">暂无碎片，请切换到「录入碎片」。</div>';
  const relCards = active.map(r => `
    <div class="card">
      <div class="row">
        <span><b>#${r.id}</b> ${esc(fragById(r.fragment_a)?.name || '?')} ↔ ${esc(fragById(r.fragment_b)?.name || '?')}</span>
        <span class="spacer"></span>
        <button class="act" data-undo="${r.id}">撤销</button>
      </div>
      <div class="sub">${r.markers_a.length} 对标记 · 最大误差 ${fmt(r.max_error, 3)} mm · ${r.created_at.slice(0, 19)}</div>
    </div>`).join('') || '<div class="small">暂无有效拼接关系。</div>';
  const undoneCards = undone.map(r => `
    <div class="card undone"><b>#${r.id}</b> ${esc(fragById(r.fragment_a)?.name || r.fragment_a)} ↔
      ${esc(fragById(r.fragment_b)?.name || r.fragment_b)} <span class="sub">已撤销</span></div>`).join('');
  return `
    <h2>碎片（${S.fragments.length}）</h2>${fragCards}
    <h2>拼接关系（${active.length}）</h2>${relCards}
    ${undone ? `<h2>已撤销（${undone.length}）</h2>${undoneCards}` : ''}`;
}

function drawPanelHTML() {
  const pts = S.draw.points.map((p, i) =>
    `<div class="small mono">${i + 1}. (${fmt(p[0])}, ${fmt(p[1])})</div>`).join('');
  return `
    <h2>录入碎片</h2>
    <label class="lab">名称</label>
    <input type="text" id="fragName" value="${esc(S.draw.name)}" placeholder="如：陶片E-口沿">
    <label class="lab">顶点（毫米，${S.draw.points.length} 个）</label>
    <div style="max-height:180px;overflow:auto">${pts || '<div class="small">在主画布上单击添加顶点</div>'}</div>
    <div class="row" style="margin-top:8px">
      <button class="act" id="undoPt" ${S.draw.points.length ? '' : 'disabled'}>撤销顶点</button>
      <button class="act" id="clearPts" ${S.draw.points.length ? '' : 'disabled'}>清空</button>
    </div>
    <div class="row" style="margin-top:6px">
      <button class="act primary" id="saveFrag" ${S.draw.points.length >= 3 ? '' : 'disabled'}>保存碎片</button>
      <button class="act" id="cancelDraw">取消</button>
    </div>
    <h2>或粘贴坐标 JSON</h2>
    <textarea id="jsonPts" rows="4" placeholder='[[0,0],[50,0],[50,40],[0,40]]'></textarea>
    <div class="row" style="margin-top:6px"><button class="act" id="loadJson">载入坐标</button></div>`;
}

function relatePanelHTML() {
  const R = S.relate;
  const opts = sel => S.fragments.map(f =>
    `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>#${f.id} ${esc(f.name)}</option>`).join('');
  const pv = R.preview;
  let pvHTML = '';
  if (pv) {
    const typeName = { new_group: '新建拼接组', join: '加入已有组', merge: '合并两个组', loop: '闭环校验' }[pv.relation_type] || '-';
    const rows = pv.placements.map(p =>
      `<tr><td>${esc(p.name)}</td><td>${fmt(p.x)}</td><td>${fmt(p.y)}</td><td>${fmt(p.theta_deg)}</td></tr>`).join('');
    const errs = pv.errors.map((e, i) =>
      `<tr><td>第 ${i + 1} 对</td><td>${fmt(e, 3)} mm</td><td>${e <= 1 ? '✓' : '✗ 超限'}</td></tr>`).join('');
    pvHTML = `
      <h2>预览结果（${typeName}）</h2>
      ${pv.ok
        ? '<div class="okbox">✓ 校验通过：对应点误差均 ≤ 1 mm，轮廓无内部重叠，可采纳。</div>'
        : `<div class="conflicts"><b>存在冲突，采纳将被拒绝：</b><ul>${pv.conflicts.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>`}
      <table class="info"><tr><th>碎片</th><th>x (mm)</th><th>y (mm)</th><th>角度 (°)</th></tr>${rows}</table>
      ${errs ? `<table class="info"><tr><th>对应点</th><th>误差</th><th>判定</th></tr>${errs}</table>` : ''}`;
  }
  const canAct = R.markersA.length >= 2 && R.markersA.length === R.markersB.length && R.aId && R.bId;
  return `
    <h2>新建拼接</h2>
    <label class="lab">碎片甲</label><select id="selA">${opts(R.aId)}</select>
    <canvas class="mini" id="miniA"></canvas>
    <div class="row"><span class="small">标记 ${R.markersA.length} 处</span><span class="spacer"></span>
      <button class="act" id="undoA" ${R.markersA.length ? '' : 'disabled'}>撤销标记</button></div>
    <label class="lab">碎片乙</label><select id="selB">${opts(R.bId)}</select>
    <canvas class="mini" id="miniB"></canvas>
    <div class="row"><span class="small">标记 ${R.markersB.length} 处</span><span class="spacer"></span>
      <button class="act" id="undoB" ${R.markersB.length ? '' : 'disabled'}>撤销标记</button></div>
    <div class="row" style="margin-top:10px">
      <button class="act" id="btnPreview" ${canAct ? '' : 'disabled'}>预 览</button>
      <button class="act primary" id="btnAccept" ${canAct ? '' : 'disabled'}>采 纳</button>
      <button class="act" id="btnClearMarkers">清空标记</button>
    </div>
    <div class="small" style="margin-top:4px">需每片 ≥2 处标记且数量一致；按序号一一对应。</div>
    ${pvHTML}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------ 试拼编排面板
function rehearseStepHTML(st, i) {
  const R = S.rehearse;
  let head, body = '';
  if (st.action === 'undo') {
    const r = S.relations.find(x => x.id === st.relation_id);
    const name = r
      ? `${esc(fragById(r.fragment_a)?.name || r.fragment_a)} ↔ ${esc(fragById(r.fragment_b)?.name || r.fragment_b)}`
      : `#${st.relation_id}`;
    head = `撤销关系 #${st.relation_id}（${name}）`;
  } else {
    head = `建立关系：#${st.fragment_a} ↔ #${st.fragment_b}（${st.markers_a.length} 对标记）`;
  }
  if (R.result && R.result.steps[i]) {
    const sr = R.result.steps[i];
    if (sr.ok) {
      if (sr.action === 'create') {
        const tn = { new_group: '新建组', join: '加入组', merge: '合并组', loop: '闭环' }[sr.relation_type] || '';
        body = `<div class="sub">✓ ${tn} · 最大误差 ${fmt(sr.max_error_mm ?? 0, 3)} mm · 步后分组 ${groupsText(sr.groups)}</div>`;
      } else {
        body = `<div class="sub">✓ 已撤销 · 步后分组 ${groupsText(sr.groups)}</div>`;
      }
    } else {
      body = `<div class="sub" style="color:#a02020">✗ ${esc((sr.conflicts || []).join('；') || '失败')}</div>`;
    }
  }
  const failed = R.result && R.result.failed_at === i ? ' failed' : '';
  return `
    <div class="card step${failed}">
      <div class="row">
        <span class="stepno">${i + 1}</span>
        <span style="flex:1">${head}</span>
        <button class="act" data-rh-edit="${i}">编辑</button>
        <button class="act danger" data-rh-del="${i}">删除</button>
      </div>${body}
    </div>`;
}

function groupsText(groups) {
  if (!groups || !groups.length) return '全部孤片';
  return groups.map(g => `{${g.fragment_ids.join(',')}}`).join(' ');
}

function rehearseComposerHTML() {
  const R = S.rehearse;
  const cp = R.cp;
  const opts = sel => S.fragments.map(f =>
    `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>#${f.id} ${esc(f.name)}</option>`).join('');
  const undoOpts = S.relations.filter(r => r.active).map(r =>
    `<option value="${r.id}" ${r.id === cp.undoId ? 'selected' : ''}>#${r.id} ${esc(fragById(r.fragment_a)?.name || r.fragment_a)} ↔ ${esc(fragById(r.fragment_b)?.name || r.fragment_b)}</option>`).join('');
  return `
    <h2>添加步骤（${R.editor == null ? '追加到序列末尾' : `编辑第 ${R.editor + 1} 步`}）</h2>
    <div class="row">
      <button class="act ${cp.kind === 'undo' ? 'primary' : ''}" data-rh-kind="undo">撤销关系</button>
      <button class="act ${cp.kind === 'create' ? 'primary' : ''}" data-rh-kind="create">建立关系</button>
    </div>
    ${cp.kind === 'undo' ? `
      <label class="lab">现存有效关系</label>
      <select id="rhUndo">${undoOpts || '<option value="">（暂无有效关系）</option>'}</select>
    ` : `
      <label class="lab">碎片甲</label><select id="rhA">${opts(cp.aId)}</select>
      <canvas class="mini" id="rhMiniA"></canvas>
      <div class="row"><span class="small">标记 ${cp.markersA.length} 处</span><span class="spacer"></span>
        <button class="act" id="rhUndoA" ${cp.markersA.length ? '' : 'disabled'}>撤销标记</button></div>
      <label class="lab">碎片乙</label><select id="rhB">${opts(cp.bId)}</select>
      <canvas class="mini" id="rhMiniB"></canvas>
      <div class="row"><span class="small">标记 ${cp.markersB.length} 处</span><span class="spacer"></span>
        <button class="act" id="rhUndoB" ${cp.markersB.length ? '' : 'disabled'}>撤销标记</button></div>
    `}
    <div class="row" style="margin-top:8px">
      <button class="act primary" id="rhApplyStep">${R.editor == null ? '加入序列' : '保存修改'}</button>
      ${R.editor != null ? '<button class="act" id="rhCancelEdit">取消编辑</button>' : ''}
    </div>`;
}

function rehearseFinalHTML() {
  const R = S.rehearse;
  const res = R.result;
  if (!res) return '';
  if (!res.ok) {
    return `
      <h2>试拼结果</h2>
      <div class="conflicts"><b>第 ${res.failed_at + 1} 步失败，推演已停止（不落库）：</b>
        <div style="margin-top:4px">${esc(res.error)}</div></div>`;
  }
  const rows = res.assembly.fragments.map(f =>
    `<tr><td>${esc(f.name)}</td><td>${f.group_id == null ? '孤片' : 'G' + f.group_id}</td>
     <td>${fmt(f.x)}</td><td>${fmt(f.y)}</td><td>${deg(f.theta)}°</td></tr>`).join('');
  return `
    <h2>试拼结果（${res.steps.length} 步全部通过）</h2>
    <div class="okbox">✓ 预演只读，数据未修改。确认后按当前版本 v${res.base_version}
      整体提交，成功仅递增至 v${res.final_version_preview}。</div>
    <table class="info"><tr><th>碎片</th><th>分组</th><th>x</th><th>y</th><th>角度</th></tr>${rows}</table>
    <div class="row"><button class="act primary" id="rhCommit">确认整段试拼（${res.steps.length} 步）</button></div>`;
}

function rehearsePanelHTML() {
  const R = S.rehearse;
  const cards = R.steps.map((st, i) => rehearseStepHTML(st, i)).join('')
    || '<div class="small">序列为空：在下方添加第一步（撤销或建立关系）。</div>';
  return `
    <h2>试拼编排（基于 v${S.version}）</h2>
    <div class="row">
      <button class="act primary" id="rhPreview" ${R.steps.length ? '' : 'disabled'}>预 演</button>
      <button class="act" id="rhClear" ${R.steps.length ? '' : 'disabled'}>清空序列</button>
    </div>
    <h2>有序步骤（${R.steps.length}）</h2>${cards}
    ${rehearseComposerHTML()}
    ${rehearseFinalHTML()}`;
}

// ------------------------------------------------------------ 试拼面板事件

// ---------------------------------------------------------------- 面板事件
function bindPanelEvents() {
  document.querySelectorAll('[data-del-frag]').forEach(b => b.onclick = () => deleteFragment(+b.dataset.delFrag));
  document.querySelectorAll('[data-undo]').forEach(b => b.onclick = () => undoRelation(+b.dataset.undo));

  if (S.mode === 'draw') {
    $('#fragName').oninput = e => { S.draw.name = e.target.value; };
    $('#undoPt').onclick = () => { S.draw.points.pop(); renderPanel(); renderMain(); };
    $('#clearPts').onclick = () => { S.draw.points = []; renderPanel(); renderMain(); };
    $('#cancelDraw').onclick = () => switchMode('view');
    $('#saveFrag').onclick = saveFragment;
    $('#loadJson').onclick = () => {
      try {
        const arr = JSON.parse($('#jsonPts').value);
        if (!Array.isArray(arr) || arr.some(p => !Array.isArray(p) || p.length < 2)) throw 0;
        S.draw.points = arr.map(p => [+p[0], +p[1]]);
        renderPanel(); renderMain();
      } catch { setMessage('坐标 JSON 格式不正确', 'err'); }
    };
  }

  if (S.mode === 'relate') {
    const R = S.relate;
    $('#selA').onchange = e => { R.aId = +e.target.value; R.markersA = []; R.preview = null; renderPanel(); renderMain(); };
    $('#selB').onchange = e => { R.bId = +e.target.value; R.markersB = []; R.preview = null; renderPanel(); renderMain(); };
    $('#undoA').onclick = () => { R.markersA.pop(); R.preview = null; renderPanel(); renderMain(); };
    $('#undoB').onclick = () => { R.markersB.pop(); R.preview = null; renderPanel(); renderMain(); };
    $('#btnClearMarkers').onclick = () => { R.markersA = []; R.markersB = []; R.preview = null; renderPanel(); renderMain(); };
    $('#btnPreview').onclick = doPreview;
    $('#btnAccept').onclick = doAccept;
    bindMini($('#miniA'), 'A');
    bindMini($('#miniB'), 'B');
  }

  if (S.mode === 'rehearse') bindRehearseEvents();
}

// ---------------------------------------------------------------- 业务动作
async function saveFragment() {
  const name = S.draw.name.trim() || `碎片${Date.now() % 10000}`;
  try {
    await api('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ name, contour: S.draw.points }),
    });
    setMessage(`碎片「${name}」已保存`);
    S.draw = { name: '', points: [] };
    await loadAssembly();
    switchMode('view');
  } catch (err) {
    setMessage(detailText(err.detail), 'err');   // 轮廓自交等：整次拒绝
  }
}

async function doPreview() {
  const R = S.relate;
  try {
    R.preview = await api('/api/relations/preview', {
      method: 'POST',
      body: JSON.stringify({
        fragment_a: R.aId, fragment_b: R.bId,
        markers_a: R.markersA, markers_b: R.markersB,
      }),
    });
    renderPanel(); renderMain();
  } catch (err) {
    setMessage(detailText(err.detail), 'err');
  }
}

async function doAccept() {
  const R = S.relate;
  try {
    const res = await api('/api/relations', {
      method: 'POST',
      body: JSON.stringify({
        fragment_a: R.aId, fragment_b: R.bId,
        markers_a: R.markersA, markers_b: R.markersB,
        expected_version: S.version,
      }),
    });
    setMessage(`拼接 #${res.relation_id} 已采纳`);
    S.relate = { aId: null, bId: null, markersA: [], markersB: [], preview: null };
    applyAssembly(res.assembly);
    switchMode('view');
  } catch (err) {
    if (err.status === 409) return handleConflict(err);          // 过期版本
    if (err.detail && err.detail.conflicts) {                    // 校验拒绝：展示冲突
      R.preview = { ok: false, relation_type: null, conflicts: err.detail.conflicts,
                    errors: [], placements: [], markers_world: null };
      renderPanel(); renderMain();
    }
    setMessage(detailText(err.detail), 'err');
  }
}

async function undoRelation(rid) {
  try {
    const res = await api(`/api/relations/${rid}/undo`, {
      method: 'POST',
      body: JSON.stringify({ expected_version: S.version }),
    });
    setMessage(`拼接关系 #${rid} 已撤销，连通组已重算`);
    applyAssembly(res.assembly);
  } catch (err) {
    if (err.status === 409) return handleConflict(err);
    setMessage(detailText(err.detail), 'err');
  }
}

async function deleteFragment(fid) {
  const f = fragById(fid);
  if (!confirm(`确认删除碎片「${f?.name}」？其相关拼接关系将一并移除。`)) return;
  try {
    const res = await api(`/api/fragments/${fid}?expected_version=${S.version}`, { method: 'DELETE' });
    setMessage(`碎片「${f?.name}」已删除`);
    applyAssembly(res.assembly);
  } catch (err) {
    if (err.status === 409) return handleConflict(err);
    setMessage(detailText(err.detail), 'err');
  }
}

function applyAssembly(a) {
  S.version = a.version;
  S.fragments = a.fragments;
  S.groups = a.groups;
  S.relations = a.relations;
  $('#versionBadge').textContent = `版本 v${S.version}`;
  renderPanel(); renderMain();
}

// ---------------------------------------------------------------- 试拼编排
function defaultCreateComposer() {
  return {
    kind: 'create',
    aId: S.fragments[0]?.id ?? null,
    bId: S.fragments[1]?.id ?? null,
    markersA: [], markersB: [],
  };
}

function resetComposer(kind = 'create') {
  const R = S.rehearse;
  const undoId = S.relations.find(r => r.active)?.id ?? null;
  R.cp = { ...defaultCreateComposer(), kind, undoId };
}

function bindRehearseEvents() {
  const R = S.rehearse;
  if (!R.cp) resetComposer();

  document.querySelectorAll('[data-rh-del]').forEach(b => b.onclick = () => {
    R.steps.splice(+b.dataset.rhDel, 1);
    R.result = null;
    if (R.editor === +b.dataset.rhDel) R.editor = null;
    renderPanel(); renderMain();
  });
  document.querySelectorAll('[data-rh-edit]').forEach(b => b.onclick = () => {
    const i = +b.dataset.rhEdit;
    const st = R.steps[i];
    R.editor = i;
    if (st.action === 'undo') R.cp = { ...defaultCreateComposer(), kind: 'undo', undoId: st.relation_id };
    else R.cp = { kind: 'create', aId: st.fragment_a, bId: st.fragment_b,
                  markersA: st.markers_a.map(p => [...p]), markersB: st.markers_b.map(p => [...p]) };
    renderPanel();
  });
  document.querySelectorAll('[data-rh-kind]').forEach(b => b.onclick = () => {
    resetComposer(b.dataset.rhKind);
    renderPanel();
  });

  $('#rhClear').onclick = () => {
    R.steps = []; R.result = null; R.editor = null;
    resetComposer();
    renderPanel(); renderMain();
  };
  $('#rhPreview').onclick = doRehearsePreview;

  const cp = R.cp;
  if (cp.kind === 'undo') {
    $('#rhUndo').onchange = e => { cp.undoId = +e.target.value; };
  } else {
    $('#rhA').onchange = e => { cp.aId = +e.target.value; cp.markersA = []; renderPanel(); };
    $('#rhB').onchange = e => { cp.bId = +e.target.value; cp.markersB = []; renderPanel(); };
    $('#rhUndoA').onclick = () => { cp.markersA.pop(); renderPanel(); };
    $('#rhUndoB').onclick = () => { cp.markersB.pop(); renderPanel(); };
    bindMiniCanvas($('#rhMiniA'), 'A', cp, () => fragById(cp.aId),
      () => { renderPanel(); renderMain(); });
    bindMiniCanvas($('#rhMiniB'), 'B', cp, () => fragById(cp.bId),
      () => { renderPanel(); renderMain(); });
  }

  $('#rhApplyStep').onclick = () => {
    let step;
    if (cp.kind === 'undo') {
      if (cp.undoId == null) return setMessage('当前没有可撤销的有效关系', 'err');
      step = { action: 'undo', relation_id: cp.undoId };
    } else {
      if (cp.aId === cp.bId) return setMessage('不能与同一片陶片建立关系', 'err');
      if (cp.markersA.length < 2 || cp.markersA.length !== cp.markersB.length)
        return setMessage('每片需 ≥2 处标记且数量一致', 'err');
      step = { action: 'create', fragment_a: cp.aId, fragment_b: cp.bId,
               markers_a: cp.markersA, markers_b: cp.markersB };
    }
    if (R.editor == null) R.steps.push(step);
    else R.steps[R.editor] = step;
    R.editor = null;
    R.result = null;
    resetComposer();
    renderPanel(); renderMain();
  };
  const cancel = $('#rhCancelEdit');
  if (cancel) cancel.onclick = () => { R.editor = null; resetComposer(); renderPanel(); };

  const commitBtn = $('#rhCommit');
  if (commitBtn) commitBtn.onclick = doRehearseCommit;
}

async function doRehearsePreview() {
  const R = S.rehearse;
  try {
    R.result = await api('/api/rehearsal/preview', {
      method: 'POST',
      body: JSON.stringify({ expected_version: S.version, steps: R.steps }),
    });
    renderPanel(); renderMain();
    if (R.result.ok) setMessage(`试拼预演通过：共 ${R.result.steps.length} 步（只读，未落库）`);
    else setMessage(R.result.error, 'err');
  } catch (err) {
    if (err.status === 409) return handleConflict(err);
    setMessage(detailText(err.detail), 'err');
  }
}

async function doRehearseCommit() {
  const R = S.rehearse;
  if (!confirm(`确认按 v${S.version} 整体提交这 ${R.steps.length} 步试拼？`
      + '\n任一步失败或版本过期均不会写入；成功后版本仅递增一次。')) return;
  try {
    const res = await api('/api/rehearsal/commit', {
      method: 'POST',
      body: JSON.stringify({ expected_version: S.version, steps: R.steps }),
    });
    setMessage(`试拼已整体确认（${res.committed_steps} 步），版本升至 v${res.version}`);
    R.steps = []; R.result = null; R.editor = null;
    applyAssembly(res.assembly);
    switchMode('view');
  } catch (err) {
    if (err.status === 409) return handleConflict(err);
    const d = err.detail || {};
    if (d.failed_at != null) {
      R.result = {
        ok: false, failed_at: d.failed_at,
        error: d.error || detailText(d), conflicts: d.conflicts || [],
        steps: R.result?.steps || [],
      };
      renderPanel(); renderMain();
    }
    setMessage(detailText(d), 'err');
  }
}

// ---------------------------------------------------------------- 小图（局部坐标 + 标记捕捉）
function fitTransform(contour, w, h, margin = 18) {
  const xs = contour.map(p => p[0]), ys = contour.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min((w - 2 * margin) / Math.max(maxX - minX, 1e-6),
                     (h - 2 * margin) / Math.max(maxY - minY, 1e-6));
  return {
    s,
    ox: (w - s * (maxX - minX)) / 2 - s * minX,
    oy: (h - s * (maxY - minY)) / 2 + s * maxY,
  };
}

function projectOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

function snapToContour(p, contour) {
  let best = null, bd = Infinity;
  for (let i = 0; i < contour.length; i++) {
    const q = projectOnSegment(p, contour[i], contour[(i + 1) % contour.length]);
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

function drawMini(cv, frag, markers) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  if (!frag) { c.fillStyle = '#999'; c.fillText('请选择碎片', 10, 20); return null; }
  const t = fitTransform(frag.contour, w, h);
  const path = new Path2D();
  frag.contour.forEach((p, i) => {
    const sx = p[0] * t.s + t.ox, sy = -p[1] * t.s + t.oy;
    i === 0 ? path.moveTo(sx, sy) : path.lineTo(sx, sy);
  });
  path.closePath();
  c.fillStyle = '#c89b5a33'; c.fill(path);
  c.strokeStyle = '#8a6d3b'; c.lineWidth = 1.5; c.stroke(path);
  markers.forEach((m, i) => {
    const sx = m[0] * t.s + t.ox, sy = -m[1] * t.s + t.oy;
    c.fillStyle = '#c0392b';
    c.beginPath(); c.arc(sx, sy, 4, 0, 7); c.fill();
    c.fillStyle = '#7b241c'; c.font = '10px sans-serif';
    c.fillText(`${i + 1}`, sx + 6, sy - 4);
  });
  return t;
}

function drawMinis() {
  const R = S.relate;
  const tA = drawMini($('#miniA'), fragById(R.aId), R.markersA);
  const tB = drawMini($('#miniB'), fragById(R.bId), R.markersB);
  $('#miniA')._t = tA; $('#miniB')._t = tB;
}

function bindMini(cv, side) {
  bindMiniCanvas(cv, side === 'A' ? 'A' : 'B', S.relate,
    fragById(side === 'A' ? S.relate.aId : S.relate.bId),
    () => { S.relate.preview = null; renderPanel(); renderMain(); });
}

function bindMiniCanvas(cv, side, store, getFrag, onChange) {
  cv.onclick = e => {
    const frag = getFrag();
    const t = cv._t;
    if (!frag || !t) return;
    const rect = cv.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const local = [(px - t.ox) / t.s, -(py - t.oy) / t.s];
    const snapped = snapToContour(local, frag.contour);   // 边缘标记：吸附到轮廓
    (side === 'A' ? store.markersA : store.markersB).push(snapped);
    onChange();
  };
}

function drawRehearseMinis() {
  const R = S.rehearse;
  if (R.cp.kind !== 'create') return;
  const tA = drawMini($('#rhMiniA'), fragById(R.cp.aId), R.cp.markersA);
  const tB = drawMini($('#rhMiniB'), fragById(R.cp.bId), R.cp.markersB);
  $('#rhMiniA')._t = tA; $('#rhMiniB')._t = tB;
}

// ---------------------------------------------------------------- 主画布交互
let drag = null;
canvas.addEventListener('mousedown', e => {
  drag = { x: e.offsetX, y: e.offsetY, moved: false };
});
canvas.addEventListener('mousemove', e => {
  if (!drag) return;
  const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.moved) {
    S.cam.ox += dx; S.cam.oy += dy;
    drag.x = e.offsetX; drag.y = e.offsetY;
    renderMain();
  }
});
canvas.addEventListener('mouseup', e => {
  const wasClick = drag && !drag.moved;
  drag = null;
  if (wasClick && S.mode === 'draw') {
    S.draw.points.push(toWorld(e.offsetX, e.offsetY).map(v => +v.toFixed(3)));
    renderPanel(); renderMain();
  }
});
canvas.addEventListener('mouseleave', () => { drag = null; });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const [wx, wy] = toWorld(e.offsetX, e.offsetY);
  S.cam.scale = Math.min(200, Math.max(0.2, S.cam.scale * k));
  S.cam.ox = e.offsetX - wx * S.cam.scale;
  S.cam.oy = e.offsetY + wy * S.cam.scale;
  renderMain();
}, { passive: false });

// ---------------------------------------------------------------- 模式切换
function switchMode(mode) {
  S.mode = mode;
  document.querySelectorAll('.mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  if (mode === 'relate' && S.relate.aId == null && S.fragments.length >= 2) {
    S.relate.aId = S.fragments[0].id;
    S.relate.bId = S.fragments[1].id;
  }
  if (mode === 'rehearse' && !S.rehearse.cp) resetComposer('create');
  renderPanel(); renderMain();
}
document.querySelectorAll('.mode-btn').forEach(b =>
  b.addEventListener('click', () => switchMode(b.dataset.mode)));

window.addEventListener('resize', renderMain);

// ---------------------------------------------------------------- 启动
loadAssembly().catch(err => setMessage('加载失败：' + detailText(err.detail), 'err'));
