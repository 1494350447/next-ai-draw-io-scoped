// S2 实验二：把变量分开控制
//  ① merge 的载荷带/不带 <diagram id>（页面身份）差别有多大
//  ② patch 用"有效 patch" vs "空 patch"
//  ③ 写回之后应用能不能收到 autosave（= 应用是否知道画布变了）
import { chromium } from "playwright";

const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const HOST = process.env.HOST_URL || "http://127.0.0.1:8080/spike-b.html";

const PAGE = "PAGE1";
const model = (inner) =>
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' + inner + "</root></mxGraphModel>";
const A = (v) => `<mxCell id="2" value="${v}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>`;
const B = '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="120" width="160" height="70" as="geometry"/></mxCell>';
const E = '<mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>';

const FILE = (inner, id = PAGE) => `<mxfile host="app"><diagram id="${id}" name="Page-1">${model(inner)}</diagram></mxfile>`;
const BASE_FILE = FILE(A("Alpha") + B + E);
const RAW_PARTIAL = model(A("Alpha-EDITED"));               // 裸 mxGraphModel，只含 A
const RAW_FULL_EDIT = model(A("Alpha-EDITED") + B + E);      // 裸 mxGraphModel，全量 + 改 A
const FILE_PARTIAL = FILE(A("Alpha-EDITED"));                // 带 diagram id，只含 A
const FILE_FULL_EDIT = FILE(A("Alpha-EDITED") + B + E);      // 带 diagram id，全量 + 改 A

const R = { scenarios: [], patchTests: [], autosave: {}, errors: [] };

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => { const t = m.text(); if (!/Deprecated|favicon/i.test(t)) console.log(`[console:${m.type()}]`, t.slice(0, 220)); });
await page.goto(HOST, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__initAt != null, null, { timeout: 40000 });
const frame = page.frames().find((f) => f.url().includes("embed=1"));
await frame.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 40000 });
console.log("宿主就绪");

const snap = () => frame.evaluate(() => {
    const ui = window.__aiScope.ui, g = ui.editor.graph, m = g.getModel();
    const cells = Object.keys(m.cells).map((k) => m.cells[k]).filter((c) => c.isVertex() || c.isEdge());
    return {
        pageId: ui.pages && ui.pages[0] ? ui.pages[0].getId() : null,
        values: cells.map((c) => c.getId() + "=" + String(c.getValue())).sort(),
        ids: cells.map((c) => c.getId()).sort(),
    };
});
const msgsSince = (n) => page.evaluate((from) => window.__msgs.slice(from).map((m) => m.event + (m.checksumMismatch ? "(checksumMismatch)" : "") + (m.error ? "(error:" + (m.error.message || JSON.stringify(m.error)).slice(0, 80) + ")" : "")), n);
const mc = () => page.evaluate(() => window.__msgs.length);
const wait = (ms) => page.waitForTimeout(ms);

async function resetBase(extra = {}) {
    await page.evaluate((o) => window.__send(Object.assign({ action: "load", xml: o.xml, autosave: 1 }, o.extra)), { xml: BASE_FILE, extra });
    await wait(2000);
    return snap();
}
function delta(before, after) {
    return {
        pageIdChanged: before.pageId !== after.pageId,
        removed: before.ids.filter((i) => !after.ids.includes(i)),
        added: after.ids.filter((i) => !before.ids.includes(i)),
        valuesBefore: before.values, valuesAfter: after.values,
    };
}

async function run(name, payload, extra = {}) {
    const before = await resetBase(extra);
    const n = await mc();
    await page.evaluate((p) => window.__send(p), payload);
    await wait(2200);
    const after = await snap();
    const s = { name, delta: delta(before, after), msgs: await msgsSince(n), pageId: after.pageId };
    R.scenarios.push(s);
    console.log(`\n### ${name}\n  载荷类型=${payload.xml ? (payload.xml.indexOf("<mxfile") === 0 ? "mxfile(带 diagram id)" : "裸 mxGraphModel") : "-"}  diffSync=${!!extra.diffSync}\n  被删=${JSON.stringify(s.delta.removed)} 新增=${JSON.stringify(s.delta.added)} pageId变了=${s.delta.pageIdChanged}\n  前=${JSON.stringify(s.delta.valuesBefore)}\n  后=${JSON.stringify(s.delta.valuesAfter)}\n  事件=${JSON.stringify(s.msgs)}`);
    return s;
}

console.log("基准 pageId 保留情况: " + JSON.stringify(await resetBase()));

