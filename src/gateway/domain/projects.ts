import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getCwdRoot, getGlobalRoot } from '../../tools/neturon/config.js'
import { getPortableRoot } from '../../utils/envUtils.js'
import { GLOBAL_PROJECT_LABEL } from '../core/state.js'
import type { ProjectInfo, TreeNode } from '../core/types.js'
import { isDir } from '../core/utils.js'
import { readBackendCfg } from './preview.js'

export function findProjects(root: string): ProjectInfo[] {
  const groups: ProjectInfo[] = []
  const global = join(root, '.claude', 'projects')
  if (isDir(global)) {
    groups.push({
      label: GLOBAL_PROJECT_LABEL,
      dir: global,
      scope: 'global',
      hasPreview: isDir(join(root, '.claude', 'preview')),
    })
  }
  const entries = readdirSync(root, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue
    const isTempTaskDir = /^\d{8,14}-/.test(e.name)
    const pd = join(root, e.name, '.claude', 'projects')
    if (isDir(pd) || isTempTaskDir) {
      const previewDir = join(root, e.name, '.claude', 'preview')
      const info: ProjectInfo = { label: e.name, dir: pd, scope: 'project', hasPreview: isDir(previewDir) }
      if (info.hasPreview) {
        const cfg = readBackendCfg(previewDir)
        if (cfg) {
          info.hasBackend = true
          info.backendCfg = cfg
        }
      }
      groups.push(info)
    }
  }
  return groups
}

export function gatewayNeuronRoots(): string[] {
  const roots = [getCwdRoot()]
  const portable = getPortableRoot()
  for (const e of readdirSync(portable, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue
    if (/^\d{8,14}-/.test(e.name)) continue
    const nr = join(portable, e.name, '.claude', 'neturon')
    if (isDir(nr)) roots.push(nr)
  }
  roots.push(getGlobalRoot())
  return [...new Set(roots)]
}

const SKIP_TREE_DIRS = new Set([
  '.git',
  'node_modules',
  '.claude',
  '.trash',
  '.cache',
  'dist',
  'cli-dist',
  '.idea',
  '.vscode',
])

export const TREE_BUDGET = 8000

function cmpTreeEntry(a: { name: string; isDirectory(): boolean }, b: { name: string; isDirectory(): boolean }): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true })
}

export function listOneLevel(dir: string): TreeNode[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  entries.sort(cmpTreeEntry)
  const out: TreeNode[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory() && SKIP_TREE_DIRS.has(e.name)) continue
    out.push(e.isDirectory() ? { name: e.name, type: 'dir' } : { name: e.name, type: 'file' })
  }
  return out
}

function listTreeLevel(dir: string, budget: { n: number }): TreeNode[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  entries.sort(cmpTreeEntry)
  const out: TreeNode[] = []
  for (const e of entries) {
    if (budget.n <= 0) break
    if (e.name.startsWith('.')) continue
    if (e.isDirectory() && SKIP_TREE_DIRS.has(e.name)) continue
    budget.n--
    out.push(e.isDirectory() ? { name: e.name, type: 'dir' } : { name: e.name, type: 'file' })
  }
  return out
}

export function walkProjectTree(dir: string, budget: { n: number }): TreeNode[] {
  const roots = listTreeLevel(dir, budget)
  const queue: Array<{ path: string; node: TreeNode }> = []
  for (const n of roots) if (n.type === 'dir') queue.push({ path: join(dir, n.name), node: n })
  while (queue.length && budget.n > 0) {
    const cur = queue.shift()!
    const kids = listTreeLevel(cur.path, budget)
    if (!kids.length) continue
    cur.node.children = kids
    for (const k of kids) if (k.type === 'dir') queue.push({ path: join(cur.path, k.name), node: k })
  }
  return roots
}

export function findProjectReadme(dir: string): string | null {
  const names = ['README.md', 'readme.md', 'README.markdown', 'readme.markdown', 'README.txt', 'readme.txt']
  for (const n of names) {
    const p = join(dir, n)
    if (existsSync(p) && statSync(p).isFile()) {
      const txt = readFileSync(p, 'utf8')
      return txt.length > 200 * 1024 ? txt.slice(0, 200 * 1024) : txt
    }
  }
  try {
    const hit = readdirSync(dir).find((f) => /^readme/i.test(f) && !/^\./.test(f))
    if (hit) {
      const p = join(dir, hit)
      if (existsSync(p) && statSync(p).isFile()) {
        const txt = readFileSync(p, 'utf8')
        return txt.length > 200 * 1024 ? txt.slice(0, 200 * 1024) : txt
      }
    }
  } catch {
    /* 忽略 */
  }
  return null
}

export function deriveProjectDescription(readme: string | null, label: string): string {
  if (readme) {
    for (const line of readme.split('\n')) {
      const m = /^#\s+(.+?)\s*$/.exec(line)
      if (m) return m[1].trim().slice(0, 120)
    }
  }
  return label
}
