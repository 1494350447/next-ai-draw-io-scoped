/*
 * 决定性探针：AI 改动之后 / 手动拖拽之后，drawio 自带的撤销到底能不能用？
 * 判据三样，全都不猜：
 *   ① XML（宿主 autosave 回吐的，产品数据面）：撤销前后 cell 片段是否回退；
 *   ② 撤销/重做**按钮**的真实状态（disabled / opacity / class）；
 *   ③ **重做**能不能把撤销掉的东西再改回来 —— 只有真的 undo+redo = 真撤销栈；
 *      若是"宿主拿旧状态重新 load"，重做不会有任何反应。
 */
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const APP = process.env.APP_URL || "http://127.0.0.1:3000/";
const FIXTURE = {
    2: { name: "Alpha", x: 120, y: 120, w: 160, h: 70, style: "rounded=1;whiteSpace=wrap;html=1;" },
    3: { name: "Beta", x: 420, y: 240, w: 200, h: 90, style: "rounded=1;whiteSpace=wrap;html=1;" },
    4: { name: "Gamma", x: 160, y: 420, w: 180, h: 60, style: "rounded=1;whiteSpace=wrap;html=1;" },
    5: { name: "KeepMe", x: 600, y: 520, w: 140, h: 60, style: "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;" },
};
const MXFILE = '<mxfile host="app.diagrams.net"><diagram name="Page-1">' +
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    Object.keys(FIXTURE).map((id) => { const f = FIXTURE[id]; return `<mxCell id="${id}" value="${f.name}" style="${f.style}" vertex="1" parent="1"><mxGeometry x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" as="geometry"/></mxCell>`; }).join("") +
    "</root></mxGraphModel></diagram></mxfile>";

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(() => {
    window.__drawioMsgs = [];
    window.addEventListener("message", (e) => { let m = null; try { m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch (_) { return; } if (m && m.event) window.__drawioMsgs.push(m); });
});
await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector('iframe[src*="8080"]', { timeout: 60000 });
const frameEl = await page.$('iframe[src*="8080"]');
const frame = await frameEl.contentFrame();
const fr = await frameEl.boundingBox();
await page.waitForTimeout(4000);
await page.evaluate((xml) => { const f = Array.from(document.querySelectorAll("iframe")).find((i) => (i.src || "").includes("8080")); f.contentWindow.postMessage(JSON.stringify({ action: "load", xml, autosave: true }), "*"); }, MXFILE);
await frame.waitForSelector("text=Alpha", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
const labelBox = async (n) => { const el = await frame.$(`text=${n}`); return el ? el.boundingBox() : null; };
const clickLabel = async (n, o = {}) => { const b = await labelBox(n); await page.mouse.click(Math.round(fr.x + b.x + b.width / 2), Math.round(fr.y + b.y + b.height / 2), o); };
const lastAutosave = () => page.evaluate(() => { const l = (window.__drawioMsgs || []).filter((m) => m.event === "autosave" && m.xml); return l.length ? l[l.length - 1].xml : null; });
const cellOf = (xml, id) => { const m = new RegExp(`<mxCell id="${id}"[\\s\\S]*?</mxCell>`).exec(xml || ""); return m ? m[0] : null; };
const geomX = (s) => { const m = /<mxGeometry[^>]*?\sx="([^"]+)"/.exec(s || ""); return m ? m[1] : null; };
// drawio 工具栏按钮：带 title 的 geButton（未国际化，title 是英文）
const buttons = () => frame.evaluate(() => {
    const out = [];
    Array.from(document.querySelectorAll("[title]")).forEach((e) => {
        const t = e.getAttribute("title") || "";
        if (!/^(Undo|Redo)/i.test(t)) return;
        const cs = getComputedStyle(e);
        out.push({ title: t, tag: e.tagName, cls: e.className, disabled: !!e.getAttribute("disabled") || e.classList.contains("geDisabled"), opacity: cs.opacity, cursor: cs.cursor });
    });
    return out;
});
const R = {};
R.before = { buttons: await buttons(), betaX: geomX(cellOf(await lastAutosave(), "3")) };

// ===== A. AI 改动（左对齐）之后 =====
await clickLabel("Alpha");
await page.keyboard.down("Shift"); await clickLabel("Beta"); await clickLabel("Gamma"); await page.keyboard.up("Shift");
await page.waitForTimeout(400);
await clickLabel("Alpha", { button: "right" });
const item = await frame.evaluate(() => {
    const menus = Array.from(document.querySelectorAll(".mxPopupMenu")).filter((m) => m.offsetParent !== null);
    for (const m of menus) for (const tr of m.querySelectorAll("tr")) if (tr.textContent.trim().startsWith("AI 局部修改…")) { const r = tr.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
    return null;
});
await page.mouse.click(fr.x + item.x, fr.y + item.y);
await page.waitForTimeout(600);
await frame.fill('#aiScopeInstructPanel [data-role="ai-scope-input"]', "左对齐");
const runBtn = await frame.evaluate(() => { const b = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-run"]').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; });
await page.mouse.click(fr.x + runBtn.x, fr.y + runBtn.y);
await frame.waitForFunction(() => { const el = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]'); return el && /已应用/.test(el.textContent || ""); }, null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);
const xmlApplied = await lastAutosave();
R.afterAI = { buttons: await buttons(), betaX: geomX(cellOf(xmlApplied, "3")), gammaX: geomX(cellOf(xmlApplied, "4")) };

// Ctrl+Z（先点空白让画布拿到焦点）
await page.mouse.click(fr.x + 900, fr.y + 700);
await page.keyboard.press("Control+z");
await page.waitForTimeout(2500);
const xmlUndo = await lastAutosave();
R.afterCtrlZ = { buttons: await buttons(), betaX: geomX(cellOf(xmlUndo, "3")), gammaX: geomX(cellOf(xmlUndo, "4")) };

// Ctrl+Y 重做：真撤销栈才会响应
await page.keyboard.press("Control+y");
await page.waitForTimeout(2500);
const xmlRedo = await lastAutosave();
R.afterCtrlY = { buttons: await buttons(), betaX: geomX(cellOf(xmlRedo, "3")), gammaX: geomX(cellOf(xmlRedo, "4")), xmlChanged: xmlRedo !== xmlUndo };

// ===== B. 手动拖拽之后（对照：之前那次结论的来源）=====
const dragBy = async (id, dx, dy) => {
    const b = await labelBox(FIXTURE[id].name);
    const cx = Math.round(fr.x + b.x + b.width / 2), cy = Math.round(fr.y + b.y + b.height / 2);
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 12 }); await page.mouse.up();
    await page.waitForTimeout(2600);
};
await dragBy(5, 0, 60);
const xmlDrag = await lastAutosave();
R.afterManualDrag = { buttons: await buttons(), keepMeY: (/<mxGeometry[^>]*?\sy="([^"]+)"/.exec(cellOf(xmlDrag, "5")) || [])[1] };
await page.mouse.click(fr.x + 900, fr.y + 700);
await page.keyboard.press("Control+z");
await page.waitForTimeout(2500);
const xmlDragUndo = await lastAutosave();
R.afterManualDragCtrlZ = { buttons: await buttons(), keepMeY: (/<mxGeometry[^>]*?\sy="([^"]+)"/.exec(cellOf(xmlDragUndo, "5")) || [])[1] };
R.dragReverted = !!xmlDrag && !!xmlDragUndo && cellOf(xmlDrag, "5") !== cellOf(xmlDragUndo, "5");

console.log("PROBE_UNDO_REDO=" + JSON.stringify(R, null, 2));
await browser.close();
