import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram } from "../src/model.mjs";
import { resolveScope } from "../src/scope.mjs";
import { runCommand, opsToWrites } from "../src/commands.mjs";
import { applyWrites } from "../src/apply.mjs";
import { guardOps, verifyCandidate } from "../src/guard.mjs";
import { sample } from "./helpers.mjs";

const ctx = (roots = ["10"], name = "small-flow") => {
    const d = parseDiagram(sample(name));
    const scope = resolveScope(d, roots);
    return { d, scope };
};

test("意图层：越界 id 一律拒绝，而且是整批拒绝", () => {
    const { scope } = ctx(["10"]);
    const ops = [
        { kind: "style", cellIds: ["10"], props: { fillColor: "#fff" } },
        { kind: "style", cellIds: ["16"], props: { fillColor: "#f00" } },   // 16 是作用域外的节点
    ];
    const g = guardOps(ops, scope);
    assert.equal(g.ok, false);
    assert.match(g.rejected[0].reason, /越界：16/);
    assert.equal(g.checkedOps, 2);
});

test("意图层：未知 kind / 空 ops / 无目标都会被拒", () => {
    const { scope } = ctx(["10"]);
    assert.equal(guardOps([{ kind: "删库跑路", cellIds: ["10"] }], scope).ok, false);
    assert.equal(guardOps([], scope).ok, false);
    assert.equal(guardOps([{ kind: "move", cellIds: [], params: {} }], scope).ok, false);
    assert.equal(guardOps([{ kind: "style", cellIds: ["10"], props: {} }], scope).ok, false);
});

test("意图层：AI 通道的 op 默认不放行（Phase 1 只有确定性通道）", () => {
    const { scope } = ctx(["10"]);
    const g = guardOps([{ kind: "update", cellId: "10", xml: "<mxCell/>" }], scope);
    assert.equal(g.ok, false);
    assert.match(g.rejected[0].reason, /Phase 1 原型不放行/);
    // 显式开关打开后，作用域内 update 可以通过
    assert.equal(guardOps([{ kind: "update", cellId: "10", xml: "<mxCell/>" }], scope, { allowAiKinds: true }).ok, true);
    // 但依然不能越界
    assert.equal(guardOps([{ kind: "update", cellId: "16", xml: "<mxCell/>" }], scope, { allowAiKinds: true }).ok, false);
    assert.equal(guardOps([{ kind: "delete", cellId: "16" }], scope, { allowAiKinds: true }).ok, false);
});

test("意图层：add 的 parent 必须落在作用域内（drawio 默认层 1 例外）", () => {
    const { scope } = ctx(["10"]);
    assert.equal(guardOps([{ kind: "add", parentId: "10", xml: "<mxCell/>" }], scope, { allowAiKinds: true }).ok, true);
    assert.equal(guardOps([{ kind: "add", parentId: "1", xml: "<mxCell/>" }], scope, { allowAiKinds: true }).ok, true);
    assert.equal(guardOps([{ kind: "add", parentId: "16", xml: "<mxCell/>" }], scope, { allowAiKinds: true }).ok, false);
});

test("结果层：改动集合必须 ⊆ writable（这条不依赖任何人的自述）", () => {
    const { d, scope } = ctx(["10"]);
    const planned = opsToWrites(d, runCommand(d, scope, "style", { props: { fillColor: "#f00" } }).ops);
    const applied = applyWrites(d, planned.writes);
    const report = verifyCandidate(d.text, applied.xml, scope);
    assert.equal(report.ok, true);
    assert.deepEqual(report.changed.sort(), [...scope.writable].sort());
    // 手工把作用域外的元素也改掉，结果层必须抓到
    const tampered = applied.xml.replace('fillColor=#d5e8d4', 'fillColor=#123456');
    const caught = verifyCandidate(d.text, tampered, scope);
    assert.equal(caught.ok, false);
    assert.ok(caught.outOfScope.length >= 1);
});

test("结果层：新增元素的判据是它的父容器（parent 在作用域外就拦）", () => {
    const { d, scope } = ctx(["10"]);
    const mk = (parent) => d.text.replace("</root>",
        `<mxCell id="999" value="偷偷加的" style="" vertex="1" parent="${parent}"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell></root>`);
    // 挂到作用域外的容器（16 不在 writable）→ 越界。用 id 判也拦得住，但判据是 parent。
    const sneaky = verifyCandidate(d.text, mk("16"), scope);
    assert.equal(sneaky.ok, false);
    assert.deepEqual(sneaky.added, ["999"]);
    assert.deepEqual(sneaky.outOfScope, ["999"]);
    // 挂到 root 层是**合法**新增（设计文档 §5.5-2：新增元素的 parent 可以是作用域内元素或 root）。
    // 早先这里判"新增 id 必须 ∈ writable"，等于把所有合法新增都判成越界 —— 加 AI 通道的 add 时才发现。
    const legit = verifyCandidate(d.text, mk("1"), scope);
    assert.equal(legit.ok, true, "挂在 root 层下的新增不该被判越界");
    assert.deepEqual(legit.added, ["999"]);

    const removed = d.text.replace(/<mxCell id="12"[^]*?<\/mxCell>\s*/, "");
    const removedReport = verifyCandidate(d.text, removed, scope);
    assert.equal(removedReport.ok, false);
    assert.deepEqual(removedReport.removed, ["12"]);
});

test("结果层是语义比较：重新排版空白不算越界", () => {
    const { d, scope } = ctx(["10"]);
    const reformatted = d.text.replace(/\n\s*/g, "\n");
    const report = verifyCandidate(d.text, reformatted, scope);
    assert.equal(report.ok, true);
    assert.deepEqual(report.changed, []);
});

test("结果层：把作用域外的元素挪进作用域（改 parent）同样算越界改动", () => {
    const { d, scope } = ctx(["10"]);
    const reparented = d.text.replace(/(<mxCell id="16"[^>]*?)parent="1"/, '$1parent="10"');
    // 原来 16 的 parent 是 1，这里改成 10（作用域内）→ 16 自己进了改动集合，而 16 不在 writable
    const report = verifyCandidate(d.text, reparented, scope);
    assert.ok(report.changed.includes("16"));
    assert.equal(report.ok, false);
    assert.deepEqual(report.outOfScope, ["16"]);
});
