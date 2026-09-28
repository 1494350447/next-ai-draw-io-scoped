// AI 通道的结构性写回（update / delete / add）。
//
// 这三条是"生成式"编辑的地基：没有它们，模型只能改改颜色和坐标，那作用域编辑就没意义。
// 关键性质：它们和属性写入走同一套补丁机制（区间替换），所以"未选中元素逐字节不变"依然成立。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram, labelOf } from "../src/model.mjs";
import { resolveScope } from "../src/scope.mjs";
import { opsToWrites } from "../src/commands.mjs";
import { applyWrites, byteIdenticalOutside } from "../src/apply.mjs";
import { guardOps, verifyCandidate } from "../src/guard.mjs";
import { diffDiagrams } from "../src/diff.mjs";
import { sample } from "./helpers.mjs";

const setup = (roots, name = "small-flow") => {
    const d = parseDiagram(sample(name));
    return { d, scope: resolveScope(d, roots) };
};
const cellRanges = (d) => [...d.cells.values()].map((c) => ({ id: c.id, start: c.cellNode.start, end: c.cellNode.end }));
const applyOps = (ctx, ops) => {
    assert.equal(guardOps(ops, ctx.scope, { allowAiKinds: true }).ok, true, "ops 自己就越界了");
    const { writes } = opsToWrites(ctx.d, ops);
    const applied = applyWrites(ctx.d, writes);
    return { applied, report: verifyCandidate(ctx.d.text, applied.xml, ctx.scope) };
};

test("delete：元素从 XML 里消失，其余元素逐字节不变", () => {
    const ctx = setup(["16"]);                     // 16 = 对账（一个独立的叶子）
    const ranges = cellRanges(ctx.d);
    const { applied, report } = applyOps(ctx, [{ kind: "delete", cellId: "16" }]);
    assert.equal(report.ok, true, `改动越界：${report.outOfScope}`);
    assert.deepEqual(report.removed, ["16"]);
    const after = parseDiagram(applied.xml);
    assert.equal(after.get("16"), undefined);
    assert.equal(after.cells.size, ctx.d.cells.size - 1);
    assert.equal(byteIdenticalOutside(ctx.d.text, applied.xml, applied.patches, ranges).ok, true);
    const diff = diffDiagrams(ctx.d.text, applied.xml);
    assert.deepEqual(diff.removed.map((r) => r.id), ["16"]);
    assert.equal(diff.total, 1);
});

test("update：整段替换一个元素（改文字/换形状都能用）", () => {
    const ctx = setup(["16"]);
    const ranges = cellRanges(ctx.d);
    // 只改 value，样式沿用原来的 —— 这样"整段替换"的 diff 应当精确到只有 value
    const xml = `<mxCell id="16" value="对账服务" style="${ctx.d.get("16").style}" vertex="1" parent="1"><mxGeometry x="80" y="440" width="120" height="60" as="geometry"/></mxCell>`;
    const { applied, report } = applyOps(ctx, [{ kind: "update", cellId: "16", xml }]);
    assert.equal(report.ok, true);
    assert.deepEqual(report.changed, ["16"]);
    const after = parseDiagram(applied.xml);
    assert.equal(after.get("16").value, "对账服务");
    assert.equal(after.get("16").geometry.x, 80);
    assert.equal(byteIdenticalOutside(ctx.d.text, applied.xml, applied.patches, ranges).ok, true);
    const diff = diffDiagrams(ctx.d.text, applied.xml);
    assert.deepEqual(diff.changed[0].fields.map((f) => f.key), ["value"]);
});

