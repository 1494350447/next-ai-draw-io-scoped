// S2 实验三（结论版）：三条写回路径 × 三种载荷，全部记录"改了什么 / 误伤什么 / 应用能否感知 / 怎么重新同步"
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const PAGE = "PAGE1";
const model = (inner) =>
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' + inner + "</root></mxGraphModel>";
const A = (v) => `<mxCell id="2" value="${v}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>`;
const B = '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="120" width="160" height="70" as="geometry"/></mxCell>';
const E = '<mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>';
const FILE = (inner) => `<mxfile host="app"><diagram id="${PAGE}" name="Page-1">${model(inner)}</diagram></mxfile>`;
const BASE = FILE(A("Alpha") + B + E);
const RAW_PARTIAL = model(A("Alpha-EDITED"));
const FILE_PARTIAL = FILE(A("Alpha-EDITED"));
const FILE_FULL = FILE(A("Alpha-EDITED") + B + E);

const R = { matrix: [], patch: {}, resync: {}, notes: [] };

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => { const t = m.text(); if (!/Deprecated|favicon/i.test(t)) console.log(`[console:${m.type()}]`, t.slice(0, 160)); });
await page.goto("http://127.0.0.1:8080/spike-b.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__initAt != null, null, { timeout: 40000 });
const frame = page.frames().find((f) => f.url().includes("embed=1"));
await frame.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 40000 });

const mc = () => page.evaluate(() => window.__msgs.length);
// 完整报文形状，方便看清 drawio 到底发了什么
const since = (n) => page.evaluate((f) => window.__msgs.slice(f).map((m) => {
    const o = { event: m.event };
    if (m.error) o.error = String(m.error.message || JSON.stringify(m.error)).slice(0, 60);
    if (m.checksum) o.checksum = m.checksum;
    if (m.checksumMismatch) o.checksumMismatch = true;
    if (m.patch) o.patchKeys = Object.keys(m.patch);
    if (m.xml) o.xmlLen = String(m.xml).length;
    if (m.data && typeof m.data === "string") o.dataLen = m.data.length;
    return o;
}), n);
const wait = (ms) => page.waitForTimeout(ms);
const values = () => frame.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    return Object.keys(m.cells).map((k) => m.cells[k]).filter((c) => c.isVertex() || c.isEdge()).map((c) => c.getId() + "=" + String(c.getValue())).sort();
});
const pageId = () => frame.evaluate(() => (window.__aiScope.ui.pages && window.__aiScope.ui.pages[0]) ? window.__aiScope.ui.pages[0].getId() : "(ui.pages 为 null)");
async function load(xml, extra = {}) {
    await page.evaluate((o) => window.__send(Object.assign({ action: "load", xml: o.xml, autosave: 1 }, o.extra)), { xml, extra });
    await wait(2000);
}
async function step(name, sendFn, { reload = true, extra = {}, payloadKind = "" } = {}) {
    if (reload) await load(BASE, extra);
    const v0 = await values(), p0 = await pageId(), n = await mc();
    await sendFn();
    await wait(2500);
    const v1 = await values(), p1 = await pageId(), msgs = await since(n);
    const s = { name, payloadKind, diffSync: !!extra.diffSync, valuesBefore: v0, valuesAfter: v1, pageIdBefore: p0, pageIdAfter: p1, msgs };
    R.matrix.push(s);
    console.log(`\n### ${name}${payloadKind ? " [" + payloadKind + "] " : " "}diffSync=${!!extra.diffSync}\n  前: ${JSON.stringify(v0)}\n  后: ${JSON.stringify(v1)}\n  pageId: ${p0} -> ${p1}\n  报文: ${JSON.stringify(msgs)}`);
    return s;
}

