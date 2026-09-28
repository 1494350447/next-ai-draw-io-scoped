// Phase 1 前端冒烟：用真实浏览器把 prototype 页面跑一遍（改过 badge/token 账单，必须验一遍别搞坏）。
// 容器用 --network host，所以能直接访问宿主机的 127.0.0.1:8787。
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const URL = process.env.PROTO_URL || "http://127.0.0.1:8787/";
const R = { url: URL, errors: [], badges: {}, tree: null, afterSelectAll: {}, svgRects: null };
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on("pageerror", (e) => R.errors.push(String(e.message).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") R.errors.push("console: " + m.text().slice(0, 200)); });
page.on("requestfailed", (r) => R.errors.push("reqfail " + r.url()));
page.on("response", (r) => { if (r.status() >= 400) R.errors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForSelector("#tree .row", { timeout: 15000 });
R.tree = await page.evaluate(() => ({
    rows: document.querySelectorAll("#tree .row").length,
    writable: document.querySelectorAll("#tree .row.writable").length,
    context: document.querySelectorAll("#tree .row.context").length,
    skeleton: document.querySelectorAll("#tree .row.skeleton").length,
}));
const readBadges = () => page.evaluate(() => ({
    cells: document.querySelector("#b-cells").textContent.trim(),
    scope: document.querySelector("#b-scope").textContent.trim(),
    token: document.querySelector("#b-token").textContent.trim(),
    tokenTitle: document.querySelector("#b-token").title.replace(/\n/g, " | "),
    guard: document.querySelector("#b-guard").textContent.trim(),
}));
R.badges.beforeSelect = await readBadges();

// 切到含嵌套容器的真实图 + 勾选一个容器（作用域应当覆盖子孙）
await page.selectOption("#sample", "aws-demo");
await page.waitForTimeout(1200);
await page.click("#sel-vertices");
await page.waitForTimeout(1200);
R.afterSelectAll = await readBadges();

// 点一个确定性命令，看 guard 报告
const cmds = await page.$$("#cmds button");
R.commandButtons = cmds.length;
if (cmds.length) {
    await page.check("#confirm-mode");      // 确认单现在是**可选**路径（默认直接应用）
    await cmds[0].click();
    await page.waitForTimeout(1500);
    R.badges.afterCommand = await readBadges();
    // 命令现在只产生"确认单"，不直接落盘：当前 XML 必须**原封不动**
    R.confirmAfterCommand = await page.evaluate(() => ({
        bar: /确认单：将改 \d+ 个元素/.test(document.querySelector("#report").textContent),
        applyBtn: !!document.querySelector("#apply-btn"),
        outLen: document.querySelector("#out").value.length,
        hl: document.querySelectorAll("svg rect.hl").length,
        marks: [...document.querySelectorAll("svg text")].filter((t) => /^(将改|将增)$/.test(t.textContent)).length,
    }));
    R.report = await page.evaluate(() => document.querySelector("#report").textContent.slice(0, 300));
    R.outLen = R.confirmAfterCommand.outLen;
    await page.uncheck("#confirm-mode");    // 后面的用例走默认的"直接应用"
}
R.svgRects = await page.evaluate(() => document.querySelectorAll("#svg rect, #svg path").length);
// 连线必须真的画出来：数据契约漏了 source/target 时，前端会静默地一条线都不画（接口全绿）
R.edges = await page.evaluate(() => ({
    lines: document.querySelectorAll("#svg line").length,
    withArrow: document.querySelectorAll("#svg line[marker-end]").length,
    abstractEdges: 2,                     // aws-demo 里就是 2 条边（8、9）
}));

// ---- 预览交互（点空白清空 / 点元素切换 / 点标签不算空白 / 拖拽框选 / Shift 加选 / Esc 清空）----
await page.selectOption("#sample", "small-flow");
await page.waitForTimeout(1000);
const countWritable = () => page.evaluate(() => document.querySelectorAll("#tree .row.writable").length);
// 注意：作用域 = 选中元素 ∪ 与它们相连的边（includeEdges 默认开），所以"选中了几个"要看 roots，
// 不能看 writable —— 否则框 1 个顶点会得到 2（顶点 + 它的边）。
const countRoots = () => page.evaluate(() => Number((document.querySelector("#b-scope").textContent.match(/roots\s*(\d+)/) || [])[1] ?? -1));
const svgBox = await page.evaluate(() => { const r = document.querySelector("#svg").getBoundingClientRect(); return { x: r.x, y: r.y }; });
const mid = (r) => ({ x: Math.round((r.x + r.right) / 2), y: Math.round((r.y + r.bottom) / 2) });
const rectsOf = () => page.evaluate(() => [...document.querySelectorAll("#svg rect[data-id]")].map((el) => {
    const b = el.getBoundingClientRect();
    return { id: el.dataset.id, x: b.x, y: b.y, right: b.right, bottom: b.bottom, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
}));
const dragBox = async (from, to, shift = false) => {
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 3 });
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
    await page.waitForTimeout(500);
};

const inter = {};
const rowHas = (id) => page.evaluate((i) => {
    const row = [...document.querySelectorAll("#tree .row")].find((r) => r.querySelector(".id").textContent === i);
    return row ? row.className.split(/\s+/).includes("writable") : null;
}, id);
/** 屏幕上这个点最上层是谁 —— 点选命中的就是它（SVG 和 draw.io 一样：后画的盖住先画的） */
const topIdAt = (x, y) => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-id]")?.dataset.id ?? null, { x, y });

// ① 全选后点空白 → 清空
await page.click("#sel-vertices");
await page.waitForTimeout(600);
inter.beforeClickEmpty = await countWritable();
await page.mouse.click(Math.round(svgBox.x + 3), Math.round(svgBox.y + 3));   // viewBox 有 40 的留白，角落必然是空白
await page.waitForTimeout(600);
inter.afterClickEmpty = await countWritable();

// ② 点元素 → 选中"屏幕上最上层的那一个"（本例里 cell 10 被更大的 cell 13 盖住，所以命中的是 13 —— 和 draw.io 的叠放规则一致）
const rects = await rectsOf();
const aim = mid(rects[0]);
const aimedAt = rects[0].id;
const expectedHit = await topIdAt(aim.x, aim.y);
await page.mouse.click(aim.x, aim.y);
await page.waitForTimeout(500);
inter.afterClickElement = { aimedAt, expectedHit, roots: await countRoots(), hitSelected: await rowHas(expectedHit) };
await page.mouse.click(aim.x, aim.y);
await page.waitForTimeout(500);
inter.afterClickSameElement = await countRoots();          // 再点一次 = 取消

// ③ 点**文字标签** → 应该选中该元素，而不是被当成点空白清空
const label = await page.evaluate(() => {
    for (const el of document.querySelectorAll("#svg text[data-id]")) {
        const b = el.getBoundingClientRect();
        const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
        const top = document.elementFromPoint(x, y)?.closest("[data-id]")?.dataset.id;
        if (top === el.dataset.id) return { id: el.dataset.id, x, y };   // 只挑"确实在最上层"的标签，否则测的是别的元素
    }
    return null;
});
inter.labelVerifiable = !!label;
if (label) {
    await page.mouse.click(label.x, label.y);
    await page.waitForTimeout(500);
    inter.afterClickLabel = { id: label.id, roots: await countRoots(), selected: await rowHas(label.id) };
}

// ④ Esc → 清空
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
inter.afterEscape = await countRoots();

// ⑤⑥⑦ 拖拽框选：挑两个"被框住时不会捎带别人"的元素
// （框选是**几何**判定，不看叠放顺序；但框要大一点才好拖，所以先筛掉会捎带别的元素的）
const margin = 3;
const expand = (r) => ({ x: r.x - margin, y: r.y - margin, right: r.right + margin, bottom: r.bottom + margin });
const insideBox = (box, r) => r.x >= box.x && r.y >= box.y && r.right <= box.right && r.bottom <= box.bottom;
const boxable = rects.filter((r) => !rects.some((o) => o.id !== r.id && insideBox(expand(r), o)));
inter.boxable = boxable.map((r) => r.id);
const [A, B] = boxable;
const boxOf = (r) => ({ from: { x: Math.round(r.x - margin), y: Math.round(r.y - margin) }, to: { x: Math.round(r.right + margin), y: Math.round(r.bottom + margin) } });

await dragBox(boxOf(A).from, boxOf(A).to);
inter.afterDragSelect = { boxed: A.id, roots: await countRoots(), selected: await rowHas(A.id) };

await dragBox(boxOf(B).from, boxOf(B).to);                 // 不按 Shift：必须替换掉上一个
inter.afterDragSecond = { boxed: B.id, roots: await countRoots(), selectedB: await rowHas(B.id), stillHasA: await rowHas(A.id) };

await dragBox(boxOf(A).from, boxOf(A).to, true);           // Shift：加回来
inter.afterShiftDrag = { roots: await countRoots(), hasA: await rowHas(A.id), hasB: await rowHas(B.id) };

R.interactions = inter;
const okEmpty = inter.beforeClickEmpty > 0 && inter.afterClickEmpty === 0;
const okElement = inter.afterClickElement.roots === 1 && inter.afterClickElement.hitSelected === true
    && inter.afterClickSameElement === 0;
const okLabel = inter.afterClickLabel ? (inter.afterClickLabel.roots === 1 && inter.afterClickLabel.selected === true) : true;
const okEscape = inter.afterEscape === 0;
const okDrag = inter.afterDragSelect.roots === 1 && inter.afterDragSelect.selected === true;
const okReplace = inter.afterDragSecond.roots === 1 && inter.afterDragSecond.selectedB === true && inter.afterDragSecond.stillHasA === false;
const okShift = inter.afterShiftDrag.roots === 2 && inter.afterShiftDrag.hasA === true && inter.afterShiftDrag.hasB === true;
const okEdges = R.edges.lines === R.edges.abstractEdges && R.edges.withArrow === R.edges.abstractEdges;
console.log("ASSERT 预览画出连线(端点数据没丢): " + (okEdges ? "通过" : "失败 " + JSON.stringify(R.edges)));
console.log("ASSERT 点空白清空: " + (okEmpty ? "通过" : "失败 " + JSON.stringify(inter)));
console.log("ASSERT 点元素切换: " + (okElement ? "通过" : "失败 " + JSON.stringify(inter)));
console.log("ASSERT 点标签=点元素: " + (okLabel ? "通过" : "失败 " + JSON.stringify(inter)));
console.log("ASSERT Esc 清空: " + (okEscape ? "通过" : "失败 " + JSON.stringify(inter)));
console.log("ASSERT 拖拽框选: " + (okDrag ? "通过" : "失败 " + JSON.stringify(inter)));
console.log("ASSERT 框选替换(不按 Shift): " + (okReplace ? "通过" : "失败 " + JSON.stringify(inter)));
console.log("ASSERT Shift 加选: " + (okShift ? "通过" : "失败 " + JSON.stringify(inter)));

// ---- 坐标换算：屏幕像素 ↔ viewBox 必须在**每个样例**上都成立 ----
// 为什么每个样例都要验：SVG 是 `preserveAspectRatio="xMinYMin meet"`，等比缩放的约束轴因图而异 ——
// viewBox 比面板"更宽"的图（small-flow / aws-demo）约束轴是宽度，恰好和"按宽度算缩放"一致；
// cat-demo（520×600 放进 779×841）约束轴是**高度**，按宽度算出来的缩放偏小 6.4%，鼠标位置和画面就错开了。
// 断言用的是"把元素的屏幕包围盒拖出来，就该只选中它" —— 纯行为，不依赖任何内部换算实现。
const coords = {};
for (const sample of ["small-flow", "aws-demo", "cat-demo"]) {
    await page.selectOption("#sample", sample);
    await page.waitForTimeout(1000);
    const target = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll("#svg rect[data-id]")].map((el) => {
            const b = el.getBoundingClientRect();
            return { id: el.dataset.id, x: b.x, y: b.y, right: b.right, bottom: b.bottom };
        });
        const pad = 5;
        const inside = (box, r) => r.x >= box.x && r.y >= box.y && r.right <= box.right && r.bottom <= box.bottom;
        // 只挑"放大 5px 之后仍然不会捎带别人"的元素，这样"只选中它"才是干净的判据
        return boxes.find((r) => !boxes.some((o) => o.id !== r.id
            && inside({ x: r.x - pad, y: r.y - pad, right: r.right + pad, bottom: r.bottom + pad }, o))) ?? null;
    });
    if (!target) { coords[sample] = { skipped: "没有可安全框选的元素" }; continue; }
    await dragBox({ x: target.x - 5, y: target.y - 5 }, { x: target.right + 5, y: target.bottom + 5 });
    const roots = await countRoots();
    const selected = await rowHas(target.id);
    const bar = await page.evaluate(() => {
        const b = document.querySelector("#floatbar");
        return b.hidden ? null : { left: Math.round(b.getBoundingClientRect().left), bottom: Math.round(b.getBoundingClientRect().bottom) };
    });
    coords[sample] = {
        aimed: target.id, roots, selected,
        floatbar: bar ? { onSameSide: bar.left >= target.x - 160 && bar.left <= target.right + 40, above: bar.bottom <= target.y + 2 } : null,
    };
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
}
R.coords = coords;
for (const [sample, c] of Object.entries(coords)) {
    const ok = !c.skipped && c.roots === 1 && c.selected === true
        && (!c.floatbar || (c.floatbar.onSameSide && c.floatbar.above));
    console.log(`ASSERT 坐标换算-${sample}(框住谁就选中谁): ` + (ok ? "通过" : "失败 " + JSON.stringify(c)));
}

