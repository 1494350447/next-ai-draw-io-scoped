// 服务端 guard：作用域越界的唯一防线（设计文档 §5.5-2）。
//
// 两条独立的检查，缺一不可：
//   ① 意图层 —— guardOps(ops, scope)：Op 指向的 cell 必须在 writable 内（确定通道与 AI 通道共用）；
//   ② 结果层 —— verifyCandidate(before, after, scope)：重新解析改动前后的 XML，算出"实际被改动的 cell 集合"，
//      必须 ⊆ writable。这一条不依赖任何人（包括模型、客户端、甚至我们自己的应用器）的自述。
//      S2 的教训是"不能相信写回方声称成功"，所以结果层必须自己算。

import { parseDiagram } from "./model.mjs";
import { cellRefsFromXml } from "./xml.mjs";

export const DETERMINISTIC_KINDS = new Set(["align", "distribute", "move", "style", "size", "square"]);
export const AI_KINDS = new Set(["update", "add", "delete"]);

/**
 * 意图层校验。
 * @param {object[]} ops
 * @param {object} scope resolveScope 的结果
 * @param {{allowAiKinds?: boolean}} options
 * @returns {{ok: boolean, rejected: {op: object, reason: string}[], checkedOps: number}}
 */
export function guardOps(ops, scope, options = {}) {
    const writable = new Set(scope.writable);
    const rejected = [];
    if (!Array.isArray(ops) || ops.length === 0) {
        return { ok: false, rejected: [{ op: null, reason: "没有 ops" }], checkedOps: 0 };
    }
    for (const op of ops) {
        if (!op || typeof op !== "object") { rejected.push({ op, reason: "op 不是对象" }); continue; }
        if (!DETERMINISTIC_KINDS.has(op.kind) && !AI_KINDS.has(op.kind)) {
            rejected.push({ op, reason: `未知的 op.kind: ${op.kind}` }); continue;
        }
        if (AI_KINDS.has(op.kind) && !options.allowAiKinds) {
            rejected.push({ op, reason: `Phase 1 原型不放行 AI 通道的 op.kind=${op.kind}` }); continue;
        }
        const ids = op.cellIds ?? (op.cellId ? [op.cellId] : []);
        if (op.kind === "add") {
            const parentOk = op.parentId === undefined
                || writable.has(op.parentId) || op.parentId === "1" || op.parentId === "0";
            if (!parentOk) rejected.push({ op, reason: `add 的 parentId=${op.parentId} 不在作用域内` });
            // 新增元素的"作用域判据"是它挂在哪、以及它连到谁：
            // 端点若落在作用域外，用户看到的就是"AI 借新元素动了别处"。宁可拒（用户把两端也选上即可）。
            const refs = typeof op.xml === "string" ? cellRefsFromXml(op.xml) : {};
            for (const key of ["source", "target"]) {
                if (refs[key] !== undefined && !writable.has(refs[key])) {
                    rejected.push({ op, reason: `add 的新元素连到了作用域外的 ${refs[key]}（${key}），越界` });
                }
            }
            continue;
        }
        if (!ids.length) { rejected.push({ op, reason: `${op.kind} 没有目标 cell` }); continue; }
        for (const id of ids) {
            if (!writable.has(id)) rejected.push({ op, reason: `越界：${id} 不在 scope.writable 内（${op.kind}）` });
        }
        if (op.kind === "style") {
            const props = Object.keys(op.props ?? {});
            if (!props.length) rejected.push({ op, reason: "style 没有 props" });
        }
    }
    return { ok: rejected.length === 0, rejected, checkedOps: ops.length };
}

/** 逐 cell 抽出"可比较的外观"：样式、值、几何、父子关系 */
function snapshot(diagram) {
    const map = new Map();
    for (const [id, cell] of diagram.cells) {
        map.set(id, {
            style: cell.style,
            value: cell.value,
            parent: cell.parent,
            source: cell.source,
            target: cell.target,
            geometry: cell.geometry
                ? [cell.geometry.x, cell.geometry.y, cell.geometry.width, cell.geometry.height].join(",")
                : null,
        });
    }
    return map;
}

/**
 * 结果层复核：改动前后的 XML 各自重新解析，算出真实改动集合。
 * @returns {{changed: string[], added: string[], removed: string[], outOfScope: string[], ok: boolean}}
 */
export function verifyCandidate(beforeText, afterText, scope) {
    const before = snapshot(parseDiagram(beforeText));
    const after = snapshot(parseDiagram(afterText));
    const writable = new Set(scope.writable);

    const changed = [];
    for (const [id, next] of after) {
        const prev = before.get(id);
        if (!prev) continue;
        if (JSON.stringify(prev) !== JSON.stringify(next)) changed.push(id);
    }
    const added = [...after.keys()].filter((id) => !before.has(id));
    const removed = [...before.keys()].filter((id) => !after.has(id));

    // 父容器变更也算改动：容器被换掉会破坏结构，必须落回它自己身上
    for (const [id, prev] of before) {
        const next = after.get(id);
        if (next && prev.parent !== next.parent && !changed.includes(id)) changed.push(id);
    }

    // 新增元素的判据是"它挂在哪"，不是它的 id ——
    // 新 id 当然不可能预先出现在 writable 里，拿 id 判会把**所有**合法新增都当成越界
    // （这是加了 AI 通道的 add 之后才暴露出来的：原来 add 从不产出，所以没被踩到）。
    // 判据与意图层保持一致：parent ∈ writable ∪ {root, layer}。
    const badAdded = added.filter((id) => {
        const parent = after.get(id)?.parent;
        return !(parent === undefined || parent === null || parent === "0" || parent === "1" || writable.has(parent));
    });
    const outOfScope = [...changed, ...removed, ...badAdded].filter((id) => !writable.has(id));
    return {
        changed: changed.sort(),
        added: added.sort(),
        removed: removed.sort(),
        outOfScope: [...new Set(outOfScope)].sort(),
        ok: outOfScope.length === 0,
    };
}
