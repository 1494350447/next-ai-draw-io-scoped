# 局部作用域编辑（Scoped Editing）架构设计报告

- 版本：v1.0（设计评审稿）
- 对象：next-ai-draw-io @ `027cd88`
- 角色：架构评审 + 目标设计
- 前提：本报告中所有"已核实"结论均来自对运行中 drawio 容器前端代码与本项目源码的直接检索，证据在附录 A；未能验证的假设单列在附录 B，实施前必须用 spike 关掉。

---

## 1. 摘要与结论

产品诉求："在 draw.io 里选中元素 → 右键 → 局部修改 → 只改我选中的部分"。

**评审结论：诉求方向正确，但候选方案不能照单全收。** 三个关键判断：

1. **能力边界**：drawio embed 协议**没有选区事件**，父窗口也**没有"取选区"的动作**。所以"画布选区"这条路必须先给 drawio 装插件，不存在零改造的捷径。（证据 A1、A2）
2. **但插件路径的成本比我上一轮预估的低得多**：仍然**不需要 fork drawio 镜像**，只需在 compose 里挂一个只读的 `js/PreConfig.js` 定制入口（S1 实测修正：drawio 的 `urlParams['plugins']` 只认**内置插件白名单**，传自定义插件路径无效；挂 `ALLOW_CUSTOM_PLUGINS=1` + 注入同源脚本才通。证据 B1/D3、附录 C）。
   S3 进一步确认这是**生产形态**：`restart` 与 `up -d --force-recreate` 后插件都还在（`./deploy.sh plugin-check`），且整条链路已作为部署资产随 `deploy.sh` 发布。
3. **真正的架构杠杆不在"悬浮聊天框"，而在"作用域模型"和"确定性/生成式分流"**。如果只做 UI 不做这两件事，功能上线了但 80% 的简单需求仍然要付一次 LLM 调用，且模型仍可能改坏选中区域之外的东西。

**建议路线与进度**（截至 2026-09-24）：

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| Phase 0 | 三个 spike 关掉未知（插件挂载 / 写回语义 / 生产形态与撤销栈） | ✅ S1–S3 全部通过 |
| Phase 1 | **零 drawio 依赖**的作用域编辑器，验证产品假设 | ✅ 骨架已落地并验收（`prototype/`，附录 F） |
| Phase 2 | 插件实现画布选区与无损回写（适配层已在 S1/S3 落地） | 未开始 |
| Phase 3 | 作用域扩展成评论/协作锚点 | 未开始 |

"能不能做"已经全部验证完毕，剩下的是纯工程活。

---

## 2. 需求与目标

| 层级 | 目标 | 可度量 |
| --- | --- | --- |
| 用户目标 | 不改动未选中的内容；不用截图；不用重复描述上下文 | 越界改动率 = 0 |
| 体验目标 | 从选中到出结果 ≤ 2 次交互 | 确定性操作 < 100ms，生成式 < 15s |
| 成本目标 | 局部修改的上下文成本显著低于全局重画 | 输入 token < 全局重画的 1/3 |
| 可维护目标 | 不 fork 上游、不阻塞 drawio 升级 | 上游升级只需回归 1 个适配层 |
| 演进目标 | 作用域成为评论、锁定、模板的锚点 | 后续功能复用同一 Scope 结构 |

非目标（本期不做）：多人实时协同、跨图引用、移动端画布手势、自动布局引擎替换（见 §6 D8）。

---

## 3. 约束：已核实的技术事实

| # | 事实 | 影响 | 证据 |
| --- | --- | --- | --- |
| A1 | embed 协议向上层发的事件中**没有选区事件**（仅 configure/draft/exit/export/getDiff/init/merge/openLink/patch/prompt/ready/remoteInvoke/resetDiff/resize/scrollWheel/shortcut/template/textContent） | 画布选区必须靠插件 | 附录 A1 |
| A2 | 父→编辑器 action 无"取选区"项，但**有 `invokeAction`，且 `actions.get(name)` 无白名单** | 父窗口可反向驱动插件注册的动作 | 附录 A2 |
| A3 | 写回三条路的语义**已实测**：`load`=整页替换（其余元素消失、pageId 变）；`merge`=以载荷为权威文档的差异合并（**载荷里没有的元素会被删**，必须用带相同 `diagram id` 的 `<mxfile>` 包装）；`patch`=真正的 cell 级局部写回（其余元素与 pageId 全不变） | 局部写回只能用 `patch`；`merge` 只能发全量文档 | 附录 A3 / S2 |
| A4 | `react-drawio` 把 `urlParameters` 的每个键追加到 iframe 查询串 | 参数能传，但 `plugins` 这条路在本版本无效（见 A5）；S1 之后改用挂载 `PreConfig.js` | 附录 A4 |
| A5 | drawio 31.4.6 里 `urlParams['plugins']` **只当开关**（`!= '0'`）：真正加载的列表来自 `mxSettings` 设置或 `?p=<registryKey>`（内置白名单）；非内置插件还需 `window.ALLOW_CUSTOM_PLUGINS=true`，否则打一句 `Unknown plugin` 静默跳过 | **必须走官方定制入口 `js/PreConfig.js` 注入脚本**（S1 已实测）；`?plugins=xxx.js` 不通 | 附录 A5 |
| A6 | 插件可注册动作（`ui.actions.addAction`）并向弹出菜单追加条目（`editorUi.menus.addMenuItems`）；镜像内自带 21 个官方插件 | 右键菜单可行 | 附录 A6 |
| A7 | drawio 页面 CSP 为 `script-src 'self' + 白名单`，由 `js/PreConfig.js` 设置 | 跨源插件会被 CSP 拦；需同源托管或改 CSP | 附录 A7 |
| A8 | 本项目持续通过 `autosave` 拿到完整 XML（`contexts/diagram-context.tsx` 的 `handleDiagramAutoSave({xml})`） | Phase 1 可零改造拿到图结构 | 附录 A8 |
| A9 | 现有 `edit_diagram` 工具已是 **id 级操作**（add/update/delete + 级联删） | 越界校验可实现为纯确定性判断 | `app/api/chat/route.ts:655-696` |
| A10 | 每次 AI 编辑前已有快照（`diagramHistory`） | "撤销本轮"零额外成本 | `contexts/diagram-context.tsx:18` |

---

## 4. 候选方案评审

### 4.1 候选定义

- **方案 A｜应用侧作用域选择器（零 drawio 依赖）**：用已有 XML 自绘结构预览图 + 元素大纲，用户在**预览图/大纲**上框选。
- **方案 B｜drawio 插件 + 画布选区 + 悬浮聊天框**（用户原设想）：插件读选区并回传，父窗口承接指令与回写。
- **方案 C｜纯自然语言指代**：不引入选区，用户用文字描述（"那个红色框"），靠模型推断目标。
- **方案 D（本轮不做）｜布局引擎替换**：模型只出语义结构，坐标由 ELK/dagre 计算。

### 4.2 决策矩阵

| 维度 | A 应用侧选择器 | B 画布插件 | C 文字指代 | 权重 |
| --- | --- | --- | --- | --- |
| 目标精确性（不误改） | 高（id 确定） | 高（id 确定） | 低（靠推断） | ★★★ |
| 交互自然度 | 中（跨界面框选） | 高（原位右键） | 中 | ★★★ |
| 对嵌套/边的表达力 | 高（结构树） | 中（框选难选单条边） | 低 | ★★ |
| 首次可用时间 | 1 周内 | 3–4 周（含 spike） | 3 天 | ★★ |
| 维护耦合 | 无 | 与 drawio 版本耦合（可隔离） | 无 | ★★★ |
| 可发现性 | 中 | 高 | 高 | ★★ |
| 撤销本轮 / 改动高亮 | 中 | 高（可操作 graph） | 低 | ★★ |
| 上下文成本 | 低（只发子图） | 低 | 低 | ★★ |

### 4.3 逐一评审

**方案 C 否。** 它把"作用域"交给模型的推断能力，而作用域恰恰是**必须确定性**的东西——用户说"那个框"，模型挑错一个 id 就产生越界改动，而越界改动的代价是最高的（用户不信任整个功能）。仅作为 A/B 的补充入口（自然语言补充描述）。

**方案 A 采纳为 Phase 1。** 它的关键优势不是"便宜"，而是**不依赖任何未验证假设**：XML 已经在手（A8），几何与 id 都在里面，框选→cell 的映射是纯确定性计算，不存在像素反查误差。用自绘 SVG 预览（矩形+标签+连线）而不是 drawio 导出的 PNG，可以彻底避免"图像坐标 ↔ 画布坐标"的标定问题。它的弱点是"跨界面框选"不如原位选区自然，以及静态快照存在滞后。

**方案 B 采纳为 Phase 2 目标形态，但必须重排实现顺序。** 三点修正：
1. **插件不只用来读选区，也要用来写回**。若读用插件、写却用 `load()`（现行做法），写入会重置视图与撤销栈，体验断裂。插件内直接操作 `EditorUi.editor.graph`（`getModel().beginUpdate()` 包裹）才能做到**保留撤销栈、保留选区、支持改动高亮**。
2. **插件是"适配层"而非业务逻辑**。它只做四件事：读选区、写操作、回传 checksum、做防御（drawio 版本探测失败即自禁用）。所有作用域解析、越界校验、prompt 构造都在我们的服务端/前端，这样 drawio 升级的影响面收敛到一个文件。
3. **CSP 必须一起解决**（A7）。两个选择：把插件文件放进 drawio 同源目录（CSP 无需改），或挂载自定义 `PreConfig.js` 把我们的源加进 `script-src`。前者更省事——挂载一个静态文件即可，不修改 drawio 代码。

**方案 D 本轮不做，但要留接口。** 它才是重叠/穿越/长输出的根因解，属于"换发动机"，与本功能正交。本期只在数据模型上预留：Scope 只描述"改什么"，不描述"怎么排版"，将来接入布局引擎时不影响上层。

---

## 5. 目标架构

### 5.1 分层与组件

