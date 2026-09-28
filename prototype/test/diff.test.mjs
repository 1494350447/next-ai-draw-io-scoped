import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram } from "../src/model.mjs";
import { resolveScope } from "../src/scope.mjs";
import { runCommand, opsToWrites } from "../src/commands.mjs";
import { applyWrites } from "../src/apply.mjs";
import { diffDiagrams, summarizeDiff } from "../src/diff.mjs";
import { sample } from "./helpers.mjs";

const flow = () => parseDiagram(sample("small-flow"));

test("diff：几何只改 x 时，只报 x 一项（带 delta）", () => {
    const d = flow();
    const scope = resolveScope(d, ["10", "11"]);
    const { ops } = runCommand(d, scope, "align", { mode: "left" });
    const { writes } = opsToWrites(d, ops);
    const applied = applyWrites(d, writes);
    const diff = diffDiagrams(d.text, applied.xml);
    assert.equal(diff.changed.length, 1);
    const [c] = diff.changed;
    assert.equal(c.id, "11");                     // 左对齐以最左的 10 为锚点，所以动的只有 11
    assert.equal(c.kind, "vertex");
    assert.deepEqual(c.fields.map((f) => f.key), ["geometry.x"]);
    assert.equal(c.fields[0].from, 200);   // 几何是数字（可以算 delta），样式/文字是字符串
    assert.equal(c.fields[0].to, 80);
    assert.equal(c.fields[0].delta, -120);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 0);
});

test("diff：样式按键比较，不受样式字符串顺序影响", () => {
    const d = flow();
    const scope = resolveScope(d, ["10"]);
    const { ops } = runCommand(d, scope, "style", { props: { fillColor: "#ffcc00" } });
    const { writes } = opsToWrites(d, ops);
    const applied = applyWrites(d, writes);
    const diff = diffDiagrams(d.text, applied.xml);
    const keys = diff.changed[0].fields.map((f) => f.key);
    assert.deepEqual(keys, ["style.fillColor"]);
    assert.equal(diff.changed[0].fields[0].from, "#dae8fc");
    assert.equal(diff.changed[0].fields[0].to, "#ffcc00");
    // 顺序被重排过（否则这条测试没有意义）
    assert.notEqual(parseDiagram(applied.xml).get("10").style, d.get("10").style);
});

test("diff：没改动时为空；删除/新增也能识别", () => {
    const d = flow();
    assert.equal(diffDiagrams(d.text, d.text).total, 0);
    const cut = d.text.replace(/<mxCell id="16"[\s\S]*?<\/mxCell>/, "");
    const diff = diffDiagrams(d.text, cut);
    assert.deepEqual(diff.removed.map((r) => r.id), ["16"]);
    assert.equal(diffDiagrams(cut, d.text).added.map((a) => a.id)[0], "16");
    assert.equal(summarizeDiff(diffDiagrams(d.text, d.text)), "没有任何改动");
});

test("diff：摘要句式稳定（给日志和 UI 用）", () => {
    const d = flow();
    const scope = resolveScope(d, ["10", "11"]);
    const { ops } = runCommand(d, scope, "move", { dx: 20, dy: 0 });
    const { writes } = opsToWrites(d, ops);
    const applied = applyWrites(d, writes);
    const s = summarizeDiff(diffDiagrams(d.text, applied.xml));
    assert.match(s, /^10\(x /);
    assert.match(s, /11\(x /);
});
