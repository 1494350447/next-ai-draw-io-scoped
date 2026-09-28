/*
 * Phase 2（应用内）：右键菜单里「AI 局部修改…」的**位置与配色**（产品要求：紧跟官方「删除」下面、绿色字体）。
 * 应用内黑盒：真鼠标右键 → 读菜单 DOM 的行序与计算样式 → 真点一次确认还能打开面板。
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
const R = { asserts: [] };
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
/** 读可见菜单的行序 + 关键行的颜色/灰态 */
const readMenu = async () => frame.evaluate(() => {
    const menus = Array.from(document.querySelectorAll(".mxPopupMenu")).filter((m) => m.offsetParent !== null);
    for (const m of menus) {
        const rows = Array.from(m.querySelectorAll("tr"));
        if (!rows.some((tr) => tr.textContent.trim().startsWith("AI 局部修改…"))) continue;
        return rows.map((tr, i) => {
            const td = tr.querySelector('td[align="left"]');
            const cs = td ? getComputedStyle(td) : null;
            return {
                i, text: tr.textContent.trim().slice(0, 30), title: tr.getAttribute("title"),
                color: cs ? cs.color : null, disabled: !!tr.querySelector("td.mxDisabled") || !!td && td.classList.contains("mxDisabled"),
                rect: (() => { const r = tr.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })(),
            };
        });
    }
    return null;
});

const SHOTS = process.env.SHOT_DIR || "/work/results/shots";

// ===== 选中一个元素后右键 =====
await clickLabel("Alpha", { button: "right" });
await page.waitForTimeout(800);
const rows = await readMenu();
await page.screenshot({ path: `${SHOTS}/p2-5-menu.png` });
R.rows = rows;
ok("右键菜单里能找到「AI 局部修改…」", !!rows, rows ? rows.length : null);
if (!rows) { console.log("\nPHASE2_MENU_RESULT=" + JSON.stringify(R, null, 2)); await browser.close(); process.exit(1); }
const aiRow = rows.find((r) => r.text.startsWith("AI 局部修改…"));
const delRow = rows.find((r) => /^delete$/i.test(String(r.title || "")) || /^Delete$/.test(r.text));
ok("① 菜单里能找到官方「删除」那一行（位置锚点）", !!delRow, delRow || rows.map((r) => [r.i, r.text, r.title]));
ok("② 「AI 局部修改…」紧跟在它下面（行序相邻）", !!delRow && aiRow.i === delRow.i + 1, { del: delRow && delRow.i, ai: aiRow && aiRow.i });
ok("③ 「AI 局部修改…」的字是绿色 (#1a7f37)", aiRow.color === "rgb(26, 127, 55)", aiRow.color);
ok("④ 官方「删除」还是红的（我们没把别人的配色改坏）", delRow.color === "rgb(255, 0, 0)", delRow.color);
// 「复原上一次改动」这条已按产品决策移除（见 DEPLOY.md / RESULT.md §5.9 的状态说明）——
// 这里用断言钉住"它不会偷偷回来"：菜单里 AI 相关行应当**有且只有一条**。
const aiRows = rows.filter((r) => r.text.startsWith("AI 局部修改"));
ok("④' 菜单里不再有「复原上一次改动」（功能已移除，且没有残留的 AI 菜单行）", aiRows.length === 1, aiRows.map((r) => r.text));

// 真点一次：改外观不能把功能改坏
await page.mouse.click(fr.x + aiRow.rect.x, fr.y + aiRow.rect.y);
await page.waitForTimeout(700);
const panelText = await frame.evaluate(() => { const el = document.getElementById("aiScopeInstructPanel"); return el ? el.textContent : null; });
ok("⑤ 点它还能正常打开悬浮框（外观改完功能没坏）", !!panelText && /已选 1 个元素/.test(panelText), panelText);
ok("⑤' 悬浮框里没有「复原上一次改动」（该功能已按产品决策移除）", !!panelText && !/复原/.test(panelText), panelText);
await frame.evaluate(() => { const b = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-close"]'); if (b) b.click(); });
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// ===== 空白处右键：没有选区时它是灰的 =====
const bA = await labelBox("Alpha");
const offX = (bA.x + bA.width / 2) - (FIXTURE[2].x + FIXTURE[2].w / 2);
const offY = (bA.y + bA.height / 2) - (FIXTURE[2].y + FIXTURE[2].h / 2);
await page.mouse.click(Math.round(fr.x + offX + 760), Math.round(fr.y + offY + 180), { button: "right" });
await page.waitForTimeout(800);
const rows2 = await readMenu();
if (rows2) {
    const ai2 = rows2.find((r) => r.text.startsWith("AI 局部修改…"));
    const del2 = rows2.find((r) => /^delete$/i.test(String(r.title || "")) || /^Delete$/.test(r.text));
    ok("⑥ 空白处右键（没有选中元素）：菜单项还在、但被置灰（mxDisabled）", !!ai2 && ai2.disabled === true, ai2);
    ok("⑦ 空白处右键：没有「删除」这一行（不参与锚点逻辑，不影响我们）", !del2, del2 || "无");
} else {
    ok("空白处右键也能打开菜单", false, null);
}

const noise = consoleErrors.filter((e) => !/favicon|Download the React DevTools|\[Fast Refresh\]|net::ERR_/.test(e));
ok("应用与插件都没有未预期的报错", noise.length === 0, noise);
console.log("\nPHASE2_MENU_RESULT=" + JSON.stringify(R, null, 2));
console.log(failures === 0 ? "\nPHASE2_MENU_SUMMARY=ALL_PASS" : `\nPHASE2_MENU_SUMMARY=${failures}_FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
