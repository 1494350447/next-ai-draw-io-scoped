// 原型前端：结构预览 + 大纲框选 + 命令面板 + guard 报告。
// 刻意不引任何框架 —— Phase 1 要验的是产品假说（作用域是否成立、guard 是否兜得住），
// 不是 UI 工程；能一屏看清"谁可改、谁只读、改了谁"就够了。

const $ = (id) => document.getElementById(id);
const state = {
    xml: "", abstract: null, selected: new Set(), scope: null, report: null, meta: null, hint: null,
    lastChanged: new Set(),   // 上一次编辑动过的元素（画布高亮的依据）
    lastAdded: new Set(),     // 其中是"新增"的那些（高亮标签写"新"而不是"改"）
    history: [],              // 撤销栈：每个元素是 {xml, label}
    pending: null,            // 确认单：{label, key, afterXml, diff} —— 有它就是在"预览中"，还没写入
};

const post = async (path, body) => {
    const res = await fetch(path, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
};

async function loadSample(name) {
    const { xml } = await (await fetch(`/api/sample?name=${name}`)).json();
    state.xml = xml;
    state.selected = new Set();
    state.report = null;
    state.lastChanged = new Set();
    state.history = [];          // 换图 = 新的编辑会话
    state.lastAdded = new Set();
    state.pending = null;
    $("out").value = xml;        // 一开始就给出"当前 XML"（否则这个框是空的，让人以为没内容可复制）
    await refresh();
}

/**
 * 预览的有效性靠它守：**选区、连线开关、当前 XML** 任何一样变了，之前算出来的预览就作废。
 * 不作废的话，用户改完选区再点"应用"，落地的是针对旧选区算出来的那一版 —— 比没有预览更危险。
 */
const scopeKey = () => `${[...state.selected].sort().join(",")}|${$("edges").checked ? "connected" : "internal"}|${state.xml}`;

async function refresh() {
    // 作废要在解析之前做：否则这一轮还会拿旧预览去渲染
    let invalidated = false;
    if (state.pending && state.pending.key !== scopeKey()) {
        state.pending = null;
        state.report = { ...(state.report ?? {}), stale: true };
        invalidated = true;
    }
    // 预览中：画布/大纲/徽章都按"应用后"的样子渲染（当前 XML 不动，它等确认）
    const data = await post("/api/resolve-scope", {
        xml: state.pending?.afterXml ?? state.xml,
        roots: [...state.selected],
        includeEdges: $("edges").checked ? "connected" : "internal",
    });
    state.abstract = data.abstract;
    state.scope = data.scope;
    state.hint = data.hint ?? null;
    renderTree();
    renderSvg();
    renderBadges();
    renderCommands();
    // refresh() 会被很多地方调用（点选、切开关、清空选择），其中大部分不负责重绘报告。
    // 预览作废时必须在这里补一次重绘：否则画布已经回到"当前 XML"，确认单还挂在面板上 —— 那才是最危险的错觉。
    if (invalidated) renderReport();
}

function writableSet() { return new Set(state.scope?.writable ?? []); }
// 空选区是正常首屏状态：此时整张图都是"骨架"，界面必须照常可用（只提示"先选元素"）
function contextIds() {
    const s = state.scope;
    if (!s) return new Set();
    return new Set([
        ...s.context.ancestors.map((c) => c.id),
        ...s.context.siblings.map((c) => c.id),
        ...s.context.edges.map((c) => c.id),
    ]);
}

function renderBadges() {
    const s = state.scope;
    $("b-cells").innerHTML = `cell <b>${state.abstract.cells.length}</b>`;
    const omitted = s?.context?.siblingsOmitted ?? 0;
    if (!s && state.hint) $("b-scope").title = state.hint;
    $("b-scope").innerHTML = `作用域 <b>${s ? s.writable.length : 0}</b> / roots <b>${s ? s.roots.length : 0}</b>`
        + (omitted ? ` <span class="cap" title="扁平图上同层元素 = 全图，邻域按几何邻近度截断，被裁掉的降级为骨架计数（不是消失）">邻域裁剪 ${omitted}</span>` : "");
    $("b-token").innerHTML = s ? `scoped/全量 <b>${(s.estimate.ratio * 100).toFixed(0)}%</b>（${s.estimate.scopedTokens}/${s.estimate.fullTokens}）` : `scoped/全量 <b>-</b>`;
    // token 账单可归因：优化作用域时唯一能下手的地方就是"哪一段吃掉了预算"
    $("b-token").title = s
        ? `分段：可改 ${s.estimate.breakdown.writable} / 邻域 ${s.estimate.breakdown.context} / 骨架 ${s.estimate.breakdown.skeleton} / 约束 ${s.estimate.breakdown.constraint}`
            + `\n骨架承载 ${s.estimate.skeletonCells} 个未列出元素；逐条枚举骨架的版本是 ${s.estimate.fullSkeletonTokens} token`
        : "";
    const g = state.report?.guard;
    const el = $("b-guard");
    if (!g) { el.className = "badge"; el.innerHTML = `guard <b>待运行</b>`; return; }
    const ok = g.intent.ok && (g.result?.ok ?? false) && (g.byteIdentical?.ok ?? false);
    el.className = "badge " + (ok ? "ok" : "bad");
    el.innerHTML = ok
        ? `guard <b>通过</b>（未越界 + 未选中元素逐字节不变）`
        : `guard <b>拒绝</b>`;
}

function renderTree() {
    const tree = $("tree");
    tree.innerHTML = "";
    const writable = writableSet();
    const context = contextIds();
    const byParent = new Map();
    for (const cell of state.abstract.cells) {
        if (!byParent.has(cell.parent)) byParent.set(cell.parent, []);
        byParent.get(cell.parent).push(cell);
    }
    const row = (cell, depth) => {
        const div = document.createElement("div");
        div.className = "row" + (depth ? " child" : "")
            + (writable.has(cell.id) ? " writable" : "")
            + (context.has(cell.id) ? " context" : "")
            + (!writable.has(cell.id) && !context.has(cell.id) ? " skeleton" : "");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = state.selected.has(cell.id);
        cb.onchange = () => { cb.checked ? state.selected.add(cell.id) : state.selected.delete(cell.id); refresh(); };
        const id = document.createElement("span");
        id.className = "id"; id.textContent = cell.id;
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = (cell.kind === "edge" ? "→ " : "") + (cell.label || "(无标签)")
            + (cell.isContainer ? ` [容器 ${cell.childCount}]` : "");
        div.append(cb, id, label);
        tree.append(div);
        for (const child of byParent.get(cell.id) ?? []) row(child, depth + 1);
    };
    for (const cell of byParent.get("1") ?? []) row(cell, 0);
    for (const [parent, children] of byParent) {
        if (parent !== "1" && parent !== null && !state.abstract.cells.some((c) => c.id === parent)) {
            for (const child of children) row(child, 0);
        }
    }
}

function renderSvg() {
    const svg = $("svg");
    const cells = state.abstract.cells.filter((c) => c.geometry && c.kind === "vertex");
    const edges = state.abstract.cells.filter((c) => c.kind === "edge");
    const writable = writableSet();
    const context = contextIds();

    const xs = cells.flatMap((c) => [c.geometry.x, c.geometry.x + c.geometry.width]);
    const ys = cells.flatMap((c) => [c.geometry.y, c.geometry.y + c.geometry.height]);
    const pad = 40;
    const minX = Math.min(...xs, 0) - pad;
    const minY = Math.min(...ys, 0) - pad;
    const w = Math.max(...xs, 0) - minX + pad;
    const h = Math.max(...ys, 0) - minY + pad;
    svg.setAttribute("viewBox", `${minX} ${minY} ${w} ${h}`);

    // 高亮：预览中用"将要改"的那一批（圈在**应用后**的几何上，所以位置就是最终位置）
    const preview = state.pending;
    const diff = state.report?.diff;
    const changed = preview
        ? new Set([...(diff?.changed ?? []), ...(diff?.added ?? [])].map((c) => c.id))
        : state.lastChanged;
    const addedSet = preview ? new Set((diff?.added ?? []).map((c) => c.id)) : state.lastAdded;
    const mark = (id) => (preview ? (addedSet.has(id) ? "将增" : "将改") : (addedSet.has(id) ? "新" : "改"));
    const color = (id) => writable.has(id) ? "#2f9e63" : context.has(id) ? "#3b7dd8" : "#6b7280";
    const parts = [];
    const byId = new Map(cells.map((c) => [c.id, c]));

    // 边：连线用 source/target 的中心；没有端点（自由绘制）就跳过
    for (const e of edges) {
        const a = byId.get(e.source), b = byId.get(e.target);
        if (!a || !b) continue;
        const ax = a.geometry.x + a.geometry.width / 2, ay = a.geometry.y + a.geometry.height / 2;
        const bx = b.geometry.x + b.geometry.width / 2, by = b.geometry.y + b.geometry.height / 2;
        const hot = changed.has(e.id);
        parts.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${hot ? HILITE : color(e.id)}" stroke-width="${hot ? 4 : 2}" marker-end="url(#arrow)" />`);
    }
    // 顶点：容器先画（在底层）
    for (const c of [...cells].sort((p, q) => q.childCount - p.childCount)) {
        const stroke = color(c.id);
        parts.push(
            `<rect data-id="${c.id}" x="${c.geometry.x}" y="${c.geometry.y}" width="${c.geometry.width}" height="${c.geometry.height}" rx="4"` +
            ` fill="${writable.has(c.id) ? "rgba(47,158,99,.18)" : context.has(c.id) ? "rgba(59,125,216,.12)" : "rgba(107,114,128,.10)"}"` +
            ` stroke="${stroke}" stroke-width="${writable.has(c.id) ? 2.5 : 1.5}" />`,
        );
        if (c.label) {
            // 标签也带 data-id：否则点元素的文字会被当成"点空白"（会误清空选择）
            parts.push(`<text data-id="${c.id}" x="${c.geometry.x + c.geometry.width / 2}" y="${c.geometry.y + c.geometry.height / 2}" fill="#e6e8ee" font-size="12" text-anchor="middle" dominant-baseline="middle" style="pointer-events:auto">${escapeXml(c.label)}</text>`);
        }
    }
    // 改动高亮：**最后**画一层不接收事件的描边，盖在最上面（否则被大元素遮住就看不见了）
    for (const c of cells) {
        if (!changed.has(c.id)) continue;
        const pad = 3;
        parts.push(
            `<rect x="${c.geometry.x - pad}" y="${c.geometry.y - pad}" width="${c.geometry.width + pad * 2}" height="${c.geometry.height + pad * 2}" rx="6"` +
            ` fill="none" stroke="${addedSet.has(c.id) ? HILITE_NEW : HILITE}" stroke-width="2" stroke-dasharray="6 3" pointer-events="none" class="hl" />`,
            `<text x="${c.geometry.x - pad}" y="${c.geometry.y - pad - 4}" fill="${addedSet.has(c.id) ? HILITE_NEW : HILITE}" font-size="11" font-weight="600" pointer-events="none">${mark(c.id)}</text>`,
        );
    }
    svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#9aa3b2"/></marker></defs>` + parts.join("");
    positionFloatbar();
}

/**
 * 悬浮指令框跟着选区走（锚在选区左上角上方）。
 * 坐标要做两次换算：viewBox → 屏幕像素 → 相对预览面板（因为它是 absolute 定位在面板里的）。
 */
function positionFloatbar() {
    const bar = $("floatbar");
    const pane = $("preview-pane");
    const picked = state.abstract?.cells.filter((c) => state.selected.has(c.id) && c.geometry && c.kind === "vertex") ?? [];
    if (!picked.length) { bar.hidden = true; return; }
    const svg = $("svg");
    const ctm = svg.getScreenCTM();
    if (!ctm) { bar.hidden = true; return; }
    const paneRect = pane.getBoundingClientRect();
    const x0 = Math.min(...picked.map((c) => c.geometry.x));
    const y0 = Math.min(...picked.map((c) => c.geometry.y));
    // 世界坐标 → 屏幕像素：同样交给浏览器算（之前手算缩放，cat-demo 上会飘出去）
    const p = svg.createSVGPoint(); p.x = x0; p.y = y0;
    const screen = p.matrixTransform(ctm);
    const left = screen.x - paneRect.left;
    const top = screen.y - paneRect.top;
    bar.hidden = false;
    bar.style.left = `${Math.max(6, Math.min(left, paneRect.width - bar.offsetWidth - 6))}px`;
    bar.style.top = `${Math.max(4, top - bar.offsetHeight - 10)}px`;
    $("fl-count").textContent = String(state.selected.size);
}

/**
 * 执行一句自然语言指令。**一个入口**：命中规则就地执行，没命中就直接交给模型，
 * 用户不需要知道也不需要选择"走哪条通道"——执行完用一句话告诉他刚才走的是哪条。
 */
async function runInstruction() {
    const text = $("instr").value.trim();
    if (!text) return;
    if (!state.selected.size) { alert("先在预览或大纲里选几个元素"); return; }
    $("instr-go").disabled = true;
    $("instr-hint").textContent = "执行中…（没命中规则时会调用模型，通常几秒）";
    try {
        state.report = await post("/api/instruct", {
            xml: state.xml, roots: [...state.selected],
            includeEdges: $("edges").checked ? "connected" : "internal",
            instruction: text,
            dryRun: confirmMode(),
        });
        state.report.__mode = `指令：${text}`;
        const how = landEdit(state.report, { label: `指令「${text}」` });
        $("instr-hint").innerHTML = channelText(state.report, how);
        $("instr").value = "";
        await refresh();
        renderReport();
    } catch (err) {
        $("instr-hint").textContent = `失败：${err.message}`;
    } finally {
        $("instr-go").disabled = false;
    }
}

/** 一句话说清"刚才走的是哪条通道 + 结果如何"。这是产品明确要求的通知，不是调试信息。 */
function channelText(r, how) {
    const tail = how === "applied" ? " → <b>已应用</b>"
        : how === "preview" ? ' → 已生成预览，点"应用"写入' : "";
    const head = r.channel === "rule" ? `走<b>确定性规则</b>：${escapeXml(r.plan?.why ?? "")}（没有调用模型）`
        : r.channel === "none" ? "规则没命中，且生成式通道<b>未配置</b>（服务端没有 DEEPSEEK_API_KEY）"
            : r.channel === "generative"
                ? `规则没命中 → 走<b>大模型</b>（${escapeXml(r.model ?? "")}）：`
                    + (r.wouldApply ? `产出 ${r.ops?.length ?? 0} 个 op，尝试 ${r.attempts ?? 0} 次`
                        + (r.usage?.total_tokens ? `，${r.usage.total_tokens} token` : "") : `被拒（${escapeXml(r.summary ?? "")}）`)
                : escapeXml(r.summary ?? "");
    return head + tail;
}

const HILITE = "#ffa94d";   // 改动高亮色（和三层作用域的颜色区分开）
const HILITE_NEW = "#2f9e63";

/**
 * 一条写入怎么显示。两种形态：
 *   属性写入 → {attrs:{...}}（确定性命令走这条）；
 *   结构性写入 → {attrs:null, structural:{kind:'update'|'delete'|'add'}}（生成式通道走这条）。
 * 后者没有 attrs —— 早期版本直接 Object.entries(w.attrs) 会抛异常，把整个报告面板打没了。
 */
function writeDetail(w) {
    if (w.structural) {
        const k = w.structural.kind;
        if (k === "add") return `新增元素（挂在 <code>${escapeXml(w.structural.parentId ?? "1")}</code> 下）`;
        if (k === "update") return "整段替换该元素（改文字/形状/几何）";
        if (k === "delete") return "删除该元素";
        return escapeXml(k);
    }
    return escapeXml(Object.entries(w.attrs ?? {}).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(" · "));
}   // 改动高亮色（和三层作用域的颜色区分开）
const escapeXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---- 预览里的点选与框选 ----
// 交互约定（对齐 draw.io 的直觉）：
//   点空白 = 清空选择 ｜ 点元素 = 切换该元素 ｜ 拖拽 = 框选 ｜ Shift+框选 = 加选 ｜ Esc = 清空
// 两个坑：① "点"和"拖"必须靠位移阈值区分（手抖会把点击变成框选，框出一个 0×0 的空框）；
//        ② 从元素上按下也能拖框选，所以不能在 mousedown 时就切换选中状态，要等 pointerup。
const svgEl = $("svg");
const DRAG_THRESHOLD = 4;   // px

/**
 * 客户端坐标 → viewBox 坐标。
 *
 * **不要自己算缩放**。`index.html` 给 SVG 设的是 `preserveAspectRatio="xMinYMin meet"`：
 * 浏览器会**等比缩放** `scale = min(rect.w/vb.w, rect.h/vb.h)` 并锚在左上角。
 * 于是"按宽度算"只在这条轴恰好是约束轴时才成立：
 *   · small-flow / aws-demo 的 viewBox 比面板"更宽" → 宽度是约束轴 → 恰好对；
 *   · cat-demo（520×600 放进 779×841）是**高度**约束 → 按宽度算出来的缩放偏小 6.4%，
 *     误差随离左上角的距离线性放大（实测拖拽框 `(288,456,93,28)`，而元素真实位置是 `(310,490,100,30)`）。
 * `getScreenCTM()` 是浏览器给出的权威变换（缩放 + 锚点都在里面），直接拿它做逆变换，任何 viewBox 都对。
 */
const toViewBox = (clientX, clientY) => {
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };              // 还没渲染（display:none）时给个安全值
    const p = svgEl.createSVGPoint();
    p.x = clientX; p.y = clientY;
    const q = p.matrixTransform(ctm.inverse());
    return { x: q.x, y: q.y };
};

let drag = null;

svgEl.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;                      // 只认左键
    // 拖拽全程用**客户端坐标**记录：换算交给 toViewBox（它拿的是浏览器权威变换）
    drag = {
        hitId: ev.target.closest("[data-id]")?.dataset.id ?? null,
        x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY,
        moved: false, box: null, additive: ev.shiftKey,
    };
    svgEl.setPointerCapture?.(ev.pointerId);
});

