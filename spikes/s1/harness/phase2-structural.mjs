/*
 * Phase 2 第四小步（应用内）：**结构性改动 —— 增删元素**（③ 的第一版：只做"选中后局部增删"）。
 *
 * 走的是产品的真实链路：真鼠标选区 → 真右键「AI 局部修改…」→ 悬浮框输入 → 执行 → 只动选中的元素。
 * 断言全在**宿主收到的 autosave XML**（上游 React 状态的来源）与真实渲染上，不看插件自述。
 *
 * 两轮：
 *   ① "删掉选中的"  → 选中的没了、**它们的连线也一起走**（drawio 语义）、别的元素逐字节不变；
 *   ② "在旁边加一个同色圆角框" → 新元素出现、样式/尺寸抄选区、位置在选区右侧、别的元素逐字节不变。
 */
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const APP = process.env.APP_URL || "http://127.0.0.1:3000/";
const SHOTS = process.env.SHOT_DIR || "/work/results/shots";

const FIXTURE = {
    2: { name: "Alpha", x: 120, y: 120, w: 160, h: 70, style: "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;" },
    3: { name: "Beta", x: 420, y: 240, w: 200, h: 90, style: "rounded=1;whiteSpace=wrap;html=1;" },
    4: { name: "Gamma", x: 160, y: 420, w: 180, h: 60, style: "rounded=1;whiteSpace=wrap;html=1;" },
    5: { name: "KeepMe", x: 600, y: 520, w: 140, h: 60, style: "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;" },
};
const MXFILE = '<mxfile host="app.diagrams.net"><diagram name="Page-1">' +
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="240" width="200" height="90" as="geometry"/></mxCell>' +
    '<mxCell id="6" value="" style="endArrow=classic;html=1;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    '<mxCell id="4" value="Gamma" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="160" y="420" width="180" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="5" value="KeepMe" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;" vertex="1" parent="1"><mxGeometry x="600" y="520" width="140" height="60" as="geometry"/></mxCell>' +
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
const seed = () => page.evaluate((xml) => {
    const f = Array.from(document.querySelectorAll("iframe")).find((i) => (i.src || "").includes("8080"));
    if (!f) return false;
    f.contentWindow.postMessage(JSON.stringify({ action: "load", xml, autosave: true }), "*");
    return true;
}, MXFILE);
await seed();
await frame.waitForSelector("text=Alpha", { timeout: 20000 }).catch(() => {});
if (!(await frame.$("text=Alpha"))) { await seed(); await frame.waitForSelector("text=Alpha", { timeout: 20000 }); }
await page.waitForTimeout(1200);

const lastAutosave = () => page.evaluate(() => { const l = (window.__drawioMsgs || []).filter((m) => m.event === "autosave" && m.xml); return l.length ? l[l.length - 1].xml : null; });
const cellOf = (xml, id) => { const m = new RegExp(`<mxCell id="${id}"[\\s\\S]*?</mxCell>`).exec(xml || ""); return m ? m[0] : null; };
/**
 * 按 id 拆出每个 cell 的片段（含自闭合的 <mxCell id="0" />）。
 * 为什么要这样比：**删除**会让两边的 cell 数量不同，早先那种"用占位符替换再整体比较"的做法必然不等 ——
 * 而且比较的是"文本位置"，不如"每个 cell 自己有没有变"来得准。
 */
