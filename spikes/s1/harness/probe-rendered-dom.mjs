/* 探针：应用内 iframe 里，"某个 cell 已被渲染"能用什么 DOM 判据（给回归断言找锚点）。 */
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const APP = process.env.APP_URL || "http://127.0.0.1:3000/";
const MXFILE = '<mxfile host="app.diagrams.net"><diagram name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector('iframe[src*="8080"]', { timeout: 60000 });
const frameEl = await page.$('iframe[src*="8080"]');
const frame = await frameEl.contentFrame();
await page.waitForTimeout(4000);
await page.evaluate((xml) => { const f = Array.from(document.querySelectorAll("iframe")).find((i) => (i.src || "").includes("8080")); f.contentWindow.postMessage(JSON.stringify({ action: "load", xml, autosave: true }), "*"); }, MXFILE);
await frame.waitForSelector("text=Alpha", { timeout: 20000 });
const r = await frame.evaluate(() => {
    const out = {};
    out.dataCellIdCount = document.querySelectorAll("[data-cell-id]").length;
    out.dataCellIdValues = Array.from(document.querySelectorAll("[data-cell-id]")).slice(0, 5).map((e) => e.getAttribute("data-cell-id"));
    const el = Array.from(document.querySelectorAll("text, span, div")).find((e) => (e.textContent || "").trim() === "Alpha");
    const chain = [];
    let n = el;
    while (n && chain.length < 6) { chain.push(n.tagName + (n.getAttribute && n.getAttribute("data-cell-id") ? "[data-cell-id=" + n.getAttribute("data-cell-id") + "]" : "")); n = n.parentElement; }
    out.chainFromLabel = chain;
    return out;
});
console.log("PROBE_RENDERED_DOM=" + JSON.stringify(r, null, 2));
await browser.close();
