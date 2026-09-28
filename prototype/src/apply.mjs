// 应用器：把 writes 变成"属性区间替换"，再落到原文上。
//
// 这里是"未选中元素 XML 逐字节不变"的实现与证明：
//   * 实现：只替换目标 cell 的个别属性值区间（src/xml.mjs 的 setAttr），其余字节原样带过；
//   * 证明：applyWrites 返回它改过的每个区间，byteIdenticalOutside() 用这些区间去核对
//     "没被覆盖的 cell，在改动前后的切片是否完全相同" —— 把验收条件变成机器可判定的断言。

import { setAttr, applyPatches } from "./xml.mjs";

const GEOMETRY_ATTRS = new Set(["x", "y", "width", "height"]);

/** writes -> 属性补丁（按属性定位，不重排、不重序列化整篇） */
export function writesToPatches(diagram, writes) {
    const patches = [];
    const warnings = [];
    for (const { cellId, attrs, structural } of writes) {
        const cell = diagram.get(cellId);
        // ---- 结构性写入（AI 通道）：删除 / 插入 ----
        // 注：update **不再**走这里 —— 它在 opsToWrites 就被规约成属性写入（style/value/几何），
        // 这样插件侧只有 attrs / add / delete 三种话，语义只存在服务端一处（插件是哑的）。
        // 之所以能这么做，是因为解析器保留了每个节点的原文区间：
        // 删除就是"把这段区间替换成空串"，新增就是"在某个位置插入长度 0 的替换"。
        if (structural) {
            if (structural.kind === "delete") {
                if (!cell) { warnings.push(`delete 目标 ${cellId} 不在图中`); continue; }
                patches.push({ start: cell.cellNode.start, end: cell.cellNode.end, text: "", cellId, attr: "__delete" });
                continue;
            }
            if (structural.kind === "add") {
                if (cell) { warnings.push(`add 的 id ${cellId} 已存在`); continue; }
                const parent = diagram.get(structural.parentId ?? "1");
                if (!parent) { warnings.push(`add 的父容器 ${structural.parentId} 不在图中`); continue; }
                // drawio 的 XML 是**扁平**的：所有 <mxCell> 都是 <root> 的直接子节点，
                // 父子关系靠 parent 属性、不靠 XML 嵌套（aws-demo 里 4 和 5 就是兄弟）。
                // 所以新增元素一律插在 </root> 之前 —— 和 drawio 自己写出来的形状一致。
                const text = diagram.text;
                const rootEnd = diagram.rootNode.end - "</root>".length;
                const lineStart = text.lastIndexOf("\n", rootEnd) + 1;
                const tail = text.slice(lineStart, rootEnd);
                const insertAt = /^\s*$/.test(tail) ? lineStart : rootEnd;   // 让新元素独占一行，别挤在 </root> 前面
                const indent = /^\s*$/.test(tail) ? tail : "";
                patches.push({
                    start: insertAt, end: insertAt, text: structural.xml + "\n" + indent,
                    cellId, attr: "__add", parentId: structural.parentId,
                });
                continue;
            }
        }
        if (!cell) { warnings.push(`写回目标 ${cellId} 不在图中`); continue; }
        // 属性落点**显式白名单**：style 落在 <mxCell> 上，value 也落在 <mxCell> 上，几何才落在 <mxGeometry> 上。
        // 这里踩过坑：早先"不是 style 就当几何属性"的写法会把 value 塞进 <mxGeometry value="...">，
        // 结果是写了段没人认识的垃圾属性、而模型层面等于什么都没改（测试才把它抓出来）。
        for (const [name, value] of Object.entries(attrs ?? {})) {
            if (name === "style" || name === "value") {
                patches.push({ ...setAttr(diagram.text, cell.cellNode, name, value), cellId, attr: name });
                continue;
            }
            if (!GEOMETRY_ATTRS.has(name)) { warnings.push(`不认识的属性 ${name}（不在白名单里，已跳过）`); continue; }
            if (!cell.geometryNode) { warnings.push(`${cellId} 没有 <mxGeometry>，跳过属性 ${name}`); continue; }
            patches.push({ ...setAttr(diagram.text, cell.geometryNode, name, value), cellId, attr: name });
        }
    }
    return { patches, warnings };
}

/**
 * 应用 writes。
 * @returns {{xml: string, patches: object[], changedCells: string[]}}
 */
export function applyWrites(diagram, writes) {
    const { patches, warnings } = writesToPatches(diagram, writes);
    const changedCells = [...new Set(patches.map((p) => p.cellId))];
    patches.warnings = warnings;
    return { xml: applyPatches(diagram.text, patches), patches, changedCells, warnings };
}

/**
 * 独立复核：所有"没有被补丁覆盖"的 cell，其原文切片在改动前后必须逐字节相同。
 * 做法是把 before 的偏移映射到 after（按前面补丁的长度差累计平移），再比切片。
 */
export function byteIdenticalOutside(beforeText, afterText, patches, cells) {
    const sorted = [...patches].sort((a, b) => a.start - b.start);
    const shiftAt = (pos) => sorted
        .filter((p) => p.end <= pos)
        .reduce((sum, p) => sum + (p.text.length - (p.end - p.start)), 0);

    const checked = [];
    const mismatches = [];
    for (const cell of cells) {
        if (sorted.some((p) => p.start < cell.end && p.end > cell.start)) continue; // 被改过的不算
        const before = beforeText.slice(cell.start, cell.end);
        const delta = shiftAt(cell.start);
        const after = afterText.slice(cell.start + delta, cell.end + delta);
        if (before === after) checked.push(cell.id);
        else mismatches.push({ id: cell.id, before: before.slice(0, 60), after: after.slice(0, 60) });
    }
    return { ok: mismatches.length === 0, checked, mismatches };
}
