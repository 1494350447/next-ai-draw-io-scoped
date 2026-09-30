# 当前架构与维护入口

生产运行只需两个容器。历史 prototype/ 和 spikes/ 用于研究，不是服务依赖。

```text
draw.io 插件：读取选区、显示浮框和编号
  → postMessage：xml + selectedIds + aliases + instruction
主应用 chat-panel：复用当前模型设置、访问码，代理请求
  → POST /api/scoped-edit
服务端：确定性规则 → 未命中则调用模型 edit_diagram
  → 作用域校验 → writes
插件：调用 mxGraph API 写回，更新主应用
```

浏览器的画布入口为 `<origin><basePath>/drawio/index.html`，Next.js 将资源转发到内部 `drawio:8080`。
嵌入模式只通过主应用发送局部编辑请求，主应用超时 140 秒，插件等待上限 150 秒；超时不会自动重复提交。
AI_SCOPE_ENDPOINT 直连仅用于没有父窗口的独立画布；该模式不会自动取得主页面的访问码和模型设置。
模型层复用主应用提供方配置与 edit_diagram 的 update/add/delete 协议。
更新只允许选区内元素，新增校验父容器和端点，删除遵循图模型的关联语义。
全图聊天仍走 /api/chat。

## 代码入口

| 文件 | 责任 |
| --- | --- |
| drawio-custom/plugins/ai-scope.js | 选区、右键入口、面板、编号、消息通信、画布写回 |
| upstream/components/chat-panel.tsx | 主应用窗口代理和模型设置转发 |
| upstream/app/api/scoped-edit/route.ts | 访问码、请求校验、规则/模型分流 |
| upstream/lib/scoped-rules.ts | 确定性指令及属性写回 |
| upstream/lib/scoped-edit.ts | XML 上下文裁剪、作用域 guard、写回规划 |
| upstream/lib/model-request.ts | 模型请求配置解析 |
| upstream/lib/edit-diagram-tool.ts | 共用模型编辑工具定义 |
| upstream/app/api/chat/route.ts | 全图聊天，复用上述公共模块 |
| upstream/tests/unit/scoped-*.test.ts | 局部编辑回归测试 |

这是对上游源码的定制扩展，不是一个仅复制 JS 即可用于任意上游版本的通用插件。
部署工具不会重置、拉取覆盖或提交当前源码。升级上游须自行合并这些改动并重新测试。

## 验证方式

部署验证使用真实容器、在线文件哈希、规则接口及可选模型调用。
源码回归（需要在 upstream/ 安装开发依赖）：

```bash
cd upstream
npx tsc --noEmit
npx vitest run tests/unit/scoped-edit.test.ts tests/unit/scoped-rules.test.ts tests/unit/scoped-edit-route.test.ts
```

插件语法可以用 `node --check drawio-custom/plugins/ai-scope.js` 检查。
部署检查不替代浏览器中拖拽、缩放、编号与主窗口交互验收。

## 已知边界与后续方向

- 编号随空间排序变化，尚未锁定为整个编辑会话的稳定身份。
- 快速规则以关键词匹配，部分含编号的复杂指令可能先匹配全选区规则；别名精确指向需专项完善。
- 等待阶段是前端定时提示，尚无服务端阶段事件。
- 请求期间修改选区或图形，尚无完整版本冲突和取消机制。
- 空白处清空选区会关闭面板，但仅关闭面板不等同于取消已经发出的请求。
- 源码历史记录显示主应用 XML 同步可能影响原生撤销；本次未重新验证完整撤销场景。
- 服务器部署支持单入口和构建期子路径，配置及验收见 SERVER_DEPLOYMENT.md。多实例须独立目录；不提供共享数据的多副本方案。

这些属于后续功能工程，本次整理不改变交互语义。旧架构设计和 spike 结论保留在工作区，
其中 /api/instruct、8787、独立复原面板等描述属于历史阶段。
