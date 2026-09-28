// S1 spike 验证 B：真实鼠标事件（trusted）点选 + 右键菜单，完全由 Playwright 驱动。
// 宿主页 spike-b.html 只负责把编辑器框进 iframe（drawio 仅在被框住时才发 init）。
import { chromium } from "playwright";

const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const HOST = process.env.HOST_URL || "http://127.0.0.1:8080/spike-b.html";

const MODEL =
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    "</root></mxGraphModel>";
const MXFILE = '<mxfile host="app.diagrams.net"><diagram name="Page-1">' + MODEL + "</diagram></mxfile>";

const R = { host: HOST, pluginReady: false, drawioVersion: null, loadVariants: [], realClick: null, rightClick: null, invokeAction: null, errors: [] };

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => console.log(`[console:${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("requestfailed", (r) => console.log("[reqfail]", r.url(), (r.failure() || {}).errorText));

await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForFunction(() => window.__initAt != null, null, { timeout: 40000 });
console.log("收到 drawio 的 init 事件");

const frame = page.frames().find((f) => f.url().includes("embed=1"));
if (!frame) {
    R.errors.push("找不到 drawio frame");
    console.log("SPIKE_B_RESULT=" + JSON.stringify(R, null, 2));
    await browser.close();
    process.exit(1);
}
R.frames = page.frames().map((f) => f.url().slice(0, 80));

await frame.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 40000 });
R.pluginReady = true;
R.drawioVersion = await frame.evaluate(() => window.__aiScope.version());
console.log("插件已就绪，drawio " + R.drawioVersion);

async function dumpState(label) {
    const st = await frame.evaluate(() => {
        const ui = window.__aiScope.ui, g = ui.editor.graph, m = g.getModel();
        let file = null;
        try { const f = ui.getCurrentFile(); file = f ? (f.getTitle ? f.getTitle() : "file") : null; } catch (e) { file = "err:" + e.message; }
        return {
            currentFile: file,
            isDiagramEmpty: ui.isDiagramEmpty ? ui.isDiagramEmpty() : null,
            cells: Object.keys(m.cells).map((k) => k),
            vertices: Object.keys(m.cells).map((k) => m.cells[k]).filter((c) => m.isVertex(c)).map((c) => c.getId()),
            viewStates: Object.keys(g.view.states || {}).length,
        };
    });
    const msgs = await page.evaluate(() => window.__msgs.map((m) => m.event + (m.error ? ":" + m.error : "") + (m.message ? ":" + (m.message.message || JSON.stringify(m.message)) : "")));
    console.log(`[${label}]\n  state=` + JSON.stringify(st) + "\n  msgs=" + JSON.stringify(msgs));
    return { st, msgs };
}

// 三条路径都试：看哪条能让图真进画布
const attempts = [
    ["A. embed load + 裸 mxGraphModel", () => page.evaluate((x) => window.__send({ action: "load", xml: x }), MODEL)],
    ["B. embed load + mxfile 包装", () => page.evaluate((x) => window.__send({ action: "load", xml: x }), MXFILE)],
    ["C. 直接调原生 setGraphXml", () => frame.evaluate((x) => window.__aiScope.ui.editor.setGraphXml(mxUtils.parseXml(x).documentElement), MODEL)],
];
for (const [name, send] of attempts) {
    try { await send(); } catch (e) { console.log(`[${name}] 发送异常: ` + e.message); }
    await page.waitForTimeout(2500);
    const d = await dumpState(name);
    R.loadVariants.push({ name, cells: d.st.cells, vertices: d.st.vertices, viewStates: d.st.viewStates, msgs: d.msgs, ok: d.st.vertices.length > 0 });
}

const geo = await frame.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel(), root = m.getRoot();
    const cell = Object.keys(m.cells).map((k) => m.cells[k]).filter((c) => m.isVertex(c) && c.getId() === "2")[0]
        || Object.keys(m.cells).map((k) => m.cells[k]).filter((c) => m.isVertex(c))[0];
    if (!cell) return { error: "画布里没有顶点", cells: Object.keys(m.cells) };
    g.scrollCellToVisible(cell); // 先把目标滚进可视区，否则坐标落在容器外
    const st = g.view.getState(cell);
    if (!st) return { error: "getState 为空", id: cell.getId() };
    const rect = g.container.getBoundingClientRect();
    // state 坐标已含 translate/scale，是“内容空间”，要减掉容器滚动量才是视口坐标
    const toClient = (sx, sy) => ({ x: rect.left - g.container.scrollLeft + sx, y: rect.top - g.container.scrollTop + sy });
    return [
        { name: "stateCenter", ...toClient(st.getCenterX(), st.getCenterY()) },
        { name: "stateTopLeft", ...toClient(st.x + 4, st.y + 4) },
    ].map((c) => {
        const el = document.elementFromPoint(c.x, c.y);
        return { ...c, id: cell.getId(), hit: el ? el.tagName : null, inGraph: !!(el && g.container.contains(el)), scale: g.view.scale, translate: { x: g.view.translate.x, y: g.view.translate.y }, scroll: { l: g.container.scrollLeft, t: g.container.scrollTop }, state: { x: st.x, y: st.y, w: st.width, h: st.height }, containerRect: { l: Math.round(rect.left), t: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }, viewport: { w: innerWidth, h: innerHeight } };
    });
});
console.log("候选点击坐标: " + JSON.stringify(geo));
if (geo.error) {
    R.errors.push(geo.error);
    console.log("SPIKE_B_RESULT=" + JSON.stringify(R, null, 2));
    await browser.close();
    process.exit(1);
}

const box = await page.evaluate(() => {
    const r = document.getElementById("f").getBoundingClientRect();
    return { left: r.left, top: r.top, scrollX: window.scrollX, scrollY: window.scrollY };
});
const chosen = geo.find((c) => c.inGraph) || geo[0];
const clickX = box.left + chosen.x - box.scrollX;
const clickY = box.top + chosen.y - box.scrollY;

// ===== 真实鼠标点击（trusted event）=====
await page.mouse.move(clickX, clickY);
await page.waitForTimeout(200);
await page.mouse.click(clickX, clickY);
await page.waitForTimeout(1500);
const selectionAfter = await frame.evaluate(() => (window.__aiScope.graph.getSelectionCells() || []).map((c) => c.getId()));
// 注意：__msgs 在宿主页(spike-b.html)上，不在 drawio frame 里
const scopeEvents = await page.evaluate(() => window.__msgs.filter((m) => m.event === "aiScope").map((m) => ({ reason: m.reason, count: m.count, ids: (m.cells || []).map((c) => c.id) })));
R.realClick = { hitTest: chosen.name, inGraph: chosen.inGraph, pageX: Math.round(clickX), pageY: Math.round(clickY), selectionAfter, scopeEventSeen: scopeEvents.some((e) => e.reason === "selectionChanged" && e.ids.includes(chosen.id)) };
console.log("真实点击 -> 选区: " + JSON.stringify(selectionAfter) + "，插件事件: " + JSON.stringify(scopeEvents));
R.events = scopeEvents;

// ===== 右键菜单里插件项是否出现 =====
await page.mouse.click(clickX, clickY, { button: "right" });
await page.waitForTimeout(1200);
R.rightClick = await frame.evaluate(() => {
    const menus = Array.from(document.querySelectorAll(".mxPopupMenu"));
    const items = [];
    menus.forEach((m) => m.querySelectorAll("tr").forEach((tr) => { const t = tr.textContent.trim(); if (t) items.push(t); }));
    // 插件项的 rect 也一起取出来，后面要在真实坐标上点它
    let pluginRect = null, pluginLabel = null;
    menus.forEach((m) => m.querySelectorAll("tr").forEach((tr) => {
        const t = tr.textContent.trim();
        if (/aiScope/i.test(t)) {
            const r = tr.getBoundingClientRect();
            pluginRect = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
            pluginLabel = t;
        }
    }));
    return { menuCount: menus.length, itemCount: items.length, items, hasPluginItem: pluginRect != null, pluginLabel, pluginRect };
});
console.log("右键菜单: " + JSON.stringify(R.rightClick));

// ===== 真实点击右键菜单里的插件项，验证"右键 -> 局部修改"这条 UX 链路 =====
if (R.rightClick.pluginRect) {
    const px = box.left + R.rightClick.pluginRect.x - box.scrollX;
    const py = box.top + R.rightClick.pluginRect.y - box.scrollY;
    await page.mouse.click(px, py);
    await page.waitForTimeout(1200);
    R.menuItemClick = {
        label: R.rightClick.pluginLabel,
        pageX: Math.round(px),
        pageY: Math.round(py),
        scopeEventSeen: (await page.evaluate(() => window.__msgs.filter((m) => m.event === "aiScope").map((m) => m.reason))).filter((r) => r === "invokeAction"),
        selection: await frame.evaluate(() => (window.__aiScope.graph.getSelectionCells() || []).map((c) => c.getId())),
    };
    console.log("点右键菜单项 -> " + JSON.stringify(R.menuItemClick));
}

// ===== 父->编辑器反向通道 =====
await page.keyboard.press("Escape");
await page.evaluate(() => window.__send({ action: "invokeAction", actionName: "aiScopeProbe" }));
await page.waitForTimeout(1000);
R.invokeAction = await page.evaluate(() => {
    const e = window.__msgs.filter((m) => m.event === "aiScope" && m.reason === "invokeAction").pop();
    return e ? { worked: true, ids: (e.cells || []).map((c) => c.id) } : { worked: false };
});
console.log("invokeAction 反向通道: " + JSON.stringify(R.invokeAction));

R.readyMeta = await page.evaluate(() => window.__msgs.find((m) => m.event === "aiScopeReady") || null);
R.allEvents = await page.evaluate(() => window.__msgs.filter((m) => m.event === "aiScope").map((m) => m.reason));

console.log("\nSPIKE_B_RESULT=" + JSON.stringify(R, null, 2));
await browser.close();
