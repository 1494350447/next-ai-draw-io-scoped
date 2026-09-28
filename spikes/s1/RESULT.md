# S1 spike 报告：drawio 插件能不能拿到画布选区

**结论：通过（真实浏览器 + 真实鼠标事件实测）。**
插件能挂上、能读到选区、能把选区回传宿主；父窗口还能反向驱动插件动作；右键菜单条目可挂、可点。
附带推翻了两条设计报告里"已核实"的结论（见 §4）。

- 日期：2026-09-24
- drawio：`31.4.6`（`jgraph/drawio:latest` 容器，`127.0.0.1:8080`）
- 应用：Next.js app，`127.0.0.1:3000`（上游 checkout 未改一行）
- 浏览器：临时容器 `s1-spike-browser`（Alpine chromium `152.0.7977.82` + Playwright `1.63.0`，`--network host`）
- 上游仓库状态：`upstream/` 保持 git 干净；所有改动只落在本目录和容器运行态

---

## 1. 判定标准

| # | 判定项 | 门槛 |
| --- | --- | --- |
| S1-1 | 最小插件能被 drawio 加载并回调 `ui` | 收到 `aiScopeReady` |
| S1-2 | 插件能听到画布选区变化 | 真实鼠标点击后拿到正确的 cell id |
| S1-3 | 选区能回传宿主 | 宿主窗口收到 `{event:'aiScope', reason:'selectionChanged', ids:[...]}` |
| S1-4 | 宿主能反向驱动编辑器 | `{action:'invokeAction'}` 触发插件动作并回传 |
| S1-5 | 右键菜单入口可行（用户设想的 UX 前提） | 菜单里出现插件条目，且**真实点击**能触发动作 |

> **2026-09-24 更新（S3 收尾）**：插件已从"spike 期临时 `docker cp`"提升为**部署资产**——
> `drawio-custom/PreConfig.js` + `drawio-custom/plugins/ai-scope.js` 由 compose 只读挂载进 drawio 容器，
> 重启/重建后依然生效（`./deploy.sh plugin-check`，见 `S3-RESULT.md`）。
> 因此本目录的脚本有两处变化：① 运行时**不再需要手工 `docker cp` 插件与 PreConfig**（只有宿主页还需要，
> 由 `harness/run-host.sh` 自动处理）；② 适配层的调试全局 `window.__aiScope` 现在只在
> embed URL 带 `?aiScopeDebug=1` 时暴露，宿主页 `spike.html`/`spike-b.html` 已补上该参数。
> `results/` 里的原始日志在本轮按新机制**重跑补齐**（结论一致；差异见 §2.1 与 §7）。
> 更早的一版日志在 S3 清理时被误删，本文件与 `S2-RESULT.md` 的结论均以重跑日志为准。

---

## 2. 验证矩阵

| 验证 | 路径 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| A | 产品路径：父页面 iframe 内嵌 drawio embed，走 `init`/`load` 握手 + `postMessage` 回传 | ✅ | `pluginLoaded=true`；脚本化点击后 `selectionAfterCount=1`、`scopeEventSeen=true`；`invokeAction` 回传 `["2","3","4"]` |
| B | 真实鼠标事件（trusted）点选 + 右键菜单点击 | ✅ | `selectionAfter=["2"]`；右键菜单 2 个、38 项，其中有 `aiScopeProbe`；点击该条目 → 回传 `invokeAction` 且选区 `["2"]` |
| C | 真实 app 页面（`:3000`）内嵌的 drawio | ✅ | 插件**零改造自动生效**（embed URL 里既没有 `?plugins=` 也没有 `aiScopeDebug`）；app 窗口收到 `aiScopeReady`；跨 origin 往返 OK（`invokeAction aiScopeSelectTop` → `aiScope{count:2, ids:["2","3"]}`）；真实鼠标点击命中节点 → `aiScope{selectionChanged, ids:["2"]}` |

原始日志：`results/spike-a.log`、`results/spike-b.log`、`results/spike-c.log`。

### 2.1 验证 C 的补充说明（已改为非破坏性 + 纯生产通道）

真实 app 的 embed URL 由上游代码决定，我们插不进参数，所以这一条**不读任何调试全局**，只用
drawio 官方 embed 协议 + 插件自己 postMessage 回宿主的事件：