test("add：插到默认层（自闭合的 <mxCell id=\"1\"/> 后面）也能被正确解析为它的子元素", () => {
    const ctx = setup(["16", "10"]);
    const ranges = cellRanges(ctx.d);
    const xml = '<mxCell id="new-1" value="新节点" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="700" y="80" width="120" height="60" as="geometry"/></mxCell>';
    const { applied, report } = applyOps(ctx, [{ kind: "add", cellId: "new-1", parentId: "1", xml }]);
    assert.equal(report.ok, true, `新增被判定为越界：${report.outOfScope}`);
    assert.deepEqual(report.added, ["new-1"]);
    const after = parseDiagram(applied.xml);
    assert.equal(after.get("new-1").parent, "1", "新元素必须真的挂在父容器下（不是只插了段文本）");
    assert.equal(after.get("new-1").geometry.x, 700);
    assert.equal(after.get("1").childIds.includes("new-1"), true);
    assert.equal(byteIdenticalOutside(ctx.d.text, applied.xml, applied.patches, ranges).ok, true);
    assert.equal(diffDiagrams(ctx.d.text, applied.xml).added[0].label, "新节点");
});

test("add：插到真实容器里，靠 parent 属性挂上去（drawio 的 XML 是扁平的）", () => {
    const d = parseDiagram(sample("aws-demo"));
    const scope = resolveScope(d, ["4"]);            // Public Subnet，里面装着 EC2
    const ctx = { d, scope };
    const ranges = cellRanges(d);
    const xml = '<mxCell id="new-2" value="RDS" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="4"><mxGeometry x="20" y="80" width="120" height="60" as="geometry"/></mxCell>';
    const { applied, report } = applyOps(ctx, [{ kind: "add", cellId: "new-2", parentId: "4", xml }]);
    assert.equal(report.ok, true, `越界：${report.outOfScope}`);
    const after = parseDiagram(applied.xml);
    assert.equal(after.get("new-2").parent, "4");
    assert.equal(after.get("4").childIds.includes("new-2"), true);
    // 它是 <root> 的直接子节点、和 cell 4 平级 —— 父子关系完全靠 parent 属性
    assert.equal(after.rootNode.children.some((n) => n.attrs.get("id")?.value === "new-2"), true,
        "新增元素应当成为 <root> 的直接子节点（drawio 的扁平布局）");
    assert.equal(after.rootNode.children.some((n) => n.attrs.get("id")?.value === "5"), true);
    assert.equal(byteIdenticalOutside(d.text, applied.xml, applied.patches, ranges).ok, true);
});

test("结构性 op 也要过 guard：update/delete 作用域外的元素一律拒绝", () => {
    const ctx = setup(["16"]);
    for (const op of [
        { kind: "update", cellId: "10", xml: "<mxCell id=\"10\"/>" },
        { kind: "delete", cellId: "10" },
        { kind: "add", cellId: "new-3", parentId: "10", xml: "<mxCell id=\"new-3\"/>" },
    ]) {
        const g = guardOps([op], ctx.scope, { allowAiKinds: true });
        assert.equal(g.ok, false, `越界 op 没被拦：${JSON.stringify(op)}`);
    }
    // add 到 root 层是允许的（模型要能往图上加东西，但只能加到作用域内或 root）
    assert.equal(guardOps([{ kind: "add", cellId: "new-4", parentId: "1", xml: "<mxCell/>" }], ctx.scope, { allowAiKinds: true }).ok, true);
});

const edgeXml = (id, source, target) =>
    `<mxCell id="${id}" edge="1" parent="1" source="${source}" target="${target}" style="edgeStyle=orthogonalEdgeStyle;"><mxGeometry relative="1" as="geometry"/></mxCell>`;

test("add：xml 引用了图上不存在的端点 —— 拒绝，而不是塞一条浮动线", () => {
    const ctx = setup(["16", "10"]);
    // 端点都在图上：正常放行（"在这两个元素之间加一条连线"要能work）
    const good = opsToWrites(ctx.d, [{ kind: "add", cellId: "e-ok", parentId: "1", xml: edgeXml("e-ok", "16", "10") }]);
    assert.equal(good.writes.length, 1, `端点都存在却没放行：${good.warnings.join(" / ")}`);
    assert.equal(good.writes[0].structural.kind, "add");
    // 端点不存在：插件解码只能得到 null 端点（浮动线），而它会照样报"新增成功"（实测 probe-add-api）
    const bad = opsToWrites(ctx.d, [{ kind: "add", cellId: "e-bad", parentId: "1", xml: edgeXml("e-bad", "16", "9999") }]);
    assert.equal(bad.writes.length, 0);
    assert.ok(bad.warnings.some((w) => w.includes("9999") && w.includes("已拒绝")), bad.warnings.join(" / "));
});

