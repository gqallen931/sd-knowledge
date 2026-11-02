// @ts-nocheck
/* 来源：agent-display-main（OPS 纸面工程主题，PolyForm-Noncommercial-1.0.0）。
   本文件为逐字移植 + 生命周期补丁，请勿在此处改视觉逻辑；
   视觉改动用 ops.template.html 里的 CSS 变量完成。 */
export function mountOps(host, SR){
'use strict';

/* 嵌入适配层：React 卸载宿主后必须能停掉 7 个定时器、rAF、3 个观察者与 2 个全局监听。
   原文件是「一次挂载、永不卸载」的单页，这里只补生命周期，不改任何视觉逻辑。 */
const __timers = [];
const __disposed = [];
let __dead = false;
const __iv = (fn, ms) => { const id = window.setInterval(fn, ms); __timers.push(id); return id; };


/* ================= 1. 数据配置（换成你自己的内容即可） ================= */
const CONFIG = {
  agents: [['01','解析'],['02','切块'],['03','向量'],['04','抽取'],['05','归一'],['06','建图'],
           ['07','社区'],['08','索引'],['09','检索'],['10','重排'],['11','摘要'],['12','归档']],
  taskNames: ['产品需求文档','技术白皮书','接口规范','会议纪要','合同条款汇编','行业标准','图谱综述',
              '数据字典','运营手册','安全审计记录','部署架构图','专利检索清单','培训课件','故障复盘',
              '版本发布说明','数据迁移方案'],
  workflows: ['文档解析','语义切块','向量化','实体抽取','关系抽取','实体归一','图谱构建','社区聚类','混合检索','重排摘要','归档索引'],
  // 执行代码面板：多套示例，随机轮换，一轮内不重复。agent = 对应 agents 的序号（0 起）
  codeSets: [
    {file: 'ingest.py', agent: 0, start: 7, lines: [
      "# 入库：扫描 → 去重 → 排队解析",
      "files = scan(root, exts=['.pdf', '.docx', '.md'])",
      "files = dedupe(files, by='sha256')",
      "for f in files:",
      "    doc_id = db.upsert(f)",
      "    queue.push(doc_id, parser=strategy(f))",
      "log.info(f'入队 {len(files)} 份')"]},
    {file: 'parse.py', agent: 0, start: 18, lines: [
      "# 解析：按版面还原段落，保留页码锚点",
      "def parse(path):",
      "    raw = reader(path)",
      "    pages = split_pages(raw)",
      "    blocks = [b for p in pages for b in layout(p)]",
      "    return Doc(blocks, meta=raw.meta)"]},
    {file: 'chunk.py', agent: 1, start: 31, lines: [
      "# 切块：按标题层级切，超长再滑窗",
      "def chunk(doc, size=512, overlap=64):",
      "    secs = split_by_heading(doc)",
      "    out = []",
      "    for s in secs:",
      "        out += window(s.text, size, overlap)",
      "    return [c.with_anchor(s.page) for c in out]"]},
    {file: 'extract.py', agent: 3, start: 42, lines: [
      "# 抽取：实体 + 关系，全部带原文片段",
      "for c in chunks:",
      "    ents = llm.extract(c.text, schema=SCHEMA)",
      "    ents = [e for e in ents if e.score > 0.6]",
      "    rels = link(ents, c.text)",
      "    graph.upsert(ents, rels, src=c.id)",
      "    audit.trace(c.id, ents, rels)"]},
    {file: 'graph.py', agent: 5, start: 56, lines: [
      "# 建图：归一别名后合并同实体",
      "canon = [alias.normalize(e) for e in ents]",
      "for e in canon:",
      "    node = graph.merge(e) if e.key in seen else graph.add(e)",
      "    graph.link(node, e.src)",
      "communities = louvain(graph, res=1.2)",
      "graph.save('graph.db')"]},
    {file: 'retrieve.py', agent: 8, start: 70, lines: [
      "# 混合检索：向量召回 + 图谱扩展 + 重排",
      "def retrieve(q, k=20):",
      "    vec = index.search(embed(q), top=k * 2)",
      "    hop = graph.traverse(vec[:5], depth=2)",
      "    hits = rerank(vec + hop, q)",
      "    return topk(hits, k, with_citation=True)"]}
  ]
};
const CODEBITS = ['chunk(text, size=512)','embed(batch, dim=1024)','extract(text, schema)','normalize(entity)','merge(a, b)',
  'edge(src, dst, type)','community(g, res=1.2)','index.upsert(chunk)','search(q, k=20)','rerank(hits)','cite(page=12)',
  'graph.traverse(id, 2)','queue.push(doc)','db.upsert(doc)','score = review(out)','route(task, parser)'];

/* 飞轮转速（弧度/秒），越大转得越快 */
const SPIN = 0.16;

/* ================= 2. 工具 ================= */
const $ = s => SR.querySelector(s);
const TAU = Math.PI * 2;
const FONT = '"JetBrains Mono","Noto Sans SC",ui-monospace,Menlo,monospace';
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const root = host;
function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pick = (rr, a) => a[(rr() * a.length) | 0];
const pad2 = n => String(n).padStart(2, '0');
const hms = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const wrapPI = a => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const rgba = (hex, a) => { let h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
function fitCv(cv, ctx){ const r = cv.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2); const w = Math.max(1, r.width), h = Math.max(1, r.height); cv.width = Math.round(w * d); cv.height = Math.round(h * d); ctx.setTransform(d, 0, 0, d, 0, 0); return [w, h]; }
function qd(c, q){ c.beginPath(); c.moveTo(q.x1, q.y1); c.quadraticCurveTo(q.cx, q.cy, q.x2, q.y2); c.stroke(); }
function bez(q, u){ const v = 1 - u; return [v*v*q.x1 + 2*v*u*q.cx + u*u*q.x2, v*v*q.y1 + 2*v*u*q.cy + u*u*q.y2]; }

/* 主题：颜色全部来自 CSS 变量 */
let T = {};
/* 配色系列：深浅由 data-theme 决定，强调色由 data-series 决定，两者正交。
   「换主题」按钮在此循环，画布每帧从 T 取色，切完立即按新色重绘 */
const SERIES = ['mint', 'sd', 'amber'];
const SERIES_CN = {mint: '薄荷', sd: '主绿', amber: '琥珀'};
const SERIES_KEY = 'sd-ops-series';
function readSeries(){
  try { const v = localStorage.getItem(SERIES_KEY); if (SERIES.indexOf(v) >= 0) return v; } catch (e) { /* 隐私模式下无 localStorage */ }
  return SERIES[0];
}
const curSeries = () => (SERIES.indexOf(root.dataset.series) >= 0 ? root.dataset.series : readSeries());
root.dataset.series = curSeries();
const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : darkMQ.matches;
/* 系列配色按 [data-theme][data-series] 组合命中，宿主上没有 data-theme 时先补一个，
   否则从标题栏切「纸面 / 粒子」之外的地方进来会只剩薄荷绿的默认值 */
if (!root.dataset.theme) root.dataset.theme = isDark() ? 'dark' : 'light';
function readTheme(){
  const cs = getComputedStyle(root), g = n => cs.getPropertyValue(n).trim();
  T = {dark: isDark(), bg: g('--bg'), panel: g('--panel'), band: g('--band'), ink: g('--ink'), ink2: g('--ink2'), mute: g('--mute'),
       hair: g('--hair'), hair2: g('--hair2'), line: g('--c-line'), hi: g('--c-hi'), hot: g('--c-hot'), text: g('--c-text'), dim: g('--c-dim')};
  T.cell = T.dark ? T.ink2 : T.ink;
  themeBtn.textContent = T.dark ? '纸面' : '粒子';
  themeBtn.setAttribute('aria-label', T.dark ? '切换到纸面主题' : '切换到粒子主题');
  seriesBtn.textContent = '换主题·' + SERIES_CN[curSeries()];
  seriesBtn.setAttribute('aria-label', '切换配色系列，当前 ' + SERIES_CN[curSeries()]);
  seriesBtn.title = '在薄荷 / 主绿 / 琥珀之间切换强调色';
}

/* ================= 3. 模拟引擎（接真实数据时替换这一段） ================= */
const R = mulberry32(20261016);
const NA = CONFIG.agents.length, NW = CONFIG.workflows.length;
const tasks = Array.from({length: 64}, (_, i) => ({i, id: 'T-' + String(i + 1).padStart(3, '0'),
  name: CONFIG.taskNames[(R() * CONFIG.taskNames.length) | 0], wf: (R() * NW) | 0, prog: 0, state: 'queued', agent: -1}));
const agents = CONFIG.agents.map(([code, name], i) => ({i, code, name, task: -1}));
const wfs = CONFIG.workflows.map((name, i) => ({i, id: 'W' + pad2(i + 1), name, q: 0, cells: Array.from({length: 16}, () => R())}));
[0.91, 0.86, 0.72, 0.88, 0.84, 0.69, 0.93, 0.82, 0.74, 0.87, 0.71].forEach((q, i) => wfs[i].q = q);
const order = tasks.map(t => t.i);
for (let i = order.length - 1; i > 0; i--) { const j = (R() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
order.slice(0, 22).forEach(i => { tasks[i].state = 'done'; tasks[i].prog = 1; });
order.slice(22, 32).forEach((i, k) => { const t = tasks[i]; t.state = 'run'; t.prog = 0.06 + R() * 0.85; t.agent = k; agents[k].task = i; });

const running = () => agents.filter(a => a.task >= 0).length;
const doneCount = () => tasks.filter(t => t.state === 'done').length;
const matched = () => wfs.filter(w => w.q >= 0.8).length;

let logN = 38;
const feed = [];
const VERB = {read: '读取', build: '生成', check: '核验', review: '复核'};
function log(verb, t){ feed.push({n: logN++, verb, text: `${VERB[verb]} ${t.name}`}); if (feed.length > 30) feed.shift(); }
order.slice(8, 20).forEach((i, k) => log(['read', 'build', 'check', 'review'][k % 4], tasks[i]));

function step(){
  for (const a of agents) {
    if (a.task < 0) continue;
    const t = tasks[a.task];
    t.prog = Math.min(1, t.prog + 0.03 + Math.random() * 0.08);
    if (t.prog >= 1) { t.state = 'done'; t.agent = -1; a.task = -1; log(Math.random() < 0.5 ? 'check' : 'review', t); }
  }
  for (const a of agents) {
    if (a.task >= 0 || Math.random() > 0.4) continue;
    const q = tasks.filter(t => t.state === 'queued');
    if (!q.length) break;
    const t = q[(Math.random() * q.length) | 0];
    t.state = 'run'; t.agent = a.i; t.prog = 0.02; a.task = t.i; log(Math.random() < 0.5 ? 'read' : 'build', t);
  }
  const done = tasks.filter(t => t.state === 'done');
  if (done.length > 54) for (let k = 0; k < 18; k++) { const t = done[(Math.random() * done.length) | 0]; t.state = 'queued'; t.prog = 0; }
  const w = wfs[(Math.random() * NW) | 0];
  w.q = Math.max(0.6, Math.min(0.97, w.q + (Math.random() - 0.38) * 0.05));
  w.cells[(Math.random() * 16) | 0] = Math.random();
  renderAll();
}

/* ================= 4. DOM 面板 ================= */
const themeBtn = $('#theme'), seriesBtn = $('[data-series-pick]'), fullBtn = $('#full');
const feedEl = $('#feed'), agentsEl = $('#agents'), codeEl = $('#code');

/* ===== SD 真实数据接入（新增，不改视觉逻辑） =====
   BigScreen 拿到快照后调用 host.__sdOpsFeed(snap) 注入；注入前一切照旧走上面的模拟引擎。
   注入后只有「stat 行 / feed / agents / hud」四块文本改读真实数据，
   舞台 canvas 与粒子求解器仍是装饰层，不承载业务数字——它们的动画不因数据为空而停摆。 */
let SNAP = null;
function renderStatsReal(){
  const s = SNAP.stats;
  $('#s0').textContent = s.docs;
  $('#s1').innerHTML = `${s.running} <small>/ ${s.concurrency}</small>`;
  $('#s2').textContent = s.communities;
  $('#s3').textContent = s.entities;
  $('#s4').textContent = s.relations;
  $('#s5').textContent = s.waiting;
  $('#noteMain').textContent = SNAP.note;
  $('#agMeta').textContent = SNAP.agMeta;
}
function renderFeedReal(){
  const n = Math.max(4, Math.floor(feedEl.clientHeight / 13.5));
  feedEl.innerHTML = SNAP.feed.slice(-n).map(e =>
    `<li><span class="n">${esc(e.n)}</span><span class="vb">${esc(e.verb)}</span><span class="d">${esc(e.text)}</span></li>`).join('');
}
function renderAgentsReal(){
  agentsEl.innerHTML = SNAP.slots.map(a =>
    `<li class="${a.busy ? 'busy' : 'idle'}"><span class="n">${esc(a.code)}</span><span class="r">${esc(a.name)}</span><span class="b"><b><i style="width:${a.busy ? 100 : 0}%"></i></b><small>${esc(a.state)}</small></span></li>`).join('');
}

function renderStats(){
  if (SNAP) return renderStatsReal();
  const run = running(), m = matched();
  $('#s1').innerHTML = `${run} <small>/ ${NA}</small>`;
  $('#s3').textContent = doneCount();
  $('#s4').innerHTML = `${m} <small>/ ${NW}</small>`;
  $('#s5').textContent = NW - m;
  $('#noteMain').textContent = `${m} / ${NW} 已匹配 · ${NW - m} 待复核`;
  $('#agMeta').textContent = `${NA - run} idle`;
}
function renderFeed(){
  if (SNAP) return renderFeedReal();
  const n = Math.max(4, Math.floor(feedEl.clientHeight / 13.5));
  feedEl.innerHTML = feed.slice(-n).map(e => `<li><span class="n">${String(e.n).padStart(3, '0')}</span><span class="vb">${e.verb}</span><span class="d">${e.text}</span></li>`).join('');
}
function renderAgents(){
  if (SNAP) return renderAgentsReal();
  agentsEl.innerHTML = agents.map(a => {
    const t = a.task >= 0 ? tasks[a.task] : null;
    const st = t ? `${t.id} · ${t.prog < 0.35 ? 'reading' : t.prog < 0.75 ? 'working' : 'review'}` : 'idle';
    return `<li class="${t ? 'busy' : 'idle'}"><span class="n">${a.code}</span><span class="r">${a.name}</span><span class="b"><b><i style="width:${t ? Math.max(4, t.prog * 100).toFixed(0) : 0}%"></i></b><small>${st}</small></span></li>`;
  }).join('');
}
function renderAll(){ renderStats(); renderFeed(); renderAgents(); if (hoverHub >= 0) showTip(); }

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hl = s => s.trim().startsWith('#') ? `<span class="cm">${esc(s)}</span>`
  : esc(s).replace(/('[^']*'?)/g, '<span class="str">$1</span>').replace(/\b(for|in|if|def|return|not|assert|lambda)\b/g, '<span class="kw">$1</span>');

/* 执行代码：逐字打出一套，停顿后换另一套；一轮内不重复，也不会连着出现同一套 */
let codeOrder = [], codeIdx = -1, cset = null, cl = 0, cc = 0, hold = 0, linePause = 0;
function nextCodeSet(){
  if (!codeOrder.length) {
    codeOrder = CONFIG.codeSets.map((_, i) => i).filter(i => i !== codeIdx);
    for (let i = codeOrder.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [codeOrder[i], codeOrder[j]] = [codeOrder[j], codeOrder[i]]; }
  }
  codeIdx = codeOrder.shift();
  cset = CONFIG.codeSets[codeIdx]; cl = 0; cc = 0; hold = 0; linePause = 0;
  const a = agents[cset.agent] || agents[0];
  $('#codeMeta').textContent = `${cset.file} · ${a.code} ${a.name}`;
}
function renderCode(){
  const fit = Math.max(4, Math.floor(codeEl.clientHeight / 13));
  let html = '';
  for (let i = Math.max(0, cl - fit + 1); i <= cl; i++) {
    const txt = i < cl ? cset.lines[i] : cset.lines[i].slice(0, cc);
    html += `<span class="row${i === cl ? ' cur' : ''}"><span class="ln">${String(i + cset.start).padStart(3, '0')}</span>${hl(txt)}${i === cl ? '<span class="caret"></span>' : ''}</span>`;
  }
  codeEl.innerHTML = html;
}
function typeTick(){
  if (hold > 0) { if (--hold === 0) nextCodeSet(); renderCode(); return; }
  if (linePause > 0) { linePause--; return; }
  cc += Math.random() < 0.3 ? 2 : 1;
  if (cc >= cset.lines[cl].length) {
    cc = cset.lines[cl].length;
    if (cl < cset.lines.length - 1) { renderCode(); cl++; cc = 0; linePause = 5; }
    else hold = 60;
  }
  renderCode();
}

/* ================= 5. 主舞台 ================= */
const stage = $('#stage'), sc = $('#sc'), sctx = sc.getContext('2d'), tip = $('#tip');
let W = 1, H = 1, DPR = 1, G = null, layThreads = null, layRing = null;
let hubs = [], pulses = [], blocks = [], streaks = [], blockFS = 8, blockLH = 11;
let hoverHub = -1, needs = true, stageDirty = true, panelsNeed = true;
const hubWf = [4, 0, 8], hubCh = [-10, -10, -10];   // 三个汇聚节点当前对应的工作流、上次切换时间
let hubTurn = 0;
const ax = (Rr, y) => G.cx + Math.sqrt(Math.max(0, Rr * Rr - (y - G.cy) * (y - G.cy)));
const visAng = (Rr, pad) => Math.asin(Math.min(1, (Math.max(G.cy, H - G.cy) + pad) / Rr));
function mkLayer(){ const cv = document.createElement('canvas'); cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); const c = cv.getContext('2d'); c.setTransform(DPR, 0, 0, DPR, 0, 0); return [cv, c]; }
function bloom(cv, c, amount){
  if (!T.dark || typeof c.filter !== 'string') return;
  const g = document.createElement('canvas'); g.width = cv.width; g.height = cv.height;
  const gc = g.getContext('2d'); gc.filter = `blur(${3 * DPR}px)`; gc.drawImage(cv, 0, 0);
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'lighter'; c.globalAlpha = amount; c.drawImage(g, 0, 0); c.restore();
}

function layoutStage(){
  const r = sc.getBoundingClientRect();
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = Math.max(1, r.width); H = Math.max(1, r.height);
  sc.width = Math.round(W * DPR); sc.height = Math.round(H * DPR);
  const narrow = W < 700;
  const R1 = narrow ? Math.max(H * 0.8, W * 0.85) : Math.max(H * 0.72, W * 0.24);
  const cx = W * (narrow ? 0.36 : 0.40) - R1;
  G = {cx, cy: H * 0.5 + (narrow ? 70 : 22), R1, R2: R1 + W * (narrow ? 0.26 : 0.22), narrow};
  buildStreaks(); buildThreads(); buildRing(); buildBlocks();
}

/* --- 飞轮谱线：整圈生成，每帧只画可见扇区 --- */
function buildStreaks(){
  const rr = mulberry32(5), thVis = visAng(G.R2, 30);
  const density = (G.narrow ? 420 : 1100) / (2 * thVis);
  streaks = [];
  const mk = (th, Lc, hot) => {
    const s = {th: ((th % TAU) + TAU) % TAU, off: 20 + rr() * 4, f: Lc * (0.7 + rr() * 0.42), b: (rr() * 4) | 0, hot, d: []};
    const nd = rr() < 0.42 ? 1 + ((rr() * 2) | 0) : 0;
    for (let i = 0; i < nd; i++) s.d.push({p: rr() * 0.92, len: 4 + rr() * 34, v: 0});
    if (rr() < 0.3) s.d.push({p: rr(), len: 5 + rr() * 20, v: 0.05 + rr() * 0.22});
    streaks.push(s);
  };
  let a = 0;
  while (a < TAU) {
    const spread = 0.008 + rr() * 0.045, n = Math.round(spread * 2 * density * (0.6 + rr() * 0.9));
    const Lc = 0.28 + rr() * 0.72, hot = rr() < 0.14;
    for (let j = 0; j < n; j++) mk(a + (rr() * 2 - 1) * spread, Lc, hot);
    a += spread * 2 + rr() * 0.05;
  }
  const nl = Math.round(density * 0.25 * TAU);
  for (let j = 0; j < nl; j++) mk(rr() * TAU, 0.15 + rr() * 0.85, false);
}

function buildThreads(){
  const [cv, c] = mkLayer(), rr = mulberry32(99), {cx, cy, R1, narrow} = G;
  const k = narrow ? 0.5 : 1, A = T.dark ? 1.3 : 1;
  const inner = y => ax(R1, y);
  const rp = (padR = 8) => { const y = rr() * H; return [rr() * Math.max(10, inner(y) - padR), y]; };
  c.save(); c.beginPath(); c.arc(cx, cy, R1 - 1, 0, TAU); c.clip();
  c.lineCap = 'round'; c.strokeStyle = T.line;
  for (let i = 0; i < Math.round(360 * k); i++) {
    const [x1, y1] = rp(), [x2, y2] = rp();
    c.globalAlpha = Math.min(1, (0.05 + rr() * 0.2) * A); c.lineWidth = 0.45 + rr() * 0.5;
    c.beginPath(); c.moveTo(x1, y1); c.quadraticCurveTo((x1 + x2) / 2 + (rr() - 0.5) * 90, (y1 + y2) / 2 + (rr() - 0.5) * 90, x2, y2); c.stroke();
  }
  for (let i = 0; i < Math.round(22 * k); i++) {
    const rad = 200 + rr() * 900, a0 = rr() * TAU;
    c.globalAlpha = (0.08 + rr() * 0.16) * A; c.lineWidth = 0.6;
    c.beginPath(); c.arc(rr() * W * 0.4 - rad * 0.3, rr() * H, rad, a0, a0 + 0.3 + rr() * 0.8); c.stroke();
  }
  hubs = [];
  (narrow ? [-0.2, 0.07, 0.3] : [-0.33, 0.01, 0.34]).forEach((off, h) => {
    const y = cy + H * off, x = inner(y) - 3, hub = {x, y, curves: [], wf: [4, 0, 8][h]};
    const n = Math.round((narrow ? 40 : 80) + rr() * 30);
    for (let i = 0; i < n; i++) {
      const sy = y + (rr() - 0.5) * H * 1.1, sx = rr() * Math.max(20, x - 60);
      const q = {x1: sx, y1: sy, cx: x - (x - sx) * (0.18 + rr() * 0.25), cy: y + (sy - y) * (0.02 + rr() * 0.18), x2: x, y2: y + (rr() - 0.5) * 3};
      hub.curves.push(q);
      c.strokeStyle = T.dark && rr() < 0.22 ? T.hi : T.line;
      c.globalAlpha = Math.min(1, (0.14 + rr() * 0.5) * A); c.lineWidth = 0.45 + rr() * 0.7; qd(c, q);
    }
    c.strokeStyle = T.dark ? T.hi : T.line; c.globalAlpha = 1; c.lineWidth = 3.2;
    c.beginPath(); c.moveTo(x - 16, y); c.lineTo(x + 1, y); c.stroke();
    hubs.push(hub);
  });
  c.strokeStyle = T.line; c.fillStyle = T.line; c.lineWidth = 0.8;
  for (let i = 0; i < Math.round(28 * k); i++) { const [x, y] = rp(20), s = 3 + rr() * 3; c.globalAlpha = 0.7 * A; c.strokeRect(x - s / 2, y - s / 2, s, s); }
  for (let i = 0; i < Math.round(14 * k); i++) { const [x, y] = rp(20); c.globalAlpha = 0.6 * A; c.beginPath(); c.arc(x, y, 2.5 + rr() * 6, 0, TAU); c.stroke(); }
  for (let i = 0; i < Math.round(16 * k); i++) { const [x, y] = rp(20); c.globalAlpha = 0.85; c.beginPath(); c.arc(x, y, 1.4 + rr() * 1.6, 0, TAU); c.fill(); }
  c.lineWidth = 1.6;
  for (let i = 0; i < Math.round(26 * k); i++) { const [x, y] = rp(20), a = rr() * TAU, l = 5 + rr() * 9; c.globalAlpha = 0.8; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke(); }
  { const [x, y] = rp(130); c.lineWidth = 0.9; c.globalAlpha = 0.75; for (let i = 0; i < 6; i++) { c.beginPath(); c.arc(x + i * 15, y - i * 4, 3.2, 0, TAU); c.stroke(); } }
  c.restore();
  c.globalAlpha = 1;
  bloom(cv, c, 0.55);
  layThreads = cv;
  pulses = Array.from({length: narrow ? 14 : 34}, () => newPulse(true));
}
function newPulse(rand){ const h = hubs[(Math.random() * hubs.length) | 0]; return {q: h.curves[(Math.random() * h.curves.length) | 0], u: rand ? Math.random() : 0, v: 0.16 + Math.random() * 0.34}; }

/* --- 环带底板：只放不转的部分（底色、两条弧、节点标签） --- */
function buildRing(){
  const [cv, c] = mkLayer(), {cx, cy, R1, R2, narrow} = G, half = Math.PI / 2;
  c.beginPath(); c.arc(cx, cy, R2, 0, TAU); c.arc(cx, cy, R1, 0, TAU, true); c.fillStyle = T.band; c.fill();
  c.strokeStyle = T.line;
  if (T.dark) { c.globalAlpha = 0.18; c.lineWidth = 5; c.beginPath(); c.arc(cx, cy, R2, -half, half); c.stroke(); c.beginPath(); c.arc(cx, cy, R1, -half, half); c.stroke(); }
  c.globalAlpha = T.dark ? 0.95 : 0.85; c.lineWidth = 1.1;
  c.beginPath(); c.arc(cx, cy, R1, -half, half); c.stroke();
  c.beginPath(); c.arc(cx, cy, R2, -half, half); c.stroke();
  c.globalAlpha = 0.3; c.lineWidth = 0.7; c.beginPath(); c.arc(cx, cy, R2 - 7, -half, half); c.stroke();
  c.globalAlpha = 1;
  layRing = cv;
}

/* --- 环带数据块：整圈排布，随飞轮一起转，文字沿半径方向 --- */
function buildBlocks(){
  blocks = [];
  blockFS = G.narrow ? 5.8 : 8.8; blockLH = blockFS * 1.34;
  for (const col of (G.narrow ? [0] : [0, 1])) {
    const rr = mulberry32(11 + col * 97);
    const types = col ? ['table', 'grid', 'bars', 'table', 'tag'] : ['code', 'table', 'bars', 'code', 'tag', 'code'];
    let th = rr() * 0.05;
    while (th < TAU - 0.06) {
      const type = pick(rr, types); let lines = [];
      if (type === 'code') { lines = ['// ' + pick(rr, ['source / extract', 'audit / compare', 'dispatch / route', 'review / revise'])]; const n = 5 + ((rr() * 6) | 0); for (let i = 0; i < n; i++) lines.push(pick(rr, CODEBITS)); }
      else if (type === 'table') { const n = 6 + ((rr() * 4) | 0); for (let i = 0; i < n; i++) lines.push(`${String((rr() * 99) | 0).padStart(3, '0')}  ${(rr() * 0.09).toFixed(4)}  ${rr() < 0.8 ? 'ok ' : 'chk'}  ${(100 + rr() * 900) | 0}ms`); }
      else if (type === 'grid') { const n = 5 + ((rr() * 3) | 0); for (let i = 0; i < n; i++) { let s = ''; for (let j = 0; j < 8; j++) s += String((rr() * 99) | 0).padStart(2, '0') + ' '; lines.push(s.trim()); } }
      else if (type === 'bars') { lines = Array(4 + ((rr() * 3) | 0)).fill(''); }
      else { lines = [`${pick(rr, wfs).id} — ${pick(rr, ['mood', 'drift', 'scope', 'route', 'spec'])}`]; }
      const h = lines.length * blockLH + 4, dth = h / G.R1;
      if (th + dth > TAU - 0.03) break;
      blocks.push({type, lines, h, th: th + dth / 2, col, ind: rr(), seed: (rr() * 100000) | 0});
      th += dth + (10 + rr() * 18) / G.R1;
    }
  }
}

function drawBlocks(c, t){
  const {cx, cy, R1, R2} = G, rot = t * SPIN, band = R2 - R1, thVis = visAng(R1, 50);
  c.font = `500 ${blockFS}px ${FONT}`; c.textBaseline = 'top';
  for (const b of blocks) {
    const th = wrapPI(b.th + rot);
    if (th > thVis || th < -thVis) continue;
    const x0 = R1 + 14 + (b.col ? band * 0.5 : 0) + b.ind * band * 0.04;
    const maxW = b.col || G.narrow ? Math.max(12, R2 - (G.narrow ? 34 : 54) - x0) : band * 0.45;
    const y = -b.h / 2;
    c.save(); c.translate(cx, cy); c.rotate(th);
    if (b.type === 'bars') {
      const rr = mulberry32(b.seed); c.fillStyle = T.text; c.globalAlpha = 0.9;
      for (let i = 0; i < b.lines.length; i++) { let x = x0; const lim = x0 + Math.min(maxW, G.narrow ? 34 : 64); while (x < lim) { const w = 2 + rr() * 9; if (rr() < 0.62) c.fillRect(x, y + 2 + i * blockLH, Math.min(w, lim - x), blockLH * 0.55); x += w + 1.5; } }
    } else {
      const hi = b.type === 'code' ? 1 + (((t * 0.6) | 0) + b.seed) % (b.lines.length - 1) : -1;
      for (let i = 0; i < b.lines.length; i++) {
        const ly = y + 2 + i * blockLH;
        if (i === hi) {
          const tw = Math.min(maxW, c.measureText(b.lines[i]).width) + 4;
          c.globalAlpha = 1; c.fillStyle = T.text; c.fillRect(x0 - 2, ly - 1, tw, blockLH); c.fillStyle = T.band;
        } else {
          c.fillStyle = T.text; c.globalAlpha = i === 0 && b.type !== 'table' && b.type !== 'grid' ? 1 : b.type === 'code' ? 0.8 : 0.62;
        }
        c.fillText(b.lines[i], x0, ly, maxW);
      }
    }
    c.restore();
  }
  c.globalAlpha = 1;
}

/* --- 飞轮刻度与字节标签，跟着转 --- */
const labelVal = k => (((k * 2654435761) >>> 0) % 360) + 20;
function drawWheelMarks(c, t){
  const {cx, cy, R1, R2, narrow} = G, rot = t * SPIN;
  const p = new Path2D(), s1 = 6 / R1, t1 = visAng(R1, 12);
  for (let k = Math.ceil((-t1 - rot) / s1), e = Math.floor((t1 - rot) / s1); k <= e; k++) {
    const a = k * s1 + rot, l = k % 5 === 0 ? 9 : 4, ca = Math.cos(a), sa = Math.sin(a);
    p.moveTo(cx + ca * (R1 + 2), cy + sa * (R1 + 2)); p.lineTo(cx + ca * (R1 + 2 + l), cy + sa * (R1 + 2 + l));
  }
  c.strokeStyle = T.line; c.globalAlpha = 0.7; c.lineWidth = 0.8; c.stroke(p);
  const q = new Path2D(), s2 = 3.2 / R2, t2 = visAng(R2, 12);
  for (let k = Math.ceil((-t2 - rot) / s2), e = Math.floor((t2 - rot) / s2); k <= e; k++) {
    const a = k * s2 + rot, l = k % 10 === 0 ? 8 : 3, ca = Math.cos(a), sa = Math.sin(a);
    q.moveTo(cx + ca * (R2 - 1), cy + sa * (R2 - 1)); q.lineTo(cx + ca * (R2 - 1 - l), cy + sa * (R2 - 1 - l));
  }
  c.globalAlpha = 0.55; c.lineWidth = 0.7; c.stroke(q);
  const s3 = (narrow ? 34 : 46) / R2;
  c.globalAlpha = 1; c.fillStyle = T.dim; c.font = `${narrow ? 6 : 8}px ${FONT}`; c.textAlign = 'right'; c.textBaseline = 'middle';
  for (let k = Math.ceil((-t2 - rot) / s3), e = Math.floor((t2 - rot) / s3); k <= e; k++) {
    c.save(); c.translate(cx, cy); c.rotate(k * s3 + rot); c.fillText(`${labelVal(k)} b`, R2 - 13, 0); c.restore();
  }
  c.textAlign = 'left';
}

/* --- 飞轮谱线：基础细线 + 荧光扇区 + 滑动亮段 --- */
const BA = [0.09, 0.17, 0.27, 0.4];
function drawWheelStreaks(c, t, dt){
  const {cx, cy, R2} = G, rot = t * SPIN, thVis = visAng(R2, 30);
  const base = [new Path2D(), new Path2D(), new Path2D(), new Path2D()], hotP = new Path2D(), dashP = new Path2D(), hotD = new Path2D();
  for (const s of streaks) {
    const th = wrapPI(s.th + rot);
    if (th > thVis || th < -thVis) continue;
    const cp = Math.cos(th), sp = Math.sin(th), r0 = R2 + s.off, x0 = cx + cp * r0, y0 = cy + sp * r0;
    const reach = Math.max(40, (W + 20 - x0) / Math.max(0.2, cp)), L = Math.min(reach, s.f * reach);
    const p = s.hot ? hotP : base[s.b];
    p.moveTo(x0, y0); p.lineTo(x0 + cp * L, y0 + sp * L);
    const q = s.hot ? hotD : dashP;
    for (const d of s.d) {
      if (d.v) d.p = (d.p + d.v * dt) % 1;
      const a0 = d.p * L, a1 = Math.min(L, a0 + d.len);
      q.moveTo(x0 + cp * a0, y0 + sp * a0); q.lineTo(x0 + cp * a1, y0 + sp * a1);
    }
  }
  c.lineCap = 'butt'; c.strokeStyle = T.line; c.lineWidth = 0.7;
  const A = T.dark ? 1.3 : 1;
  base.forEach((p, i) => { c.globalAlpha = Math.min(0.9, BA[i] * A); c.stroke(p); });
  if (T.dark) {
    c.globalCompositeOperation = 'lighter';
    c.strokeStyle = T.hot; c.globalAlpha = 0.1; c.lineWidth = 4.5; c.stroke(hotP);
    c.globalAlpha = 0.6; c.lineWidth = 0.9; c.stroke(hotP);
    c.globalAlpha = 0.12; c.strokeStyle = T.hi; c.lineWidth = 5; c.stroke(dashP);
    c.globalAlpha = 0.9; c.lineWidth = 1.6; c.stroke(dashP);
    c.strokeStyle = T.hot; c.globalAlpha = 0.3; c.lineWidth = 7; c.stroke(hotD);
    c.strokeStyle = T.hi; c.globalAlpha = 1; c.lineWidth = 2; c.stroke(hotD);
    c.globalCompositeOperation = 'source-over';
  } else {
    c.strokeStyle = T.hot; c.globalAlpha = 0.5; c.lineWidth = 0.8; c.stroke(hotP);
    c.strokeStyle = T.line; c.globalAlpha = 0.8; c.lineWidth = 1.5; c.stroke(dashP);
    c.strokeStyle = T.hot; c.globalAlpha = 0.95; c.lineWidth = 2; c.stroke(hotD);
  }
  c.globalAlpha = 1;
}

function drawPulses(c, dt){
  const p = new Path2D();
  for (let i = 0; i < pulses.length; i++) {
    const m = pulses[i]; m.u += m.v * dt;
    if (m.u > 1) { pulses[i] = newPulse(false); continue; }
    const u0 = Math.max(0, m.u - 0.07);
    for (let k = 0; k <= 6; k++) { const [x, y] = bez(m.q, u0 + (m.u - u0) * k / 6); k ? p.lineTo(x, y) : p.moveTo(x, y); }
  }
  c.lineCap = 'round';
  if (T.dark) { c.globalCompositeOperation = 'lighter'; c.strokeStyle = T.hi; c.globalAlpha = 0.12; c.lineWidth = 4.5; c.stroke(p); c.globalAlpha = 0.9; c.lineWidth = 1.4; c.stroke(p); c.globalCompositeOperation = 'source-over'; }
  else { c.strokeStyle = T.line; c.globalAlpha = 0.8; c.lineWidth = 1.35; c.stroke(p); }
  c.globalAlpha = 1;
}
function drawHubMarks(c, t){
  hubs.forEach((h, i) => {
    const on = i === hoverHub, r = on ? 15 : 9 + 2 * Math.sin(t * 2 + i);
    c.strokeStyle = T.dark ? T.hi : T.line; c.globalAlpha = on ? 1 : 0.55; c.lineWidth = on ? 1.2 : 0.8;
    c.beginPath(); c.arc(h.x - 6, h.y, r, 0, TAU); c.stroke();
    if (on) { c.beginPath(); c.moveTo(h.x - 30, h.y); c.lineTo(h.x - 22, h.y); c.moveTo(h.x - 6, h.y - 24); c.lineTo(h.x - 6, h.y - 16); c.moveTo(h.x - 6, h.y + 16); c.lineTo(h.x - 6, h.y + 24); c.stroke(); }
  });
  c.globalAlpha = 1;
}

/* --- 扫光：一道光束绕圆心快速扫过飞轮 --- */
function drawBeam(c, t){
  const {cx, cy, R1} = G, a = wrapPI(t * 0.85), w = 0.24, tv = visAng(R1, 40);
  if (a < -tv || a - w > tv) return;
  const far = W * 2, col = T.dark ? T.hot : T.line;
  c.save();
  c.beginPath(); c.moveTo(cx + Math.cos(a - w) * R1, cy + Math.sin(a - w) * R1);
  c.arc(cx, cy, far, a - w, a); c.arc(cx, cy, R1, a, a - w, true); c.closePath();
  if (c.createConicGradient) {
    const g = c.createConicGradient(a - w, cx, cy), f = w / TAU;
    g.addColorStop(0, rgba(col, 0)); g.addColorStop(f * 0.97, rgba(col, T.dark ? 0.2 : 0.07)); g.addColorStop(f, rgba(col, 0)); g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
  } else { c.fillStyle = rgba(col, T.dark ? 0.08 : 0.03); }
  if (T.dark) c.globalCompositeOperation = 'lighter';
  c.fill();
  c.beginPath(); c.moveTo(cx + Math.cos(a) * R1, cy + Math.sin(a) * R1); c.lineTo(cx + Math.cos(a) * far, cy + Math.sin(a) * far);
  c.strokeStyle = col; c.globalAlpha = T.dark ? 0.55 : 0.35; c.lineWidth = 1; c.stroke();
  c.restore();
}

/* --- 齿环：外圈反向快转、内圈反向慢转 --- */
function drawGears(c, t){
  const {cx, cy, R1, R2} = G;
  const ro = -t * SPIN * 2.6, r0 = R2 + 5, r1 = R2 + 12, n = Math.round(TAU * R2 / 9), st = TAU / n, tv = visAng(R2, 30);
  const p = new Path2D();
  for (let k = Math.ceil((-tv - ro) / st), e = Math.floor((tv - ro) / st); k <= e; k++) {
    const m = ((k % 7) + 7) % 7; if (m === 3 || m === 6) continue;
    const a = k * st + ro, a2 = a + st * (m === 0 ? 0.85 : 0.45);
    p.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); p.arc(cx, cy, r0, a, a2); p.arc(cx, cy, r1, a2, a, true); p.closePath();
  }
  const ri = R1 - 9, si = TAU / Math.round(TAU * R1 / 7), ti = visAng(R1, 30), roi = -t * SPIN * 1.6;
  const q = new Path2D();
  for (let k = Math.ceil((-ti - roi) / si), e = Math.floor((ti - roi) / si); k <= e; k++) {
    if (((k % 9) + 9) % 9 > 5) continue;
    const a = k * si + roi; q.moveTo(cx + Math.cos(a) * ri, cy + Math.sin(a) * ri); q.arc(cx, cy, ri, a, a + si * 0.55);
  }
  if (T.dark) {
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = T.hot; c.globalAlpha = 0.85; c.fill(p);
    c.strokeStyle = T.hot; c.globalAlpha = 0.18; c.lineWidth = 6; c.stroke(p);
    c.globalCompositeOperation = 'source-over';
    c.strokeStyle = T.line; c.globalAlpha = 0.8; c.lineWidth = 2; c.stroke(q);
  } else {
    c.fillStyle = T.line; c.globalAlpha = 0.8; c.fill(p);
    c.strokeStyle = T.line; c.globalAlpha = 0.6; c.lineWidth = 2; c.stroke(q);
  }
  c.globalAlpha = 1;
}

/* --- 三个汇聚节点的标签：定时切换工作流，切换时乱码跳动 --- */
const GLYPH = '01#%&*+=/<>▚▞▙▟░▒';
function switchHub(){
  const i = hubTurn++ % hubWf.length;
  const busy = [...new Set(tasks.filter(t => t.state === 'run').map(t => t.wf))].filter(w => !hubWf.includes(w));
  const pool = busy.length ? busy : wfs.map(w => w.i).filter(w => !hubWf.includes(w));
  hubWf[i] = pool[(Math.random() * pool.length) | 0];
  hubCh[i] = simT; needs = true;
  const h = hubs[i];
  if (h) for (let k = 0; k < 10; k++) pulses[(Math.random() * pulses.length) | 0] = {q: h.curves[(Math.random() * h.curves.length) | 0], u: Math.random() * 0.3, v: 0.5 + Math.random() * 0.45};
  if (hoverHub === i) showTip();
}
function drawHubLabels(c, t){
  const fs = G.narrow ? 6.5 : 9;
  c.textAlign = 'right'; c.textBaseline = 'middle';
  hubs.forEach((h, i) => {
    const w = wfs[hubWf[i]], full = `${w.id} — ${w.name}`, e = t - hubCh[i];
    let s = full;
    if (e >= 0 && e < 0.6) {
      const n = Math.floor(e / 0.6 * full.length);
      s = full.slice(0, n) + Array.from(full.slice(n), ch => ch === ' ' ? ' ' : GLYPH[(Math.random() * GLYPH.length) | 0]).join('');
    }
    const fresh = e >= 0 && e < 1.1, jump = e >= 0 && e < 0.4 ? -6 * Math.sin(e / 0.4 * Math.PI) : 0;
    const x = h.x - 30, y = h.y - 16 + jump;
    c.font = `700 ${fs}px ${FONT}`;
    const tw = c.measureText(s).width;
    c.globalAlpha = 1; c.fillStyle = fresh ? T.text : T.bg; c.fillRect(x - tw - 6, y - fs * 0.8, tw + 12, fs * 1.6);
    if (!fresh) { c.strokeStyle = T.text; c.globalAlpha = 0.5; c.lineWidth = 0.8; c.strokeRect(x - tw - 6 + 0.5, y - fs * 0.8 + 0.5, tw + 11, fs * 1.6 - 1); c.globalAlpha = 1; }
    c.fillStyle = fresh ? T.band : T.text; c.fillText(s, x, y);
    const sub = `${h.curves.length} src · q ${w.q.toFixed(2)} · ${w.q >= 0.8 ? 'match' : 'review'}`;
    c.font = `500 ${fs - 1.5}px ${FONT}`;
    const sw = c.measureText(sub).width;
    c.fillStyle = T.bg; c.fillRect(x - sw - 4, y + fs * 0.85, sw + 8, fs * 1.25);
    c.fillStyle = T.dim; c.fillText(sub, x, y + fs * 1.45);
    if (e >= 0 && e < 0.7) {
      const k = e / 0.7;
      c.strokeStyle = T.dark ? T.hot : T.line; c.globalAlpha = 1 - k; c.lineWidth = 1.4;
      c.beginPath(); c.arc(h.x - 6, h.y, 10 + k * 70, 0, TAU); c.stroke(); c.globalAlpha = 1;
    }
  });
  c.textAlign = 'left';
}

let nextGlitch = 6, glitchUntil = 0;
function drawStage(t, dt){
  const c = sctx;
  c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  c.fillStyle = T.bg; c.fillRect(0, 0, sc.width, sc.height);
  c.drawImage(layThreads, 0, 0); c.drawImage(layRing, 0, 0);
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawWheelStreaks(c, t, dt); drawBeam(c, t); drawGears(c, t); drawWheelMarks(c, t); drawPulses(c, dt); drawBlocks(c, t); drawHubMarks(c, t); drawHubLabels(c, t);
  if (T.dark && !reduce && dt > 0) {
    if (t > nextGlitch) { glitchUntil = t + 0.1; nextGlitch = t + 5 + Math.random() * 5; }
    if (t < glitchUntil) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      for (let k = 0; k < 3; k++) { const y = Math.random() * sc.height, h = (4 + Math.random() * 24) * DPR, dx = (Math.random() - 0.5) * 36 * DPR; c.drawImage(sc, 0, y, sc.width, h, dx, y, sc.width, h); }
    }
  }
}

function showTip(){
  const h = hubs[hoverHub]; if (!h) return;
  const wi = hubWf[hoverHub], w = wfs[wi], live = tasks.filter(t => t.wf === wi && t.state === 'run').length;
  tip.innerHTML = `<b>${w.id}</b>${w.name}<span>汇入 ${h.curves.length} 条来源 · 运行中 ${live} · 质检 ${w.q.toFixed(2)} ${w.q >= 0.8 ? 'match' : 'review'}</span>`;
  tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(W - tw - 8, h.x + 14)) + 'px';
  tip.style.top = Math.max(8, Math.min(H - th - 8, h.y + 16)) + 'px';
}
function onPointer(e){
  if (!G) return;
  const r = sc.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  let h = -1; hubs.forEach((hb, i) => { if (Math.hypot(x - (hb.x - 6), y - hb.y) < 34) h = i; });
  if (h !== hoverHub) { hoverHub = h; needs = true; }
  if (h >= 0) showTip(); else tip.hidden = true;
}
sc.addEventListener('pointermove', onPointer);
sc.addEventListener('pointerdown', onPointer);
sc.addEventListener('pointerleave', () => { hoverHub = -1; tip.hidden = true; needs = true; });