```
app 窗口收到: aiScopeReady(版本, 无 debug) 
            → export（先备份 app 当前图，405 字符）
            → load（载入测试图 spike-1/spike-2）
            → invokeAction aiScopeSelectTop → aiScope{reason:"selectTop", count:2, ids:["2","3"]}
            → 真实鼠标点击 (240,200) → aiScope{reason:"selectionChanged", count:1, ids:["2"]}
            → load（把 app 原来的图还原）
```

两条关键点：① **跨 origin 双向通道成立**（app → iframe 的动作、iframe → app 的事件）；
② 真实鼠标点击在真实 app 页里同样被识别为选区变化。`undoDepth` 也随事件回传（当前实现走
`ui.editor.undoManager`，见 `S3-RESULT.md` §1.1）。

早期版本是"用 drawio API 往 app 画布里插两个节点再点"，会污染用户当前图；现在改成先 export 备份、
测完 load 还原。

---

## 3. 交付物

| 文件 | 作用 |
| --- | --- |
| `../../drawio-custom/plugins/ai-scope.js` | 适配层插件（spike 期产物已提升为部署资产）：读选区 + 回传 + 注册动作 + 挂右键菜单条目 + 写回 |
| `../../drawio-custom/PreConfig.js` | **唯一可行的挂载点**：由 `tools/gen_drawio_custom.py` 生成，注入同源插件脚本 |
| `../../drawio-custom/PreConfig.image-orig.js` | 从镜像里取回的**原版**（仅供对照；容器运行时的那份由 entrypoint 重写，见 `S3-RESULT.md` §3） |
| `drawio-custom/PreConfig.js(.orig)`（本目录，历史） | S1 期的临时副本，已被上一行的正式资产取代，保留作为当时的记录 |
| `spike.html` / `spike-b.html` / `spike-e.html` | 容器内的宿主页（iframe 框住编辑器，负责 `init`/`load` 握手） |
| `harness/spike-{a,b,c}.mjs` | Playwright 驱动脚本（A：产品路径；B：真实鼠标+右键；C：真实 app） |
| `harness/spike-{d,d2,d3}.mjs` / `harness/spike-e.mjs` / `harness/spike-f.mjs` | S2（写回语义）/ S3（撤销栈·选区 / 真实 app 生产通道） |
| `harness/spike-g.mjs` | **Phase 1 跨系统验证**：把 `prototype/` 产出的 XML 交给真实 drawio load → export 回读比对（用独立实现的解析器）；`results/phase1-{before,after}.xml` 是产物，`phase1-command.json` 是原型那侧的返回值 |
| `harness/probe-*.mjs` | 排查过程用的诊断脚本（load 载荷 / 编辑器实例归属 / 撤销管理器定位） |
| `harness/Dockerfile.browser` + `run.sh` + `run-host.sh` | 浏览器环境（宿主机没浏览器、也缺 `libnss3`，所以关在容器里跑）；`run-host.sh` 额外负责宿主页的进出容器 |

---

## 4. 实测发现（都会改设计，逐条列证据）

### 4.1 `?plugins=` 加载不了我们的插件（原设计 A5 结论有误）

drawio 31.4.6 里 `urlParams['plugins']` **只当开关用**（判断 `!= '0'`），真正的插件列表来自 `mxSettings.getPlugins()`（设置里的插件列表）或 `?p=<registryKey>`（**内置白名单**）。
而且非内置插件还要 `window.ALLOW_CUSTOM_PLUGINS = true`，否则只打一句 `console 'Unknown plugin'` 就静默跳过——**没有任何报错**，从外表看就像"插件没加载"。

- 证据：`draw/js/diagramly/App.js:993,1023,1039-1046`、`Init.js:79`（默认 `false`）
- 实测：第一次跑验证 A 时 `pluginLoaded=false`、`errors=[]`、控制台无任何异常

### 4.2 唯一可行的挂载点是 `PreConfig.js`（官方定制入口）

`js/PreConfig.js` 在 drawio 应用脚本之前执行，是官方留给自托管的改造点。在里面做两件事即可：

```js
window.ALLOW_CUSTOM_PLUGINS = true;
(function () { var s = document.createElement('script');
  s.src = window.AI_SCOPE_PLUGIN_URL || 'plugins/ai-scope.js';
  (document.head || document.getElementsByTagName('head')[0]).appendChild(s); })();
```

- 仍是同源加载，不碰 CSP；跨源插件依旧会被 `script-src` 拦（原 A7 结论成立）。
- 插件脚本**必须轮询等 `Draw.loadPlugin`**：注入时机早于 drawio 定义该 API。

