# Phase 1 骨架原型：作用域编辑（Scoped Editing）

> 验证的是**产品假说与安全边界**，不是 UI 工程：用户选中一部分元素 → 只改这部分 → 其余元素逐字节不变。
> 配套设计与验收：`../docs/scoped-editing-design.md` §5 / §9，实测报告见 `RESULT.md`。

**零依赖**：只用 `node:` 内置模块（`node:http` / `node:crypto` / `node:test`），没有 `package.json`、没有 npm 包、没有构建步骤。
浏览器侧的冒烟测试在 `../spikes/s1/harness/smoke-prototype.mjs`（复用 S1 的浏览器镜像，需服务先跑起来）。
**零 drawio 依赖**：不碰画布、不碰插件，只吃 XML 字符串 —— 这样 Phase 1 的结论不依赖 Phase 0 的任何 spike。

## 跑起来

```bash
cd prototype
node server.mjs                 # http://127.0.0.1:8787/   （PORT=xxxx 可换端口）
node --test test/*.test.mjs     # 86 个测试（全部离线，不打网络）

# 想用生成式通道（指令没命中规则时自动走它）就带上密钥一起起 —— 密钥只留在服务端进程里：
set -a; . ../.env; set +a; node server.mjs
```

生成式通道读三个环境变量：`DEEPSEEK_API_KEY`（没有它按钮不出现）、`AI_MODEL`（默认 `deepseek-flash`）、
`DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`，任何 OpenAI 兼容的 `/chat/completions` 都能接）。
**密钥绝不下发到浏览器**：前端只从 `/api/meta` 拿到 `{configured, model}` 两个字段。

打开 `http://127.0.0.1:8787/`：

1. 左上选样例；2. 在**大纲勾选**或**在结构预览里点选/框选**（= 作用域 roots）；
3. 右侧点确定性命令（对齐/分布/等尺寸/移动/样式），或在悬浮框里说一句话；
4. 结果**直接应用**，并告诉你刚才走的是**确定性规则**还是**大模型**；5. 看 guard 报告与当前 XML。

**一句话进来怎么走（一个入口，自动分流）**：

```
指令 ──► 规则表（25 条，免费/可审计）──命中──► 就地执行
                                   └─没命中─► 生成式通道（模型产 Op → guard → 落盘）
执行完只回一句："走确定性规则：颜色 → fillColor=#2f9e63（没有调用模型）· 已应用"
            或 "规则没命中 → 走大模型（deepseek-flash）：产出 4 个 op，尝试 1 次，5738 token · 已应用"
```

不需要用户判断"这句话该谁干"，也没有"没命中 → 再点一次交给模型"这种二次操作。

> **想要刹车就勾「先预览再应用」**（默认不勾）：勾上后所有编辑先出**确认单**（将改 N 个元素 + 逐项账本），
> 画布按**应用后**的样子渲染（圈成"将改"/"将增"），但"当前 XML"一个字都不变，点「应用」才写入。
> 为什么留着它：选中一个容器就点"左对齐"，在 `aws-demo` 上会改到 88% 的图。预览作废规则很简单：
> **选区、连线开关、当前 XML 任何一样变了，预览立即作废**（否则"应用"落地的会是针对旧选区算出来的那一版）。

预览里的鼠标约定（对齐 draw.io 的直觉）：

| 操作 | 结果 |
| --- | --- |
| 左键点**空白** | 清空选择 |
| 左键点元素（或它的文字标签） | 切换该元素（已选则取消） |
| 拖拽 | 框选（**替换**当前选择） |
| Shift + 拖拽 | 框选并**加选** |
| 右键元素 | 选中它并唤起**悬浮指令框**（对齐"在画布上指着元素说怎么改"的设想） |
| 预览中按 `Esc` / `Ctrl+Z` | 取消这次预览（**不清空选区**、不动已提交的历史） |

> 坐标换算必须交给浏览器：SVG 是 `preserveAspectRatio="xMinYMin meet"`，等比缩放的**约束轴因图而异**
> （`cat-demo` 是高度约束），手算"按宽度缩放"会让鼠标和画面对不上。用 `getScreenCTM()` 做逆变换，
> 什么 viewBox 都对 —— 这条有跨样例的回归断言（`smoke-prototype.mjs` 的"坐标换算-*"）。
| `Esc` | 清空选择（在指令输入框里按 `Esc` 只清输入，不清选择） |

