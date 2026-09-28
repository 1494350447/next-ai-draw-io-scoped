/*
 * 探针：新增元素到底该用哪个 API 写回？—— 把"模型注册 + 画布渲染 + 端点绑定"三件事分开量。
 *
 * 背景：`probe-add-edge.mjs` 量出插件现有的 XML 兜底路径（`mxCodec.decodeCell` + `model.add`）会
 * 把新元素插进父容器的 children 里、也写进了序列化 XML，但 **`model.getCell(id)` 找不到它、画布上也没渲染**，
 * 而 `applyWrites` 依然报 `added:1`。也就是"报告成功、实际没落地"。
 *
 * 本探针在同一张图上分别试 4 种组合，每种都读同一组事实：
 *   registered（model.getCell 能否找到） / inTree（父容器 children 里有） / rendered（graph.view.getState）
 *   / terminals（边的端点绑没绑上） / consoleErrors（解码时的告警）
 *
 * 用法：./harness/run.sh probe-add-api.mjs
 */
import { chromium } from "playwright";

const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const DRAWIO = process.env.DRAWIO_URL || "http://127.0.0.1:8080";

const MXFILE =
    '<mxfile host="app.diagrams.net"><diagram name="Page-1">' +
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="240" width="200" height="90" as="geometry"/></mxCell>' +
    "</root></mxGraphModel></diagram></mxfile>";

const VERTEX_XML = (id) => `<mxCell id="${id}" value="${id}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="300" y="600" width="120" height="60" as="geometry"/></mxCell>`;
const EDGE_XML = (id) => `<mxCell id="${id}" edge="1" parent="1" source="3" target="2" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;"><mxGeometry relative="1" as="geometry" /></mxCell>`;

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

await page.goto(`${DRAWIO}/?aiScopeDebug=1&ui=kennedy`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 45000 });
await page.evaluate((xml) => { window.__aiScope.ui.setFileData(xml); }, MXFILE);
await page.waitForTimeout(800);

/** 一次尝试：how = "model.add" | "graph.addCell"；registerAll = 解码前是否注册全部 cell；detach = 解码后是否 setParent(null) */
const attempt = (id, xml, how, registerAll, detach) => page.evaluate(({ id, xml, how, registerAll, detach }) => {
    const w = window.__aiScope, g = w.graph, m = g.getModel();
    const doc = mxUtils.parseXml(xml);
    const codec = new mxCodec(doc);
    codec.putObject("1", m.getCell("1"));
    codec.putObject("0", m.getCell("0"));
    if (registerAll) { Object.keys(m.cells).forEach((k) => codec.putObject(k, m.cells[k])); }
    let made = null;
    m.beginUpdate();
    try {
        made = codec.decodeCell(doc.documentElement);
        // 候选修法：解码时 parent 已被 codec 接到活着的图层上 → parentForCellChanged 会认为"它已经在模型里"，
        // 于是跳过 cellAdded（=不注册进 model.cells，画布就不渲染）。先摘掉 parent，再交给官方 API 挂。
        if (made && detach) made.setParent(null);
        const parent = m.getCell("1");
        if (made && how === "model.add") m.add(parent, made, m.getChildCount(parent));
        else if (made && how === "graph.addCell") g.addCell(made, parent);
    } finally { m.endUpdate(); }
    const cell = m.getCell(id);
    const layer = m.getCell("1");
    let inTree = false;
    for (let i = 0; layer && i < layer.getChildCount(); i++) if (String(layer.getChildAt(i).getId()) === String(id)) inTree = true;
    let rendered = null;
    try { rendered = !!(cell && g.view.getState(cell)); } catch (e) { rendered = "err"; }
    return {
        how, registerAll,
        decoded: !!made, decodedId: made ? String(made.getId()) : null,
        registered: !!cell, inTree, rendered,
        terminals: cell && m.isEdge(cell) ? {
            source: cell.getTerminal(true) ? cell.getTerminal(true).getId() : null,
            target: cell.getTerminal(false) ? cell.getTerminal(false).getId() : null,
        } : null,
        isEdge: cell ? m.isEdge(cell) : null,
        inXml: w.xmlOf().includes(id),
    };
}, { id, xml, how, registerAll, detach });

const cases = [
    ["顶点 + model.add + 不注册（插件现状）", "probe-v1", VERTEX_XML("probe-v1"), "model.add", false, false],
    ["顶点 + graph.addCell + 不注册（插件现状）", "probe-v2", VERTEX_XML("probe-v2"), "graph.addCell", false, false],
    ["边 + model.add + 不注册（插件现状）", "probe-e1", EDGE_XML("probe-e1"), "model.add", false, false],
    ["顶点 + graph.addCell + 注册全部 + detach（候选修法）", "probe-v3", VERTEX_XML("probe-v3"), "graph.addCell", true, true],
    ["边 + graph.addCell + 注册全部 + detach（候选修法）", "probe-e3", EDGE_XML("probe-e3"), "graph.addCell", true, true],
];

const out = [];
for (const [name, id, xml, how, registerAll, detach] of cases) {
    const before = consoleErrors.length;
    const r = await attempt(id, xml, how, registerAll, detach);
    r.name = name;
    r.consoleErrors = consoleErrors.slice(before);
    out.push(r);
}

// 附：`decodeCell(node)` 的第二个参数默认是 true —— 它自己就会把 cell 裸插进父容器的 children
// （`mxCodec.insertIntoGraph` → `parent.insert(cell)`），**绕过 model.cells 注册**。
// 这一条是"报告新增成功、画布上却看不见"的机制，单独量一次留证。
const defaultInsert = await page.evaluate(() => {
    const w = window.__aiScope, m = w.graph.getModel();
    const layer = m.getCell("1");
    const countChildren = () => { let n = 0; for (let i = 0; layer && i < layer.getChildCount(); i++) n++; return n; };
    const xml = '<mxCell id="probe-d1" value="D" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="10" y="700" width="60" height="40" as="geometry"/></mxCell>';
    const doc = mxUtils.parseXml(xml);
    const codec = new mxCodec(doc);
    codec.putObject("1", layer);
    const before = countChildren();
    const made = codec.decodeCell(doc.documentElement);            // 默认 restoreStructures = true
    const afterDefault = countChildren();
    let inXml = w.xmlOf().includes("probe-d1");
    return { before, afterDefault, insertedByDefault: afterDefault > before, registered: !!m.getCell("probe-d1"), inXml };
});

console.log("PROBE_ADD_API_RESULT=" + JSON.stringify({ drawio: DRAWIO, cases: out, decodeCellDefaultInsert: defaultInsert }, null, 2));
const okCount = out.filter((c) => c.decoded && c.registered && c.inTree && c.rendered === true && c.consoleErrors.length === 0).length;
console.log(`PROBE_ADD_API_SUMMARY=全绿（注册+入树+渲染+无报错）的有 ${okCount}/${out.length} 种组合`);
await browser.close();
