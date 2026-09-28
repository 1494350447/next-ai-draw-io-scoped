// 确定性命令通道（零 LLM）：对齐 / 分布 / 等尺寸 / 移动 / 样式。
//
// 这一层的存在意义是"快、准、免费"：用户选中几个元素后最常想做的事（对齐、统一大小、刷个颜色）
// 根本不需要模型，直接产出可审计的 Op 更好 —— 确定性、无幻觉、不吃配额。
// 产出的 Op 形状对齐设计文档 §5.3，后续 Phase 2 由插件在同一事务里落地（一次写回 = 一条撤销记录）。

import { parseStyle, serializeStyle } from "./model.mjs";
import { cellRefsFromXml, encodeAttr, parseXml } from "./xml.mjs";

export const STYLE_PROPS = [
    { key: "fillColor", label: "填充色", type: "color", def: "#dae8fc" },
    { key: "strokeColor", label: "描边色", type: "color", def: "#6c8ebf" },
    { key: "fontColor", label: "文字色", type: "color", def: "#000000" },
    { key: "strokeWidth", label: "描边宽度", type: "number", def: "2" },
    { key: "fontSize", label: "字号", type: "number", def: "14" },
    { key: "fontStyle", label: "字体样式", type: "number", def: "1" },   // 位掩码：1 粗体 / 2 斜体 / 4 下划线（drawio 约定）
    { key: "opacity", label: "不透明度", type: "number", def: "50" },
    { key: "rounded", label: "圆角", type: "flag", def: "1" },
    { key: "shadow", label: "阴影", type: "flag", def: "1" },
    { key: "dashed", label: "虚线", type: "flag", def: "1" },
    // shape 是"形状名"（drawio 的样式键）：加进白名单后，"改成数据库形状"这类诉求能走确定性通道
    { key: "shape", label: "形状", type: "text", def: "cylinder3" },
];

const ALIGN_MODES = ["left", "center", "right", "top", "middle", "bottom"];

/** 选中元素里"可以参与几何运算"的（顶点 + 有 geometry），按父容器分组 */
function geometryGroups(diagram, scope, warnings) {
    const byParent = new Map();
    for (const id of scope.roots) {
        const cell = diagram.get(id);
        if (!cell) continue;
        if (!cell.isVertex) { continue; }
        if (!cell.geometryNode) {
            warnings.push(`${id} 没有 <mxGeometry>，跳过几何运算`);
            continue;
        }
        const key = cell.parent ?? "(无父)";
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(cell);
    }
    if (byParent.size > 1) {
        warnings.push("选中的元素不在同一个父容器里：几何运算按父容器分组后各自进行（坐标是相对父容器的）");
    }
    return byParent;
}

function groupBox(cells) {
    const box = { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity };
    for (const c of cells) {
        box.x = Math.min(box.x, c.geometry.x);
        box.y = Math.min(box.y, c.geometry.y);
        box.right = Math.max(box.right, c.geometry.x + c.geometry.width);
        box.bottom = Math.max(box.bottom, c.geometry.y + c.geometry.height);
    }
    return { ...box, width: box.right - box.x, height: box.bottom - box.y };
}

/**
 * 给新元素取一个**图里没被占用**的 id。
 * add 的 id 由服务端定（插件照搬），所以必须自己保证唯一 —— 撞 id 会让新元素顶掉旧的。
 */
function nextFreeId(diagram, prefix) {
    for (let i = 1; i < 10000; i++) {
        const candidate = `${prefix}-${i}`;
        if (!diagram.get(candidate)) return candidate;
    }
    throw new Error(`取不到空闲 id（前缀 ${prefix}）`);
}

/** 锚点：bbox（选区包围盒，默认）/ first（第一个选中）/ largest（面积最大） */
function pickAnchor(cells, anchor) {
    if (anchor === "first") return cells[0];
    if (anchor === "largest") {
        return cells.reduce((a, b) => (
            b.geometry.width * b.geometry.height > a.geometry.width * a.geometry.height ? b : a
        ));
    }
    return null; // bbox
}

