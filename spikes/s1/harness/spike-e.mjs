// S3 实验一：写回（只改选中元素）的撤销栈与选区行为。
//
// 全部走生产通道：
//   * 插件由只读挂载的 js/PreConfig.js 自动注入（embed URL 里没有 ?plugins=、没有 aiScopeDebug）
//   * 选区用真实鼠标点击（pointer + mouse 两套事件）
//   * 动作调用用 drawio 官方 embed 协议 {action:'invokeAction', actionName:'<名字>'}
//     （app.min.js: `if("invokeAction"==C.action){var Q=this.actions.get(C.actionName);null!=Q&&Q.funct();return}`）
//   * 结果用 {action:'export', format:'xml'} 读回，不依赖任何调试全局变量
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const HOST = process.env.HOST_URL || "http://127.0.0.1:8080/spike-e.html";
const PAGE = "PAGE1";

const model = (inner) =>
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' + inner + "</root></mxGraphModel>";
const A = (v, fill) => `<mxCell id="2" value="${v}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=#666666;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>`;
const B = '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="420" y="120" width="160" height="70" as="geometry"/></mxCell>';
const E = '<mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;strokeColor=#333333;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>';
const FILE = (inner) => `<mxfile host="app"><diagram id="${PAGE}" name="Page-1">${model(inner)}</diagram></mxfile>`;
const BASE = FILE(A("Alpha", "#ffffff") + B + E);

const R = { host: HOST, ready: null, steps: [], notes: [] };
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => { const t = m.text(); if (!/Deprecated|favicon/i.test(t)) console.log(`[console:${m.type()}]`, t.slice(0, 200)); });

await page.goto(HOST, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__initAt != null, null, { timeout: 40000 });
const frame = page.frames().find((f) => f.url().includes("embed=1"));
console.log("drawio frame: " + frame.url().slice(0, 90));

const mc = () => page.evaluate(() => window.__msgs.length);
const since = (n) => page.evaluate((f) => window.__msgs.slice(f), n);
const wait = (ms) => page.waitForTimeout(ms);
const send = (o) => page.evaluate((x) => window.__send(x), o);
const pick = (msgs, ev) => msgs.filter((m) => m.event === ev);
const aio = (msgs, action) => msgs.filter((m) => m.event === "aiScopeWrite" && m.action === action);

async function exportXml() {
    const n = await mc();
    await send({ action: "export", format: "xml" });
    for (let i = 0; i < 40; i++) {
        await wait(250);
        const hit = (await since(n)).find((m) => m.event === "export" && (m.data || m.xml));
        if (hit) return String(hit.data || hit.xml);
    }
    throw new Error("export 没有回数据");
}
// 只比较"元素 id -> 样式"这一层，够看清写回到底动了谁
function styles(xml) {
    const out = {};
    for (const cell of xml.matchAll(/<mxCell\b([^>]*?)(?:\/>|>)/g)) {
        const id = /\bid="([^"]+)"/.exec(cell[1]);
        if (!id) continue;
        const st = /\bstyle="([^"]*)"/.exec(cell[1]);
        out[id[1]] = st ? st[1] : "";
    }
    return out;
}
function changedIds(before, after) {
    return Object.keys(after).filter((k) => before[k] !== after[k]);
}
// 真实鼠标点击某个元素的中心（pointer + mouse 两套事件，S1 spike 的结论）
async function clickCell(id) {
    const geo = await frame.evaluate((cid) => {
        const g = window.__aiScope.graph, m = g.getModel();
        const cell = Object.keys(m.cells).map((k) => m.cells[k]).filter((c) => c.getId() === cid)[0];
        if (!cell) return { error: "找不到 " + cid };
        g.scrollCellToVisible(cell);
        const st = g.view.getState(cell), rect = g.container.getBoundingClientRect();
        const p = { x: rect.left - g.container.scrollLeft + st.getCenterX(), y: rect.top - g.container.scrollTop + st.getCenterY() };
        const el = document.elementFromPoint(p.x, p.y);
        return Object.assign(p, { inGraph: !!(el && g.container.contains(el)) });
    }, id);
    if (geo.error) return { error: geo.error };
    if (!geo.inGraph) return { error: "坐标没落在画布上，不去点", ...geo };
    const box = await (await frame.frameElement()).boundingBox();
    const x = box.x + geo.x, y = box.y + geo.y;
    await page.mouse.move(x, y);
    await wait(150);
    await page.mouse.down({ button: "left" });
    await wait(60);
    await page.mouse.up({ button: "left" });
    await wait(1200);
    return { id, pageX: Math.round(x), pageY: Math.round(y), inGraph: geo.inGraph };
}
async function selection() {
    const n = await mc();
    await send({ action: "invokeAction", actionName: "aiScopeProbe" });
    await wait(800);
    const msg = pick(await since(n), "aiScope").pop();
    if (msg) return { ids: msg.ids, count: msg.count, undoDepth: msg.undoDepth };
    const fallback = await frame.evaluate(() => (window.__aiScope ? window.__aiScope.selected().map((c) => c.getId()) : null));
    return { ids: fallback, count: fallback ? fallback.length : null, undoDepth: null, via: "debug 兜底" };
}

