# 部署整理与验证报告

日期：2026-09-28。上游基线：027cd88c9088ad5b2d6deff4641dc47ded06afd2。
本报告记录当前定制版本；早期报告见工作区 docs/history/。

## 部署假设与证据

| 假设 | 证据 | 置信度 | 证伪时处理 |
| --- | --- | --- | --- |
| 只需应用和 draw.io 两个服务 | upstream/docker-compose.yml:1 | 高 | 检查服务列表，拒绝未知服务 |
| 宿主端口为 3000 / 8080 | upstream/docker-compose.yml:4 | 高 | 检测冲突并退出 |
| 应用配置端点可用于就绪检测 | upstream/app/api/config/route.ts:3 | 高 | 检查状态码和两个容器状态 |
| 局部编辑由应用提供 | upstream/app/api/scoped-edit/route.ts:24 | 高 | 镜像路由与真实接口冒烟 |
| 服务端模型由环境或前端覆盖决定 | upstream/lib/ai-providers.ts:740 | 高 | 核对 key、提供方和模型 ID |
| 插件必须随 compose 挂载 | tools/gen_drawio_custom.py:87 | 高 | 比对在线文件哈希，重启重建检查 |
| 定制代码需要随包交付 | upstream/components/chat-panel.tsx:184 | 高 | 包含完整源码与哈希清单 |

## 本次实测

环境：Ubuntu 24.04，Docker 29.1.3，Compose 2.40.3，Linux amd64。

| 检查 | 实际结果 |
| --- | --- |
| Bash、Python、插件语法检查 | 通过 |
| doctor | 只读体检通过；不再依赖宿主 PyYAML |
| deploy | 应用生产构建通过，包含 TypeScript 检查和 /api/scoped-edit 路由 |
| 两个服务就绪 | 容器运行，/api/config 与 PreConfig.js 均返回 200 |
| 在线插件与生成物 | 两个文件的 SHA-256 与本地一致，官方 animation.js 可访问 |
| 局部编辑快速规则 | 变绿仅返回 a 的写回，不涉及未选中 b；无效选区返回 422 |
| 聊天模型调用 | /api/chat 实际返回 display_diagram 工具调用及 XML |
| 局部编辑模型调用 | generative 通道只对 a 返回 deployment-ok 文字写回 |
| verify | 重复 up 容器 ID 不变；停止后两个端口释放，无本项目容器残留；重新启动成功 |
| plugin-check | draw.io 重启、强制重建后在线文件哈希一致 |
| 局部编辑单元测试 | 3 个测试文件、9 个测试全部通过 |
| 部署包解压验证 | 331 个交付文件逐项哈希一致，不含运行凭据、数据、依赖、实验目录 |
| 无 Git 部署目录 | help、init、doctor、再次 package 可运行；从 /tmp 调用不依赖当前目录 |
| 配置与删除边界 | init 权限 600，重复 init 不覆盖；doctor 缺配置不创建文件；空 key 被拒绝；非交互 purge 被拒绝 |

镜像准备复用了已有 draw.io digest 和 npm 依赖缓存；应用源码重新完成生产构建。
第一次运行发现 Compose JSON 未提供隐式应用 image 字段，已改用 config --images 解析并完整重跑通过。
运行记录保存于本机 logs/deploy-validation.log、logs/verify.log、logs/plugin-check.log，
不进入部署包。模型原始响应和凭据不写入这些验证记录。
本机 data/ 已有目录为 UID 1000，脚本未更改；容器 UID 1001 的后台设置写权限尚未验证。

## 一键入口补充验证

新增 setup.sh，提供环境检查、首次交互配置、部署、可选系统依赖安装及模型冒烟。

- 本机 `./setup.sh --check` 通过，保留已有配置。
- 本机 `./setup.sh --install-deps --with-ai` 通过：依赖齐全，跳过 apt；
  完成镜像构建、启动、在线插件检查、规则 guard、聊天及局部编辑模型调用。
- 8 项 setup 回归测试通过，覆盖已有配置保留、只读检查、非交互缺配置退出、失败后停止、
  600 配置权限、空密钥拒绝、版本门槛、Docker 权限与端口冲突。
- 系统依赖安装命令使用隔离的假 apt/sudo/systemctl 验证参数和失败传播；
  未在空白 Ubuntu 24.04 系统实际安装 Docker，不将其计为实机安装通过。
- 安装分支只支持 Ubuntu 24.04，复用管理员配置的 APT 源；国内 npm 镜像不变。

## 与官方流程的偏离

| 偏离 | 原因 | 影响 |
| --- | --- | --- |
| 新增 scoped-edit API、共享模型模块和主窗口代理 | 局部编辑复用主应用能力 | 不可用官方原版源码替代当前 upstream/ |
| 挂载 PreConfig 与 ai-scope 插件 | 选区、浮框、编号和写回 | 官方入口的部分运行期改写被跳过 |
| 固定 draw.io digest | 避免 latest 悄然改变编辑器 API | 升级需重新探测并验证 |
| npm 国内镜像源 | 本地构建下载 | 默认 registry.npmmirror.com，可配置 |
| webpack 生产构建 | 沿用本机已验证构建路径 | 与上游默认 next build 不同 |
| 跳过 Electron/Playwright 二进制下载 | Web 容器不需要桌面程序和测试浏览器 | 镜像不提供桌面/e2e 工具 |
| 源码随部署包分发 | 保留未提交的定制功能 | 不包含 .git 历史，以 manifest 记录文件哈希 |

## 未覆盖与风险

未在另一台全新机器验证；已有本机镜像和构建缓存不能证明所有镜像源在新机器可达。
当前实例未开启访问码；检查脚本支持从 Compose 有效配置取码，但本次未切换实例配置验证该分支。
完整浏览器交互、撤销、多用户、HTTPS 反代、跨机地址不属于此次部署验证。
Node 基础镜像和 npm install 仍沿用上游方式，未实现完全可复现构建。
模型输出具有不确定性；规则/编号/代理边界见 docs/ARCHITECTURE.md。
