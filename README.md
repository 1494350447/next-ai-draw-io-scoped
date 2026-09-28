# Next AI Draw.io · AI 局部修改版

基于 [DayuanJiang/next-ai-draw-io](https://github.com/DayuanJiang/next-ai-draw-io) 的定制版本。
上游基线：`027cd88c9088ad5b2d6deff4641dc47ded06afd2`。保留上游 Apache-2.0 许可证。

选中画布元素 → 右键「AI 局部修改…」→ 输入指令 → 在选区内写回。
常见指令先走确定性规则，未命中时复用主应用模型；无需启动历史 8787 服务。

## 开始使用

需要 Linux、Docker、Compose >= 2.24.4、Python >= 3.9、curl 和 ss。
下载本仓库完整源码或克隆后，在仓库根目录运行以下命令；无需另行克隆上游。

```bash
./deploy.sh init
# 编辑 .env，填写 DEEPSEEK_API_KEY，确认 AI_MODEL 是服务商支持的模型 ID
./deploy.sh
```

默认命令完成构建、启动、就绪检查、插件校验和局部编辑规则冒烟。
应用：<http://127.0.0.1:3000/>；画布：<http://127.0.0.1:8080/>。
实际模型调用另用 `./deploy.sh smoke` 验证，会消耗模型额度。

## 项目内容

| 路径 | 用途 |
| --- | --- |
| `upstream/` | 上游源码及已接入的局部编辑 API、模型复用、主窗口代理、单元测试 |
| `drawio-custom/plugins/ai-scope.js` | 选区、右键菜单、指令浮框、可选编号、画布写回 |
| `drawio-custom/PreConfig.js` | 自动生成的插件入口、CSP 和缓存指纹 |
| `deploy.sh`、`docker-compose.yml`、`tools/` | 部署、验证、资产生成、打包 |
| `docs/USAGE.md` | 操作说明 |
| `docs/ARCHITECTURE.md` | 当前架构、维护入口和已知边界 |
| `DEPLOY.md`、`deploy-report.md` | 部署说明和本次实测结果 |
| `prototype/`、`spikes/`、`docs/history/` | 历史原型、实验脚本及报告；随仓库保存，不参与运行，不进入部署包 |
| `.env`、`data/`、`logs/` | 本机凭据、后台设置、构建日志，不进入部署包 |

## 交付与更新

`./deploy.sh package` 在 `releases/` 生成部署包和 SHA-256 校验文件。
包中包含当前定制源码、插件和部署工具，无需重新克隆 GitHub。
`release-manifest.json` 记录上游基线和每个交付文件的哈希。

本仓库将 `upstream/` 作为完整源码目录保存，并非 Git 子模块。
临时实验输出、日志、截图、密钥、数据、依赖及构建缓存不入库；历史报告中的本机结果路径仅供回溯。

**这是包含源码改动的定制版。** 只下载上游原版、只复制插件、或直接覆盖 `upstream/`，都会丢失主应用侧功能。
修改应用源码后运行 `./deploy.sh deploy`；仅修改插件后运行 `./deploy.sh up`，再刷新浏览器。
详细步骤见 [DEPLOY.md](DEPLOY.md)。
