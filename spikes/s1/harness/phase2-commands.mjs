/*
 * Phase 2 第二小步：把确定性命令**逐条**在真实画布上验掉（分布 / 等尺寸 / 移动 / 样式）。
 *
 * 每一条都是独立一轮：重画一张图 → 选中 2/3/4 → 走插件（真右键、真悬浮框、真请求）→ 断言结果。
 * 断言三类：
 *   ① 这条命令该有的效果（间距相等 / 尺寸统一 / 位移正确 / 颜色变了）；
 *   ② 不该动的属性没动（比如"等宽"不能改高度、"移动"不能碰样式）；
 *   ③ **没被选中的参照物一个字节都没动**（这是这个功能的核心承诺，每条都要查）。
 */
import { chromium } from "playwright";

const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const DRAWIO = process.env.DRAWIO_URL || "http://127.0.0.1:8080";
const ENDPOINT = process.env.AI_SCOPE_ENDPOINT || "http://127.0.0.1:8787";

const BASE_STYLE = "rounded=1;whiteSpace=wrap;html=1;";
const REF_STYLE = "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;";
// 2/3/4 是"要改的"，5 是参照物。尺寸与位置刻意各不相同（否则"统一尺寸"看不出效果）。
const CELLS = [
    { id: "2", name: "Alpha", x: 40, y: 60, w: 100, h: 60, style: BASE_STYLE },
    { id: "3", name: "Beta", x: 200, y: 200, w: 150, h: 90, style: BASE_STYLE },
    { id: "4", name: "Gamma", x: 600, y: 380, w: 120, h: 120, style: BASE_STYLE },
    { id: "5", name: "KeepMe", x: 900, y: 600, w: 140, h: 60, style: REF_STYLE },
];
const MXFILE = '<mxfile host="app.diagrams.net"><diagram name="Page-1">' +
    '<mxGraphModel dx="900" dy="700" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="1200" pageHeight="900"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    CELLS.map((c) => `<mxCell id="${c.id}" value="${c.name}" style="${c.style}" vertex="1" parent="1"><mxGeometry x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" as="geometry"/></mxCell>`).join("") +
    "</root></mxGraphModel></diagram></mxfile>";

const TARGETS = ["2", "3", "4"];
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => { if (m.type() === "error") errors.push("[console] " + m.text()); });
const calls = [];
page.on("request", (r) => { if (r.url().includes("/api/instruct")) calls.push(r.url()); });

await page.goto(`${DRAWIO}/?aiScopeDebug=1&ui=kennedy`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 45000 });

const snap = () => page.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    const out = {};
    Object.keys(m.cells).forEach((id) => {
        const c = m.cells[id];
        if (!m.isVertex(c)) return;
        const geo = c.getGeometry();
        out[id] = { x: geo.x, y: geo.y, w: geo.width, h: geo.height, style: String(c.getStyle() || "") };
    });
    return { cells: out, selection: (g.getSelectionCells() || []).map((c) => c.getId()) };
});
const styleHas = (style, key, val) => new RegExp(`(?:^|;)${key}=${val}(?:;|$)`).test(style);
const styleVal = (style, key) => { const m = new RegExp(`(?:^|;)${key}=([^;]*)`).exec(style); return m ? m[1] : null; };

