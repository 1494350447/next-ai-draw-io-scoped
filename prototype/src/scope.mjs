// 作用域解析（设计文档 §5.5-1）。
//
// 核心思想：**"能改什么"与"能看到什么"必须解耦**。
//   writable  —— 允许被修改的 cell（选中元素 + 容器子孙 + 与它们相连的边）
//   context   —— 只读邻域（父容器链 / 同级兄弟 / 边界边），喂给模型当上下文
//   skeleton  —— 全局骨架（其余容器的 id/label/子元素数；其余节点只给 label，不带 geometry）
// 再配上 token 估算，直接量化 Phase 1 的验收指标"输入 token < 全局 1/3"。

import { labelOf } from "./model.mjs";

/** 粗估 token：ASCII 约 4 字符 1 token，CJK 约 1 字符 1 token。够用来做量级判断。 */
export function estimateTokens(text) {
    let ascii = 0;
    let wide = 0;
    for (const ch of String(text)) {
        if (ch.charCodeAt(0) > 0x2e7f) wide++;
        else ascii++;
    }
    return Math.ceil(ascii / 4) + wide;
}

/** 选区的几何包围盒（只看有真实尺寸的顶点；边/未布局元素不参与） */
function selectionBBox(diagram, writable, ) {
    let box = null;
    for (const id of writable) {
        const cell = diagram.get(id);
        const g = cell?.geometry;
        if (!g || cell.isEdge) continue;
        const w = Number(g.width) || 0;
        const h = Number(g.height) || 0;
        if (w <= 0 && h <= 0) continue;
        const x = Number(g.x) || 0;
        const y = Number(g.y) || 0;
        box = box
            ? { x1: Math.min(box.x1, x), y1: Math.min(box.y1, y), x2: Math.max(box.x2, x + w), y2: Math.max(box.y2, y + h) }
            : { x1: x, y1: y, x2: x + w, y2: y + h };
    }
    return box;
}

/**
 * 按"离选区中心的距离"排序（近 → 远）；无几何的元素排在最后，同距离保持文档顺序。
 * 目的不是精确的视觉邻近，而是让有限的邻域名额落在"最可能被误伤"的那些元素上。
 */
function rankByProximity(diagram, ids, writable) {
    const box = selectionBBox(diagram, writable);
    if (!box) return ids;
    const cx = (box.x1 + box.x2) / 2;
    const cy = (box.y1 + box.y2) / 2;
    const scored = ids.map((id, index) => {
        const g = diagram.get(id)?.geometry;
        const w = Number(g?.width) || 0;
        const h = Number(g?.height) || 0;
        const hasGeom = !!g && (w > 0 || h > 0);
        if (!hasGeom) return { id, index, dist: Number.POSITIVE_INFINITY };
        const dx = (Number(g.x) || 0) + w / 2 - cx;
        const dy = (Number(g.y) || 0) + h / 2 - cy;
        return { id, index, dist: Math.hypot(dx, dy) };
    });
    scored.sort((a, b) => (a.dist - b.dist) || (a.index - b.index));
    return scored.map((s) => s.id);
}

const ref = (diagram, id, extra = {}) => {
    const cell = diagram.get(id);
    if (!cell) return { id, missing: true };
    return {
        id,
        kind: cell.isEdge ? "edge" : "vertex",
        label: labelOf(cell),
        parent: cell.parent,
        ...extra,
    };
};

/**
 * 把作用域渲染成"喂给模型的那段文本"（设计文档 §5.4 的 prompt 契约雏形）。
 * 可改部分给完整 XML；只读邻域给 id+label+几何；骨架只给 id+label（容器多一个子元素数）。
 * token 估算就是量它 —— 这是 Phase 1 后续接模型时要发的真实载荷。
 *
 * 返回分段结果，是为了让 token 账单**可归因**（哪一层吃掉了预算），而不是只有一个总数：
 * 优化作用域时唯一能下手的地方就是"某一段的 token 占比"。
 */