> 两个实现要点：① "点"和"拖"靠位移阈值（4px）区分，否则手抖会让点击变成框出一个 0×0 空框；
> ② 点击是**等抬起鼠标才生效**的，所以从元素上按下也能直接拖框选。
>
> 命中遵循 SVG 的叠放顺序（后画的在上面，和 draw.io 一致）：如果一个大矩形把别的元素盖住了，
> 点它上面命中的是**大矩形**。`small-flow` 样例里就有一个这样的矩形（`13` 是个 560×320 的框，
> 包住了 `10`/`11`/`12`，但并没有真的当它们的父容器）—— 这不是 bug，是图本身的画法。

预览里三种颜色就是三层作用域：**绿=可改（writable）、蓝=只读邻域（context）、灰=全局骨架（skeleton）**。

## 目录

```
server.mjs            零依赖 HTTP 服务（路由 + JSON 收发）
src/xml.mjs           保偏移 XML 解析器 + applyPatches / setAttr / 实体编解码
src/model.mjs         parseDiagram：cells / 父子 / 样式 / 几何（每个 cell 都映射回原文区间）
src/scope.mjs         resolveScope（三层作用域 + 邻域有界化）+ token 估算与分段账单
src/commands.mjs      确定性命令：align / distribute / size / square / move / style → Op；结构性 op（update/add/delete）→ 整段替换/删除/插入
src/apply.mjs         Op → 属性级写入 / 结构性写入 → 补丁（区间替换、区间置空、插到 </root> 前）
src/guard.mjs         guardOps（意图层）/ verifyCandidate（结果层）
src/diff.mjs          改动账本：改动前后 XML → 改了谁、改了哪一项、从什么变成什么
src/instructions.mjs  自然语言 → 确定性命令的规则分流（命中就地执行；未命中则**自动**交给模型）
src/ai.mjs            生成式通道：拼作用域载荷 / 逐项校验模型输出 / 失败重试；不依赖任何 SDK
public/               无框架前端：大纲树 + 结构预览 SVG + 命令面板 + 悬浮指令框 + 报告
samples/              small-flow（自造，含一个盖住别的元素的大矩形）/ aws-demo、cat-demo（真实 drawio 导出，v29.0.3）
test/                 86 个测试：xml/model/scope/commands/guard/diff/instructions/ai + acceptance（对着 §9 验收条件写）+ server（HTTP 接口回归，含 dry-run 与生成式通道）
logs/                 server.log / server.pid（跑服务的产物，不是源码）
```

## API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/meta` | 样式白名单、样例列表、命令列表、生成式通道是否已配置（`generative.{configured,model}`） |
| GET | `/api/sample?name=` | 取样例 XML |
| POST | `/api/resolve-scope` | `{xml, roots, includeEdges}` → `{scope, abstract}` |
| POST | `/api/command` | `{xml, roots, command, params}` → 完整局部编辑结果（含 guard 与结果 XML） |
| POST | `/api/instruct` | `{xml, roots, instruction}` → **一个入口自动分流**：规则命中就地执行（不调模型）；未命中**自动**交给生成式通道并直接落地。返回带 `channel: rule\|generative\|none`，前端据此回一句人话 |
| POST | `/api/generate` | `{xml, roots, instruction}` → 走生成式通道：模型产 Op → guard → 落到 XML（未配置密钥时返回 200 + `configured:false`，不是 500） |
| POST | `/api/apply-ops` | `{xml, roots, ops}` → 同上，但 ops 由调用方给（等价于"模型不听话"，用来验 guard） |
| POST | `/api/verify` | `{beforeXml, afterXml, roots}` → 只做结果层复核（给 Phase 2 的插件当校验口） |

这四个写接口都支持 `dryRun: true`（**确认单**的基础）：整条流水线照跑（含结果层复核与字节级核对），
但 `applied` 恒为 false、结论放进 `wouldApply`，`after.xml` 照样返回给前端做预览。预览与真跑的 `after.xml`/`diff`/`guard`
**逐字节一致**（有测试钉死）。生成式通道的预览也只调用一次模型，确认时不会再花钱。

`/api/command`、`/api/instruct`、`/api/generate`、`/api/apply-ops` 的返回统一是：
`scope` / `ops` / `writes` / `changedCells` / `after.xml` / `diff`（改动账本）/ `summary`（一句话）/
`guard.{intent, result, byteIdentical}` / `warnings` / `ms` / `applied`。
`/api/generate` 另带 `attempts` / `usage`（token）/ `modelLog`（每次尝试的成败与原因）。

