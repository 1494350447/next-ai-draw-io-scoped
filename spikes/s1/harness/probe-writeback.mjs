// 诊断：为什么 merge/patch 抛 "ya is not a function"、为什么 getDiff 的 patch 是空的
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const BASE =
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    "</root></mxGraphModel>";

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => { const t = m.text(); if (!/Deprecated|favicon/i.test(t)) console.log(`[console:${m.type()}]`, t.slice(0, 300)); });
await page.goto("http://127.0.0.1:8080/spike-b.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__initAt != null, null, { timeout: 40000 });
const frame = page.frames().find((f) => f.url().includes("embed=1"));
await frame.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 40000 });
await page.evaluate((x) => window.__send({ action: "load", xml: x, autosave: 1, diffSync: true }), BASE);
await page.waitForTimeout(2500);

const out = await frame.evaluate((base) => {
    const ui = window.__aiScope.ui, g = ui.editor.graph;
    const probe = (label, fn) => { try { return { [label]: fn() }; } catch (e) { return { [label]: "THROW: " + (e && e.message) + " | " + String((e && e.stack || "").split("\n")[1] || "").trim().slice(0, 160) }; } };
    const r = {
        types: {
            diffPages: typeof ui.diffPages, patchPages: typeof ui.patchPages, clonePages: typeof ui.clonePages,
            applyPatches: typeof ui.applyPatches, getHashValueForPages: typeof ui.getHashValueForPages,
            resolveCrossReferences: typeof ui.resolveCrossReferences,
            LocalFile: typeof window.LocalFile, DrawioFile: typeof window.DrawioFile,
            mxCellAttributes: typeof window.mxCellAttributes,
        },
        currentFile: (() => { const f = ui.getCurrentFile(); return f ? { ctor: f.constructor && f.constructor.name, hasGetShadowPages: typeof f.getShadowPages, hasPatch: typeof f.patch, hasMergeFile: typeof f.mergeFile, hasGetData: typeof f.getData } : null; })(),
        pagesLen: ui.pages ? ui.pages.length : null,
        // 关键 1：ui.pages 是不是"活的"？跟 live model 比一下
        liveVsPages: (() => {
            const live = Object.keys(g.getModel().cells).map((k) => k + "=" + String(g.getModel().cells[k].getValue())).sort().join(",");
            const p = ui.pages && ui.pages[0];
            const pg = p && p.root ? Object.keys(p.root.children || {}).map((k) => k + "=" + String(p.root.children[k].getValue())).sort().join(",") : "no pages";
            return { live, pageRootChildren: pg };
        })(),
    };
    // 关键 2：LocalFile 能不能拿到 shadow pages
    Object.assign(r, probe("newLocalFile_pages", () => { const f = new window.LocalFile(ui, base); return { hasData: typeof f.getData, pages: f.getShadowPages ? "has getShadowPages" : "no method" }; }));
    Object.assign(r, probe("getShadowPages_call", () => { const f = new window.LocalFile(ui, base); const p = f.getShadowPages(); return p ? { len: p.length, firstRootChildren: p[0] && p[0].root ? Object.keys(p[0].root.children || {}).length : null } : "null"; }));
    Object.assign(r, probe("ui_clonePages", () => { const c = ui.clonePages(ui.pages); return { len: c.length, firstChildren: c[0] && c[0].root ? Object.keys(c[0].root.children || {}).length : null }; }));
    Object.assign(r, probe("diffPages_shadow_vs_incoming", () => {
        const f = new window.LocalFile(ui, base);
        const incoming = f.getShadowPages();
        const shadow = ui.getCurrentFile().getShadowPages ? ui.getCurrentFile().getShadowPages() : ui.clonePages(ui.pages);
        return { shadowLen: shadow ? shadow.length : null, incomingLen: incoming.length, diffKeys: Object.keys(ui.diffPages(shadow, incoming) || {}) };
    }));
    // 关键 3：改动 live model 后，diffPages(shadow, clonePages(pages)) 是否为空（= pages 没跟着活）
    Object.assign(r, probe("diff_after_live_edit", () => {
        const shadow = ui.clonePages(ui.pages);
        const m = g.getModel();
        m.beginUpdate(); try { m.setValue(m.cells["2"], "Alpha-XYZ"); } finally { m.endUpdate(); }
        const afterClone = ui.clonePages(ui.pages);
        const d1 = ui.diffPages(shadow, afterClone);
        ui.getFileData(true); // drawio 内部会在这里把 live model 刷新回 pages
        const afterGetFileData = ui.clonePages(ui.pages);
        const d2 = ui.diffPages(shadow, afterGetFileData);
        return { 不刷新pages时diff为空: Object.keys(d1 || {}).length === 0, 调getFileData后diff为空: Object.keys(d2 || {}).length === 0, d2keys: Object.keys(d2 || {}) };
    }));
    return r;
}, BASE);
console.log(JSON.stringify(out, null, 2));
await browser.close();