export function renderScopeSections(diagram, scope, options = {}) {
    const mode = options.skeleton ?? "compact";
    const sections = { writable: [], context: [], skeleton: [], constraint: [] };
    const geom = (cell) => cell.geometry
        ? ` (x=${cell.geometry.x},y=${cell.geometry.y},${cell.geometry.width}x${cell.geometry.height})`
        : "";
    sections.writable.push(`[可修改] ${scope.writable.length} 个元素 —— 只允许改这些`);
    for (const id of scope.writable) {
        const cell = diagram.get(id);
        sections.writable.push(diagram.parsed.text.slice(cell.cellNode.start, cell.cellNode.end).trim());
    }
    const { ancestors, siblings, edges } = scope.context ?? {};
    if ((ancestors?.length ?? 0) || (siblings?.length ?? 0) || (edges?.length ?? 0)) {
        sections.context.push(`[只读·邻域] 不要改这些（同层共 ${scope.context.siblingsTotal ?? siblings.length} 个，此处列出最近的 ${siblings.length} 个）`);
        for (const item of ancestors) sections.context.push(`- 祖先 ${item.id} "${item.label}"${geom(diagram.get(item.id))}`);
        for (const item of siblings) sections.context.push(`- 兄弟 ${item.id} "${item.label}"${geom(diagram.get(item.id))}`);
        for (const item of edges) sections.context.push(`- 相连边 ${item.id} "${item.label}"`);
    }
    if (scope.skeleton.length) {
        if (mode === "full") {
            // 逐条枚举：结构最完整，但"其余节点仅 label"在扁平大图上仍然是一行一个元素
            sections.skeleton.push("[只读·骨架] 其他元素只给标签");
            for (const item of scope.skeleton) {
                sections.skeleton.push(`- ${item.id} "${item.label}"${item.container ? ` 子元素 ${item.childCount}` : ""}`);
            }
        } else {
            // 结构性骨架：容器必须逐条列（模型要选 add 的 parent），其余只给数量。
            // 依据：模型真正需要的是"结构边界 + 存在性"，不是逐个认识每个无关元素。
            const containers = scope.skeleton.filter((s) => s.container);
            const others = scope.skeleton.filter((s) => !s.container);
            const otherVertices = others.filter((s) => s.kind === "vertex").length;
            const otherEdges = others.filter((s) => s.kind === "edge").length;
            sections.skeleton.push("[只读·骨架] 其他容器与元素（未列出细节）");
            for (const item of containers) sections.skeleton.push(`- 容器 ${item.id} "${item.label}" 子元素 ${item.childCount}`);
            sections.skeleton.push(`- 其余 ${otherVertices} 个节点、${otherEdges} 条边未列出`);
        }
    }
    sections.constraint.push("硬约束：只允许对 [可修改] 内的 id 产生 add/update/delete；新增元素的 parent 必须是 [可修改] 内元素或 root。");
    return sections;
}

export function renderScopeText(diagram, scope, options = {}) {
    const s = renderScopeSections(diagram, scope, options);
    return [...s.writable, ...s.context, ...s.skeleton, ...s.constraint].join("\n");
}

/** 分段 token 账单（加起来就是 scopedTokens；约束行是固定开销） */
export function scopeTokenBreakdown(diagram, scope, options = {}) {
    const s = renderScopeSections(diagram, scope, options);
    const out = {};
    for (const [key, lines] of Object.entries(s)) out[key] = estimateTokens(lines.join("\n"));
    out.total = out.writable + out.context + out.skeleton + out.constraint;
    return out;
}

/**
 * @param {object} diagram parseDiagram 的结果
 * @param {string[]} roots 用户选中的元素 id
 * @param {{includeEdges?: 'connected'|'internal', maxSiblings?: number, maxAncestors?: number}} options
 *        includeEdges='connected'（默认，设计文档）：只要有一端落在 writable 就纳入，避免连线断裂
 *        includeEdges='internal'：只有两端都在 writable 内的边才可改，边界边降级为只读上下文
 *        maxSiblings（默认 12）：邻域里的兄弟元素上限。**扁平图（drawio 最常见形态：所有元素 parent="1"）
 *          的"兄弟"就是全图**，不设上限等于把整张图塞进 prompt —— 作用域白做。超出上限的兄弟按
 *          "离选区由近到远"截断，被截断者降级进 skeleton（compact 渲染只计数量，full 才逐条列）。
 *        maxAncestors（默认 8）：父容器链上限（正常图 = 图层深度，天然有界；这里只做兜底）
 */