所有响应都带 CORS 头，`OPTIONS` 预检回 204 —— Phase 2 的 drawio 插件是从 drawio 自己的 origin
（默认 `http://localhost:8080`）跨源调过来的，发的是 `application/json`，浏览器必然先发预检。

## 四个关键设计

**1. 三层作用域，且"能改什么"与"能看到什么"解耦**

```
writable = roots ∪ descendants(roots) ∪ 相连的边（includeEdges='connected'，默认）  ← 唯一可写
context  = 父容器链 + 同层邻居（有界，默认 12 个）+ 边界边                        ← 只读，给上下文
skeleton = 其余全部：容器逐条给 id/label/childCount，其余按数量汇总                 ← 只读，给结构边界
```

- 只给"可改"会让模型把边接错、把容器拆坏；给全图就没有 token 收益。中间那层才是关键。
- **邻域必须有界**：draw.io 最常见的形态是所有元素 `parent="1"`，此时"同层邻居"**等于全图**。
  不设上限就退化回"把整张图发出去"，所以按**几何邻近度**排序截断，被截掉的降级进 skeleton（不是消失）。
  这条是被验收 3 抓出来的真实缺陷，回归测试见 `test/scope.test.mjs`。
- 被截断的容器仍会在 compact 骨架里**逐条**出现，所以模型想 `add` 到某个容器时依然拿得到它的 id。

**2. 保偏移解析：把"未选中元素逐字节不变"变成结构性保证**

`src/xml.mjs` 不做"解析成对象再重新序列化"，而是给每个节点记录它在原文里的区间；
写操作是"替换某个属性的值区间"。因此没被写到的元素不是"重新生成后内容相同"，是**字节没动过**。
验收 2 直接核验这一点（`byteIdenticalOutside`）。

**3. 两层 guard，而且不信任任何自述**

| 层 | 函数 | 依据 | 为什么不省 |
| --- | --- | --- | --- |
| 意图层 | `guardOps` | Op 指向的 id ⊆ writable | 便宜，能在"执行前"整批拒绝（回灌模型重试） |
| 结果层 | `verifyCandidate` | 重新解析改动前后 XML，算**真实改动集合** | S2 的教训：写回方声称的成功不算数，必须自己算 |

结果层连我们自己的应用器也不信任 —— 它是"给未来改动兜底的断言"，不是重复劳动。
Phase 1 默认不放行 AI 通道的 `update/add/delete`（`allowAiKinds` 默认 false），确定性通道先行。

**4. 确定性命令通道（零 LLM）**

`align / distribute / size / square / move / style` 直接产出可审计的 Op：快、准、免费、不吃配额、无幻觉。
两个细节：**no-op 过滤**（对齐锚点元素、分布两端不产生无意义写入）；**跨父容器按父容器分组**各自算基准，
并明确提示（子元素的坐标是相对父容器的，混在一起算就是错的）。

**5. 先分流、再生成：80% 的改动不该付一次 LLM 调用**

一句话进来先过**规则表**（`src/instructions.mjs`，顺序即优先级）：对齐/分布/等尺寸/移动/变个颜色就地执行 ——
快、准、免费、无幻觉。只有没命中的才落到生成式通道。规则表刻意**只做关键词命中、不做语义理解**：
宁可漏判（交给模型），不可错判（改错东西）。两个真实的坑写在注释里：*"垂直居中"必须排在裸"居中"之前*；
颜色词必须**带动作词**（变/改/刷/换…），否则"红色"这种名词会把句子误判成"要变红"。

**6. 生成式通道：模型只产出"意图"，落盘永远由我们做**

```
模型 → Op（JSON：style/move/align/size/distribute/update/add/delete）
     → parseModelOps 逐项校验（未知 kind / 幻觉 id / id 撞车 / 非法 <mxCell> / 父容器不存在）
     → guardOps（意图层，Op 指向的 id ⊆ writable）
     → 和确定性通道**完全相同**的 opsToWrites → applyWrites → verifyCandidate → byteIdenticalOutside
```

这条分工是整套设计能成立的原因：模型拿不到"直接改文件"的能力，它最多只能提出**越界的 Op**，
而越界 Op 会被 guard **整批拒绝**（`update/add/delete` 需要显式 `allowAiKinds` 才放行）。
第一次输出被拒就把拒绝原因回灌给模型重试一次；两次都不行就明确失败，**绝不部分应用**。

## 已知限制（都是刻意的）