### 4.3 `init` 事件只在被 iframe 框住时才发

顶层直接打开 `/?embed=1&proto=json` 时收不到 `init`，因此也不会发生 `load`，画布永远是空的。
调试时如果直接把 embed URL 当顶层页面打开，会误判成"插件没加载"。验证 B 因此专门做了个薄宿主页 `spike-b.html` 来框住编辑器。

### 4.4 `model.getChildren(root)` 只返回 layer，不是元素

mxGraph 的 `getChildren` 不递归：`getChildren(model.getRoot())` 只拿到默认 layer（id `1`）。
它让我白排查了一轮（模型里明明有 `0,1,2,3`，我却读成"图没加载"）。
正确姿势：遍历 `Object.keys(model.cells)` 再按 `isVertex/isEdge` 过滤。

### 4.5 合成鼠标事件选不中，必须补 pointer 事件

只派发 `mousedown/mouseup/click` 时选区始终为空（`selectionAfterCount=0`），补上 `pointerdown/pointerup` 后立刻生效。
说明 drawio 这一代的手势栈走 pointer 事件。**真实鼠标点击不受影响**（验证 B/C 都是真实事件）。

### 4.6 应用自身的 autosave/export 会清空画布选区（Phase 2 风险）

验证 C 里，点击节点后 app 先收到 `selectionChanged["spike-1"]`，紧接着收到 `selectionChanged[]`；同一时刻 app 还收到了自己的 `autosave` 与 `export` 事件。
含义：**局部编辑的作用域不能依赖"当前选区"这个瞬时状态**，必须以 id 集合保存，并在每次操作前做有效性校验（元素是否还存在、是否被应用重绘换掉）。

### 4.7 `load` 载荷很宽容

裸 `<mxGraphModel>` 与 `<mxfile><diagram>` 包装两种都能加载成功（验证 B 的三种载荷全部 `ok=true`）。回写时不必纠结包装格式。

---

## 5. 对 Phase 2 的意义

- **架构报告里的方案 B 可行**：画布选区 + 悬浮框的入口技术上成立，且"右键菜单 + 插件动作"这条链路已实测可点。
- **"插件必须是适配层"这点被强化**：只有插件能读到选区，且插件必须由 drawio 侧加载；应用侧一行都不用改（验证 C 直接证明）。
- **部署形态已经明确**：给 compose 覆盖层加一个只读挂载（不改上游仓库）：

```yaml
services:
  drawio:
    volumes:
      - ./drawio-custom/PreConfig.js:/usr/local/tomcat/webapps/draw/js/PreConfig.js:ro
```

- **状态模型要改**：作用域 = 稳定的 id 集合（不是"当前选区"），配合 §4.6 的校验兜底。
- **越界校验仍在服务端**：本次 spike 只证明"能读到选区"，不改变"写回必须服务端校验"的结论。

---

## 6. 怎么复现

```bash
cd /home/sunhaha/deploy/next-ai-draw-io/spikes/s1

# 0) 前置：drawio 侧定制已由部署层挂好（一次性，见 S3-RESULT.md §3）
../../deploy.sh up && ../../deploy.sh plugin-check

# 1) 跑验证（首次会自动构建浏览器镜像，走清华源约 30s）
#    run-host.sh 会自动把宿主页拷进 drawio 容器（同源），退出时删掉，不需要手工 docker cp
cd harness
./run-host.sh spike-a.mjs | tee ../results/spike-a.log   # 产品路径
./run-host.sh spike-b.mjs | tee ../results/spike-b.log   # 真实鼠标 + 右键菜单
./run-host.sh spike-c.mjs | tee ../results/spike-c.log   # 真实 app 页面（不需要宿主页，但用同一个入口）
./run.sh      spike-c.mjs                                 # （等价：C 只开 app 页）
```

不做任何需要还原的改动 —— 定制是挂载出来的，容器里本来就没有残留资产。

## 7. 本次残留

| 项 | 状态 |
| --- | --- |
| drawio 容器内的 `PreConfig.js` | **是我们挂载的那份**（预期行为，不是残留）：与 `drawio-custom/PreConfig.js` sha256 一致，`./deploy.sh plugin-check` 每次都会校验 |
| 容器内 spike 资产（宿主页） | **已删除**，`/spike-e.html` 等一律 404 |
| `upstream/` 仓库 | 未改动（git 干净） |
| `s1-spike-browser` 镜像 | 保留（约 1.39GB），便于复跑；删除：`docker rmi s1-spike-browser` |
| `harness/node_modules` | 保留（约 19MB） |
| `results/` 原始日志 | 2026-09-24 按新机制**重跑补齐**（早先一版在 S3 清理时被误删）；`probe-autosave.log` 在 ⑤ 之前中止，原因见 `S2-RESULT.md` §6 |