```
┌───────────────────────────── 浏览器（我们的应用，Next.js）─────────────────────────────┐
│                                                                                        │
│  ┌──────────────────┐   ┌───────────────────────┐   ┌──────────────────────────────┐   │
│  │ Scope Picker      │   │ Scope Editor Panel    │   │ Chat Panel（现有）           │   │
│  │ ·结构预览 SVG     │   │ ·确定性操作按钮条     │   │ ·主会话；作用域编辑折叠为     │   │
│  │ ·元素大纲树       │   │ ·悬浮指令输入         │   │  一条"对 N 个元素做了修改"   │   │
│  │ （Phase 2 换成    │   │ ·改动高亮 / 撤销本轮  │   │                              │   │
│  │   画布选区）      │   │                       │   │                              │   │
│  └────────┬─────────┘   └───────────┬───────────┘   └──────────────┬───────────────┘   │
│           │  Scope                  │  Ops(确定性)                 │  SSE              │
│           ▼                         ▼                              ▼                   │
│  ┌────────────────────────────────────────────────────────────────────────────────┐    │
│  │ OpApplier（唯一写入口）：三级降级 load / merge / graph API                       │    │
│  └────────────────────────────────────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────────────────────────────────────┐    │
│  │ DiagramStore：当前 XML、revision/checksum、diagramHistory 快照（已有能力）      │    │
│  └────────────────────────────────────────────────────────────────────────────────┘    │
└───────────────┬────────────────────────────────────────────────────────────────────────┘
                │ postMessage（drawio embed 协议 + 我们扩展的两条消息）
┌───────────────▼─────────────────────────────┐
│ drawio 容器（jgraph/drawio，上游镜像 + 1 个挂载文件）│
│  ·官方编辑器                                 │
│  ·ai-scope.js（我们的插件＝适配层，Phase 2 起）│
│     - 读选区: graph.getSelectionCells()      │
│     - 写操作: graph.getModel().beginUpdate() │
│     - 回传 checksum / 版本探测               │
└───────────────────────────────────────────────┘
                │ HTTP（复用现有 /api/chat）
┌───────────────▼────────────────────────────────────────────────────────────────────────┐
│ 服务端（现有 Next.js route，不新增服务）                                             │
│  ·scope-resolver：可写 / 可见 / 参考 三层上下文                                        │
│  ·prompt 构造：子图 + 邻域 + 骨架（不发全图）                                          │
│  ·guard：operation ⊆ writable 硬校验（安全边界，不可只放客户端）                       │
│  ·deterministic 通道：不进 LLM，直接返回 Ops                                          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 核心时序（Phase 2）

```
用户                插件(iframe)              前端                服务端
 │ 选中 3 个元素        │                       │                   │
 │ 右键"用 AI 改选中"   │                       │                   │
 ├─────────────────────▶│ getSelectionCells()  │                   │
 │                      │ 解析成 roots + xml    │                   │
 │                      ├─── event:aiScope ────▶│ 记 checksum       │
 │                      │                       │ 展开邻域(本地可预演)│
 │                      │                       │                   │
 │ 悬浮框输入"拆成两个服务"                     │                   │
 ├──────────────────────────────────────────────────────────────────▶│
 │                      │                       │ POST /api/chat    │
 │                      │                       │ (scope+instruction)│
 │                      │                       │  guard 越界校验    │
 │                      │                       │◀── Ops ───────────│
 │                      │◀── action:applyOps ───│                   │
 │                      │ graph 写入 + 高亮 + 选中                    │
 │ 看到改动高亮 + 撤销本轮按钮                   │                   │
```

**并发保护**：请求发出时记录画布状态，应用前再校验一次，若用户在此期间手改了图则拒绝应用并提示"图已变化，请重试"。

⚠️ **不能用 drawio 的 `checksum`/`checksumMismatch` 做这件事**：S2 实测该分支在 embed 上不可达（patch 分支在算出
checksum 之前就抛错中断，给错误 checksum 也不会有任何标记，见附录 D-4）。改成**应用侧自己算**：插件在请求发出时把当前
XML 的摘要一起给应用，应用在写回前再用 `{action:'export', format:'xml'}` 读回并比对（这条读回链路 S2 已实测有效）。

另外**回滚不能只靠"撤销一次"**：一次写回确实只占撤销栈一条记录（附录 E），但用户此前的手改也在同一条栈上，
所以"撤销本轮"要么记录 baseline depth，要么直接用写回前的 XML 快照恢复。

### 5.3 数据模型

```
Scope {
  pageId: string
  writable: string[]            // 允许被修改的 cell id（含容器子孙与内部边）
  roots: string[]               // 用户实际选中的元素（保留语义，用于 prompt 描述）
  context: {                    // 只读可见（**有界**，见 §5.5-1；超限者降级进 skeleton）
    ancestors: CellRef[]        // 父容器链（最多 maxAncestors=8 层）
    siblings:  CellRef[]        // 同层邻居，按几何邻近度取最近 maxSiblings=12 个（只给 id/label/geometry）
    edges:     CellRef[]        // 与 writable 相连的边
    siblingsTotal, siblingsOmitted, ancestorsTotal   // 供 UI 提示"上下文被裁剪过"
  }
  skeleton: ContainerRef[]      // 全局骨架：其他容器逐条给 id/label/childCount，其余节点只给数量
  estimate: { scopedTokens, fullSkeletonTokens, fullTokens, ratio, breakdown:{writable,context,skeleton,constraint} }
  reference?: string[]          // 用户显式指定的"照这个改"
  origin: 'outline'|'preview-box'|'canvas'|'text'
}

Op =
  | {kind:'add',    cellId, parentId, xml}
  | {kind:'update', cellId, xml}
  | {kind:'delete', cellId}
  | {kind:'style',  cellId, props}      // 确定性通道
  | {kind:'align'|'distribute'|'move', cellIds, params}  // 确定性通道

ScopedEditResult {
  applied: Op[]; rejected: {op, reason}[]; warnings: string[]
  diff: {added, updated, deleted}; tokens; ms; checksumBefore; checksumAfter
}
```

### 5.4 接口契约

**扩展的 postMessage（插件 ↔ 前端）**

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| drawio → 前端 | `{event:'aiScope', pageId, roots, writable, xml, checksum}` | 用户在画布上确认作用域 |
| drawio → 前端 | `{event:'aiScopeCleared'}` | 选区取消 |
| drawio → 前端 | `{event:'aiApplied', ok, checksum, error?}` | 写回结果回执 |
| 前端 → drawio | `{action:'aiApplyOps', ops, checksum, highlight:true}` | 应用操作（插件注册的自定义 action） |

**服务端**：复用现有 `POST /api/chat`，新增请求头 `x-scope-json`（或 body 字段 `scope`），响应沿用现有 SSE 流，额外在 `data:` 流末尾追加一条 `{type:'scoped-edit-result', ...}` 供前端做高亮与审计。**不新增服务、不新增端口**。

**prompt 契约**（服务端拼装，模型侧只看到这些）
```
[可修改] id 列表 + 元素 XML（含 geometry）
[只读·邻域] 父容器 / 最近的同层邻居 / 相连边（id + label + geometry，有界）
[只读·骨架] 其他容器（id + label + 子元素数量）+ 其余元素只给数量
硬约束：只允许对 [可修改] 内的 id 产生 add/update/delete；
       新增元素的 parent 必须是 [可修改] 内元素或 root。
```

### 5.5 关键算法

**（1）作用域解析 `resolveScope(xml, roots)`**
```
writable = roots ∪ descendants(roots)                 # 选中容器 → 隐含包含子孙
writable ∪= { e | e∈edges ∧ (e.source∈writable ∨ e.target∈writable) }
                                                       # 关键：与选中元素相连的边必须纳入，否则连线断裂
context  = ancestors(roots) ∪ siblings(parent(roots)) − writable（只读）
           ancestors 取最近 8 层；siblings 按"到选区包围盒中心的距离"排序取最近 12 个
           被截断的祖先/兄弟 → 降级进 skeleton（**不是丢弃**）
skeleton = 所有容器 {id,label,childCount} + 其余节点仅 label/数量（不带 geometry，省 token）
```
> 设计要点：**"能改什么"与"能看到什么"必须解耦**。只给模型看选中部分会导致它把边接错、把容器拆坏；把全图都给模型则失去 token 收益。
>
> **邻域同样必须有界（Phase 1 实测修正，见附录 F）**：draw.io 最常见的形态是所有元素 `parent="1"`，
> 此时"同层兄弟"**等于全图** —— 不设上限，`skeleton` 会被挤成空集，作用域退化成"把整张图发出去"。
> 200 顶点扁平图上实测：不设限 5055 token（占全量 23.0%），设限后 652 token（**3.0%**）。
> 排序用几何邻近度（模型排版/接边时真正要看的就是最近的邻居），无几何的边排在最后；
> 被截断的容器仍会在 compact 骨架里**逐条**列出，所以模型想 `add` 到某容器时依然拿得到容器 id。

**（2）越界校验 `guard(ops, scope)`（服务端强制）**
```
for op in ops:
  if kind in {update, delete}: require op.cellId ∈ scope.writable        → 否则 reject
  if kind == add:              require op.parentId ∈ scope.writable ∪ {root}
  任一 reject → 整批拒绝，回灌模型重试 1 次；仍失败 → 返回 rejected 明细
```
> 这里是**唯一的安全边界**，必须在服务端；客户端校验只是体验优化。

**（3）确定性/生成式分流 `classify(instruction, scope)`**
```
确定性（本地即时执行，不进 LLM）：
  对齐/分布/等间距、统一宽高、批量改字号/配色/线型、批量换形状、
  容器内自动排布、把 N 个元素收拢/散开、"删除选中的边"…
生成式（走 LLM）：
  语义重构（拆分/合并服务）、新增加节点与连线、按描述重命名并扩展、
  需要理解业务含义的任何改动