// ---- 悬浮指令输入（规则分流）----
await page.selectOption("#sample", "aws-demo");
await page.waitForTimeout(900);
await page.click("#sel-layer");
await page.waitForTimeout(900);
const instr = {};
instr.barVisible = await page.evaluate(() => !document.querySelector("#floatbar").hidden);
instr.count = await page.evaluate(() => document.querySelector("#fl-count").textContent);

// ① 命中规则的指令：就地执行（不走模型），**直接应用**，只用一句话告知走的是规则
const xmlBeforeInstr = await page.evaluate(() => document.querySelector("#out").value);
await page.fill("#instr", "都变成绿色");
await page.keyboard.press("Enter");
await page.waitForTimeout(1300);
instr.hintAfterHit = await page.evaluate(() => document.querySelector("#instr-hint").textContent.trim());
instr.hitLedger = await page.evaluate(() => /fillColor/.test(document.querySelector("#report").textContent));
instr.hlAfterInstr = await page.evaluate(() => document.querySelectorAll("svg rect.hl").length);
instr.inputCleared = await page.evaluate(() => document.querySelector("#instr").value === "");
instr.appliedDirectly = await page.evaluate((b) => document.querySelector("#out").value !== b, xmlBeforeInstr);
instr.undoAvailable = await page.evaluate(() => !!document.querySelector("#undo-btn"));
instr.channelRow = await page.evaluate(() => /确定性规则/.test(document.querySelector("#report").textContent));

