// 自然语言 → 确定性命令的**规则分流**（设计文档 §5.5-3 的第一段）。
//
// 为什么要它：80% 的局部修改需求（对齐、等宽、变个颜色、挪一下）不该付一次 LLM 调用 ——
// 又慢又贵还可能幻觉。命中规则就地执行，未命中才交给生成式通道（Phase 2 接模型）。
// 这里**不做语义理解**，只做关键词命中：宁可漏判（交给模型），不可错判（改错东西）。

export const COLOR_WORDS = {
    红: "#ff0000", 红色: "#ff0000",
    橙: "#ffa94d", 橙色: "#ffa94d",
    黄: "#ffe066", 黄色: "#ffe066",
    绿: "#2f9e63", 绿色: "#2f9e63",
    蓝: "#3b7dd8", 蓝色: "#3b7dd8",
    青: "#15aabf", 青色: "#15aabf",
    紫: "#9775fa", 紫色: "#9775fa",
    粉: "#f783ac", 粉色: "#f783ac",
    灰: "#adb5bd", 灰色: "#adb5bd",
    黑: "#000000", 黑色: "#000000",
    白: "#ffffff", 白色: "#ffffff",
};
const COLOR_RE = new RegExp(`(${Object.keys(COLOR_WORDS).join("|")})`);
const NUM = "([0-9]+(?:\\.[0-9]+)?)";

/** 规则表：顺序即优先级。每条要么命中并给出 command/params，要么返回 null。 */
// 几个方位词的后缀："向右移动 20" / "右移20" / "往右挪 5" 都得认
const MOVE_VERB = "(?:平移|移动|移|挪|走|拖|偏)";
const GAP = "[^,，。;；]{0,6}";   // 允许"纵向<均匀>分布"这种中间夹字的说法