服务健康检查（清理后）：drawio `200`、app `307`（正常跳转）。

---

> 本目录同时是 S2 的工作区（目录名保留 s1 是历史原因）。

## 8. 后续进展

1. **S2 已完成**：写回三件套（`patch` / `merge` / `load`）在"只改选中元素"下的语义已实测 —— 见 `S2-RESULT.md`。
   一句话：只有 `patch` 无损；`merge` 的载荷是权威文档（缺的元素会被删）；三条路都会回上游的假错误。
2. **S3 已完成**：`PreConfig.js` 挂载已写进 compose 覆盖层并经 `restart` / `--force-recreate` 双向验证；
   插件内 `beginUpdate()` 写回**进撤销栈且一次写回 = 一条记录**，撤销一次完全还原，**选区不丢** —— 见 `S3-RESULT.md`。
   Phase 0 三个 spike 至此全部关闭。
3. 设计文档已同步：`docs/scoped-editing-design.md` 的 A5 被修正、B1/B2/B3 关闭、D6 降级链改为 `patch → merge(全量) → load`，
   新增 B6（选区被应用重绘清空）、附录 C（S1）、附录 D（S2）与附录 E（S3）。
4. **Phase 1 已完成**（2026-09-24）：`prototype/` 是零依赖的作用域编辑骨架，三条验收条件全过
   （越界率 0 / 未选中元素逐字节不变 / 大图输入 token 3.0%；48 个测试）。
   设计文档新增附录 F、决策 D11（**只读邻域必须有界**）。
   附带浏览器冒烟（`harness/smoke-prototype.mjs`，`results/smoke-prototype.log`）：10 条断言全过，
   期间抓到两个单测覆盖不到的缺陷（空选区被当错误 → 页面首屏不可用；结构摘要误含默认层 → 大纲每行渲染两遍），均已修复；
   并补齐了预览交互（点空白清空 / 拖拽框选 / Shift 加选 / Esc）及其 7 条浏览器断言。
5. **跨系统验证 `spike-g.mjs`**：把原型经 HTTP 产出的 `after.xml`（真实导出的 `cat-demo.xml` 做一次 `align left`）
   交给真实 drawio 31.4.6 load → export 回读，独立解析器比对结果 `added=[] removed=[] changed={"2":["geometry"]}`，
   其余 20 个元素语义完全不变。日志 `results/spike-g.log`。

6. **Phase 1 续（2026-09-25）**：指令分流（25 条规则）+ **生成式通道接真实模型**（`deepseek-flash`，
   OpenAI 兼容协议）+ 改动账本 / 改动高亮 / 撤销本轮 + **应用前确认单**（`dryRun` 预览 → 应用）。
   测试 48 → **86 passed**；浏览器冒烟 10 → **25 条断言**（`results/smoke-prototype.log`，含真实模型调用），
   外加确认单三态与 cat-demo 拖拽框的截图 `results/shots/`。
   最有价值的一条证据：让模型"把作用域外的元素全删掉"，它两次尝试都被 guard **整批拒绝、一个字节没写** ——
   越界防线不依赖模型听话。密钥仍只走 `.env` 的 `DEEPSEEK_API_KEY`（原型不新增配置项，跑的时候 `set -a; . ../.env; set +a`）。
   随后按用户实测反馈又改了两处（`prototype/RESULT.md` §5.6）：① 修掉 **cat-demo 鼠标与画面错位**的真 bug
   （手算缩放 vs 浏览器 `preserveAspectRatio` 的约束轴；改用 `getScreenCTM()`，并做了对照实验证明回归断言有效）；
   ② 指令流程改成一入口自动分流（未命中直接交给模型并直接应用，只通知"走的规则还是模型"）。
   细节见 `prototype/RESULT.md` §5.3–§5.6、设计文档附录 F.1–F.3。

> Phase 1 之后，"这个功能能不能做"已经全部验证完毕，剩余的是纯工程活（Phase 2：把原型的作用域接上画布选区与 `patch` 写回）。
