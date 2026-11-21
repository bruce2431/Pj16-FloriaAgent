/**
 * webAssets.ts —— 网关静态前端资源的唯一投送点。
 *
 * 解析顺序：
 *  1. dev 磁盘（exe/项目根的 `Floria/src/gateway/web/` 或 `src/gateway/web/`）
 *     —— 改 index.html / app.js / sw.js 后刷新即生效，不必重建 exe、不必重启网关；
 *  2. 内嵌 `web-assets.generated.ts`（build 时打包，拷贝部署到别处时用）。
 *
 * 磁盘层按 mtime 做缓存失效：文件被重新生成（bundle-web）后，下一个请求就拿新内容。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { webAssets } from './web-assets.generated.js'

const WEB_REL_IN_REPO = join('src', 'gateway', 'web')

/** dev 源码里 web 目录的候选位置（按优先级）。 */
function devWebDirCandidates(): string[] {
  const exeDir = dirname(process.execPath)
  const cwd = process.cwd()
  const out: string[] = []
  const push = (d: string) => {
    const abs = resolve(d)
    if (!out.includes(abs)) out.push(abs)
  }
  // exe 在项目根（构建产物直出）→ <exeDir>/Floria/src/gateway/web
  push(join(exeDir, 'Floria', WEB_REL_IN_REPO))
  // 源码直跑（bun dev）→ cwd 即 Floria/ 或项目根
  push(join(cwd, WEB_REL_IN_REPO))
  push(join(cwd, 'Floria', WEB_REL_IN_REPO))
  push(join(exeDir, WEB_REL_IN_REPO))
  return out
}

let devDirCache: { dir: string | null; checkedAt: number } | null = null
const DEV_DIR_RECHECK_MS = 5_000

/** dev 磁盘目录（含 index.html 才认）；不存在返回 null → 用内嵌资源。 */
function devWebDir(): string | null {
  const now = Date.now()
  if (devDirCache && now - devDirCache.checkedAt < DEV_DIR_RECHECK_MS) return devDirCache.dir
  let dir: string | null = null
  for (const c of devWebDirCandidates()) {
    if (existsSync(join(c, 'index.html'))) {
      dir = c
      break
    }
  }
  devDirCache = { dir, checkedAt: now }
  return dir
}

const diskCache = new Map<string, { mtimeMs: number; size: number; buf: Buffer }>()
const embeddedCache = new Map<string, Buffer>()

/** 读一个 web 资源（key 用相对 web 根的正斜杠路径，'index.html'）。 */
export function readWebAsset(rel: string): Buffer | null {
  const dir = devWebDir()
  if (dir) {
    const file = join(dir, rel)
    try {
      const st = statSync(file)
      if (st.isFile()) {
        const hit = diskCache.get(rel)
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.buf
        const buf = readFileSync(file)
        diskCache.set(rel, { mtimeMs: st.mtimeMs, size: st.size, buf })
        return buf
      }
    } catch {
      /* 磁盘缺该文件 → 回落内嵌（如部署包只覆盖了部分资源） */
    }
  }
  const cached = embeddedCache.get(rel)
  if (cached) return cached
  const b64 = webAssets[rel]
  if (b64 === undefined) return null
  const buf = Buffer.from(b64, 'base64')
  embeddedCache.set(rel, buf)
  return buf
}

/** 前端资源版本戳：变了说明投送内容换了一版（dev 取磁盘 mtime，内嵌取内容长度）。 */
export function webAssetStamp(): string {
  const dir = devWebDir()
  if (dir) {
    try {
      const picks = ['index.html', 'app.js', 'sw.js'].map((f) => {
        const st = statSync(join(dir, f))
        return `${basename(f)}:${Math.round(st.mtimeMs)}`
      })
      return picks.join('|')
    } catch {
      /* 落到内嵌戳 */
    }
  }
  const t = (k: string) => (webAssets[k] ? webAssets[k].length : 0)
  return `embedded:${t('index.html')}/${t('app.js')}/${t('sw.js')}`
}

/** 供诊断：当前资源来自磁盘还是 exe 内嵌。 */
export function webAssetSource(): 'disk' | 'embedded' {
  return devWebDir() ? 'disk' : 'embedded'
}
