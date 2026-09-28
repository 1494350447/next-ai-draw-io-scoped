// 服务端接口的回归测试（不起浏览器，用真实 HTTP 打一遍）。
//
// 这两条都是**跑浏览器冒烟时才暴露**的真实缺陷，所以必须固化成测试：
//   ① 空选区是首屏的默认状态，不能是 500 —— 否则前端 `refresh()` 抛错，大纲树永远渲染不出来；
//   ② 静态文件缺失要 404 而不是 500（浏览器会自动请求 /favicon.ico，别把控制台刷红）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

const xml = readFileSync(path.join(ROOT, "samples", "small-flow.xml"), "utf8");
const post = (p, body) => fetch(BASE + p, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

/**
 * 生成式通道的测试**不连真实模型**：本地起一个 OpenAI 兼容的假接口，把响应体控制在我们手里。
 * 这样"模型越界会不会被挡""返回结构对不对"都能离线断言，也不会花钱、不会 flaky。
 */
const STUB_PORT = 8793, GEN_PORT = 8792, NOKEY_PORT = 8794;
let stubReply = null;          // 每次请求返回什么，由用例设置
let stubCalls = 0;             // 模型被调了几次（用来断言"命中规则时不该调模型"）
let stub, genChild, noKeyChild;

const waitUp = async (url) => {
    const deadline = Date.now() + 10000;
    for (;;) {
        try { const r = await fetch(url); if (r.ok) return; } catch { /* 还没起来 */ }
        if (Date.now() > deadline) throw new Error(`没能在 10s 内起来：${url}`);
        await new Promise((r) => setTimeout(r, 150));
    }
};

before(async () => {
    stub = createServer((req, res) => {
        stubCalls += 1;
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                choices: [{ message: { content: JSON.stringify({ ops: stubReply }) } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
    await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

    const boot = (port, env) => spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
        env: { ...process.env, PORT: String(port), ...env }, stdio: "ignore",
    });
    genChild = boot(GEN_PORT, {
        DEEPSEEK_API_KEY: "stub-key-not-a-real-secret",
        AI_MODEL: "stub-model",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
    });
    noKeyChild = boot(NOKEY_PORT, { DEEPSEEK_API_KEY: "", AI_MODEL: "stub-model" });
    await waitUp(`http://127.0.0.1:${GEN_PORT}/api/meta`);
    await waitUp(`http://127.0.0.1:${NOKEY_PORT}/api/meta`);
});

let child;
before(async () => {
    child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
        env: { ...process.env, PORT: String(PORT) }, stdio: "ignore",
    });
    const deadline = Date.now() + 10000;
    for (;;) {
        try { const r = await fetch(BASE + "/api/meta"); if (r.ok) return; } catch { /* 还没起来 */ }
        if (Date.now() > deadline) throw new Error("原型服务没能在 10s 内起来");
        await new Promise((r) => setTimeout(r, 150));
    }
});
after(() => { child?.kill(); genChild?.kill(); noKeyChild?.kill(); stub?.close(); });

test("空选区是正常状态：/api/resolve-scope 返回 200 + scope=null + 提示，而不是 500", async () => {
    const res = await post("/api/resolve-scope", { xml, roots: [] });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.scope, null);
    assert.match(data.hint, /先选择要修改的元素/);
    assert.ok(data.abstract.cells.length > 0, "即使没选中，也要能返回结构摘要（否则大纲树画不出来）");
});

