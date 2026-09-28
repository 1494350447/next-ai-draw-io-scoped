/*
 * Phase 2 第一小步（生成式支路）：指令**没命中规则**时，插件是不是照样把模型产出的改动落地、
 * 并把"这次走的是大模型"如实告诉用户。
 *
 * 刻意不放进日常回归：它会真的调一次模型（有成本、结果不完全确定）。
 * 断言只看"结构性事实"：通道 = generative、通知文案提到大模型、只有选中元素被改。
 */
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const ENDPOINT = process.env.AI_SCOPE_ENDPOINT || "http://127.0.0.1:8787";
const INSTRUCTION = process.argv[2] || process.env.INSTRUCTION || "给这三个框都换成浅灰色的底";
const SHOTS = process.env.SHOT_DIR || "/work/results/shots";
const MXFILE = '<mxfile host="app.diagrams.net"><diagram name="Page-1"><mxGraphModel dx="800" dy="600" page="1" pageWidth="850" pageHeight="1100"><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Alpha" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="3" value="Beta" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="240" width="200" height="90" as="geometry"/></mxCell>' +
    '<mxCell id="4" value="Gamma" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="160" y="420" width="180" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="5" value="KeepMe" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;" vertex="1" parent="1"><mxGeometry x="600" y="520" width="140" height="60" as="geometry"/></mxCell>' +
    "</root></mxGraphModel></diagram></mxfile>";
let failures = 0;
const R = { instruction: INSTRUCTION, asserts: [] };
const ok = (n, c, extra) => { R.asserts.push({ name: n, pass: !!c, detail: extra }); if (!c) failures++; console.log(`ASSERT ${n}: ${c ? "通过" : "失败"}` + (c ? "" : " -> " + JSON.stringify(extra))); };

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const calls = [];
page.on("request", (r) => { if (r.url().includes("/api/instruct")) calls.push(r.url()); });
await page.goto("http://127.0.0.1:8080/?aiScopeDebug=1&ui=kennedy", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__aiScope && window.__aiScope.graph, null, { timeout: 45000 });
await page.evaluate((xml) => window.__aiScope.ui.setFileData(xml), MXFILE);
await page.waitForTimeout(600);

const before = await page.evaluate(() => window.__aiScope.xmlOf());
await page.evaluate(() => {
    const g = window.__aiScope.graph;
    g.setSelectionCells(["2", "3", "4"].map((id) => g.getModel().getCell(id)));
    window.__aiScope.openInstruct(null);
});
await page.waitForTimeout(400);
await page.fill('#aiScopeInstructPanel [data-role="ai-scope-input"]', INSTRUCTION);
await page.evaluate(() => document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-run"]').click());
await page.waitForFunction(() => {
    const el = document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]');
    return el && el.textContent && el.textContent.indexOf("→") >= 0;
}, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(800);
const result = await page.evaluate(() => document.querySelector('#aiScopeInstructPanel [data-role="ai-scope-result"]').textContent);
const after = await page.evaluate(() => window.__aiScope.xmlOf());
const cellOf = (xml, id) => { const m = new RegExp(`<mxCell id="${id}"[\\s\\S]*?</mxCell>`).exec(xml); return m ? m[0] : null; };
R.result = result;
R.beforeCells = { 2: cellOf(before, "2"), 5: cellOf(before, "5") };
R.afterCells = { 2: cellOf(after, "2"), 5: cellOf(after, "5") };
await page.screenshot({ path: `${SHOTS}/p2-4-generative.png` });

ok("指令没命中规则时，插件也真的调了局部编辑服务", calls.length > 0, calls);
ok("通知文案说明这次走的是大模型（不是假装成规则命中）", /大模型/.test(result || "") && /已应用/.test(result || ""), result);
// 模型怎么表达"挪一点"由它自己决定（可能改 Beta，也可能改别的选中元素），
// 所以这里只断言"被改的都在选中集合里、且至少改了一个"，不断言它选了谁。
const changed = ["2", "3", "4"].filter((id) => cellOf(after, id) !== cellOf(before, id));
R.changed = changed;
R.cellsBefore = Object.fromEntries(["2", "3", "4"].map((id) => [id, cellOf(before, id)]));
R.cellsAfter = Object.fromEntries(["2", "3", "4"].map((id) => [id, cellOf(after, id)]));
ok("模型产出的改动落到了画布上（选中的元素里至少变了一个）", changed.length > 0, { changed });
ok("没选中的参照物没被动", cellOf(after, "5") === cellOf(before, "5"), { before: cellOf(before, "5"), after: cellOf(after, "5") });
ok("画布整体结构没坏（四个元素都还在）", ["2", "3", "4", "5"].every((id) => cellOf(after, id)));
console.log("\nPHASE2_GEN_RESULT=" + JSON.stringify(R, null, 2));
console.log(failures === 0 ? "PHASE2_GEN_SUMMARY=ALL_PASS" : `PHASE2_GEN_SUMMARY=${failures}_FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
