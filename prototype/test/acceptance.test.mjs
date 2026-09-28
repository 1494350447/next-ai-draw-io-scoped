// Phase 1 骨架的验收测试 —— 直接对着设计文档 §9 的三条验收条件写。
//
//   1) 越界率 0
//   2) 未选中元素 XML 逐字节不变
//   3) 作用域输入 token < 全局的 1/3（这里对"叶子选择"断言，并对更大的选择打印实测比例）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram } from "../src/model.mjs";
import { resolveScope } from "../src/scope.mjs";
import { runCommand, opsToWrites } from "../src/commands.mjs";
import { applyWrites, byteIdenticalOutside } from "../src/apply.mjs";
import { guardOps, verifyCandidate } from "../src/guard.mjs";
import { SAMPLES, sample, synthDiagram } from "./helpers.mjs";

const allCommands = [
    ["style", { props: { fillColor: "#ffcc00" } }],
    ["style", { props: { fontSize: "20", rounded: "1" } }],
    ["align", { mode: "left" }],
    ["align", { mode: "middle" }],
    ["distribute", { axis: "x" }],
    ["distribute", { axis: "y" }],
    ["size", { mode: "both" }],
    ["move", { dx: 12, dy: -8 }],
];

/** 每个样例挑几个有代表性的选择：叶子 / 容器 / 多选 / 边 */
function selectionsFor(diagram) {
    const vertices = [...diagram.cells.values()].filter((c) => c.isVertex && c.parent !== "0");
    const out = [];
    const leaf = vertices.find((c) => c.childIds.length === 0);
    const container = vertices.find((c) => c.childIds.length > 0);
    if (leaf) out.push([leaf.id]);
    if (container) out.push([container.id]);
    const twoTop = vertices.filter((c) => c.parent === "1").slice(0, 2).map((c) => c.id);
    if (twoTop.length === 2) out.push(twoTop);
    const anyEdge = [...diagram.cells.values()].find((c) => c.isEdge);
    if (anyEdge) out.push([anyEdge.id]);
    return out;
}

test("验收 1+2：任何命令都不会改动作用域外的元素，且未选中元素逐字节不变", () => {
    let cases = 0;
    for (const name of SAMPLES) {
        const d = parseDiagram(sample(name));
        for (const roots of selectionsFor(d)) {
            const scope = resolveScope(d, roots);
            const cellRanges = [...d.cells.values()].map((c) => ({ id: c.id, start: c.cellNode.start, end: c.cellNode.end }));
            for (const [command, params] of allCommands) {
                const { ops } = runCommand(d, scope, command, params);
                if (!ops.length) continue;
                assert.equal(guardOps(ops, scope).ok, true, `${name}/${roots}/${command} 的 op 自己就越界了`);
                const { writes } = opsToWrites(d, ops);
                const applied = applyWrites(d, writes);
                const report = verifyCandidate(d.text, applied.xml, scope);
                assert.equal(report.ok, true, `${name}/${roots}/${command} 改到了作用域外：${report.outOfScope}`);
                const bytes = byteIdenticalOutside(d.text, applied.xml, applied.patches, cellRanges);
                assert.equal(bytes.ok, true, `${name}/${roots}/${command} 破坏了未选中元素的字节`);
                assert.ok(bytes.checked.length > 0, `${name}/${roots}/${command} 没有任何可核对的未改动元素（patches=${applied.patches.length}）`);
                cases++;
            }
        }
    }
    assert.ok(cases >= 20, `覆盖的用例太少：${cases}`);
    console.log(`  · 覆盖 ${cases} 个"样例 × 选择 × 命令"组合，全部通过`);
});