/**
 * 执行一条命令，产出 Op（不改文档）。
 * @returns {{ops: object[], warnings: string[]}}
 */
export function runCommand(diagram, scope, command, params = {}) {
    const warnings = [];
    const writable = new Set(scope.writable);

    if (command === "style") {
        const props = params.props ?? {};
        const known = new Set(STYLE_PROPS.map((p) => p.key));
        const clean = {};
        for (const [k, v] of Object.entries(props)) {
            if (!known.has(k)) { warnings.push(`样式 ${k} 不在白名单里，已忽略`); continue; }
            if (v === null || v === undefined || v === "") continue;
            clean[k] = String(v);
        }
        if (!Object.keys(clean).length) return { ops: [], warnings: [...warnings, "没有要设置的样式"] };
        // targets: roots（只改选中的，不含子孙/边）｜ vertices（改形状，不含连线）｜ 默认全部 writable
        // 为什么要有 vertices：填充色/圆角这类属性对连线是空操作，写进去只会让"改动账本"变脏
        const targets = params.targets === "roots" ? scope.roots
            : params.targets === "vertices" ? [...writable].filter((id) => diagram.get(id)?.isVertex)
                : [...writable];
        return { ops: [{ kind: "style", cellIds: targets, props: clean }], warnings };
    }

    const groups = geometryGroups(diagram, scope, warnings);
    const ops = [];

    if (command === "move") {
        const dx = Number(params.dx ?? 0);
        const dy = Number(params.dy ?? 0);
        if (!dx && !dy) return { ops: [], warnings: [...warnings, "dx/dy 都是 0"] };
        for (const cells of groups.values()) {
            ops.push({ kind: "move", cellIds: cells.map((c) => c.id), params: { dx, dy } });
        }
        return { ops, warnings };
    }

    if (command === "align") {
        const mode = params.mode ?? "left";
        if (!ALIGN_MODES.includes(mode)) throw new Error(`未知的对齐方式 ${mode}`);
        const anchor = params.anchor ?? "bbox";
        for (const cells of groups.values()) {
            if (cells.length < 2) { warnings.push("对齐至少要选中 2 个元素"); continue; }
            const base = pickAnchor(cells, anchor);
            const box = base ? null : groupBox(cells);
            ops.push({
                kind: "align",
                cellIds: cells.map((c) => c.id),
                params: {
                    mode,
                    anchor,
                    reference: base ? { id: base.id } : { box: { x: box.x, y: box.y, centerX: box.x + box.width / 2, centerY: box.y + box.height / 2, right: box.right, bottom: box.bottom } },
                },
            });
        }
        return { ops, warnings };
    }

    if (command === "distribute") {
        const axis = params.axis ?? "x";
        for (const cells of groups.values()) {
            if (cells.length < 3) { warnings.push("分布至少要选中 3 个元素"); continue; }
            ops.push({ kind: "distribute", cellIds: cells.map((c) => c.id), params: { axis } });
        }
        return { ops, warnings };
    }

    if (command === "size") {
        const mode = params.mode ?? "both";
        const anchor = params.anchor ?? "largest";
        for (const cells of groups.values()) {
            if (cells.length < 2) { warnings.push("统一尺寸至少要选中 2 个元素"); continue; }
            const base = pickAnchor(cells, anchor) ?? cells.reduce((a, b) => (
                b.geometry.width * b.geometry.height > a.geometry.width * a.geometry.height ? b : a));
            ops.push({
                kind: "size",
                cellIds: cells.map((c) => c.id),
                params: { mode, anchor, reference: { id: base.id, width: base.geometry.width, height: base.geometry.height } },
            });
        }
        return { ops, warnings };
    }

    // "变成正方形"：宽高统一到**长边**。
    // 为什么取长边而不是短边/宽度：① 不会把元素缩到比原来还窄；② 与"等大"命令取"面积最大者"的口径一致。
    // 按元素各自算（不是全选区统一一个尺寸）—— "这几个都变成正方形"就是要每个自己变方。
    if (command === "square") {
        const targets = (params.targets === "writable" ? [...writable] : [...scope.roots])
            .map((id) => diagram.get(id))
            .filter((c) => c && c.isVertex && c.geometry);
        if (!targets.length) return { ops: [], warnings: ["没有可改尺寸的顶点（先选中要改的元素）"] };
        return { ops: targets.map((c) => ({ kind: "square", cellId: c.id })), warnings };
    }

    // ---- 结构性命令（③ 增删元素）----
    // 与上面的几何/样式命令不同，这两条会改变"图里有哪些元素"。
    // 纪律不变：**只动用户选中的那几个 roots**，不主动扩展到子孙（删容器连带子孙是 drawio 的语义，
    // 但"选一个框整棵子树没了"太容易误伤；要删子孙就让用户自己选中它们）。
    if (command === "delete") {
        const targets = (params.targets === "writable" ? [...writable] : [...scope.roots])
            .filter((id) => diagram.get(id));
        if (!targets.length) return { ops: [], warnings: ["没有可删除的元素（先选中要删的）"] };
        return { ops: targets.map((cellId) => ({ kind: "delete", cellId })), warnings };
    }

    if (command === "add") {
        // "在旁边加一个同色圆角框"：位置算在选区右侧，**尺寸与样式抄选区里的第一个顶点**。
        // 关键约束：坐标是相对父容器的，所以新元素必须挂在与参照物**同一个父容器**下，否则位置会飞。
        const roots = scope.roots.map((id) => diagram.get(id)).filter((c) => c && c.isVertex && c.geometry);
        const fallback = [...writable].map((id) => diagram.get(id)).filter((c) => c && c.isVertex && c.geometry);
        const src = (roots.length ? roots : fallback)[0];
        if (!src) return { ops: [], warnings: ["没有可参照的元素（先选中一个元素，新元素按它的位置/样式来）"] };
        const refs = roots.length ? roots : [src];
        const box = groupBox(refs);
        const parentId = String(params.parentId ?? src.parent ?? "1");
        if (!diagram.get(parentId)) return { ops: [], warnings: [`add 的父容器 ${parentId} 不在图中`] };
        const gap = Number(params.gap ?? 60);
        const width = Number(params.width ?? src.geometry.width);
        const height = Number(params.height ?? src.geometry.height);
        const x = Math.round(Number(params.x ?? box.right + gap));
        const y = Math.round(Number(params.y ?? box.y));
        const style = String(params.style ?? src.style ?? "");
        const value = String(params.label ?? "新建");
        const id = nextFreeId(diagram, String(params.idPrefix ?? "ai-add"));
        const xml = `<mxCell id="${encodeAttr(id)}" value="${encodeAttr(value)}" style="${encodeAttr(style)}" vertex="1" parent="${encodeAttr(parentId)}">` +
            `<mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/></mxCell>`;
        // 除了 xml（审计与原型自己的 applier 用），再给一份**部件**：插件据此直接调 mxGraph 的
        // insertVertex 建元素，不必在浏览器里解 XML（少一层解析、也避开 mxCodec 单独解 cell 时的告警）。
        return {
            ops: [{ kind: "add", cellId: id, parentId, xml, value, style, x, y, width, height }],
            warnings,
        };
    }

    throw new Error(`未知命令 ${command}`);
}

