// cat-demo 的坐标错位（用户报的那个）：拖拽框必须跟着鼠标走。
// 左边=修复后（框贴着鼠标） 右边=旧实现（框与鼠标错开 ~6%）。
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const CHROME = process.env.CHROME_PATH || "/usr/lib/chromium/chromium";
const OUT = process.env.SHOT_DIR || "/work/results/shots";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(process.env.PROTO_URL || "http://127.0.0.1:8787/", { waitUntil: "networkidle", timeout: 30000 });
await page.waitForSelector("#tree .row", { timeout: 15000 });
await page.selectOption("#sample", "cat-demo");
await page.waitForTimeout(1200);

// 挑一个元素，从它的屏幕左上角拖到右下角，**松手前**截图：框应该正好套住它
const t = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("#svg rect[data-id]")].map((el) => {
        const b = el.getBoundingClientRect();
        return { id: el.dataset.id, x: b.x, y: b.y, right: b.right, bottom: b.bottom };
    });
    const pad = 5, inside = (box, r) => r.x >= box.x && r.y >= box.y && r.right <= box.right && r.bottom <= box.bottom;
    return boxes.find((r) => !boxes.some((o) => o.id !== r.id && inside({ x: r.x - pad, y: r.y - pad, right: r.right + pad, bottom: r.bottom + pad }, o)));
});
await page.mouse.move(t.x - 5, t.y - 5);
await page.mouse.down();
await page.mouse.move((t.x + t.right) / 2, (t.y + t.bottom) / 2, { steps: 2 });
await page.mouse.move(t.right + 5, t.bottom + 5, { steps: 3 });
await page.waitForTimeout(150);
const box = await page.evaluate(() => {
    const last = document.querySelector("#svg").lastElementChild;
    return { x: Math.round(+last.getAttribute("x")), y: Math.round(+last.getAttribute("y")), w: Math.round(+last.getAttribute("width")), h: Math.round(+last.getAttribute("height")) };
});
await page.screenshot({ path: `${OUT}/4-cat-demo-drag.png` });
await page.mouse.up();
console.log("CAT_DRAG=" + JSON.stringify({ aimed: t.id, screenBox: [t.x, t.y, t.right, t.bottom].map(Math.round), drawnViewBox: box }));
await browser.close();
