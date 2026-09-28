# S3 spike 报告：插件在生产形态下活着（重启/重建后仍在），且写回进撤销栈、保留选区

**一句话结论：drawio 定制可以做成"重建即生效"的生产形态（只读挂载顶掉 entrypoint 每次重写的那份 `PreConfig.js`）；
插件内直接改 model 的写回**进撤销栈且一次写回 = 一条撤销记录**，撤销一次即完全还原，并且**选区不会丢**。
Phase 0 的三个 spike 至此全部关闭，剩下纯工程活。**

- 日期：2026-09-24；环境同 S1/S2（drawio `31.4.6` 容器 + Alpine chromium/Playwright）
- 实验方法：**全部走生产通道** —— 插件由 `js/PreConfig.js` 自动注入（embed URL 里没有 `?plugins=`），
  动作调用走 drawio 官方 `{action:'invokeAction'}`，状态用 `{action:'export', format:'xml'}` 读回。
  调试全局只在"给真实点击定位坐标"时用到（`?aiScopeDebug=1`），不参与任何判定。
- 证据：`results/spike-e.log`（撤销栈/选区）、`results/spike-f.log`（真实产品页）、
  `results/probe-undo.log`、`results/probe-undo2.log`（撤销栈定位探针）

---

## 1. 实验一：撤销栈与选区（`spikes/s1/harness/spike-e.mjs`）

基准图同 S2：`2=Alpha(#ffffff)`、`3=Beta(#dae8fc)`、`4=边`，pageId=`PAGE1`。
每一步都"先 load 重置，再动作，再用 export 读回"，对比的是**逐 cell 的 style 字典**。

| # | 动作 | 结果 | 读数 |
| --- | --- | --- | --- |
| 0 | 插件自动加载（无 `?plugins=`、无 debug 判定） | ✅ | `aiScopeReady{version:"31.4.6", hasMenus:true, hasAddAction:true}` |
| 1 | 载入基线 | ✅ | 三个元素的 style 如基准 |
| 2 | 真实鼠标点击 cell 2 | ✅ 只选中它 | 点击坐标 `inGraph:true`；选区 `{ids:["2"],count:1}` |
| 3 | `invokeAction aiScopeRecolor`（只改选中） | ✅ 只动 cell 2 | `changed:["2"]`；`undoDepth 0→1`；`lastEditChanges:2`；`undoEnabledAfter:true`；`selectionAfter:["2"]` |
| 4 | `invokeAction aiScopeUndo`（撤销一次） | ✅ **完全回到基线** | `changedStill:[]`；`undoEnabledAfter:false` |
| 5 | 空选区时写回 | ✅ 走报错分支，无副作用 | 选区 `{ids:[],count:0}` → 回 `{ok:false,error:"没有选中元素"}` |
| 6 | 多选（Shift 点选 2+3）后写回 | ✅ 只改这两个 | `changed:["2","3"]`；`undoDepth 0→1`；`lastEditChanges:4`；`selectionAfter:["2","3"]` |

**这张表回答了三件事：**

1. **写回可撤销，且是"一次操作 = 一条撤销记录"。** 第 6 行最关键：一次事务里改了 2 个元素 × 2 个样式键
   （`lastEditChanges:4`），在撤销栈里只**占一条**（`history 0→1`）→ 用户按一次 Ctrl+Z 就能整体回退本轮，
   不会要按 4 次。实现方式就是 `graph.getModel().beginUpdate()` / `endUpdate()` 包住整批 `setCellStyles`。
2. **写回不动其余元素。** 只有选中 id 的 style 变了（`changed` 就是选中集合本身），边（cell 4）与其他元素逐字节不变。
3. **写回后选区保留。** 第 3、6 行的 `selectionAfter` 等于写回前的选区 —— 这跟应用自身 autosave/export
   会清空选区（S1 附录 B6）形成对比：**写回这条路径不会让用户"选了半天，改完选区没了"**。

### 1.1 顺手修掉的一个真 bug

