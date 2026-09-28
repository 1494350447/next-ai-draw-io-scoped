// 探针：drawio 的撤销管理器到底挂在哪、history 叫什么名字（S3 需要它来证明写回进没进撤销栈）
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(process.env.HOST_URL || "http://127.0.0.1:8080/spike-e.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__initAt != null, null, { timeout: 40000 });
const frame = page.frames().find((f) => f.url().includes("embed=1"));
await frame.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 40000 });
// 先放一张图进去 —— 空画布上改任何东西都是 no-op，撤销栈当然不动（这版探针第一轮就踩了这个坑）
const PAGE1 = "PAGE1";
const mk = (inner) => `<mxfile host="app"><diagram id="${PAGE1}" name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${inner}</root></mxGraphModel></diagram></mxfile>`;
const CELL = '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>';
await page.evaluate((xml) => window.__send({ action: "load", xml, autosave: 1 }), mk(CELL));
await page.waitForTimeout(2500);

const out = await frame.evaluate(() => {
    const g = window.__aiScope.graph, ui = window.__aiScope.ui;
    const probe = (label, o) => o ? {
        label,
        构造: o.constructor && o.constructor.name,
        键: Object.keys(o),
        history: Array.isArray(o.history) ? o.history.length : typeof o.history,
        undoStack: Array.isArray(o.undoStack) ? o.undoStack.length : typeof o.undoStack,
        enabled: o.enabled,
        size: typeof o.size === "function" ? o.size() : undefined,
    } : null;
    const list = {
        "graph.undoManager": probe("graph.undoManager", g.undoManager),
        "ui.undoManager": probe("ui.undoManager", ui.undoManager),
        "ui.editor.undoManager": probe("ui.editor.undoManager", ui.editor && ui.editor.undoManager),
        "ui.actions.undo.exists": !!ui.actions.get("undo"),
        "ui.actions.undo.funct": typeof (ui.actions.get("undo") || {}).funct,
        "ui.actions.undo.enabled": (ui.actions.get("undo") || {}).enabled,
        "mxUndoManager.proto": Object.getOwnPropertyNames(mxUndoManager.prototype),
    };
    // 真实改一次，看看哪个计数会动
    const before = {};
    const snap = () => {
        const g2 = g, ui2 = ui;
        const cands = [g2.undoManager, ui2.undoManager, ui2.editor && ui2.editor.undoManager].filter(Boolean);
        return cands.map((c) => (c.history ? c.history.length : -1));
    };
    before.depths = snap();
    const m = g.getModel();
    m.beginUpdate();
    try { g.setCellStyles("fillColor", "#ffe6cc", [m.cells["2"]]); } finally { m.endUpdate(); }
    return { list, before: before.depths, after: snap() };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
