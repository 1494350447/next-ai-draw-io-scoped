// Phase 1 骨架原型：零依赖 HTTP 服务（node:http，不装任何包）。
//
// 它验证的产品假说是：
//   XML → 结构预览 + 大纲框选 → Scope（能改/可见/骨架三层）→ 确定性命令 → 服务端 guard
//
// 刻意**不依赖 drawio**：这一层要能独立成立，才能证明"作用域编辑"的价值不在画布渲染上。
// 也刻意不碰 upstream：原型的产物都在 prototype/ 里，方便将来整块搬进应用。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseDiagram } from "./src/model.mjs";
import { resolveScope, renderScopeText } from "./src/scope.mjs";
import { runCommand, opsToWrites, STYLE_PROPS } from "./src/commands.mjs";
import { applyWrites, byteIdenticalOutside } from "./src/apply.mjs";
import { guardOps, verifyCandidate } from "./src/guard.mjs";
import { diffDiagrams, summarizeDiff } from "./src/diff.mjs";
import { parseInstruction } from "./src/instructions.mjs";
import { runGenerative, makeChatCaller } from "./src/ai.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const SAMPLES = path.join(HERE, "samples");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".json": "application/json; charset=utf-8",
};

/**
 * 生成式通道的配置。**密钥只存在于服务端进程的环境里**：
 * 前端拿到的永远只是 {configured, model}，绝不会把 key 下发到浏览器。
 * 未配置不是错误状态 —— 规则通道仍然完全可用，只是"没命中的句子"接不下去。
 */
function readGenerativeConfig(env = process.env) {
    const apiKey = (env.DEEPSEEK_API_KEY ?? "").trim();
    return {
        configured: Boolean(apiKey),
        apiKey,
        model: (env.AI_MODEL ?? "deepseek-flash").trim() || "deepseek-flash",
        baseUrl: (env.DEEPSEEK_BASE_URL ?? "").trim() || "https://api.deepseek.com",
    };
}
const GENERATIVE = readGenerativeConfig();

// 调用器按配置 memo 一份，省掉每次请求重建（key 换了也不会发生：进程启动时读一次）
let chatCallerCache = null;
function chatCaller(cfg) {
    if (!chatCallerCache) chatCallerCache = makeChatCaller({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model });
    return chatCallerCache;
}

const SAMPLE_FILES = {
    "small-flow": "small-flow.xml",
    "aws-demo": "aws-demo.xml",
    "cat-demo": "cat-demo.xml",
};

/**
 * 跨源：Phase 2 的 drawio 插件是从 drawio 自己的 origin（localhost:8080）调这里的，
 * 属于跨源请求（`content-type: application/json` 还会先发 OPTIONS 预检）。
 * 只放行浏览器侧的读取，不带 credentials —— 服务端不依赖任何浏览器身份，
 * 密钥也仍然只在进程环境里，不会下发到页面。
 */
const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
};

