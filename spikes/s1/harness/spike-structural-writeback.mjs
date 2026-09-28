/*
 * 最小写回 spike（③ 增删元素的第一步）：**结构性改动在真实画布上怎么写、写完什么语义**。
 *
 * 只回答"能不能、怎么写"，不做产品接线。用 standalone 画布（同一个 drawio 构建 + 同一个插件，
 * `?aiScopeDebug=1` 只是为了能直接读模型/调 API，产品路径不依赖它）。
 *
 * 要回答的问题：
 *   Q1 mxGraph 的几个全局（mxUtils / mxCodec / mxCell）在插件上下文里在不在
 *   Q2 用官方 API `graph.insertVertex` 新建元素：能不能拿到 id、XML 里长什么样
 *   Q3 新建到**容器**里：parent 对不对
 *   Q4 `graph.removeCells` 删一个带**连线**的元素：连线会不会一起走、容器/别的元素受不受影响
 *   Q5 服务端给的 `<mxCell>` XML 能不能解成 cell（**保住服务端指定的 id**，便于审计对齐）
 *   Q6 两种写法的撤销栈行为（in-app 那层"写回后被宿主 setFileData 清空"另说）
 */
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const DRAWIO = process.env.DRAWIO_URL || "http://127.0.0.1:8080";

const MXFILE =
    '<mxfile host="app.diagrams.net"><diagram name="Page-1">' +
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="1200" pageHeight="900"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="240" width="200" height="90" as="geometry"/></mxCell>' +
    '<mxCell id="6" value="" style="endArrow=classic;html=1;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    '<mxCell id="7" value="Box" style="rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#666666;dashed=1;" vertex="1" parent="1"><mxGeometry x="700" y="120" width="240" height="200" as="geometry"/></mxCell>' +
    '<mxCell id="8" value="Inner" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="7"><mxGeometry x="720" y="150" width="180" height="60" as="geometry"/></mxCell>' +
    "</root></mxGraphModel></diagram></mxfile>";

const R = { steps: {}, asserts: [] };
let failures = 0;
const ok = (name, cond, extra) => {
    R.asserts.push({ name, pass: !!cond, ...(extra !== undefined ? { detail: extra } : {}) });
    if (!cond) failures += 1;
    console.log(`ASSERT ${name}: ${cond ? "通过" : "失败"}` + (extra !== undefined && !cond ? " -> " + JSON.stringify(extra) : ""));
};

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto(`${DRAWIO}/?aiScopeDebug=1&ui=kennedy`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 45000 });
await page.evaluate((xml) => { window.__aiScope.ui.setFileData(xml); }, MXFILE);
await page.waitForTimeout(900);

// Q1: 全局可用性
R.q1_globals = await page.evaluate(() => ({
    mxUtils: typeof mxUtils, mxCodec: typeof mxCodec, mxCell: typeof mxCell, mxGeometry: typeof mxGeometry,
    insertVertex: typeof window.__aiScope.graph.insertVertex, removeCells: typeof window.__aiScope.graph.removeCells,
    decodeCell: typeof (mxCodec && mxCodec.prototype && mxCodec.prototype.decodeCell),
}));
ok("Q1 mxGraph 全局齐备（mxUtils/mxCodec/mxCell 都在）",
    R.q1_globals.mxUtils === "object" && R.q1_globals.mxCodec === "function" && R.q1_globals.mxCell === "function",
    R.q1_globals);

// Q2: insertVertex 到图层
R.q2 = await page.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    const before = window.__aiScope.undoDepth();
    const parent = m.getCell("1");
    let made = null;
    m.beginUpdate();
    try {
        made = g.insertVertex(parent, null, "AI 新建", 200, 700, 140, 60, "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;");
        made.setId && made.setId("ai-new-1");
    } finally { m.endUpdate(); }
    const xml = window.__aiScope.xmlOf();
    const frag = /<mxCell id="ai-new-1"[\s\S]*?<\/mxCell>/.exec(xml);
    return {
        returnedId: made ? made.getId() : null, isVertex: made ? m.isVertex(made) : null,
        xmlFragment: frag ? frag[0] : null,
        undoDepthBefore: before, undoDepthAfter: window.__aiScope.undoDepth(),
    };
});
ok("Q2 insertVertex 能建元素、能指定 id、XML 里几何/样式都对",
    !!R.q2.xmlFragment && /x="200"/.test(R.q2.xmlFragment) && /fillColor=#dae8fc/.test(R.q2.xmlFragment) && /value="AI 新建"/.test(R.q2.xmlFragment),
    R.q2);