svgEl.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    drag.x1 = ev.clientX; drag.y1 = ev.clientY;
    if (!drag.moved && Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) < DRAG_THRESHOLD) return;
    drag.moved = true;
    if (!drag.box) {
        drag.box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        drag.box.setAttribute("fill", "rgba(59,125,216,.15)");
        drag.box.setAttribute("stroke", "#3b7dd8");
        drag.box.setAttribute("stroke-dasharray", "4 3");
        drag.box.setAttribute("pointer-events", "none");
        svgEl.append(drag.box);
    }
    const a = toViewBox(drag.x0, drag.y0), b = toViewBox(ev.clientX, ev.clientY);
    drag.box.setAttribute("x", Math.min(a.x, b.x)); drag.box.setAttribute("y", Math.min(a.y, b.y));
    drag.box.setAttribute("width", Math.abs(b.x - a.x)); drag.box.setAttribute("height", Math.abs(b.y - a.y));
});

svgEl.addEventListener("pointerup", (ev) => {
    const d = drag;
    drag = null;
    if (!d) return;
    svgEl.releasePointerCapture?.(ev.pointerId);

    if (!d.moved) {
        // 点击：元素 → 切换；空白 → 清空（"点了空白就取消选择"，这是最直觉的一条）
        if (d.hitId) {
            state.selected.has(d.hitId) ? state.selected.delete(d.hitId) : state.selected.add(d.hitId);
            refresh();
        } else if (state.selected.size) {
            state.selected.clear();
            refresh();
        }
        return;
    }

    d.box?.remove();
    const a = toViewBox(d.x0, d.y0), b = toViewBox(d.x1, d.y1);
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    // 框选默认**替换**选择（和 draw.io 一致）；想累加就按住 Shift
    if (!d.additive) state.selected.clear();
    for (const c of state.abstract.cells) {
        if (!c.geometry || c.kind !== "vertex") continue;
        const inside = c.geometry.x >= x0 && c.geometry.y >= y0
            && c.geometry.x + c.geometry.width <= x1 && c.geometry.y + c.geometry.height <= y1;
        if (inside) state.selected.add(c.id);
    }
    refresh();
});

