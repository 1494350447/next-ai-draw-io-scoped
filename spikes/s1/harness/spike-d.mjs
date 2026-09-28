// S2 spike：写回三件套(load / merge / patch)在"只改选中元素"时的真实语义。
// 每个场景都从同一份基准图重来，用 drawio 自己的 checksum 对比"改了什么、误伤什么"。
import { chromium } from "playwright";

const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const HOST = process.env.HOST_URL || "http://127.0.0.1:8080/spike-b.html";

const wrap = (inner) =>
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' + inner + "</root></mxGraphModel>";
const A = (v) => `<mxCell id="2" value="${v}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>`;
const B = '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="120" width="160" height="70" as="geometry"/></mxCell>';
const E = '<mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>';

const BASE = wrap(A("Alpha") + B + E);            // 基准：2=Alpha, 3=Beta, 4=边
const ONLY_A_EDITED = wrap(A("Alpha-EDITED"));    // 只带被选中的那个元素（局部载荷）
const FULL_A_EDITED = wrap(A("Alpha-EDITED") + B + E); // 全量载荷 + 局部修改

const R = { host: HOST, base: {}, scenarios: [], patchRoundTrip: null, wrongChecksum: null, errors: [] };

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => { const t = m.text(); if (!/Deprecated|favicon/i.test(t)) console.log(`[console:${m.type()}]`, t.slice(0, 200)); });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForFunction(() => window.__initAt != null, null, { timeout: 40000 });
const frame = page.frames().find((f) => f.url().includes("embed=1"));
await frame.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 40000 });
console.log("宿主就绪，drawio " + (await frame.evaluate(() => window.__aiScope.version())));

const snapshot = () => frame.evaluate(() => {
    const ui = window.__aiScope.ui, g = ui.editor.graph, m = g.getModel();
    const cells = Object.keys(m.cells).map((k) => m.cells[k]).filter((c) => m.isVertex(c) || m.isEdge(c));
    let checksum = null;
    try { checksum = ui.getHashValueForPages(ui.clonePages(ui.pages)); } catch (e) { checksum = "err:" + e.message; }
    return {
        ids: cells.map((c) => c.getId()).sort(),
        values: cells.map((c) => c.getId() + "=" + String(c.getValue())).sort(),
        styles: cells.map((c) => c.getId() + "=" + String(c.getStyle() || "")).sort(),
        selection: (g.getSelectionCells() || []).map((c) => c.getId()),
        undoDepth: (g.undoManager && g.undoManager.history) ? g.undoManager.history.length : null,
        view: { scale: g.view.scale, tx: Math.round(g.view.translate.x), ty: Math.round(g.view.translate.y) },
        checksum,
    };
});

const msgsSince = (n) => page.evaluate((from) => window.__msgs.slice(from).map((m) => m.event + (m.checksumMismatch ? "(checksumMismatch)" : "") + (m.error ? "(error:" + (m.error.message || m.error) + ")" : "") + (m.patch ? "(含patch)" : "")), n);
const msgCount = () => page.evaluate(() => window.__msgs.length);
const wait = (ms) => page.waitForTimeout(ms);

async function resetBase(label) {
    // 和真实 app 一样：带 autosave，且开 diffSync（增量同步协议）
    await page.evaluate((xml) => window.__send({ action: "load", xml, autosave: 1, diffSync: true }), BASE);
    await wait(2200);
    const s = await snapshot();
    if (label) R.base[label] = s;
    return s;
}

function diff(before, after) {
    const bv = Object.fromEntries(before.values.map((v) => v.split("=").slice(0, 1).concat([v.substring(v.indexOf("=") + 1)])));
    const av = Object.fromEntries(after.values.map((v) => [v.split("=")[0], v.substring(v.indexOf("=") + 1)]));
    return {
        removed: before.ids.filter((i) => !after.ids.includes(i)),
        added: after.ids.filter((i) => !before.ids.includes(i)),
        valueChanged: Object.keys(av).filter((k) => bv[k] !== undefined && bv[k] !== av[k]).map((k) => `${k}: ${bv[k]} -> ${av[k]}`),
        checksumSame: before.checksum === after.checksum,
        selectionBefore: before.selection, selectionAfter: after.selection,
        undoBefore: before.undoDepth, undoAfter: after.undoDepth,
        viewBefore: before.view, viewAfter: after.view,
    };
}

async function scenario(name, fn) {
    const before = await resetBase();
    const n0 = await msgCount();
    await fn();
    await wait(2200);
    const after = await snapshot();
    const s = { name, delta: diff(before, after), msgs: await msgsSince(n0) };
    R.scenarios.push(s);
    console.log(`\n### ${name}\n  被删元素: ${JSON.stringify(s.delta.removed)}\n  新增: ${JSON.stringify(s.delta.added)}\n  值变化: ${JSON.stringify(s.delta.valueChanged)}\n  checksum 不变: ${s.delta.checksumSame}\n  选区: ${JSON.stringify(s.delta.selectionBefore)} -> ${JSON.stringify(s.delta.selectionAfter)}\n  undo 深度: ${s.delta.undoBefore} -> ${s.delta.undoAfter}\n  视图: ${JSON.stringify(s.delta.viewBefore)} -> ${JSON.stringify(s.delta.viewAfter)}\n  期间事件: ${JSON.stringify(s.msgs)}`);
    return s;
}