// Q3: 新建到容器里
R.q3 = await page.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    const box = m.getCell("7");
    m.beginUpdate();
    try { g.insertVertex(box, null, "AI 容器内", 740, 250, 160, 50, "rounded=1;whiteSpace=wrap;html=1;"); }
    finally { m.endUpdate(); }
    const xml = window.__aiScope.xmlOf();
    // 注意：drawio 序列化时属性按字母序排（id, parent, style, value, vertex），
    // 所以不能拿 `id="X" value="Y"` 这种相邻假设去匹配（这个 spike 第一版就是这么写错的）。
    const i = xml.indexOf('value="AI 容器内"');
    let frag = null;
    if (i >= 0) {
        const start = xml.lastIndexOf("<mxCell", i), end = xml.indexOf("</mxCell>", i);
        if (start >= 0 && end >= 0) frag = xml.slice(start, end + "</mxCell>".length);
    }
    return { xmlFragment: frag };
});
ok("Q3 新建到容器里：parent 指向容器 id（7）", !!R.q3.xmlFragment && /parent="7"/.test(R.q3.xmlFragment), R.q3);

// Q4: 删除带连线的元素
R.q4 = await page.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    const xmlBefore = window.__aiScope.xmlOf();
    const depthBefore = window.__aiScope.undoDepth();
    g.removeCells([m.getCell("2")]);
    const xmlAfter = window.__aiScope.xmlOf();
    const has = (xml, id) => new RegExp(`<mxCell id="${id}"[\\s\\S]*?</mxCell>`).test(xml);
    return {
        cell2Before: has(xmlBefore, "2"), cell2After: has(xmlAfter, "2"),
        edge6Before: has(xmlBefore, "6"), edge6After: has(xmlAfter, "6"),
        betaStillThere: has(xmlAfter, "3"), boxStillThere: has(xmlAfter, "7"), innerStillThere: has(xmlAfter, "8"),
        newStillThere: has(xmlAfter, "ai-new-1"), containerChildStillThere: /value="AI 容器内"/.test(xmlAfter),
        undoDepthBefore: depthBefore, undoDepthAfter: window.__aiScope.undoDepth(),
    };
});
ok("Q4 删掉 Alpha：元素没了，**它的连线也一起走了**，别的元素一个没动",
    R.q4.cell2Before && !R.q4.cell2After && R.q4.edge6Before && !R.q4.edge6After &&
    R.q4.betaStillThere && R.q4.boxStillThere && R.q4.innerStillThere && R.q4.newStillThere && R.q4.containerChildStillThere,
    R.q4);

// Q5: 服务端给的 XML → cell（保住指定 id）
R.q5 = await page.evaluate(() => {
    const g = window.__aiScope.graph, m = g.getModel();
    const xml = '<mxCell id="ai-new-2" value="服务端造的" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;" vertex="1" parent="1"><mxGeometry x="300" y="800" width="150" height="70" as="geometry"/></mxCell>';
    const doc = mxUtils.parseXml(xml);
    const node = doc.documentElement;
    const codec = new mxCodec(doc);
    const cell = codec.decodeCell(node);
    let okAdd = false, err = null;
    m.beginUpdate();
    try { m.add(m.getCell("1"), cell, 1); okAdd = true; } catch (e) { err = String(e); } finally { m.endUpdate(); }
    const after = window.__aiScope.xmlOf();
    const frag = new RegExp('<mxCell id="ai-new-2"[\\s\\S]*?</mxCell>').exec(after);
    return { decodeOk: !!cell, decodedId: cell ? cell.getId() : null, isVertex: cell ? m.isVertex(cell) : null, okAdd, err, xmlFragment: frag ? frag[0] : null };
});
ok("Q5 服务端给的 <mxCell> XML 能解码成 cell 并挂上（**id 保持服务端指定的那个**）",
    R.q5.decodeOk && R.q5.decodedId === "ai-new-2" && R.q5.okAdd && R.q5.isVertex === true && !!R.q5.xmlFragment,
    R.q5);

// Q7: 写回后的 XML 还能被 drawio 自己吃回去（别造出坏文件）
R.q7 = await page.evaluate(() => {
    const xml = window.__aiScope.xmlOf();
    window.__aiScope.ui.setFileData(xml);
    const m = window.__aiScope.graph.getModel();
    const ids = Object.keys(m.cells);
    return { cells: ids.length, has2: ids.indexOf("2") >= 0, hasNew1: ids.indexOf("ai-new-1") >= 0, hasWrapAtEnd: /value="AI 新建"/.test(xml) };
});
await page.waitForTimeout(500);
ok("Q7 增删之后的 XML 能原样吃回 drawio（文件没被写坏）",
    R.q7.cells > 0 && !R.q7.has2 && R.q7.hasNew1 && R.q7.hasWrapAtEnd, R.q7);

console.log("\nSPIKE_STRUCTURAL_RESULT=" + JSON.stringify(R, null, 2));
console.log(failures === 0 ? "\nSPIKE_STRUCTURAL_SUMMARY=ALL_PASS" : `\nSPIKE_STRUCTURAL_SUMMARY=${failures}_FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
