/*
 * Phase 2 第一小步（应用内）：在**真实产品页面**（next-ai-draw-io :3000）里跑同一条链路。
 *
 * 与 phase2-instruct.mjs 的分工：
 *   · standalone 那条测的是插件与服务的完整链路（有 aiScopeDebug=1，能直接读模型）；
 *   · 这条测的是**产品形态**：drawio 被应用框在跨源 iframe 里、没有调试开关，
 *     CSP / 跨源 fetch / 插件注入都按生产的来。断言全部走黑盒：
 *       ① 悬浮框的文案（用户看到的）；
 *       ② autosave 回吐给宿主的 XML（**产品的真实数据面**，上游就是靠它同步 React 状态的）；
 *       ③ 渲染出来的标签位置（用户看到的画面）。
 * 塞图用的是 embed 协议自带的 load 消息（父页发出 → evt.source 校验才过），
 * 插件与上游都不需要为测试改动一行。
 */
import { chromium } from "playwright";

const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const APP = process.env.APP_URL || "http://127.0.0.1:3000/";
const ENDPOINT = process.env.AI_SCOPE_ENDPOINT || "http://127.0.0.1:8787";
const SHOTS = process.env.SHOT_DIR || "/work/results/shots";

// 三个待对齐的（宽度各不相同，用来证明"标签居中"不会骗人）+ 一个不该被碰的参照物
const FIXTURE = {
    2: { name: "Alpha", x: 120, y: 120, w: 160, h: 70, style: "rounded=1;whiteSpace=wrap;html=1;" },
    3: { name: "Beta", x: 420, y: 240, w: 200, h: 90, style: "rounded=1;whiteSpace=wrap;html=1;" },
    4: { name: "Gamma", x: 160, y: 420, w: 180, h: 60, style: "rounded=1;whiteSpace=wrap;html=1;" },
    5: { name: "KeepMe", x: 600, y: 520, w: 140, h: 60, style: "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;" },
};
const cellXml = (id) => {
    const f = FIXTURE[id];
    return `<mxCell id="${id}" value="${f.name}" style="${f.style}" vertex="1" parent="1">` +
        `<mxGeometry x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" as="geometry"/></mxCell>`;
};
const MXFILE = '<mxfile host="app.diagrams.net"><diagram name="Page-1">' +
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    Object.keys(FIXTURE).map(cellXml).join("") +
    "</root></mxGraphModel></diagram></mxfile>";

const R = { app: APP, endpoint: ENDPOINT, asserts: [], steps: {} };
let failures = 0;
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
const calls = [];
page.on("request", (r) => { if (r.url().includes("/api/instruct")) calls.push(r.method() + " " + r.url()); });

