/*
 * 探针：drawio 的右键菜单里，`enabled=false` 的项在 DOM 上长什么样？
 * 探针（历史）：用来量"菜单项在什么条件下是灰的"（曾服务于已移除的「复原上一次改动」功能）。
 * 保留是因为它记录了两条仍然有用的事实：addItem 的 enabled 参数如何映射到 mxDisabled，以及无选区时菜单行的状态。
 */
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const APP = process.env.APP_URL || "http://127.0.0.1:3000/";
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector('iframe[src*="8080"]', { timeout: 60000 });
const frameEl = await page.$('iframe[src*="8080"]');
const frame = await frameEl.contentFrame();
const MXFILE = '<mxfile host="app.diagrams.net"><diagram name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';
await page.waitForTimeout(3500);
await page.evaluate((xml) => {
    const f = Array.from(document.querySelectorAll("iframe")).find((i) => (i.src || "").includes("8080"));
    f.contentWindow.postMessage(JSON.stringify({ action: "load", xml, autosave: true }), "*");
}, MXFILE);
await frame.waitForSelector("text=Alpha", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
const el = await frame.$("text=Alpha");
const b = await el.boundingBox();
const b2 = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
const fr = await frameEl.boundingBox();
await page.mouse.click(fr.x + b2.x, fr.y + b2.y, { button: "right" });
await page.waitForTimeout(800);
const rows = await frame.evaluate(() => {
    const out = [];
    Array.from(document.querySelectorAll(".mxPopupMenu")).filter((m) => m.offsetParent !== null).forEach((m) => {
        Array.from(m.querySelectorAll("tr")).forEach((tr) => {
            const cs = getComputedStyle(tr);
            out.push({ text: tr.textContent.trim().slice(0, 40), cls: tr.className, opacity: cs.opacity, cursor: cs.cursor, filter: cs.filter, color: cs.color });
        });
    });
    return out;
});
const all = await frame.evaluate(() => Array.from(document.querySelectorAll("*")).filter((e) => e.children.length === 0 && /AI 局部修改/.test(e.textContent || "")).map((e) => ({ tag: e.tagName, cls: e.className, vis: !!e.offsetParent })));
console.log("ALL_MATCH=" + JSON.stringify(all));
const html = await frame.evaluate(() => {
    const out = [];
    Array.from(document.querySelectorAll(".mxPopupMenu")).filter((m) => m.offsetParent !== null).forEach((m) => {
        Array.from(m.querySelectorAll("tr")).forEach((tr) => {
            const t = tr.textContent.trim();
            if (/AI 局部修改|撤销|Undo|删除|Delete/.test(t)) out.push({ text: t.slice(0, 30), html: tr.outerHTML.slice(0, 400) });
        });
    });
    return out;
});
console.log("ROW_HTML=" + JSON.stringify(html, null, 2));
console.log(JSON.stringify(rows.filter((r) => /AI 局部修改|撤销|Undo/.test(r.text) || r.text === ""), null, 2));
console.log("ROWS_TOTAL=" + rows.length);
await browser.close();
