// 改动账本：把"两份 XML 的差异"翻译成**用户能看懂、能核对**的明细。
//
// 它和 guard 的结果层是同一份事实的两个视角：
//   guard 看"改动集合 ⊆ writable 吗"（能不能这样改）；
//   diff  看"每个元素到底哪几个字段从什么变成了什么"（改成了什么样）。
// 前端的高亮与"改动 N 个元素"的文案都吃这个结构 —— 用户不该靠肉眼比对 XML 来确认改了什么。

import { parseDiagram, parseStyle, labelOf } from "./model.mjs";

const GEOM_KEYS = ["x", "y", "width", "height"];
const CELL_KEYS = [["value", "文字"], ["parent", "父容器"], ["source", "起点"], ["target", "终点"]];
const kindOf = (cell) => (cell.isEdge ? "edge" : cell.isVertex ? "vertex" : "other");
const norm = (v) => (v === undefined || v === null || v === "" ? null : String(v));

/** 单个 cell 的字段级差异（没变化就返回空数组） */
function diffCell(before, after) {
    const out = [];
    for (const [key, name] of CELL_KEYS) {
        const b = norm(before[key]), a = norm(after[key]);
        if (b !== a) out.push({ key, name, from: b, to: a });
    }
    for (const key of GEOM_KEYS) {
        const b = before.geometry?.[key] ?? null, a = after.geometry?.[key] ?? null;
        if (b === null && a === null) continue;
        if (Number(b) !== Number(a)) {
            out.push({ key: `geometry.${key}`, name: key, from: b, to: a, delta: Number(a) - Number(b) });
        }
    }
    // 样式按"键"比较（不是按字符串）：drawio 里样式顺序无关，字符串比对会误报
    const bs = parseStyle(before.style), as = parseStyle(after.style);
    for (const [k, v] of as) if (bs.get(k) !== v) out.push({ key: `style.${k}`, name: k, from: bs.get(k) ?? null, to: v, style: true });
    for (const [k, v] of bs) if (!as.has(k)) out.push({ key: `style.${k}`, name: k, from: v, to: null, style: true });
    return out;
}

/**
 * 比较两份 XML。
 * @returns {{changed: object[], added: object[], removed: object[], total: number}}
 *          changed 里每项：{id, label, kind, fields:[{key,name,from,to,delta?,style?}]}
 */
export function diffDiagrams(beforeText, afterText) {
    const before = parseDiagram(beforeText);
    const after = parseDiagram(afterText);
    const changed = [];
    const added = [];
    const removed = [];

    for (const [id, b] of before.cells) {
        const a = after.cells.get(id);
        if (!a) { removed.push({ id, label: labelOf(b), kind: kindOf(b) }); continue; }
        const fields = diffCell(b, a);
        if (fields.length) changed.push({ id, label: labelOf(a), kind: kindOf(a), fields });
    }
    for (const [id, a] of after.cells) {
        if (!before.cells.has(id)) added.push({ id, label: labelOf(a), kind: kindOf(a) });
    }
    changed.sort((x, y) => x.id.localeCompare(y.id, "en", { numeric: true }));
    return { changed, added, removed, total: changed.length + added.length + removed.length };
}

/** 一行摘要（给日志、审计、和"这次改了啥"的一句提示用） */
export function summarizeDiff(diff, limit = 3) {
    const parts = diff.changed.slice(0, limit).map((c) => {
        const fields = c.fields.slice(0, 2).map((f) => `${f.name} ${f.from ?? "∅"}→${f.to ?? "∅"}`).join("、");
        const more = c.fields.length > 2 ? ` 等 ${c.fields.length} 项` : "";
        return `${c.id}(${fields}${more})`;
    });
    if (diff.changed.length > limit) parts.push(`…共 ${diff.changed.length} 个元素`);
    if (diff.added.length) parts.push(`新增 ${diff.added.length} 个`);
    if (diff.removed.length) parts.push(`删除 ${diff.removed.length} 个`);
    return parts.join("；") || "没有任何改动";
}
