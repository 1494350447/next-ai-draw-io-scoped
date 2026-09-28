/*
 * 探针（两件事，用户提问驱动）：
 *  A. 右键菜单的行顺序 —— 「删除」在第几行、我们的项现在插在哪（要给"挪到删除下面"找依据）
 *  B. **AI 改动之后**，应用内 drawio 自带的撤销还能不能用（用户认为"本身 drawio 自带返回上次修改"，这里用证据核）
 *     · 只看按钮状态 + Ctrl+Z 后宿主收到的 XML 有没有退回去，不猜。
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
    window.addEventListener("message", (e) => {
        let m = null; try { m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch (_) { return; }
        if (m && m.event) window.__drawioMsgs.push(m);
    });
});
await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector('iframe[src*="8080"]', { timeout: 60000 });
const frameEl = await page.$('iframe[src*="8080"]');
const frame = await frameEl.contentFrame();
const fr = await frameEl.boundingBox();
await page.waitForTimeout(4000);
await page.evaluate((xml) => {
    const f = Array.from(document.querySelectorAll("iframe")).find((i) => (i.src || "").includes("8080"));
    f.contentWindow.postMessage(JSON.stringify({ action: "load", xml, autosave: true }), "*");
}, MXFILE);
await frame.waitForSelector("text=Alpha", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
const labelBox = async (n) => { const el = await frame.$(`text=${n}`); return el ? el.boundingBox() : null; };
const clickLabel = async (n, o = {}) => { const b = await labelBox(n); await page.mouse.click(Math.round(fr.x + b.x + b.width / 2), Math.round(fr.y + b.y + b.height / 2), o); };
const lastAutosave = () => page.evaluate(() => { const l = (window.__drawioMsgs || []).filter((m) => m.event === "autosave" && m.xml); return l.length ? l[l.length - 1].xml : null; });

// ===== A. 菜单行顺序 =====
await clickLabel("Alpha", { button: "right" });
await page.waitForTimeout(800);
const rows = await frame.evaluate(() => {
    const out = [];
    Array.from(document.querySelectorAll(".mxPopupMenu")).filter((m) => m.offsetParent !== null).forEach((m) => {
        Array.from(m.querySelectorAll("tr")).forEach((tr, i) => out.push({ i, title: tr.getAttribute("title"), text: tr.textContent.trim().slice(0, 24), color: getComputedStyle(tr.querySelector('td[align="left"]') || tr).color }));
    });
    return out;
});
console.log("MENU_ROWS=" + JSON.stringify(rows, null, 1));
await page.keyboard.press("Escape");

// ===== B. AI 改动之后，自带撤销还能不能用 =====
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
const runBtn = await frame.evaluate(() => { const el = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-run"]'); const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; });
await page.mouse.click(fr.x + runBtn.x, fr.y + runBtn.y);
await frame.waitForFunction(() => { const el = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]'); return el && /已应用/.test(el.textContent || ""); }, null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(500);
const xmlAfterApply = await lastAutosave();
const undoBtn = () => frame.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button,[role='button'],div[class*='toolbar'] *")).find((e) => /undo|撤销/i.test((e.getAttribute && (e.getAttribute("title") || e.getAttribute("aria-label") || e.getAttribute("data-tooltip"))) || ""));
    if (!b) return { found: false };
    const cs = getComputedStyle(b);
    return { found: true, disabled: !!b.getAttribute("disabled"), cls: b.className, opacity: cs.opacity, pointer: cs.pointerEvents, title: b.getAttribute("title") || b.getAttribute("aria-label") || b.getAttribute("data-tooltip") };
});
const timeline = [];
for (const ms of [300, 1200, 2000, 4000]) { await page.waitForTimeout(ms === 300 ? 300 : 0); await page.waitForTimeout(0); timeline.push({ at: ms, btn: await undoBtn() }); }
console.log("UNDO_BUTTON_AFTER_AI=" + JSON.stringify(timeline, null, 1));
// Ctrl+Z（画布聚焦后）
await frame.evaluate(() => { const g = document.querySelector("svg"); if (g) g.focus && g.focus(); });
await page.mouse.click(fr.x + 700, fr.y + 300);
await page.keyboard.press("Control+z");
await page.waitForTimeout(2500);
const xmlAfterCtrlZ = await lastAutosave();
const cellOf = (xml, id) => { const m = new RegExp(`<mxCell id="${id}"[\\s\\S]*?</mxCell>`).exec(xml || ""); return m ? m[0] : null; };
const geomX = (s) => { const m = /<mxGeometry[^>]*?\sx="([^"]+)"/.exec(s || ""); return m ? m[1] : null; };
console.log("CTRLZ_RESULT=" + JSON.stringify({
    alphaAfterApply: geomX(cellOf(xmlAfterApply, "2")), betaAfterApply: geomX(cellOf(xmlAfterApply, "3")),
    betaAfterCtrlZ: geomX(cellOf(xmlAfterCtrlZ, "3")),
    ctrlZReverted: !!xmlAfterApply && !!xmlAfterCtrlZ && cellOf(xmlAfterApply, "3") !== cellOf(xmlAfterCtrlZ, "3"),
}));
await browser.close();