test("验收 1（攻击面）：对作用域外每一个 cell 发越界 op，全部被拦", () => {
    let attacks = 0;
    for (const name of SAMPLES) {
        const d = parseDiagram(sample(name));
        for (const roots of selectionsFor(d)) {
            const scope = resolveScope(d, roots);
            const writable = new Set(scope.writable);
            const outsiders = [...d.cells.keys()].filter((id) => !writable.has(id));
            for (const id of outsiders) {
                for (const op of [
                    { kind: "style", cellIds: [id], props: { fillColor: "#ff0000" } },
                    { kind: "move", cellIds: [id], params: { dx: 5, dy: 5 } },
                    { kind: "delete", cellId: id },
                    { kind: "update", cellId: id, xml: "<mxCell/>" },
                ]) {
                    const g = guardOps([op], scope, { allowAiKinds: true });
                    assert.equal(g.ok, false, `${name}: 越界 op 没被拦：${JSON.stringify(op)}`);
                    attacks++;
                }
            }
        }
    }
    assert.ok(attacks > 100, `攻击用例太少：${attacks}`);
    console.log(`  · 穷举 ${attacks} 个越界 op，拒绝率 100%`);
});

test("验收 3：作用域输入的 token 占比（图越大收益越明显；大图必须 < 1/3）", () => {
    // 小图（10~20 个 cell）上，脚手架（骨架 + 上下文）本身就占相当比例，
    // 作用域化没有 token 收益 —— 这是产品结论：作用域编辑的价值从中等图开始。
    const lines = [];
    for (const name of SAMPLES) {
        const d = parseDiagram(sample(name));
        for (const roots of selectionsFor(d)) {
            const e = resolveScope(d, roots).estimate;
            lines.push(`${name.padEnd(10)} cell=${String(d.cells.size).padStart(3)} roots=[${roots}] → ${String(e.scopedTokens).padStart(6)}/${String(e.fullTokens).padStart(6)} = ${(e.ratio * 100).toFixed(0)}%`
            + `（可改 ${e.breakdown.writable} + 邻域 ${e.breakdown.context} + 骨架 ${e.breakdown.skeleton} + 约束 ${e.breakdown.constraint}）`);
        }
    }
    // 大图：200 个顶点 + 199 条边，只选 3 个叶子
    const big = parseDiagram(synthDiagram(200));
    const bigScope = resolveScope(big, ["v7", "v8", "v9"]);
    const be = bigScope.estimate;
    lines.push(`synth-200  cell=${big.cells.size} roots=[v7,v8,v9] → ${be.scopedTokens}/${be.fullTokens} = ${(be.ratio * 100).toFixed(1)}%`
        + `（骨架逐条枚举的版本是 ${be.fullSkeletonTokens}，即 ${(be.fullSkeletonTokens / be.fullTokens * 100).toFixed(1)}%）`);
    console.log("  · 实测占比：\n    " + lines.join("\n    "));

    assert.ok(be.ratio < 1 / 3, `200 cell 的图上占比仍然过高：${be.ratio}`);
    // 结构性骨架必须比"逐条枚举"显著更省，否则 compact 模式没有存在意义
    assert.ok(be.scopedTokens < be.fullSkeletonTokens, "结构性骨架应当比逐条枚举更省");
    assert.ok(be.fullSkeletonTokens / be.scopedTokens > 2, `骨架两种渲染模式差距太小：${be.fullSkeletonTokens} vs ${be.scopedTokens}`);
    // 邻域必须有界：扁平图上"兄弟 == 全图"，不截断就等于把整张图发出去
    assert.ok(bigScope.context.siblingsOmitted > 300, `邻域没有被裁剪：omitted=${bigScope.context.siblingsOmitted}`);
    assert.ok(be.breakdown.total > 0 && be.breakdown.writable > 0);
    assert.equal(bigScope.skeleton.every((s) => s.geometry === undefined), true);
    const tiny = resolveScope(parseDiagram(synthDiagram(20)), ["v7", "v8", "v9"]);
    assert.ok(be.ratio < tiny.estimate.ratio, "图变大后占比应当更小");
});
