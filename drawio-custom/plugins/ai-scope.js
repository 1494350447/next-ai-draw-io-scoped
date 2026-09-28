/*
 * ai-scope.js —— next-ai-draw-io 的"作用域编辑"适配层（drawio 侧插件）
 *
 * 它只做适配，不放业务逻辑：
 *   ① 读画布选区并回传宿主窗口
 *   ② 注册可被宿主用 {action:'invokeAction'} 调用的动作
 *   ③ 在右键菜单里挂入口
 *   ④ 提供"只改选中元素"的写回动作（供 S3 验证与后续 Phase 2 复用）
 *
 * 加载方式（实测唯一可行）：
 *   drawio 的 ?plugins= 只认内置白名单，自定义插件必须由 js/PreConfig.js 注入本文件
 *   （见 tools/gen_drawio_custom.py）。注入时机早于 Draw.loadPlugin 定义，所以这里轮询等待。
 *
 * 调试：给 embed URL 加 ?aiScopeDebug=1 才会暴露 window.__aiScope（给同源测试脚本用）。
 */
(function () {
    var DEBUG = (function () {
        try { return location.search.indexOf("aiScopeDebug=1") >= 0; } catch (e) { return false; }
    })();

    function boot() {
        if (typeof Draw === "undefined" || !Draw.loadPlugin) {
            post({ event: "aiScopeError", where: "boot", error: "Draw.loadPlugin 不存在" });
            return;
        }

        Draw.loadPlugin(function (ui) {
            var graph = ui.editor.graph;

            function post(payload) {
                try { window.parent.postMessage(JSON.stringify(payload), "*"); } catch (e) {}
            }

            function version() {
                try {
                    if (window.EditorUi && EditorUi.VERSION) return EditorUi.VERSION;
                    if (typeof App !== "undefined" && App.VERSION) return App.VERSION;
                } catch (e) {}
                return "unknown";
            }

            function geomOf(c) {
                var g = c.getGeometry();
                return g ? { x: g.x, y: g.y, w: g.width, h: g.height } : null;
            }

            // 撤销栈在这个 drawio 版本上不在 graph 上：graph.undoManager 是 undefined，
            // 真正的 mxUndoManager 挂在 ui.editor.undoManager（其实测见 spikes/s1/S3-RESULT.md）。
            function undoManager() {
                try { return (ui.editor && ui.editor.undoManager) || graph.undoManager || null; } catch (e) { return null; }
            }

            function undoEnabled() {
                try {
                    var a = ui.actions.get("undo");
                    return a ? (typeof a.enabled === "function" ? !!a.enabled() : !!a.enabled) : null;
                } catch (e) { return null; }
            }

            function undoDepth() {
                try {
                    var um = undoManager();
                    return (um && um.history) ? um.history.length : null;
                } catch (e) { return null; }
            }

            // 栈顶那一条编辑里合并了几个改动：证明"一次写回 = 一条撤销记录"
            function lastEditChanges() {
                try {
                    var um = undoManager();
                    if (!um || !um.history || um.history.length === 0) return null;
                    var e = um.history[um.history.length - 1];
                    return e && e.changes ? e.changes.length : null;
                } catch (e) { return null; }
            }

            function selected() {
                return graph.getSelectionCells() || [];
            }

            function snap(reason) {
                var cells = selected();
                post({
                    event: "aiScope",
                    reason: reason,
                    count: cells.length,
                    ids: cells.map(function (c) { return c.getId(); }),
                    cells: cells.map(function (c) {
                        return {
                            id: c.getId(),
                            value: String(c.getValue() === null || c.getValue() === undefined ? "" : c.getValue()),
                            style: String(c.getStyle() || ""),
                            geometry: geomOf(c),
                        };
                    }),
                    undoDepth: undoDepth(),
                    version: version(),
                });
            }

            if (DEBUG) {
                window.__aiScope = {
                    ui: ui, graph: graph, snap: snap, version: version, selected: selected,
                    undoDepth: undoDepth, undoManager: undoManager, lastEditChanges: lastEditChanges,
                    // Phase 2：给同源测试脚本用的入口（这段声明在下面，函数声明会提升，调用时机在加载之后）
                    openInstruct: openInstruct, closePanel: closePanel, xmlOf: xmlOf,
                    applyWrites: applyWrites, callInstruct: callInstruct, endpoint: function () { return SCOPE_ENDPOINT; },
                };
            }

            // ① 选区变化（真实鼠标点击与 setSelectionCells 走同一个 selection model）
            try {
                graph.getSelectionModel().addListener(mxEvent.CHANGE, function () {
                    snap("selectionChanged");
                    if (selected().length === 0) closePanel();
                });
            } catch (e) {
                post({ event: "aiScopeError", where: "selectionListener", error: String(e) });
            }

            try {
                graph.view.addListener(mxEvent.SCALE, scheduleSelectionNumberRefresh);
                graph.view.addListener(mxEvent.TRANSLATE, scheduleSelectionNumberRefresh);
                graph.view.addListener(mxEvent.SCALE_AND_TRANSLATE, scheduleSelectionNumberRefresh);
                graph.getModel().addListener(mxEvent.CHANGE, scheduleSelectionNumberRefresh);
                window.addEventListener("resize", scheduleSelectionNumberRefresh);
                window.addEventListener("scroll", scheduleSelectionNumberRefresh, true);
            } catch (e) {
                post({ event: "aiScopeError", where: "selectionNumberRefreshListener", error: String(e) });
            }

            // ② 动作：宿主用 {action:'invokeAction', actionName:'<名字>'} 调用
            ui.actions.addAction("aiScopeProbe", function () { snap("invokeAction"); });

            ui.actions.addAction("aiScopeSelectTop", function () {
                var model = graph.getModel();
                var cells = Object.keys(model.cells).map(function (k) { return model.cells[k]; })
                    .filter(function (c) { return model.isVertex(c) || model.isEdge(c); });
                graph.setSelectionCells(cells);
                snap("selectTop");
            });

            // ④ 写回：只动选中元素，走 mxGraph 的 model 事务（是否进撤销栈由 S3 验证）
            ui.actions.addAction("aiScopeRecolor", function () {
                var cells = selected();
                if (cells.length === 0) {
                    post({ event: "aiScopeWrite", action: "aiScopeRecolor", ok: false, error: "没有选中元素" });
                    return;
                }
                var model = graph.getModel();
                var before = cells.map(function (c) { return { id: c.getId(), style: String(c.getStyle() || "") }; });
                var depthBefore = undoDepth();
                model.beginUpdate();
                try {
                    graph.setCellStyles("fillColor", "#ffe6cc", cells);
                    graph.setCellStyles("strokeColor", "#d79b00", cells);
                } finally {
                    model.endUpdate();
                }
                post({
                    event: "aiScopeWrite",
                    action: "aiScopeRecolor",
                    ok: true,
                    ids: cells.map(function (c) { return c.getId(); }),
                    before: before,
                    after: cells.map(function (c) { return { id: c.getId(), style: String(c.getStyle() || "") }; }),
                    undoDepthBefore: depthBefore,
                    undoDepthAfter: undoDepth(),
                    lastEditChanges: lastEditChanges(),
                    undoEnabledAfter: undoEnabled(),
                    selectionAfter: selected().map(function (c) { return c.getId(); }),
                });
                snap("writeBack");
            });

            // 撤销一次（用于验证写回是否进了撤销栈）
            ui.actions.addAction("aiScopeUndo", function () {
                var a = null;
                try { a = ui.actions.get("undo"); } catch (e) {}
                if (a && a.funct) { a.funct(); } else { var um = undoManager(); if (um) um.undo(); }
                post({
                    event: "aiScopeWrite",
                    action: "aiScopeUndo",
                    ok: true,
                    undoDepthAfter: undoDepth(),
                    undoEnabledAfter: undoEnabled(),
                    selectionAfter: selected().map(function (c) { return c.getId(); }),
                });
                snap("afterUndo");
            });

            // ③ 右键菜单入口
            // 入口用 menu.addItem 直接挂，标签自己给：走 ui.actions/addMenuItems 的话
            // 标签是 mxResources 查 "aiScope*" 的结果，查不到就显示成英文 key（实测菜单里出现过 "aiScopeProbe"）。
            // 动作本身仍然注册（invokeAction 反向通道要用），只是不再出现在菜单里。
            try {
                var origCreatePopupMenu = ui.menus.createPopupMenu;
                ui.menus.createPopupMenu = function (menu, cell, evt) {
                    origCreatePopupMenu.apply(this, arguments);
                    try {
                        // 打开新的右键菜单 = 用户要发起新一次操作：把上一次留下的悬浮框收掉。
                        // 不收它会挡住菜单项本身（实测：上一轮的框正好压在菜单行上，点不到），
                        // 而且那个框指向的是**上一次的选区**，留着也容易让人误判作用域。
                        closePanel();
                        ui.menus.addMenuItems(menu, ["-"], null, evt);
                        var hasSel = selected().length > 0;
                        var aiItem = menu.addItem("AI 局部修改…", null, function () { openInstruct(evt); }, null, null, hasSel);
                        // 位置与配色（产品要求）：紧跟在官方「删除」下面，字体用绿色。
                        // 官方那一行的 title 就是 "Delete"（实测，见 spikes/s1/results/probe-menu-order-undo.log），
                        // 拿它当锚点把我们的行插到它后面；锚点找不到就退回默认位置（追加在末尾），不会因此报错。
                        try {
                            var rows = menu.table ? menu.table.getElementsByTagName("tr") : [];
                            var del = null;
                            for (var ri = 0; ri < rows.length && !del; ri++) {
                                var rowTitle = rows[ri].getAttribute("title") || "";
                                if (/^delete$/i.test(rowTitle) || /^delete$/i.test(String(rows[ri].textContent || "").trim())) del = rows[ri];
                            }
                            if (aiItem && del && del.parentNode) del.parentNode.insertBefore(aiItem, del.nextSibling);
                            var labelCell = aiItem && aiItem.querySelector ? aiItem.querySelector('td[align="left"]') : null;
                            if (labelCell) labelCell.style.color = "#1a7f37";
                        } catch (e) {}
                    } catch (e) {}
                };
            } catch (e) {
                post({ event: "aiScopeError", where: "menu", error: String(e) });
            }

            // ===== Phase 2：选中元素 → 悬浮指令框 → 服务端分流（规则 / 大模型）→ 就地写回 =====
            // 这一段是"局部作用域编辑"在**真实画布**上的落地。分工刻意划清：
            //   · 服务端：语义（这句话是哪条命令 / 该改哪些元素 / 越界与否）+ 算出 writes；
            //   · 插件：只把服务端给的 writes 落进当前模型，一次写回 = 一个 beginUpdate = 一条撤销记录。
            // 插件不含业务逻辑，也不自己算几何 —— 与原型里"绝不手算坐标变换"是同一条纪律。

            var GEO_KEYS = ["x", "y", "width", "height"];

            /** 局部编辑 API 根地址。由 PreConfig 注入（见 tools/gen_drawio_custom.py）。 */
            var SCOPE_ENDPOINT = String(window.AI_SCOPE_ENDPOINT || "http://localhost:3000").replace(/\/+$/, "");
            var PANEL_ID = "aiScopeInstructPanel";
            var NUMBER_LAYER_ID = "aiScopeSelectionNumbers";
            var numberingEnabled = false;
            var numberedCells = null;
            var numberRefreshFrame = null;

            function selectionMarker(index) {
                var markers = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];
                return markers[index] || String(index + 1);
            }

            function orderedSelection(cells) {
                return cells.map(function (cell, originalIndex) {
                    return { cell: cell, rect: screenRectOf(cell), originalIndex: originalIndex };
                }).sort(function (a, b) {
                    if (!a.rect && !b.rect) return a.originalIndex - b.originalIndex;
                    if (!a.rect) return 1;
                    if (!b.rect) return -1;
                    var row = Math.abs(a.rect.top - b.rect.top) > 16;
                    return row ? a.rect.top - b.rect.top : a.rect.left - b.rect.left;
                });
            }

            function selectionAliases(cells) {
                var aliases = {};
                orderedSelection(cells).forEach(function (entry, index) {
                    var id = entry.cell.getId();
                    aliases[selectionMarker(index)] = id;
                    aliases["第" + (index + 1) + "个"] = id;
                });
                return aliases;
            }

            function removeSelectionNumbers() {
                var layer = document.getElementById(NUMBER_LAYER_ID);
                if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
            }

            function renderSelectionNumbers(cells) {
                removeSelectionNumbers();
                if (!numberingEnabled) return;
                var layer = document.createElement("div");
                layer.id = NUMBER_LAYER_ID;
                layer.style.cssText = "position:fixed;inset:0;z-index:99999;pointer-events:none";
                orderedSelection(cells).forEach(function (entry, index) {
                    if (!entry.rect) return;
                    var badge = document.createElement("span");
                    badge.textContent = selectionMarker(index);
                    badge.setAttribute("data-cell-id", entry.cell.getId());
                    badge.style.cssText = "position:fixed;left:" + Math.max(4, entry.rect.left - 9) + "px;top:" + Math.max(4, entry.rect.top - 9) + "px;display:flex;align-items:center;justify-content:center;width:22px;height:22px;box-sizing:border-box;border:2px solid #ffffff;border-radius:50%;background:#1677ff;color:#ffffff;font:700 12px/18px system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 2px 7px rgba(22,119,255,.35)";
                    layer.appendChild(badge);
                });
                (document.body || document.documentElement).appendChild(layer);
            }

            function refreshSelectionNumbers() {
                if (!numberingEnabled || !numberedCells || !numberedCells.length) {
                    removeSelectionNumbers();
                    return;
                }
                renderSelectionNumbers(numberedCells);
            }

            function scheduleSelectionNumberRefresh() {
                if (!numberingEnabled || numberRefreshFrame !== null) return;
                var schedule = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 0); };
                numberRefreshFrame = schedule(function () {
                    numberRefreshFrame = null;
                    refreshSelectionNumbers();
                });
            }

            function closePanel() {
                numberingEnabled = false;
                numberedCells = null;
                removeSelectionNumbers();
                var el = document.getElementById(PANEL_ID);
                if (el && el.parentNode) el.parentNode.removeChild(el);
            }

            /**
             * 当前图的**明文** XML。原型只吃明文（压缩载荷会被显式拒绝），
             * 所以最后一位 uncompressed 显式传 true —— 默认值受 Editor.defaultCompressed 影响，不能靠默认。
             */
            function xmlOf() {
                try { return ui.getFileData(null, null, null, null, null, null, null, null, null, true); }
                catch (e) { return null; }
            }

            /** 元素在屏幕上的位置：用**渲染出来的节点**量，绝不用 view.translate/scale 手算。 */
            function screenRectOf(cell) {
                try {
                    var st = graph.view.getState(cell);
                    var node = st && st.shape && st.shape.node;
                    if (node && node.getBoundingClientRect) return node.getBoundingClientRect();
                } catch (e) {}
                return null;
            }

            /** 悬浮框落点：优先右键的落点，取不到就贴着选区。 */
            function anchorPoint(evt, cells) {
                try {
                    if (evt && typeof evt.getClientX === "function") {
                        var ex = evt.getClientX(), ey = evt.getClientY();
                        if (typeof ex === "number" && typeof ey === "number") return { x: ex, y: ey };
                    }
                } catch (e) {}
                var box = null;
                for (var i = 0; i < cells.length; i++) {
                    var r = screenRectOf(cells[i]);
                    if (!r) continue;
                    box = box
                        ? { l: Math.min(box.l, r.left), t: Math.min(box.t, r.top), r: Math.max(box.r, r.right), b: Math.max(box.b, r.bottom) }
                        : { l: r.left, t: r.top, r: r.right, b: r.bottom };
                }
                return box ? { x: box.l, y: box.b + 8 } : { x: 100, y: 140 };
            }

            /**
             * 把服务端算好的 writes 落进当前模型。
             * 只认 attrs（几何 + 样式）；结构性写入（增删元素）这一步明确不做，报出来而不是悄悄跳过。
             */
            function applyWrites(writes) {
                var model = graph.getModel();
                var applied = [], refused = [];
                var added = 0, deleted = 0, removedEdges = 0;
                var pendingVerify = [];
                model.beginUpdate();
                try {
                    for (var i = 0; i < writes.length; i++) {
                        var w = writes[i] || {};
                        var cell = model.getCell(w.cellId);
                        // ---- 结构性写入（③ 增删元素）----
                        // 用的全是 mxGraph 官方编辑 API，所以行为和"用户自己画/自己删"完全一致：
                        // 会进撤销栈、会触发 autosave（宿主状态同步）、删元素会连带它的连线。
                        // 语义已按 spike 实测过（spikes/s1/results/spike-structural-writeback.log）：
                        //   · removeCells 删一个元素会**连带删掉它的连线**，其余元素不动；
                        //   · insertVertex / mxCodec.decodeCell 都能建元素，后者能**保住服务端指定的 id**（审计要对得上）。
                        if (w.structural) {
                            var st = w.structural || {};
                            if (st.kind === "delete") {
                                var target = model.getCell(w.cellId);
                                if (!target) { refused.push(w.cellId + " 不在画布上"); continue; }
                                var incident = [];
                                try { incident = graph.getEdges(target) || []; } catch (e) {}
                                graph.removeCells([target]);
                                removedEdges += incident.length;
                                deleted++;
                                applied.push(w.cellId);
                                continue;
                            }
                            if (st.kind === "add") {
                                if (typeof st.xml !== "string" || !st.xml) { refused.push(w.cellId + " 缺少要新增的 XML"); continue; }
                                if (model.getCell(w.cellId)) { refused.push(w.cellId + " 已存在，拒绝新增（id 必须唯一）"); continue; }
                                var parent = model.getCell(st.parentId || "1") || model.getCell("1");
                                if (!parent) { refused.push(w.cellId + " 的父容器不在画布上"); continue; }
                                var made = null;
                                if (st.x !== undefined && st.y !== undefined && st.width !== undefined && st.height !== undefined) {
                                    // 首选：服务端给了部件（value/style/几何/id），直接用官方 API 建元素 ——
                                    // 与"用户自己画一个框"走的是同一条路（进撤销栈、触发 autosave、行为一致）。
                                    made = graph.insertVertex(parent, st.id || w.cellId, st.value == null ? "" : st.value,
                                        Number(st.x), Number(st.y), Number(st.width), Number(st.height), st.style == null ? "" : st.style);
                                } else if (st.xml) {
                                    // 兜底：只有 XML（生成式通道的 add 就是这种）→ 解码。
                                    // 这一小段有三个坑，全是实测出来的（spikes/s1/results/probe-add-api.log、probe-add-edge.log）：
                                    //  ① `mxCodec.decodeCell(node)` 的第二个参数**默认是 true**，它会顺手
                                    //     `insertIntoGraph()` —— 把 cell **裸插进父容器的 children**（`parent.insert`），
                                    //     绕过 mxGraphModel 的注册。结果：元素在树里、会被序列化进 XML，
                                    //     但 `model.getCell(id)` 找不到、画布不渲染 —— "报告新增成功，用户却看不见"。
                                    //     所以必须显式传 false，插入由我们用官方 API 自己来。
                                    //  ② 单解一个 cell 片段时，parent/source/target 全靠 codec 的对象表解析；
                                    //     不把画布上的 cell 注册进去，它找不到端点就 console.error 并把端点设成 null
                                    //     → 新边变成**浮动线**。所以把画布上所有 cell 都注册进去。
                                    //  ③ 即便传了 false，codec 仍会把 `parent` 指到活着的图层上；
                                    //     mxGraphModel.parentForCellChanged 见"它已经在模型里"就会**跳过 cellAdded**
                                    //     （同样不注册）。所以挂之前先把 parent 摘掉。
                                    // 先做一次便宜的预检：XML 声明的端点在不在画布上？
                                    // 不在就**别去解码** —— decodeCell 解析不到端点会打一条 console.error，
                                    // 而且解出来是 null 端点（浮动线）。服务端现在也会拒，这里是"不谎报成功"的兜底。
                                    var declaredTerminals = (String(st.xml).match(/(?:source|target)="([^"]*)"/g) || [])
                                        .map(function (kv) { return kv.replace(/^[a-z]+="/, "").replace(/"$/, ""); })
                                        .filter(function (v) { return v && !model.getCell(v); });
                                    if (declaredTerminals.length) {
                                        refused.push(w.cellId + " 的 xml 引用了画布上不存在的端点 " + declaredTerminals.join("、") + "，已跳过");
                                        continue;
                                    }
                                    var declaresTerminals = /source="[^"]*"|target="[^"]*"/.test(st.xml);
                                    try {
                                        var doc = mxUtils.parseXml(st.xml);
                                        var codec = new mxCodec(doc);
                                        try {
                                            if (typeof codec.putObject === "function") {
                                                var allIds = Object.keys(model.cells);
                                                for (var ci = 0; ci < allIds.length; ci++) codec.putObject(allIds[ci], model.cells[allIds[ci]]);
                                            }
                                        } catch (e2) {}
                                        made = codec.decodeCell(doc.documentElement, false);
                                        if (made) {
                                            // XML 里声明了端点却没绑上 = 服务端漏了校验（正常应在服务端就被拒）。
                                            // 插件不假装成功 —— 宁可不加，也不给用户一条没连上的线。
                                            if (declaresTerminals && model.isEdge(made) && (!made.getTerminal(true) || !made.getTerminal(false))) {
                                                refused.push(w.cellId + " 的端点绑不上（服务端应当先拒绝这种 add），已跳过");
                                                made = null;
                                                continue;
                                            }
                                            made.setParent(null);
                                            graph.addCell(made, parent, model.getChildCount(parent));
                                            // "不许谎报成功"：等整个写回结束（view 的校验发生在 endUpdate 之后）
                                            // 再验它真的被模型接纳、并真的渲染出来。踩过的坑见上面 ①：
                                            // 曾经元素只进了父容器 children、没进 model.cells ——
                                            // XML 里有、报告"新增成功"，画布上却什么都没有。
                                            pendingVerify.push({ id: made.getId() || w.cellId, cell: made });
                                        }
                                    } catch (e) { made = null; }
                                }
                                if (!made) { refused.push(w.cellId + " 建不出来（既没部件也解不开 XML）"); continue; }
                                added++;
                                applied.push(made.getId() || w.cellId);
                                continue;
                            }
                            refused.push(w.cellId + " 不认识的改写类型 " + String(st.kind) + "（服务端版本不匹配？update 应当在服务端就转成属性写入）");
                            continue;
                        }
                        if (!cell) { refused.push(w.cellId + " 不在画布上"); continue; }
                        var attrs = w.attrs || {};
                        var touched = false;
                        if (attrs.style != null) { graph.setCellStyle(String(attrs.style), [cell]); touched = true; }
                        if (attrs.value != null) { model.setValue(cell, String(attrs.value)); touched = true; }
                        var patch = null, k, name;
                        for (k = 0; k < GEO_KEYS.length; k++) {
                            name = GEO_KEYS[k];
                            if (attrs[name] != null) { patch = patch || {}; patch[name] = Number(attrs[name]); }
                        }
                        if (patch) {
                            var g = cell.getGeometry();
                            if (!g) { refused.push(w.cellId + " 没有几何信息"); }
                            else {
                                var ng = g.clone();
                                for (k = 0; k < GEO_KEYS.length; k++) {
                                    name = GEO_KEYS[k];
                                    if (patch[name] != null) ng[name] = patch[name];
                                }
                                model.setGeometry(cell, ng);
                                touched = true;
                            }
                        }
                        if (touched) applied.push(w.cellId);
                    }
                } finally {
                    model.endUpdate();
                }
                // 写完之后再验"新增的真的落地了"：模型接纳（getCell 指回同一个对象）+ 画布渲染出状态。
                // 放在 endUpdate 之后是因为 mxGraphView 的校验在那之后才跑。
                for (var vi = 0; vi < pendingVerify.length; vi++) {
                    var pv = pendingVerify[vi];
                    var registered = false, rendered = false;
                    try {
                        registered = model.getCell(pv.id) === pv.cell;
                        rendered = !!graph.view.getState(pv.cell);
                    } catch (e4) {}
                    if (registered && rendered) continue;
                    try { graph.removeCells([pv.cell]); } catch (e5) {}
                    added -= 1;
                    applied = applied.filter(function (x) { return x !== pv.id; });
                    refused.push(pv.id + " 加进去了但没落地（" + (registered ? "画布未渲染" : "模型未接纳") + "），已回滚");
                }
                return { applied: applied, refused: refused, added: added, deleted: deleted, removedEdges: removedEdges };
            }

            /** 手动刷新一次服务端 JSON（给调试与测试用，不参与正常流程）。 */
            function directCallInstruct(xml, roots, instruction, aliases) {
                return fetch(SCOPE_ENDPOINT + "/api/scoped-edit", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ xml: xml, selectedIds: roots, aliases: aliases, instruction: instruction }),
                }).then(function (r) {
                    return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
                });
            }

            function callInstruct(xml, roots, instruction, aliases) {
                if (!window.parent || window.parent === window) return directCallInstruct(xml, roots, instruction, aliases);
                return new Promise(function (resolve, reject) {
                    var requestId = "ai-scope-" + Date.now() + "-" + Math.random().toString(36).slice(2);
                    var settled = false;
                    var timer = null;
                    function finish(fn, value) {
                        if (settled) return;
                        settled = true;
                        if (timer) clearTimeout(timer);
                        window.removeEventListener("message", onMessage);
                        fn(value);
                    }
                    function onMessage(evt) {
                        var data = evt && evt.data;
                        if (!data || data.type !== "aiScopeProxyResponse" || data.requestId !== requestId) return;
                        finish(resolve, { ok: !!data.ok, status: Number(data.status || 502), body: data.body || {} });
                    }
                    window.addEventListener("message", onMessage);
                    try {
                        window.parent.postMessage({
                            type: "aiScopeProxyRequest", requestId: requestId,
                            xml: xml, selectedIds: roots, aliases: aliases, instruction: instruction,
                        }, "*");
                    } catch (e) {
                        finish(reject, e);
                        return;
                    }
                    timer = setTimeout(function () {
                        if (settled) return;
                        directCallInstruct(xml, roots, instruction, aliases).then(function (value) {
                            finish(resolve, value);
                        }).catch(function (error) {
                            finish(reject, error);
                        });
                    }, 5000);
                });
            }

            function openInstruct(evt) {
                var cells = selected();
                if (cells.length === 0) {
                    post({ event: "aiScopeNotice", ok: false, text: "先选中要修改的元素，再右键打开" });
                    return;
                }
                var at = anchorPoint(evt, cells);
                closePanel();

                var panel = document.createElement("div");
                panel.id = PANEL_ID;
                panel.setAttribute("data-role", "ai-scope-instruct");
                panel.setAttribute("role", "dialog");
                panel.setAttribute("aria-label", "AI 局部修改");
                panel.style.cssText = "position:fixed;z-index:100000;width:368px;box-sizing:border-box;background:rgba(255,255,255,.98);color:#1f2328;border:1px solid #e1e5ea;border-radius:14px;box-shadow:0 16px 40px rgba(31,35,40,.16),0 2px 8px rgba(31,35,40,.08);font:13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;padding:9px;backdrop-filter:blur(12px)";
                panel.style.left = Math.max(8, Math.min(at.x, (window.innerWidth || 1200) - 384)) + "px";
                panel.style.top = Math.max(8, Math.min(at.y, (window.innerHeight || 800) - 220)) + "px";

                var title = document.createElement("div");
                title.style.cssText = "display:flex;justify-content:space-between;align-items:center;height:28px;padding:0 2px 5px 3px";
                var titleLeft = document.createElement("div");
                titleLeft.style.cssText = "display:flex;align-items:center;gap:7px;min-width:0";
                var mark = document.createElement("span");
                mark.textContent = "✦";
                mark.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;background:#eef6ff;color:#1677ff;font-size:14px;font-weight:700";
                var label = document.createElement("strong");
                label.textContent = "AI 局部修改";
                label.style.cssText = "font-size:13px;font-weight:650;letter-spacing:.1px";
                var count = document.createElement("span");
                count.textContent = cells.length + " 个已选";
                count.style.cssText = "color:#6e7781;font-size:12px;white-space:nowrap";
                titleLeft.appendChild(mark);
                titleLeft.appendChild(label);
                titleLeft.appendChild(count);
                var closeBtn = document.createElement("button");
                closeBtn.type = "button";
                closeBtn.textContent = "×";
                closeBtn.setAttribute("data-role", "ai-scope-close");
                closeBtn.setAttribute("aria-label", "关闭局部修改");
                closeBtn.style.cssText = "width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:#8c959f;font-size:19px;line-height:22px;cursor:pointer;padding:0";
                closeBtn.onmouseenter = function () { closeBtn.style.background = "#f1f3f5"; closeBtn.style.color = "#1f2328"; };
                closeBtn.onmouseleave = function () { closeBtn.style.background = "transparent"; closeBtn.style.color = "#8c959f"; };
                closeBtn.onclick = closePanel;
                var titleActions = document.createElement("div");
                titleActions.style.cssText = "display:flex;align-items:center;gap:3px";
                var numberBtn = document.createElement("button");
                numberBtn.type = "button";
                numberBtn.textContent = "显示编号";
                numberBtn.setAttribute("data-role", "ai-scope-number-toggle");
                numberBtn.setAttribute("aria-pressed", "false");
                numberBtn.style.cssText = "height:26px;border:0;border-radius:7px;background:transparent;color:#6e7781;font:12px/20px system-ui,-apple-system,'Segoe UI',sans-serif;cursor:pointer;padding:0 7px";
                numberBtn.onmouseenter = function () { if (!numberingEnabled) numberBtn.style.background = "#f1f3f5"; };
                numberBtn.onmouseleave = function () { if (!numberingEnabled) numberBtn.style.background = "transparent"; };
                numberBtn.onclick = function () {
                    numberingEnabled = !numberingEnabled;
                    numberedCells = numberingEnabled ? cells : null;
                    numberBtn.setAttribute("aria-pressed", numberingEnabled ? "true" : "false");
                    numberBtn.textContent = numberingEnabled ? "隐藏编号" : "显示编号";
                    numberBtn.style.background = numberingEnabled ? "#eaf3ff" : "transparent";
                    numberBtn.style.color = numberingEnabled ? "#1677ff" : "#6e7781";
                    renderSelectionNumbers(cells);
                };
                titleActions.appendChild(numberBtn);
                titleActions.appendChild(closeBtn);
                title.appendChild(titleLeft);
                title.appendChild(titleActions);

                var inputBox = document.createElement("div");
                inputBox.style.cssText = "display:flex;align-items:flex-end;gap:7px;border:1px solid #cbd5e1;border-radius:10px;background:#ffffff;padding:6px 6px 6px 10px;transition:border-color .15s,box-shadow .15s";
                var input = document.createElement("textarea");
                input.setAttribute("data-role", "ai-scope-input");
                input.setAttribute("aria-label", "描述要修改的内容");
                input.rows = 2;
                input.placeholder = "描述你想怎么改…";
                input.style.cssText = "flex:1;min-width:0;min-height:44px;max-height:88px;box-sizing:border-box;resize:none;overflow:auto;border:0;outline:0;background:transparent;color:#1f2328;font:14px/22px system-ui,-apple-system,'Segoe UI',sans-serif;padding:0";
                input.onfocus = function () { inputBox.style.borderColor = "#1677ff"; inputBox.style.boxShadow = "0 0 0 3px rgba(22,119,255,.12)"; };
                input.onblur = function () { inputBox.style.borderColor = "#cbd5e1"; inputBox.style.boxShadow = "none"; };
                function resizeInput() {
                    input.style.height = "auto";
                    input.style.height = Math.min(Math.max(input.scrollHeight, 44), 88) + "px";
                }
                input.addEventListener("input", resizeInput);

                var runBtn = document.createElement("button");
                runBtn.type = "button";
                runBtn.textContent = "执行";
                runBtn.setAttribute("data-role", "ai-scope-run");
                runBtn.setAttribute("aria-label", "执行局部修改");
                runBtn.style.cssText = "flex:none;border:0;background:#1677ff;color:#ffffff;border-radius:8px;padding:6px 10px;cursor:pointer;font:12px/18px system-ui,-apple-system,'Segoe UI',sans-serif;font-weight:600;box-shadow:0 1px 2px rgba(22,119,255,.24)";
                runBtn.onmouseenter = function () { if (!runBtn.disabled) runBtn.style.background = "#0958d9"; };
                runBtn.onmouseleave = function () { runBtn.style.background = "#1677ff"; };
                inputBox.appendChild(input);
                inputBox.appendChild(runBtn);

                var result = document.createElement("div");
                result.setAttribute("data-role", "ai-scope-result");
                result.style.cssText = "display:none;margin-top:7px;padding:7px 9px;border-radius:8px;background:#f6f8fa;color:#57606a;font-size:12px;line-height:18px;white-space:pre-wrap";
                var progress = document.createElement("div");
                progress.setAttribute("data-role", "ai-scope-progress");
                progress.style.cssText = "display:none;align-items:center;gap:8px;margin-top:7px;padding:7px 9px;border-radius:8px;background:#eef6ff;color:#175cd3;font-size:12px;line-height:18px;white-space:pre-wrap";
                var progressSpinner = document.createElement("span");
                progressSpinner.style.cssText = "display:inline-block;width:12px;height:12px;box-sizing:border-box;border:2px solid #b7d5ff;border-top-color:#1677ff;border-radius:50%;animation:ai-scope-spin .8s linear infinite;flex:none";
                var progressText = document.createElement("span");
                progress.appendChild(progressSpinner);
                progress.appendChild(progressText);
                if (!document.getElementById("ai-scope-progress-style")) {
                    var progressStyle = document.createElement("style");
                    progressStyle.id = "ai-scope-progress-style";
                    progressStyle.textContent = "@keyframes ai-scope-spin{to{transform:rotate(360deg)}}";
                    (document.head || document.documentElement).appendChild(progressStyle);
                }

                panel.appendChild(title);
                panel.appendChild(inputBox);
                panel.appendChild(progress);
                panel.appendChild(result);
                (document.body || document.documentElement).appendChild(panel);
                resizeInput();
                try { input.focus(); } catch (e) {}

                function busy(on) {
                    runBtn.disabled = !!on;
                    runBtn.style.opacity = on ? "0.6" : "1";
                    runBtn.style.cursor = on ? "wait" : "pointer";
                }
                function say(text) {
                    progress.style.display = "none";
                    result.textContent = text;
                    result.style.display = text ? "block" : "none";
                }
                function showProgress(text) {
                    result.style.display = "none";
                    progressText.textContent = text;
                    progress.style.display = "flex";
                }
                function run() {
                    var instruction = String(input.value || "").trim();
                    if (!instruction) { say("先说一句要改什么。"); return; }
                    var xml = xmlOf();
                    if (!xml) { say("拿不到当前图形 XML，无法执行。"); return; }
                    var roots = cells.map(function (c) { return c.getId(); });
                    var aliases = selectionAliases(cells);
                    var progressTimers = [];
                    function clearProgressTimers() {
                        for (var i = 0; i < progressTimers.length; i++) clearTimeout(progressTimers[i]);
                        progressTimers = [];
                    }
                    busy(true);
                    showProgress("正在读取选区并检查指令…");
                    progressTimers.push(setTimeout(function () { showProgress("正在判断是否可用快速规则…"); }, 350));
                    progressTimers.push(setTimeout(function () { showProgress("正在请求 AI 分析选区…"); }, 1200));
                    progressTimers.push(setTimeout(function () { showProgress("AI 正在生成修改方案，请稍候…"); }, 4500));
                    progressTimers.push(setTimeout(function () { showProgress("处理时间较长，正在等待模型返回…"); }, 10000));
                    callInstruct(xml, roots, instruction, aliases).then(function (res) {
                        clearProgressTimers();
                        var b = res.body || {};
                        if (!res.ok) { say("服务端报错（HTTP " + res.status + "）：" + (b.error || "未知")); return; }
                        if (b.channel === "none") { say(b.summary || b.hint || "这句话没命中规则，且生成式通道未配置。"); return; }
                        var writes = b.writes || [];
                        if (!b.ready || writes.length === 0) {
                            // 没改动时要分清三件事（用户看到"没有任何改动 · 邻域…"会以为出错了）：
                            //   ① 为什么没改动（结论）；② 是不是被拦下/跳过了（原因）；
                            //   ③ 作用域提示（邻域被裁剪之类）—— 它的存在是设计如此，**不是**失败原因。
                            var scopeNotes = (b.scope && b.scope.warnings) || [];
                            // 结论与原因重复时不再重复念一遍（服务端在"空 ops"时给的 summary 就是那条原因）
                            var reasons = (b.warnings || []).filter(function (x) { return scopeNotes.indexOf(x) === -1 && x !== b.summary; });
                            var lines = [b.summary || "没有产生可落地的改动"];
                            if (b.channel === "generative") {
                                if (!reasons.length && b.ready === false && (b.operations || []).length > 0) {
                                    lines.push("模型产出 " + b.operations.length + " 个 op，但换算下来与现状一致（例如本来就是那个值），所以没有可写回的差异。");
                                } else {
                                    lines.push("模型产出 " + ((b.operations || []).length) + " 个 op，落地 " + writes.length + " 处写入。");
                                }
                            }
                            if (reasons.length) lines.push("原因：" + reasons.join("；"));
                            if (scopeNotes.length) lines.push("作用域提示（不影响本次改动）：" + scopeNotes.join("；"));
                            say(lines.join("\n"));
                            return;
                        }
                        showProgress("正在校验修改范围并写回画布…");
                        var r = applyWrites(writes);
                        var extra = [];
                        if (r.added) extra.push("新增 " + r.added + " 个");
                        if (r.deleted) extra.push("删除 " + r.deleted + " 个");
                        if (r.removedEdges) extra.push("连带删掉 " + r.removedEdges + " 条连线");
                        var head = b.channel === "rule"
                            ? "走确定性规则：" + ((b.plan && b.plan.why) || "") + "（没有调用模型）"
                            : "规则没命中 → 走大模型（" + (b.model || "") + "）：产出 " + ((b.ops || []).length) + " 个 op";
                        say(head + " → 已应用" + (extra.length ? "：" + extra.join("；") : "") + (r.refused.length ? "\n· 跳过：" + r.refused.join("；") : ""));
                        post({
                            event: "aiScopeWrite", action: "aiScopeInstructApply", ok: true,
                            instruction: instruction, channel: b.channel, model: b.model || null,
                            ids: roots, applied: r.applied, refused: r.refused,
                            added: r.added || 0, deleted: r.deleted || 0, removedEdges: r.removedEdges || 0,
                            undoDepthAfter: undoDepth(), lastEditChanges: lastEditChanges(),
                            selectionAfter: selected().map(function (c) { return c.getId(); }),
                        });
                        snap("instructApplied");
                    }).catch(function (err) {
                        clearProgressTimers();
                        say("调不通局部编辑服务（" + SCOPE_ENDPOINT + "）：" + (err && err.message ? err.message : err));
                    }).then(function () { busy(false); });
                }

                runBtn.onclick = run;
                input.addEventListener("keydown", function (e) {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
                    else if (e.key === "Escape") { e.preventDefault(); closePanel(); }
                });
                post({ event: "aiScopePanel", open: true, selected: cells.map(function (c) { return c.getId(); }) });
            }

            // 动作：宿主/测试可以用 {action:'invokeAction', actionName:'aiScopeInstruct'} 直接开框
            ui.actions.addAction("aiScopeInstruct", function () { openInstruct(null); });
            ui.actions.addAction("aiScopeClosePanel", function () { closePanel(); });
            post({
                event: "aiScopeReady",
                version: version(),
                hasMenus: !!ui.menus,
                hasAddAction: typeof ui.actions.addAction === "function",
                allowCustomPlugins: !!window.ALLOW_CUSTOM_PLUGINS,
                debug: DEBUG,
            });
        });
    }

    // 注入时机早于 Draw.loadPlugin 定义 → 轮询等待，而不是脚本解析时就要求 Draw 存在
    var waited = 0;
    (function waitPlugin() {
        if (typeof Draw !== "undefined" && Draw.loadPlugin) { return boot(); }
        if (waited >= 30000) {
            post({ event: "aiScopeError", where: "boot", error: "等待 Draw.loadPlugin 超时(30s)" });
            return;
        }
        waited += 100;
        setTimeout(waitPlugin, 100);
    })();
})();
