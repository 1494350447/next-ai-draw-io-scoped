/*
 * Phase 2 第一小步的端到端验证：真实 drawio 画布上的「选中 → 右键 → 悬浮指令框 → 执行 → 只改选中元素」。
 *
 * 全链路：插件读明文 XML → POST /api/instruct（服务端分流 + guard + 算出 writes）
 *         → 插件把 writes 落进当前模型（一次 beginUpdate = 一条撤销记录）。
 *
 * 关键：**不手算坐标**。要点的元素一律用"渲染出来的节点"的 boundingBox 定位（与原型里改用
 * getScreenCTM() 是同一条纪律）。鼠标事件全是真实事件，右键菜单、悬浮框都是真的。
 */
import { chromium } from "playwright";

const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const DRAWIO = process.env.DRAWIO_URL || "http://127.0.0.1:8080";
const ENDPOINT = process.env.AI_SCOPE_ENDPOINT || "http://127.0.0.1:8787";
const SHOTS = process.env.SHOT_DIR || "/work/results/shots";

// 3 个要对齐的 + 1 个不该被碰的（"只改选中元素"的证据）
const MXFILE =
    '<mxfile host="app.diagrams.net"><diagram name="Page-1">' +
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="240" width="200" height="90" as="geometry"/></mxCell>' +
    '<mxCell id="4" value="Gamma" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="160" y="420" width="180" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="5" value="别动我" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;" vertex="1" parent="1"><mxGeometry x="600" y="520" width="140" height="60" as="geometry"/></mxCell>' +
    "</root></mxGraphModel></diagram></mxfile>";

const R = { drawio: DRAWIO, endpoint: ENDPOINT, steps: {}, asserts: [], unexpectedErrors: [] };
let failures = 0;
const ok = (name, cond, extra) => {
    R.asserts.push({ name, pass: !!cond, ...(extra !== undefined ? { detail: extra } : {}) });
    if (!cond) failures += 1;
    console.log(`ASSERT ${name}: ${cond ? "通过" : "失败"}` + (extra !== undefined && !cond ? " -> " + JSON.stringify(extra) : ""));
};

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const serverCalls = [];
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push("[console] " + m.text()); });
page.on("request", (req) => {
    if (req.url().includes("/api/instruct")) serverCalls.push({ url: req.url(), method: req.method() });
});

await page.goto(`${DRAWIO}/?aiScopeDebug=1&ui=kennedy`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 45000 });
await page.evaluate((xml) => { window.__aiScope.ui.setFileData(xml); }, MXFILE);
await page.waitForTimeout(800);

const snapshot = () => page.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    const out = {};
    Object.keys(m.cells).forEach((id) => {
        const c = m.cells[id];
        if (!m.isVertex(c)) return;
        const geo = c.getGeometry();
        out[id] = { x: geo.x, y: geo.y, w: geo.width, h: geo.height, style: String(c.getStyle() || "") };
    });
    return {
        cells: out,
        selection: (g.getSelectionCells() || []).map((c) => c.getId()),
        undoDepth: window.__aiScope.undoDepth(),
        endpoint: window.__aiScope.endpoint(),
    };
});

const before = await snapshot();
R.steps.before = before;
ok("插件读到的端点是注入进来的那个", before.endpoint === ENDPOINT, { got: before.endpoint, want: ENDPOINT });
ok("画布上有 4 个元素（2/3/4 待对齐，5 是参照物）", ["2", "3", "4", "5"].every((id) => before.cells[id]));

// ===== 真实鼠标选区：左键点 2，Shift 加选 3、4 =====
const boxOf = async (id) => {
    const h = await page.evaluateHandle((cid) => {
        const g = window.__aiScope.graph;
        const st = g.view.getState(g.getModel().getCell(cid));
        return st && st.shape ? st.shape.node : null;
    }, id);
    return h.boundingBox();
};
const boxes = {};
for (const id of ["2", "3", "4", "5"]) boxes[id] = await boxOf(id);
const at = (b) => [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];