// ① merge 的四种组合
await run("M1 merge 裸模型 局部载荷", { action: "merge", xml: RAW_PARTIAL });
await run("M2 merge 裸模型 全量载荷+改A", { action: "merge", xml: RAW_FULL_EDIT });
await run("M3 merge mxfile 局部载荷", { action: "merge", xml: FILE_PARTIAL });
await run("M4 merge mxfile 全量载荷+改A", { action: "merge", xml: FILE_FULL_EDIT });
await run("M5 merge mxfile 全量载荷+改A (diffSync 开)", { action: "merge", xml: FILE_FULL_EDIT }, { diffSync: true });
await run("M6 merge mxfile 局部载荷 (diffSync 开)", { action: "merge", xml: FILE_PARTIAL }, { diffSync: true });

// ② patch：自己算一个"有效"的 cell 级 diff，再走 patch 通道
console.log("\n### patch 通道测试");
const setup = await resetBase();
const realPatch = await frame.evaluate(() => {
    const ui = window.__aiScope.ui, g = ui.editor.graph, m = g.getModel();
    const shadow = ui.clonePages(ui.pages);
    m.beginUpdate();
    try { m.setValue(m.cells["2"], "Alpha-PATCHED"); } finally { m.endUpdate(); }
    const current = ui.clonePages(ui.pages);
    return { patch: ui.diffPages(shadow, current), shadowPageId: shadow[0] && shadow[0].getId(), currentPageId: current[0] && current[0].getId() };
});
console.log("自算 patch: pageId " + realPatch.shadowPageId + " -> " + realPatch.currentPageId + "，形状=" + JSON.stringify(realPatch.patch).slice(0, 400));

const beforeP = await resetBase();
let n = await mc();
await page.evaluate((p) => window.__send({ action: "patch", patch: p }), realPatch.patch);
await wait(2200);
const afterP = await snap();
const pt = { name: "P1 patch 有效 patch（diffSync 关）", delta: delta(beforeP, afterP), msgs: await msgsSince(n) };
R.patchTests.push(pt);
console.log(`\n### ${pt.name}\n  被删=${JSON.stringify(pt.delta.removed)} 新增=${JSON.stringify(pt.delta.added)}\n  前=${JSON.stringify(pt.delta.valuesBefore)}\n  后=${JSON.stringify(pt.delta.valuesAfter)}\n  事件=${JSON.stringify(pt.msgs)}`);

const beforeP2 = await resetBase({ diffSync: true });
const realPatch2 = await frame.evaluate(() => {
    const ui = window.__aiScope.ui, g = ui.editor.graph, m = g.getModel();
    const shadow = ui.clonePages(ui.pages);
    m.beginUpdate();
    try { m.setValue(m.cells["2"], "Alpha-PATCHED"); } finally { m.endUpdate(); }
    return ui.diffPages(shadow, ui.clonePages(ui.pages));
});
const b2 = await resetBase({ diffSync: true });
n = await mc();
await page.evaluate((p) => window.__send({ action: "patch", patch: p }), realPatch2);
await wait(2200);
const afterP2 = await snap();
const pt2 = { name: "P2 patch 有效 patch（diffSync 开）", delta: delta(b2, afterP2), msgs: await msgsSince(n) };
R.patchTests.push(pt2);
console.log(`\n### ${pt2.name}\n  被删=${JSON.stringify(pt2.delta.removed)} 新增=${JSON.stringify(pt2.delta.added)}\n  前=${JSON.stringify(pt2.delta.valuesBefore)}\n  后=${JSON.stringify(pt2.delta.valuesAfter)}\n  事件=${JSON.stringify(pt2.msgs)}`);

// ③ 写回后应用能否收到 autosave
console.log("\n### autosave 可达性");
await resetBase();
await frame.evaluate(() => { const g = window.__aiScope.graph, m = g.getModel(); m.beginUpdate(); try { m.setValue(m.cells["3"], "Beta-MANUAL"); } finally { m.endUpdate(); } });
const nManual = await mc();
await wait(2500);
R.autosave.manualEdit = await msgsSince(nManual);
console.log("用户在画布上手动改值 -> 应用收到: " + JSON.stringify(R.autosave.manualEdit));

const b3 = await resetBase();
const nPatch = await mc();
await page.evaluate((p) => window.__send({ action: "patch", patch: p }), realPatch.patch);
await wait(2500);
R.autosave.afterPatch = { msgs: await msgsSince(nPatch), values: (await snap()).values };
console.log("走 patch 写回 -> 应用收到: " + JSON.stringify(R.autosave.afterPatch.msgs) + "，画布值=" + JSON.stringify(R.autosave.afterPatch.values));

const b4 = await resetBase();
const nMerge = await mc();
await page.evaluate((xml) => window.__send({ action: "merge", xml }), FILE_FULL_EDIT);
await wait(2500);
R.autosave.afterMerge = { msgs: await msgsSince(nMerge), values: (await snap()).values };
console.log("走 merge 写回 -> 应用收到: " + JSON.stringify(R.autosave.afterMerge.msgs) + "，画布值=" + JSON.stringify(R.autosave.afterMerge.values));

console.log("\nSPIKE_D2_RESULT=" + JSON.stringify(R, null, 2));
await browser.close();
