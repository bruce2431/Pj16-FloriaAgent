import { chmodSync, existsSync, mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json() as {
  name: string
  version: string
}

// 子脚本一律用「当前正在跑的 bun」启动，而非 PATH 里的 `bun`——本机 bun 是便携副本
// （F:\@WrokSpace\.tools\bun\bun.exe），不在 PATH；裸名会 ENOENT 打断构建。
const BUN_BIN = process.execPath

const args = process.argv.slice(2)
const compile = args.includes('--compile')
const dev = args.includes('--dev')

const fullExperimentalFeatures = [
  'AGENT_MEMORY_SNAPSHOT',
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'AWAY_SUMMARY',
  'BASH_CLASSIFIER',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'CACHED_MICROCOMPACT',
  'COMPACTION_REMINDERS',
  'CONNECTOR_TEXT',
  'EXTRACT_MEMORIES',
  'HISTORY_PICKER',
  'HOOK_PROMPTS',
  'KAIROS_BRIEF',
  'KAIROS_CHANNELS',
  'LODESTONE',
  'MCP_RICH_OUTPUT',
  'MESSAGE_ACTIONS',
  'NATIVE_CLIPBOARD_IMAGE',
  'NEW_INIT',
  'POWERSHELL_AUTO_MODE',
  'PROMPT_CACHE_BREAK_DETECTION',
  'QUICK_SEARCH',
  'SHOT_STATS',
  'TEAMMEM',
  'TOKEN_BUDGET',
  'TREE_SITTER_BASH',
  'TREE_SITTER_BASH_SHADOW',
  'ULTRAPLAN',
  'ULTRATHINK',
  'UNATTENDED_RETRY',
  'VERIFICATION_AGENT',
  'VOICE_MODE',
] as const

function runCommand(cmd: string[]): string | null {
  const proc = Bun.spawnSync({
    cmd,
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (proc.exitCode !== 0) {
    return null
  }

  return new TextDecoder().decode(proc.stdout).trim() || null
}

// dev 版本串 = <base>+<构建元数据>。构建元数据必须挂在 `+` 而非 `-`：
// `-` 在 SemVer 里引出 pre-release 段（语义「某版本的预发布版」，且优先级低于该版本本身），
// 把已发布产物标成比 base 更早的预发布属于自相矛盾；`+` 引出 build metadata，
// 不参与优先级比较，语义正是「同版本、不同构建」——dev 与正式版的区分另由产物名
// 的 `cli-dev-` 前缀承载（见下方 outfile 推导）。
function getDevVersion(baseVersion: string): string {
  const timestamp = new Date().toISOString()
  const date = timestamp.slice(0, 10).replaceAll('-', '')
  const time = timestamp.slice(11, 19).replaceAll(':', '')
  const sha = runCommand(['git', 'rev-parse', '--short=8', 'HEAD']) ?? 'unknown'
  return `${baseVersion}+${date}.t${time}.sha${sha}`
}

function getVersionChangelog(): string {
  return (
    runCommand(['git', 'log', '--format=%h %s', '-20']) ??
    'Local development build'
  )
}

// 2026-08-25 用户定案：PRIVATE_GATEWAY（内置私有化网关）进默认特性——所有构建默认含 /server，
// 无需再显式 --feature=PRIVATE_GATEWAY（build:dev:gateway 显式传入仍按显式代号命名产物）
// 2026-09-15 用户定案：SESSION_LINK（会话间协作 session_send）进默认特性——工具未暴露任何会话时
// 完全惰性（isEnabled 恒真但 checkPermissions 无授权目标即拒），进默认收益 = 免专用 flag 构建即可实测。
// NEURON_RAG（神经元内置检索/记忆）默认关：需显式 --feature=NEURON_RAG 才注册 recall/remember 等工具与名册段。
// 2026-10-11 用户定案：CARD_API（卡片公开 API 的 agent 侧工具 CardCall）进默认特性——门控点 =
// tools.ts 登记 + CardCallTool.isEnabled()（feature('CARD_API')）；无浏览器在场时 list 返回空、call 明确报错。
// VOICE_MODE（/voice 等语音 UI）默认关：voice_stream 后端随 OAuth 移除已不可用，flag 仅剩 UI/按键编排，
// 需显式 --feature=VOICE_MODE 才编入。
const defaultFeatures = ['BUILTIN_EXPLORE_PLAN_AGENTS', 'PRIVATE_GATEWAY', 'REACTIVE_COMPACT', 'SESSION_LINK', 'CARD_API']
const featureSet = new Set(defaultFeatures)
// 显式 --feature=X 的代号集合：用于输出 exe 以 feature 代号命名（feature 构建不复用默认 cli-dev 名，避免互相覆盖）
const explicitFeatures = new Set<string>()
// 本地时间戳 YYYYMMDDHHMMSS，用于产物命名，区分不同构建
function getBuildTimestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--feature-set' && args[i + 1]) {
    if (args[i + 1] === 'dev-full') {
      for (const feature of fullExperimentalFeatures) {
        featureSet.add(feature)
      }
    }
    i += 1
    continue
  }
  if (arg === '--feature-set=dev-full') {
    for (const feature of fullExperimentalFeatures) {
      featureSet.add(feature)
    }
    continue
  }
  if (arg === '--feature' && args[i + 1]) {
    featureSet.add(args[i + 1]!)
    explicitFeatures.add(args[i + 1]!)
    i += 1
    continue
  }
  if (arg.startsWith('--feature=')) {
    const f = arg.slice('--feature='.length)
    featureSet.add(f)
    explicitFeatures.add(f)
  }
}
const features = [...featureSet]

// 2026-08-25 用户定案：dev 构建（build:dev / build:dev:gateway）产物直接输出到项目根
// （仓库根 Floria 的上一级 = 便携项目根，免手动复制部署）。基于脚本位置推导
// （import.meta.url = <项目根>/Floria/scripts/build.ts → 上两级），不依赖 cwd。
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)) // <项目根>/Floria/scripts
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..', '..') // <项目根>

