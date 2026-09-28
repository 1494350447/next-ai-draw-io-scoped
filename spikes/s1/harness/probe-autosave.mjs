// 钉死两件事：① autosave 到底会不会发（计数必须在改动之前取）② ya(=getData) 到底能不能用
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const PAGE = "PAGE1";
const model = (inner) =>
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' + inner + "</root></mxGraphModel>";
const A = '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>';
const B = '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="120" width="160" height="70" as="geometry"/></mxCell>';
const E = '<mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>';
const FILE = (inner) => `<mxfile host="app"><diagram id="${PAGE}" name="Page-1">${model(inner)}</diagram></mxfile>`;
const BASE = FILE(A + B + E);
const FULL_EDIT = FILE('<mxCell id="2" value="Alpha-EDITED" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>' + B + E);

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => { const t = m.text(); if (!/Deprecated|favicon/i.test(t)) console.log(`[console:${m.type()}]`, t.slice(0, 200)); });
await page.goto("http://127.0.0.1:8080/spike-b.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__initAt != null, null, { timeout: 40000 });
const frame = page.frames().find((f) => f.url().includes("embed=1"));
await frame.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 40000 });

const mc = () => page.evaluate(() => window.__msgs.length);
const since = (n) => page.evaluate((f) => window.__msgs.slice(f).map((m) => m.event + (m.error ? "(error)" : "") + (m.patch ? "(patch)" : "") + (m.xml ? "(xml:" + String(m.xml).length + ")" : "")), n);
const wait = (ms) => page.waitForTimeout(ms);
const load = async (xml, extra = {}) => { await page.evaluate((o) => window.__send(Object.assign({ action: "load", xml: o.xml, autosave: 1 }, o.extra)), { xml, extra }); await wait(2000); };
const edit = () => frame.evaluate(() => { const g = window.__aiScope.graph, m = g.getModel(); m.beginUpdate(); try { m.setValue(m.cells["3"], "Beta-EDIT-" + Math.random().toString(36).slice(2, 6)); } finally { m.endUpdate(); } });

const R = {};

// ① 第一次 load 之后手动改值
await load(BASE);
let n = await mc();
await edit();
await wait(4000);
R.首次load后手动改值 = await since(n);
console.log("① 首次 load 后手动改值 -> " + JSON.stringify(R.首次load后手动改值));

// ② 再 load 一次（模拟应用刷新画布）之后手动改值
await load(BASE);
n = await mc();
await edit();
await wait(4000);
R.二次load后手动改值 = await since(n);
console.log("② 二次 load 后手动改值 -> " + JSON.stringify(R.二次load后手动改值));

// ③ 真实鼠标点击（用户操作路径）是否产生 autosave
await load(BASE);
n = await mc();
const geo = await frame.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    const c = Object.keys(m.cells).map((k) => m.cells[k]).filter((x) => x.getId() === "2")[0];
    g.scrollCellToVisible(c);
    const st = g.view.getState(c), rect = g.container.getBoundingClientRect();
    return { x: rect.left - g.container.scrollLeft + st.getCenterX(), y: rect.top - g.container.scrollTop + st.getCenterY() };
});
const box = await page.evaluate(() => { const r = document.getElementById("f").getBoundingClientRect(); return { left: r.left, top: r.top }; });
await page.mouse.click(box.left + geo.x, box.top + geo.y);
await wait(4000);
R.真实点击后 = await since(n);
console.log("③ 真实点击后 -> " + JSON.stringify(R.真实点击后));

// ④ getDiff 在没开 diffSync 时会不会返回 xml（= getData/ya 能不能用）
await load(BASE);
n = await mc();
await page.evaluate(() => window.__send({ action: "getDiff" }));
await wait(1500);
R.getDiff无diffSync = await since(n);
console.log("④ getDiff(无 diffSync) -> " + JSON.stringify(R.getDiff无diffSync));

// ⑤ patch 带错误 checksum
const realPatch = await frame.evaluate(() => {
    const ui = window.__aiScope.ui, g = ui.editor.graph, m = g.getModel();
    const shadow = ui.clonePages(ui.pages);
    m.beginUpdate(); try { m.setValue(m.cells["2"], "Alpha-PATCHED"); } finally { m.endUpdate(); }
    return ui.diffPages(shadow, ui.clonePages(ui.pages));
});
await load(BASE);
n = await mc();
await page.evaluate((p) => window.__send({ action: "patch", patch: p, checksum: "deadbeef" }), realPatch);
await wait(2000);
R.patch错误checksum = { msgs: await since(n), values: await frame.evaluate(() => { const m = window.__aiScope.graph.getModel(); return Object.keys(m.cells).map((k) => k + "=" + String(m.cells[k].getValue())).sort(); }) };
console.log("⑤ patch + 错误 checksum -> " + JSON.stringify(R.patch错误checksum));

// ⑥ merge 之后应用能否感知（计数取在 merge 之前）
await load(BASE);
n = await mc();
await page.evaluate((xml) => window.__send({ action: "merge", xml }), FULL_EDIT);
await wait(3000);
R.merge后 = await since(n);
console.log("⑥ merge 全量载荷+改A -> " + JSON.stringify(R.merge后));

console.log("\nPROBE_AUTOSAVE_RESULT=" + JSON.stringify(R, null, 2));
await browser.close();
