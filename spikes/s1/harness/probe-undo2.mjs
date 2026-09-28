// 探针 2：到底什么操作会让 drawio 的撤销栈增长？（决定"只改选中元素"的写回要不要换调用方式）
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const PAGE = "PAGE1";
const model = (inner) =>
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' + inner + "</root></mxGraphModel>";
const A = '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>';
const B = '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="420" y="120" width="160" height="70" as="geometry"/></mxCell>';
const BASE = `<mxfile host="app"><diagram id="${PAGE}" name="Page-1">${model(A + B)}</diagram></mxfile>`;

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(process.env.HOST_URL || "http://127.0.0.1:8080/spike-e.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__initAt != null, null, { timeout: 40000 });
const frame = page.frames().find((f) => f.url().includes("embed=1"));
await frame.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 40000 });
const send = (o) => page.evaluate((x) => window.__send(x), o);
const wait = (ms) => page.waitForTimeout(ms);

const depth = () => frame.evaluate(() => {
    const um = window.__aiScope.ui.editor.undoManager;
    return { history: um.history.length, indexOfNextAdd: um.indexOfNextAdd, canUndo: um.canUndo(), canRedo: um.canRedo() };
});
const modelListeners = () => frame.evaluate(() => {
    const m = window.__aiScope.graph.getModel();
    const out = {};
    Object.keys(m.eventListeners || {}).forEach((k) => { out[k] = m.eventListeners[k].length; });
    return out;
});

await send({ action: "load", xml: BASE, autosave: 1 });
await wait(2500);
console.log("载入后 depth: " + JSON.stringify(await depth()));
console.log("model 事件监听器: " + JSON.stringify(await modelListeners()));

const cases = [];
async function kase(name, fn) {
    const d0 = await depth();
    const r = await fn();
    await wait(600);
    const d1 = await depth();
    cases.push({ name, 前: d0, 后: d1, 变化: d1.history - d0.history, 返回: r });
    console.log(`\n### ${name}\n  前 ${JSON.stringify(d0)}\n  后 ${JSON.stringify(d1)}\n  history 变化 ${d1.history - d0.history}${r !== undefined ? "\n  返回 " + JSON.stringify(r) : ""}`);
}

await kase("A. model.setValue（带 beginUpdate/endUpdate）", () => frame.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    m.beginUpdate(); try { m.setValue(m.cells["2"], "Alpha-1"); } finally { m.endUpdate(); }
}));
await kase("B. graph.setCellStyles（不带外层 beginUpdate）", () => frame.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    g.setCellStyles("fillColor", "#ffe6cc", [m.cells["2"]]);
}));
await kase("C. graph.setCellStyles（带外层 beginUpdate/endUpdate）", () => frame.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    m.beginUpdate(); try { g.setCellStyles("fillColor", "#d5e8d4", [m.cells["3"]]); } finally { m.endUpdate(); }
}));
await kase("D. model.setStyle（带 beginUpdate）", () => frame.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    m.beginUpdate(); try { m.setStyle(m.cells["3"], "rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;"); } finally { m.endUpdate(); }
}));
await kase("E. 分组事务：一次 endUpdate 里改两个元素", () => frame.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    m.beginUpdate();
    try { g.setCellStyles("fillColor", "#fff2cc", [m.cells["2"], m.cells["3"]]); } finally { m.endUpdate(); }
}));
// 真实 UI 编辑作为对照：双击进入编辑、输入、回车
await kase("F. 真实 UI 编辑（双击改标签）", async () => {
    const g = await frame.evaluate(() => {
        const g2 = window.__aiScope.graph, m = g2.getModel();
        const c = m.cells["2"]; g2.scrollCellToVisible(c);
        const st = g2.view.getState(c), rect = g2.container.getBoundingClientRect();
        return { x: rect.left - g2.container.scrollLeft + st.getCenterX(), y: rect.top - g2.container.scrollTop + st.getCenterY() };
    });
    const box = await (await frame.frameElement()).boundingBox();
    await page.mouse.dblclick(box.x + g.x, box.y + g.y);
    await wait(800);
    await page.keyboard.type("-UI");
    await page.keyboard.press("Enter");
    await wait(800);
});
console.log("\nmodel 事件监听器（改完再看一次）: " + JSON.stringify(await modelListeners()));
console.log("\nPROBE_UNDO2=" + JSON.stringify(cases, null, 2));
await browser.close();