const RULES = [
    // ---- 结构性命令（③ 增删元素）----
    // 放在最前面是刻意的：add/delete 的措辞里常常夹着样式词（"加一个**圆角**框"/"删掉那条**虚线**"），
    // 排在后面前面就会被样式规则抢走。反过来也要防"样式诉求被当成增删"：
    //   · add 要求句子里出现**对象名词**（框/矩形/元素/形状/卡片…）—— "添加阴影" 这种才不会被当成新建元素；
    //   · delete 只要出现样式词就**弃权**（走后面的规则或交给模型）—— "删掉边框" 不该删元素。
    // 两条都遵守本文件的既定原则：**宁可漏判（交给模型），不可错判（改错东西）**。
    {
        why: "新增元素（抄选区的样式与尺寸，放在选区右侧）",
        re: /(?:新增|添加|加一(?:个|条)|画一(?:个|条)|旁边加|再来一(?:个|条)|复制一(?:个|条))/,
        run: (m, raw) => {
            // 只认**通用框**（框/矩形/方框/方块）。刻意不认"节点/元素/形状/卡片"这种更抽象的说法：
            // 单元测试里的"这里再加一个数据库节点"就是反例 —— 那是要模型去设计一个数据库节点，
            // 被我们当成"加个空框"就错得离谱了（这类必须落到模型通道）。
            if (!/框|矩形|方框|方块/.test(raw)) return [null, null];
            const quoted = /["“「']([^"”」']{1,12})["”」']/.exec(raw);
            return ["add", quoted ? { label: quoted[1] } : {}];
        },
    },
    {
        why: "删除选中元素",
        re: /(?:删除|删掉|移除|不要了|去掉)/,
        run: (m, raw) => (/边框|描边|轮廓|颜色|线条|文字|字体|样式|阴影|圆角|虚线|箭头|填充/.test(raw)
            ? [null, null] : ["delete", {}]),
    },
    // 对齐：**带"水平/垂直"的要放在裸"居中"前面**，否则"垂直居中"会被"居中"抢先命中
    { why: "垂直居中", re: /垂直居中|纵向居中/, run: () => ["align", { mode: "middle" }] },
    { why: "水平居中", re: /水平居中|横向居中/, run: () => ["align", { mode: "center" }] },
    { why: "左对齐", re: /左对齐|靠左|贴左|对齐(?:到)?左/, run: () => ["align", { mode: "left" }] },
    { why: "右对齐", re: /右对齐|靠右|贴右|对齐(?:到)?右/, run: () => ["align", { mode: "right" }] },
    { why: "顶对齐", re: /顶对齐|上对齐|靠上|贴顶/, run: () => ["align", { mode: "top" }] },
    { why: "底对齐", re: /底对齐|下对齐|靠下|贴底/, run: () => ["align", { mode: "bottom" }] },
    { why: "居中", re: /居中|对中/, run: () => ["align", { mode: "center" }] },
    // 没给方向的"对齐"：默认左对齐（最常用）。放在所有带方向的对齐规则**之后**才不会被抢走。
    { why: "对齐（未指定方向 → 左对齐）", re: /对齐/, run: () => ["align", { mode: "left" }] },
    { why: "水平等距分布", re: new RegExp(`(?:水平|横向)${GAP}(?:等距|均分|分布|均匀)`), run: () => ["distribute", { axis: "x" }] },
    { why: "垂直等距分布", re: new RegExp(`(?:垂直|纵向)${GAP}(?:等距|均分|分布|均匀)`), run: () => ["distribute", { axis: "y" }] },
    { why: "等大小", re: /等大|一样大|统一大小|大小一致|大小一样|一样大小/, run: () => ["size", { mode: "both" }] },
    { why: "等宽", re: /等宽|(?:宽度|宽)(?:一致|一样|相同|统一)|(?:统一|一致|相同)宽度/, run: () => ["size", { mode: "width" }] },
    { why: "等高", re: /等高|(?:高度|高)(?:一致|一样|相同|统一)|(?:统一|一致|相同)高度/, run: () => ["size", { mode: "height" }] },
    { why: "向右移动", re: new RegExp(`(?:向|往)?右(?:边)?${MOVE_VERB}?\\s*${NUM}`), run: (m) => ["move", { dx: Number(m[1]), dy: 0 }] },
    { why: "向左移动", re: new RegExp(`(?:向|往)?左(?:边)?${MOVE_VERB}?\\s*${NUM}`), run: (m) => ["move", { dx: -Number(m[1]), dy: 0 }] },
    { why: "向下移动", re: new RegExp(`(?:向|往)?下(?:边)?${MOVE_VERB}?\\s*${NUM}`), run: (m) => ["move", { dx: 0, dy: Number(m[1]) }] },
    { why: "向上移动", re: new RegExp(`(?:向|往)?上(?:边)?${MOVE_VERB}?\\s*${NUM}`), run: (m) => ["move", { dx: 0, dy: -Number(m[1]) }] },
    { why: "改字号", re: new RegExp(`(?:字号|字体大小|字体)\\s*(?:调整|调|设|改|变|缩放)?\\s*(?:到|为|成)?\\s*${NUM}`), run: (m, raw) => ["style", { props: { fontSize: m[1] }, targets: targetsFor(raw, "fontSize") }] },
    { why: "加粗", re: /加粗|粗体|字体加粗/, run: () => ["style", { props: { fontStyle: "1" }, targets: "vertices" }] },
    { why: "斜体", re: /斜体/, run: () => ["style", { props: { fontStyle: "2" }, targets: "vertices" }] },
    // 换形状：**必须带明确的变换动词**（改成/换成/变成…），形状名词才算数。
    // 为什么收得这么紧：`数据库` 这个词太常见 —— 「这里再加一个数据库节点」「把数据库连到缓存」都不该被当成换形状；
    // 而「把这块搞得像数据库一点」这种含糊说法，交给模型反而更好（模型会连配色一起给）。
    // 于是这里只认「动词 +（可夹几个字）+ 形状名」这种**明确诉求**，其余一律漏判给模型。
    // "变成正方形"是**尺寸**问题（drawio 里没有"正方形"这个形状，方 = 宽高相等），所以它是一条几何命令。
    // 只认"正方形/正方"：**刻意不认"长方形/矩形"**（那是另一个意思，别把用户的框改方了）。
    { why: "变成正方形（宽高取长边）", re: /(?:改成|换成|变成|做成|改为|换为|变为|弄成|搞成|调成)[^，。;；]{0,4}(?:正方形|正方)/, run: () => ["square", { targets: "vertices" }] },
    { why: "换成数据库形状（圆柱）", re: /(?:改成|换成|变成|做成|改为|换为|变为|弄成|搞成|调成)[^，。;；]{0,4}(?:数据库|圆柱|柱状)/, run: () => ["style", { props: { shape: "cylinder3" }, targets: "vertices" }] },
    { why: "换成菱形", re: /(?:改成|换成|变成|做成|改为|换为|变为|弄成|搞成|调成)[^，。;；]{0,4}(?:菱形|判断框|条件框)/, run: () => ["style", { props: { shape: "rhombus" }, targets: "vertices" }] },
    { why: "换成椭圆/圆形", re: /(?:改成|换成|变成|做成|改为|换为|变为|弄成|搞成|调成)[^，。;；]{0,4}(?:椭圆|圆形)/, run: () => ["style", { props: { shape: "ellipse" }, targets: "vertices" }] },
    { why: "圆角", re: /圆角/, run: () => ["style", { props: { rounded: "1" }, targets: "vertices" }] },
    { why: "虚线", re: /虚线/, run: () => ["style", { props: { dashed: "1" } }] },
    { why: "阴影", re: /阴影|投影/, run: () => ["style", { props: { shadow: "1" }, targets: "vertices" }] },
    { why: "半透明", re: /半透明|透明度|透明/, run: () => ["style", { props: { opacity: "50" }, targets: "vertices" }] },
    { why: "线宽", re: new RegExp(`(?:线宽|边框(?:粗细|宽度))\\s*(?:到|为)?\\s*${NUM}`), run: (m) => ["style", { props: { strokeWidth: m[1] } }] },
];

