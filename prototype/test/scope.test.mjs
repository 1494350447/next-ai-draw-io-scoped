import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram } from "../src/model.mjs";
import { resolveScope, estimateTokens } from "../src/scope.mjs";
import { sample, synthDiagram } from "./helpers.mjs";

const hasContextId = (scope, id) => [
    ...scope.context.ancestors, ...scope.context.siblings, ...scope.context.edges,
].some((c) => c.id === id);

const aws = () => parseDiagram(sample("aws-demo"));

test("writable = 选中元素 + 子孙 + 相连的边（默认）", () => {
    const d = aws();
    const scope = resolveScope(d, ["3"]);          // VPC
    assert.deepEqual(scope.writable.sort(), ["3", "4", "5", "9"].sort());
    assert.equal(scope.edgeReason["9"], "boundary");   // 一端在作用域内
    assert.deepEqual(scope.roots, ["3"]);
});

test("includeEdges='internal' 时边界边降级为只读上下文（不改它就不会断线）", () => {
    const d = aws();
    const scope = resolveScope(d, ["5"], { includeEdges: "internal" });
    assert.deepEqual(scope.writable, ["5"]);
    assert.deepEqual(scope.context.edges.map((c) => c.id), ["9"]);
});

test("上下文三层互斥：祖先/兄弟是只读，且不出现在 skeleton 里", () => {
    const d = aws();
    const scope = resolveScope(d, ["5"]);
    const contextIds = new Set([
        ...scope.context.ancestors.map((c) => c.id),
        ...scope.context.siblings.map((c) => c.id),
        ...scope.context.edges.map((c) => c.id),
    ]);
    assert.deepEqual(scope.context.ancestors.map((c) => c.id), ["4", "3", "2", "1"]);
    for (const id of scope.writable) assert.ok(!contextIds.has(id), `${id} 同时出现在 writable 与 context`);
    for (const item of scope.skeleton) {
        assert.ok(!contextIds.has(item.id) && !scope.writable.includes(item.id));
        assert.equal(item.geometry, undefined, "骨架不带 geometry（省 token 的关键）");
    }
});

test("容器的 childCount 只给数字，不给子元素明细（骨架的意义）", () => {
    const d = aws();
    const scope = resolveScope(d, ["7"]);
    // aws-demo 里 3(VPC) 直接子元素只有 4(Public Subnet)，5(EC2) 是 4 的孩子
    const vpc = scope.skeleton.find((s) => s.id === "3");
    assert.equal(vpc.container, true);
    assert.equal(vpc.childCount, 1);
    assert.equal(vpc.geometry, undefined);
    assert.equal(vpc.label, "VPC");
});

test("无效 roots 会被提示并跳过；全空则报错", () => {
    const d = aws();
    const scope = resolveScope(d, ["5", "不存在", "0"]);
    assert.deepEqual(scope.roots, ["5"]);
    assert.equal(scope.warnings.length, 2);
    assert.throws(() => resolveScope(d, []), /没有有效的选中元素/);
});

test("token 估算：叶子选择远小于全量，且 token 数随作用域单调增长", () => {
    const d = aws();
    const leaf = resolveScope(d, ["7"]);
    const big = resolveScope(d, ["3"]);
    assert.ok(leaf.estimate.scopedTokens < big.estimate.scopedTokens);
    assert.ok(leaf.estimate.scopedTokens < leaf.estimate.fullTokens);
    assert.ok(leaf.estimate.ratio < 0.35, `叶子选择占比过高：${leaf.estimate.ratio}`);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("中文"), 2);
});

// —— 回归：邻域必须有界（这是被验收 3 抓出来的真实缺陷）——
// 扁平图（drawio 最常见形态）里所有元素 parent="1"，于是"兄弟" == 全图。
// 不设上限时 skeleton 会被挤空、compact/full 完全等价，作用域退化成"把整张图塞进 prompt"。
test("邻域有界：扁平大图的兄弟按邻近度截断，被截断者降级进骨架而不是消失", () => {
    const d = parseDiagram(synthDiagram(200));
    const scope = resolveScope(d, ["v7", "v8", "v9"]);
    assert.equal(scope.context.siblingsTotal, 392);
    assert.ok(scope.context.siblings.length <= 12, `邻域兄弟没有被截断：${scope.context.siblings.length}`);
    assert.equal(scope.context.siblingsOmitted, scope.context.siblingsTotal - scope.context.siblings.length);
    // 离选区最近、最可能被误伤的邻居要留下（v6 = v7 的上游）
    assert.ok(scope.context.siblings.some((s) => s.id === "v6"), "最近的邻居没进邻域");
    // 被裁掉的不能凭空消失：必须出现在骨架里
    const skeletonIds = new Set(scope.skeleton.map((s) => s.id));
    for (const id of ["v200", "e1", "e199"]) {
        assert.ok(!scope.writable.includes(id) && !hasContextId(scope, id), `${id} 意外出现在作用域内`);
        assert.ok(skeletonIds.has(id), `${id} 既不在邻域也不在骨架里 → 丢失了`);
    }
    assert.equal(scope.skeleton.every((s) => s.geometry === undefined), true);
    assert.ok(scope.warnings.some((w) => w.includes("降级为骨架计数")), "裁剪邻域必须给出提示");
    assert.ok(scope.estimate.skeletonCells > 300, "骨架应当承接被裁掉的元素");
});

test("maxSiblings 可调：设 0 时邻域只剩祖先/边，兄弟全部走骨架计数", () => {
    const d = parseDiagram(synthDiagram(200));
    const scope = resolveScope(d, ["v7", "v8", "v9"], { maxSiblings: 0 });
    assert.equal(scope.context.siblings.length, 0);
    assert.equal(scope.context.siblingsOmitted, 392);
    // 邻域被压到最省，token 进一步下降
    assert.ok(scope.estimate.scopedTokens < resolveScope(d, ["v7", "v8", "v9"]).estimate.scopedTokens);
});

test("分段 token 账单可归因：各段之和 ≈ scopedTokens，且约束行是固定开销", () => {
    const d = parseDiagram(synthDiagram(200));
    const scope = resolveScope(d, ["v7", "v8", "v9"]);
    const b = scope.estimate.breakdown;
    assert.ok(Math.abs(b.total - scope.estimate.scopedTokens) <= 4, `分段账单与总数差异过大：${b.total} vs ${scope.estimate.scopedTokens}`);
    assert.ok(b.writable > 0 && b.constraint > 0);
    assert.ok(b.skeleton < b.writable, "结构骨架不该比可改部分还贵（那就白设骨架了）");
});