// 宿主侧抓 drawio 发给页面的消息：autosave 里带的是完整 XML，正是 React 状态的数据来源
await page.addInitScript(() => {
    window.__drawioMsgs = [];
    window.addEventListener("message", (e) => {
        let m = null;
        try { m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch (_) { return; }
        if (m && m.event) window.__drawioMsgs.push(m);
    });
});
await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector('iframe[src*="8080"]', { timeout: 60000 });
const frameEl = await page.$('iframe[src*="8080"]');
const src = await frameEl.getAttribute("src");
const frame = await frameEl.contentFrame();
R.steps.iframeSrc = src;
ok("应用把自托管 drawio 框在 iframe 里（真是产品形态：跨源 + embed）", /8080/.test(src) && /embed=1/.test(src), src);

// 塞图：embed 的 load 消息。autosave:true 是**必须**的 —— 宿主的画布状态同步就靠它，
// 漏了这个开关，drawio 就不再往宿主回吐 XML，产品层面等于"聊天的上下文永远停在旧图"。
const seed = () => page.evaluate((xml) => {
    const f = Array.from(document.querySelectorAll("iframe")).find((i) => (i.src || "").includes("8080"));
    if (!f) return false;
    f.contentWindow.postMessage(JSON.stringify({ action: "load", xml, autosave: true }), "*");
    return true;
}, MXFILE);
await page.waitForTimeout(4000);
await seed();
await frame.waitForSelector("text=Alpha", { timeout: 20000 }).catch(() => {});
if (!(await frame.$("text=Alpha"))) { await seed(); await frame.waitForSelector("text=Alpha", { timeout: 20000 }); }
ok("通过 embed 的 load 消息把测试图塞进了应用的画布", !!(await frame.$("text=Alpha")));

const lastAutosave = () => page.evaluate(() => {
    const list = (window.__drawioMsgs || []).filter((m) => m.event === "autosave" && m.xml);
    return list.length ? list[list.length - 1].xml : null;
});
// XML 工具：drawio 规范化后的 cell 片段。注意 x=" 是 vertex="1" 的后缀，
// 所以匹配几何属性必须限定在 <mxGeometry …> 里（朴素正则会先命中 vertex 的尾巴）。
const cellOf = (xml, id) => {
    const m = new RegExp(`<mxCell id="${id}"[\\s\\S]*?</mxCell>`).exec(xml);
    return m ? m[0] : null;
};
const geomX = (cellStr) => { const m = /<mxGeometry[^>]*?\sx="([^"]+)"/.exec(cellStr || ""); return m ? m[1] : null; };
const stripX = (t) => t.replace(/(<mxGeometry[^>]*?\s)x="[^"]+"/, "$1");
const strip = (xml, ids) => ids.reduce((acc, id) => acc.split(cellOf(xml, id)).join("/*removed*/"), xml);

const labelBox = async (name) => {
    const el = await frame.$(`text=${name}`);
    return el ? el.boundingBox() : null;
};
// 标签是**居中**在形状里的，所以形状左边缘 = 标签中心 - 画布上的形状宽度/2。
// 宽度用 fixture 里自己的值（不是猜 drawio 的变换），缩放为 1 时按屏幕像素算即可。
const shapeLeft = async (id) => {
    const b = await labelBox(FIXTURE[id].name);
    return b ? b.x + b.width / 2 - FIXTURE[id].w / 2 : null;
};
const shapeCenterY = async (id) => {
    const b = await labelBox(FIXTURE[id].name);
    return b ? b.y + b.height / 2 : null;
};