- **只支持明文 XML**：drawio 的压缩载荷（base64）会明确报错，不静默产出错数据。
- **不做布局引擎**：不自动避让重叠、不重排，几何命令只做用户明确要求的对齐/分布/移动。
- **单页**：只处理第一个 `<diagram>`；多页是 Phase 2 的事。
- **生成式通道只走了单轮**：没有多轮对话、没有"上一版图表"的记忆，每次都是"当前 XML + 选区 + 这句话"。
- **样式白名单只有 10 个属性**：模型给出白名单外的样式（如 `shape=mxgraph.aws4.*`）会被**忽略并给警告**
  （`样式 xxx 不在白名单里，已忽略`）—— 所以"把矩形变成菱形"这类**换形状**的诉求目前会部分落空。
- **模型产出的几何是"它自己算的"**：`add` 出来的坐标靠模型给，模型可能算得不好看（重叠、贴边）；
  原型只保证"不越界、结构合法"，不保证"排得好看"。
- **预览是"整段替换"式的**：预览态直接渲染 `after.xml` 的全量结果（不是叠加一层 diff 图层），所以它显示的是
  "应用后长什么样"，而不是"变化的过程"（没有动画/逐条回放）。
- **前端不做虚拟化**：几百个 cell 的 SVG 预览会卡；>500 cell 的耗时还没测（设计文档附录 B5）。
- **预览里选不了边**：框选只挑顶点（边没有独立可点的形状，只有一条线）；要选边目前用大纲勾选。
- **点选遵循叠放顺序**：大矩形盖住小元素时，点上面命中大矩形（与 draw.io 一致，不做穿透）。

## 接进真实画布（Phase 2）

Phase 2 **第一小步已跑通**（一条命令：对齐），`upstream/` 仍然一行没改。链路：

```
drawio 右键「AI 局部修改…」→ 悬浮指令框 → POST /api/instruct {xml, roots, instruction}
  服务端：规则分流 / 模型调用 → Op → guard → writes
  插件：把 writes 落进当前模型（一次 beginUpdate = 一条撤销记录），只动 writes 点名的 cell
```

要点与踩过的坑（详见 `RESULT.md` §5.7、`../docs/scoped-editing-design.md` 附录 F.4）：

- **服务端算 `writes`，客户端照做**：插件里没有语义与几何逻辑，guard 只有服务端一处。
- **接线三件套缺一不可**：① 插件由 PreConfig 注入 drawio；② 浏览器放行端点（drawio 自带 CSP 的 `connect-src`
  要加上 `AI_SCOPE_ENDPOINT` 的 origin，否则 fetch 在 iframe 里静默失败）；③ 服务端放行跨源（CORS + 预检）。
- **端点怎么配**：`AI_SCOPE_ENDPOINT`（shell 环境变量 > 工作目录 `.env` > 默认 `http://127.0.0.1:8787`），
  由 `../tools/gen_drawio_custom.py` 在**生成 `PreConfig.js` 时**读入 → 改完要重跑 `build` 并重启 drawio 容器。
- **别指望画布自带的撤销**：应用内 drawio 的撤销栈只有约 1.2 s 生命（应用侧会把图再 `load` 回去，
  详见 `RESULT.md` §5.7）。插件侧曾经为此刻意做过一条「复原上一次改动」（自己存改动前的完整 XML），
  **后按产品决策移除** —— 产品上把"回退上一次"交给 drawio 自带的撤销，面板不再重复这个入口。

跑起来（本地）：

```bash
# 生产形态：从仓库根目录启动 compose，ai-scope 服务会自动托管本服务
./deploy.sh up

# 本地开发/调试：手工启动原型服务
cd prototype && set -a && . ../.env && set +a && node server.mjs     # :8787
# 2) 画布侧：drawio 容器已挂载插件；改了端点要先重新生成并重启
python3 ../tools/gen_drawio_custom.py build
docker compose --project-directory .. -f ../upstream/docker-compose.yml -f ../docker-compose.yml \
  --project-name next-ai-draw-io restart drawio
# 3) 回归
cd ../spikes/s1 && ./harness/run.sh phase2-instruct.mjs       # 真画布 19 条
./harness/run.sh phase2-in-app.mjs                            # 应用内（:3000）16 条
./harness/run.sh phase2-generative.mjs "把 Beta 往右下挪一点"  # 生成式支路（真调模型，5 条）
```

对应关系：`resolveScope` → 服务端作用域解析；`guardOps`/`verifyCandidate` → 服务端硬校验；
`commands.mjs` → 确定性操作条；`renderScopeText`/`estimate` → 子图 prompt 构造与 token 预算。
