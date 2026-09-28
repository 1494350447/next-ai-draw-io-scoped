// A/B 取证：同一套"真实拖拽 + 撤销"，在 standalone 画布 vs 应用内 iframe 里各是什么行为。
// 目的：分清"撤销在应用里失效"到底是 (a) 插件/我的改动造成 (b) drawio embed 形态本身的既有行为。
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const MXFILE = '<mxfile host="app.diagrams.net"><diagram name="Page-1"><mxGraphModel dx="800" dy="600" page="1" pageWidth="850" pageHeight="1100"><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="3" value="Ref" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="420" width="160" height="70" as="geometry"/></mxCell>' +
    "</root></mxGraphModel></diagram></mxfile>";

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

async function scenario(name, { url, isApp }) {
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    let frame = page, fr = { x: 0, y: 0 };
    if (isApp) {
        await page.waitForSelector('iframe[src*="8080"]', { timeout: 60000 });
        const fe = await page.$('iframe[src*="8080"]');
        frame = await fe.contentFrame();
        fr = await fe.boundingBox();
        await page.waitForTimeout(4000);
        await page.evaluate((xml) => {
            const f = Array.from(document.querySelectorAll("iframe")).find((i) => (i.src || "").includes("8080"));
            f.contentWindow.postMessage(JSON.stringify({ action: "load", xml }), "*");
        }, MXFILE);
    } else {
        await page.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 45000 });
        await page.evaluate((xml) => window.__aiScope.ui.setFileData(xml), MXFILE);
    }
    await frame.waitForSelector("text=Alpha", { timeout: 20000 });
    await page.waitForTimeout(1200);

    const state = async () => frame.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("[title]")).find((e) => /undo/i.test(e.getAttribute("title") || ""));
        return {
            toolbarUndoDisabled: btn ? btn.getAttribute("disabled") : "no-button",
            toolbarUndoOpacity: btn ? getComputedStyle(btn).opacity : null,
            graphEnabled: window.__aiScope ? window.__aiScope.graph.isEnabled() : null,
            undoEnabled: window.__aiScope ? (window.__aiScope.ui.actions.get("undo").enabled ? (typeof window.__aiScope.ui.actions.get("undo").enabled === "function" ? window.__aiScope.ui.actions.get("undo").enabled() : window.__aiScope.ui.actions.get("undo").enabled) : null) : null,
            undoDepth: window.__aiScope ? window.__aiScope.undoDepth() : null,
        };
    });
    const box = async (t) => { const e = await frame.$(`text=${t}`); return e ? e.boundingBox() : null; };

    const before = { a: await box("Alpha"), r: await box("Ref"), st: await state() };
    // 真实拖拽 Alpha
    await page.mouse.move(fr.x + before.a.x + before.a.width / 2, fr.y + before.a.y + before.a.height / 2);
    await page.mouse.down();
    await page.mouse.move(fr.x + before.a.x + before.a.width / 2 + 120, fr.y + before.a.y + before.a.height / 2 + 60, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const afterDrag = { a: await box("Alpha"), r: await box("Ref"), st: await state() };

    // Ctrl+Z（先点空白画布）
    const canvas = await frame.evaluate(() => { const c = document.querySelector("#graphContainer") || document.querySelector("svg"); const r = c.getBoundingClientRect(); return { x: Math.round(r.right - 60), y: Math.round(r.bottom - 60) }; });
    await page.mouse.click(fr.x + canvas.x, fr.y + canvas.y);
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(1200);
    const afterUndo = { a: await box("Alpha"), r: await box("Ref"), st: await state() };

    const d = (p, q, k) => Math.round((q[k][k === "a" ? "x" : "x"] - p[k][k === "a" ? "x" : "x"]));
    console.log(`\n### ${name}`);
    console.log("  before :", JSON.stringify(before.st), "Alpha.x=", Math.round(before.a.x), "Ref.x=", Math.round(before.r.x));
    console.log("  拖拽后 :", JSON.stringify(afterDrag.st), "Alpha.x=", Math.round(afterDrag.a.x), "Ref.x=", Math.round(afterDrag.r.x), "→ Alpha 位移", Math.round(afterDrag.a.x - before.a.x), " Ref 位移", Math.round(afterDrag.r.x - before.r.x));
    console.log("  Ctrl+Z :", JSON.stringify(afterUndo.st), "Alpha.x=", Math.round(afterUndo.a.x), "→ 相对原值", Math.round(afterUndo.a.x - before.a.x));
    await page.close();
}

await scenario("A. standalone 画布（无 embed）", { url: "http://127.0.0.1:8080/?aiScopeDebug=1&ui=kennedy", isApp: false });
await scenario("B. 应用内 iframe（embed=1&proto=json）", { url: "http://127.0.0.1:3000/", isApp: true });
await browser.close();
