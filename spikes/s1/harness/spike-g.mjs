// Phase 1 spike G：跨系统契约验证。
// 把**原型产出的 XML**（prototype/ 的 /api/command 输出）交给**真实 drawio**加载并导出回读，
// 用一份独立实现（不 import 原型代码）比对前后模型，回答两个问题：
//   1) 我们改出来的 XML，drawio 认不认（能不能加载、有没有报错、内容有没有丢）
//   2) "只改选中元素"在 drawio 眼里是不是真的只改了那些元素（其余元素语义完全不变）
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const HOST = process.env.HOST_URL || "http://127.0.0.1:8080/spike-b.html";
const BEFORE = process.env.BEFORE_XML || "/work/results/phase1-before.xml";
const AFTER = process.env.AFTER_XML || "/work/results/phase1-after.xml";

// ---- 独立的轻量 XML 读取（刻意不复用原型解析器：独立实现才叫交叉验证）----
const decode = (s) => String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#10;/g, "\n").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
function attrsOf(text) {
    const out = {};
    const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(text))) out[m[1]] = decode(m[2]);
    return out;
}
function extractCells(xml) {
    const cells = {};
    const re = /<mxCell\b([^>]*?)(\/>|>)/g;
    let m;
    while ((m = re.exec(xml))) {
        const a = attrsOf(m[1]);
        if (!a.id) continue;
        // 自闭合的 <mxCell/> 没有子节点；非自闭合的只在**它自己的 </mxCell> 之前**找 geometry，
        // 否则会误抓到下一个 cell 的 geometry（这个坑第一次跑就踩到了：cell 0/1 被报成"变了"）
        let rest = "";
        if (m[2] !== "/>") {
            const tail = xml.slice(re.lastIndex, re.lastIndex + 2000);
            const close = tail.indexOf("</mxCell>");
            rest = close >= 0 ? tail.slice(0, close) : tail;
        }
        const g = /<mxGeometry\b([^>]*?)(\/>|>)/.exec(rest);
        const ga = g ? attrsOf(g[1]) : null;
        cells[a.id] = {
            value: a.value ?? "",
            style: (a.style ?? "").split(";").filter(Boolean).sort().join(";"),
            vertex: a.vertex ?? null, edge: a.edge ?? null, parent: a.parent ?? null,
            source: a.source ?? null, target: a.target ?? null,
            geometry: ga ? { x: ga.x ?? null, y: ga.y ?? null, width: ga.width ?? null, height: ga.height ?? null } : null,
        };
    }
    return cells;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function diffCells(before, after) {
    const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const out = { added: [], removed: [], changed: {}, unchanged: [] };
    for (const id of ids) {
        if (!(id in before)) { out.added.push(id); continue; }
        if (!(id in after)) { out.removed.push(id); continue; }
        const fields = Object.keys(before[id]).filter((k) => !eq(before[id][k], after[id][k]));
        if (fields.length) out.changed[id] = fields;
        else out.unchanged.push(id);
    }
    return out;
}

const R = { host: HOST, before: BEFORE, after: AFTER, load: {}, changed: null, onlyIntended: null, errors: [] };
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") console.log("[console:error]", m.text()); });
page.on("pageerror", (e) => R.errors.push(String(e.message).slice(0, 200)));
page.on("requestfailed", (r) => R.errors.push("reqfail " + r.url() + " " + (r.failure() || {}).errorText));

await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForFunction(() => window.__initAt != null, null, { timeout: 40000 });
await page.waitForTimeout(1200);

const send = (o) => page.evaluate((x) => window.__send(x), o);

/** 载入一份 XML，然后 export 回读；直到导出的图里出现期望的 cell 才认为 load 完成 */
async function loadAndExport(xml, expectedIds) {
    let mark = await page.evaluate(() => window.__msgs.length);
    await send({ action: "load", xml, autosave: 0 });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        await page.waitForTimeout(900);
        await send({ action: "export", format: "xml" });
        await page.waitForTimeout(900);
        const msgs = await page.evaluate((k) => window.__msgs.slice(k), mark);
        const got = msgs.filter((m) => m.event === "export").pop();
        if (!got) continue;
        const data = String(got.data || got.xml || "");
        const ids = Object.keys(extractCells(data));
        if (expectedIds.every((id) => ids.includes(id)) && ids.length >= expectedIds.length) return data;
    }
    return null;
}

const beforeXml = readFileSync(BEFORE, "utf8");
const afterXml = readFileSync(AFTER, "utf8");
const beforeIds = Object.keys(extractCells(beforeXml));
R.load.beforeCellIds = beforeIds;

const exportedBefore = await loadAndExport(beforeXml, beforeIds);
R.load.beforeLoaded = !!exportedBefore;
const exportedAfter = await loadAndExport(afterXml, beforeIds);
R.load.afterLoaded = !!exportedAfter;

if (exportedBefore && exportedAfter) {
    const b = extractCells(exportedBefore);
    const a = extractCells(exportedAfter);
    const d = diffCells(b, a);
    R.changed = { added: d.added, removed: d.removed, changed: d.changed, unchangedCount: d.unchanged.length };
    R.onlyIntended = d.added.length === 0 && d.removed.length === 0 && Object.keys(d.changed).length === 1 && Object.keys(d.changed)[0] === "2";
    console.log("drawio 回读后的差异：");
    console.log("  added=" + JSON.stringify(d.added) + " removed=" + JSON.stringify(d.removed));
    console.log("  changed=" + JSON.stringify(d.changed));
    console.log("  unchanged=" + d.unchanged.length + " 个元素");
    const id = Object.keys(d.changed)[0];
    if (id) console.log("  例：" + id + " " + JSON.stringify({ before: b[id].geometry, after: a[id].geometry }));
    // 我们的产出与 drawio 回读的一致性：改的那一项两边必须一致（说明 drawio 没有纠正/丢弃我们的改动）
    if (id) {
        const ourAfter = extractCells(afterXml)[id];
        R.load.ourChangeSurvived = eq(ourAfter.geometry, a[id].geometry) && eq(ourAfter.style, a[id].style);
    }
}
console.log("SPIKE_G_RESULT=" + JSON.stringify(R, null, 2));
await browser.close();
