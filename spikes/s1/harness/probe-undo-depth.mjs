/*
 * 机制级探针（应用内）：插件写回**到底有没有进 drawio 的撤销栈**？
 * 手段：走 embed 自带的 {action:'invokeAction'} 反向通道去调插件注册的 aiScopeProbe，
 * 它会把当前 undoDepth（撤销栈长度）回传成 {event:'aiScope'} 消息 —— 不靠按钮灰不灰去猜。
 * 对照：同一条通道下，**用户手动拖拽**之后 undoDepth 是多少（那是 drawio 自己的编辑路径）。
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

/** 用 embed 的反向通道问插件要一次快照（含 undoDepth / lastEditChanges） */
const probe = async (label) => {
    const before = await page.evaluate(() => (window.__drawioMsgs || []).length);
    await page.evaluate(() => {
        const f = Array.from(document.querySelectorAll("iframe")).find((i) => (i.src || "").includes("8080"));
        f.contentWindow.postMessage(JSON.stringify({ action: "invokeAction", actionName: "aiScopeProbe" }), "*");
    });
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(200);
        const got = await page.evaluate((n) => {
            const list = (window.__drawioMsgs || []).slice(n).filter((m) => m.event === "aiScope");
            return list.length ? list[list.length - 1] : null;
        }, before);
        if (got) return { label, undoDepth: got.undoDepth, reason: got.reason, count: got.count };
    }
    return { label, undoDepth: "TIMEOUT" };
};
const lastAutosave = () => page.evaluate(() => { const l = (window.__drawioMsgs || []).filter((m) => m.event === "autosave" && m.xml); return l.length ? l[l.length - 1].xml : null; });
const cellOf = (xml, id) => { const m = new RegExp(`<mxCell id="${id}"[\\s\\S]*?</mxCell>`).exec(xml || ""); return m ? m[0] : null; };
const geomX = (s) => { const m = /<mxGeometry[^>]*?\sx="([^"]+)"/.exec(s || ""); return m ? m[1] : null; };
const labelBox = async (n) => { const el = await frame.$(`text=${n}`); return el ? el.boundingBox() : null; };
const clickLabel = async (n, o = {}) => { const b = await labelBox(n); await page.mouse.click(Math.round(fr.x + b.x + b.width / 2), Math.round(fr.y + b.y + b.height / 2), o); };

// 给 iframe 里的 EditorUi.setFileData 打桩：看"谁在改动之后把图又 load 回来"（load 会清撤销栈）
const patchSetFileData = async () => frame.evaluate(() => {
    window.__sfd = window.__sfd || [];
    const P = window.EditorUi && window.EditorUi.prototype;
    if (P && !P.__patched) {
        const orig = P.setFileData;
        P.setFileData = function () { window.__sfd.push(new Date().toISOString()); return orig.apply(this, arguments); };
        P.__patched = true;
        return "patched";
    }
    return P ? "already" : "no EditorUi";
});
const sfd = async (label) => ({ label, calls: (await frame.evaluate(() => window.__sfd || [])).length });
console.log("SETFILEDATA_PATCH=" + await patchSetFileData());

const R = { probes: [], writes: [] };
R.sfd = [];
R.sfd.push(await sfd("打桩后（基线）"));
R.probes.push(await probe("① 刚 load 完（基线）"));

// ===== AI 写回 =====
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
await page.waitForTimeout(2000);
R.writes = await page.evaluate(() => (window.__drawioMsgs || []).filter((m) => m.event === "aiScopeWrite").map((m) => ({ action: m.action, undoDepthAfter: m.undoDepthAfter, lastEditChanges: m.lastEditChanges, ids: m.ids })));
R.probes.push(await probe("② AI 写回之后"));
R.sfd.push(await sfd("AI 写回之后"));
R.betaXAfterAI = geomX(cellOf(await lastAutosave(), "3"));

// ===== 手动拖拽（对照）=====
const dragBy = async (id, dx, dy) => {
    const b = await labelBox(FIXTURE[id].name);
    const cx = Math.round(fr.x + b.x + b.width / 2), cy = Math.round(fr.y + b.y + b.height / 2);
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 12 }); await page.mouse.up();
    await page.waitForTimeout(2600);
};
await dragBy(5, 0, 60);
R.sfd.push(await sfd("手动拖拽之前"));
R.probes.push(await probe("③ 手动拖拽之后（drawio 自己的编辑路径）"));
R.sfd.push(await sfd("手动拖拽之后"));
await page.mouse.click(fr.x + 900, fr.y + 700);
await page.keyboard.press("Control+z");
await page.waitForTimeout(2200);
R.probes.push(await probe("④ 手动拖拽后按 Ctrl+Z"));
const xmlAfterUndo = await lastAutosave();
R.keepMeYAfterUndo = (/<mxGeometry[^>]*?\sy="([^"]+)"/.exec(cellOf(xmlAfterUndo, "5")) || [])[1];
R.betaXAfterThatUndo = geomX(cellOf(xmlAfterUndo, "3"));
console.log("PROBE_UNDO_DEPTH=" + JSON.stringify(R, null, 2));
console.log("SETFILEDATA_CALLS=" + JSON.stringify(await frame.evaluate(() => window.__sfd || [])));
await browser.close();