await page.mouse.click(...at(boxes["2"]));
await page.keyboard.down("Shift");
await page.mouse.click(...at(boxes["3"]));
await page.mouse.click(...at(boxes["4"]));
await page.keyboard.up("Shift");
await page.waitForTimeout(400);
const selected = await page.evaluate(() => (window.__aiScope.graph.getSelectionCells() || []).map((c) => c.getId()).sort());
R.steps.selectedByMouse = selected;
ok("真实鼠标（点 + Shift 加选）选中了 2/3/4", JSON.stringify(selected) === JSON.stringify(["2", "3", "4"]), selected);

// ===== 右键 → 菜单项 =====
await page.mouse.click(...at(boxes["2"]), { button: "right" });
await page.waitForTimeout(700);
const menu = await page.evaluate(() => {
    const menus = Array.from(document.querySelectorAll(".mxPopupMenu")).filter((m) => m.offsetParent !== null);
    const hit = [];
    menus.forEach((m) => m.querySelectorAll("tr").forEach((tr) => {
        const t = tr.textContent.trim();
        if (!t) return;
        const r = tr.getBoundingClientRect();
        hit.push({ text: t, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: tr.className.indexOf("mxPopupMenuDisabled") >= 0 });
    }));
    return {
        selection: (window.__aiScope.graph.getSelectionCells() || []).map((c) => c.getId()),
        item: hit.find((i) => i.text.indexOf("AI 局部修改") >= 0) || null,
        itemCount: hit.length,
    };
});
R.steps.menu = { selection: menu.selection, item: menu.item, itemCount: menu.itemCount };
ok("右键后多选被保留（不是只选中被点的那一个）", JSON.stringify(menu.selection) === JSON.stringify(["2", "3", "4"]), menu.selection);
ok("右键菜单里有「AI 局部修改…」且可点", !!menu.item && !menu.item.disabled, menu);
await page.screenshot({ path: `${SHOTS}/p2-1-menu.png` });

// ===== 点菜单项 → 悬浮指令框 =====
await page.mouse.click(menu.item.x, menu.item.y);
await page.waitForTimeout(600);
const panel = await page.evaluate(() => {
    const el = document.getElementById("aiScopeInstructPanel");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
        text: el.textContent,
        hasInput: !!el.querySelector('[data-role="ai-scope-input"]'),
        at: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) },
        inViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
    };
});
R.steps.panel = panel;
ok("点菜单后出现悬浮指令框，且标题写着已选个数", !!panel && panel.hasInput && /已选 3 个元素/.test(panel.text), panel);
ok("悬浮框完全落在视口内（没跑到屏幕外）", !!panel && panel.inViewport, panel && panel.at);

// ===== 输入指令 → 执行 =====
await page.fill('#aiScopeInstructPanel [data-role="ai-scope-input"]', "左对齐");
ok("输入框里打的内容没被 drawio 的快捷键吃掉", (await page.inputValue('#aiScopeInstructPanel [data-role="ai-scope-input"]')) === "左对齐");
const runBtn = await page.evaluate(() => {
    const b = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-run"]').getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
});
await page.mouse.click(runBtn.x, runBtn.y);
await page.waitForFunction(() => {
    const el = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]');
    return el && el.textContent && el.textContent.indexOf("已应用") >= 0;
}, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(400);

const after = await snapshot();
const resultText = await page.evaluate(() => {
    const el = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]');
    return el ? el.textContent : null;
});
R.steps.result = resultText;
R.steps.after = after;
R.steps.serverCalls = serverCalls;
await page.screenshot({ path: `${SHOTS}/p2-2-applied.png` });

ok("插件确实把指令发给了局部编辑服务（POST /api/instruct）", serverCalls.some((c) => c.method === "POST" && c.url === ENDPOINT + "/api/instruct"), serverCalls);
ok("通知文案说清走的哪条通道：确定性规则 + 没有调用模型", !!resultText && /走确定性规则：左对齐/.test(resultText) && /没有调用模型/.test(resultText), resultText);
ok("三个选中元素的 x 被对齐到同一个值（=最左的 120）",
    ["2", "3", "4"].every((id) => after.cells[id].x === 120), ["2", "3", "4"].map((id) => after.cells[id].x));
ok("对齐只动 x：y / 宽 / 高一个都没变",
    ["2", "3", "4"].every((id) => after.cells[id].y === before.cells[id].y && after.cells[id].w === before.cells[id].w && after.cells[id].h === before.cells[id].h),
    ["2", "3", "4"].map((id) => [before.cells[id].y, after.cells[id].y]));
