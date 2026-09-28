// 生成式通道：用**假的模型**跑（不联网），验的是"模型不听话时这套机制还成不成立"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram } from "../src/model.mjs";
import { resolveScope } from "../src/scope.mjs";
import { buildScopedPrompt, parseModelOps, runGenerative } from "../src/ai.mjs";
import { sample } from "./helpers.mjs";

const ctx = (roots = ["10", "11"]) => {
    const d = parseDiagram(sample("small-flow"));
    return { d, scope: resolveScope(d, roots) };
};
const fake = (...replies) => {
    let i = 0;
    const calls = [];
    const fn = async (prompt) => { calls.push(prompt); return { text: replies[Math.min(i++, replies.length - 1)], usage: { total_tokens: 100 + i }, ms: 5 }; };
    fn.calls = calls;
    return fn;
};

test("载荷：含三层作用域 + 用户要求 + 输出 schema + 硬约束", () => {
    const { d, scope } = ctx();
    const p = buildScopedPrompt(d, scope, "把这两个框合并成一个");
    assert.match(p, /\[可修改\] \d+ 个元素/);   // writable 含"相连的边"，所以不是 2
    assert.match(p, /\[只读·邻域\]/);
    assert.match(p, /硬约束：只允许对 \[可修改\] 内的 id/);
    assert.match(p, /用户的修改要求\] 把这两个框合并成一个/);
    assert.match(p, /"kind":"add"/);
    // 只给作用域，不给全图：未选中的元素不该出现在载荷里（除了骨架的计数行）
    assert.ok(!/id="12"/.test(p), "载荷里不该出现作用域外元素的完整 XML");
});

test("解析：能剥掉 ```json 围栏，也能吃裸数组", () => {
    const { d, scope } = ctx();
    const ok = '```json\n{"ops":[{"kind":"style","cellIds":["10"],"props":{"fillColor":"#ff0000"}}]}\n```';
    assert.equal(parseModelOps(ok, { diagram: d }).ops.length, 1);
    assert.equal(parseModelOps('[{"kind":"delete","cellId":"10"}]', { diagram: d }).ops.length, 1);
    assert.ok(parseModelOps("这不是 JSON", { diagram: d }).errors.length);
    assert.ok(parseModelOps('{"ops":[]}', { diagram: d }).errors.length);
});

test("解析：逐项校验 —— 幻觉 id、未知 kind、空目标、坏 xml 全都被拦", () => {
    const { d } = ctx();
    const raw = JSON.stringify({
        ops: [
            { kind: "style", cellIds: ["99"], props: { fillColor: "#f00" } },   // 图上没有 99
            { kind: "炸图", cellIds: ["10"] },                                   // 未知 kind
            { kind: "move", cellIds: [], params: { dx: 1 } },                    // 没有目标
            { kind: "update", cellId: "10", xml: "随便写点什么" },                // xml 不是 mxCell
            { kind: "add", cellId: "n1", parentId: "不存在", xml: "<mxCell/>" },  // 父容器不存在
            { kind: "style", cellIds: ["10"], props: { fillColor: "#ff0000" } },  // 这条是好的
        ],
    });
    const { ops, errors } = parseModelOps(raw, { diagram: d });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, "style");
    assert.equal(errors.length, 5);
    assert.ok(errors.some((e) => /不存在的 id：99/.test(e)));
    assert.ok(errors.some((e) => /kind=炸图/.test(e)));
});

test("生成式：模型一次就给对 → 直接采纳", async () => {
    const { d, scope } = ctx();
    const ask = fake(JSON.stringify({ ops: [{ kind: "style", cellIds: ["10", "11"], props: { fillColor: "#ff0000" } }] }));
    const r = await runGenerative({ diagram: d, scope, instruction: "都变红", askModel: ask });
    assert.equal(r.accepted, true);
    assert.equal(r.attempts, 1);
    assert.equal(ask.calls.length, 1);
    assert.equal(r.ops.length, 1);
});

test("生成式：模型越界 → 拒绝并把原因回灌重试；第二次改对了就采纳", async () => {
    const { d, scope } = ctx();
    const ask = fake(
        JSON.stringify({ ops: [{ kind: "style", cellIds: ["12"], props: { fillColor: "#f00" } }] }),   // 12 在作用域外
        JSON.stringify({ ops: [{ kind: "style", cellIds: ["10", "11"], props: { fillColor: "#f00" } }] }),
    );
    const r = await runGenerative({ diagram: d, scope, instruction: "都变红", askModel: ask });
    assert.equal(r.accepted, true);
    assert.equal(r.attempts, 2);
    assert.equal(r.log[0].ok, false);
    assert.equal(r.log[0].stage, "guard");
    assert.match(r.log[0].rejected[0], /越界/);
    // 第二次的载荷必须带上"上次为什么被拒"
    assert.match(ask.calls[1], /上一次的输出被拒绝了/);
    assert.match(ask.calls[1], /越界/);
});

test("生成式：两次都不听话 → 明确失败，不产生任何 op（绝不部分应用）", async () => {
    const { d, scope } = ctx();
    const bad = JSON.stringify({ ops: [{ kind: "delete", cellId: "12" }, { kind: "style", cellIds: ["16"], props: {} }] });
    const r = await runGenerative({ diagram: d, scope, instruction: "删掉那个", askModel: fake(bad, bad) });
    assert.equal(r.accepted, false);
    assert.equal(r.attempts, 2);
    assert.deepEqual(r.ops, []);
    assert.ok(r.errors.length >= 2);
});

test("生成式：add 到 root 层是合法的（parentId 1）", async () => {
    const { d, scope } = ctx();
    const xml = '<mxCell id="new-x" value="新节点" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>';
    const ask = fake(JSON.stringify({ ops: [{ kind: "add", cellId: "new-x", parentId: "1", xml }] }));
    const r = await runGenerative({ diagram: d, scope, instruction: "加一个节点", askModel: ask });
    assert.equal(r.accepted, true);
});
