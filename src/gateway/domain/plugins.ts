import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCustomizationDirEnabled } from '../../utils/customizationToggle.js'
import { isDir, readJsonObject } from '../core/utils.js'

function parseSkillFrontmatter(text: string): { name: string; description: string; repo: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out = { name: '', description: '', repo: '' }
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    const val = line.slice(i + 1).trim()
    if (key === 'name') out.name = val
    else if (key === 'description') out.description = val
    else if (key === 'repo' || key === 'repository') out.repo = val.replace(/^['"]|['"]$/g, '')
  }
  return out
}

export function readSkillDir(skillsDir: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (!isDir(skillsDir)) return out
  for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const dir = join(skillsDir, e.name)
    const fp = join(dir, 'SKILL.md')
    if (!existsSync(fp)) continue
    const fm = parseSkillFrontmatter(readFileSync(fp, 'utf8'))
    out.push({
      n: fm.name || e.name,
      d: fm.description,
      repo: fm.repo,
      inst: 1,
      k: e.name,
      en: isCustomizationDirEnabled(dir) ? 1 : 0,
    })
  }
  return out
}

export function readPluginDir(pluginsDir: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (!isDir(pluginsDir)) return out
  for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'data' || e.name === 'marketplaces') continue
    const m = readJsonObject(join(pluginsDir, e.name, '.claude-plugin', 'plugin.json'))
    if (!m) continue
    const repoRaw = m.repository
    const repoField =
      typeof repoRaw === 'string'
        ? repoRaw
        : repoRaw && typeof repoRaw === 'object'
          ? String((repoRaw as Record<string, unknown>).url || '')
          : ''
    const homepage = typeof m.homepage === 'string' ? m.homepage : ''
    const repo = /^https?:\/\/github\.com\//i.test(repoField)
      ? repoField
      : /^https?:\/\/github\.com\//i.test(homepage)
        ? homepage
        : ''
    out.push({
      n: String(m.name || e.name),
      d: String(m.description || ''),
      v: String(m.version || ''),
      repo,
      inst: 1,
      k: e.name,
      en: isCustomizationDirEnabled(join(pluginsDir, e.name)) ? 1 : 0,
    })
  }
  return out
}

export function listPlugins(root: string): Record<string, unknown> {
  const pluginsDir = join(root, '.claude', 'plugins')
  const skillsDir = join(root, '.claude', 'skills')

  const personalPlugins = readPluginDir(pluginsDir)
  const personalSkills = readSkillDir(skillsDir)

  const sortN = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    String(a.n).localeCompare(String(b.n))
  personalPlugins.sort(sortN)
  personalSkills.sort(sortN)

  return {
    workspace: root,
    plugins: { personal: personalPlugins },
    skills: { personal: personalSkills },
  }
}
