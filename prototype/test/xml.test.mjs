import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml, setAttr, applyPatches, encodeAttr, decodeEntities } from "../src/xml.mjs";
import { sample } from "./helpers.mjs";

test("实体编解码可逆（含换行走 &#10;）", () => {
    const raw = 'a & b < c > d "e" f\ng';
    assert.equal(decodeEntities(encodeAttr(raw)), raw);
});

test("保偏移解析：每个节点的切片都能在原文里原样取回", () => {
    const text = sample("aws-demo");
    const { root, nodes } = parseXml(text);
    for (const node of nodes) {
        const slice = text.slice(node.start, node.end);
        assert.ok(slice.startsWith(`<${node.name}`), `${node.name} 起始不匹配`);
        assert.ok(slice.endsWith(">"), `${node.name} 结束不匹配`);
        if (!node.selfClosing) assert.ok(slice.endsWith(`</${node.name}>`));
    }
    assert.equal(root.name, "mxfile");
});

test("属性区间定位准确：改一个属性只动那一段", () => {
    const text = sample("small-flow");
    const { nodes } = parseXml(text);
    const cell = nodes.find((n) => n.name === "mxCell" && n.attrs.get("id")?.value === "10");
    const before = cell.attrs.get("style");
    assert.equal(text.slice(before.valueStart, before.valueEnd), before.raw);
    const patch = setAttr(text, cell, "style", "rounded=1;");
    const out = applyPatches(text, [patch]);
    // 去掉补丁区间后，两份文本必须完全相同
    const strip = (s, p) => s.slice(0, p.start) + s.slice(p.end);
    assert.equal(strip(out, { start: patch.start, end: patch.end + (patch.text.length - (patch.end - patch.start)) }),
        strip(text, patch));
});

test("给不存在的属性补值：插在起始标签末尾，且不破坏结构", () => {
    const text = '<mxCell id="7" parent="1"><mxGeometry x="1" y="2"/></mxCell>';
    const { nodes } = parseXml(text);
    const cell = nodes[0];              // nodes[0] 是 mxCell，nodes[1] 是它的子节点 mxGeometry
    const geo = cell.children[0];
    const patch = setAttr(text, geo, "width", "42");
    const out = applyPatches(text, [patch]);
    assert.equal(out, '<mxCell id="7" parent="1"><mxGeometry x="1" y="2" width="42"/></mxCell>');
});

test("applyPatches 从后往前应用，多补丁互不影响偏移", () => {
    const text = "abcdefghij";
    const out = applyPatches(text, [
        { start: 1, end: 2, text: "BBBB" },
        { start: 7, end: 9, text: "Y" },
    ]);
    assert.equal(out, "aBBBBcdefgYj");
});

test("补丁区间重叠会报错（拒绝静默出错的数据）", () => {
    assert.throws(() => applyPatches("abcdef", [
        { start: 1, end: 4, text: "X" },
        { start: 3, end: 5, text: "Y" },
    ]), /重叠/);
});