// 基线 XML 的取法：load 不产生 autosave（load 分支里 ignoreChange=true，监听器也是那次 load 末尾才装上的），
// 所以"再 load 一次"拿不到基线；应用内又不能用撤销（下面的 FINDING，纯手动拖拽也一样）。
// 于是用**真实鼠标把参照物拖走、再拖回原位**制造两段模型变化 ——
// 第二段结束时的 XML 就是"还没对齐"的规范化基线，而且全程没有任何注入。
const dragBy = async (id, dx, dy) => {
    const b = await labelBox(FIXTURE[id].name);
    await page.mouse.move(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
    await page.mouse.down();
    await page.mouse.move(Math.round(b.x + b.width / 2) + dx, Math.round(b.y + b.height / 2) + dy, { steps: 12 });
    await page.mouse.up();
    // 等够：画布变更后应用侧会再把图 load 回 drawio（实测 ~1.2s），撞在这次加载上会丢掉下一次拖拽
    await page.waitForTimeout(2600);
};
await page.waitForTimeout(1200);
const beforeLefts = { 2: await shapeLeft(2), 3: await shapeLeft(3), 4: await shapeLeft(4), 5: await shapeLeft(5) };
const beforeY = { 3: await shapeCenterY(3), 4: await shapeCenterY(4), 5: await shapeCenterY(5) };
R.steps.beforeLefts = beforeLefts;

await dragBy(5, 80, 0);
await dragBy(5, -80, 0);
let baseXml = null;
for (let i = 0; i < 20 && !baseXml; i++) { await page.waitForTimeout(400); baseXml = await lastAutosave(); }
R.steps.baseXml = baseXml;
const bx5 = baseXml ? geomX(cellOf(baseXml, "5")) : null;
ok("拿到了编辑前的基线 XML（拖走再拖回，参照物回到原位；autosave 通道可用 = 画布同步没断）",
    !!baseXml && bx5 === "600", bx5);

// ===== 真实鼠标：点选 + Shift 加选 → 右键 → 菜单项 =====
const clickLabel = async (name, opts = {}) => {
    const b = await labelBox(name);
    await page.mouse.click(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2), opts);
};
await clickLabel("Alpha");
await page.keyboard.down("Shift");
await clickLabel("Beta");
await clickLabel("Gamma");
await page.keyboard.up("Shift");
await page.waitForTimeout(400);
await clickLabel("Alpha", { button: "right" });
await page.waitForTimeout(900);
const menuHit = await frame.evaluate(() => {
    const menus = Array.from(document.querySelectorAll(".mxPopupMenu")).filter((m) => m.offsetParent !== null);
    for (const m of menus) for (const tr of m.querySelectorAll("tr")) {
        if (tr.textContent.trim().indexOf("AI 局部修改") >= 0) {
            const r = tr.getBoundingClientRect();
            return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
    }
    return { found: false };
});
R.steps.menu = menuHit;
ok("应用内右键菜单里有「AI 局部修改…」（插件在应用的 iframe 里加载成功）", menuHit.found, menuHit);
if (!menuHit.found) {
    console.log("\nPHASE2_APP_RESULT=" + JSON.stringify(R, null, 2));
    await browser.close();
    process.exit(1);
}

const fr = await frameEl.boundingBox();
await page.mouse.click(fr.x + menuHit.x, fr.y + menuHit.y);
await page.waitForTimeout(700);
const panelText = await frame.evaluate(() => {
    const el = document.getElementById("aiScopeInstructPanel");
    return el ? el.textContent : null;
});
R.steps.panelText = panelText;
ok("悬浮指令框出现在 iframe 内部，且写着已选 3 个", !!panelText && /已选 3 个元素/.test(panelText), panelText);

// ===== 输入 + 执行 =====
await frame.fill('#aiScopeInstructPanel [data-role="ai-scope-input"]', "左对齐");
const runBtn = await frame.evaluate(() => {
    const b = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-run"]').getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
});
await page.mouse.click(fr.x + runBtn.x, fr.y + runBtn.y);
await frame.waitForFunction(() => {
    const el = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]');
    return el && el.textContent && el.textContent.indexOf("已应用") >= 0;
}, null, { timeout: 25000 }).catch(() => {});
await page.waitForTimeout(800);

const resultText = await frame.evaluate(() => {
    const el = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]');
    return el ? el.textContent : null;
});
let afterXml = null;
for (let i = 0; i < 20 && !afterXml; i++) { await page.waitForTimeout(500); afterXml = await lastAutosave(); }
R.steps.result = resultText;
R.steps.afterXml = afterXml;
R.steps.serverCalls = calls;
await page.screenshot({ path: `${SHOTS}/p2-3-in-app.png` });

// FINDING（不是断言，是实测记录）：应用内 drawio 自带的撤销**用不了**，而且与插件无关 ——
// 纯手动拖一个元素之后，撤销按钮只有约 1.2s 是亮的，随后就变灰；Ctrl+Z 也无效。
// 对照：同一套操作在 standalone 画布上撤销完全正常（见 results/probe-undo-ab 的输出）。
// 机制（实测）：画布一改，应用侧会立刻把图再 load 回 drawio，而 embed 的 load 会重置撤销栈。
const undoProbe = await frame.evaluate(() => {
    const b = Array.from(document.querySelectorAll("[title]")).find((e) => /undo/i.test(e.getAttribute("title") || ""));
    return b ? { disabled: !!b.getAttribute("disabled"), opacity: getComputedStyle(b).opacity } : null;
});
R.steps.undoInApp = undoProbe;
R.steps.eventsAtEnd = await page.evaluate(() => (window.__drawioMsgs || []).map((m) => m.event));

