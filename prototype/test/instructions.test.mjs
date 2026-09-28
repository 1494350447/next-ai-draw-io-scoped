import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstruction } from "../src/instructions.mjs";

const hit = (t) => {
    const r = parseInstruction(t);
    assert.equal(r.matched, true, `"${t}" 没命中`);
    return r;
};

test("对齐类：六个方向都能命中，且长词优先（水平居中 ≠ 居中）", () => {
    assert.deepEqual(hit("左对齐").params, { mode: "left" });
    assert.deepEqual(hit("靠左一点").params, { mode: "left" });
    assert.deepEqual(hit("水平居中").params, { mode: "center" });
    assert.deepEqual(hit("垂直居中").params, { mode: "middle" });
    assert.deepEqual(hit("顶对齐").params, { mode: "top" });
    assert.deepEqual(hit("底对齐").params, { mode: "bottom" });
    assert.deepEqual(hit("居中").params, { mode: "center" });
    assert.deepEqual(hit("把这两个对齐").params, { mode: "left" });   // 没给方向 → 默认左对齐
});

test("分布与尺寸", () => {
    assert.deepEqual(hit("水平等距").params, { axis: "x" });
    assert.deepEqual(hit("纵向均匀分布").params, { axis: "y" });
    assert.deepEqual(hit("等宽").params, { mode: "width" });
    assert.deepEqual(hit("统一高度").params, { mode: "height" });
    assert.deepEqual(hit("大小一致").params, { mode: "both" });
});

test("移动：带数字，方向决定正负", () => {
    assert.deepEqual(hit("向右移动 20").params, { dx: 20, dy: 0 });
    assert.deepEqual(hit("左移 15").params, { dx: -15, dy: 0 });
    assert.deepEqual(hit("往下 8").params, { dx: 0, dy: 8 });
    assert.deepEqual(hit("上移10").params, { dx: 0, dy: -10 });
    // 没给数字就不该命中（交给模型，别猜）
    assert.equal(parseInstruction("往右挪一点").matched, false);
});

test("颜色：默认填充，提到描边/文字时改对应属性", () => {
    assert.deepEqual(hit("变成红色").params.props, { fillColor: "#ff0000" });
    assert.deepEqual(hit("边框改成蓝色").params.props, { strokeColor: "#3b7dd8" });
    assert.deepEqual(hit("文字改黑色").params.props, { fontColor: "#000000" });
    assert.equal(hit("刷成橙色").params.targets, "vertices");       // 填充色只改形状
    assert.equal(hit("连线改成灰色").params.targets, "writable");     // 提到连线 → 带上边
});

test("样式类：字号/加粗/圆角/虚线/透明/线宽", () => {
    assert.deepEqual(hit("字号 20").params.props, { fontSize: "20" });
    assert.deepEqual(hit("字体大小调整为18").params.props, { fontSize: "18" });
    assert.deepEqual(hit("加粗").params.props, { fontStyle: "1" });
    assert.deepEqual(hit("加圆角").params.props, { rounded: "1" });
    assert.deepEqual(hit("改成虚线").params.props, { dashed: "1" });
    assert.deepEqual(hit("半透明").params.props, { opacity: "50" });
    assert.deepEqual(hit("线宽 3").params.props, { strokeWidth: "3" });
});

test("不认识的句子必须不命中（宁可漏判，不可错判）", () => {
    for (const t of ["把支付服务拆成两个服务", "这里再加一个数据库节点", "把这一段重画成时序图", "", "   "]) {
        const r = parseInstruction(t);
        assert.equal(r.matched, false, `"${t}" 不该命中确定性规则`);
        assert.ok(r.why);
    }
});

test("结构性命令：删除与新增（③ 增删元素）", () => {
    assert.equal(hit("删掉选中的").command, "delete");
    assert.equal(hit("移除这三个").command, "delete");
    assert.equal(hit("不要了").command, "delete");
    const add = hit("在旁边加一个同色圆角框");
    assert.equal(add.command, "add");
    assert.equal(hit("加一个\u201c用户表\u201d框").params.label, "用户表");
});

test("结构性命令的边界：样式诉求与领域化说法都不能被当成增删", () => {
    // "删掉边框" 是样式诉求，不该删元素 → 规则弃权（本文件没有"边框"规则，所以未命中，交给模型）
    assert.equal(parseInstruction("删掉边框").matched, false);
    // "添加阴影" 是样式，不是新建元素 → 落到阴影规则
    assert.equal(hit("添加阴影").command, "style");
    // "再加一个数据库节点" 要模型去设计节点，不能被当成"加个空框"
    assert.equal(parseInstruction("再加一个数据库节点").matched, false);
    // "画一个流程图" 同理
    assert.equal(parseInstruction("画一个流程图").matched, false);
});

test("换形状：断言式说法命中，含糊/无关说法一律漏判给模型", () => {
    assert.equal(hit("改成数据库形状").params.props.shape, "cylinder3");
    assert.equal(hit("换成菱形").params.props.shape, "rhombus");
    assert.equal(hit("变成圆形").params.props.shape, "ellipse");
    // 下面这些是**故意的漏判**（交给模型），别改成命中：
    assert.equal(parseInstruction("把这块搞得像数据库一点").matched, false);   // 含糊，模型能给得更全
    assert.equal(parseInstruction("这里再加一个数据库节点").matched, false);   // 是"加节点"，不是"换形状"
    assert.equal(parseInstruction("把数据库连到缓存").matched, false);         // 根本没说形状
});

test("变成正方形：命中确定性命令（几何），但'变成长方形'故意不认", () => {
    const s = hit("变成正方形");
    assert.equal(s.command, "square");
    assert.equal(hit("改成正方").command, "square");
    // "长方形/矩形"是另一个意思 —— 把它按正方形处理会把用户的框改坏，所以刻意漏判给模型
    assert.equal(parseInstruction("变成长方形").matched, false);
    assert.equal(parseInstruction("变成一个矩形框").matched, false);
});

test("纯颜色词不算指令（避免把'红色'这种名词当动词用）", () => {
    assert.equal(parseInstruction("红色").matched, false);
});