test("guard：add 的新元素连到作用域外的元素也算越界（判据是挂在哪 + 连到谁）", () => {
    const outside = setup(["16"]);                 // 只有 16 在作用域内，10 在外面
    const bad = guardOps([{ kind: "add", cellId: "e-1", parentId: "1", xml: edgeXml("e-1", "16", "10") }], outside.scope, { allowAiKinds: true });
    assert.equal(bad.ok, false, "连到作用域外的元素没被拦");
    assert.ok(bad.rejected.some((r) => r.reason.includes("10") && r.reason.includes("越界")), JSON.stringify(bad.rejected));
    // 两端都在作用域内：放行
    const inside = setup(["16", "10"]);
    const ok = guardOps([{ kind: "add", cellId: "e-2", parentId: "1", xml: edgeXml("e-2", "16", "10") }], inside.scope, { allowAiKinds: true });
    assert.equal(ok.ok, true, `两端都在作用域内却被拦：${JSON.stringify(ok.rejected)}`);
});

test("update + style 落在同一个 cell：两者都生效（update 已被规约成属性写入）", () => {
    const ctx = setup(["16"]);
    const { writes } = opsToWrites(ctx.d, [
        { kind: "update", cellId: "16", xml: "<mxCell id=\"16\" value=\"X\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"1\" y=\"1\" width=\"1\" height=\"1\" as=\"geometry\"/></mxCell>" },
        { kind: "style", cellIds: ["16"], props: { fillColor: "#ff0000" } },
    ]);
    const w = writes.find((x) => x.cellId === "16");
    assert.equal(w.structural, null, "update 应当被规约成属性写入，不再走结构性通道");
    assert.equal(w.attrs.value, "X", "模型给的 value 不能丢");
    assert.ok(w.attrs.style.includes("fillColor=#ff0000"));
    const out = applyWrites(ctx.d, writes);            // 属性落在不同节点上，不该出现"补丁区间重叠"
    assert.equal(out.changedCells.includes("16"), true);
    const after = parseDiagram(out.xml).get("16");
    assert.equal(after.value, "X");                    // 新语义：模型的改值 + 确定性的改色都在
    assert.ok(after.style.includes("fillColor=#ff0000"));
});

test("id 撞车与不存在的目标：一行警告并跳过，不塞坏数据", () => {
    const ctx = setup(["16"]);
    const dup = opsToWrites(ctx.d, [{ kind: "add", cellId: "10", parentId: "1", xml: "<mxCell id=\"10\"/>" }]);
    assert.equal(dup.writes.length, 0);
    assert.ok(dup.warnings.some((w) => w.includes("已存在")));
    const missing = opsToWrites(ctx.d, [{ kind: "delete", cellId: "不存在" }]);
    assert.equal(missing.writes.length, 0);
    assert.ok(missing.warnings.some((w) => w.includes("不在图中")));
    const noParent = opsToWrites(ctx.d, [{ kind: "add", cellId: "n1", parentId: "也不存在", xml: "<mxCell/>" }]);
    assert.equal(noParent.writes.length, 0);
});

test("删除后的 XML 仍然是 drawio 能吃的结构：根/层都在，且能再次解析", () => {
    const ctx = setup(["16"]);
    const { applied } = applyOps(ctx, [{ kind: "delete", cellId: "16" }]);
    const again = parseDiagram(applied.xml);
    assert.equal(again.get("0").isRoot, true);
    assert.equal(again.get("1").isLayer, true);
    assert.equal(labelOf(again.get("10")), "订单");
});
