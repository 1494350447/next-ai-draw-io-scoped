// 生成式通道：把**作用域载荷**交给模型，拿回 Op 列表。
//
// 分工是刻意的（也是这套设计能成立的原因）：
//   模型只负责"想改什么" → 产出 Op（意图）；
//   我们的应用器负责"怎么落到 XML 上" → writes/patches。
// 所以模型即使想越界，也只能产出**越界的 Op**，而 Op 会被 guard 整批拒绝 —— 它拿不到直接改文件的能力。
//
// 本文件不依赖网络：真正的模型调用通过 askModel 注入，测试里换成假的即可。

import { renderScopeText } from "./scope.mjs";
import { guardOps } from "./guard.mjs";

export const OP_SCHEMA = `ops 里每一项必须是下面之一（JSON，不要加注释）：
{"kind":"style","cellIds":["id"],"props":{"fillColor":"#ff0000"}}
{"kind":"move","cellIds":["id"],"params":{"dx":20,"dy":0}}
{"kind":"align","cellIds":["id","id2"],"params":{"mode":"left|center|right|top|middle|bottom"}}
{"kind":"size","cellIds":["id","id2"],"params":{"mode":"width|height|both"}}
{"kind":"distribute","cellIds":["id","id2","id3"],"params":{"axis":"x|y"}}
{"kind":"update","cellId":"id","xml":"<mxCell id=\\"id\\" value=\\"新文字\\" style=\\"...\\" vertex=\\"1\\" parent=\\"1\\"><mxGeometry x=\\"0\\" y=\\"0\\" width=\\"120\\" height=\\"60\\" as=\\"geometry\\"/></mxCell>"}
{"kind":"add","cellId":"new-1","parentId":"1","xml":"<mxCell id=\\"new-1\\" value=\\"新节点\\" style=\\"rounded=0;whiteSpace=wrap;html=1;\\" vertex=\\"1\\" parent=\\"1\\"><mxGeometry x=\\"0\\" y=\\"0\\" width=\\"120\\" height=\\"60\\" as=\\"geometry\\"/></mxCell>"}
{"kind":"delete","cellId":"id"}`;

/** 拼装"作用域载荷"：可改什么 + 只读邻域 + 全局骨架 + 硬约束 + 用户要求 */
export function buildScopedPrompt(diagram, scope, instruction, options = {}) {
    const lines = [
        "你在编辑一张 draw.io 图（XML）。用户在画布上选中了一部分元素，要求你**只改这一部分**。",
        "",
        renderScopeText(diagram, scope),
        "",
        `[用户的修改要求] ${instruction}`,
        "",
        "只输出一个 JSON 对象，形如 {\"ops\":[...]}，不要输出任何解释或 Markdown 代码块。",
        OP_SCHEMA,
        "",
        "注意：cellIds/cellId/parentId 必须是上面出现过的 id；新增元素的 id 不能和已有 id 冲突；xml 必须是完整的 <mxCell> 片段。",
    ];
    if (options.retryReasons?.length) {
        lines.push("", `上一次的输出被拒绝了，原因如下，请修正后重新输出：`, ...options.retryReasons.map((r) => `- ${r}`));
    }
    return lines.join("\n");
}

const KINDS = new Set(["style", "move", "align", "size", "distribute", "update", "add", "delete"]);
const stripFence = (text) => String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
const idsOf = (op) => (Array.isArray(op.cellIds) ? op.cellIds.map(String) : op.cellId ? [String(op.cellId)] : []);
const looksLikeMxCell = (xml) => /^<(mxCell|object|UserObject)\b/.test(String(xml ?? "").trim());

/**
 * 解析并**逐项校验**模型输出（不是"能 JSON.parse 就放行"）。
 * @returns {{ops: object[], errors: string[]}} errors 会作为重试理由回灌给模型。
 */