// ② 没命中规则的指令：**自动**交给模型（不再需要用户点"交给模型"），结果直接应用，只告知通道
const xmlBeforeMiss = await page.evaluate(() => document.querySelector("#out").value);
await page.fill("#instr", "把这个流程拆成两个服务");
await page.keyboard.press("Enter");
// 这一步会真的调一次模型，给它宽裕的时间
await page.waitForFunction(() => /大模型|未配置|被拒|失败/.test(document.querySelector("#instr-hint").textContent),
    null, { timeout: 120000 });
await page.waitForTimeout(600);
instr.missHint = await page.evaluate(() => document.querySelector("#instr-hint").textContent.trim());
instr.missNoManualButton = await page.evaluate(() => !document.querySelector("#gen-btn"));
instr.missApplied = await page.evaluate((b) => document.querySelector("#out").value !== b, xmlBeforeMiss);
instr.missReport = await page.evaluate(() => document.querySelector("#report").textContent.replace(/\s+/g, " ").slice(0, 400));

// ③ 右键元素 → 自动选中它并唤起悬浮框
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const rightTarget = await page.evaluate(() => {
    const el = [...document.querySelectorAll("#svg rect[data-id]")].pop();
    const b = el.getBoundingClientRect();
    return { id: el.dataset.id, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
});
await page.mouse.click(rightTarget.x, rightTarget.y, { button: "right" });
await page.waitForTimeout(800);
instr.rightClick = {
    barVisible: await page.evaluate(() => !document.querySelector("#floatbar").hidden),
    roots: await countRoots(),
    focused: await page.evaluate(() => document.activeElement?.id === "instr"),
};
R.instructions = instr;
const okBar = instr.barVisible && Number(instr.count) > 0;
const okHit = /确定性规则/.test(instr.hintAfterHit) && /没有调用模型/.test(instr.hintAfterHit)
    && instr.hitLedger && instr.hlAfterInstr > 0 && instr.inputCleared
    && instr.appliedDirectly && instr.undoAvailable && instr.channelRow;
// 未命中 = 自动走模型：要能一句话说清"走的大模型"，且结果已经落地（不需要用户再点一次）
const okMiss = /大模型/.test(instr.missHint) && instr.missNoManualButton && instr.missApplied;
const okRight = instr.rightClick.barVisible && instr.rightClick.roots >= 1;
console.log("ASSERT 悬浮指令框跟随选区: " + (okBar ? "通过" : "失败 " + JSON.stringify(instr)));
console.log("ASSERT 指令命中→走规则并直接应用: " + (okHit ? "通过" : "失败 " + JSON.stringify(instr)));
console.log("ASSERT 指令未命中→自动走模型并直接应用: " + (okMiss ? "通过" : "失败 " + JSON.stringify(instr)));
console.log("ASSERT 右键唤起指令框: " + (okRight ? "通过" : "失败 " + JSON.stringify(instr)));

// ---- 改动高亮 + 改动账本 + 撤销本轮 ----
await page.selectOption("#sample", "small-flow");
await page.waitForTimeout(900);
await page.click("#sel-vertices");
await page.waitForTimeout(700);
const xmlBefore = await page.evaluate(() => document.querySelector("#out").value);
const clickCmd = (text) => page.evaluate((t) => {
    const b = [...document.querySelectorAll("#cmds button")].find((x) => x.textContent.trim() === t);
    if (!b) throw new Error("找不到命令按钮：" + t);
    b.click();
}, text);

await page.check("#confirm-mode");     // 这一段专测可选的"先预览再应用"
// ① 取消：预览不写入，画布回到当前 XML
await clickCmd("左对齐");
await page.waitForTimeout(1000);
const cancel = {
    previewed: await page.evaluate(() => !!document.querySelector("#apply-btn")),
    hlWhilePreview: await page.evaluate(() => document.querySelectorAll("svg rect.hl").length),
    xmlKept: await page.evaluate((b) => document.querySelector("#out").value === b, xmlBefore),
};
cancel.rootsBefore = await countRoots();
await page.keyboard.press("Escape");          // 预览中 Esc = 取消这次预览（不是清空选择）
await page.waitForTimeout(900);
cancel.hlAfterCancel = await page.evaluate(() => document.querySelectorAll("svg rect.hl").length);
cancel.barGone = await page.evaluate(() => !document.querySelector("#apply-btn"));
cancel.xmlStillKept = await page.evaluate((b) => document.querySelector("#out").value === b, xmlBefore);
cancel.selectionKept = await countRoots();
cancel.reportSaysCancelled = await page.evaluate(() => /已取消/.test(document.querySelector("#report").textContent));

// ② 选区一变，预览立即作废（否则"应用"落地的会是针对旧选区算的那一版），且**面板要跟着更新**
await clickCmd("左对齐");
await page.waitForTimeout(900);
const beforeStale = await page.evaluate(() => !!document.querySelector("#apply-btn"));
await page.click("#sel-none");     // 只改选区，不碰 XML
await page.waitForTimeout(900);
const stale = {
    hadPreview: beforeStale,
    applyGone: await page.evaluate(() => !document.querySelector("#apply-btn")),
    warned: await page.evaluate(() => /预览已作废/.test(document.querySelector("#report").textContent)),
    xmlKept: await page.evaluate((b) => document.querySelector("#out").value === b, xmlBefore),
};

// ③ 应用：这一步才真正落盘
await page.click("#sel-vertices");     // 恢复到"全选顶点"（和刚才那次预览同一选区）
await page.waitForTimeout(700);
await clickCmd("左对齐");
await page.waitForTimeout(900);
await page.click("#apply-btn");
await page.waitForTimeout(1000);
const edit = {};
edit.cancel = cancel;
edit.stale = stale;
edit.hlRings = await page.evaluate(() => document.querySelectorAll("svg rect.hl").length);      // 高亮圈
edit.hlTags = await page.evaluate(() => [...document.querySelectorAll("svg text")].filter((t) => t.textContent === "改").length);
edit.ledgerInReport = await page.evaluate(() => /改动账本 · (\d+) 个元素/.exec(document.querySelector("#report").textContent)?.[1] ?? null);
edit.xmlChanged = await page.evaluate((b) => document.querySelector("#out").value !== b, xmlBefore);
edit.hasUndoButton = await page.evaluate(() => !!document.querySelector("#undo-btn"));
edit.scopeBadge = await page.evaluate(() => document.querySelector("#b-scope").textContent.trim());

await page.click("#undo-btn");
await page.waitForTimeout(1000);
const undo1 = {};
undo1.xmlBack = await page.evaluate((b) => document.querySelector("#out").value === b, xmlBefore);
undo1.hlGone = await page.evaluate(() => document.querySelectorAll("svg rect.hl").length);
undo1.noMoreUndo = await page.evaluate(() => !document.querySelector("#undo-btn"));

await page.uncheck("#confirm-mode");   // 回到默认：直接应用（不再有"应用"按钮可点）
// Ctrl+Z 也要能撤销（走键盘，不走按钮）
await clickCmd("平移选中");
await page.waitForTimeout(900);
const afterMove = await page.evaluate(() => document.querySelector("#out").value);
await page.keyboard.press("Control+z");
await page.waitForTimeout(1000);
const undo2 = {
    moved: afterMove !== xmlBefore,
    xmlBack: await page.evaluate((b) => document.querySelector("#out").value === b, xmlBefore),
    hlGone: await page.evaluate(() => document.querySelectorAll("svg rect.hl").length),
};
R.highlightUndo = { edit, undo1, undo2 };
const okCancel = cancel.previewed && cancel.hlWhilePreview > 0 && cancel.xmlKept
    && cancel.hlAfterCancel === 0 && cancel.barGone && cancel.xmlStillKept
    && cancel.selectionKept === cancel.rootsBefore && cancel.reportSaysCancelled;
const okStale = stale.hadPreview && stale.applyGone && stale.warned && stale.xmlKept;
const okHl = edit.hlRings > 0 && edit.hlRings === edit.hlTags && edit.hlRings === Number(edit.ledgerInReport);
const okLedger = edit.ledgerInReport !== null && edit.xmlChanged && edit.hasUndoButton;
const okUndo = undo1.xmlBack && undo1.hlGone === 0 && undo1.noMoreUndo;
const okCtrlZ = undo2.moved && undo2.xmlBack && undo2.hlGone === 0;
console.log("ASSERT 确认单-取消(Esc 不写入且保留选区): " + (okCancel ? "通过" : "失败 " + JSON.stringify(cancel)));
console.log("ASSERT 确认单-选区一变即作废: " + (okStale ? "通过" : "失败 " + JSON.stringify(stale)));
console.log("ASSERT 确认单-命令只出单不落盘: " + (R.confirmAfterCommand?.bar && R.confirmAfterCommand?.applyBtn && R.confirmAfterCommand?.hl > 0 && R.confirmAfterCommand?.marks > 0 ? "通过" : "失败 " + JSON.stringify(R.confirmAfterCommand)));
console.log("ASSERT 改动高亮(圈数=账本数): " + (okHl ? "通过" : "失败 " + JSON.stringify(R.highlightUndo)));
console.log("ASSERT 改动账本: " + (okLedger ? "通过" : "失败 " + JSON.stringify(R.highlightUndo)));
console.log("ASSERT 撤销本轮按钮: " + (okUndo ? "通过" : "失败 " + JSON.stringify(R.highlightUndo)));
console.log("ASSERT Ctrl+Z 撤销: " + (okCtrlZ ? "通过" : "失败 " + JSON.stringify(R.highlightUndo)));

// ---- 回归断言 ----
// ① 大纲行不能重复（曾经因为把默认层 "1" 也当普通元素，每行被渲染两遍）
R.dupCheck = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("#tree .row .id")].map((e) => e.textContent);
    return { rows: ids.length, unique: new Set(ids).size, duplicated: ids.filter((v, i) => ids.indexOf(v) !== i) };
});
// ② 空选区首屏必须可用（曾经直接 500 → 大纲永远渲染不出来）
R.firstLoadUsable = R.tree.rows > 0 && R.tree.skeleton === R.tree.rows;
// ③ 控制台只允许 favicon 的 404
R.unexpectedErrors = R.errors.filter((e) => !/404/.test(e));
console.log("ASSERT 行数去重: " + (R.dupCheck.rows === R.dupCheck.unique ? "通过" : "失败 " + JSON.stringify(R.dupCheck)));
console.log("ASSERT 空选区首屏可用: " + (R.firstLoadUsable ? "通过" : "失败"));
console.log("ASSERT 无意外错误: " + (R.unexpectedErrors.length === 0 ? "通过" : "失败 " + JSON.stringify(R.unexpectedErrors)));
console.log("SMOKE_RESULT=" + JSON.stringify(R, null, 2));
await browser.close();
