// S1 spike 验证 C：真实产品页面（Next.js app :3000）里的 drawio iframe 是否自动带上适配插件。
// 这是最关键的一条：插件挂在 drawio 的 origin 上，app 侧不改一行代码就应该生效。
//
// 2026-09-24 重写：插件改成由 compose 只读挂载的 PreConfig.js 注入，且调试全局只在 ?aiScopeDebug=1 时暴露。
// 真实 app 的 embed URL 由上游代码决定、我们插不进参数，所以本脚本**只用生产通道**（embed 协议 +
// 插件自己 postMessage 回宿主的事件），不再读 window.__aiScope。
// 顺便做成非破坏性的：先把 app 当前图 export 出来，测完再 load 回去。
import { chromium } from "playwright";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const APP = process.env.APP_URL || "http://127.0.0.1:3000/";
const PAGE1 = "PAGE1";
const TEST_XML = `<mxfile host="app"><diagram id="${PAGE1}" name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" pageHeight="1100"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="spike-1" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="70" as="geometry"/></mxCell><mxCell id="3" value="spike-2" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="120" width="160" height="70" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;

const R = { app: APP, embedUrl: null, ready: null, originalLen: null, roundTrip: null, realClick: null, restored: false, errors: [] };
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => R.errors.push(String(e.message).slice(0, 160)));
// 在 app 页面装上监听：插件应该把消息 postMessage 给 app 窗口（跨 origin）
await page.addInitScript(() => {
    window.__msgs = [];
    window.addEventListener("message", (e) => {
        let m;
        try { m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch (_) { return; }
        if (m && m.event) window.__msgs.push(m);
    });
});

await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("app 已打开: " + (await page.title()));

let frame = null;
for (let i = 0; i < 60 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes("embed=1"));
    if (!frame) await page.waitForTimeout(1000);
}
if (!frame) {
    R.errors.push("app 里没找到 drawio iframe");
    console.log("SPIKE_C_RESULT=" + JSON.stringify(R, null, 2));
    await browser.close();
    process.exit(1);
}
R.embedUrl = frame.url();
console.log("app 内 drawio frame: " + frame.url());
console.log("embed URL 里有 ?plugins= 吗: " + /[?&]plugins=/.test(frame.url()) + " / 有 aiScopeDebug 吗: " + /aiScopeDebug/.test(frame.url()));

const send = (o) => page.evaluate((x) => { document.querySelector("iframe").contentWindow.postMessage(JSON.stringify(x), "*"); }, o);
const msgsSince = (n) => page.evaluate((k) => window.__msgs.slice(k), n);
async function waitFor(pred, timeout = 8000) {   // pred 在 page 上下文里跑
    await page.waitForFunction(pred, null, { timeout });
}

// ---- 1. 插件零改造自动生效 ----
try {
    await waitFor(() => window.__msgs.some((m) => m.event === "aiScopeReady"), 45000);
    R.ready = await page.evaluate(() => window.__msgs.find((m) => m.event === "aiScopeReady"));
    console.log(">>> app 窗口收到 aiScopeReady：" + JSON.stringify(R.ready));
} catch (e) {
    R.errors.push("插件未加载（没等到 aiScopeReady）: " + e.message);
    console.log("SPIKE_C_RESULT=" + JSON.stringify(R, null, 2));
    await browser.close();
    process.exit(1);
}

// ---- 2. 备份 app 当前图，载入测试图（非破坏性：最后会 load 回去）----
let n = await page.evaluate(() => window.__msgs.length);
await send({ action: "export", format: "xml" });
await page.waitForTimeout(2000);
const exported = (await msgsSince(n)).find((m) => m.event === "export");
const original = exported ? String(exported.data || exported.xml || "") : "";
R.originalLen = original.length;
await send({ action: "load", xml: TEST_XML, autosave: 1 });
await page.waitForTimeout(2500);
console.log("已备份 app 当前图（" + original.length + " 字符）并载入测试图");

// ---- 3. 跨 origin 往返：app 窗口 -> 编辑器动作 -> 回到 app 窗口 ----
n = await page.evaluate(() => window.__msgs.length);
await send({ action: "invokeAction", actionName: "aiScopeSelectTop" });
try {
    await waitFor((k) => window.__msgs.slice(k).some((m) => m.event === "aiScope"), 8000, n);
} catch (e) { R.errors.push("等 aiScope 回传超时: " + e.message); }
await page.waitForTimeout(500);
R.roundTrip = (await msgsSince(n)).filter((m) => m.event === "aiScope").map((m) => ({ reason: m.reason, count: m.count, ids: m.ids, undoDepth: m.undoDepth, version: m.version }));
console.log("跨 origin 往返（invokeAction aiScopeSelectTop）：" + JSON.stringify(R.roundTrip));

// ---- 4. 真实鼠标点击：插件应该把它当成用户交互并 push 选区 ----
// 这里读不到画布的坐标变换（不碰调试全局），所以按"候选点扫描"来点：
// 测试图的两个节点在图上坐标 (120,120,160x70) / (420,120,160x70)，100% 缩放下屏幕位置就在这附近。
const box = await (await frame.frameElement()).boundingBox();
const candidates = [];
for (const y of [150, 175, 200, 225, 250]) for (const x of [160, 200, 240, 280]) candidates.push([x, y]);
R.realClick = [];
for (const [x, y] of candidates) {
    n = await page.evaluate(() => window.__msgs.length);
    await page.mouse.click(box.x + x, box.y + y);
    await page.waitForTimeout(700);
    const pushed = (await msgsSince(n)).filter((m) => m.event === "aiScope" && m.reason === "selectionChanged");
    const hit = pushed.find((m) => m.count === 1);
    R.realClick.push({ 尝试坐标: [x, y], 推送: pushed.map((m) => ({ count: m.count, ids: m.ids })) });
    if (hit) {
        R.realClickHit = { 坐标: [x, y], 选区: hit.ids, count: hit.count };
        console.log("真实点击命中节点：" + JSON.stringify(R.realClickHit));
        break;
    }
}
if (!R.realClickHit) R.errors.push("候选点都没选中单个节点（可能缩放/偏移与预期不同）");
console.log("真实点击明细：" + JSON.stringify(R.realClick));

// ---- 5. 还原 app 原来的图 ----
if (original) {
    await send({ action: "load", xml: original, autosave: 1 });
    await page.waitForTimeout(2500);
    R.restored = true;
    console.log("已还原 app 原来的图（" + original.length + " 字符）");
}
R.allEventsSeenByApp = await page.evaluate(() => Array.from(new Set(window.__msgs.map((m) => m.event))));

console.log("\nSPIKE_C_RESULT=" + JSON.stringify(R, null, 2));
await browser.close();