export function parseModelOps(raw, { diagram }) {
    const errors = [];
    let data;
    try {
        data = JSON.parse(stripFence(raw));
    } catch (err) {
        return { ops: [], errors: [`输出不是合法 JSON：${String(err.message).slice(0, 120)}`] };
    }
    const list = Array.isArray(data) ? data : data?.ops;
    if (!Array.isArray(list)) return { ops: [], errors: ["输出里没有 ops 数组"] };

    const ops = [];
    for (const [i, op] of list.entries()) {
        const at = `ops[${i}]`;
        if (!op || typeof op !== "object") { errors.push(`${at} 不是对象`); continue; }
        if (!KINDS.has(op.kind)) { errors.push(`${at} 的 kind=${op.kind} 不支持`); continue; }
        const targets = idsOf(op);
        if (!targets.length) { errors.push(`${at}(${op.kind}) 没有给出任何 cellId`); continue; }
        const missing = targets.filter((id) => !diagram.get(id));
        if (op.kind !== "add" && missing.length) { errors.push(`${at}(${op.kind}) 引用了图上不存在的 id：${missing.join(",")}`); continue; }
        if (op.kind === "add") {
            const parentId = String(op.parentId ?? "1");
            if (!diagram.get(parentId)) { errors.push(`${at}(add) 的 parentId=${parentId} 不存在`); continue; }
            if (diagram.get(String(op.cellId))) { errors.push(`${at}(add) 的 id=${op.cellId} 和已有元素冲突`); continue; }
            if (!looksLikeMxCell(op.xml)) { errors.push(`${at}(add) 的 xml 不是 <mxCell> 片段`); continue; }
        }
        if (op.kind === "update" && !looksLikeMxCell(op.xml)) { errors.push(`${at}(update) 的 xml 不是 <mxCell> 片段`); continue; }
        if (op.kind === "style" && (!op.props || typeof op.props !== "object")) { errors.push(`${at}(style) 缺少 props`); continue; }
        ops.push(op);
    }
    if (!ops.length && !errors.length) errors.push("输出里没有任何 op");
    return { ops, errors };
}

/** 真实模型调用（OpenAI 兼容的 /chat/completions；DeepSeek 走的就是这个协议） */
export function makeChatCaller({ apiKey, baseUrl = "https://api.deepseek.com", model, timeoutMs = 60000, fetchImpl = fetch }) {
    return async function askModel(prompt) {
        const t0 = Date.now();
        const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: "你是 draw.io 图编辑助手。只输出 JSON。" },
                    { role: "user", content: prompt },
                ],
                temperature: 0,
                response_format: { type: "json_object" },
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`模型接口 ${res.status}：${JSON.stringify(body).slice(0, 200)}`);
        return {
            text: body?.choices?.[0]?.message?.content ?? "",
            usage: body?.usage ?? null,
            ms: Date.now() - t0,
        };
    };
}

/**
 * 生成式通道主流程：问模型 → 解析校验 → guard → （失败则带着原因重试一次）。
 * 注意**不在这里应用写入**：应用与结果层复核由调用方做（和确定性通道共用同一条路径）。
 * @param {{askModel: (prompt: string) => Promise<{text: string, usage?: object, ms?: number}>}} deps
 * @returns {{ops, attempts, accepted, log, errors, usage}}
 */
export async function runGenerative({ diagram, scope, instruction, askModel, maxAttempts = 2 }) {
    const log = [];
    const errors = [];
    let usage = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const prompt = buildScopedPrompt(diagram, scope, instruction, { retryReasons: errors });
        const reply = await askModel(prompt);
        const ms = reply?.ms ?? null;
        usage = reply?.usage ?? usage;
        const parsed = parseModelOps(reply?.text, { diagram });
        if (parsed.errors.length) {
            errors.push(...parsed.errors);
            log.push({ attempt, ok: false, stage: "parse", ms, errors: parsed.errors, raw: String(reply?.text ?? "").slice(0, 400) });
            continue;
        }
        const guard = guardOps(parsed.ops, scope, { allowAiKinds: true });
        if (!guard.ok) {
            const reasons = guard.rejected.map((r) => r.reason);
            errors.push(...reasons);
            log.push({ attempt, ok: false, stage: "guard", ms, ops: parsed.ops, rejected: reasons, raw: String(reply?.text ?? "").slice(0, 400) });
            continue;
        }
        log.push({ attempt, ok: true, stage: "guard", ms, ops: parsed.ops, tokens: usage?.total_tokens ?? null });
        return { ops: parsed.ops, attempts: attempt, accepted: true, log, errors: [], usage };
    }
    return { ops: [], attempts: maxAttempts, accepted: false, log, errors, usage };
}
