# docs/ 文档库索引

> 本库是 Floria 仓库（源码构建区 + 权威标准）的权威文档库，按读者主题分层。`docs/` 随本仓库属 git 跟踪内容。
> 各件头部自带互链；本件只做地图与阅读顺序，不放正文。

## 文档地图

| 文件 | 主题 | 一句话 |
|---|---|---|
| [standards.md](standards.md) | 权威规则 | skill/plugin/MCP/changelog/工作区/审批等全部约定，与 CLAUDE.md 冲突时以此为准 |
| [build.md](build.md) | 构建与 flag | 构建调用与参数/产物规范/前端内嵌打包 cache-busting + 92 个 feature flag 分类总表（工具/技能/插件/命令四类已分表到下述三件） |
| [tools.md](tools.md) | 工具 | 工具全量清单 + 工具类 feature flag |
| [commands.md](commands.md) | 斜杠命令 | 命令全量清单 + 命令类 feature flag |
| [skills-plugins.md](skills-plugins.md) | 技能与插件 | 内置/工作区技能、插件全量清单 + 技能类、插件类 feature flag |
| [glossary.md](glossary.md) | 术语表 | web/CLI 双前端 UI 实体规范名 ↔ 实际 DOM 码对照 + SSE 信号族 |
| [core.md](core.md) | 源码核心机制 | 便携配置根/wire protocol 与 openai-chat 适配器/生图能力层/会话平铺/插件双发现/沙箱权限/自愈日志/神经元 NEURON_RAG/WebSearch 多后端/动态定价/队列催办/工具循环熔断/反应式压缩/会话间协作 |
| [gateway.md](gateway.md) | 网关服务 | API 前缀/认证配对/mDNS/预览容器（含 §6.7 预览多卡片 card.json 扫描）/反代/独立会话进程链/审批中继/会话间通信路由/神经元可视化与文件树·评论端点 |
| [web-ui.md](web-ui.md) | web 前端链路 | 路由/首条消息事务链/session-delta/打断收口/两层消息流占位/渲染与交互定案（§1-§69；含视图卡片化 §41-§42、chat/work 双模式 §43、CM6 编辑区 §54、评论批注 §55、夜晚模式 §56、KaTeX §57、§58 右栏工具页与预览多卡片、围栏代码块 codex 化 §59、统一滚动条 §60、图形化解释口径 §66、源码-渲染-复制协议 §67、work 槽状态模型 §68、工作区根=一等项目 §69） |

## 阅读顺序与优先级

- **规则冲突判定**：`docs/standards.md` > 各项目 CLAUDE.md > 本库其它件。
- **新会话上手**：本件 → [glossary.md](glossary.md)（对齐交流用词）→ 按任务读对应主题件。
- **改码前必查**：涉及构建 → [build.md](build.md)；涉及网关/认证/容器 → [gateway.md](gateway.md)；涉及 web 交互 → [web-ui.md](web-ui.md)；涉及源码核心机制 → [core.md](core.md)。各件头部均注明「改动以下机制时必须同步更新本文」。

## 维护约定

1. **规则 vs 机制分家**：约定/标准留 standards.md；链路机制按服务边界拆 gateway.md / web-ui.md；构建与 flag 独立成 build.md。
2. **重复内容归并**：同一事实只保留一份，其余改交叉链接。
3. **只写现状**：文内只描述当前实现与不变量；历史沿革、发布版本、事故过程归神经元 LOG 层（项目根不再有 LOG.md），不入本库。
4. **改码必同步**：代码改动与对应文档更新同等级，缺一不算任务完成。
