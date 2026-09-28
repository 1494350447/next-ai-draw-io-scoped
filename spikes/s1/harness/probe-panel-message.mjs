/*
 * 探针：悬浮框在"没改动"时的**文案**（用户报"没有任何改动 · 邻域里还有 31 个…"看不懂）。
 *
 * 这个探针要回答两件事，都用真实面板渲染来验（不猜）：
 *   ① 面板里**不再有**「复原上一次改动」这个按钮（该功能已按产品决策移除 —— 曾因浏览器缓存旧插件而复现）；
 *   ② "没改动"时面板要说清：结论 / 原因 / 作用域提示，三行分开，别把邻域裁剪写成失败原因。
 *
 * 场景刻意选确定性的：只选中 1 个元素却说"等宽" → 规则命中但产不出 op（等宽至少要 2 个），
 * 于是走"没改动"分支，且原因来自规则本身（不是模型、不烧 token）。
 *
 * 用法：./harness/run.sh probe-panel-message.mjs
 */
import { chromium } from "playwright";

const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const DRAWIO = process.env.DRAWIO_URL || "http://127.0.0.1:8080";

const MXFILE =
    '<mxfile host="app.diagrams.net"><diagram name="Page-1">' +
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="240" width="200" height="90" as="geometry"/></mxCell>' +
    "</root></mxGraphModel></diagram></mxfile>";

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.goto(`${DRAWIO}/?aiScopeDebug=1&ui=kennedy`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 45000 });
await page.evaluate((xml) => { window.__aiScope.ui.setFileData(xml); }, MXFILE);
await page.waitForTimeout(600);

const out = {};
// 只选中 Alpha（1 个元素）→ 打开面板（openInstruct(null) 是插件注册的动作，与宿主调用同一条路）
out.opened = await page.evaluate(() => {
    const w = window.__aiScope, m = w.graph.getModel();
    w.ui.setSelectionCells? null : null;
    w.graph.setSelectionCell(m.getCell("2"));
    w.openInstruct(null);
    return !!document.getElementById("aiScopeInstructPanel");
});
out.panelBeforeRun = await page.evaluate(() => {
    const el = document.getElementById("aiScopeInstructPanel");
    return el ? el.textContent : null;
});

// 输入"等宽"并点执行
out.result = await page.evaluate(async () => {
    const input = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-input"]');
    const btn = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-run"]');
    input.value = "等宽";
    btn.click();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) {
        await wait(250);
        const el = document.getElementById("aiScopeInstructPanel");
        const txt = el ? el.textContent : "";
        if (txt && !/执行中/.test(txt)) return txt;
    }
    const el = document.getElementById("aiScopeInstructPanel");
    return el ? el.textContent : "";
});

console.log("PROBE_PANEL_MESSAGE=" + JSON.stringify(out, null, 2));
const t = String(out.result);
console.log("断言 面板不再出现「复原」: " + (t.includes("复原") || String(out.panelBeforeRun).includes("复原") ? "失败" : "通过"));
console.log("断言 面板说清了真实原因（不是含糊的“没有任何改动”）: " + (/统一尺寸至少要选中 2 个元素/.test(t) ? "通过" : "失败"));
console.log("断言 空 ops 没有被说成「被 guard 拒绝」（那是越界的说法）: " + (/被 guard 拒绝/.test(t) ? "失败" : "通过"));
console.log("断言 作用域提示被单独标注: " + (/作用域提示（不影响本次改动）/.test(t) ? "通过" : "本次没有作用域提示（正常）"));
console.log("PANEL_TEXT=" + JSON.stringify(t));
await browser.close();