// 产物命名 = <前缀>-<YYYYMMDDHHMMSS>[-<显式 feature 代号>]，Windows 输出 .exe；
// 时间戳保证不同构建不覆盖，显式 --feature 代号在时间戳后追加（多个用 + 连接）
// compile（正式发布）仍输出 ./dist/，dev 构建直出项目根
const baseOutfile = compile
  ? dev
    ? './dist/cli-dev'
    : './dist/cli'
  : dev
    ? join(PROJECT_ROOT, 'cli-dev')
    : join(PROJECT_ROOT, 'cli')
const buildTimestamp = getBuildTimestamp()
const outfile =
  explicitFeatures.size > 0
    ? `${baseOutfile}-${buildTimestamp}-${[...explicitFeatures].join('+')}`
    : `${baseOutfile}-${buildTimestamp}`
const buildTime = new Date().toISOString()
const version = dev ? getDevVersion(pkg.version) : pkg.version

const outDir = dirname(outfile)
if (outDir !== '.') {
  mkdirSync(outDir, { recursive: true })
}

const externals = [
  '@ant/*',
  'audio-capture-napi',
  'image-processor-napi',
  'modifiers-napi',
  'url-handler-napi',
]

// sharp stub（2026-09-04）：自包含 exe 内 sharp 原生绑定无法加载（@img/sharp-win32-x64 的
// .node 依赖同目录 libvips DLL，兄弟 DLL 打包后到不了位 → LoadLibrary 失败），而
// @huggingface/transformers 对 sharp 是静态 import（image.js:17）——不 stub 则 transformers
// 整包加载即炸，BGE 文本嵌入链瘫痪。仅对 transformers 的 import 重定向：BGE 纯文本嵌入
// 不调用 sharp 任何 API，stub 保持可 import（保住模块图）但真实调用立即报错（不留兜底）。
// 其它 importer（FileReadTool 等）保持真 sharp，行为不变（exe 内其自带 try/catch 降级链）。
const SHARP_STUB_SOURCE = `
const thrower = (prop) => () => {
  throw new Error('sharp.' + String(prop) + '() is stubbed out of the compiled exe: native bindings cannot load in a self-contained binary (DLL siblings unavailable). Text-only pipelines are unaffected; run from source (bun run dev) for image processing.')
}
export default new Proxy({}, { get: (_t, prop) => thrower(prop) })
`