/* ================= 6. 粒子求解器 ================= */
const pc = $('#pc'), pctx = pc.getContext('2d');
let PW = 1, PH = 1, mode = 'advect', stepN = 561, maxU = 0;
const parts = [], vort = [];
function seedP(){ parts.length = 0; const n = Math.round(Math.min(520, PW * PH / 70)); for (let i = 0; i < n; i++) parts.push({x: Math.random() * PW, y: Math.random() * PH, hl: Math.random() < 0.1, age: Math.random() * 200, life: 60 + Math.random() * 180}); }
function stepP(dt, tt){
  const c = pctx, s = 60 * dt;
  c.globalAlpha = 1; c.fillStyle = T.panel; c.fillRect(0, 0, PW, PH);
  const pa = new Path2D(), pb = new Path2D(); let mu = 0;
  for (const p of parts) {
    const a = Math.sin(p.x * 0.03 + tt * 0.35) * 1.7 + Math.cos(p.y * 0.045 - tt * 0.27) * 1.7 + Math.sin((p.x - p.y) * 0.015 + tt * 0.12);
    let vx = Math.cos(a) * 0.5, vy = Math.sin(a) * 0.5;
    for (const v of vort) { const dx = p.x - v.x, dy = p.y - v.y, d2 = dx * dx + dy * dy + 25, d = Math.sqrt(d2), f = v.life * 2.4 * Math.exp(-d2 / 1400); vx += -dy / d * f; vy += dx / d * f; }
    if (mode === 'project') { vx = Math.abs(vx) + 0.2; vy = (Math.round(p.y / 9) * 9 - p.y) * 0.12; }
    const u = Math.hypot(vx, vy); if (u > mu) mu = u;
    p.x += vx * s; p.y += vy * s; p.age += s;
    if (p.age > p.life) { p.x = Math.random() * PW; p.y = Math.random() * PH; p.age = 0; }
    if (p.x < -6) p.x += PW + 12; else if (p.x > PW + 6) p.x -= PW + 12;
    if (p.y < -6) p.y += PH + 12; else if (p.y > PH + 6) p.y -= PH + 12;
    const l = 2.5 + Math.min(6, u * 5), ux = vx / (u || 1), uy = vy / (u || 1), path = p.hl ? pb : pa;
    path.moveTo(p.x - ux * l / 2, p.y - uy * l / 2); path.lineTo(p.x + ux * l / 2, p.y + uy * l / 2);
  }
  if (dt > 0 || !maxU) maxU = mu;
  c.lineCap = 'butt'; c.strokeStyle = T.cell; c.globalAlpha = 0.85; c.lineWidth = 1.3; c.stroke(pa);
  c.strokeStyle = T.ink; c.globalAlpha = 1; c.lineWidth = 2; c.stroke(pb);
  for (const v of vort) { v.life -= dt / 6; if (v.life > 0) { c.strokeStyle = T.ink; c.globalAlpha = 0.6 * v.life; c.lineWidth = 0.8; c.beginPath(); c.arc(v.x, v.y, 6 + (1 - v.life) * 20, 0, TAU); c.stroke(); } }
  for (let i = vort.length - 1; i >= 0; i--) if (vort[i].life <= 0) vort.splice(i, 1);
  c.globalAlpha = 1;
  if (dt > 0) stepN++;
}
function addVortex(x, y){ vort.push({x, y, life: 1}); if (vort.length > 4) vort.shift(); }
pc.addEventListener('pointerdown', e => { const r = pc.getBoundingClientRect(); addVortex(e.clientX - r.left, e.clientY - r.top); panelsNeed = true; });
pc.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addVortex(PW * (0.2 + Math.random() * 0.6), PH * (0.2 + Math.random() * 0.6)); } });
SR.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.m === 'rerun') { seedP(); stepN = 0; vort.length = 0; panelsNeed = true; b.classList.add('on'); setTimeout(() => b.classList.remove('on'), 350); return; }
  mode = b.dataset.m; panelsNeed = true;
  SR.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x.dataset.m === mode));
}));

