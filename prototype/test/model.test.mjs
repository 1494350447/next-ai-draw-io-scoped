import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiagram, parseStyle, serializeStyle, labelOf } from "../src/model.mjs";
import { sample } from "./helpers.mjs";

test("真实图（aws-demo）的父子关系与端点解析正确", () => {
    const d = parseDiagram(sample("aws-demo"));
    assert.match(d.pageId, /^[A-Za-z0-9_-]{16,}$/);   // drawio 生成的 diagram id
    assert.equal(d.pageName, "Page-1");
    assert.equal([...d.cells.values()].filter((c) => c.isVertex).length, 7);
    assert.equal([...d.cells.values()].filter((c) => c.isEdge).length, 2);
    // 容器嵌套：EC2(5) 在 Public Subnet(4) 里
    assert.equal(d.get("5").parent, "4");
    assert.deepEqual(d.ancestors("5").slice(0, 3), ["4", "3", "2"]);
    assert.deepEqual(d.descendants("3"), ["4", "5"]);
    // 边的端点
    const e8 = d.get("8");
    assert.equal(e8.source, "7");
    assert.equal(e8.target, "6");
    assert.deepEqual(d.edgesOf("6").map((c) => c.id).sort(), ["8", "9"]);
});

test("自由绘制的图（cat-demo）里没有端点的边不会炸", () => {
    const d = parseDiagram(sample("cat-demo"));
    const edges = [...d.cells.values()].filter((c) => c.isEdge);
    assert.ok(edges.length > 0);
    assert.ok(edges.every((c) => c.source === null && c.target === null));
    assert.equal(d.edgesOf("2").length, 0);
});

test("样式字符串解析/序列化可逆（保留顺序与无值 flag）", () => {
    const style = "rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=none;";
    const map = parseStyle(style);
    assert.equal(map.get("html"), "1");
    assert.equal(map.get("fillColor"), "#dae8fc");
    assert.equal(serializeStyle(map), style);
    assert.equal(serializeStyle(parseStyle("rounded;shadow;")), "rounded;shadow;");
});

test("value 为空时用形状/端点兜底出可读标签", () => {
    const d = parseDiagram(sample("cat-demo"));
    assert.match(labelOf(d.get("2")), /ellipse/);
    assert.match(labelOf(d.get("8")), /→/);
});

test("几何信息解析正确（含容器相对坐标）", () => {
    const d = parseDiagram(sample("aws-demo"));
    assert.deepEqual(
        [d.get("5").geometry.x, d.get("5").geometry.y, d.get("5").geometry.width, d.get("5").geometry.height],
        [126, 50, 68, 68],
    );
    assert.equal(d.get("8").geometry.relative, true);
});

test("压缩载荷会明确报错，而不是静默产生错数据", () => {
    const compressed = '<mxfile><diagram id="x" name="P">7Vpbc9o4FP41zLQP</diagram></mxfile>';
    assert.throws(() => parseDiagram(compressed), /压缩载荷/);
});