/**
 * 命中规则后，"要改哪些元素"的取舍。
 * 默认**只改形状**（连线没有填充色、也不该跟着字号变），除非：
 *   · 这个属性本来就是线条相关的（描边色 / 线宽 / 虚线）—— 那时连线才是主角；
 *   · 用户明确提到了连线/箭头。
 * 这条规则的意义是让"改动账本"干净：不该出现"改了 3 个元素"里有两个是看不见变化的连线。
 */
const EDGE_PROPS = new Set(["strokeColor", "strokeWidth", "dashed"]);
export function targetsFor(text, prop) {
    if (EDGE_PROPS.has(prop)) return "writable";
    return /连线|连线|箭头|边线/.test(String(text)) ? "writable" : "vertices";
}

/**
 * 解析一句自然语言指令。
 * @returns {{matched: boolean, why?: string, command?: string, params?: object, targets?: string, confidence?: string}}
 *   matched=false 时调用方应当走生成式通道（或提示"这句话需要模型"）。
 */
export function parseInstruction(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return { matched: false, why: "指令是空的" };

    // 颜色要单独处理：它既可能指填充、也可能指描边或文字
    // 必须带"变化的动作"才当作指令：否则"红色"这种名词（甚至"把红色那个删掉"）会被误判成"填充改红"
    const colorHit = COLOR_RE.exec(raw);
    if (colorHit && /变|改|刷|换|调|设|弄|涂/.test(raw)) {
        const hex = COLOR_WORDS[colorHit[1]];
        const prop = /(描边|边框|轮廓)/.test(raw) ? "strokeColor"
            : /(文字|字体|文本)/.test(raw) ? "fontColor"
                : "fillColor";
        return {
            matched: true, why: `颜色 → ${prop}=${hex}`, command: "style",
            params: { props: { [prop]: hex }, targets: targetsFor(raw, prop) }, confidence: "high",
        };
    }

    for (const rule of RULES) {
        const m = rule.re.exec(raw);
        if (!m) continue;
        const [command, params] = rule.run(m, raw);
        // 规则可以"主动弃权"（返回 null）：措辞太含糊、或它其实是另一类诉求（比如"添加阴影"不是新建元素）。
        // 弃权就继续往下匹配 —— 这样"宁可漏判不可错判"才能落地成代码，而不是写在注释里。
        if (!command) continue;
        return { matched: true, why: rule.why, command, params, confidence: "high" };
    }
    return { matched: false, why: "没有命中确定性规则（这类改动需要模型）" };
}