/* ================= 7. 主循环与控制 ================= */
let simT = 0, last = performance.now(), paused = false;
fullBtn.addEventListener('click', () => {
  const el = host;
  try {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => { fullBtn.textContent = '不支持'; setTimeout(() => fullBtn.textContent = '全屏', 1500); });
  } catch (e) { /* 部分窗口不允许全屏 */ }
});
const __onFs = () => { fullBtn.textContent = document.fullscreenElement ? '退出全屏' : '全屏'; }; document.addEventListener('fullscreenchange', __onFs); __disposed.push(() => document.removeEventListener('fullscreenchange', __onFs));
themeBtn.addEventListener('click', () => { root.dataset.theme = isDark() ? 'light' : 'dark'; });
/* 换主题：在「薄荷 / 主绿 / 琥珀」三系强调色间循环，选择记在 localStorage，
   下次进大屏沿用；属性变化统一交给下面的 MutationObserver 重读颜色 */
seriesBtn.addEventListener('click', () => {
  const next = SERIES[(SERIES.indexOf(curSeries()) + 1) % SERIES.length];
  root.dataset.series = next;
  try { localStorage.setItem(SERIES_KEY, next); } catch (e) { /* 隐私模式下写不进去，不影响本次切换 */ }
});
function onTheme(){ readTheme(); stageDirty = true; panelsNeed = true; }
const __mo = new MutationObserver(onTheme); __mo.observe(root, {attributes: true, attributeFilter: ['data-theme', 'data-series']}); __disposed.push(() => __mo.disconnect());
darkMQ.addEventListener('change', onTheme); __disposed.push(() => darkMQ.removeEventListener('change', onTheme));