/**
 * Op -> 具体的属性写入（服务端算，客户端不参与）。
 * 与 runCommand 分开是刻意的：Op 是"意图记录"（可审计、可回灌给模型），
 * writes 是"落到 XML 属性上的结果"，guard 与 byte-identical 校验都看这一层。
 */
export function opsToWrites(diagram, ops) {
    const writes = new Map();      // cellId -> {x?,y?,width?,height?,style?}
    const structural = new Map();  // cellId -> {kind:'update'|'delete'|'add', xml?, parentId?}
    const warnings = [];
    const GEOM = new Set(["x", "y", "width", "height"]);
    // 跳过"写进去和现在一样"的值：否则锚点元素也会被写一遍，
    // 既产生无意义的补丁，又让"改动集合"这种给用户看的数字失真。
    const put = (id, attrs) => {
        const cell = diagram.get(id);
        const merged = { ...(writes.get(id) ?? {}), ...attrs };
        const effective = {};
        for (const [key, value] of Object.entries(merged)) {
            if (key === "style") { if (String(value) !== cell.style) effective[key] = value; continue; }
            if (key === "value") { if (String(value) !== String(cell.value ?? "")) effective[key] = value; continue; }
            if (GEOM.has(key)) { if (Number(value) !== Number(cell.geometry?.[key])) effective[key] = value; continue; }
            effective[key] = value;
        }
        if (Object.keys(effective).length) {
            structural.delete(id);      // 同一 cell 上：属性写入覆盖结构性写入（避免补丁重叠）
            writes.set(id, effective);
        } else {
            writes.delete(id);
        }
    };

    for (const op of ops) {
        const ids = op.cellIds ?? (op.cellId ? [op.cellId] : []);
        if (op.kind === "style") {
            for (const id of ids) {
                const cell = diagram.get(id);
                if (!cell) { warnings.push(`样式目标 ${id} 不在图中`); continue; }
                const map = new Map(cell.styleMap);
                for (const [k, v] of Object.entries(op.props)) map.set(k, v);
                put(id, { style: serializeStyle(map) });
            }
            continue;
        }
        if (op.kind === "move") {
            for (const id of ids) {
                const cell = diagram.get(id);
                if (!cell?.geometry) { warnings.push(`${id} 没有几何信息，跳过`); continue; }
                put(id, {
                    x: Math.round(cell.geometry.x + Number(op.params.dx ?? 0)),
                    y: Math.round(cell.geometry.y + Number(op.params.dy ?? 0)),
                });
            }
            continue;
        }
        if (op.kind === "align") {
            const ref = op.params.reference?.box;
            for (const id of ids) {
                const cell = diagram.get(id);
                if (!cell?.geometry) { warnings.push(`${id} 没有几何信息，跳过`); continue; }
                const g = cell.geometry;
                if (op.params.anchor !== "bbox" && op.params.reference?.id) {
                    const base = diagram.get(op.params.reference.id);
                    if (!base?.geometry) continue;
                    const bg = base.geometry;
                    const r = {
                        x: bg.x, y: bg.y, right: bg.x + bg.width, bottom: bg.y + bg.height,
                        centerX: bg.x + bg.width / 2, centerY: bg.y + bg.height / 2,
                    };
                    put(id, alignAttrs(op.params.mode, g, r));
                } else if (ref) {
                    put(id, alignAttrs(op.params.mode, g, ref));
                }
            }
            continue;
        }
        if (op.kind === "distribute") {
            const axis = op.params.axis === "y" ? "y" : "x";
            const cells = ids.map((id) => diagram.get(id)).filter((c) => c?.geometry);
            if (cells.length < 3) continue;
            const sorted = [...cells].sort((a, b) => (axis === "x" ? a.geometry.x - b.geometry.x : a.geometry.y - b.geometry.y));
            const first = sorted[0];
            const last = sorted[sorted.length - 1];
            const spanStart = axis === "x" ? first.geometry.x : first.geometry.y;
            const spanEnd = axis === "x" ? last.geometry.x + last.geometry.width : last.geometry.y + last.geometry.height;
            const sizes = sorted.reduce((sum, c) => sum + (axis === "x" ? c.geometry.width : c.geometry.height), 0);
            const gap = (spanEnd - spanStart - sizes) / (sorted.length - 1);
            let cursor = spanStart;
            for (const cell of sorted) {
                put(cell.id, axis === "x" ? { x: Math.round(cursor) } : { y: Math.round(cursor) });
                cursor += (axis === "x" ? cell.geometry.width : cell.geometry.height) + gap;
            }
            continue;
        }
        if (op.kind === "size") {
            const refCell = op.params.reference?.id ? diagram.get(op.params.reference.id) : null;
            for (const id of ids) {
                if (id === op.params.reference?.id) continue;
                const cell = diagram.get(id);
                if (!cell?.geometry) { warnings.push(`${id} 没有几何信息，跳过`); continue; }
                const attrs = {};
                if ((op.params.mode === "width" || op.params.mode === "both") && refCell?.geometry) attrs.width = Math.round(refCell.geometry.width);
                if ((op.params.mode === "height" || op.params.mode === "both") && refCell?.geometry) attrs.height = Math.round(refCell.geometry.height);
                if (Object.keys(attrs).length) put(id, attrs);
            }
            continue;
        }
        if (op.kind === "square") {
            for (const id of ids) {
                const cell = diagram.get(id);
                if (!cell?.geometry) { warnings.push(`${id} 没有几何信息，跳过`); continue; }
                const side = Math.round(Math.max(cell.geometry.width, cell.geometry.height));
                put(id, { width: side, height: side });
            }
            continue;
        }
        // ---- 以下是 AI 通道的结构性 op（确定性通道不产出；能不能用由 guard 决定）----
        // update（AI 通道的主力：模型给一整段 mxCell）**在这里就被规约成属性写入**。
        // 为什么不让插件去解这段 XML：插件是"哑"的 —— 它只会三种话（attrs / add / delete），
        // 一旦把"怎么解释模型产出的 XML"塞进插件，语义就分了两处，guard 也就不再只有服务端一处了。
        // 这条正是"跳过：不认识的改写类型：update"的根因（插件收到 structural.update 无话可说）。
        if (op.kind === "update") {
            const cell = diagram.get(op.cellId);
            if (!cell) { warnings.push(`update 目标 ${op.cellId} 不在图中`); continue; }
            if (typeof op.xml !== "string" || !op.xml.trim()) { warnings.push(`update ${op.cellId} 缺少 xml`); continue; }
            const attrs = attrsFromCellXml(op.xml, op.cellId, warnings);
            if (attrs) put(op.cellId, attrs);
            continue;
        }
        if (op.kind === "delete") {
            const cell = diagram.get(op.cellId);
            if (!cell) { warnings.push(`delete 目标 ${op.cellId} 不在图中`); continue; }
            structural.set(op.cellId, { kind: "delete" });
            continue;
        }
        if (op.kind === "add") {
            const id = String(op.cellId ?? "");
            if (!id) { warnings.push("add 缺少 cellId"); continue; }
            if (diagram.get(id) || structural.has(id)) { warnings.push(`add 的 id ${id} 已存在，拒绝（id 必须唯一）`); continue; }
            if (typeof op.xml !== "string" || !op.xml.trim()) { warnings.push(`add ${id} 缺少 xml`); continue; }
            const parentId = String(op.parentId ?? "1");
            if (!diagram.get(parentId)) { warnings.push(`add 的父容器 ${parentId} 不在图中`); continue; }
            // XML 里声明的引用（parent/source/target）也必须真实存在 ——
            // 否则插件解码时端点是 null，会**静默**产出一条浮动线（点/边都是），
            // 而 applyWrites 照样报"新增成功"（实测见 spikes/s1/results/probe-add-api.log）。
            const refs = cellRefsFromXml(op.xml);
            const dangling = ["parent", "source", "target"].filter((k) => refs[k] !== undefined && !diagram.get(refs[k]));
            if (dangling.length) {
                warnings.push(`add ${id} 的 xml 引用了图上不存在的 ${dangling.map((k) => `${k}=${refs[k]}`).join("、")}，已拒绝（会变成不连任何东西的浮动元素）`);
                continue;
            }
            structural.set(id, {
                kind: "add", xml: op.xml.trim(), parentId,
                // 部件可选：AI 通道产出的 add 只有 xml（模型给的就是整段 mxCell），那时插件走解码兜底
                ...(op.value !== undefined ? { value: String(op.value) } : {}),
                ...(op.style !== undefined ? { style: String(op.style) } : {}),
                ...(op.x !== undefined ? { x: Number(op.x), y: Number(op.y), width: Number(op.width), height: Number(op.height) } : {}),
            });
            continue;
        }
    }
    // 注意：要取两边的**并集**。只遍历 writes 会把"只有结构性写入"的 cell 整个丢掉
    // （第一版就是这么错的：delete/add 一个 cell 都产不出来，测试直接抓到）
    const ids = [...new Set([...writes.keys(), ...structural.keys()])];
    return {
        writes: ids.map((cellId) => ({
            cellId,
            attrs: writes.get(cellId) ?? null,
            // 结构性写入与属性写入互斥：同一个 cell 只能有一种（否则补丁区间会重叠）
            structural: structural.get(cellId) ?? null,
        })),
        warnings,
    };
}