适配层原先用 `graph.undoManager` 读撤销栈，实测**这个字段在 drawio 31.4.6 里是 `undefined`**：

```
probe-undo:  "graph.undoManager": null   "ui.undoManager": null
             "ui.editor.undoManager": { 构造:"mxUndoManager", history:0, … }
```

真正的栈在 `ui.editor.undoManager`（源码对应 `EditorUndoManager`）。已改为
`ui.editor.undoManager || graph.undoManager`，并在写回报文里补了 `lastEditChanges` / `undoEnabledAfter`；
`aiScopeUndo` 优先走 `ui.actions.get('undo').funct()`，退化到 `undoManager.undo()`。

### 1.2 为什么"程序化写回"和"用户手改"都算一条编辑

`probe-undo2.mjs` 把各种调用方式逐一对比（每次都记 `history.length`）：

| 调用方式 | history 变化 |
| --- | --- |
| `model.setValue`（带 `beginUpdate/endUpdate`） | +1 |
| `graph.setCellStyles`（不带外层事务） | +1 |
| `graph.setCellStyles`（带外层 `beginUpdate/endUpdate`） | +1 |
| `model.setStyle`（带事务） | +1 |
| 一次事务里改两个元素 | **+1（合并成一条）** |

结论：`mxUndoManager` 把**一个事务内的改动合并成一条撤销记录**，所以"批量只改选中元素"天然就是一次可撤销的操作。
（同一探针里"双击改标签"没让 history 增长，是 Playwright 的键盘事件没进 iframe，属测试方法问题，不作为结论。）

---

## 2. 实验二：真实产品页（`spikes/s1/harness/spike-f.mjs`）

打开真实 Next.js 应用 `http://127.0.0.1:3000/`，看它内嵌的 drawio iframe：

| 检查项 | 结果 |
| --- | --- |
| iframe URL | `http://localhost:8080/?embed=1&proto=json&ui=kennedy&spin=0&libraries=0&saveAndEdit...` |
| URL 里有 `?plugins=` 吗 | **没有**（这正是 S1 的负结论：那条路本来就不通） |
| URL 里有 `aiScopeDebug` 吗 | **没有** → 判定完全不依赖调试开关 |
| app 窗口收到 `aiScopeReady` | ✅ `{version:"31.4.6", hasMenus:true, hasAddAction:true, allowCustomPlugins:true, debug:false}` |
| 插件 HTTP | `GET plugins/custom/ai-scope.js → 200`，8383 字节，含 `Draw.loadPlugin` |
| `invokeAction` 通道 | ✅ 回 `aiScope{reason:"invokeAction", count:0}` |
| 页面错误 | 无 |

即：**真实产品页零改造就带上了适配层**，且这条路现在是"部署配置"而不是"临时 docker cp"。

---

## 3. 生产形态怎么落地的（`tools/gen_drawio_custom.py` + compose 覆盖层）

### 3.1 为什么必须用只读挂载顶掉 `PreConfig.js`

镜像的 `/docker-entrypoint.sh` **每次容器启动都会重写** `webapps/draw/js/PreConfig.js`
（`echo … > $CATALINA_HOME/webapps/draw/js/PreConfig.js`，然后追加 CSP、`DRAWIO_*`、`urlParams`）。
所以"把定制版 `docker cp` 进去"只在本次运行有效，**重启即失效**。正确做法是 bind mount 一份只读文件顶掉它：

```yaml
services:
  drawio:
    volumes:
      - ./drawio-custom/PreConfig.js:/usr/local/tomcat/webapps/draw/js/PreConfig.js:ro
      # 插件挂 plugins/ 的**子目录**：直挂 plugins/ 会盖掉镜像自带的 22 个官方插件
      - ./drawio-custom/plugins:/usr/local/tomcat/webapps/draw/plugins/custom:ro
```

### 3.2 只读挂载的代价（实测，已在 `DEPLOY.md` 写明）

entrypoint 开头用 `touch $CATALINA_HOME/webapps/draw/js/PreConfig.js` 探测写权限，只读挂载让它失败，
于是它打印一条 WARNING 后直接启动 Tomcat，**跳过整段运行时改写**：

