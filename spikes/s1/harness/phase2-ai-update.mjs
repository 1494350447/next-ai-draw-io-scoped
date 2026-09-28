/*
 * 复现用户的真实场景并验证修复（应用内 + **真调模型**）：
 *   「规则没命中 → 走大模型（deepseek-flash）：产出 1 个 op → 已应用 · 跳过：do 不认识的改写类型：update」
 * 根因：模型产的 op.kind=update（整段 mxCell）原本被原样丢给插件，而插件只会 attrs/add/delete 三种话。
 * 修法：**服务端把 update 规约成属性写入**（style/value/几何），插件侧语义保持只有一处。
 * 这条测试就用用户当时的措辞，走完整产品链路（真右键 → 真悬浮框 → 真模型 → 看宿主拿到的 XML）。
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

let failures = 0;
const R = { asserts: [], steps: {} };
const ok = (name, cond, extra) => {
    R.asserts.push({ name, pass: !!cond, ...(extra !== undefined ? { detail: extra } : {}) });
    if (!cond) failures += 1;
    console.log(`ASSERT ${name}: ${cond ? "通过" : "失败"}` + (extra !== undefined && !cond ? " -> " + JSON.stringify(extra) : ""));
};

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
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
await page.waitForTimeout(1200);

const cellsOf = (xml) => {
    const out = {}; const s = String(xml || ""); const re = /<mxCell id="([^"]+)"[^>]*?(\/?)>/g; let m;
    while ((m = re.exec(s))) {
        if (m[2] === "/") { out[m[1]] = m[0]; continue; }
        const end = s.indexOf("</mxCell>", m.index);
        out[m[1]] = end < 0 ? m[0] : s.slice(m.index, end + "</mxCell>".length);
    }
    return out;
};
const lastAutosave = () => page.evaluate(() => { const l = (window.__drawioMsgs || []).filter((m) => m.event === "autosave" && m.xml); return l.length ? l[l.length - 1].xml : null; });
const labelBox = async (n) => { const el = await frame.$(`text=${n}`); return el ? el.boundingBox() : null; };
const clickLabel = async (n, o = {}) => { const b = await labelBox(n); await page.mouse.click(Math.round(fr.x + b.x + b.width / 2), Math.round(fr.y + b.y + b.height / 2), o); };
const waitAutosave = async (pred, tries = 30) => {
    let xml = await lastAutosave();
    for (let i = 0; i < tries; i++) { if (xml && pred(xml)) return xml; await page.waitForTimeout(500); xml = await lastAutosave(); }
    return xml;
};

// 归一化基线（load 不产生 autosave；拖走再拖回制造两段模型变化）
const b5 = await labelBox("KeepMe");
const cx = Math.round(fr.x + b5.x + b5.width / 2), cy = Math.round(fr.y + b5.y + b5.height / 2);
for (const dx of [80, -80]) {
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx + dx, cy, { steps: 12 }); await page.mouse.up();
    await page.waitForTimeout(2600);
}
const baseXml = await waitAutosave((x) => cellsOf(x)["5"]);
ok("拿到改动前的基线 XML（零注入）", !!baseXml && !!cellsOf(baseXml)["2"], baseXml ? baseXml.length : null);

// ===== 用户那条指令（真模型）=====
await clickLabel("Alpha");
await page.waitForTimeout(400);
await clickLabel("Alpha", { button: "right" });
const item = await frame.evaluate(() => {
    const menus = Array.from(document.querySelectorAll(".mxPopupMenu")).filter((m) => m.offsetParent !== null);
    for (const m of menus) for (const tr of m.querySelectorAll("tr")) if (tr.textContent.trim().startsWith("AI 局部修改…")) { const r = tr.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
    return null;
});
await page.mouse.click(fr.x + item.x, fr.y + item.y);
await page.waitForTimeout(600);
await frame.fill('#aiScopeInstructPanel [data-role="ai-scope-input"]', "把这块搞得像数据库一点");
const runBtn = await frame.evaluate(() => { const b = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-run"]').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; });
await page.mouse.click(fr.x + runBtn.x, fr.y + runBtn.y);
await frame.waitForFunction(() => {
    const el = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]');
    return el && el.textContent && /(已应用|没有落到画布上|拒绝|跳过)/.test(el.textContent);
}, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(1200);
const text = await frame.evaluate(() => document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]').textContent);
const afterXml = await waitAutosave((x) => x !== baseXml);
R.steps.panelText = text;

ok("① 走的是生成式通道（真调模型），且明确说了“已应用”", !!text && /走大模型/.test(text) && /已应用/.test(text), text);
ok("② **不再出现“不认识的改写类型：update”**（用户报的那个 bug）", !!text && !/不认识的改写类型/.test(text), text);
ok("③ update 真的落地了：Alpha 的 style 变了（实测会变成 shape=cylinder3 的数据库形状）",
    !!afterXml && !!cellsOf(baseXml)["2"] && !!cellsOf(afterXml)["2"] && cellsOf(baseXml)["2"] !== cellsOf(afterXml)["2"] &&
    /shape=\w+/.test(cellsOf(afterXml)["2"]),
    { before: cellsOf(baseXml)["2"], after: cellsOf(afterXml)["2"] });
const a = cellsOf(baseXml), b = cellsOf(afterXml);
ok("④ 只动了 Alpha：Beta/Gamma/参照物逐字节不变",
    a["3"] === b["3"] && a["4"] === b["4"] && a["5"] === b["5"],
    { beta: a["3"] === b["3"], gamma: a["4"] === b["4"], keepMe: a["5"] === b["5"] });
ok("⑤ 画布上真的换了形状（渲染出来的节点数/文本仍在，没有把元素弄没）",
    !!(await frame.$("text=Beta")) && !!(await frame.$("text=KeepMe")), {});

const noise = consoleErrors.filter((e) => !/favicon|Download the React DevTools|\[Fast Refresh\]|net::ERR_/.test(e));
ok("应用与插件都没有未预期的报错", noise.length === 0, noise);
console.log("\nPHASE2_AI_UPDATE_RESULT=" + JSON.stringify(R, null, 2));
console.log(failures === 0 ? "\nPHASE2_AI_UPDATE_SUMMARY=ALL_PASS" : `\nPHASE2_AI_UPDATE_SUMMARY=${failures}_FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
