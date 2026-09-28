import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram } from "../src/model.mjs";
import { resolveScope } from "../src/scope.mjs";
import { runCommand, opsToWrites } from "../src/commands.mjs";
import { applyWrites } from "../src/apply.mjs";
import { sample } from "./helpers.mjs";

const setup = (roots, name = "small-flow") => {
    const d = parseDiagram(sample(name));
    const scope = resolveScope(d, roots);
    return { d, scope };
};
const run = (ctx, command, params) => {
    const { ops, warnings } = runCommand(ctx.d, ctx.scope, command, params);
    const { writes } = opsToWrites(ctx.d, ops);
    return { ops, writes, warnings };
};
const writeOf = (writes, id) => writes.find((w) => w.cellId === id)?.attrs;

test("对齐（同一父容器）：以选区包围盒为基准，数值精确", () => {
    const ctx = setup(["10", "11", "12"]);          // y=80 / 140 / 80，高都是 60
    const { writes } = run(ctx, "align", { mode: "middle" });
    const boxTop = 80, boxBottom = 200;             // y 80..140+60
    const centerY = (boxTop + boxBottom) / 2;       // 140
    assert.equal(writeOf(writes, "10").y, Math.round(centerY - 30));
    assert.equal(writeOf(writes, "11").y, Math.round(centerY - 30));
    assert.equal(writeOf(writes, "12").y, Math.round(centerY - 30));
});

test("对齐锚点可选：largest 时以面积最大的元素为准", () => {
    const ctx = setup(["10", "13"]);                // 13 是大容器
    const { writes } = run(ctx, "align", { mode: "left", anchor: "largest" });
    assert.equal(writeOf(writes, "10").x, 60);      // 13 的 x=60
    assert.equal(writeOf(writes, "13"), undefined); // 锚点自己不用写
});

test("分布：两端保持原位（不产生无意义写入）、中间等距", () => {
    const ctx = setup(["10", "11", "12"]);
    const { writes } = run(ctx, "distribute", { axis: "x" });
    // 10: x=80 w=120；12: x=480 w=120 → 两端 80..600，总宽 360，间隙 =(600-80-360)/2=80
    assert.equal(writeOf(writes, "11").x, 280);
    assert.equal(writeOf(writes, "10"), undefined, "左端本来就在最左，不该产生写入");
    assert.equal(writeOf(writes, "12"), undefined, "右端同理");
    assert.equal(writes.length, 1);
});

test("等尺寸：以面积最大的为基准，锚点自己不写", () => {
    const ctx = setup(["10", "13"]);
    const { writes } = run(ctx, "size", { mode: "width" });
    assert.equal(writeOf(writes, "10").width, 560);
    assert.equal(writeOf(writes, "13"), undefined);
});

test("移动：只动选中的（含隐式纳入的边）", () => {
    const ctx = setup(["10"]);
    const { writes } = run(ctx, "move", { dx: 10, dy: -5 });
    assert.deepEqual(writeOf(writes, "10"), { x: 90, y: 75 });
});