await step("1. load 局部载荷", () => page.evaluate((xml) => window.__send({ action: "load", xml, autosave: 1 }), RAW_PARTIAL), { payloadKind: "裸模型/只含A" });
await step("2. merge 裸模型 局部载荷", () => page.evaluate((xml) => window.__send({ action: "merge", xml }), RAW_PARTIAL), { payloadKind: "裸模型/只含A" });
await step("3. merge mxfile 局部载荷", () => page.evaluate((xml) => window.__send({ action: "merge", xml }), FILE_PARTIAL), { payloadKind: "mxfile+id/只含A" });
await step("4. merge mxfile 全量载荷+改A", () => page.evaluate((xml) => window.__send({ action: "merge", xml }), FILE_FULL), { payloadKind: "mxfile+id/全量" });
await step("5. merge mxfile 全量载荷+改A (diffSync)", () => page.evaluate((xml) => window.__send({ action: "merge", xml }), FILE_FULL), { payloadKind: "mxfile+id/全量", extra: { diffSync: true } });

// ===== patch：先用 diffSync 让 drawio 自己产出一个真 patch =====
console.log("\n### 6. 取 drawio 自产的 patch");
await load(BASE, { diffSync: true });
const n0 = await mc();
await frame.evaluate(() => { const g = window.__aiScope.graph, m = g.getModel(); m.beginUpdate(); try { m.setValue(m.cells["2"], "Alpha-PATCHED"); } finally { m.endUpdate(); } });
await wait(2500);
const auto = await page.evaluate((n) => window.__msgs.slice(n).find((m) => m.event === "autosave" && m.patch), n0);
const selfPatch = auto ? auto.patch : null;
R.patch.来源 = auto ? "drawio autosave 报文里带的 patch" : "拿不到（回退自算）";
R.patch.形状 = JSON.stringify(selfPatch).slice(0, 400);
R.patch.checksum = auto ? auto.checksum : null;
console.log("patch 来源: " + R.patch.来源 + "\n形状: " + R.patch.形状 + "\nchecksum: " + R.patch.checksum);

if (selfPatch) {
    const s = await step("6. patch（drawio 自产 patch，带正确 checksum）", () => page.evaluate((o) => window.__send({ action: "patch", patch: o.patch, checksum: o.checksum }), { patch: selfPatch, checksum: auto.checksum }));
    R.patch.应用后生效 = s.valuesAfter.indexOf("2=Alpha-PATCHED") >= 0;
    R.patch.误伤 = s.valuesAfter.filter((v) => !s.valuesBefore.includes(v) && v !== "2=Alpha-PATCHED");
    R.patch.应用侧收到autosave = s.msgs.some((m) => m.event === "autosave");
    R.patch.pageId不变 = s.pageIdBefore === s.pageIdAfter;

    const s2 = await step("7. patch（同一个 patch，带错误 checksum）", () => page.evaluate((o) => window.__send({ action: "patch", patch: o.patch, checksum: "deadbeefdeadbeef" }), { patch: selfPatch }));
    R.patch.错误checksum仍生效 = s2.valuesAfter.indexOf("2=Alpha-PATCHED") >= 0;
    R.patch.错误checksum被标记 = s2.msgs.some((m) => m.checksumMismatch);

    // ===== 8. patch 之后应用怎么重新同步 =====
    await load(BASE);
    await page.evaluate((o) => window.__send({ action: "patch", patch: o.patch }), { patch: selfPatch });
    await wait(2000);
    const vAfter = await values();
    const n2 = await mc();
    await page.evaluate(() => window.__send({ action: "export", format: "xml" }));
    await wait(2000);
    const exp = await page.evaluate((n) => window.__msgs.slice(n).map((m) => ({ event: m.event, keys: Object.keys(m), dataLen: m.data ? String(m.data).length : (m.xml ? String(m.xml).length : 0), hasPatchedValue: String(m.data || m.xml || "").indexOf("Alpha-PATCHED") >= 0 })), n2);
    R.resync = { 画布值: vAfter, export响应: exp };
    console.log("\n### 8. patch 后用 export 重新同步\n  画布值: " + JSON.stringify(vAfter) + "\n  export 响应: " + JSON.stringify(exp));
}

console.log("\nSPIKE_D3_RESULT=" + JSON.stringify(R, null, 2));
await browser.close();
