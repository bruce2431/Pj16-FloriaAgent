import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPortableRoot } from '../../utils/envUtils.js'

export interface RepoVersionEntry {
  version: string
  source: string
  error?: string
  at: number
}

export type RepoReadmeEntry = { name: string; text: string; error?: string; at: number }

export const repoVersionCache = new Map<string, RepoVersionEntry>()
export const REPO_VERSION_TTL_MS = 10 * 60 * 1000
export const REPO_VERSION_ERR_TTL_MS = 60 * 1000

export const repoReadmeCache = new Map<string, RepoReadmeEntry>()
export const REPO_README_TTL_MS = 10 * 60 * 1000
const REPO_README_MAX_CHARS = 80_000

export function parseGithubRepo(raw: string): { owner: string; repo: string } | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'github.com' && u.hostname !== 'www.github.com')) return null
  const seg = u.pathname.replace(/\.git$/i, '').split('/').filter(Boolean)
  if (seg.length !== 2) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(seg[0]) || !/^[A-Za-z0-9_.-]+$/.test(seg[1])) return null
  return { owner: seg[0], repo: seg[1] }
}

let githubTokenCache: { token: string; at: number } | null = null
function githubToken(): string {
  if (githubTokenCache && Date.now() - githubTokenCache.at < 60_000) return githubTokenCache.token
  let token = (process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  if (!token) {
    try {
      const p = join(getPortableRoot(), '.claude', 'plugins', 'github', '.mcp.json')
      const cfg = JSON.parse(readFileSync(p, 'utf8')) as { mcpServers?: { github?: { env?: Record<string, string> } } }
      token = String(cfg?.mcpServers?.github?.env?.GITHUB_PERSONAL_ACCESS_TOKEN || '').trim()
    } catch {
      /* 无插件配置：按匿名访问 */
    }
  }
  githubTokenCache = { token, at: Date.now() }
  return token
}

async function githubJson<T>(url: string): Promise<T> {
  const token = githubToken()
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Floria-Gateway',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return (await res.json()) as T
}

export async function probeRepoVersion(g: { owner: string; repo: string }): Promise<RepoVersionEntry> {
  const base = `https://api.github.com/repos/${g.owner}/${g.repo}`
  try {
    const rel = await githubJson<{ tag_name?: string }>(base + '/releases/latest')
    if (rel && typeof rel.tag_name === 'string' && rel.tag_name.trim()) {
      return { version: rel.tag_name.trim(), source: 'release', at: Date.now() }
    }
  } catch {
    /* 无 Release：继续回退 */
  }
  try {
    const tags = await githubJson<Array<{ name?: string }>>(base + '/tags?per_page=1')
    const name = Array.isArray(tags) && tags[0] && typeof tags[0].name === 'string' ? tags[0].name.trim() : ''
    if (name) return { version: name, source: 'tag', at: Date.now() }
  } catch {
    /* 无 tag：继续回退 */
  }
  try {
    const token = githubToken()
    const res = await fetch(`https://raw.githubusercontent.com/${g.owner}/${g.repo}/HEAD/package.json`, {
      headers: { 'User-Agent': 'Floria-Gateway', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const pkg = (await res.json()) as { version?: unknown }
      if (typeof pkg.version === 'string' && pkg.version.trim()) {
        return { version: pkg.version.trim(), source: 'package.json', at: Date.now() }
      }
    }
  } catch {
    /* 无 package.json */
  }
  try {
    const commits = await githubJson<Array<{ sha?: string }>>(base + '/commits?per_page=1')
    const sha = Array.isArray(commits) && commits[0] && typeof commits[0].sha === 'string' ? commits[0].sha.trim() : ''
    if (sha) return { version: sha.slice(0, 7), source: 'commit', at: Date.now() }
  } catch {
    /* 仓库不可访问 */
  }
  return { version: '', source: '', error: '未找到版本信息', at: Date.now() }
}

export async function probeRepoReadme(g: { owner: string; repo: string }, sub = ''): Promise<RepoReadmeEntry> {
  const token = githubToken()
  const base = `https://api.github.com/repos/${g.owner}/${g.repo}`
  const dir = sub.replace(/^\/+|\/+$/g, '')
  if (dir) {
    for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.mdx']) {
      try {
        const res = await fetch(`${base}/contents/${dir}/${name}`, {
          headers: {
            Accept: 'application/vnd.github.raw',
            'User-Agent': 'Floria-Gateway',
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
          },
          signal: AbortSignal.timeout(8000),
        })
        if (res.ok) {
          const text = (await res.text()).slice(0, REPO_README_MAX_CHARS)
          if (text.trim()) return { name, text, at: Date.now() }
        }
      } catch {
        /* 试下一个文件名 */
      }
    }
    return { name: '', text: '', error: '未找到 README', at: Date.now() }
  }
  try {
    const res = await fetch(base + '/readme', {
      headers: {
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'Floria-Gateway',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const text = (await res.text()).slice(0, REPO_README_MAX_CHARS)
      if (text.trim()) return { name: 'README', text, at: Date.now() }
    }
  } catch {
    /* 无 readme API 访问：继续回退 raw */
  }
  for (const name of ['README.md', 'readme.md', 'README.mdx']) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${g.owner}/${g.repo}/HEAD/${name}`, {
        headers: { 'User-Agent': 'Floria-Gateway', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const text = (await res.text()).slice(0, REPO_README_MAX_CHARS)
        if (text.trim()) return { name, text, at: Date.now() }
      }
    } catch {
      /* 试下一个文件名 */
    }
  }
  return { name: '', text: '', error: '未找到 README', at: Date.now() }
}