```
WARNING: No write access to /usr/local/tomcat (running as UID 1001, GID 999).
         Skipping runtime configuration: DRAWIO_* environment variables, SSL and the
         context path will NOT be applied.
```

因此我们把等价内容**静态化**进 `drawio-custom/PreConfig.js`：CSP meta、`DRAWIO_*`、`urlParams[...]=0`。
跳过的东西里对我们无影响的：SSL 自签证书/8443 端口（我们只跑 8080）、Tomcat 子路径 context 重写
（我们不用子路径）、`PostConfig.js` 追加的 3 行（`EditorUi.enableLogging=false`、`isDriveDomain`，
自托管下不涉及）。**代价换来的是"重启/重建后定制仍在"。**

另外把 `DRAWIO_BASE_URL` 从"entrypoint 写的硬编码值"改成了**从 PreConfig.js 自身的
`<script src>` 反推部署前缀**，所以同一份文件在 `/`、`/draw/`、反代子路径下都成立，也不依赖环境变量。

### 3.3 验证方式（可复跑）

```bash
cd /home/sunhaha/deploy/next-ai-draw-io
./deploy.sh plugin-check
```

三步都实测通过（`deploy.sh` 里 `do_plugin_check`）：

1. 当前容器：容器内 `PreConfig.js` 的 sha256 与工作目录文件**同源**、HTTP 能取到 `ai-scope-adapter` 标记与插件、
   `GET /plugins/animation.js → 200`（官方插件没被盖掉）。
2. `docker compose restart drawio` 后同上。
3. `docker compose up -d --force-recreate drawio`（等价镜像升级/重建）后同上 → **通过：重启与重建后插件仍在**。

`./deploy.sh doctor` 也会校验定制资产自洽（生成物 vs 模板、插件存在、compose 里有挂载）以及
`docker-compose.yml` 没被手改。

---

## 4. 对 Phase 1 / Phase 2 的结论

1. **Phase 0 全部关闭**：挂载路径（S1）、写回语义（S2）、撤销栈与选区（S3）都有实测结论，没有悬空假设。
2. Phase 2 的写回闭环确定为：
   `选中 → beginUpdate → 批量改选中元素（样式/几何）→ endUpdate → patch 写回/读回校验`
   —— 插件内直接改 model 这条路**不进"embed patch"通道也能成立**（撤销栈和选区都对），
   两条路可以并存：**插件内改**用于"用户就在画布前、要立刻看到"，**patch** 用于"服务端算好的改动"。
3. 撤销语义已满足验收（"撤销一次点击"）：一次写回 = 一条记录，`undoEnabled` 随之变化，用户 Ctrl+Z 即可整体回退。
4. 作用域状态仍必须存 **id 集合**（不能存"当前选区"）：画布选区会被应用自身的 autosave/export 清空（S1 B6），
   而写回本身不动选区 —— 两者叠加意味着"选区随时可能被外部清掉，写回则不会"。

---

## 5. 遗留（本轮未验，不阻塞）

- 大图（>500 cell）下批量写回的耗时与撤销栈上限（`mxUndoManager` 默认 `size=100`，超出会 trim）。
- 多页文档时"选区跨页"的语义（S2 已列同类遗留）。
- `aiScopeUndo` 只能退一次；"撤销本轮"若要求"连续撤销到本轮之前"，需要记录 baseline depth（Phase 2 再定）。

---

## 6. 复现

```bash
cd /home/sunhaha/deploy/next-ai-draw-io/spikes/s1
./harness/run-host.sh                      # 实验一（自动 docker cp 宿主页，跑完清理）
./harness/run.sh spike-f.mjs            # 实验二（真实产品页）
./harness/run-host.sh probe-undo2.mjs      # 撤销栈探针
```

（`harness/run-e.sh` 只把 `spike-e.html` 拷进容器并要求同源宿主页，退出时自动删掉；不需要再手工还原容器。）