const sharpStubPlugin: BunPlugin = {
  name: 'sharp-stub-for-transformers',
  setup(builder) {
    builder.onResolve({ filter: /^sharp$/ }, (args) => {
      if (
        args.importer &&
        args.importer.includes('@huggingface') &&
        args.importer.includes('transformers')
      ) {
        return { path: 'sharp-stub', namespace: 'sharp-stub' }
      }
      return undefined
    })
    builder.onLoad({ filter: /.*/, namespace: 'sharp-stub' }, () => ({
      contents: SHARP_STUB_SOURCE,
      loader: 'js',
    }))
  },
}

// 2026-10-03：自包含 exe 内嵌 ripgrep——Bun 1.4.2 编译产物不再提供 argv0='rg' 的
// 内部分发（旧链 `command: process.execPath, argv0:'rg'` 会以 CLI 自身启动并把 --hidden
// 当未知选项，exit 1 被 ripgrep.ts 当作「无匹配」→ Grep/Glob 全路径恒空），而系统 rg
// 与 builtin 目录在本机均不可得。改为把本仓自带 rg 作为构建资产内嵌，运行时落地到
// 真实路径再 spawn（内嵌虚拟路径只可读、不可执行）。宿主平台二进制缺失即硬失败，
// 不静默降级（降级=回到「Grep 恒空」的坑）。
const rgBinPath = resolve(
  SCRIPT_DIR,
  '..',
  'src',
  'vendor',
  'ripgrep',
  `${process.arch}-${process.platform}`,
  process.platform === 'win32' ? 'rg.exe' : 'rg',
)
if (!existsSync(rgBinPath)) {
  console.error(
    `[build] 自带 ripgrep 缺失：${rgBinPath}（Grep/Glob 依赖它，拒绝产出不可用的 exe）`,
  )
  process.exit(1)
}

const ripgrepEmbedPlugin: BunPlugin = {
  name: 'ripgrep-bin-embed',
  setup(builder) {
    builder.onResolve({ filter: /^virtual:ripgrep-bin$/ }, () => ({
      path: rgBinPath,
      namespace: 'ripgrep-bin',
    }))
    builder.onLoad({ filter: /.*/, namespace: 'ripgrep-bin' }, async () => ({
      contents: new Uint8Array(await Bun.file(rgBinPath).arrayBuffer()),
      loader: 'file',
    }))
  },
}

const defines = {
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.CLAUDE_CODE_FORCE_FULL_LOGO': JSON.stringify('true'),
  ...(dev
    ? { 'process.env.NODE_ENV': JSON.stringify('development') }
    : {}),
  ...(dev
    ? {
        'process.env.CLAUDE_CODE_EXPERIMENTAL_BUILD': JSON.stringify('true'),
      }
    : {}),
  'process.env.CLAUDE_CODE_VERIFY_PLAN': JSON.stringify('false'),
  'process.env.CCR_FORCE_BUNDLE': JSON.stringify('true'),
  'MACRO.VERSION': JSON.stringify(version),
  'MACRO.BUILD_TIME': JSON.stringify(buildTime),
  'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
  'MACRO.NATIVE_PACKAGE_URL': 'undefined',
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'use the /feedback command to report a feature request or bug.',
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(
    dev ? getVersionChangelog() : 'https://github.com/paoloanzn/claude-code',
  ),
} as const

// 前端 JS 模块拼接：src/gateway/web-src/（ESM 模块源码，唯一手改处）→ src/gateway/web/app.js（单 IIFE 产物）。
// 不用 Bun.build 打包器：其按依赖图重排模块执行序，而各模块顶层立即执行代码（事件绑定/DOM 初始化）依赖
// 原 IIFE 物理行序（重排 → TDZ 崩溃，2026-09-10 首跑实证），且切割会丢 IIFE 顶部区间外的 `const $` 声明
// ——故用自写拼接器按切割区间行序拼回（行序=原执行序，语义保真），锚点检索防呆，产物可 diff 等价验证。
// web/app.js 是生成物勿手改；产物文件名/引用不变（?v= cache-bust、sw CORE、gen-web-assets 全链零改动）。
const bundleWeb = Bun.spawnSync({
  cmd: [BUN_BIN, 'scripts/bundle-web-modules.ts'],
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
})
if (bundleWeb.exitCode !== 0) {
  console.error('[build] 前端模块拼接失败（bundle-web-modules），终止构建')
  process.exit(bundleWeb.exitCode ?? 1)
}

