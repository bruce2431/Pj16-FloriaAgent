/* 离线演示数据（?demo=1）——由 demo-mode.js 的 fetch 垫片读取，供预览卡内嵌真实前端时使用。
   只描述界面所需的最小数据：会话列表 / 单会话消息 / 项目文件树 / 模型座；不含任何真实用户数据。 */
window.FLORIA_DEMO_DATA = (() => {
  const now = Date.now()
  const t0 = now - 42 * 60 * 1000
  const messages = [
    {
      role: 'user',
      blocks: [{ kind: 'text', text: '给底栏加一个「最近文件」入口，点开列出最近改过的文件。' }],
      timestamp: t0,
      sid: 'demo-m1',
    },
    {
      role: 'assistant',
      blocks: [
        { kind: 'thinking', text: '先确认底栏工具栏现有的入口结构，再决定挂在哪个分组。' },
        { kind: 'tool_use', name: 'Grep', input: { pattern: 'cmdViews|toolbar/', path: 'gateway/web-src/inputbar' } },
      ],
      timestamp: t0 + 4000,
      stopReason: null,
      sid: 'demo-m2',
      model: 'deepseek-v4',
    },
    {
      role: 'assistant',
      blocks: [
        { kind: 'tool_result', name: 'Grep', text: 'inputbar/toolbar/entries.js:34  function cmdViews()\ninputbar/commands.js:150  openCmdPop()' },
      ],
      timestamp: t0 + 9000,
      stopReason: null,
      sid: 'demo-m3',
      model: 'deepseek-v4',
    },
    {
      role: 'assistant',
      blocks: [
        { kind: 'text', text: '入口挂在「+」工具栏首屏：新增「最近文件」分组，数据按文件修改时间倒序取前 20 条，选中即插入文件引用。' },
      ],
      timestamp: t0 + 21000,
      stopReason: 'end_turn',
      sid: 'demo-m4',
      usage: { input: 18240, cacheRead: 96000, cacheWrite: 3200, output: 1180 },
      model: 'deepseek-v4',
    },
  ]
  return {
    sessions: {
      workspace: 'WorkFlie',
      // 演示用通用项目：不指向真实目录、不声明任何预览，右栏不会加载真实预览页
      groups: [
        { label: 'WorkFlie', dir: 'WorkFlie', scope: 'project', hasPreview: false },
      ],
      sessions: [
        {
          file: 'demo-1.jsonl',
          title: '演示 · 底栏最近文件入口',
          // 全局根会话：chat 侧栏不显示任何项目标签/项目分组
          projectLabel: '',
          projectScope: 'global',
          messageCount: messages.length,
          updatedAt: now - 12 * 60 * 1000,
          createdAt: t0 - 10 * 60 * 1000,
          state: null,
          turnEndAt: null,
        },
        {
          // work 模式项目会话：work 侧栏「聊天」页签只列 projectLabel === 当前工作项目的会话
          file: 'demo-2.jsonl',
          title: '演示 · 预览卡组件树',
          projectLabel: 'WorkFlie',
          projectScope: 'project',
          messageCount: 3,
          updatedAt: now - 32 * 60 * 1000,
          createdAt: t0 - 40 * 60 * 1000,
          state: null,
          turnEndAt: null,
        },
      ],
    },
    session: {
      file: 'demo-1',
      cwd: 'WorkFlie',
      model: 'deepseek-v4',
      effort: 'low',
      context: { usedTokens: 38400, contextWindow: 200000, percent: 19 },
      queued: [],
      tasks: [],
      deltaSeq: 0,
      messages,
    },
    models: {
      activeModel: 'deepseek-v4',
      activeProvider: 'deepseek',
      effortLevel: 'low',
      items: [],
    },
    project: {
      files: [
        {
          name: 'src',
          type: 'dir',
          children: [
            { name: 'app.ts', type: 'file' },
            { name: 'gateway', type: 'dir', children: [{ name: 'localGateway.ts', type: 'file' }] },
          ],
        },
        { name: 'docs', type: 'dir', children: [{ name: 'gateway.md', type: 'file' }] },
        { name: 'CLAUDE.md', type: 'file' },
        { name: 'README.md', type: 'file' },
      ],
    },
    // 演示项目不提供任何预览：无传统单页、无卡，右栏只显示空态
    previewCards: { label: 'WorkFlie', cards: [], previewCards: [], hasIndex: false, indexEnabled: false },
    plugins: { plugins: [], skills: [], items: [] },
  }
})()