export function resolveScope(diagram, roots, options = {}) {
    const includeEdges = options.includeEdges ?? "connected";
    const warnings = [];
    const cleanRoots = [];
    for (const id of roots ?? []) {
        const cell = diagram.get(String(id));
        if (!cell) { warnings.push(`roots 里的 ${id} 不在图中，已忽略`); continue; }
        if (cell.isRoot) { warnings.push(`${id} 是 root 占位单元，已忽略`); continue; }
        if (!cleanRoots.includes(cell.id)) cleanRoots.push(cell.id);
    }
    if (cleanRoots.length === 0) throw new Error("没有有效的选中元素");

    // ---- writable ----
    const writable = new Set(cleanRoots);
    for (const id of cleanRoots) for (const d of diagram.descendants(id)) writable.add(d);

    const edgeReason = new Map();
    for (const cell of diagram.cells.values()) {
        if (!cell.isEdge) continue;
        const sourceIn = cell.source !== null && writable.has(cell.source);
        const targetIn = cell.target !== null && writable.has(cell.target);
        if (!sourceIn && !targetIn) continue;
        const internal = sourceIn && targetIn;
        if (internal || includeEdges === "connected") {
            writable.add(cell.id);
            edgeReason.set(cell.id, internal ? "internal" : "boundary");
        }
    }

    // ---- 只读上下文 ----
    const ancestorIds = new Set();
    for (const id of cleanRoots) for (const a of diagram.ancestors(id)) {
        if (!writable.has(a) && a !== "0") ancestorIds.add(a);
    }
    const siblingIds = new Set();
    for (const id of cleanRoots) {
        const parentId = diagram.get(id)?.parent;
        if (!parentId) continue;
        for (const childId of diagram.get(parentId)?.childIds ?? []) {
            if (childId !== id && !writable.has(childId)) siblingIds.add(childId);
        }
    }
    const boundaryEdges = [...diagram.cells.values()]
        .filter((c) => c.isEdge && !writable.has(c.id)
            && ((c.source && writable.has(c.source)) || (c.target && writable.has(c.target))));

    // 邻域有界化（关键）：扁平图上 siblings == 全图，必须按"几何邻近度"截断。
    // 排序依据是"模型真正需要谁" —— 离选区最近的邻居才是它排版/接边时要看的对象；
    // 无几何的元素（边、未布局的新元素）一律排在最后，它们靠"存在性"就够，不需要逐条列举。
    const maxSiblings = Math.max(0, options.maxSiblings ?? 12);
    const siblingsRanked = rankByProximity(diagram, [...siblingIds], writable);
    const keptSiblingIds = siblingsRanked.slice(0, maxSiblings);
    const droppedSiblingIds = siblingsRanked.slice(maxSiblings);

    const maxAncestors = Math.max(1, options.maxAncestors ?? 8);
    const ancestorsRanked = [...ancestorIds];
    if (ancestorsRanked.length > maxAncestors) {
        warnings.push(`父容器链有 ${ancestorsRanked.length} 层，只保留最近 ${maxAncestors} 层，其余降级为骨架`);
    }
    const keptAncestorIds = ancestorsRanked.slice(-maxAncestors);
    const droppedAncestorIds = ancestorsRanked.slice(0, -maxAncestors);
    if (droppedSiblingIds.length) {
        warnings.push(`邻域里还有 ${droppedSiblingIds.length} 个同层元素在 ${maxSiblings} 个之外，已降级为骨架计数`);
    }

    const context = {
        ancestors: keptAncestorIds.map((id) => ref(diagram, id, { childCount: diagram.get(id).childIds.length })),
        siblings: keptSiblingIds.map((id) => ref(diagram, id)),
        edges: boundaryEdges.map((c) => ref(diagram, c.id)),
        // 让调用方（UI / prompt 构造 / 审计）知道邻域被裁剪过，而不是以为"只有这些"
        siblingsTotal: siblingIds.size,
        siblingsOmitted: droppedSiblingIds.length,
        ancestorsTotal: ancestorIds.size,
    };

    // ---- 全局骨架 ----
    const inContext = new Set([
        ...keptAncestorIds, ...keptSiblingIds, ...boundaryEdges.map((c) => c.id),
    ]);
    // 注意：被邻域裁剪掉的兄弟/祖先会自然落到这里 —— 它们没有消失，只是从"逐条可读"降级为"存在性"。
    const skeleton = [];
    for (const id of diagram.order) {
        if (writable.has(id) || inContext.has(id) || id === "0") continue;
        const cell = diagram.get(id);
        const isContainer = cell.childIds.length > 0;
        skeleton.push({
            id,
            kind: cell.isEdge ? "edge" : "vertex",
            label: labelOf(cell),
            childCount: isContainer ? cell.childIds.length : undefined,
            container: isContainer || undefined,
        });
    }

    // ---- token 估算（验收指标：scoped 输入 < 全局 1/3）----
    // 注意：必须按"真正要喂给模型的文本形态"来估，不能拿 JSON.stringify(对象数组) 去估 ——
    // 那样光是重复的键名就把骨架撑成和全量差不多大，测出来的是序列化开销，不是作用域收益。
    const rendered = { writable: [...writable], context, skeleton };
    const scopedTokens = estimateTokens(renderScopeText(diagram, rendered));
    const fullSkeletonTokens = estimateTokens(renderScopeText(diagram, rendered, { skeleton: "full" }));
    const fullTokens = estimateTokens(diagram.text);

    const scope = {
        pageId: diagram.pageId,
        roots: cleanRoots,
        writable: [...writable],
        edgeReason: Object.fromEntries(edgeReason),
        context,
        skeleton,
        origin: options.origin ?? "outline",
        warnings,
        includeEdges,
        estimate: {
            scopedTokens,
            fullSkeletonTokens,
            fullTokens,
            ratio: fullTokens ? Number((scopedTokens / fullTokens).toFixed(3)) : null,
            writableCells: writable.size,
            totalCells: diagram.cells.size,
            // 分段账单：一眼看出预算被谁吃掉（writable 是硬成本，skeleton/context 是可调的）
            breakdown: scopeTokenBreakdown(diagram, rendered),
            skeletonCells: skeleton.length,
            context: { ancestors: context.ancestors.length, siblings: context.siblings.length, omittedSiblings: context.siblingsOmitted },
        },
        fingerprint: {
            xml: diagram.checksum,
            writable: diagram.cells.get(cleanRoots[0]) ? diagram.pageId ?? null : null,
        },
    };
    return scope;
}
