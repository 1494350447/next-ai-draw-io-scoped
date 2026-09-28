// 确认单流程的视觉取证：预览（将改） / 取消 / 已应用 三张截图 + 关键 DOM 数值。
// 用法：./run.sh shots-confirm-flow.mjs   → 图落在 results/shots/
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const URL = process.env.PROTO_URL || "http://127.0.0.1:8787/";
const OUT = process.env.SHOT_DIR || "/work/results/shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errors.push(m.text().slice(0, 160)); });

await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForSelector("#tree .row", { timeout: 15000 });
await page.selectOption("#sample", "small-flow");
await page.waitForTimeout(900);
await page.click("#sel-vertices");
await page.waitForTimeout(700);

const clickCmd = (text) => page.evaluate((t) => {
    const b = [...document.querySelectorAll("#cmds button")].find((x) => x.textContent.trim() === t);
    if (!b) throw new Error("找不到命令：" + t);
    b.click();
}, text);
const snap = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const xmlBefore = await page.evaluate(() => document.querySelector("#out").value);
const probe = () => page.evaluate((b) => ({
    outChanged: document.querySelector("#out").value !== b,
    applyBtn: !!document.querySelector("#apply-btn"),
    rings: document.querySelectorAll("svg rect.hl").length,
    marks: [...document.querySelectorAll("svg text")].map((t) => t.textContent).filter((t) => /^(改|新|将改|将增)$/.test(t)),
    status: (document.querySelector("#report").textContent.match(/结果\\s*(\\S+)/) ?? [])[1] ?? null,
    lines: document.querySelectorAll("#svg line").length,
}), xmlBefore);

await clickCmd("左对齐");
await page.waitForTimeout(1000);
const preview = await probe();
await snap("1-preview");

await page.click("#cancel-btn");
await page.waitForTimeout(1000);
const cancelled = await probe();
await snap("2-cancelled");

await clickCmd("左对齐");
await page.waitForTimeout(1000);
await page.click("#apply-btn");
await page.waitForTimeout(1200);
const applied = await probe();
await snap("3-applied");

console.log("SHOTS_RESULT=" + JSON.stringify({ preview, cancelled, applied, errors }, null, 2));
await browser.close();