function frame(now){
  if (__dead) return;
  requestAnimationFrame(frame);
  if (host.hidden) { last = now; return; }
  const real = Math.min(0.05, (now - last) / 1000); last = now;
  const dt = paused ? 0 : real; simT += dt;
  try {
    if (stageDirty) { layoutStage(); stageDirty = false; needs = true; }
    if (dt > 0 || needs) { drawStage(simT, dt); needs = false; }
    if (dt > 0 || panelsNeed) {
      if (PW > 20) stepP(dt, simT);
      panelsNeed = false;
    }
  } catch (err) { console.error(err); }
}

function hudTick(){
  if (SNAP) {
    $('#cfl').textContent = SNAP.hud.value;
    const st = $('#cflst'); st.textContent = SNAP.hud.state; st.className = SNAP.hud.bad ? 'warn' : '';
  } else {
    const cfl = maxU / 1.6, bad = cfl > 1;
    $('#cfl').textContent = cfl.toFixed(2);
    const st = $('#cflst'); st.textContent = bad ? 'OVER · 步长减半' : 'OK'; st.className = bad ? 'warn' : '';
  }
  $('#stepN').textContent = 'step ' + stepN;
}
function clockTick(){ $('#clock').textContent = hms(new Date()); }
let hiIdx = 1; const cells = [...SR.querySelectorAll('.stat')];
function cycleHi(){ cells.forEach((el, i) => el.classList.toggle('on', i === hiIdx)); hiIdx = (hiIdx + 1) % cells.length; }