const cellsOf = (xml) => {
    const out = {};
    const s = String(xml || "");
    const re = /<mxCell id="([^"]+)"[^>]*?(\/?)>/g;
    let m;
    while ((m = re.exec(s))) {
        if (m[2] === "/") { out[m[1]] = m[0]; continue; }
        const end = s.indexOf("</mxCell>", m.index);
        out[m[1]] = end < 0 ? m[0] : s.slice(m.index, end + "</mxCell>".length);
    }
    return out;
};
/** 除了 ids 这几个"允许变化"的，两边其余 cell 必须逐字节一致 */
const compareExcept = (base, after, ids) => {
    const a = cellsOf(base), b = cellsOf(after);
    return {
        onlyInBase: Object.keys(a).filter((id) => !b[id] && !ids.includes(id)),
        changed: Object.keys(b).filter((id) => a[id] && a[id] !== b[id] && !ids.includes(id)),
        added: Object.keys(b).filter((id) => !a[id] && !ids.includes(id)),
        removedAllowed: ids.filter((id) => a[id] && !b[id]),
    };
};
const labelBox = async (n) => { const el = await frame.$(`text=${n}`); return el ? el.boundingBox() : null; };
const clickLabel = async (n, o = {}) => { const b = await labelBox(n); await page.mouse.click(Math.round(fr.x + b.x + b.width / 2), Math.round(fr.y + b.y + b.height / 2), o); };
const dragBy = async (id, dx, dy) => {
    const b = await labelBox(FIXTURE[id].name);
    const cx = Math.round(fr.x + b.x + b.width / 2), cy = Math.round(fr.y + b.y + b.height / 2);
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 12 }); await page.mouse.up();
    await page.waitForTimeout(2600);
};
const waitAutosave = async (pred, tries = 25) => {
    let xml = await lastAutosave();
    for (let i = 0; i < tries; i++) { if (xml && pred(xml)) return xml; await page.waitForTimeout(400); xml = await lastAutosave(); }
    return xml;
};
const openInstruct = async () => {
    await clickLabel("Alpha", { button: "right" });
    const item = await frame.evaluate(() => {
        const menus = Array.from(document.querySelectorAll(".mxPopupMenu")).filter((m) => m.offsetParent !== null);
        for (const m of menus) for (const tr of m.querySelectorAll("tr")) if (tr.textContent.trim().startsWith("AI 局部修改…")) { const r = tr.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
        return null;
    });
    await page.mouse.click(fr.x + item.x, fr.y + item.y);
    await page.waitForTimeout(600);
};
const run = async (text) => {
    await frame.fill('#aiScopeInstructPanel [data-role="ai-scope-input"]', text);
    const b = await frame.evaluate(() => { const el = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-run"]'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
    await page.mouse.click(fr.x + b.x, fr.y + b.y);
    await frame.waitForFunction(() => { const el = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]'); return el && /已应用|跳过|拒绝|没有/.test(el.textContent || ""); }, null, { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(900);
    return frame.evaluate(() => document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]').textContent);
};
// 归一化基线：拖走→拖回（load 不产生 autosave，应用内又不能用撤销）
await dragBy(5, 80, 0); await dragBy(5, -80, 0);
const baseXml = await waitAutosave((x) => cellOf(x, "5"));
ok("拿到改动前的基线 XML（拖走再拖回，零注入）", !!baseXml && !!cellOf(baseXml, "2"), baseXml ? baseXml.length : null);

// ===== 第一轮：删除 =====
await clickLabel("Alpha");
await page.keyboard.down("Shift"); await clickLabel("Beta"); await page.keyboard.up("Shift");
await page.waitForTimeout(400);
await openInstruct();
const delText = await run("删掉选中的");
const afterDel = await waitAutosave((x) => !cellOf(x, "2"));
R.steps.delText = delText;
R.steps.afterDel = afterDel;
ok("① 删除走了确定性通道，文案说清删了几个", !!delText && /走确定性规则/.test(delText) && /已应用/.test(delText) && /删除 2 个/.test(delText), delText);
if (baseXml && afterDel) {
    ok("② 选中的 Alpha/Beta 真的从图里没了", !cellOf(afterDel, "2") && !cellOf(afterDel, "3"), { has2: !!cellOf(afterDel, "2"), has3: !!cellOf(afterDel, "3") });
    ok("③ 它们的连线也一起走了（drawio 的删除语义：删元素连带它的边）", !!cellOf(baseXml, "6") && !cellOf(afterDel, "6"), { before: !!cellOf(baseXml, "6"), after: !!cellOf(afterDel, "6") });
    const cmpDel = compareExcept(baseXml, afterDel, ["2", "3", "6"]);
    R.steps.compareDelete = cmpDel;
    ok("④ 除了被删的 2/3/6，其余元素逐字节不变（没有顺带改动别人）",
        cmpDel.onlyInBase.length === 0 && cmpDel.changed.length === 0 && cmpDel.added.length === 0,
        cmpDel);
    ok("⑤ 画布上 Alpha/Beta 的标签也没了（用户看到的一致）", !(await frame.$("text=Alpha")) && !(await frame.$("text=Beta")), {});
} else {
    ok("拿到删除前后的两份 XML", false, { base: !!baseXml, after: !!afterDel });
}
await clickLabel("Gamma", { button: "right" });   // 关掉面板（点别处）
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

// ===== 第二轮：新增（先重新塞图，回到原始状态）=====
await seed();
await page.waitForTimeout(2500);
await dragBy(5, 80, 0); await dragBy(5, -80, 0);
const base2 = await waitAutosave((x) => cellOf(x, "2") && cellOf(x, "3"));
ok("第二轮基线就绪（图已恢复原样）", !!base2 && !!cellOf(base2, "6"), base2 ? base2.length : null);
await clickLabel("Alpha");
await page.waitForTimeout(400);
await openInstruct();
const addText = await run("在旁边加一个同色圆角框");
const afterAdd = await waitAutosave((x) => x !== base2 && /value="新建"/.test(x || ""));
R.steps.addText = addText;
R.steps.afterAdd = afterAdd;
ok("⑥ 新增走了确定性通道，文案说清新增了几个", !!addText && /走确定性规则/.test(addText) && /已应用/.test(addText) && /新增 1 个/.test(addText), addText);
if (base2 && afterAdd) {
    const ids = (xml) => [...String(xml).matchAll(/<mxCell id="([^"]+)"/g)].map((m) => m[1]);
    const fresh = ids(afterAdd).filter((id) => !ids(base2).includes(id));
    R.steps.newIds = fresh;
    ok("⑦ 图里多出且只多出一个元素，id 是服务端给的那一个（审计能对上）", fresh.length === 1 && /^ai-add-\d+$/.test(fresh[0]), fresh);
    const frag = fresh.length ? cellOf(afterAdd, fresh[0]) : null;
    ok("⑧ 新元素的样式/尺寸抄的是选中的那个（同色 160x70），父容器是图层",
        !!frag && /fillColor=#dae8fc/.test(frag) && /width="160"/.test(frag) && /height="70"/.test(frag) && /parent="1"/.test(frag),
        frag);
    ok("⑨ 新元素的位置在选区右侧（Alpha 右边距 120+160=280 之外）",
        !!frag && Number((/<mxGeometry[^>]*?\sx="([^"]+)"/.exec(frag) || [])[1]) >= 280, frag);
    const cmpAdd = compareExcept(base2, afterAdd, fresh);
    R.steps.compareAdd = cmpAdd;
    ok("⑩ 除了新加的那一个，别的元素逐字节不变（没有顺带改动别人）",
        cmpAdd.onlyInBase.length === 0 && cmpAdd.changed.length === 0 && cmpAdd.added.length === 0,
        cmpAdd);
    ok("⑪ 画布上真的渲染出了新元素（用户看得见）", !!(await frame.$("text=新建")), {});
} else {
    ok("拿到新增前后的两份 XML", false, { base: !!base2, after: !!afterAdd });
}
await page.screenshot({ path: `${SHOTS}/p2-6-structural.png` });

const noise = consoleErrors.filter((e) => !/favicon|Download the React DevTools|\[Fast Refresh\]|net::ERR_/.test(e));
R.unexpectedErrors = noise;
ok("应用与插件都没有未预期的报错", noise.length === 0, noise);
console.log("\nPHASE2_STRUCT_RESULT=" + JSON.stringify(R, null, 2));
console.log(failures === 0 ? "\nPHASE2_STRUCT_SUMMARY=ALL_PASS" : `\nPHASE2_STRUCT_SUMMARY=${failures}_FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