/**
 * 把"模型给的一整段 mxCell"规约成属性写入（style / value / 几何）。
 * 保守优先：拿不准的**不写**并给出 warning，而不是猜。
 *   · XML 里的 id 与目标不一致 → 拒绝（可能模型想改的是别的元素）；
 *   · XML 声明了 parent 且与现图不同 → 拒绝（移动层级属结构性改动，不在这一版范围内）；
 *   · 只抄 value/style/x/y/width/height，别的属性一律不碰（顶点/边标志、折叠、端点都不动）。
 */
function attrsFromCellXml(xml, expectedId, warnings) {
    let node;
    try { node = parseXml(xml).root; } catch (e) { warnings.push(`update ${expectedId} 的 xml 解析失败`); return null; }
    // 允许外面再包一层（模型有时会把 <mxCell> 包在 <root> 或 <object> 里）
    let inner = node;
    if (inner && inner.name !== "mxCell") inner = (inner.children || []).find((c) => c.name === "mxCell") || inner;
    if (!inner || inner.name !== "mxCell") { warnings.push(`update ${expectedId} 的 xml 里没有 <mxCell>`); return null; }
    const attr = (name) => (inner.attrs.get(name) ? inner.attrs.get(name).value : undefined);
    const id = attr("id");
    if (id && String(id) !== String(expectedId)) {
        warnings.push(`update 的 xml id=${id} 与目标 ${expectedId} 不一致，已拒绝（避免改错元素）`);
        return null;
    }
    const attrs = {};
    const style = attr("style");
    if (style !== undefined) attrs.style = style;
    const value = attr("value");
    if (value !== undefined) attrs.value = value;
    const geoNode = (inner.children || []).find((c) => c.name === "mxGeometry");
    if (geoNode) {
        for (const key of ["x", "y", "width", "height"]) {
            const v = geoNode.attrs.get(key) ? geoNode.attrs.get(key).value : undefined;
            if (v !== undefined) attrs[key] = Number(v);
        }
    }
    if (!Object.keys(attrs).length) { warnings.push(`update ${expectedId} 的 xml 里没有可写的属性`); return null; }
    return attrs;
}

function alignAttrs(mode, g, r) {
    switch (mode) {
        case "left": return { x: Math.round(r.x) };
        case "center": return { x: Math.round(r.centerX - g.width / 2) };
        case "right": return { x: Math.round(r.right - g.width) };
        case "top": return { y: Math.round(r.y) };
        case "middle": return { y: Math.round(r.centerY - g.height / 2) };
        case "bottom": return { y: Math.round(r.bottom - g.height) };
        default: throw new Error(`未知对齐方式 ${mode}`);
    }
}

/** 样式参数解析：给 CLI / 测试用的一步到位入口 */
export function stylePropsFromQuery(props = {}) {
    return { props: { ...props } };
}

export { parseStyle, serializeStyle };
