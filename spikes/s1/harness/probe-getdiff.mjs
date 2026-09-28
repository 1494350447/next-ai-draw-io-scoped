// 补测：不开 diffSync 时 getDiff 是否可用（它是"重新同步"的备选 API）
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const model = (inner) =>
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' + inner + "</root></mxGraphModel>";
const A = '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>';
const B = '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="120" width="160" height="70" as="geometry"/></mxCell>';
const FILE = `<mxfile host="app"><diagram id="PAGE1" name="Page-1">${model(A + B)}</diagram></mxfile>`;
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => { const t = m.text(); if (!/Deprecated|favicon/i.test(t)) console.log(`[console:${m.type()}]`, t.slice(0, 200)); });
await page.goto("http://127.0.0.1:8080/spike-b.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__initAt != null, null, { timeout: 40000 });
const frame = page.frames().find((f) => f.url().includes("embed=1"));
await frame.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 40000 });

const R = {};
// 干净复测：先等 load 响应彻底到齐（5s），再发 getDiff
for (const [label, extra] of [["不开 diffSync", {}], ["开 diffSync", { diffSync: true }]]) {
    await page.evaluate((o) => window.__send(Object.assign({ action: "load", xml: o.xml, autosave: 1 }, o.extra)), { xml: FILE, extra });
    await page.waitForTimeout(5000);
    R["load响应_" + label] = await page.evaluate(() => window.__msgs.map((m) => ({ event: m.event, xmlLen: m.xml ? String(m.xml).length : null })));
    const n = await page.evaluate(() => window.__msgs.length);
    await page.evaluate(() => window.__send({ action: "getDiff" }));
    await page.waitForTimeout(3000);
    R[label] = await page.evaluate((f) => window.__msgs.slice(f).map((m) => ({ event: m.event, keys: Object.keys(m), error: m.error ? String(m.error.message || m.error).slice(0, 70) : null, xmlLen: m.xml ? String(m.xml).length : null, patchKeys: m.patch ? Object.keys(m.patch) : null, checksum: m.checksum || null })), n);
    console.log(label + " -> " + JSON.stringify(R[label]));
    console.log(label + " 发 getDiff 前的事件: " + JSON.stringify(R["load响应_" + label]));
}
console.log("\nPROBE_GETDIFF_RESULT=" + JSON.stringify(R, null, 2));
await browser.close();
