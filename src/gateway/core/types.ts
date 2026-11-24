import type { ChildProcess } from 'node:child_process'
import type { WebSocket } from 'ws'

export type LocalGatewayInfo = {
  port: number
  host: string
  token: string
  lanUrl: string
  localUrl: string
}

export interface BackendCfg {
  name?: string
  cmd: string[]
  cwd: string
  port: number
  idleMinutes?: number
  readyPath?: string
  previewDir: string
}

export interface PreviewCard {
  id: string
  title: string
  icon: string
  path: string
  host: 'view'
  tab: boolean
  repo: string
  enabled: boolean
  backendName: string
  backendCfg?: BackendCfg
  elements: unknown[]
  elementsTitle: string
  elementsIcon: string
  elementsScope: 'all' | string[]
}

export interface PreviewPaneCard {
  id: string
  title: string
  icon: string
  entry: string
  order: number
  default: boolean
  repo: string
  enabled: boolean
  backendName: string
  backendCfg?: BackendCfg
}

export type MentionElementInsert =
  | { type: 'text'; text: string }
  | { type: 'token'; token: string }
  | { type: 'path'; path: string; pathType: 'file' | 'dir' }

export interface MentionElement {
  id: string
  name: string
  desc: string
  icon: string
  card: string
  insert: MentionElementInsert
}

export interface MentionElementSource {
  name: string
  icon: string
}

export interface PreviewQuoteAction {
  id: string
  title: string
  icon: string
}

export interface BackendProc {
  pid: number
  port: number
  cfg: BackendCfg
  startedAt: number
  lastActive: number
  child: ChildProcess | null
}

export interface BpSession {
  labels: Set<string>
  expires: number
}

export interface WebSessionProc {
  sessionId: string
  pid?: number
  clients: Set<WebSocket>
  startedAt: number
  lastActive: number
}

export type GatewayTaskItem = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string
  activeForm?: string
  blockedBy: string[]
}

export interface ProjectInfo {
  label: string
  dir: string
  scope: string
  hasPreview: boolean
  hasBackend?: boolean
  backendCfg?: BackendCfg
}

export type EntryOpResult =
  | { ok: true; path?: string; name?: string; trash?: string; size?: number }
  | { ok: false; code: number; error: string }

export type FileWriteResult =
  | { ok: true; path: string; mtime: number }
  | { ok: false; code: number; error: string }

export type StoredUploadFile =
  | { ok: true; name: string; relPath: string; abs: string; size: number }
  | { ok: false; code: number; error: string }

export type UploadKind = 'image' | 'file'
export type UploadScope = 'session' | 'document'
export type UploadReferenceFormat = 'none' | 'markdown' | 'latex-includegraphics' | 'template'
export type UploadFallback = 'session' | 'reject'

export type UploadSlot = {
  id: string
  priority: number
  match: { workFileExtensions: string[]; uploadKinds: UploadKind[] }
  storage: { scope: UploadScope; directory: string }
  reference: { format: UploadReferenceFormat; template?: string; pathPrefix?: string }
  fallback?: UploadFallback
  builtin?: boolean
}

export type UploadDeclaration = {
  slots: UploadSlot[]
  fallback: UploadFallback
}

export type UploadSlotResolution =
  | { ok: true; slot: UploadSlot; fallback: boolean; fallbackReason?: string }
  | { ok: false; code: number; error: string }

export type ProjectComment = {
  id: string
  path: string
  l0: number
  l1: number
  excerpt: string
  body: string
  author: string
  createdAt: string
  resolved: boolean
}

export interface CardBackendEntry {
  id: string
  cfg: BackendCfg
}

export type TreeNode = { name: string; type: 'file' | 'dir'; children?: TreeNode[] }

export type DeliveryFeedback = {
  staged: (spawning: boolean) => void
  resuming: () => void
  done: (ok: boolean, error?: string) => void
}

export type CardCap = {
  label?: string
  instanceId?: string
  kind?: string
  ns?: string
  cmds?: string[]
  ready?: boolean
}

export type CardOutcome =
  | { kind: 'ok'; result: unknown }
  | { kind: 'err'; error: string }
  | { kind: 'timeout' }
  | { kind: 'gone' }

export interface EjectTarget {
  sessionId: string
  pid?: number
}