ok("应用内也真的把指令发给了局部编辑服务（跨源 POST 成功）", calls.some((c) => c.startsWith("POST") && c.includes(ENDPOINT + "/api/instruct")), calls);
ok("通知文案：走确定性规则 + 没有调用模型", !!resultText && /走确定性规则/.test(resultText) && /没有调用模型/.test(resultText), resultText);

// ===== 数据面断言：宿主收到的 XML（上游 React 状态就是从这来的）=====
ok("拿到了编辑后的 XML（autosave 通道可用 = 画布同步没断）", !!afterXml && afterXml.includes('value="Alpha"'), afterXml ? afterXml.length : 0);
if (baseXml && afterXml) {
    ok("① 没被选中的元素一个字节都没动（去掉 2/3/4 后，编辑前后逐字节相同）",
        strip(baseXml, ["2", "3", "4"]) === strip(afterXml, ["2", "3", "4"]),
        { base: strip(baseXml, ["2", "3", "4"]).slice(0, 140), after: strip(afterXml, ["2", "3", "4"]).slice(0, 140) });
    ok("② 参照物 KeepMe 的 XML 逐字节相同", cellOf(baseXml, "5") === cellOf(afterXml, "5"), { base: cellOf(baseXml, "5"), after: cellOf(afterXml, "5") });
    const diffX = (id) => {
        const b = cellOf(baseXml, id), a = cellOf(afterXml, id);
        if (!b || !a) return { id, ok: false, why: "缺 cell" };
        return { id, ok: stripX(b) === stripX(a), from: geomX(b), to: geomX(a) };
    };
    const d2 = diffX("2"), d3 = diffX("3"), d4 = diffX("4");
    R.steps.xOnly = { d2, d3, d4 };
    ok("③ Beta/Gamma 只有 x 变了（其它属性逐字节相同），X 从 420/160 变成 120",
        d3.ok && d4.ok && d3.from === "420" && d3.to === "120" && d4.from === "160" && d4.to === "120", { d3, d4 });
    ok("④ Alpha 本来就最左：它的 XML 一个字节都没变（没做无谓写入）", d2.ok && d2.from === d2.to, d2);
} else {
    ok("拿到两份可对比的 XML", false, { base: !!baseXml, after: !!afterXml });
}

// ===== 画面断言：用户眼睛看到的 =====
const afterLefts = { 2: await shapeLeft(2), 3: await shapeLeft(3), 4: await shapeLeft(4), 5: await shapeLeft(5) };
const afterY = { 3: await shapeCenterY(3), 4: await shapeCenterY(4), 5: await shapeCenterY(5) };
R.steps.afterLefts = afterLefts;
R.steps.afterY = afterY;
const near = (a, b) => Math.abs(a - b) <= 1.5;
ok("⑤ 画面上三个元素的左边缘对齐到同一个 x",
    near(afterLefts[2], afterLefts[3]) && near(afterLefts[3], afterLefts[4]),
    { lefts: afterLefts });
ok("⑥ 画面上只横向移动：Beta/Gamma 的竖直中心没变",
    near(afterY[3], beforeY[3]) && near(afterY[4], beforeY[4]),
    { BetaY: [beforeY[3], afterY[3]], GammaY: [beforeY[4], afterY[4]] });
ok("⑦ 参照物在画面上也一动不动",
    near(afterLefts[5], beforeLefts[5]) && near(afterY[5], beforeY[5]),
    { x: [beforeLefts[5], afterLefts[5]], y: [beforeY[5], afterY[5]] });

const noise = consoleErrors.filter((e) => !/favicon|Download the React DevTools|\[Fast Refresh\]|net::ERR_/.test(e));
R.unexpectedErrors = noise;
ok("应用与插件都没有未预期的报错", noise.length === 0, noise);

console.log("\nPHASE2_APP_RESULT=" + JSON.stringify(R, null, 2));
console.log(failures === 0 ? "\nPHASE2_APP_SUMMARY=ALL_PASS" : `\nPHASE2_APP_SUMMARY=${failures}_FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