// 先记一下基准状态本身
const baseSnap = await resetBase("first");
console.log("基准图: ids=" + JSON.stringify(baseSnap.ids) + " values=" + JSON.stringify(baseSnap.values) + " checksum=" + baseSnap.checksum);

// ===== 场景 0：全量 load（不做局部）======
await scenario("0. load 全量基准图（对照：确认重置动作本身是干净的）", async () => {
    await page.evaluate((xml) => window.__send({ action: "load", xml, autosave: 1, diffSync: true }), BASE);
});

// ===== 场景 1：局部载荷 load =====
await scenario("1. load 局部载荷（只含被选中元素 A 的新值）", async () => {
    await page.evaluate((xml) => window.__send({ action: "load", xml, autosave: 1, diffSync: true }), ONLY_A_EDITED);
});

// ===== 场景 2：局部载荷 merge =====
await scenario("2. merge 局部载荷（只含被选中元素 A 的新值）", async () => {
    await page.evaluate((xml) => window.__send({ action: "merge", xml }), ONLY_A_EDITED);
});

// ===== 场景 3：全量载荷 merge（= 全量 + 一处修改）======
await scenario("3. merge 全量载荷（含 A 的新值，B/边原样）", async () => {
    await page.evaluate((xml) => window.__send({ action: "merge", xml }), FULL_A_EDITED);
});

// ===== 场景 4：getDiff -> patch 往返 =====
console.log("\n### 4. getDiff -> patch 往返");
await resetBase();
await frame.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    m.beginUpdate();
    try { m.setValue(m.cells["2"], "Alpha-PATCHED"); } finally { m.endUpdate(); }
});
await wait(1800);
const n1 = await msgCount();
await page.evaluate(() => window.__send({ action: "getDiff" }));
await wait(1500);
const gd = await page.evaluate((n) => window.__msgs.slice(n).find((m) => m.event === "getDiff"), n1);
const autosaveMsg = await page.evaluate((n) => window.__msgs.slice(n).find((m) => m.event === "autosave"), n1);
const patch = gd && gd.patch;
console.log("getDiff 返回: patch 非空 = " + !!patch + "，checksum = " + (gd && gd.checksum) + "，xml 字段 = " + !!(gd && gd.xml));
console.log("patch 形状: " + JSON.stringify(patch).slice(0, 700));
console.log("同期的 autosave 消息: " + JSON.stringify(autosaveMsg ? { 有patch: !!autosaveMsg.patch, 有xml: !!autosaveMsg.xml, checksum: autosaveMsg.checksum } : null));

const preReset = await resetBase();
const n2 = await msgCount();
await page.evaluate((p) => window.__send({ action: "patch", patch: p }), patch);
await wait(2000);
const postPatch = await snapshot();
R.patchRoundTrip = { patchShape: JSON.stringify(patch).slice(0, 700), delta: diff(preReset, postPatch), msgs: await msgsSince(n2), autosaveSawPatch: !!(autosaveMsg && autosaveMsg.patch) };
console.log("patch 应用后: 被删=" + JSON.stringify(R.patchRoundTrip.delta.removed) + " 值变化=" + JSON.stringify(R.patchRoundTrip.delta.valueChanged) + " 事件=" + JSON.stringify(R.patchRoundTrip.msgs));
console.log("patch 的 autosave 通知: " + JSON.stringify(await msgsSince(n2)));

// ===== 场景 5：patch 带错误 checksum =====
console.log("\n### 5. patch 带错误 checksum");
const pre5 = await resetBase();
const n3 = await msgCount();
await page.evaluate((p) => window.__send({ action: "patch", patch: p, checksum: "deadbeefdeadbeef" }), patch);
await wait(2000);
const post5 = await snapshot();
R.wrongChecksum = { delta: diff(pre5, post5), msgs: await msgsSince(n3) };
console.log("错误 checksum 下: 值变化=" + JSON.stringify(R.wrongChecksum.delta.valueChanged) + " 事件=" + JSON.stringify(R.wrongChecksum.msgs));

// ===== 场景 6：patch 后应用能不能收到 autosave（对比：手动改一个值会不会收到 autosave）=====
console.log("\n### 6. autosave 可达性对照");
await resetBase();
const n4 = await msgCount();
await frame.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    m.beginUpdate();
    try { m.setValue(m.cells["3"], "Beta-MANUAL"); } finally { m.endUpdate(); }
});
await wait(2200);
R.manualEditMsgs = await msgsSince(n4);
console.log("手动改值（模拟用户在画布上编辑）期间事件: " + JSON.stringify(R.manualEditMsgs));

await resetBase();
const n5 = await msgCount();
await page.evaluate((p) => window.__send({ action: "patch", patch: p }), patch);
await wait(2200);
R.afterPatchMsgs = await msgsSince(n5);
console.log("patch 期间事件: " + JSON.stringify(R.afterPatchMsgs));

console.log("\nSPIKE_D_RESULT=" + JSON.stringify(R, null, 2));
await browser.close();