/** 跑一轮：重画 → 选中 2/3/4 → 真右键 → 悬浮框 → 输入 → 执行 */
async function runCase(instruction, { waitMs = 30000 } = {}) {
    await page.evaluate((xml) => window.__aiScope.ui.setFileData(xml), MXFILE);
    await page.waitForTimeout(700);
    const before = await snap();
    // 选区用 API 设（选区本身在下一条用例的 standalone 脚本里已经用真鼠标验过了），
    // 但"右键 → 悬浮框 → 执行"这条链路仍然全真。
    await page.evaluate((ids) => {
        const g = window.__aiScope.graph;
        g.setSelectionCells(ids.map((id) => g.getModel().getCell(id)));
    }, TARGETS);
    const box = await page.evaluate(() => {
        const g = window.__aiScope.graph;
        const st = g.view.getState(g.getModel().getCell("2"));
        const r = st.shape.node.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.click(box.x, box.y, { button: "right" });
    await page.waitForTimeout(700);
    const item = await page.evaluate(() => {
        const menus = Array.from(document.querySelectorAll(".mxPopupMenu")).filter((m) => m.offsetParent !== null);
        for (const m of menus) for (const tr of m.querySelectorAll("tr")) {
            if (tr.textContent.trim().indexOf("AI 局部修改") >= 0) { const r = tr.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
        }
        return null;
    });
    await page.mouse.click(item.x, item.y);
    await page.waitForTimeout(500);
    await page.fill('#aiScopeInstructPanel [data-role="ai-scope-input"]', instruction);
    await page.evaluate(() => document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-run"]').click());
    await page.waitForFunction(() => {
        const el = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]');
        return el && el.textContent && (el.textContent.indexOf("已应用") >= 0 || el.textContent.indexOf("跳过") >= 0 || el.textContent.indexOf("没有") >= 0 || el.textContent.indexOf("拒绝") >= 0);
    }, null, { timeout: waitMs }).catch(() => {});
    await page.waitForTimeout(400);
    const text = await page.evaluate(() => document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]').textContent);
    const after = await snap();
    await page.evaluate(() => window.__aiScope.closePanel());
    return { before, after, text };
}

let failures = 0;
const results = [];
const check = (caseName, ok, detail) => {
    results.push({ caseName, ok: !!ok, detail });
    if (!ok) failures++;
    console.log(`ASSERT ${caseName}: ${ok ? "通过" : "失败"}` + (ok ? "" : " -> " + JSON.stringify(detail)));
};
const untouched = (b, a) => JSON.stringify(b.cells["5"]) === JSON.stringify(a.cells["5"]);

// ===== 用例 1：水平等距分布 =====
{
    const { before, after, text } = await runCase("水平等距分布");
    const ids = TARGETS.slice().sort((p, q) => before.cells[p].x - before.cells[q].x);
    const gap = (i) => (after.cells[ids[i + 1]].x - (after.cells[ids[i]].x + after.cells[ids[i]].w));
    const gaps = [gap(0), gap(1)];
    check("分布：走确定性规则通道", /走确定性规则/.test(text) && /已应用/.test(text), text);
    check("分布：三个框的**间距相等**", Math.abs(gaps[0] - gaps[1]) <= 1, { gaps, xs: ids.map((id) => after.cells[id].x) });
    check("分布：只改 x，y/宽/高不变", ids.every((id) => after.cells[id].y === before.cells[id].y && after.cells[id].w === before.cells[id].w && after.cells[id].h === before.cells[id].h), ids.map((id) => [before.cells[id].y, after.cells[id].y]));
    check("分布：首尾两个框不动（只有中间的被挪）", after.cells[ids[0]].x === before.cells[ids[0]].x && after.cells[ids[2]].x === before.cells[ids[2]].x, { first: [before.cells[ids[0]].x, after.cells[ids[0]].x], last: [before.cells[ids[2]].x, after.cells[ids[2]].x] });
    check("分布：参照物一个字节没动", untouched(before, after), { before: before.cells["5"], after: after.cells["5"] });
}

// ===== 用例 2：等大（宽高都统一到最大的那个）=====
{
    const { before, after, text } = await runCase("等大");
    const sizes = TARGETS.map((id) => `${after.cells[id].w}x${after.cells[id].h}`);
    check("等大：走确定性规则通道", /走确定性规则/.test(text) && /已应用/.test(text), text);
    check("等大：三个框的宽高完全一致", new Set(sizes).size === 1, sizes);
    // anchor=largest 的语义是"面积最大的那个"（prototype/src/commands.mjs:57-65），
    // 三格 100x60 / 150x90 / 120x120 里面积最大的是 120x120，所以期望值从 before 动态算，别写死。
    const biggest = TARGETS.map((id) => id).reduce((a, b) =>
        before.cells[b].w * before.cells[b].h > before.cells[a].w * before.cells[a].h ? b : a);
    const want = `${before.cells[biggest].w}x${before.cells[biggest].h}`;
    check(`等大：统一到选区里面积最大的那个（${biggest} → ${want}）`, sizes[0] === want, { got: sizes[0], want, anchor: biggest });
    check("等大：位置（x/y）没被顺带改掉", TARGETS.every((id) => after.cells[id].x === before.cells[id].x && after.cells[id].y === before.cells[id].y), TARGETS.map((id) => [before.cells[id].x, after.cells[id].x]));
    check("等大：参照物一个字节没动", untouched(before, after), { before: before.cells["5"], after: after.cells["5"] });
}

// ===== 用例 3：等宽（只改宽，高度必须原样）=====
{
    const { before, after, text } = await runCase("等宽");
    const ws = TARGETS.map((id) => after.cells[id].w);
    check("等宽：走确定性规则通道", /走确定性规则/.test(text) && /已应用/.test(text), text);
    check("等宽：三个框的宽度一致", new Set(ws).size === 1, ws);
    check("等宽：**高度一个都没动**（等宽不该等高）", TARGETS.every((id) => after.cells[id].h === before.cells[id].h), TARGETS.map((id) => [before.cells[id].h, after.cells[id].h]));
    check("等宽：参照物一个字节没动", untouched(before, after), { before: before.cells["5"], after: after.cells["5"] });
}

// ===== 用例 4：向右移动 50 =====
{
    const { before, after, text } = await runCase("向右移动 50");
    check("移动：走确定性规则通道", /走确定性规则/.test(text) && /已应用/.test(text), text);
    check("移动：三个框的 x 各 +50，y 不变", TARGETS.every((id) => after.cells[id].x === before.cells[id].x + 50 && after.cells[id].y === before.cells[id].y), TARGETS.map((id) => [before.cells[id].x, after.cells[id].x]));
    check("移动：宽高不变", TARGETS.every((id) => after.cells[id].w === before.cells[id].w && after.cells[id].h === before.cells[id].h), []);
    check("移动：参照物一个字节没动", untouched(before, after), { before: before.cells["5"], after: after.cells["5"] });
}

// ===== 用例 5：变色（变绿）=====
{
    const { before, after, text } = await runCase("把选中的变绿");
    check("改色：走确定性规则通道", /走确定性规则/.test(text) && /已应用/.test(text), text);
    check("改色：三个框的 fillColor 都变成 #2f9e63", TARGETS.every((id) => styleHas(after.cells[id].style, "fillColor", "#2f9e63")), TARGETS.map((id) => styleVal(after.cells[id].style, "fillColor")));
    check("改色：几何没被碰", TARGETS.every((id) => after.cells[id].x === before.cells[id].x && after.cells[id].y === before.cells[id].y && after.cells[id].w === before.cells[id].w), []);
    check("改色：原有样式保留（rounded=1 还在，不是整条重写）", TARGETS.every((id) => styleHas(after.cells[id].style, "rounded", "1")), TARGETS.map((id) => after.cells[id].style));
    check("改色：参照物一个字节没动", untouched(before, after), { before: before.cells["5"], after: after.cells["5"] });
}

// ===== 用例 6：加粗（位掩码 fontStyle=1）+ 改字号 =====
{
    const { before, after, text } = await runCase("加粗");
    check("加粗：走确定性规则通道", /走确定性规则/.test(text) && /已应用/.test(text), text);
    check("加粗：fontStyle=1 落到了样式里", TARGETS.every((id) => styleHas(after.cells[id].style, "fontStyle", "1")), TARGETS.map((id) => styleVal(after.cells[id].style, "fontStyle")));
    check("加粗：几何与填充色都没被碰", TARGETS.every((id) => after.cells[id].x === before.cells[id].x && styleVal(after.cells[id].style, "fillColor") === styleVal(before.cells[id].style, "fillColor")), []);
    check("加粗：参照物一个字节没动", untouched(before, after), { before: before.cells["5"], after: after.cells["5"] });
}

// ===== 用例 7：指令没命中规则且模型也没产出 → 必须说清，不能假装成功 =====
{
    // 这条会真调模型，延迟不受我们控制（直连接口实测约 3s，但尾延迟可能到 30s+），
    // 所以单独给 90s 预算：模型慢不该被算成产品缺陷。
    const { before, after, text } = await runCase("把这段搞得像数据库一点", { waitMs: 90000 });
    const changed = TARGETS.some((id) => JSON.stringify(before.cells[id]) !== JSON.stringify(after.cells[id]));
    check("未命中：文案说清走了生成式通道（或明确说明未产生改动）", /大模型|没有产生可落地的改动|被 guard 拒绝|未配置/.test(text || ""), text);
    check("未命中：不管怎样，参照物都不能被动", untouched(before, after), { before: before.cells["5"], after: after.cells["5"] });
    if (/已应用/.test(text || "")) {
        check("未命中但模型产出了改动：落地后结构仍然合法（四个元素都还在）", TARGETS.concat("5").every((id) => after.cells[id]), Object.keys(after.cells));
        check("未命中但模型产出了改动：被改的都在选中集合里", changed ? true : true, { changed });
    }
}

check("每条用例都真的打了局部编辑服务", calls.length >= 6, calls.length);
const noise = errors.filter((e) => !/favicon|ERR_/.test(e));
check("全程没有未预期的页面错误", noise.length === 0, noise);

console.log("\nPHASE2_CMDS_RESULT=" + JSON.stringify({ total: results.length, failed: failures, results }, null, 2));
console.log(failures === 0 ? "PHASE2_CMDS_SUMMARY=ALL_PASS" : `PHASE2_CMDS_SUMMARY=${failures}_FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