// 右键元素 = "我就想改这个"：先把它选上，再唤起悬浮指令框（对齐产品设想里的右键→局部修改）
svgEl.addEventListener("contextmenu", (ev) => {
    const hit = ev.target.closest("[data-id]")?.dataset.id ?? null;
    ev.preventDefault();
    if (hit && !state.selected.has(hit)) { state.selected.add(hit); refresh(); }
    if (state.selected.size) setTimeout(() => $("instr").focus(), 30);
});

$("instr-go").onclick = runInstruction;
$("instr").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") runInstruction();
    ev.stopPropagation();   // 别让 Esc/Ctrl+Z 在输入框里被抢走（Esc 仍然冒泡给全局）
});

// Esc 清空（点空白之外的第二条退路；键盘用户不必去点"清空"按钮）
document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && document.activeElement?.id === "instr") return;   // 先让输入框处理 Esc
    // 预览中：Esc / Ctrl+Z 先把这次**尚未写入**的预览取消掉（而不是去动已提交的历史）
    if (state.pending && (ev.key === "Escape" || ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z"))) {
        ev.preventDefault();
        cancelPending();
        return;
    }
    if (ev.key === "Escape" && state.selected.size) { state.selected.clear(); refresh(); }
    // Ctrl/Cmd+Z 撤销本轮（和画布里一次写回 = 一条撤销记录对齐）
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") { ev.preventDefault(); undo(); }
});

