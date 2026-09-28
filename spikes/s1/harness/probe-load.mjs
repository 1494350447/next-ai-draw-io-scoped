// 诊断：embed 里发送 load 后图是否真的进去
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const DIAGRAM =
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    "</root></mxGraphModel>";
const Q = "embed=1&proto=json&spin=0&libraries=0&noSaveBtn=1&noExitBtn=1&ui=kennedy";
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("console", (m) => console.log(`[page:${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.addInitScript(({ xml }) => {
    window.__msgs = [];
    window.addEventListener("message", (e) => {
        let m; try { m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch (_) { return; }
        if (!m || !m.event) return;
        window.__msgs.push(m);
        if (m.event === "init") {
            window.__loadSentAt = Date.now();
            window.postMessage(JSON.stringify({ action: "load", xml }), "*");
        }
    });
}, { xml: DIAGRAM });
await page.goto(`http://127.0.0.1:8080/?${Q}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 45000 });
for (const t of [500, 1500, 3000, 6000]) {
    await page.waitForTimeout(t === 500 ? 500 : 1000);
    const d = await page.evaluate(() => {
        const g = window.__aiScope.graph, m = g.getModel(), root = m.getRoot();
        return {
            t: Date.now(),
            cells: m.getChildren(root).map((c) => c.getId()),
            fileXmlLen: (window.__aiScope.ui.getFileData ? (window.__aiScope.ui.getFileData().xml || "").length : -1),
            modelCells: m.cells ? Object.keys(m.cells).length : -1,
        };
    });
    console.log("dump@" + t + "ms: " + JSON.stringify(d));
}
console.log("MSGS=" + JSON.stringify(await page.evaluate(() => window.__msgs.map((m) => m.event))));
console.log("loadSent=" + (await page.evaluate(() => !!window.__loadSentAt)));
await browser.close();