const ro = new ResizeObserver(entries => {
  for (const e of entries) {
    if (e.target === stage) stageDirty = true;
    else if (e.target.id === 'pcBox') { [PW, PH] = fitCv(pc, pctx); seedP(); for (let k = 0; k < 4; k++) stepP(1 / 60, simT); }
  }
  renderFeed(); needs = true; panelsNeed = true;
});
[stage, $('#pcBox')].forEach(el => ro.observe(el)); __disposed.push(() => ro.disconnect());
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { stageDirty = true; panelsNeed = true; });

readTheme();
renderAll(); nextCodeSet();

/* 数据入口：BigScreen 轮询到快照就推进来。只重绘受数据驱动的四块，不碰 canvas。 */
host.__sdOpsFeed = snap => {
  if (__dead || !snap) return;
  SNAP = snap;
  renderStats(); renderFeed(); renderAgents(); hudTick();
};
if (reduce) { cl = cset.lines.length - 1; cc = cset.lines[cl].length; }
renderCode(); clockTick(); cycleHi();
__iv(() => { if (!paused && !host.hidden) step(); }, 900);
__iv(() => { if (!paused && !host.hidden) hudTick(); }, 300);
__iv(clockTick, 1000);
__iv(() => { if (!paused && !host.hidden) cycleHi(); }, 4500);
__iv(() => { if (!paused && !host.hidden) switchHub(); }, 2400);
__iv(() => { if (!paused && !host.hidden) typeTick(); }, 34);
__iv(() => { if (!paused && PW > 1) addVortex(PW * (0.2 + Math.random() * 0.6), PH * (0.2 + Math.random() * 0.6)); }, 9000);
setTimeout(hudTick, 500);
requestAnimationFrame(frame);
  host.__sdDispose = () => {
    __dead = true;
    SNAP = null; delete host.__sdOpsFeed;
    __timers.forEach(clearInterval); __timers.length = 0;
    __disposed.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); __disposed.length = 0;
  };
}