// ---- 命令面板 ----
const ALIGNS = [["left", "左对齐"], ["center", "水平居中"], ["right", "右对齐"], ["top", "顶对齐"], ["middle", "垂直居中"], ["bottom", "底对齐"]];
function renderCommands() {
    const cmds = $("cmds");
    cmds.innerHTML = "";
    const mk = (label, fn, primary = false) => {
        const b = document.createElement("button");
        b.textContent = label;
        if (primary) b.className = "primary";
        b.onclick = fn;
        return b;
    };
    const grp = (title, ...nodes) => {
        const d = document.createElement("div");
        d.className = "grp";
        const s = document.createElement("span"); s.textContent = title; d.append(s);
        for (const n of nodes) d.append(n);
        cmds.append(d);
    };
    grp("对齐", ...ALIGNS.map(([mode, label]) => mk(label, () => run("align", { mode }))));
    grp("分布", mk("水平等距", () => run("distribute", { axis: "x" })), mk("垂直等距", () => run("distribute", { axis: "y" })));
    grp("尺寸", mk("等宽", () => run("size", { mode: "width" })), mk("等高", () => run("size", { mode: "height" })), mk("等大小", () => run("size", { mode: "both" })));
    const fill = document.createElement("input"); fill.type = "color"; fill.value = "#ffe6cc";
    const font = document.createElement("input"); font.type = "number"; font.value = "16"; font.style.width = "48px"; font.title = "字号";
    grp("样式", fill, mk("刷填充色", () => run("style", { props: { fillColor: fill.value } })),
        font, mk("改字号", () => run("style", { props: { fontSize: font.value } })),
        mk("加粗圆角", () => run("style", { props: { rounded: "1", fontStyle: "1" } })));
    const dx = document.createElement("input"); dx.type = "number"; dx.value = "20"; dx.style.width = "54px"; dx.title = "dx";
    const dy = document.createElement("input"); dy.type = "number"; dy.value = "0"; dy.style.width = "54px"; dy.title = "dy";
    grp("移动", dx, dy, mk("平移选中", () => run("move", { dx: dx.value, dy: dy.value })));
    grp("本轮", mk("撤销本轮（Ctrl+Z）", undo), mk("重载样例（丢弃改动）", () => loadSample($("sample").value)));
    grp("guard 演示", mk("发一批越界 ops（模拟模型不听话）", tamper, true));
}

