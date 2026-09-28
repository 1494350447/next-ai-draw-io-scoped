/*
 * 探针：插件 `applyWrites` 落地"新增**边**"（AI 通道的 add 可以是一条 edge）时，真实语义是什么。
 *
 * 起因：`phase2-commands` 的生成式那一轮，真模型一次加了 12 个元素（含边 `new-e1`），
 * 画布控制台冒出两条 `mxCellCodec.beforeDecode: source 3 not found for cell new-e1`。
 * 去 app.min.js 里读实现：那段代码在 `codec.objects[id]` 和 `codec.getElementById(id)` 都找不到端点时
 * **`console.error` 并把 `cell.source/target` 设成 null** —— 也就是说，只解"一个 cell 片段"时，
 * 新边会变成**浮动线**（看起来加上了，其实没连到任何东西）。
 *
 * 本探针不改任何代码，只量三件事：
 *   A. 端点在工作目录里存在（3=Beta / 2=Alpha）时，新边的 source/target 到底绑上没有；
 *   B. 端点根本不存在（source="9999"）时表现如何（有没有报错、有没有静默浮动线）；
 *   C. 序列化后的 XML 里还留不留 source/target 属性。
 *
 * 用法：./harness/run.sh probe-add-edge.mjs
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

const EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;";
const edgeXml = (id, source, target) => `<mxCell id="${id}" edge="1" parent="1" source="${source}" target="${target}" style="${EDGE_STYLE}"><mxGeometry relative="1" as="geometry" /></mxCell>`;

const R = { drawio: DRAWIO, scenario: {}, consoleErrors: [] };

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") R.consoleErrors.push(m.text()); });
page.on("pageerror", (e) => R.consoleErrors.push("pageerror: " + e.message));

await page.goto(`${DRAWIO}/?aiScopeDebug=1&ui=kennedy`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 45000 });
await page.evaluate((xml) => { window.__aiScope.ui.setFileData(xml); }, MXFILE);
await page.waitForTimeout(800);

/** 用插件的真实入口 applyWrites 落地一条边，然后把模型里的真实状态读回来 */
const tryAddEdge = (id, source, target) => page.evaluate(({ id, source, target, xml }) => {
    const w = window.__aiScope, m = w.graph.getModel();
    const xmlBefore = w.xmlOf();
    const r = w.applyWrites([{ cellId: id, structural: { kind: "add", xml, parentId: "1" } }]);
    const c = m.getCell(id);
    const after = w.xmlOf();
    const frag = new RegExp('<mxCell id="' + id + '"[\\s\\S]*?</mxCell>').exec(after);
    const allIds = Object.keys(m.cells);
    const edgesInModel = allIds.filter((k) => { try { return m.isEdge(m.cells[k]); } catch (e) { return false; } });
    // 模型树里有没有它（编码走的是树遍历，不是 cells 表 —— 两者不一致本身就是发现）
    const layer = m.getCell("1");
    const layerChildren = [];
    for (let i = 0; layer && i < layer.getChildCount(); i++) layerChildren.push(String(layer.getChildAt(i).getId()));
    const inTree = layerChildren.indexOf(String(id)) !== -1;
    const registered = !!m.getCell(id);
    const treeCell = inTree ? layer.getChildAt(layerChildren.indexOf(String(id))) : null;
    let rendered = null;
    try { rendered = !!(treeCell && w.graph.view.getState(treeCell)); } catch (e) { rendered = "err:" + e.message; }
    return {
        applyWrites: r,
        xmlBeforeHasEdge: xmlBefore.includes(id),
        sameModel: m === w.graph.getModel(),
        exists: !!c,
        registered: registered,
        inLayerTree: inTree,
        layerChildren: layerChildren,
        renderedOnCanvas: rendered,
        treeTerminals: treeCell ? {
            source: treeCell.getTerminal(true) ? treeCell.getTerminal(true).getId() : null,
            target: treeCell.getTerminal(false) ? treeCell.getTerminal(false).getId() : null,
        } : null,
        modelIds: allIds,
        edgesInModel: edgesInModel.map((k) => {
            const e = m.cells[k];
            return { id: k, source: e.getTerminal(true) ? e.getTerminal(true).getId() : null, target: e.getTerminal(false) ? e.getTerminal(false).getId() : null };
        }),
        isEdge: c ? m.isEdge(c) : null,
        source: c ? (c.getTerminal(true) ? c.getTerminal(true).getId() : null) : undefined,
        target: c ? (c.getTerminal(false) ? c.getTerminal(false).getId() : null) : undefined,
        xmlFragment: frag ? frag[0] : null,
    };
}, { id, source, target, xml: edgeXml(id, source, target) });

const beforeCount = R.consoleErrors.length;
R.scenario["A 端点存在（3=Beta → 2=Alpha）"] = await tryAddEdge("probe-edge-a", "3", "2");
R.scenario["A 本次新增的控制台报错"] = R.consoleErrors.slice(beforeCount);

const beforeB = R.consoleErrors.length;
R.scenario["B 端点不存在（source=9999）"] = await tryAddEdge("probe-edge-b", "9999", "2");
R.scenario["B 本次新增的控制台报错"] = R.consoleErrors.slice(beforeB);

const a = R.scenario["A 端点存在（3=Beta → 2=Alpha）"];
const b = R.scenario["B 端点不存在（source=9999）"];
const summary = {
    A_exists: a.exists,
    A_inLayerTree: a.inLayerTree,
    A_renderedOnCanvas: a.renderedOnCanvas,
    A_isEdge: a.isEdge,
    A_terminals: `${a.source}->${a.target}`,
    A_terminals_bound: a.source === "3" && a.target === "2",
    A_xml_keeps_source_target: /source="3"/.test(String(a.xmlFragment)) && /target="2"/.test(String(a.xmlFragment)),
    A_console_errors: R.scenario["A 本次新增的控制台报错"].length,
    B_exists: b.exists,
    B_terminals: `${b.source}->${b.target}`,
    B_inXml: /probe-edge-b/.test(String(b.xmlFragment)),
    B_refused: (b.applyWrites.refused || []).length > 0,
    B_reported_added: b.applyWrites.added,
    B_console_errors: R.scenario["B 本次新增的控制台报错"].length,
    verdict: [
        (a.registered !== false && a.exists && a.renderedOnCanvas === true && a.source === "3" && a.target === "2" && R.scenario["A 本次新增的控制台报错"].length === 0)
            ? "A：新边连上两端、画布渲染出来、无报错 ✅"
            : "A：新边落地不完整 ❌",
        b.applyWrites.added === 0 && b.exists === false && /probe-edge-b/.test(String(b.xmlFragment)) === false
            ? "B：端点不存在的 add 被拒（没有假装成功）✅"
            : "B：端点不存在的 add 仍被加上 ❌",
    ].join(" / "),
};

console.log("PROBE_ADD_EDGE_RESULT=" + JSON.stringify({ ...R, summary }, null, 2));
console.log("PROBE_ADD_EDGE_SUMMARY=" + summary.verdict);
await browser.close();