test("样式：白名单外的属性被丢弃并提示；命中所有 writable", () => {
    const ctx = setup(["10"]);
    const { ops, writes, warnings } = run(ctx, "style", { props: { fillColor: "#ffffff", 危险属性: "x" } });
    assert.ok(warnings.some((w) => w.includes("白名单")));
    assert.equal(writes.length, ctx.scope.writable.length);
    assert.match(writeOf(writes, "10").style, /fillColor=#ffffff/);
    assert.ok(!JSON.stringify(writes).includes("危险属性"));
    assert.deepEqual(ops[0].cellIds.sort(), [...ctx.scope.writable].sort());
});

test("样式是合并而不是覆盖：原有样式键保留", () => {
    const ctx = setup(["10"]);
    const { writes } = run(ctx, "style", { props: { fontSize: "20" } });
    const style = writeOf(writes, "10").style;
    assert.match(style, /fillColor=#dae8fc/);       // 原有键还在
    assert.match(style, /fontSize=20/);
    assert.match(style, /strokeColor=#6c8ebf/);
});

test("跨父容器的几何命令：按父容器分组，各组独立算基准", () => {
    // 两个容器各装两个元素，坐标是"相对父容器"的，所以必须分组算
    const xml = `<mxfile><diagram id="p" name="P"><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="20" value="容器A" style="" vertex="1" parent="1"><mxGeometry x="0" y="0" width="200" height="100" as="geometry"/></mxCell>
      <mxCell id="21" value="容器B" style="" vertex="1" parent="1"><mxGeometry x="300" y="0" width="200" height="100" as="geometry"/></mxCell>
      <mxCell id="22" value="a1" style="" vertex="1" parent="20"><mxGeometry x="10" y="10" width="40" height="20" as="geometry"/></mxCell>
      <mxCell id="23" value="a2" style="" vertex="1" parent="20"><mxGeometry x="90" y="40" width="40" height="20" as="geometry"/></mxCell>
      <mxCell id="24" value="b1" style="" vertex="1" parent="21"><mxGeometry x="20" y="30" width="40" height="20" as="geometry"/></mxCell>
      <mxCell id="25" value="b2" style="" vertex="1" parent="21"><mxGeometry x="120" y="60" width="40" height="20" as="geometry"/></mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    const d = parseDiagram(xml);
    const scope = resolveScope(d, ["22", "23", "24", "25"]);
    const { ops, writes, warnings } = run({ d, scope }, "align", { mode: "left" });
    assert.equal(ops.length, 2, "两个父容器 → 两个 op");
    assert.ok(warnings.some((w) => w.includes("不在同一个父容器")));
    // 每组以自己组的包围盒最左为准；本来就在最左的那个不产生写入
    assert.equal(writeOf(writes, "23").x, 10);   // 容器 A 组最左是 22 的 x=10
    assert.equal(writeOf(writes, "22"), undefined);
    assert.equal(writeOf(writes, "25").x, 20);   // 容器 B 组最左是 24 的 x=20
    assert.equal(writeOf(writes, "24"), undefined);
});

test("跨父容器但每组只有 1 个元素时不产出 op，只给提示", () => {
    const ctx = setup(["5", "6"], "aws-demo");      // 5 在 subnet(4)，6 在 cloud(2)
    const { ops, warnings } = run(ctx, "align", { mode: "left" });
    assert.deepEqual(ops, []);
    assert.ok(warnings.some((w) => w.includes("不在同一个父容器")));
    assert.ok(warnings.some((w) => w.includes("至少要选中 2 个")));
});

test("参数不足时不产出无效 op，只给提示", () => {
    const ctx = setup(["10"]);
    assert.deepEqual(run(ctx, "align", { mode: "left" }).ops, []);
    assert.deepEqual(run(ctx, "distribute", { axis: "x" }).ops, []);
    assert.deepEqual(run(ctx, "move", { dx: 0, dy: 0 }).ops, []);
    assert.throws(() => run(ctx, "align", { mode: "斜着对齐" }), /未知的对齐方式/);
    assert.throws(() => run(ctx, "没有这个命令", {}), /未知命令/);
});

test("命令产出的 writes 全部落在 writable 内，且真的只改这些 cell", () => {
    for (const name of ["small-flow", "aws-demo"]) {
        const d = parseDiagram(sample(name));
        for (const roots of [["10"], ["13"], ["2"]]) {
            if (!roots.every((r) => d.get(r))) continue;
            const scope = resolveScope(d, roots);
            for (const [cmd, params] of [
                ["style", { props: { fillColor: "#ff0000" } }],
                ["move", { dx: 5, dy: 5 }],
            ]) {
                const { writes } = run({ d, scope }, cmd, params);
                const writable = new Set(scope.writable);
                for (const w of writes) assert.ok(writable.has(w.cellId), `${w.cellId} 不在作用域内`);
                const out = applyWrites(d, writes);
                for (const id of out.changedCells) {
                    assert.ok(writable.has(id), `${cmd} 改到了作用域外的 ${id}`);
                }
            }
        }
    }
});

test("styles 的 targets 取舍：vertices 跳过连线，roots 只改选中的", () => {
    const ctx = setup(["10"]);
    const all = run(ctx, "style", { props: { fillColor: "#ff0000" } });
    const verts = run(ctx, "style", { props: { fillColor: "#ff0000" }, targets: "vertices" });
    const roots = run(ctx, "style", { props: { fillColor: "#ff0000" }, targets: "roots" });
    assert.equal(all.writes.length, ctx.scope.writable.length, "默认仍然是全部 writable");
    assert.ok(verts.writes.length < all.writes.length, "vertices 应当排除连线");
    assert.deepEqual(roots.writes.map((w) => w.cellId), ["10"]);
});

test("fontStyle 在白名单里（否则'加粗'会被静默丢掉）", () => {
    const ctx = setup(["10"]);
    const { writes, warnings } = run(ctx, "style", { props: { fontStyle: "1" } });
    assert.ok(!warnings.some((w) => w.includes("白名单")));
    assert.match(writeOf(writes, "10").style, /fontStyle=1/);
});

test("square：宽高统一到长边，只动选中的、别的属性一律不碰", () => {
    const ctx = setup(["10", "13"]);              // 120x60 与 560x320：边长不同，能测出"各自变方"
    const geo = (id) => ctx.d.get(id).geometry;
    const side10 = Math.max(geo("10").width, geo("10").height);
    const side13 = Math.max(geo("13").width, geo("13").height);
    assert.notEqual(side10, side13, "样例没选好：两个元素的边长一样，测不出'各自变方'");
    const { writes, warnings } = run(ctx, "square", { targets: "vertices" });
    assert.deepEqual(warnings, []);
    // 落在 XML 上验：两个元素各自变成正方形，位置/样式一个都不许动
    const out = applyWrites(ctx.d, writes);
    const after = parseDiagram(out.xml);
    for (const [id, side] of [["10", side10], ["13", side13]]) {
        assert.equal(after.get(id).geometry.width, side, `${id} 的宽应当是长边`);
        assert.equal(after.get(id).geometry.height, side, `${id} 的高应当是长边`);
        assert.equal(after.get(id).geometry.x, geo(id).x, `${id} 的 x 不该动`);
        assert.equal(after.get(id).geometry.y, geo(id).y, `${id} 的 y 不该动`);
        assert.equal(after.get(id).style, ctx.d.get(id).style, `${id} 的样式不该动`);
    }
    // 作用域外一个都没改（"只动选中的"是这个功能的硬承诺）
    assert.equal(out.changedCells.every((id) => ["10", "13"].includes(id)), true, out.changedCells.join(","));
});