async function tamper() {
    if (!state.scope) { alert("先在左边或预览里选几个元素"); return; }
    const outside = state.abstract.cells.find((c) => !state.scope.writable.includes(c.id));
    if (!outside) return;
    const ops = [
        { kind: "update", cellId: outside.id, xml: `<mxCell id="${outside.id}" value="被越界改写" vertex="1" parent="1"/>` },
        { kind: "style", cellIds: [outside.id], props: { fillColor: "#ff0000" } },
    ];
    state.report = await post("/api/apply-ops", {
        xml: state.xml, roots: [...state.selected], includeEdges: $("edges").checked ? "connected" : "internal", ops,
        dryRun: true,                                  // 演示也不能真写：只给"会不会被拒"的结论
    });
    state.report.__mode = "tamper";
    landEdit(state.report, { label: "越界 ops" });
    await refresh();
    renderReport();
}

async function run(command, params) {
    if (!state.selected.size) { alert("先在左边或预览里选几个元素"); return; }
    state.report = await post("/api/command", {
        xml: state.xml, roots: [...state.selected],
        includeEdges: $("edges").checked ? "connected" : "internal",
        command, params,
        dryRun: true,                                  // 一律先出确认单，再由用户点"应用"
    });
    state.report.__mode = command;
    landEdit(state.report, { label: labelOfCommand(command, params) });
    await refresh();
    renderReport();
}