test("空选区下执行命令：软拒绝（200 + applied=false + 提示），不是报错", async () => {
    const res = await post("/api/command", { xml, roots: [], command: "align", params: { mode: "left" } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.applied, false);
    assert.equal(data.after, null);
    assert.match(data.warnings[0], /先选择要修改的元素/);
});

test("结构摘要只给用户元素：不含根占位 0 和默认层 1（含了会让前端把每行渲染两遍）", async () => {
    const { abstract } = await (await post("/api/resolve-scope", { xml, roots: [] })).json();
    const ids = abstract.cells.map((c) => c.id);
    assert.ok(!ids.includes("0"), "不该把根占位 0 当元素");
    assert.ok(!ids.includes("1"), "不该把默认层 1 当元素");
    assert.deepEqual(ids, [...new Set(ids)], "元素列表不能重复");
});

test("静态文件缺失返回 404（不是 500）", async () => {
    assert.equal((await fetch(BASE + "/favicon.ico")).status, 404);
    assert.equal((await fetch(BASE + "/nope.css")).status, 404);
    assert.equal((await fetch(BASE + "/")).status, 200);
});

test("正常选区：命令走通，三层 guard 全绿", async () => {
    const res = await post("/api/command", { xml, roots: ["10", "11"], command: "align", params: { mode: "left" } });
    const data = await res.json();
    assert.equal(data.applied, true);
    assert.equal(data.guard.intent.ok, true);
    assert.equal(data.guard.result.ok, true);
    assert.equal(data.guard.byteIdentical.ok, true);
    assert.ok(data.after.xml.includes('x="'));
});

// ---- 生成式通道（/api/generate）----

const genPost = (body) => fetch(`http://127.0.0.1:${GEN_PORT}/api/generate`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("生成式通道：模型产出作用域内的 op → 落到 XML，且报告里带的是**真实** guard 与账本", async () => {
    stubReply = [{ kind: "style", cellIds: ["10"], props: { fillColor: "#ff0000" } }];
    const res = await genPost({ xml, roots: ["10"], includeEdges: "internal", instruction: "把它涂红一点" });
    assert.equal(res.status, 200);
    const g = await res.json();
    assert.equal(g.configured, true);
    assert.equal(g.model, "stub-model");
    assert.equal(g.attempts, 1);
    assert.equal(g.applied, true);
    // 回归：accepted 分支曾经用占位 guard 覆盖了真实 guard（applied=true 但 guard.result=null）
    assert.ok(g.guard.result, "guard.result 不能被占位值覆盖成 null");
    assert.equal(g.guard.result.ok, true);
    assert.equal(g.guard.byteIdentical.ok, true);
    assert.equal(g.diff.total, 1);
    assert.deepEqual(g.diff.changed.map((c) => c.id), ["10"]);
    assert.equal(g.usage.total_tokens, 15, "token 用量要透传给前端（成本可见）");
    assert.ok(g.after.xml.includes('fillColor=#ff0000'), "改动真的写进了 XML");
    assert.ok(!JSON.stringify(g).includes("stub-key-not-a-real-secret"), "密钥绝不能出现在响应里");
});

test("生成式通道：模型越界 → 整批拒绝，一个字节都不写", async () => {
    stubReply = [{ kind: "delete", cellId: "11" }];   // 11 不在 roots=["10"] 的作用域内
    const g = await (await genPost({ xml, roots: ["10"], includeEdges: "internal", instruction: "把 11 删了" })).json();
    assert.equal(g.applied, false);
    assert.equal(g.attempts, 2, "第一次被拒后要带着原因重试一次");
    assert.ok(!g.after, "被拒绝时不能回传 after（前端据此判断没写入）");
    assert.ok(g.warnings.some((w) => /越界/.test(w)), `警告里要写清越界原因，实际：${g.warnings}`);
    assert.equal(g.diff.total, 0);
});

test("生成式通道未配置：200 + configured=false + 说清原因，而不是 500", async () => {
    const g = await (await fetch(`http://127.0.0.1:${NOKEY_PORT}/api/generate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ xml, roots: ["10"], instruction: "随便改点什么" }),
    })).json();
    assert.equal(g.configured, false);
    assert.equal(g.applied, false);
    assert.match(g.summary, /DEEPSEEK_API_KEY/);
    assert.ok(g.prompt, "即使没配置，也要能给出作用域载荷（它本身就有价值）");
    const meta = await (await fetch(`http://127.0.0.1:${NOKEY_PORT}/api/meta`)).json();
    assert.deepEqual(meta.generative, { configured: false, model: "stub-model", baseUrl: "https://api.deepseek.com" });
});

// ---- 确认单（dry-run）----
// 产品要求：写回之前先让用户看清"将改 N 个元素"。dry-run 必须与真跑**算得一模一样**，
// 只是结论不落地 —— 否则"预览看到的"和"确认后得到的"就会不一致，比没有预览更糟。

const cmdPost = (body) => fetch(BASE + "/api/command", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("dry-run：预览与真跑算出的结果逐字节相同，只是不落地", async () => {
    const body = { xml, roots: ["10", "11"], command: "align", params: { mode: "left" } };
    const preview = await (await cmdPost({ ...body, dryRun: true })).json();
    assert.equal(preview.dryRun, true);
    assert.equal(preview.applied, false, "dry-run 绝不能声称已应用");
    assert.equal(preview.wouldApply, true);
    assert.ok(preview.after?.xml, "预览必须给出 after.xml（前端用它渲染'应用后的样子'）");

    const real = await (await cmdPost(body)).json();
    assert.equal(real.dryRun, false);
    assert.equal(real.applied, true);
    assert.equal(real.after.xml, preview.after.xml, "预览与真跑必须逐字节一致");
    assert.deepEqual(real.diff, preview.diff, "改动账本也必须一致");
    assert.deepEqual(real.guard.result, preview.guard.result, "结果层结论也要一致");
});

test("dry-run：被拒时明确 wouldApply=false，且不给 after（没有可确认的东西）", async () => {
    const outside = xml.includes('id="12"') ? "12" : null;
    assert.ok(outside, "样例里得有作用域外的元素");
    const g = await (await fetch(BASE + "/api/apply-ops", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ xml, roots: ["10"], includeEdges: "internal", dryRun: true, ops: [{ kind: "delete", cellId: "12" }] }),
    })).json();
    assert.equal(g.dryRun, true);
    assert.equal(g.applied, false);
    assert.equal(g.wouldApply, false);
    assert.ok(!g.after, "被拒就不要给 after，免得前端误当成可确认的预览");
});

test("dry-run：生成式通道同样支持预览（模型只调用一次，确认时不重复调用）", async () => {
    stubReply = [{ kind: "style", cellIds: ["10"], props: { fillColor: "#00ff00" } }];
    const g = await (await genPost({ xml, roots: ["10"], includeEdges: "internal", instruction: "涂成绿色", dryRun: true })).json();
    assert.equal(g.dryRun, true);
    assert.equal(g.applied, false);
    assert.equal(g.wouldApply, true);
    assert.ok(g.after.xml.includes("fillColor=#00ff00"), "预览里要能看到模型的改动");
    assert.equal(g.attempts, 1, "预览已经把模型调用过了，确认时不该再调一次");
});

test("结构摘要必须带上连线的 source/target —— 前端要靠它画线（漏了会导致预览里一条线都没有）", async () => {
    const { abstract } = await (await post("/api/resolve-scope", { xml, roots: [] })).json();
    const edges = abstract.cells.filter((c) => c.kind === "edge");
    assert.ok(edges.length > 0, "样例里应该有连线");
    for (const e of edges) {
        assert.ok(e.source && e.target, `连线 ${e.id} 的端点丢了：${JSON.stringify(e)}`);
        assert.ok(abstract.cells.some((c) => c.id === e.source), `连线 ${e.id} 的 source=${e.source} 不在元素列表里`);
        assert.ok(abstract.cells.some((c) => c.id === e.target), `连线 ${e.id} 的 target=${e.target} 不在元素列表里`);
    }
});

// ---- 一条指令一个入口：自动分流 ----
// 产品要求：不要让用户先看"没命中规则"再手动点一次"交给模型"。命中就执行，没命中就直接交给模型，
// 最后只用一句话告诉用户"走的规则"还是"走的大模型"。

const insPost = (port, body) => fetch(`http://127.0.0.1:${port}/api/instruct`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("指令分流：命中规则 → 走确定性通道，channel=rule，**完全不调用模型**", async () => {
    const before = stubCalls;
    const r = await (await insPost(GEN_PORT, { xml, roots: ["10", "11"], instruction: "都左对齐" })).json();
    assert.equal(r.matched, true);
    assert.equal(r.channel, "rule");
    assert.equal(r.applied, true, "默认直接应用（不勾「先预览」时不再需要二次确认）");
    assert.equal(stubCalls, before, "命中规则时不该产生任何模型调用");
});

test("指令分流：没命中规则 → **自动**交给模型并直接应用，channel=generative", async () => {
    stubReply = [{ kind: "style", cellIds: ["10"], props: { fillColor: "#123456" } }];
    const before = stubCalls;
    const r = await (await insPost(GEN_PORT, { xml, roots: ["10"], instruction: "把这块搞得像数据库一点" })).json();
    assert.equal(r.matched, false);
    assert.equal(r.channel, "generative");
    assert.equal(stubCalls, before + 1, "未命中应自动调用一次模型（不需要用户再点按钮）");
    assert.equal(r.applied, true);
    assert.ok(r.after.xml.includes("fillColor=#123456"));
    assert.equal(r.model, "stub-model");
    assert.ok(r.usage, "要能告诉用户花了多少 token");
});

test("指令分流：没命中且生成式通道未配置 → channel=none，且给出作用域载荷", async () => {
    const r = await (await insPost(NOKEY_PORT, { xml, roots: ["10"], instruction: "把这块搞得像数据库一点" })).json();
    assert.equal(r.channel, "none");
    assert.equal(r.applied, false);
    assert.match(r.summary, /DEEPSEEK_API_KEY/);
    assert.ok(r.prompt, "没配置也要让用户看见「本来会发给模型什么」");
});

// ===== Phase 2：drawio 插件是跨源调过来的，CORS 不能少 =====
// 插件跑在 drawio 自己的 origin（localhost:8080），发的是 application/json → 浏览器会先发 OPTIONS 预检。
// 预检不过，插件侧看到的只是"调不通"，排查成本极高，所以把它固化成测试。
test("预检：OPTIONS 回 204 且带 CORS 许可（application/json 必然触发预检）", async () => {
    const res = await fetch(`${BASE}/api/instruct`, {
        method: "OPTIONS",
        headers: {
            origin: "http://localhost:8080",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
        },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /content-type/);
});

test("跨源 POST：响应里带 access-control-allow-origin，浏览器才把 JSON 交给插件", async () => {
    const res = await fetch(`${BASE}/api/instruct`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:8080" },
        body: JSON.stringify({ xml, roots: ["10", "11"], instruction: "左对齐" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const body = await res.json();
    // 插件拿到的必须是"服务端算好的 writes"，它自己不做语义判断
    assert.equal(body.channel, "rule");
    assert.ok(body.writes.length > 0, "规则通道要给插件可落地的 writes");
    assert.ok(body.writes.every((w) => w.cellId && (w.attrs || w.structural)));
});