// ---- 0. 插件是否自动加载（没有 ?plugins=、没有 debug 开关）----
await frame.waitForFunction(() => typeof window.Draw !== "undefined", null, { timeout: 40000 });
await wait(1500);
R.ready = pick(await since(0), "aiScopeReady").pop() || null;
console.log("aiScopeReady: " + JSON.stringify(R.ready));
if (!R.ready) { console.log("S3_E_RESULT=" + JSON.stringify(R, null, 2)); await browser.close(); process.exit(1); }

// ---- 1. 载入基线图 ----
await send({ action: "load", xml: BASE, autosave: 1 });
await wait(2500);
const xml0 = await exportXml();
const st0 = styles(xml0);
console.log("\n### 1. 基线样式\n" + JSON.stringify(st0));

// ---- 2. 真实点击只选中 cell 2 ----
const click = await clickCell("2");
const sel2 = await selection();
console.log("\n### 2. 点选 cell 2 -> " + JSON.stringify(click) + " 选区 " + JSON.stringify(sel2));

// ---- 3. 只改选中元素（写回）----
let n = await mc();
await send({ action: "invokeAction", actionName: "aiScopeRecolor" });
await wait(1500);
const write = aio(await since(n), "aiScopeRecolor").pop();
await wait(500);
const xml1 = await exportXml();
const st1 = styles(xml1);
R.steps.push({ name: "3. 写回只改选中元素", write, stylesAfter: st1, changed: changedIds(st0, st1) });
console.log("\n### 3. aiScopeRecolor\n  报文: " + JSON.stringify(write) +
    "\n  改动: " + JSON.stringify(changedIds(st0, st1)) +
    "\n  写回后选区: " + JSON.stringify(await selection()));

// ---- 4. 撤销一次，看是否回到原样（决定 writeBack 是否进撤销栈）----
n = await mc();
await send({ action: "invokeAction", actionName: "aiScopeUndo" });
await wait(2000);
const undo = aio(await since(n), "aiScopeUndo").pop();
const xml2 = await exportXml();
const st2 = styles(xml2);
R.steps.push({
    name: "4. 撤销一次",
    undo,
    restored: changedIds(st0, st2).length === 0,
    changedStill: changedIds(st0, st2),
    stylesAfter: st2,
});
console.log("\n### 4. aiScopeUndo\n  报文: " + JSON.stringify(undo) +
    "\n  是否回到基线: " + (changedIds(st0, st2).length === 0) +
    "\n  仍未还原: " + JSON.stringify(changedIds(st0, st2)));

// ---- 5. 无选中时写回的报错分支 ----
await page.mouse.click(300, 700);   // 画布空白处 -> 清空选区（元素都在上半部）
await wait(1200);
const selEmpty = await selection();
n = await mc();
await send({ action: "invokeAction", actionName: "aiScopeRecolor" });
await wait(1200);
const emptyWrite = aio(await since(n), "aiScopeRecolor").pop();
R.steps.push({ name: "5. 无选中时写回", selection: selEmpty, write: emptyWrite });
console.log("\n### 5. 空选区写回\n  选区: " + JSON.stringify(selEmpty) + "\n  报文: " + JSON.stringify(emptyWrite));

// ---- 6. 多选：只改选中的那两个 ----
await send({ action: "load", xml: BASE, autosave: 1 });
await wait(2000);
await clickCell("2");
const box = await (await frame.frameElement()).boundingBox();
const geo3 = await frame.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    const c = Object.keys(m.cells).map((k) => m.cells[k]).filter((x) => x.getId() === "3")[0];
    g.scrollCellToVisible(c);
    const st = g.view.getState(c), rect = g.container.getBoundingClientRect();
    return { x: rect.left - g.container.scrollLeft + st.getCenterX(), y: rect.top - g.container.scrollTop + st.getCenterY() };
});
await page.keyboard.down("Shift");
await page.mouse.click(box.x + geo3.x, box.y + geo3.y);
await page.keyboard.up("Shift");
await wait(1200);
const selMulti = await selection();
n = await mc();
await send({ action: "invokeAction", actionName: "aiScopeRecolor" });
await wait(1500);
const multiWrite = aio(await since(n), "aiScopeRecolor").pop();
const st3 = styles(await exportXml());
R.steps.push({ name: "6. 多选只改选中", selection: selMulti, write: multiWrite, changed: changedIds(st0, st3) });
console.log("\n### 6. 多选写回\n  选区: " + JSON.stringify(selMulti) +
    "\n  报文: " + JSON.stringify(multiWrite) +
    "\n  改动: " + JSON.stringify(changedIds(st0, st3)));

console.log("\nS3_E_RESULT=" + JSON.stringify(R, null, 2));
await browser.close();