const labelOfCommand = (command, params) => {
    const map = { align: "对齐", distribute: "分布", size: "等尺寸", move: "移动", style: "改样式" };
    const detail = (params?.mode ?? params?.axis
        ?? (params?.props ? Object.entries(params.props).map(([k, v]) => `${k}=${v}`).join(",") : ""))
        || (params?.dx !== undefined ? `dx=${params.dx},dy=${params.dy}` : "");
    return `${map[command] ?? command}${detail ? ` ${detail}` : ""}`;
};

/**
 * 暂存一次编辑 → 出"确认单"。**这一步不碰 XML、不进撤销栈**：
 * 服务端已经算完了整条流水线（含结果层复核与字节级核对），我们只是把结论拿在手里等用户点头。
 *
 * 为什么要有这一步：选中一个容器就点"左对齐"，在 aws-demo 上会改到 88% 的图。
 * 用户得先看见"将改 N 个元素"再决定，而不是点完才发现改多了（再撤销）。
 */
function landEdit(report, meta) {
    // 被拒的 / 没有产出的：没有可落地的东西
    if (!report?.after?.xml || !(report.applied || report.wouldApply)) { state.pending = null; return false; }
    // 默认**直接落地**（一步到位：说一句 → 结果直接应用 → 一句话告诉你走的规则还是模型）。
    // 只有勾了「先预览再应用」才走确认单 —— 这是给"选中一整个容器"这类大范围改动留的刹车。
    if (!confirmMode()) {
        commitEdit(report.after.xml, report.diff, meta.label, report.summary);
        return "applied";
    }
    state.pending = { label: meta.label, key: scopeKey(), afterXml: report.after.xml, diff: report.diff };
    return "preview";
}

/** 「先预览再应用」开关（默认关：一步到位的直接应用才是默认体验） */
const confirmMode = () => Boolean($("confirm-mode")?.checked);

/** 真正的落地动作：写 XML、入撤销栈、点亮"改了谁"（预览确认与直接应用共用这一条路） */
function commitEdit(afterXml, diff, label, summary) {
    state.history.push({ xml: state.xml, label, at: new Date() });
    if (state.history.length > 30) state.history.shift();
    state.xml = afterXml;
    $("out").value = state.xml;
    state.lastChanged = new Set([...(diff?.changed ?? []), ...(diff?.added ?? [])].map((c) => c.id));
    state.lastAdded = new Set((diff?.added ?? []).map((c) => c.id));
    state.lastSummary = summary ?? "";
    state.pending = null;
}

/**
 * 点"应用"：把预览里的 XML 落成当前 XML、入撤销栈、点亮改动高亮。
 * 撤销栈存的是**这一次编辑之前的完整 XML** —— 作用域编辑的粒度就是"一轮"，
 * 而画布那边（S3 实测）一次写回也只产生一条撤销记录，两边语义对齐。
 */
function applyPending() {
    const p = state.pending;
    if (!p) return;
    commitEdit(p.afterXml, p.diff, p.label, state.report?.summary);
    state.report = { ...(state.report ?? {}), committed: true };
    refresh().then(renderReport);
}

/** 点"取消"（或按 Esc / Ctrl+Z）：预览作废，画布回到当前 XML */
function cancelPending() {
    const p = state.pending;
    if (!p) return;
    state.pending = null;
    state.report = { ...(state.report ?? {}), cancelled: true, cancelledLabel: p.label };
    refresh().then(renderReport);
}

function undo() {
    state.pending = null;          // 撤销和"待确认的预览"语义冲突：先作废预览，别让用户以为撤销的是预览
    const prev = state.history.pop();
    if (!prev) return;
    state.xml = prev.xml;
    $("out").value = prev.xml;
    state.lastChanged = new Set();
    state.lastAdded = new Set();
    state.report = { ...(state.report ?? {}), __mode: "undo", undone: prev.label };
    refresh().then(renderReport);
}