function json(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, { ...CORS, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
    res.end(text);
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const NO_SELECTION = "先选择要修改的元素（勾选左侧大纲，或在右侧预览里框选）";

const EMPTY_DIFF = { changed: [], added: [], removed: [], total: 0 };
const rejectAll = (reason) => ({
    intent: { ok: false, checkedOps: 0, rejected: [{ op: null, reason }] },
    result: null, byteIdentical: null,
});

/**
 * 空选区是**正常状态**（首屏就是这样），不是错误：它只能让"可用性"变差，不该让页面炸掉。
 * 所以这里统一软处理 —— 返回 scope:null + 一句提示，由调用方决定怎么展示。
 */
function tryResolveScope(diagram, roots, includeEdges) {
    try {
        return { scope: resolveScope(diagram, roots ?? [], { includeEdges }), hint: null };
    } catch (err) {
        if (/没有有效的选中元素/.test(String(err.message))) return { scope: null, hint: NO_SELECTION };
        throw err;
    }
}

/**
 * 一次"完整的局部编辑"：解析 → 作用域 → 命令 → 写入 → guard（意图层 + 结果层 + 字节级）。
 *
 * `dryRun` 是**确认单**的基础：整条流水线照跑（含结果层复核与字节级核对），但结论放在 `wouldApply` 里、
 * 且 `applied` 恒为 false —— 调用方拿到的是一份"**如果确认会变成什么样**"，而不是已经落地的状态。
 * 注意 `after.xml` 在 dry-run 下照样返回：前端要用它渲染预览（画布显示"应用后的样子"），
 * 真正的"提交"是前端把 `state.xml` 换成它，因此**不会二次调用模型、也不会二次落盘**。
 */
function scopedEdit({ xml, roots, includeEdges, command, params, ops, allowAiKinds, dryRun }) {
    const t0 = Date.now();
    const diagram = parseDiagram(xml);
    const { scope, hint } = tryResolveScope(diagram, roots, includeEdges);
    if (!scope) {
        return {
            scope: null, ops: [], writes: [], changedCells: [], after: null,
            applied: false, dryRun: !!dryRun, wouldApply: false, ms: Date.now() - t0, warnings: [hint],
            diff: { changed: [], added: [], removed: [], total: 0 }, summary: hint,
            guard: { intent: { ok: false, checkedOps: 0, rejected: [{ op: null, reason: hint }] }, result: null, byteIdentical: null },
        };
    }

    let effectiveOps = ops;
    let warnings = [...scope.warnings];
    if (!effectiveOps) {
        const result = runCommand(diagram, scope, command, params);
        effectiveOps = result.ops;
        warnings.push(...result.warnings);
    }

    const intent = guardOps(effectiveOps, scope, { allowAiKinds });
    if (!intent.ok) {
        // 两种"没写成"对用户含义完全不同，文案不能混（实测：选 1 个元素说"等宽"曾显示"被 guard 拒绝"，
        // 而真实原因是规则自己说"等宽至少要选中 2 个元素"）：
        //   · 空 ops = 这条指令本来就没产出可执行的改动（原因在规则/模型给的 warnings 里）；
        //   · 真越界 = 产出了 op，但被 guard 拦下（§5.5-2：整批拒绝，不回写、不部分应用）。
        const emptyOps = !Array.isArray(effectiveOps) || effectiveOps.length === 0;
        const scopeNotes = scope.warnings ?? [];
        const why = emptyOps
            ? (warnings.filter((w) => !scopeNotes.includes(w)).pop() ?? "这条指令没有产生可执行的改动")
            : "被 guard 拒绝，未写入任何改动";
        return {
            scope, ops: effectiveOps, rejected: intent.rejected, warnings,
            applied: false, dryRun: !!dryRun, wouldApply: false, ms: Date.now() - t0,
            diff: { changed: [], added: [], removed: [], total: 0 },
            summary: why,
            guard: { intent, result: null, byteIdentical: null },
        };
    }

    const planned = opsToWrites(diagram, effectiveOps);
    warnings.push(...planned.warnings);
    const applied = applyWrites(diagram, planned.writes);
    warnings.push(...applied.warnings);

    const result = verifyCandidate(diagram.text, applied.xml, scope);
    // 改动账本：guard 说"能不能这样改"，diff 说"到底改成了什么样"（前端高亮与文案都吃它）
    const diff = diffDiagrams(diagram.text, applied.xml);
    const cellRanges = [...diagram.cells.values()].map((c) => ({ id: c.id, start: c.cellNode.start, end: c.cellNode.end }));
    const byteIdentical = byteIdenticalOutside(diagram.text, applied.xml, applied.patches, cellRanges);

    // 结果层复核一旦发现越界，说明"我们的应用器"出了问题 —— 这是给未来改动兜底的断言
    const finalOk = result.ok && byteIdentical.ok;

    return {
        scope,
        ops: effectiveOps,
        writes: planned.writes,
        warnings,
        applied: dryRun ? false : finalOk,
        dryRun: !!dryRun,
        wouldApply: finalOk,       // "如果确认，能不能落地" —— dry-run 下的结论就靠它
        ms: Date.now() - t0,
        before: { xml, checksum: diagram.checksum },
        after: { xml: applied.xml },
        changedCells: applied.changedCells,
        diff,
        summary: summarizeDiff(diff),
        guard: {
            intent,
            result,
            byteIdentical: { ok: byteIdentical.ok, checked: byteIdentical.checked.length, mismatches: byteIdentical.mismatches },
        },
    };
}

/**
 * 生成式通道的完整流程：模型产 Op → 逐项校验 → guard → 走**和确定性通道完全相同**的落盘路径。
 * 抽成函数是因为它现在有两个入口：`/api/generate`（显式）和 `/api/instruct`（规则没命中时自动走）。
 */
async function generativeEdit({ diagram, xml, roots, includeEdges, instruction, dryRun }) {
    const cfg = GENERATIVE;
    const { scope, hint } = tryResolveScope(diagram, roots, includeEdges);
    const base = {
        instruction, channel: "generative", model: cfg.model, configured: cfg.configured, matched: false,
        dryRun: !!dryRun, diff: EMPTY_DIFF, guard: rejectAll("生成式通道未执行"),
    };
    if (!scope) return { ...base, scope: null, applied: false, wouldApply: false, hint, warnings: [hint], summary: hint };

    // 未配置密钥是**可解释的状态**，不是 500：规则通道照旧可用，这里把原因说清楚
    if (!cfg.configured) {
        const why = "生成式通道未配置：服务端没有读到 DEEPSEEK_API_KEY（在 .env 里填好再重启）";
        return {
            ...base, scope, applied: false, wouldApply: false, warnings: [why], summary: why,
            prompt: renderScopeText(diagram, scope), estimate: scope.estimate, guard: rejectAll(why),
        };
    }

    let gen;
    try {
        gen = await runGenerative({ diagram, scope, instruction, askModel: chatCaller(cfg) });
    } catch (err) {
        // 网络/鉴权/超时：如实报错，但保持 200 + applied=false，前端只需展示一句人话
        const why = `模型调用失败：${String(err.message || err).slice(0, 300)}`;
        return { ...base, scope, applied: false, wouldApply: false, warnings: [why], summary: why, guard: rejectAll(why) };
    }

    const { guard: _guard, diff: _diff, ...baseInfo } = base;
    const meta = {
        ...baseInfo,
        attempts: gen.attempts, usage: gen.usage, modelLog: gen.log,
        scopedTokens: scope.estimate.scopedTokens, fullTokens: scope.estimate.fullTokens,
    };
    if (!gen.accepted) {
        const why = `模型 ${gen.attempts} 次都没产出合法且不越界的 ops，整批放弃（绝不部分应用）`;
        return {
            ...meta, scope, ops: [], applied: false, wouldApply: false, diff: EMPTY_DIFF,
            estimate: scope.estimate, warnings: gen.errors, summary: why, guard: rejectAll(why),
        };
    }
    const out = scopedEdit({
        xml, roots, includeEdges, ops: gen.ops, allowAiKinds: true, dryRun,
    });
    // 顺序要紧：meta 里带的是**占位** guard/diff，必须让 scopedEdit 的真实结果覆盖它
    return { ...meta, ...out, ops: gen.ops };
}

const routes = {
    "GET /api/meta": async () => ({
        styleProps: STYLE_PROPS,
        samples: Object.keys(SAMPLE_FILES),
        commands: ["align", "distribute", "size", "square", "move", "style", "add", "delete"],
        // 前端据此决定"交给模型"按钮是否可点。只说配置状态与模型名，不含密钥。
        generative: { configured: GENERATIVE.configured, model: GENERATIVE.model, baseUrl: GENERATIVE.baseUrl },
    }),
    "GET /api/sample": async (req, res, url) => {
        const name = url.searchParams.get("name") ?? "small-flow";
        const file = SAMPLE_FILES[name];
        if (!file) return { __status: 404, error: `没有样例 ${name}` };
        return { name, xml: await readFile(path.join(SAMPLES, file), "utf8") };
    },
    "POST /api/resolve-scope": async (req, res, url, body) => {
        const diagram = parseDiagram(body.xml);
        const { scope, hint } = tryResolveScope(diagram, body.roots, body.includeEdges);
        return {
            scope,
            hint,
            warnings: scope?.warnings ?? (hint ? [hint] : []),
            abstract: describeDiagram(diagram),
        };
    },
    "POST /api/command": async (req, res, url, body) => scopedEdit({
        xml: body.xml, roots: body.roots, includeEdges: body.includeEdges,
        command: body.command, params: body.params, dryRun: body.dryRun,
    }),
    // 自然语言指令：**一个入口，自动分流**。
    // 命中规则 → 确定性通道（免费、可审计）；没命中 → 直接交给生成式通道，不需要用户再点一次。
    // 返回里的 `channel` 就是给用户看的那句话的依据："走的规则" 还是 "走的大模型"。
    "POST /api/instruct": async (req, res, url, body) => {
        const plan = parseInstruction(body.instruction);
        const diagram = parseDiagram(body.xml);
        const { scope, hint } = tryResolveScope(diagram, body.roots, body.includeEdges);
        if (!scope) {
            return {
                instruction: body.instruction, plan, scope: null, applied: false, matched: plan.matched,
                channel: "none", warnings: [hint], hint, diff: EMPTY_DIFF, summary: hint, guard: rejectAll(hint),
            };
        }
        if (plan.matched) {
            const out = scopedEdit({
                xml: body.xml, roots: body.roots, includeEdges: body.includeEdges,
                command: plan.command, params: plan.params, dryRun: body.dryRun,
                // 规则通道现在也会产出结构性 op（delete/add，③ 增删元素）。
                // 放行"AI 通道的 op.kind"不等于放宽校验：这些 op 是**服务端自己按用户选区算出来的**，
                // 而且仍然要过 guardOps 的 writable 检查与 verifyCandidate 的结果层复核。
                allowAiKinds: true,
            });
            return { ...out, instruction: body.instruction, plan, matched: true, channel: "rule" };
        }
        const out = await generativeEdit({
            diagram, xml: body.xml, roots: body.roots, includeEdges: body.includeEdges,
            instruction: body.instruction, dryRun: body.dryRun,
        });
        return { ...out, instruction: body.instruction, plan, matched: false, channel: out.configured ? "generative" : "none" };
    },

    // 显式走生成式通道（前端不再需要"交给模型"这个按钮，但保留这个入口给外部系统与测试）
    "POST /api/generate": async (req, res, url, body) => generativeEdit({
        diagram: parseDiagram(body.xml), xml: body.xml, roots: body.roots,
        includeEdges: body.includeEdges, instruction: body.instruction, dryRun: body.dryRun,
    }),

    // 客户端直接给 ops（等价于"模型不听话"或"客户端被改坏"）：唯一防线就是 guard
    "POST /api/apply-ops": async (req, res, url, body) => scopedEdit({
        xml: body.xml, roots: body.roots, includeEdges: body.includeEdges, ops: body.ops, dryRun: body.dryRun,
    }),
    // 只做结果层复核：给外部系统（或 Phase 2 的插件）校验一份候选 XML
    "POST /api/verify": async (req, res, url, body) => {
        const { scope, hint } = tryResolveScope(parseDiagram(body.beforeXml), body.roots, body.includeEdges);
        if (!scope) return { scopeIds: [], guard: { ok: false, reason: hint, changed: [], outOfScope: [] } };
        const guard = verifyCandidate(body.beforeXml, body.afterXml, scope);
        const diff = body.afterXml ? diffDiagrams(body.beforeXml, body.afterXml) : null;
        return { scopeIds: scope.writable, guard, diff, summary: diff ? summarizeDiff(diff) : null };
    },
};

/** 给 UI 用的结构摘要（不含几何，够画树） */
function describeDiagram(diagram) {
    const abs = (cell) => {
        let x = cell.geometry?.x ?? 0;
        let y = cell.geometry?.y ?? 0;
        let cur = cell.parent;
        while (cur && cur !== "0") {
            const p = diagram.get(cur);
            if (!p) break;
            x += p.geometry?.x ?? 0;
            y += p.geometry?.y ?? 0;
            cur = p.parent;
        }
        return { x, y };
    };
    return {
        pageId: diagram.pageId,
        pageName: diagram.pageName,
        checksum: diagram.checksum,
        // 只给"用户元素"：0 是根占位、1 是默认层，它们不是画布上的东西。
        // （漏掉 1 会让前端把它既当普通行渲染一次、又当父容器遍历一次 → 每行重复两遍）
        cells: [...diagram.cells.values()].filter((c) => !c.isRoot && !c.isLayer).map((c) => ({
            id: c.id,
            parent: c.parent,
            kind: c.isEdge ? "edge" : (c.isVertex ? "vertex" : "other"),
            // 连线的端点必须往下传：前端要靠它算线的两个端点。
            // （漏了这个字段的后果很隐蔽 —— 前端 `byId.get(undefined)` 直接 continue，
            //   于是"预览里一条线都没有"，但帧率、报错、接口全是正常的。）
            source: c.source ?? null,
            target: c.target ?? null,
            label: String(c.value || "").replace(/<[^>]*>/g, " ").trim().slice(0, 40),
            childCount: c.childIds.length,
            geometry: c.geometry ? { ...c.geometry, ...abs(c) } : null,
            isContainer: c.childIds.length > 0,
        })),
    };
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
        // 预检：浏览器问"能不能这样跨源调"。不回业务逻辑，只回许可。
        if (req.method === "OPTIONS") {
            res.writeHead(204, CORS);
            return res.end();
        }
        const key = `${req.method} ${url.pathname}`;
        if (routes[key]) {
            const body = req.method === "POST" ? await readBody(req) : {};
            const out = await routes[key](req, res, url, body);
            if (out && out.__status) return json(res, out.__status, out);
            return json(res, 200, out);
        }
        // 静态文件
        const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
        const file = path.join(PUBLIC, rel);
        if (!file.startsWith(PUBLIC)) return json(res, 403, { error: "越界路径" });
        let data;
        try {
            data = await readFile(file);
        } catch (err) {
            // 静态文件缺失是 404 而不是 500（浏览器会自己请求 /favicon.ico，别在控制台里刷红色错误）
            if (err.code === "ENOENT") return json(res, 404, { error: `没有这个文件：/${rel}` });
            throw err;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        return res.end(data);
    } catch (err) {
        return json(res, 500, { error: String(err.message || err) });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`Phase 1 骨架原型: http://${HOST}:${PORT}/`);
    console.log(`样例: ${Object.keys(SAMPLE_FILES).join(", ")}`);
    console.log(`生成式通道: ${GENERATIVE.configured ? `已配置（${GENERATIVE.model} @ ${GENERATIVE.baseUrl}）` : "未配置（缺 DEEPSEEK_API_KEY，规则通道不受影响）"}`);
});
