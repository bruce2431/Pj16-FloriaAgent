/**
 * 回合内热启用：用户 @ 点名的停用插件/技能只在**该回合**内对 agent 生效。
 *
 * 启用态（目录内 `.disabled`）只控制会话启动时的默认暴露面；消息里的
 * `[插件:名称]` 令牌（web 的 @ 提及序列化，技能同用该前缀）是显式点名，
 * 本模块把对应目录登记为「本回合启用」，两个加载侧把它当作已启用：
 * - `skills/loadSkillsDir.ts`（.claude/skills/<name>）
 * - `utils/plugins/pluginLoader.ts`（.claude/plugins/<name> 就地插件）
 *
 * 生命周期 = `executeUserInput` 的 try/finally：回合开始前解析并 set、
 * 回合结束 clear，并清除插件/命令 memo，令技能清单与 Skill 工具在下一回合复位。
 */

import { readdir, readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { parseFrontmatter } from '../frontmatterParser.js'
import { getProjectDirsUpToHome } from '../markdownConfigLoader.js'
import { isCustomizationDirEnabled } from '../customizationToggle.js'
import { getPluginsDirectory } from './pluginDirectories.js'

const exposedPaths = new Set<string>()

/** 该目录是否被本回合 @ 点名热启用（加载侧与 isCustomizationDirEnabled 取或）。 */
export function isTurnExposedPath(dir: string): boolean {
  return exposedPaths.size > 0 && exposedPaths.has(resolve(dir))
}

export function hasTurnExposure(): boolean {
  return exposedPaths.size > 0
}

export function setTurnExposedPaths(dirs: readonly string[]): void {
  exposedPaths.clear()
  for (const dir of dirs) exposedPaths.add(resolve(dir))
}

export function clearTurnExposedPaths(): void {
  exposedPaths.clear()
}

/** `[插件:名称]` / `[技能:名称]` 令牌取名称（名称里允许出现冒号以外的任意字符）。 */
const PLUGIN_TOKEN_RE = /\[(?:插件|技能):([^\]\n]{1,200})\]/g

export function parseTurnExposedNames(text: string): string[] {
  const names = new Set<string>()
  for (const m of String(text || '').matchAll(PLUGIN_TOKEN_RE)) {
    const name = m[1]?.trim()
    if (name) names.add(name)
  }
  return [...names]
}

async function readManifestName(dir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')
    const m = JSON.parse(raw) as { name?: unknown }
    return typeof m.name === 'string' && m.name ? m.name : null
  } catch {
    return null
  }
}

async function readSkillName(dir: string): Promise<string | null> {
  try {
    const md = await readFile(join(dir, 'SKILL.md'), 'utf8')
    const name = parseFrontmatter(md).frontmatter?.name
    return typeof name === 'string' && name.trim() ? name.trim() : null
  } catch {
    return null
  }
}

/**
 * 从一条用户输入解析出台词里点名的、当前停用的插件/技能目录。
 * 已启用的不返回（本来就在暴露面内，无需额外动作）。
 */
export async function resolveTurnExposedPaths(text: string): Promise<string[]> {
  const names = new Set(parseTurnExposedNames(text))
  if (names.size === 0) return []

  const found = new Set<string>()

  // 就地插件：<便携根>/.claude/plugins/<name>/（与 loadSkillsDirPlugins 同一发现口径）
  const pluginsDir = getPluginsDirectory()
  let pluginEntries
  try {
    pluginEntries = await readdir(pluginsDir, { withFileTypes: true })
  } catch {
    pluginEntries = []
  }
  for (const entry of pluginEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name === 'data' || entry.name === 'marketplaces') continue
    const dir = join(pluginsDir, entry.name)
    const manifestName = await readManifestName(dir)
    if (!manifestName) continue
    if (!names.has(manifestName) && !names.has(entry.name)) continue
    if (isCustomizationDirEnabled(dir)) continue
    found.add(dir)
  }

  // 技能目录：便携根 .claude/skills + 项目 .claude/skills（与 getSkillDirCommands 同源）
  const skillBases = [
    join(getClaudeConfigHomeDir(), 'skills'),
    ...getProjectDirsUpToHome('skills', getOriginalCwd()),
  ]
  for (const base of skillBases) {
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = join(base, entry.name)
      // 带 .claude-plugin 的目录是插件，由上一段处理
      const skillName = await readSkillName(dir)
      if (!skillName) continue
      if (!names.has(skillName) && !names.has(entry.name)) continue
      if (isCustomizationDirEnabled(dir)) continue
      found.add(dir)
    }
  }

  return [...found]
}