ok("**没被选中的元素一个字节都没动**（几何 + 样式）",
    JSON.stringify(after.cells["5"]) === JSON.stringify(before.cells["5"]), { before: before.cells["5"], after: after.cells["5"] });
ok("写回后选区还在（可以连续改）", JSON.stringify(after.selection) === JSON.stringify(["2", "3", "4"]), after.selection);
ok("一次写回 = 一条撤销记录（撤销栈 +1）", after.undoDepth === before.undoDepth + 1, { before: before.undoDepth, after: after.undoDepth });

// ===== 撤销：整批一起回退 =====
const undone = await page.evaluate(() => {
    const a = window.__aiScope.ui.actions.get("undo");
    if (a && a.funct) a.funct();
    const g = window.__aiScope.graph, m = g.getModel();
    const out = {};
    ["2", "3", "4"].forEach((id) => { const geo = m.getCell(id).getGeometry(); out[id] = geo.x; });
    return { x: out, undoDepth: window.__aiScope.undoDepth() };
});
R.steps.undone = undone;
ok("撤销一次就把整批对齐回退了（2/3/4 的 x 回到原值）",
    undone.x["2"] === before.cells["2"].x && undone.x["3"] === before.cells["3"].x && undone.x["4"] === before.cells["4"].x,
    { before: ["2", "3", "4"].map((id) => before.cells[id].x), after: undone.x });

// ===== 没选中元素时：菜单项不可点（而不是执行了改错东西）=====
await page.evaluate(() => window.__aiScope.graph.clearSelection());
await page.waitForTimeout(300);
await page.mouse.click(...at(boxes["5"]), { button: "right" });
await page.waitForTimeout(600);
const noSelMenu = await page.evaluate(() => {
    const menus = Array.from(document.querySelectorAll(".mxPopupMenu")).filter((m) => m.offsetParent !== null);
    for (const m of menus) for (const tr of m.querySelectorAll("tr")) {
        if (tr.textContent.trim().indexOf("AI 局部修改") >= 0) return { found: true, disabled: tr.className.indexOf("mxPopupMenuDisabled") >= 0 };
    }
    return { found: false };
});
// 右键空白/未选中元素时 drawio 会先把它选中，所以这里菜单项应当是**可点**的（选中了一个）
R.steps.noSelMenu = noSelMenu;
ok("右键未选中元素时 drawio 会先选中它，菜单项随之可点", noSelMenu.found && !noSelMenu.disabled, noSelMenu);
await page.keyboard.press("Escape");

// ===== 悬浮框的行为：ESC 关框、× 关框（不然它是个关不掉的浮层）=====
await page.evaluate(() => window.__aiScope.graph.setSelectionCells(["2", "3"].map((id) => window.__aiScope.graph.getModel().getCell(id))));
await page.evaluate(() => window.__aiScope.openInstruct(null));
await page.waitForTimeout(400);
const opened = await page.evaluate(() => !!document.getElementById("aiScopeInstructPanel"));
await page.fill('#aiScopeInstructPanel [data-role="ai-scope-input"]', "随便写点");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const closedByEsc = await page.evaluate(() => !document.getElementById("aiScopeInstructPanel"));

await page.evaluate(() => window.__aiScope.openInstruct(null));
await page.waitForTimeout(400);
const closeBtn = await page.evaluate(() => {
    const b = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-close"]').getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
});
await page.mouse.click(closeBtn.x, closeBtn.y);
await page.waitForTimeout(300);
const closedByX = await page.evaluate(() => !document.getElementById("aiScopeInstructPanel"));
R.steps.panelLifecycle = { opened, closedByEsc, closedByX };
ok("指令框能开、ESC 能关、× 能关", opened && closedByEsc && closedByX, R.steps.panelLifecycle);

R.unexpectedErrors = pageErrors.filter((e) => !/favicon|ERR_/.test(e));
ok("全程没有未预期的页面错误", R.unexpectedErrors.length === 0, R.unexpectedErrors);

console.log("\nPHASE2_RESULT=" + JSON.stringify(R, null, 2));
console.log(failures === 0 ? "\nPHASE2_SUMMARY=ALL_PASS" : `\nPHASE2_SUMMARY=${failures}_FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