```
> 判定优先用**规则 + 关键词**（命中即走确定性），未命中才交模型；也可让模型先返回 `{mode:'deterministic'|'generative'}` 再分流，但要多一次往返，仅作为兜底。

---

## 6. 关键设计决策

| # | 决策 | 理由 | 被否方案 |
| --- | --- | --- | --- |
| D1 | 作用域采用三层模型（可写/可见/参考） | 只用"可写"会让模型接错边；只用"全图"丢掉 token 收益 | 单一 scope |
| D2 | Phase 1 不做画布选区，做"结构预览 + 大纲"框选 | 不阻塞在插件与未验证假设上，先验证产品假设；映射确定性最高 | 直接把 B 当第一期 |
| D3 | Phase 2 用 drawio 插件，**通过挂载官方定制入口 `js/PreConfig.js` 注入**（开 `ALLOW_CUSTOM_PLUGINS` + 注入同源脚本），插件由我们托管 | S1 实测：`?plugins=` 只认内置白名单，这条路不通；挂 PreConfig.js 是官方定制点，**仍无需 fork 镜像** | fork drawio / 魔改 embed 协议 / 依赖 `?plugins=` |
| D4 | 插件同时负责**读选区与写回**；写回走 `patch`（cell 级），**不依赖 drawio 的 diff 引擎**（我们自己按 Op 生成 patch） | S2 实测：patch 是唯一无损的局部写回；插件内直接改 model 是否进撤销栈**尚未验证**（S2 遗留） | 读用插件、写用 `load()` / `merge` 传局部载荷 |
| D5 | 越界校验放服务端 | 安全边界不可信客户端 | 只在前端校验 |
| D6 | 回写三级降级 `patch → merge（全量+相同 diagram id）→ load` | S2 实测语义：patch 无损；merge 必须整图回传否则误删；load 丢视图/撤销栈且换 pageId | 只用 `load()`；或用 merge 传局部载荷（会误删） |
| D7 | 确定性操作走本地"命令"通道，与 LLM 共用 `Op` 结构 | 80% 的局部需求不该付 LLM 成本；单一写入口便于审计与撤销 | 全部交 LLM |
| D8 | 本期不引入布局引擎，但 Scope 不描述排版 | 布局引擎是根因解但属换发动机，与本功能正交 | 本期一并替换 |
| D9 | 插件定位为"适配层"，业务逻辑全在应用侧 | 把 drawio 升级影响面收敛到一个文件 | 逻辑写进插件 |
| D10 | 每个作用域编辑产出一条审计记录（scope/指令/ops/tokens/checksum） | 可重放、可解释、可统计越界率 | 只存最终 XML |
| D11 | **只读邻域也必须有界**（兄弟按几何邻近度截断，超限降级进骨架） | 扁平图上"同层兄弟 == 全图"，不设限则骨架被挤空、作用域失效（Phase 1 实测，附录 F） | 邻域列举全部兄弟 / 直接把兄弟也算进骨架 |
| D12 | token 预算按**分段**记账（可改/邻域/骨架/固定约束） | 优化作用域唯一能下手的地方是"哪一段吃掉预算"；单一总数无法归因 | 只报一个总 token 数 |
| ~~D13~~ **（已撤销）** | ~~复原上一次改动 = 自存"改动前的整份 XML"，但只回写被改过的元素~~ | **实现与实测都已完成（附录 F.6，21/21），但随后按产品决策移除**：产品上把"回退上一次"交给 drawio 自带的撤销，面板不再重复这个入口。保留此条作为决策记录 —— 它同时记录了"应用内撤销栈会被宿主清空"这个**仍然成立**的实测事实（F.4） | 灌整份 XML（`setFileData`）/ 依赖撤销栈 / 只存最终 XML 不存改动前 |
| D14 | **模型语义一律在服务端收敛成"插件三话"（attrs / add / delete）**，插件不解释模型输出 | 模型最自然的写法是 `kind=update` + 整段 `<mxCell>`；两边各自解释就会长出"插件不认识的类型"（F.9 实测），且 guard/审计会分叉 | 让插件也认识 `update` |
| D15 | **新增元素的作用域判据 = 挂在谁下面 + 连到谁** | 只有 `parentId` 时，一条连到作用域外的新边等于"借新元素动别处"；引用不存在的端点则必然变成浮动线（F.9 实测） | 只看 `parentId` / 端点不做校验 |
| D16 | **写回断言打在"模型接纳 + 画布渲染"上**，不认"XML 里有 / 面板说成功" | AI 通道新增元素曾"报告新增 12 个、画布上什么都没有"（元素进了树与 XML，却没注册进 `model.cells`），当时没有任何功能断言抓到（F.9） | 用 `xmlOf()` 含某 id / 面板文案当证据 |
| D17 | **部署资产用内容指纹 URL**（`?v=<插件 sha256 前 8 位>`）做缓存失效 | Tomcat 对静态文件只发 `ETag`/`Last-Modified`、不发 `Cache-Control`，浏览器用启发式缓存继续跑旧插件 —— 已删掉的功能在用户页面上"还在"（F.10 实测） | 靠浏览器自觉 / 让用户手动硬刷新 |
| D18 | **"没改成"必须分成"结论 / 原因 / 作用域提示"三类说清** | 用户看到 `没有任何改动 · 邻域…已降级为骨架计数` 无法判断；且空 ops 曾被误报成"被 guard 拒绝"（F.10 实测） | 把不同含义的失败串成一行 / 把 D11 的设计行为当失败原因 |

---

## 7. 安全

| 面 | 措施 |
| --- | --- |
| 越界修改 | 服务端 guard 硬校验（§5.5-2），拒绝即回灌重试一次 |
| prompt 注入（图内文本） | 图内标签属不可信输入；模型输出仍走 guard，不因"图里写着让我删掉其他东西"而越界 |
| 并发写冲突 | 应用侧自己比对写回前后 XML/checksum（**不能依赖 drawio 的 `checksumMismatch`**：S2 实测该分支在 embed 上不可达） |
| 插件供应链 | 插件由我们自己的应用托管、同源加载（A7）；不改 drawio 镜像；插件内容纳入本仓库版本管理 |
| 配额 | 作用域编辑沿用现有 quota 链路（`lib/dynamo-quota-manager.ts`），确定性操作不计配额 |

---

## 8. 兼容与降级

```
插件可用  → 画布选区 + patch 无损写回 + 改动高亮（完整体验）
插件不可用→ 结构预览/大纲选区 + merge（全量文档）写回（Phase 1 形态，功能不缺，只是入口不同）
merge 不可用 → load 整文档写回（功能可用，牺牲视图与撤销栈、pageId 会变，需提示用户）
无 XML（首次加载前）→ 禁用作用域编辑入口，提示"先让 AI 画一张图"
```

写回后**必须主动刷新应用侧 XML**：`patch` 不会触发 `autosave`（drawio 在 patch 期间抑制变更通知），实测可用 `{action:'export', format:'xml'}` 读回最新 XML；不能把 drawio 回执里的 `error` 当写回失败（见附录 D）。

启动时做一次能力探测（插件握手 + `getCurrentFile()` 是否非空 + drawio 版本号），把结果写进前端 store，UI 据此启用/隐藏入口。

---

## 9. 分期实施

**Phase 0｜技术验证（1–2 天，必须先做，三个 spike）**
| # | 验证内容 | 状态与结论 | 不通过则 |
| --- | --- | --- | --- |
| S1 | 能否挂插件并拿到画布选区 | ✅ **已通过**：`?plugins=` 不通，改挂 `PreConfig.js`；真实鼠标点选 → 选区 id 正确回传（`spikes/s1/RESULT.md`） | — |
| S2 | 写回（patch/merge/load）在局部修改下的语义 | ✅ **已通过**：只有 `patch` 无损；`merge` 必须全量+带 diagram id；三条路都有上游假错误（`spikes/s1/S2-RESULT.md`） | — |
| S3 | ① 定制插件挂载能否做成「重启/重建后仍在」的生产形态；② 插件内 `beginUpdate()` 写入是否进撤销栈/保留选区 | ✅ **已通过**：① 只读挂载 `PreConfig.js` + 插件子目录，`restart` 与 `--force-recreate` 双向验证通过（`./deploy.sh plugin-check`）；② 一次写回 = **一条**撤销记录、撤销一次完全还原、**选区保留**（`spikes/s1/S3-RESULT.md`） | — |

**Phase 1｜作用域编辑器（1 周）—— ✅ 骨架已落地并验收（`prototype/`，报告见附录 F）**
- ✅ 前端：XML → 结构预览 SVG + 元素大纲树；框选/多选产出 `Scope`；**悬浮指令输入、改动高亮、改动账本、撤销本轮均已做**（附录 F 续）
  - 预览交互按 draw.io 习惯：**点空白=清空**、点元素=切换、拖拽=框选（替换）、Shift+拖拽=加选、`Esc`=清空
  - 命中遵循**叠放顺序**（后画的在上面，不做穿透）；框选是**几何**判定，只挑顶点（选边用大纲）
- ✅ 服务端：`resolveScope` + 两层 `guard`；`renderScopeText` 已给出子图 prompt 契约与 token 预算
- ✅ 指令分流 + **生成式通道已接真实模型**：规则命中就地执行（零 LLM），未命中才 `/api/generate`；
  模型只产 Op，落盘/复核复用确定性通道的同一条路径（附录 F 续）
- ✅ **应用前确认单**：所有写接口支持 `dryRun` —— 命令/指令/模型先出"将改 N 个元素"的预览（画布按应用后渲染），
  用户点「应用」才写回、才进撤销栈。预览与真跑逐字节一致；选区一变预览立即作废（附录 F.2）
- ✅ 确定性操作通道（对齐/分布/等尺寸/移动/样式，5 类 9 个样式属性）
- ✅ 验收全过：越界率 0（穷举 444 个越界 op 全拦）；未选中元素逐字节不变；大图输入 token 3.0%（< 1/3）
- ⚠️ 实测修正：**只读邻域必须有界**，否则扁平图上作用域失效（D11，附录 F）
- 未验证项集中在 `prototype/RESULT.md` §6（大图耗时、多页、画布选区接线，以及生成式通道的换形状/几何质量）

**Phase 2｜画布插件（2–3 周）**
- 插件（适配层）：选区、写操作、版本探测、右键菜单项 —— **适配层已在 S1/S3 落地**（`drawio-custom/`），
  并已作为**部署资产**（compose 只读挂载）随 `deploy.sh` 发布；Phase 2 是在它上面加业务能力，不是从零写插件
- ✅ 第一小步：画布选区 → 悬浮指令框 → `/api/instruct` → 写回（**F.4**，真画布 19/19 + 应用内 16/16 + 生成式 5/5）
- ✅ 第二小步：确定性命令**逐条**在真画布验掉（分布/等大/等宽/移动/改色/加粗 + 生成式，**F.5**，33/33；
  这一步**零生产代码改动** —— 同一条通道，命令间无特例）
- ~~第三小步：复原上一次改动~~ —— 曾做到应用内 21/21（**F.6**），**后按产品决策移除**（回退交给 drawio 自带撤销）
- ✅ 第四小步（v1）：结构性改动（增删元素）—— **选中后局部增删**（**F.8**，应用内 14/14）；新增不带连线、不选层级
- ✅ 第五小步：AI 语义规约到插件契约（`update` → 属性写入）、换形状确定性规则、**修掉"AI 新增元素报告成功但画布不渲染"的真 bug**（**F.9** / §5.11，真模型 7/7）
- ⬜ 前端：悬浮面板锚定选区、作用域子会话、主会话折叠卡
- 验收：S1–S3 全绿 ✅；撤销一次点击 ⚠️（应用内宿主会清空撤销栈，见 F.4；本轮**不做**自存 XML 的兜底）；从选中到应用 ≤ 2 次交互 ✅

**Phase 3｜延展（按需）**
- 选区 → 评论/批注（补协作缺口）
- 区域锁定（"这块别动"）、作用域快捷指令模板
- 与布局引擎（方案 D）对接

---

## 10. 风险登记册

| # | 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | 插件在 embed 下加载失败（CSP / 参数） | 中 | 高（阻塞 Phase 2） | Phase 0 S1 先验证；降级 Phase 1 形态 |
| R2 | `merge` 被误用成"局部更新"→ 静默删掉载荷外的元素 | 高（若不按 S2 结论实现） | 高 | 已实测并写明：局部写回只用 `patch`；merge 必须整图 + 带 diagram id（附录 D） |
| R2b | drawio embed 的 `merge`/`patch`/`getDiff` 回假错误（改动已生效） | 高（必然遇到） | 中 | 不把 `error` 当失败；以读回（`export`/`getDiff`）结果为准（附录 D） |
| R2c | 写回后应用侧 XML 不同步（patch 不触发 autosave） | 高（必然遇到） | 高 | 写回后强制 `export` 读回并更新应用侧状态（附录 D） |
| R3 | drawio 升级破坏插件 API | 中 | 中 | 插件定位适配层（D9）+ 固定 drawio tag + 启动握手探测（`aiScopeReady`），失败即自禁用并回退。**新增：镜像升级会让 entrypoint 重写 `PreConfig.js`（我们只读顶掉），所以升级后要重跑 `tools/gen_drawio_custom.py probe` 刷新 `.orig` 与锁文件**；`image.lock.json` 记录原版 sha256，`./deploy.sh doctor` 会校验生成物一致 |
| R4 | 模型不服从作用域 | 高 | 高 | prompt 硬约束 + 服务端 guard + 一次重试；越界率纳入监控 |
| R5 | 可见上下文不足导致改坏邻域 | 中 | 中 | 邻域纳入只读上下文；先给"预览改动"再应用 |
| R6 | 大图（>500 cell）预览渲染卡顿 | 中 | 低 | 预览按需渲染/虚拟化；超阈值只给大纲 |
| R7 | 用户手改与 AI 写回竞态 | 中 | 中 | 应用侧自己算的 XML 摘要比对（§5.2）——**不能用 drawio 的 `checksumMismatch`，S2 实测该分支不可达** |
| R8 | 悬浮框成为第二聊天入口，分散认知 | 中 | 中 | 作用域会话是同一会话模型的作用域视图，主会话折叠展示，不引入独立上下文 |

---

## 附录 A｜证据清单（均已直接检索确认）

| 编号 | 结论 | 证据位置 |
| --- | --- | --- |
| A1 | embed 事件无选区事件 | `draw/js/diagramly/EditorUi.js`、`App.js` 中 `postMessage(JSON.stringify({event:...}))` 全量枚举 |
| A2 | 父→编辑器 action 清单含 `invokeAction`，实现为 `this.actions.get(data.actionName).funct()`，无白名单 | `draw/js/diagramly/EditorUi.js:24082-24092` |
| A3 | embed 动作 `merge`/`patch`/`getDiff`/`resetDiff` 的实现；`merge` 走 `file.mergeFile(new LocalFile(...))` → `diffPages` 差异合并；`patch` 走 `file.patch([data.patch])` | `draw/js/diagramly/EditorUi.js:24939-25066`、`DrawioFile.js:390+`（`mergeFile`）；**语义与坑见附录 D（S2 实测）** |
| A4 | react-drawio 将 `urlParameters` 每个键追加到查询串 | 前端 chunk 中 `a.append(e, ...)` 循环；本项目用法见 `upstream/app/[lang]/page.tsx:187-201` |
| A5 | ① 插件列表来自 `mxSettings.getPlugins()`（`:993`）与 `?p=<registryKey>`（`:1015-1020`），`?plugins` 仅作开关（`:989/:1023`）；② `:1039-1046`：非内置且未开 `ALLOW_CUSTOM_PLUGINS` → `Unknown plugin` 跳过，跨域 → `Blocked plugin`；③ `ALLOW_CUSTOM_PLUGINS` 默认 `false`；④ 注入时机可能早于 `Draw` 定义，插件需轮询等 `Draw.loadPlugin` | `draw/js/diagramly/App.js:993,1023,1039-1046`、`draw/js/diagramly/Init.js:79`；实测见 `spikes/s1/RESULT.md` |
| A6 | 插件注册动作/菜单 | `draw/plugins/*.js` 中 `ui.actions.addAction(...)`、`editorUi.menus.addMenuItems(menu, [...], parent)` |
| A7 | CSP 由 `js/PreConfig.js` 设置，`script-src 'self' + 白名单` | `draw/js/PreConfig.js` |
| A8 | 应用持续接收 autosave XML | `upstream/contexts/diagram-context.tsx`（`handleDiagramAutoSave`）、`app/[lang]/page.tsx` 传 `autosave:true, onAutoSave` |
| A9 | 编辑工具已是 id 级操作，删除自动级联 | `upstream/app/api/chat/route.ts:655-696` |
| A10 | 每次 AI 编辑前有快照，可恢复 | `upstream/contexts/diagram-context.tsx:18`、`upstream/components/history-dialog.tsx` |

## 附录 B｜验证清单（状态截至 2026-09-24）

| # | 项 | 状态 | 结论 |
| --- | --- | --- | --- |
| B1 | embed 下插件的加载路径与时机 | **已关闭（S1 实测）** | `?plugins=` 无效；走 `js/PreConfig.js`：开 `ALLOW_CUSTOM_PLUGINS` + 注入同源脚本。插件要**轮询等 `Draw.loadPlugin`**（注入早于该 API 定义）。是否在 iframe 内**不影响插件加载**，只影响 `init` 事件 |
| B2 | 插件往右键菜单挂条目的挂钩点 | **已关闭（S1 实测）** | 覆盖 `ui.menus.createPopupMenu` + `ui.menus.addMenuItems(menu, ["-", "<actionName>"], null, evt)` 有效：菜单出现条目，**真实点击该条目会触发插件动作并回传** |
| B3 | embed 下 `getCurrentFile()` 是否非空 | **已关闭** | `load` 之后非空（`EmbedFile`，title 为空串）→ `merge`/`patch` 的前置条件成立；S2 已实测两者都能应用写回 |
| B4 | autosave 推送延迟与节流 | 待验证 | 影响 Phase 1 预览新鲜度 |
| B5 | 大图（>500 cell）结构预览与作用域解析耗时 | **部分验证（Phase 1）** | 解析与作用域计算本身很快（401 cell 端到端 3 ms）；但前端 SVG 无虚拟化，几百个 cell 会卡。**>500 cell 的界面耗时仍未测** |
| B9 | 作用域在**扁平图**（所有元素 `parent="1"`）上是否成立 | **已关闭（Phase 1 实测，附录 F）** | 不成立 —— 直到把只读邻域也做有界化（D11）。这是"平坦化"这个 drawio 最常见形态下的必修项 |
| B7 | 定制插件的挂载能否做成生产形态（重启/重建后仍在） | **已关闭（S3 实测）** | 只读挂载顶掉镜像 entrypoint 每次重写的 `js/PreConfig.js`；插件挂 `plugins/custom/` 子目录，避免盖掉镜像自带的 22 个官方插件。`docker compose restart` 与 `up -d --force-recreate` 后均验证通过（`./deploy.sh plugin-check`）。代价：entrypoint 的运行时改写整段被跳过（SSL/子路径/PostConfig 追加），等价内容已在 `drawio-custom/PreConfig.js` 静态化 |
| B8 | 插件内写回是否进撤销栈、是否保留选区 | **已关闭（S3 实测）** | `beginUpdate/endUpdate` 包住的批量写回 = 撤销栈**一条**记录（改 2 元素 × 2 个样式键仍是 1 条）；撤销一次完全还原；**写回后选区保留**。注意撤销栈不在 `graph.undoManager`（该字段为 `undefined`），在 `ui.editor.undoManager` |
| B6 | 画布选区在应用自身动作下是否稳定 | **已实测出风险** | 真实点击产生 `selectionChanged[spike-1]` 后，紧接着收到一条 `selectionChanged[]` —— 应用自身的 autosave/export 会重绘并清空选区。**作用域状态必须以 id 集合保存并做有效性校验，不能依赖"当前选区"** |

## 附录 C｜S1 spike 实测记录

完整报告：`spikes/s1/RESULT.md`；原始日志：`spikes/s1/results/spike-{a,b,c}.log`；可复现脚本：`spikes/s1/harness/`。

关键结论（均为真实浏览器 + 真实鼠标事件的实测）：

- 插件能拿到选区：点击节点 → `selectionChanged`，`ids` 正确。
- 父→编辑器反向通道可用：`{action:'invokeAction', actionName:'aiScopeProbe'}` 触发插件动作并回传。
- 右键菜单条目真实可点：点击后触发插件动作。
- **真实 app 页面（:3000）零改造即生效**：插件挂在 drawio 的 origin 上，app 内嵌的 iframe 自动带上，选区消息跨 origin 传到了 app 窗口。

## 附录 D｜S2 实测记录：写回语义（2026-09-24）

完整报告：`spikes/s1/S2-RESULT.md`；日志：`spikes/s1/results/spike-d3.log`（结论版）、`spike-d2.log`、`probe-autosave.log`、`probe-getdiff.log`。

同一份基准图（`2=Alpha`、`3=Beta`、`4=边`，pageId=`PAGE1`）每次重置，目标改动 = 只改 cell 2：

| 路径 | 载荷 | 目标 | 其他元素 | pageId | 应用感知 |
| --- | --- | --- | --- | --- | --- |
| `load` | 只含 cell 2 | 改为新值 | **全被删** | 变了 | 只有 `load` 回执 |
| `merge` | 裸 `<mxGraphModel>` 只含 cell 2 | 改为新值 | **全被删** | 变了 | `autosave` |
| `merge` | `<mxfile>`+相同 `diagram id`，只含 cell 2 | 改为新值 | **全被删** | 不变 | `autosave` |
| `merge` | `<mxfile>`+相同 id，全量（含一处修改） | 改为新值 | **原样保留** | 不变 | `autosave`（开 `diffSync` 时还带 patch+checksum） |
| `patch` | cell 级 patch | 改为新值 | **原样保留** | 不变 | **无 autosave** |

要点：

1. **`merge` 的载荷是"权威文档"**，缺的元素 = 删除项。局部载荷会静默误删；要安全必须整图回传。
2. **`merge` 必须带相同 `<diagram id>`**，否则裸模型没有页面身份，差异退化为整页替换（pageId 变化）。
3. **`patch` 是唯一无损局部写回**，格式（drawio 自产实测样本）：
   `{"u": {"PAGE1": {"cells": {"u": {"2": {"value": "新值"}}}}}}` —— 我们可以自己生成，不必依赖 drawio 的 diff 引擎。
4. **上游假错误**：`merge`（开 diffSync）回 `error:{}`；`patch` 回 `error:"ya is not a function"`；`getDiff`（未开 diffSync）**不响应** —— 但**改动都已生效**。因此：不得以 `error` 判定失败；`checksumMismatch` 在本版本不可达，不能用于并发保护。
5. **写回后不会自动同步到应用**：`patch` 期间 drawio 抑制变更通知（无 `autosave`）；实测用 `{action:'export', format:'xml'}` 能读回含新值的最新 XML → 作为 Phase 2 的读回校验与状态同步手段。

## 附录 E｜S3 实测记录：生产形态挂载 + 撤销栈/选区（2026-09-24）

完整报告：`spikes/s1/S3-RESULT.md`；日志：`spikes/s1/results/spike-e.log`（撤销栈/选区）、
`spike-f.log`（真实产品页）、`probe-undo.log` / `probe-undo2.log`（撤销栈定位探针）。

### E.1 挂载即生产形态

| 检查 | 结果 |
| --- | --- |
| 挂什么 | `drawio-custom/PreConfig.js` → `/usr/local/tomcat/webapps/draw/js/PreConfig.js:ro`；`drawio-custom/plugins` → `.../plugins/custom:ro` |
| 为什么必须挂 | 镜像 `/docker-entrypoint.sh` **每次容器启动都重写** `js/PreConfig.js`；"docker cp 进去"重启即失效 |
| 为什么挂子目录 | 直挂 `plugins/` 会盖掉镜像自带的 22 个官方插件；`GET /plugins/animation.js` 仍为 200（已验证） |
| 重启后 | ✅ `docker compose restart drawio` → 校验通过 |
| 重建后 | ✅ `docker compose up -d --force-recreate drawio` → 校验通过 |
| 命令 | `./deploy.sh plugin-check`（另有 `doctor` 做资产自洽与生成物一致性校验） |

**代价**（容器日志原文，已在 `DEPLOY.md` 写明）：

```
WARNING: No write access to /usr/local/tomcat (running as UID 1001, GID 999).
         Skipping runtime configuration: DRAWIO_* environment variables, SSL and the
         context path will NOT be applied.
```

→ entrypoint 的整段运行时改写被跳过（SSL 自签证书/8443、Tomcat 子路径 context、`PostConfig.js` 追加的 3 行）。
等价内容（CSP meta、`DRAWIO_*`、`urlParams`）已在 `drawio-custom/PreConfig.js` 里静态化；
`DRAWIO_BASE_URL` 改为从 PreConfig 自身 `<script src>` 反推部署前缀，因此 `/`、`/draw/`、反代子路径都成立，
也不依赖环境变量。

### E.2 撤销栈与选区（生产通道：`invokeAction` + `export` 读回）

基准图同 S2（cell 2/3 为顶点、cell 4 为边），逐步重置后对比逐 cell 的 style：

| # | 动作 | 结果 | 读数 |
| --- | --- | --- | --- |
| 1 | 真实鼠标点选 cell 2 | ✅ 只选中它 | 选区 `{ids:["2"],count:1}` |
| 2 | `invokeAction aiScopeRecolor`（只改选中） | ✅ 只动 cell 2 | `changed:["2"]`；`undoDepth 0→1`；`lastEditChanges:2`；`selectionAfter:["2"]` |
| 3 | `invokeAction aiScopeUndo` | ✅ 完全回到基线 | `changedStill:[]`；`undoEnabled true→false` |
| 4 | 空选区写回 | ✅ 报错分支、无副作用 | `{ok:false,error:"没有选中元素"}` |
| 5 | 多选（2+3）写回 | ✅ 只改这两个、**一条**撤销记录 | `changed:["2","3"]`；`lastEditChanges:4`；`undoDepth 0→1`；`selectionAfter:["2","3"]` |

要点：

1. **一次写回 = 一条撤销记录**：`mxUndoManager` 合并同一事务内的改动（改 2 元素 × 2 样式键 = 1 条），
   所以"批量只改选中元素"天然就是一次可撤销的用户操作 —— 满足 Phase 2 的"撤销一次点击"验收。
2. **写回不动其余元素、也不动选区**：这两点让"局部编辑"在画布层面成立。
3. **撤销栈的位置与直觉不同**：`graph.undoManager` 在本版本是 `undefined`，真正的栈是 `ui.editor.undoManager`
   （`mxUndoManager`）。适配层已按此修正，并在 `aiScopeWrite` 报文里回传
   `undoDepth` / `lastEditChanges` / `undoEnabled`。
4. **真实产品页零改造**：app 的 embed URL 里既无 `?plugins=` 也无调试开关，`aiScopeReady` 照常到达，
   `invokeAction` 往返可用，真实鼠标点击被识别为选区变化（`spike-f.log`、`spike-c.log`）。

## 附录 F｜Phase 1 实测记录：作用域骨架（2026-09-24）

代码 `prototype/`（零依赖，无 npm 包）；完整报告 `prototype/RESULT.md`；原始输出 `prototype/logs/test.log`。

| 验收条件 | 结果 | 证据 |
| --- | --- | --- |
| 越界率 0 | ✅ 36 个"样例 × 选择 × 命令"组合全过；穷举 **444** 个越界 op 拒绝率 **100%** | `prototype/test/acceptance.test.mjs` |
| 未选中元素逐字节不变 | ✅ 靠**保偏移解析**（只替换属性值区间，不重新序列化）从结构上保证 | `byteIdenticalOutside` |
| 输入 token < 全局 1/3 | ✅ 大图 **3.0%**；中等图 19%–32%；**小图无收益**（脚手架占比高） | 同上用例 3 |
| 测试总况 | ✅ **48 passed / 0 failed** | `node --test test/*.test.mjs` |
| 前端冒烟 | ✅ 10 条断言全过：大纲无重复行、空选区首屏可用、命令后三层 guard 全绿、控制台无意外错误，以及 7 条**预览交互**断言（点空白清空 / 点元素切换 / 点标签=点元素 / 拖拽框选 / 框选替换 / Shift 加选 / Esc 清空） | `spikes/s1/harness/smoke-prototype.mjs`（`results/smoke-prototype.log`） |

**发现并修掉的缺陷（→ D11）**：`context.siblings` 无上限。draw.io 最常见形态是所有元素 `parent="1"`，
"同层兄弟"即全图 → 200 顶点图上邻域塞进 392 个元素、`skeleton` 被挤空、compact/full 两种渲染 token 完全相同（均 5055）。
修复：按几何邻近度截断到 12 个，超限降级进 skeleton 并给出 `warnings`/`siblingsOmitted`。
**修复后 652 token（3.0%）**，逐条枚举骨架的版本 2554（11.6%）。

**跨系统验证（`spikes/s1/harness/spike-g.mjs` + `results/spike-g.log`）**：把原型 HTTP 接口产出的 `after.xml`
（真实 drawio 导出的 `cat-demo.xml` 做一次 `align left`）交给**真实 drawio 31.4.6** load → export 回读，
用**独立实现**的解析器比对：`added=[] removed=[] changed={"2":["geometry"]}`（`x: 300→280`），
其余 **20** 个元素语义完全不变，`ourChangeSurvived:true`，无 pageerror。

**交互细节（容易想当然，都在浏览器里验过）**：① "点"与"拖"用 4px 位移阈值区分，且点击等 `pointerup` 才生效
（这样从元素上按下也能拖框选）；② 文字标签也要挂 `data-id`，否则点元素的文字会被当成"点空白"而清空作用域；
③ 命中遵循叠放顺序 —— 写测试时踩到过：`small-flow` 里的 `13` 是包住 `10`/`11`/`12` 的大矩形（并非它们的父容器），
后画所以在最上层，点 `10` 的中心命中 `13`（与 draw.io 一致，不做穿透）。

**前端/接口层抓到两个真缺陷（单测覆盖不到，浏览器冒烟才暴露）**：① **空选区被当成错误**（`resolveScope` 抛错 → 接口 500），
而首屏默认就是空选区 → 前端 `refresh()` 抛错 → **大纲树永远渲染不出来**（页面等于坏的）；② `describeDiagram` 把**默认层 `1`**
当普通元素返回，前端既当一行渲染、又当父容器遍历一次 → **每行重复两遍**（9 个元素渲染成 19 行）。
两条都已修并固化为 `prototype/test/server.test.mjs`。**教训：只测 `src/` 会漏掉"接口层把正常状态当异常"这一类缺陷。**

**对 Phase 2 的硬输入**：① `patch` 写回与"只动 1 个属性"的最小补丁形状天然对齐；
② 作用域必须以 id 集合保存（S1：应用自身动作会清空选区）；③ guard 放服务端，`/api/verify` 可直接当写回闸门；
④ `siblingsOmitted` 必须展示给用户，静默裁剪会让人误判上下文完整性；
⑤ **选中容器 ≠ 局部改**：UI 必须显式给出"本次会改 N 个元素"（`aws-demo` 选顶层容器时占比 88%）。


---

### F.1 续：指令分流 / 生成式通道 / 改动账本（2026-09-25）

代码仍在 `prototype/`（零依赖，79 个测试全离线）；完整报告 `prototype/RESULT.md` §5.3–§5.4；浏览器冒烟 20 条断言全过。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 指令分流 | ✅ 25 条规则，命中就地执行、未命中原样展示"将发给模型的作用域载荷" | `src/instructions.mjs` |
| 生成式通道 | ✅ **已接真实模型**（`deepseek-flash` / OpenAI 兼容），模型只产 Op | `src/ai.mjs`、`server.mjs` 的 `POST /api/generate` |
| 越界红线（真实模型） | ✅ 模型两次尝试删 8 个作用域外元素 → **逐条被 guard 拒绝 → 整批放弃，一个字节未写** | `prototype/RESULT.md` §5.4 用例 3 |
| 改动账本 | ✅ 改动前后 XML → 改了谁/哪一项/从什么变成什么 + 一句话摘要（样式**按键**比较，避免顺序误报） | `src/diff.mjs` |
| 改动高亮 / 撤销本轮 | ✅ 高亮最后画在最上层且不接收事件；撤销栈存"本轮之前的完整 XML"（对齐"一次写回 = 一条撤销记录"） | `public/app.mjs`、浏览器冒烟 |
| 测试总况 | ✅ **79 passed / 0 failed**；生成式通道用本地假模型接口离线测（不花钱、不 flaky） | `node --test test/*.test.mjs` |

**这轮抓到的三个真缺陷**（都属于"单元测试覆盖不到"那一类，值得记进方法论）：

1. **越界判定的位置错了**：结果层原来判"新增元素的 **id** 必须 ∈ writable" → 等于把所有合法新增都判成越界；
   应判**父容器**（`parent ∈ writable ∪ {root, layer}`），与意图层对齐。
2. **新增的图元在画布上没有任何反馈**：前端只高亮 `diff.changed`，而新增元素落在 `diff.added` → "让模型加个节点"看不见结果。
3. **一条结构性写入能把整个报告面板打没**：写入列表无条件 `Object.entries(w.attrs)`，而 `add/update/delete` 的 `attrs` 是 `null`
   → 抛异常。症状极具迷惑性：**HTTP 全绿、79 个单测全绿、XML 也确实写进去了**，只有报告面板空白。

**生成式通道的成本观测**（实测，`temperature:0` + `response_format:json_object`）：单条指令 1.2k–3.4k token、
1.6–2.5s、**1 次通过**（重试只在真正越界时发生）。作用域载荷占全图 3%–88%，取决于选区大小。
**边界**：密钥只在服务端环境变量里，前端只拿到 `{configured, model}`；未配置密钥返回 200 + `configured:false`（不是 500）；
模型调用失败同样 200 + `applied:false` + 原因。


---

### F.2 续：应用前确认单（dry-run，2026-09-25）

代码仍在 `prototype/`（零依赖，**83 个测试**全离线）；报告 `prototype/RESULT.md` §5.5；浏览器冒烟 **24 条断言**全过。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| `dryRun` 预览 | ✅ 整条流水线照跑（含结果层复核 + 字节级核对），`applied` 恒 false、结论放 `wouldApply` | `server.mjs` 的 `scopedEdit`；`test/server.test.mjs` |
| 预览 = 真跑 | ✅ `after.xml` / `diff` / `guard.result` **逐字节一致**（有测试钉死） | 同上 |
| 预览作废 | ✅ 选区、连线开关、当前 XML 任一变化即作废并提示，绝不"拿旧预览落地" | `public/app.mjs` 的 `scopeKey()`；冒烟断言 |
| 取消零副作用 | ✅ 当前 XML 逐字节不变、高亮归零、**选区保留**（预览中 Esc 只取消预览） | 冒烟断言 + `results/shots/2-cancelled.png` |
| 生成式通道 | ✅ 预览只调用一次模型，确认时不重复调用、不重复花钱 | 冒烟 + `test/server.test.mjs` |
| 视觉取证 | ✅ 预览中 / 取消后 / 已应用 三张对照图 | `spikes/s1/results/shots/`（`harness/shots-confirm-flow.mjs`） |

**这一步抓到的真 bug（值得进方法论）**：`describeDiagram` 没把连线的 `source`/`target` 传给前端，
前端 `byId.get(undefined)` 直接 `continue` → **预览里一条线都画不出来**。接口 200、计数正常、控制台无错、
83 个单元测试全绿 —— 它是被一个**端到端数字**（"模型新增了一条连线，却没有一条线高亮"）勾出来的。
跨层数据契约（服务端结构摘要 ↔ 前端渲染）两边各自看都对，只有端到端断言能发现字段根本没人传。

**给 Phase 2 的对应动作**：插件拿到 `after.xml` 后**不要立刻 patch**：先把"将改 N 个元素"摆给用户，
确认后再 `beginUpdate()` 写回（S2/S3 已验：一次写回 = 一条撤销记录、选区保留）。


---

### F.3 续：按用户实测反馈的两处修正（2026-09-25）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| **cat-demo 鼠标/画面错位**（真 bug） | ✅ 已修 | `prototype/RESULT.md` §5.6-①；`spikes/s1/results/shots/4-cat-demo-drag.png` |
| 坐标换算改用 `getScreenCTM()` | ✅ 跨 3 个样例回归断言通过（含对照实验：旧公式下 cat-demo 必失败） | `harness/smoke-prototype.mjs` 的「坐标换算-*」 |
| 指令流程：一入口自动分流 | ✅ 命中规则就地执行；没命中**自动**走模型并直接应用；只回一句"走的规则/模型" | `server.mjs` 的 `POST /api/instruct` 返回 `channel`；`test/server.test.mjs` |
| 「先预览再应用」 | ✅ 降级为**可选开关**（默认关）。默认体验是"说一句 → 直接改 → 告诉你走了哪条通道" | `public/index.html` 的 `#confirm-mode` |
| 测试 | ✅ **86 passed / 0 failed**；浏览器冒烟 **25 条断言** | `prototype/logs/test.log`、`spikes/s1/results/smoke-prototype.log` |

**两个可复用的经验（都值得进 Phase 2 的实现纪律）**：

1. **屏幕 ↔ 世界坐标一律用 `getScreenCTM()` 之类的权威变换，绝不手算缩放**。SVG 是
   `preserveAspectRatio="xMinYMin meet"`：等比缩放的**约束轴因图而异**，手算"按宽度缩放"只在宽度恰好是约束轴时成立
   —— 而 `small-flow`/`aws-demo` 恰好就是这样，于是 bug 只在 `cat-demo` 上现形。画布侧对应的是 drawio 自己的
   `graph.view` 变换，同样不要自己乘。
2. **测试数据的宽高比要覆盖多种**。旧冒烟只在 `small-flow` 上做拖拽，所以这个 bug 一直没被发现；
   补上"每个样例都拖一次"之后，它立刻现形（并在临时换回旧公式时精确复现）。

**对 Phase 2 的接口影响**：`/api/instruct` 现在自带分流（返回 `channel`），画布侧只需要一个输入框、
一个调用、一句通道提示；**不需要**再做"没命中 → 提示用户点一下交给模型"的二次交互。
写回前是否要确认，由"这条改动会碰几个元素"决定（用户已在原型里把默认定为**直接应用**）。

### F.4 续：Phase 2 第一小步——接到真实画布（2026-09-25）

§9「分期实施」里的 Phase 2 第一步（画布选区 → 悬浮指令框 → 分流 → 写回）**已跑通**，只做了一条命令（对齐）。
约束照旧：**`upstream/` 一行不动**（`git status --porcelain` = 0 行），改动全部落在插件、服务端与生成器里。

**落地形态**

| 环节 | 实现 | 位置 |
| --- | --- | --- |
| 入口 | drawio 右键菜单「AI 局部修改…」（用 `menu.addItem` 直接挂：走 action 名会显示英文 key） | `drawio-custom/plugins/ai-scope.js` |
| 悬浮框 | 插件注入 `position:fixed` 的面板，落点优先用右键的 `getClientX/Y`，取不到才贴选区（贴选区用**渲染节点**的 `getBoundingClientRect`，不手算 `view` 变换） | 同上 |
| 读图 | `ui.getFileData(..., uncompressed=true)`：原型只吃明文 XML，压缩载荷会被显式拒绝 | 同上 |
| 分流 | `POST /api/instruct {xml, roots, instruction}` → 服务端规则表 → 未命中走模型 → `guardOps` → `opsToWrites` | `prototype/server.mjs` |
| 写回 | 只把返回的 `writes` 落进模型（几何 + `style`），一次 `model.beginUpdate()`；**结构性写入明确拒绝**（下一步） | `drawio-custom/plugins/ai-scope.js` |
| 提示 | 一句话说清通道：`走确定性规则：左对齐（没有调用模型） → 已应用` / `规则没命中 → 走大模型（deepseek-flash）：产出 N 个 op → 已应用` | 同上 |
| 端点注入 | `AI_SCOPE_ENDPOINT`（shell 环境变量 > 工作目录 `.env` > 默认 `http://127.0.0.1:8787`）写进 `PreConfig.js`，**并同步放行 CSP 的 `connect-src`** | `tools/gen_drawio_custom.py` |

**接线三件套（缺一不可，②最容易被漏）**：① 插件由 PreConfig 注入 drawio；② 浏览器侧放行端点（drawio 自带 CSP 的
`connect-src` 只允许 `'self'` + 几个第三方，不放行则在 iframe 里静默失败）；③ 服务端放行跨源（CORS +
`OPTIONS` 预检，因为发的是 `application/json`）。

**实测（证据文件）**

- 真画布 standalone：**19/19 断言** — `spikes/s1/results/phase2-instruct.log`
- **应用内**（:3000，跨源 iframe、无调试开关，断言走黑盒：悬浮框文案 + autosave 回吐的 XML + 渲染节点位置）：**16/16** — `spikes/s1/results/phase2-in-app.log`
- 生成式支路（真调模型）：**5/5** — `spikes/s1/results/phase2-generative.log`
- 回归：单元 **88 passed**、原型浏览器冒烟 **25 条** — `prototype/logs/test.log`、`spikes/s1/results/smoke-prototype.log`

其中"未选中元素逐字节不变"这条，在应用内是拿 **autosave 回吐给宿主的 XML** 比的 —— 那是上游 React 状态的来源，
比"我们自己读回来"更接近产品真实数据面。

**新增风险 / 设计修正（一条要改设计，一条要记住）**

1. ⚠️ **应用内撤销：手动拖拽能用，AI 写回之后不能用**（2026-09-25 更正；最初写成"应用内撤销整体失效、
   用户拖拽也一样"，**那是错的**）。用 embed 反向通道读撤销栈深度的实测是：
   · 手动拖拽 → `undoDepth 0→1` 且**稳住**，撤销按钮亮，Ctrl+Z 完全还原；
   · 插件写回 → 写完**瞬间** `0→1`（**我们的写回确实进了栈，且一次写回 = 一条记录**），但约 **1~2 s 后回到 0**，
     撤销按钮变灰，Ctrl+Z 撤不回 AI 改动。
   机制（打桩，不是推测）：给 iframe 的 `EditorUi.prototype.setFileData` 打桩，**插件写回之后它被调用了一次**
   （手动拖拽那条路一次都没有）；`setFileData` 重建模型 → 清空撤销栈。触发者未定位，属应用侧数据流。
   证据：`spikes/s1/results/probe-undo-depth.log`、`probe-undo-redo.log`。
   → **§5.6 的"撤销本轮"不能在应用里依赖画布撤销栈**；要做就得走 §5.3 的自存 XML（"本轮之前的完整 XML"）。
   曾按此做出「复原上一次改动」（F.6 / D13，21/21），**后按产品决策移除** —— 现状是**没有**回退 AI 改动的入口。
   将来若要补，这条路的实现与实测结论可直接复用（F.6 保留了完整记录）。
2. **服务端算 `writes`、客户端照做**这条分工成立且好维护：插件里没有一行语义/几何逻辑，
   guard 只有服务端一处，插件是哑的（也便于将来把 guard 换成更严的策略而不动插件）。

### F.5 续：Phase 2 第二小步——确定性命令逐条上真画布（2026-09-25）

F.4 只把**一条**命令（对齐）跑通了端到端。这一步把其余确定性命令**逐条**在真实画布上验掉，
并把生成式支路放进同一张表对照。**这一步没有新增生产代码**：改的只有测试脚本本身，
`upstream/` 仍是 0 行改动 —— 结论就是"同一条通道，命令之间没有特例"。

**验法（每轮独立一张图，同一条真实链路）**：重画 → 选中 2/3/4 → **真右键**「AI 局部修改…」→ 悬浮框输入 → 执行 → 读回画布。
断言三类并**每条都要过**：① 该有的效果；② 不该动的属性没动（等宽不许改高、移动不许碰样式、改色不许碰几何，
且原有样式是**改**不是整条重写）；③ **未选中的参照物逐字节不变**（核心承诺，7 轮每轮都查）。

| 指令 | 通道 | 关键断言 |
| --- | --- | --- |
| 水平等距分布 | 确定性 | 两个间距相等（≤1px）；只改 x；**首尾框不动**（只挪中间的） |
| 等大 | 确定性 | 宽高一致且等于选区里**面积最大**者；x/y 未被顺带改 |
| 等宽 | 确定性 | 宽度一致，**高度一个都没动** |
| 向右移动 50 | 确定性 | x 各 +50，y/宽/高不变 |
| 把选中的变绿 | 确定性 | `fillColor=#2f9e63`；几何没碰；`rounded=1` 仍在 |
| 加粗 | 确定性 | `fontStyle=1` 落进样式；几何与填充色没碰 |
| 把这段搞得像数据库一点 | 生成式（真调模型） | 文案说清通道；参照物不动；结构仍合法 |

**结果：33/33 全过** —— `spikes/s1/results/phase2-commands.log`（`PHASE2_CMDS_SUMMARY=ALL_PASS`，退出码 0）；
同时复跑单元 **88 passed**（`prototype/logs/test.log`），`upstream/` 0 行改动。

**这一步抓到的两处问题，都不是产品缺陷**（写下来是为了别把测试的锅算到实现头上）：

1. **断言写错了**：`等大` 原期望统一到 `150x90`（按"宽高都最大"理解），实际 `120x120`。查
   `prototype/src/commands.mjs:57-65` 确认 `anchor=largest` 的语义是**面积最大**（120×120=14400 > 150×90=13500），
   即**代码对、期望错**。已把断言改为**从 `before` 动态算期望**（面积最大者），不再写死数字 —— 换样例也不会再假报警。
2. **模型尾延迟**：第 7 轮真调模型，直连实测约 3s，但偶发超过 30s 预算，表现为面板停在「执行中…」被判失败。
   属**模型延迟而非产品行为**，已单独把这一轮的等待预算放到 90s。

**设计层面的确认（三条，无一条需要改架构）**：

1. **确定性命令之间没有特例**：同一份 `writes`、同一个 `beginUpdate`、同一条撤销记录 —— 逐条验过即覆盖，
   将来新增确定性命令**不需要新的验证框架**，照这张表加一行即可。
2. **"只动选中元素"在每条命令上都成立**（参照物逐字节不变 × 7），说明这个承诺由**通道**保证，而不是由某条命令的巧合保证。
3. **生成式与确定性共用同一个落地口**，差别只在"服务端是谁算出来的" —— 这也是 F.4 那条"服务端算 writes、客户端照做"
   分工的直接收益。

**下一步（用户已定顺序）**：② 复原上一次改动 —— ~~走 §5.3 的自存 XML~~ **用户随后撤掉了这一项**（回退交给 drawio 自带撤销），
见下面的「续」；③ 结构性改动（增删元素，插件侧当时是明确拒绝并提示）已落地，见 F.8。

### F.6 续：Phase 2 第三小步——复原上一次改动（2026-09-25，**后按产品决策移除**）

> **状态更新（同日）**：这一条**已经从代码里移除**（插件不再有快照 / 菜单项 / 面板按钮 / `aiScopeRestore` 事件）。
> 用户判断"回退上一次"应由 drawio 自带的撤销承担，面板里再挂一个同类入口是重复。下面这段保留**实现与实测记录**，
> 作为决策留痕；其中"应用内撤销栈会被宿主清空"（F.4 第 1 条）是**独立于本功能**的事实，**依然成立**。
> 换句话说：移除 ≠ 撤销可用 —— 现状是"AI 改动在应用内撤不回，且我们不再提供替代入口"。

设计决策 **D13** 的落地与实测。当时的依据是 F.4 第 1 条：**AI 写回之后用户按 Ctrl+Z 撤不回**（写回确实进栈，但约 1~2 s 后宿主把撤销栈清空），所以"复原"必须自己存快照。

**实现（只动了插件一个文件，`upstream/` 依旧 0 行改动）**

| 环节 | 做法 |
| --- | --- |
| 存 | 写回**之前**存下「整份明文 XML + 本次被改的每个 cell 的样式/几何」 |
| 复原 | **不灌整份 XML**，只把快照里那几个 cell 回写回去（复用同一条哑通道 `applyWrites`）→ 只动被改过的元素、触发 autosave 让宿主同步、一次写回一条撤销记录 |
| 自校验 | 复原后把 cell 片段与 `beforeXml` 同 id 片段**逐字节比对**，`exact` + 没对上的 id 一起写进面板文案与 `aiScopeRestore` 事件 |
| 入口 | ① 悬浮框里的「复原上一次改动」按钮（有快照才出现，用完收起）；② 右键菜单项（无快照时 `mxDisabled` 置灰，实测见 `results/probe-menu-disabled.log`；**不依赖选区**） |

**实测**：`spikes/s1/harness/phase2-restore.mjs` → **21/21 全过**（`results/phase2-restore.log`），应用内黑盒，
判据是**宿主收到的 autosave XML** + 面板文案 + 菜单项的灰/亮。（该脚本第一轮跑出 **14/15**，
失败那条是"上一轮的悬浮框挡住了菜单项"—— 真问题，已修，见下。）

核心几条：复原后 2/3/4 与改动前**逐字节一致** ✅ / 参照物全程一字节没动 ✅ / 复原**也走 autosave**（宿主状态同步）✅ /
无选区时「复原」仍可点而「AI 局部修改…」是灰的 ✅ / **AI 改完 → 用户手动挪了参照物 → 复原：目标元素回退、用户那笔留着** ✅。

**这一步抓到的真 UX 缺陷（已修）**：上一轮遗留的悬浮框会**压在右键菜单项上**（面板是 `position:fixed`，落点就是上次右键处），
导致「复原」点不动；而且那个框指向的是上一次的选区。修法：`ui.menus.createPopupMenu` 覆盖里**先收掉旧面板**，并加断言钉住。

**已知口子**：只有一个快照（"上一次"），没有多步回退栈；复原是就地覆盖 —— 若用户恰好改过**同一个元素的同一属性**，
那笔会被一起覆盖（跨元素的改动已验不受影响）。这两条都写进了 `prototype/RESULT.md` §5.9 与 §6。

### F.7 续：右键菜单的位置与配色（2026-09-25）

产品要求：「AI 局部修改…」从菜单末尾挪到**紧跟官方「删除」下面**，字体用**绿色**。

做法（不碰 drawio 源码）：`menu.addItem` 之后拿返回的 `<tr>`，以官方那一行做锚点插进去 —— 官方行的 `title` 就是 `"Delete"`
（实测，见 `spikes/s1/results/probe-menu-order-undo.log` 的 `MENU_ROWS`：i=0、title=Delete、字色红），
把我们的行插到它后面；再把标签格（`td[align="left"]`）的 `color` 设为 `#1a7f37`。
锚点找不到就退回默认位置，不会因此报错。完整菜单行序同理可核对（原实现是追加在末尾，即 22/23 行）。

**实测（应用内黑盒）**：`spikes/s1/harness/phase2-menu.mjs` → **9/9 全过**（`results/phase2-menu.log`）：
紧跟「删除」✅ / 字体 `rgb(26,127,55)` ✅ / 官方「删除」仍是红的（没改坏别人的配色）✅ / 点它仍能打开悬浮框（外观没改坏功能）✅ /
空白处右键（无选区）时置灰 ✅。截图：`results/shots/p2-5-menu.png`。

**顺带修的一件测试环境事**：截图里中文曾渲染成"豆腐块" —— 排查是**测试镜像没有 CJK 字体**（42 个字体、0 个 CJK，
`fc-match sans-serif:lang=zh` 落到 DejaVu），与产品无关；已在 `harness/Dockerfile.browser` 里加 `font-noto-cjk`，
视觉证据从此可读。

### F.8 续：Phase 2 第四小步——结构性改动（增删元素，③ 第一版，2026-09-25）

**范围按约定收窄**：只做"选中后局部增删"（"删掉选中的"、"在选中旁边加一个同色圆角框"）；
连线/层级语义不做，也不主动扩展到子孙。

**先做的写回 spike**（`spikes/s1/results/spike-structural-writeback.log`，6/6）：① mxGraph 全局在插件上下文里都在；
②③ `insertVertex` 能建元素并能放进**容器**；④ `removeCells` 删元素会**连带删掉它的连线**、其余不动；
⑤ 服务端给的 XML 能解码且**保住服务端指定的 id**（审计对得上）；⑦ 写回后的 XML 能原样吃回 drawio。

**落地**：规则表加 `delete`/`add` 两条（**排在样式规则之前** —— 否则"加一个**圆角**框"会被"圆角"抢走）；
`runCommand` 加两条命令（`delete` 只删 roots；`add` 位置在选区右侧、尺寸样式抄选区第一个顶点、父容器跟参照物一致、
id 由服务端分配）；规则通道也把结构性 op 送进 `guardOps`（`allowAiKinds: true`，**校验没放宽**）；
插件用 `graph.removeCells` / `graph.insertVertex` 落地（与"用户自己画/自己删"同一条路）。

**两条被测试逼出来的边界**（都遵循"宁可漏判，不可错判"）：
1. `add` 只认**通用框**（框/矩形/方框/方块）：单元测试里原有的反例「这里再加一个数据库节点」必须不命中 ——
   那是要模型去设计一个数据库节点，被当成"加个空框"就错得离谱。
2. `delete` 一看到样式词（边框/描边/颜色/文字/字体/阴影/圆角/虚线/箭头/填充）就**弃权** ——「删掉边框」不该删元素。
   为此给规则机制加了"`run` 返回 `null` = 弃权，继续往下匹配"这条小能力。

**实测（应用内黑盒，14/14）**：`spikes/s1/results/phase2-structural.log` ——
删除：选中的没了、**连线一起走**、其余元素逐字节不变、画布上标签同步消失；
新增：多出且只多出一个（id = `ai-add-N`）、样式尺寸抄选区、位置在右侧、其余逐字节不变、画布上真渲染出来。
截图：`results/shots/p2-6-structural.png`。回归：单元 **90 passed**，其余五条画布链路脚本全绿。

**第一版刻意不做的**：新增不带连线、不选层级；删除不扩展到子孙。
（原文还写"含增删的改动不给「复原」入口"—— 「复原」功能已整体移除，此约束自然消失。）

### F.9 续：让"AI 识别 + 落地"更准——契约收敛、规则扩容，与一个"报告成功没落地"的真 bug（2026-09-25）

实测与逐条证据在 `prototype/RESULT.md` §5.11；这里只记**设计与决策**。

**决策 D14（新）：模型语义一律在服务端收敛成"插件三话"（attrs / add / delete），插件不解释模型输出。**

- 起因：用户常看到 `跳过：do 不认识的改写类型：update`。根因是模型最自然的写法是
  `kind=update` + 一整段 `<mxCell>`（见 `prototype/src/ai.mjs` 的 `OP_SCHEMA`），而插件只认三种话（**这是刻意的**：插件哑、guard 只有服务端一处）。
  两边各自解释模型输出，就必然长出"插件不认识的类型"。
- 落地：`update` 在 `prototype/src/commands.mjs` 里就拆成属性写入（含 `value`），XML 的 `id` 与目标不一致**拒绝**而不是纠正；
  属性落点改成显式白名单（`style`/`value` 落 `<mxCell>`，几何落 `<mxGeometry>`）。
- 代价与收益：服务端多一层转换；换来的是一条**单一语义入口**（审计、guard、撤销记录都还只有一处）。
- 备选（已否）：让插件也认识 `update`。等于把模型语义分两处，guard 与审计都会分叉。

**决策 D15（新）："新增元素"的作用域判据 = 挂在谁下面 **+ 连到谁**。**

- 原判据只有 `parentId`（"它挂在哪"）。但一条新边连到作用域外的元素，用户看到的就是"AI 借新元素动了别处"。
- 落地：`prototype/src/guard.mjs` 里 `add` 的 `source`/`target` 必须在 writable 内（否则越界拒绝）；
  `prototype/src/commands.mjs` 里 `add` 的 XML 若引用图上**不存在**的 `parent/source/target` → 拒绝（那种必然变成浮动线）。
- 由"宁可漏判、不可错判"推出：**拒绝要给出用户可理解的原因**（面板会显示 warning），而不是静默丢掉。

**决策 D16（新）：写回断言要打在"模型接纳 + 画布渲染"上，不能打在"XML 里有 / 面板说成功"上。**

- 起因是一个**真 bug**：AI 通道新增元素时，`mxCodec.decodeCell(node)` 的第二个参数默认 `true`，
  它自己会 `insertIntoGraph()` 把元素**裸插进父容器 children**（绕过 `model.cells` 注册）。
  于是元素在树里、被序列化进 XML、插件报"新增 12 个"，但画布上**什么都没渲染**（重载后才出现）；
  边还会因为端点解析不到而变成**浮动线**。当时**没有任何功能断言抓到它**，唯一报警的是"没有未预期的页面错误"。
- 修正做法（三处一起才成立）：`decodeCell(node, false)` → 解码前把画布上所有 cell 注册进 codec（端点可解析、无告警）
  → 挂之前 `setParent(null)`（逼 `mxGraphModel.cellAdded` 跑）→ 官方 `graph.addCell` → **写回结束后**自检
  "`getCell` 指回同一对象 + `view.getState` 非空"，没落地就回滚并如实上报。
- **留给后续的纪律**：凡是"新增/删除"的验收，都要有一条断言落在**渲染**上；`xmlOf()` 包含某个 id **不足以**证明它落地了。

**同轮的确定性规则扩容（D7 既有思路的延伸）**：`shape` 进样式白名单，规则表加"换形状"三条
（数据库/圆柱 → `cylinder3`、菱形 → `rhombus`、椭圆 → `ellipse`），但**必须带变换动词**才命中 ——
`数据库` 这个词太常见（"再加一个数据库节点"/"把数据库连到缓存"都不该被当成换形状），
宁可漏判交给模型。这就是规则"可弃权"（`run` 返回 `null`）机制的实际用法。

**实测汇总**：单元 93 passed；应用内 7 条脚本全绿（`phase2-commands` 33/33、`phase2-ai-update` 7/7、
`phase2-structural` 14/14、`phase2-menu` 10/10、`phase2-in-app`/`phase2-instruct`/`smoke-prototype`）；
两个新探针 `probe-add-api` / `probe-add-edge` 给出"注册/入树/渲染/端点"的对照证据；`upstream/` 0 行改动。

**尚未做、但已知有价值的方向**（未实测，别当成已有能力）：
① 写回后用 `/api/verify` 拿 `after.xml` 做一次服务端复核（现在只有客户端自检）；
② 模型的幻觉样式被忽略时，把"白名单是什么"回灌重试一次（现在只给 warning）；
③ 对模型给的几何做合理性钳制（重叠/越界/压线）；
④ 按图缓存上下文、多轮子会话（省 token、少歧义）。

### F.10 续：现场回报三则——缓存失效、失败文案、邻域降级（2026-09-25）

逐条证据在 `prototype/RESULT.md` §5.12。这里只记设计与决策。

**决策 D17（新）：部署资产用"内容指纹 URL"做缓存失效。**

- 现场：代码里已删掉的「复原上一次改动」，在用户的浏览器里**还在**（菜单 + 面板都有）。
  逐层对账（宿主文件 / 容器内挂载文件 / HTTP 取回）全是 0 处"复原"、md5 一致 —— 问题在**响应头**：
  Tomcat 对静态文件只发 `ETag`/`Last-Modified`、**不发 `Cache-Control`**，浏览器按启发式缓存继续用旧文件。
- 做法：注入的插件 URL 带 `?v=<插件 sha256 前 8 位>`（`tools/gen_drawio_custom.py` 现算），内容变则 URL 变。
- 代价：改了插件必须重跑 `build`；所以 `check` 会把"指纹过期"单独报出来（比笼统的"与模板不一致"更可行动）。
- 这条对 Phase 2 之后的**任何**前端资产都成立：**部署资产的缓存失效必须由指纹保证，不能指望浏览器守规矩。**

**决策 D18（新）："没改成"必须分类说清，禁止把不同含义的失败串成一行黑话。**

- 现场：用户看到 `没有任何改动 · 邻域里还有 31 个同层元素在 12 个之外，已降级为骨架计数`，
  无法判断是出错还是正常。
- 三件事必须分开：
  ① **结论**（为什么没改动）；② **原因**（被谁拦下、缺什么参数）；③ **作用域提示**（邻域被裁剪等）。
  其中 ③ 是 **D11 的设计行为**、**与本次能不能落地无关**，不能和 ② 混排。
- 顺带修掉一个真文案 bug：**空 ops 曾被报成"被 guard 拒绝"**。
  "选 1 个元素说等宽"是**规则层面没产出**（等宽至少要 2 个），与"产出了越界 op 被拦"（§5.5-2）含义完全不同。
  服务端现在按"有没有产出 op"分开措辞（`prototype/server.mjs`）。
- 注意：改的是**解释**，不是行为 —— "没有任何改动"本身是正确结论（绝不写 no-op 进图）。

**规则扩容（D7 思路的继续）**：`变成正方形` 进确定性通道（新命令 `square`：宽高统一到**长边**，
与"等大"取最大者的口径一致）。"正方形"在 drawio 里不是形状而是尺寸，所以归几何命令；
**刻意不认"长方形/矩形"** —— 同一句话族里这两个词含义不同，宁可漏判给模型。

**同轮修掉的一处脚本自伤**：`deploy.sh` 开了 `set -o pipefail`，而校验写成 `curl … | grep -q X` ——
`grep -q` 提前退出会掐断 curl 的写管道（exit 23），于是「内容明明在」的校验恒红。
改成 `body_contains <url> <needle>`（先读正文再匹配）。`./deploy.sh plugin-check` 现在三次（当前/重启/重建）全绿。

**本轮实测汇总**：单元 95 passed；`phase2-menu` 11/11（新增"菜单与面板都不再有复原"）、`phase2-commands` 33/33、
`phase2-ai-update` 7/7、`phase2-structural` 14/14、`phase2-in-app`/`phase2-instruct`/`smoke-prototype` 全绿、
`probe-panel-message`/`probe-add-edge`/`probe-add-api` 全绿；`upstream/` 0 行改动。