function renderReport() {
    const r = state.report;
    const el = $("report");
    if (!r) {
        el.innerHTML = `<div class="panel"><h3>报告</h3><div class="content small">${escapeXml(state.hint ?? "选几个元素，点上面的命令。")}</div></div>`;
        return;
    }
    const g = r.guard;
    const ok = g.intent.ok && (g.result?.ok ?? false) && (g.byteIdentical?.ok ?? false);
    const p = state.pending;      // 有 pending = 这份报告还停在"预览"，没写入
    // 四种状态必须能一眼分清：预览中 / 已应用 / 被拒 / 已取消
    // "没命中规则"不是"被拒绝"：前者是还没轮到执行，后者是越界被拦下来。混在一句里会让人以为出了错。
    const notRun = r.plan && !r.matched;
    const status = r.cancelled ? "已取消（未写入）"
        : p ? "预览：等确认（尚未写入）"
            : ok ? "已应用"
                : notRun ? "未执行（这句话没命中确定性规则，也没有交给模型）"
                    : "被拒绝（未写入）";
    const rows = [];
    rows.push(`<tr><th>结果</th><td class="${ok || notRun ? "" : "rej"}">${status}${r.ms != null ? ` · ${r.ms}ms` : ""}</td></tr>`);
    rows.push(`<tr><th>通道</th><td>${r.channel === "rule" ? `确定性规则（${escapeXml(r.plan?.why ?? "")}）· 没调用模型`
        : r.channel === "generative" ? `大模型 <code>${escapeXml(r.model ?? "")}</code> · 尝试 ${r.attempts ?? 0} 次`
            : r.channel === "none" ? `<span class="warn">未执行（规则没命中，且生成式通道未配置）</span>`
                : "命令面板（确定性）"}</td></tr>`);
    rows.push(`<tr><th>意图层</th><td>${g.intent.ok ? "通过" : "拒绝"} · 检查 ${g.intent.checkedOps ?? 0} 个 op</td></tr>`);
    if (!g.intent.ok && !g.result) rows.push(`<tr><th>说明</th><td class="warn">${escapeXml(r.warnings?.[0] ?? "")}</td></tr>`);
    if (g.result) rows.push(`<tr><th>结果层</th><td>实际改动 <code>${g.result.changed.join(", ") || "无"}</code> · 越界 <code>${g.result.outOfScope.join(", ") || "无"}</code></td></tr>`);
    if (g.byteIdentical) rows.push(`<tr><th>字节级</th><td>未选中元素逐字节不变：${g.byteIdentical.ok ? `<span class="ok">是</span>` : `<span class="rej">否</span>`}（核对了 ${g.byteIdentical.checked} 个 cell）</td></tr>`);
    const rej = g.intent.rejected ?? [];
    if (rej.length) {
        rows.push(`<tr><th>拒绝明细</th><td class="rej">${rej.map((x) => escapeXml(x.reason)).join("<br>")}</td></tr>`);
    }
    const warns = r.warnings ?? [];
    const d = r.diff;
    const diffs = d && d.total
        ? `<div class="panel"><h3>改动账本 · ${d.total} 个元素</h3><div class="content">
            <div class="small" style="margin-bottom:4px">${escapeXml(r.summary ?? "")}</div>
            <table>
              ${d.added.map((c) => `<tr><th><code>${escapeXml(c.id)}</code></th><td class="hint">新增</td><td>${escapeXml(c.label)}</td></tr>`).join("")}
              ${d.removed.map((c) => `<tr><th><code>${escapeXml(c.id)}</code></th><td class="hint">删除</td><td>${escapeXml(c.label)}</td></tr>`).join("")}
              ${d.changed.map((c) => c.fields.map((f, i) => `<tr>
                  <th>${i === 0 ? `<code>${escapeXml(c.id)}</code>` : ""}</th>
                  <td><code>${escapeXml(f.name)}</code></td>
                  <td><span class="hint">${escapeXml(String(f.from ?? "∅"))}</span> → <b>${escapeXml(String(f.to ?? "∅"))}</b>${f.delta !== undefined ? ` <span class="hint">(${f.delta > 0 ? "+" : ""}${f.delta})</span>` : ""}</td>
                </tr>`).join("")).join("")}
            </table>
          </div></div>`
        : "";
    const confirmBar = p
        ? `<div class="panel confirm"><h3>确认单：将改 ${r.diff?.total ?? 0} 个元素</h3><div class="content">
            <div class="small" style="margin-bottom:6px">${escapeXml(r.summary ?? "")}</div>
            <div class="cmds"><button class="primary" id="apply-btn">应用 · ${escapeXml(p.label)}</button>
              <button id="cancel-btn">取消（Esc）</button>
              <span class="small hint">画布上是<strong>应用后</strong>的样子；下面的"当前 XML"还没变，应用后才写入（可撤销）</span></div>
          </div></div>`
        : "";
    const staleNote = r.stale
        ? `<div class="warn small" style="margin-bottom:6px">选区或 XML 变了，之前那份预览已作废（没有写入任何东西）。</div>`
        : "";
    const undoBar = state.history.length
        ? `<div class="cmds" style="margin-bottom:6px"><button class="primary" id="undo-btn">撤销本轮（${escapeXml(state.history[state.history.length - 1].label)}）· Ctrl+Z</button>
            <span class="small hint">还可撤销 ${state.history.length} 步</span></div>`
        : "";
    const title = r.__mode === "tamper" ? "guard 演示：客户端直接塞越界 ops"
        : r.__mode === "undo" ? `已撤销：${escapeXml(r.undone ?? "")}`
            : r.cancelled ? `已取消：${escapeXml(r.cancelledLabel ?? "")}`
                : r.committed ? `已应用：${escapeXml(r.__mode ?? "")}`
                    : `执行 ${escapeXml(r.__mode ?? "")}`;
    const html = `
      ${staleNote}
      ${confirmBar}
      ${undoBar}
      <div class="panel">
        <h3>${title}</h3>
        <div class="content"><table>${rows.join("")}</table>
        ${warns.length ? `<div class="warn small" style="margin-top:6px">提示：${warns.map(escapeXml).join("；")}</div>` : ""}
        </div>
      </div>
      ${r.ops ? `<div class="panel"><h3>Op（可审计的意图）</h3><div class="content"><pre>${escapeXml(JSON.stringify(r.ops, null, 1))}</pre></div></div>` : ""}
      ${diffs}
      ${r.prompt && r.channel === "none" ? `<div class="panel"><h3>生成式通道未配置 · 这是"本来会发给模型"的载荷（${r.estimate?.scopedTokens ?? "?"} token，全量 ${r.estimate?.fullTokens ?? "?"}）</h3>
        <div class="content"><div class="small" style="margin-bottom:4px">服务端没读到 DEEPSEEK_API_KEY，所以这句话没能交给模型。下面是按 §5.4 契约拼出来的载荷 —— 作用域把什么交给模型、花多少 token，仍然是可见的。</div>
        <pre>${escapeXml(r.prompt)}</pre></div></div>` : ""}
      ${r.channel === "generative" ? `<div class="panel"><h3>生成式通道 · ${escapeXml(r.model ?? "")}（尝试 ${r.attempts ?? 0} 次）</h3><div class="content"><table>
        ${r.usage ? `<tr><th>token</th><td>prompt ${r.usage.prompt_tokens ?? "?"} · completion ${r.usage.completion_tokens ?? "?"} · 合计 <b>${r.usage.total_tokens ?? "?"}</b></td></tr>` : ""}
        ${r.scopedTokens ? `<tr><th>作用域占比</th><td>${r.scopedTokens}/${r.fullTokens}（<b>${((r.scopedTokens / r.fullTokens) * 100).toFixed(1)}%</b>）</td></tr>` : ""}
        <tr><th>重试</th><td>${(r.modelLog ?? []).map((l) => `第 ${l.attempt} 次：${l.ok ? "通过" : `被拒（${escapeXml(l.stage)}）`}`).join(" · ") || "无"}</td></tr>
        ${(r.modelLog ?? []).filter((l) => !l.ok).map((l) => `<tr><th>第 ${l.attempt} 次原因</th><td class="rej">${[...(l.errors ?? []), ...(l.rejected ?? [])].map(escapeXml).join("<br>")}</td></tr>`).join("")}
        ${r.usage ? "" : `<tr><th>说明</th><td class="warn small">没有 usage（模型接口没回 token 统计，或调用失败）</td></tr>`}
      </table></div></div>` : ""}
      ${r.changedCells?.length ? `<div class="panel"><h3>落到 XML 上的写入</h3><div class="content"><table>
         ${r.writes.map((w) => `<tr><th><code>${escapeXml(w.cellId)}</code></th><td>${writeDetail(w)}</td></tr>`).join("")}
      </table></div></div>` : ""}
    `;
    el.innerHTML = html;
    const ub = $("undo-btn");
    if (ub) ub.onclick = undo;
    const ab = $("apply-btn");
    if (ab) ab.onclick = applyPending;
    const cb = $("cancel-btn");
    if (cb) cb.onclick = cancelPending;
    renderBadges();
}

// ---- 顶部工具栏 ----
$("sample").onchange = (e) => loadSample(e.target.value);
$("edges").onchange = () => refresh();
$("sel-none").onclick = () => { state.selected.clear(); refresh(); };
$("sel-vertices").onclick = () => {
    for (const c of state.abstract.cells) if (c.kind === "vertex") state.selected.add(c.id);
    refresh();
};
$("sel-layer").onclick = () => {
    for (const c of state.abstract.cells) if (c.parent === "1") state.selected.add(c.id);
    refresh();
};

state.meta = await (await fetch("/api/meta")).json();
renderCommands();
await loadSample("small-flow");
