// 诊断：插件拿到的 ui.editor.graph 与页面上真正显示的编辑器是不是同一个
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const MODEL =
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    "</root></mxGraphModel>";

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => console.log(`[console:${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto("http://127.0.0.1:8080/spike-b.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__initAt != null, null, { timeout: 40000 });
const frame = page.frames().find((f) => f.url().includes("embed=1"));
await frame.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 40000 });

await page.evaluate((x) => window.__send({ action: "load", xml: x }), MODEL);
await page.waitForTimeout(3000);

const d = await frame.evaluate(() => {
    const ui = window.__aiScope.ui, g = ui.editor.graph, m = g.getModel(), root = m.getRoot();
    const containers = Array.from(document.querySelectorAll(".geDiagramContainer"));
    const info = (gg) => {
        try {
            const mm = gg.getModel();
            return { rootId: mm.getRoot() && mm.getRoot().id, rootChildCount: mm.getChildCount(mm.getRoot()), cellKeys: Object.keys(mm.cells || {}), vertexCount: gg.getChildVertices(mm.getRoot()).length };
        } catch (e) { return "err:" + e.message; }
    };
    return {
        uiIsWindowUi: typeof window.ui !== "undefined" ? window.ui === ui : "no window.ui",
        pluginGraphVsVisible: containers.map((c) => ({ isPluginGraph: c === g.container, rect: (r => ({ w: Math.round(r.width), h: Math.round(r.height) }))(c.getBoundingClientRect()) })),
        containerCount: containers.length,
        pluginGraph: info(g),
        pluginModelIsGraphModel: m === g.model,
        allGraphsOnPage: (() => {
            // drawio 的编辑器实例挂在这些地方
            const out = {};
            out.App_editor_graph = (window.App && App.editor && App.editor.graph) ? info(App.editor.graph) : "none";
            out.window_ui = (typeof window.ui !== "undefined" && window.ui && window.ui.editor && window.ui.editor.graph) ? info(window.ui.editor.graph) : "none";
            return out;
        })(),
        pages: ui.pages ? { length: ui.pages.length, first: ui.pages[0] ? { id: ui.pages[0].getId ? ui.pages[0].getId() : "?", cells: ui.pages[0].root ? Object.keys(ui.pages[0].root.children || {}) : null } : null } : null,
        fileDataLen: ui.getFileData ? String(ui.getFileData(true).length) : "n/a",
        fileDataHead: ui.getFileData ? ui.getFileData(true).slice(0, 120) : "n/a",
        isDiagramEmpty: ui.isDiagramEmpty ? ui.isDiagramEmpty() : null,
    };
});
console.log(JSON.stringify(d, null, 2));
console.log("HOST_MSGS=" + JSON.stringify(await page.evaluate(() => window.__msgs.map((m) => m.event))));
await browser.close();
