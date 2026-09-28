// 定性：应用内"拖一下"之后，撤销按钮的启用状态随时间怎么变（判断是不是同步/autosave 把撤销栈清了）
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const MXFILE = '<mxfile host="app.diagrams.net"><diagram name="Page-1"><mxGraphModel dx="800" dy="600" page="1" pageWidth="850" pageHeight="1100"><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(() => { window.__msgs = []; window.addEventListener("message", (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } if (m && m.event) window.__msgs.push({ ev: m.event, t: Date.now() }); }); });
await page.goto("http://127.0.0.1:3000/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector('iframe[src*="8080"]', { timeout: 60000 });
const fe = await page.$('iframe[src*="8080"]');
const frame = await fe.contentFrame();
const fr = await fe.boundingBox();
await page.waitForTimeout(4000);
await page.evaluate((xml) => {
    const f = Array.from(document.querySelectorAll("iframe")).find((i) => (i.src || "").includes("8080"));
    f.contentWindow.postMessage(JSON.stringify({ action: "load", xml, autosave: true }), "*");
}, MXFILE);
await frame.waitForSelector("text=Alpha", { timeout: 20000 });
await page.waitForTimeout(1500);
const btn = () => frame.evaluate(() => {
    const b = Array.from(document.querySelectorAll("[title]")).find((e) => /undo/i.test(e.getAttribute("title") || ""));
    return b ? (b.getAttribute("disabled") ? "disabled" : "enabled") : "none";
});
const box = async () => (await frame.$("text=Alpha")).boundingBox();
await frame.evaluate(() => { window.__t0 = Date.now(); window.__poll = []; });
const t0 = Date.now();
let b = await box();
await page.mouse.move(fr.x + b.x + b.width / 2, fr.y + b.y + b.height / 2);
await page.mouse.down();
await page.mouse.move(fr.x + b.x + b.width / 2 + 120, fr.y + b.y + b.height / 2 + 60, { steps: 10 });
await page.mouse.up();
const timeline = [];
for (let i = 0; i < 20; i++) {
    timeline.push(`${Date.now() - t0}ms:${await btn()}`);
    await page.waitForTimeout(150);
}
console.log("撤销按钮时间线: " + timeline.join(" "));
console.log("事件时间线: " + JSON.stringify(await page.evaluate(() => window.__msgs.map((m) => m.ev + "@" + (Date.now() - window.__msgs[0].t) + "ms"))));
const after = await box();
console.log("Alpha 是否真的移动了: " + (Math.round(after.x - b.x)));
await browser.close();
