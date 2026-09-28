# S2 spike 报告：写回（patch / merge / load）在"只改选中元素"时的真实语义

**一句话结论：三条路里只有 `patch` 是真正的"局部写回"；`merge` 不是局部更新 API（它是"以来件为权威文档"的差异合并，载荷里没有的元素会被删掉）；`load` 是整页替换。另外 drawio 31.4.6 的 embed 里 `merge`/`patch`/`getDiff` 会回一个假错误，改动却已生效。**

- 日期：2026-09-24；环境同 S1（drawio `31.4.6` 容器 + Alpine chromium/Playwright）
- 实验方法：同一份基准图（A=cell2、B=cell3、边=cell4）每次重置，用 drawio 自己的 `checksum` 与逐 cell 值对比，看"改了什么 / 误伤什么 / 应用能否感知 / 怎么重新同步"
- 证据：`results/spike-d3.log`（结论版）、`results/probe-autosave.log`、`results/probe-getdiff.log`
  - **2026-09-24 更新**：插件已改为"由部署层只读挂载注入"（见 `S3-RESULT.md`），`results/` 里的日志按新机制重跑补齐，结论一致；
    早期一版日志在 S3 清理时被误删。`spike-d2.log`/`spike-d.log` 未重跑（内容已被 d3 取代），如需请按 §7 自行生成。

---

## 1. 实测矩阵

基准图：`2=Alpha`、`3=Beta`、`4=边`，pageId=`PAGE1`；目标改动：把 cell 2 的值改成 `Alpha-EDITED`（模拟"只改选中的那个元素"）。

| # | 路径 | 载荷 | 目标元素 | **其他元素** | pageId | 应用能否感知 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `load` | 裸模型，只含 cell 2 | ✅ 改了 | ❌ **3、4 全被删** | ❌ 变了 | ❌ 只回 `load` 回执 |
| 2 | `merge` | 裸模型，只含 cell 2 | ✅ 改了 | ❌ **全被删** | ❌ 变了 | ✅ `autosave` |
| 3 | `merge` | mxfile+id，只含 cell 2 | ✅ 改了 | ❌ **全被删** | ✅ 不变 | ✅ `autosave` |
| 4 | `merge` | mxfile+id，全量 + 改 cell 2 | ✅ 改了 | ✅ **3、4 原样保留** | ✅ 不变 | ✅ `autosave`（含完整 xml） |
| 5 | `merge` + `diffSync` | mxfile+id，全量 + 改 cell 2 | ✅ 改了 | ✅ 保留 | ✅ 不变 | ✅ `autosave`，且**带 patch+checksum**（增量同步可用） |
| 6 | `patch` | cell 级 patch | ✅ 改了 | ✅ **保留** | ✅ 不变 | ❌ **收不到 autosave** |
| 7 | `patch` + 错误 checksum | cell 级 patch | ✅ 仍然改了 | ✅ 保留 | ✅ 不变 | ❌ 无 `checksumMismatch` 标记（见 §3） |

（第 6 行是唯一的"无损局部写回"；第 4/5 行是"全量 merge"，需要应用每次把整图发过来。）

---

## 2. 三条路的确切语义

### 2.1 `load` = 整页替换
- 载荷只含 cell 2 时，cell 3、4 直接消失；**pageId 也换了一个新的**（整页被替换，不是原地改）。
- 不发 `autosave`（发起方本来就该知道自己加载了什么）。
- 用途：只适合"整图替换"，不适合局部编辑。

### 2.2 `merge` = 差异合并，但**以载荷为权威文档**
- 实现：`file.mergeFile(new LocalFile(this, xml))` → 内部 `diffPages(当前页, 来件页)` → 把差异当作 patch 应用（`DrawioFile.js:390+`）。
- 因此"载荷里没有的元素"= 差异里的删除项 → **被删掉**。第 2、3 行就是这么误删掉 3、4 的。
- **必须用 `<mxfile><diagram id="与原页面相同">` 包装**：裸 `<mxGraphModel>` 没有页面身份，差异会退化成一整页替换，pageId 跟着变（第 2 行；带 id 的第 3 行 pageId 才不变）。
- 结论：要做局部修改又想用 merge，**必须发全量文档**（第 4 行），等价于"把整张图发回去"，丢失了"只传改动"的意义。

### 2.3 `patch` = 真正的 cell 级局部写回
- 载荷是 cell 级 patch，格式（drawio 自己产出的实测样本）：

```json
{"u": {"PAGE1": {"cells": {"u": {"2": {"value": "Alpha-PATCHED"}}}}}}
```

  层级：`操作类型(u=update)` → `页面 id` → `cells` → `操作` → `cell id` → `要改的属性`。
- 应用方式：`{action:'patch', patch: <上面的对象>, checksum: <可选>}`。
- 效果（第 6 行实测）：只有 cell 2 变，cell 3、4、pageId、其余一切不动 —— **这就是局部编辑要的原语**。
- 这个 patch 我们可以自己算（服务端按 `Ops` 生成），不必依赖 drawio 的 diff 引擎；drawio 侧只是"应用器"。

---

## 3. 上游 bug：写回成功却回 `error`（必须规避）

drawio 31.4.6 的 embed 分支里，下面三处回调都引用了压缩产物中未定义的闭包函数（对应源码里的 `lastData = getData()`），抛 `TypeError: ya is not a function`：