// 前端资源打包：把 src/gateway/web/ → web-assets.generated.ts（内置网关 PRIVATE_GATEWAY 内嵌 serve 用）
// 生成产物会打进 exe，因此每次构建都自动重跑，保证 exe 内前端为最新。
const genWeb = Bun.spawnSync({
  cmd: [BUN_BIN, 'scripts/gen-web-assets.ts'],
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
})
if (genWeb.exitCode !== 0) {
  console.error('[build] 前端资源打包失败（gen-web-assets），终止构建')
  process.exit(genWeb.exitCode ?? 1)
}

// 2026-09-04：CLI spawn 改 Bun.build() API（旗标经探针验证完整等价，探针留档
// 20260904202312-sharp-stub-exe修复/）——API 才能挂 onResolve 插件做 sharp stub。
const result = await Bun.build({
  entrypoints: ['./src/entrypoints/cli.tsx'],
  target: 'bun',
  format: 'esm',
  minify: true,
  bytecode: true,
  packages: 'bundle',
  conditions: ['bun'],
  compile: {
    outfile,
    windowsIcon: 'assets/icon.ico',
  },
  external: externals,
  define: defines,
  features,
  plugins: [sharpStubPlugin, ripgrepEmbedPlugin],
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

if (existsSync(outfile)) {
  chmodSync(outfile, 0o755)
}

// bun writes `<outfile>.exe` on Windows
const builtPath = existsSync(outfile) ? outfile : `${outfile}.exe`

console.log(`Built ${builtPath}`)

// Icon finalization: rewrite into a SINGLE RT_GROUP_ICON (id=1) so Windows
// Explorer does per-size frame selection (crisp at every size). bun's own
// `--windows-icon` embeds a two-group structure (IDI_MYICON 256-only) that
// Windows reuses for ALL sizes → over-sharpened small icons. See
// scripts/postprocess-icon.mjs. Failure here is non-fatal (bun's icon remains).
if (existsSync(builtPath)) {
  const post = Bun.spawnSync({
    cmd: [BUN_BIN, 'scripts/postprocess-icon.mjs', builtPath, 'assets/icon.ico'],
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (post.exitCode !== 0) {
    console.warn(`[build] icon post-process failed (exit ${post.exitCode}); keeping bun-embedded icon`)
  }
}

// dev 构建即部署：8124 上运行的若是别的 exe，构建完直接换成本次产物。
// 杀/起必须交给唯一重启模板（同进程零间隙，防旧会话 60s 节流抢先拉起旧网关）。
// 只对 --dev 生效；--compile 发布产物不碰现网。
function portHolderName(port: number): string | null {
  const out = runCommand(['netstat', '-ano'])
  if (!out) return null
  const pids = new Set<string>()
  for (const line of out.split('\n')) {
    if (!line.includes(`:${port}`) || !line.includes('LISTENING')) continue
    const cols = line.trim().split(/\s+/)
    pids.add(cols[cols.length - 1])
  }
  const pid = [...pids][0]
  if (!pid) return null
  const name = runCommand([
    'powershell', '-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").Name`,
  ])
  return name ? name.trim() : null
}

if (dev && existsSync(builtPath)) {
  const holder = portHolderName(8124)
  const newName = builtPath.replace(/\\/g, '/').split('/').pop()!
  if (holder && holder !== newName) {
    const nextRoot = resolve(process.cwd(), '..')
    const restart = join(nextRoot, '.claude', 'neturon', 'neurons', 'Neuron-Pj16', 'l3.raw', 'files', '20261006192000-restart-gateway.ts')
    if (existsSync(restart)) {
      console.log(`[build] 8124 由 ${holder} 持有 → 重启网关为 ${newName}`)
      const r = Bun.spawnSync({
        cmd: [BUN_BIN, restart, newName],
        cwd: nextRoot,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      if (r.exitCode !== 0) console.warn(`[build] 网关重启失败（exit ${r.exitCode}），可手动重跑模板`)
    } else {
      console.warn(`[build] 未找到网关重启模板（${restart}），跳过自动重启`)
    }
  }
}