| 触发 | 现象 | 改动是否生效 |
| --- | --- | --- |
| `merge`（开 `diffSync`） | 回 `{event:'merge', error:{}}`，控制台有 `Error in mergeFile` | ✅ 生效（第 5 行值已改） |
| `patch` | 回 `{event:'patch', error:"ya is not a function"}` | ✅ 生效（第 6、7 行值已改） |
| `getDiff`（**未**开 `diffSync`） | **完全不回响应** | — （开了 `diffSync` 才正常返回 `patch`+`checksum`） |

影响与规避：

1. **不能把 `error` 当成"写回失败"**：客户端必须以"读回校验"为准（或直接信任本地 Ops + 后续校验），否则会把已成功的写回当失败重试。
2. **`checksum` / `checksumMismatch` 在本版本不可达**：patch 分支在算出 checksum 之前就抛错中断了（第 7 行：给了错误 checksum 也没有任何标记）→ 并发保护不能依赖它，得由应用层用 `getDiff`/`export` 的 XML 自己算。
3. `merge`（不带 `diffSync`）不抛错，行为正常 —— 要 merge 就别开 `diffSync`。

---

## 4. 写回之后：应用怎么知道画布变了

| 路径 | 应用侧收到 | 含义 |
| --- | --- | --- |
| 用户在画布上编辑 | `autosave`（带完整 xml；开 `diffSync` 时带 patch+checksum） | 正常链路，应用由此维护自己的 XML |
| `merge`（全量，不带 diffSync） | `autosave`（完整 xml，985 字符） | 应用会知道 |
| `patch` | **只有 `patch` 回执（且带假错误），没有 autosave** | ⚠️ 应用**不会**知道画布变了（drawio 在 patch 期间抑制了 change 通知） |
| `load` | 只有 `load` 回执 | 发起方自己知道 |

**重新同步的可靠手段（实测有效）**：`{action:'export', format:'xml'}` → 回 `{event:'export', xml: <最新 xml>}`，里面包含刚 patch 进去的新值（`results/spike-d3.log` §8，xml 长度 986、含 `Alpha-PATCHED`）。

所以 Phase 2 的写回闭环应该是：

```
插件/服务端算出 cell 级 patch → 发 patch → 读回校验（export 或 getDiff）→ 用读回结果更新应用侧 XML → 应用侧状态与画布一致
```

---

## 5. 对 Phase 2 的结论与建议

1. **写回用 `patch`**（cell 级，自己构造），不要用 `merge` 传局部载荷 —— 后者会静默删掉载荷外的一切。
2. **降级顺序改为**：`patch` → `merge（全量文档 + 相同 diagram id）` → `load（整页替换，需提示用户）`。
   - 降级到 merge 时必须整图回传，代价是往返数据量，而不是正确性。
   - 降级到 load 会丢视图与撤销栈、且 pageId 变化，需要在 UI 上明确提示。
3. **写回后必须主动刷新应用侧 XML**（`export` 或 `getDiff`），不能等 `autosave` —— patch 不触发它。
4. **不要把 drawio 回执里的 `error` 当失败**（§3），以读回结果为准。
5. **不要依赖 `checksumMismatch`** 做并发保护；改成应用侧比对读回的 XML/checksum 自己实现。
6. 撤销栈与选区：patch 应用后选区与其余元素不受影响（第 6 行前后值完全一致，仅目标 cell 变化），说明"无损局部写回"在画布层面成立。

---

## 6. 遗留

- ~~插件内直接 `graph.getModel().beginUpdate()` 写入是否进撤销栈、是否保留选区~~ → **S3 已关闭**：
  进撤销栈（一次事务 = **一条**撤销记录）、撤销一次完全还原、**选区保留** —— 见 `S3-RESULT.md` §1。
- `results/probe-autosave.log` 在 ⑤ 处中止：embed 模式下 `ui.pages` 为 null，脚本里 `ui.clonePages(ui.pages)`
  抛错（脚本自身的限制，不是 drawio 的问题）。① ② ③ ④ 的结论在此之前已全部打印；
  "错误 checksum 也不会有标记"这条结论由 `spike-d3.log` 第 7 步独立验证。
- 大图（>500 cell）下 patch 的耗时与 `prefetchFonts` 等参数的影响。
- 多页文档（`ui.pages.length > 1`）时 patch 的 `pageId` 选择与跨页作用域。

## 7. 复现

```bash
cd /home/sunhaha/deploy/next-ai-draw-io/spikes/s1

# 前置：drawio 侧定制已由部署层挂好（见 S3-RESULT.md §3），不需要再手工 docker cp 插件/PreConfig
../../deploy.sh plugin-check

cd harness
./run-host.sh spike-d3.mjs          | tee ../results/spike-d3.log          # 结论版矩阵
./run-host.sh probe-autosave.mjs    | tee ../results/probe-autosave.log    # autosave 行为（⑤ 起会因脚本限制中止，见 §6）
./run-host.sh probe-getdiff.mjs     | tee ../results/probe-getdiff.log
```

`run-host.sh` 会自动把宿主页（`spike.html`/`spike-b.html`/`spike-e.html`）拷进 drawio 容器并在退出时删除 ——
宿主页必须与 drawio 同源才能直接驱动 iframe 里的编辑器。不需要再手工还原 `PreConfig.js`：
现在它是**挂载**出来的，容器里本来就没有需要还原的临时副本。
