import { dirname, sep } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from '../../services/teamMemorySync/teamMemSecretGuard.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  countLinesChanged,
  getPatchForDisplay,
  sumLinesChanged,
} from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { getFileModificationTime, writeTextContent } from '../../utils/file.js'
import {
  findFileModifier,
  recordFileModifier,
} from '../../utils/fileModifierRegistry.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  fetchSingleFileGitDiff,
  type ToolUseDiff,
} from '../../utils/gitDiff.js'
import {
  formatConcurrentChangeError,
  formatConcurrentMergeNote,
  hasUtf8Bom,
  isCompleteReadSnapshot,
  mergeTextWithPolicy,
  readSnapshotMatchesDisk,
} from '../../utils/concurrentWrite.js'
import { wkLineDelta } from '../../utils/threeWayMerge.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { gitDiffSchema, hunkSchema } from '../FileEditTool/types.js'
import { FILE_WRITE_TOOL_NAME, getWriteToolDescription } from './prompt.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z
      .string()
      .describe(
        'The absolute path to the file to write (must be absolute, not relative)',
      ),
    content: z.string().describe('The content to write to the file'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    type: z
      .enum(['create', 'update'])
      .describe(
        'Whether a new file was created or an existing file was updated',
      ),
    filePath: z.string().describe('The path to the file that was written'),
    content: z.string().describe('The content that was written to the file'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('Diff patch showing the changes'),
    originalFile: z
      .string()
      .nullable()
      .describe(
        'The original file content before the write (null for new files)',
      ),
    gitDiff: gitDiffSchema().optional(),
    concurrentNote: z
      .string()
      .optional()
      .describe('Set when the content was three-way merged with a concurrent disk change'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
export type FileWriteToolInput = InputSchema

export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  searchHint: 'create or overwrite files',
  // Fork: defer core tool — GLM-compatible upstreams drop undiscovered inline
  // core tools; ToolSearch (select:) is the reliable fetch path.
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return 'Write a file to the local filesystem.'
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Writing ${summary}` : 'Writing file'
  },
  async prompt() {
    return getWriteToolDescription()
  },
  renderToolUseMessage,
  isResultTruncated,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    return `${input.file_path}: ${input.content}`
  },
  getPath(input): string {
    return input.file_path
  },
  backfillObservableInput(input) {
    // hooks.mdx documents file_path as absolute; expand so hook allowlists
    // can't be bypassed via ~ or relative paths.
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      FileWriteTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText() {
    // Transcript render shows either content (create, via HighlightedCode)
    // or a structured diff (update). The heuristic's 'content' allowlist key
    // would index the raw content string even in update mode where it's NOT
    // shown — phantom. Under-count: tool_use already indexes file_path.
    return ''
  },
  async validateInput({ file_path, content }, toolUseContext: ToolUseContext) {
    const fullFilePath = expandPath(file_path)

    // Reject writes to team memory files that contain secrets
    const secretError = checkTeamMemSecrets(fullFilePath, content)
    if (secretError) {
      return { result: false, message: secretError, errorCode: 0 }
    }

    // Check if path should be ignored based on permission settings
    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 1,
      }
    }

    // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
    // On Windows, fs.existsSync() on UNC paths triggers SMB authentication which could
    // leak credentials to malicious servers. Let the permission check handle UNC paths.
    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    const fs = getFsImplementation()
    try {
      await fs.stat(fullFilePath)
    } catch (e) {
      if (isENOENT(e)) {
        // 新建文件不需要先 Read；并发判定与合并都在 call 内按磁盘内容做。
        return { result: true }
      }
      throw e
    }

    const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
    if (!readTimestamp || readTimestamp.isPartialView) {
      return {
        result: false,
        message:
          'File has not been read yet. Read it first before writing to it.',
        errorCode: 2,
      }
    }

    // 磁盘是否被并发改动不在这里按 mtime 判死：mtime 会被同步/杀软等无关写入
    // 抬高，且 EOL/BOM/末尾换行差异不算修改。判定统一放 call 的快照比对里。
    return { result: true }
  },
  async call(
    { file_path, content },
    { readFileState, updateFileHistoryState, dynamicSkillDirTriggers },
    _,
    parentMessage,
  ) {
    const fullFilePath = expandPath(file_path)
    const dir = dirname(fullFilePath)

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    const cwd = getCwd()
    const newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
    if (newSkillDirs.length > 0) {
      // Store discovered dirs for attachment display
      for (const dir of newSkillDirs) {
        dynamicSkillDirTriggers?.add(dir)
      }
      // Don't await - let skill loading happen in the background
      addSkillDirectories(newSkillDirs).catch(() => {})
    }

    // Activate conditional skills whose path patterns match this file
    activateConditionalSkillsForPaths([fullFilePath], cwd)

    await diagnosticTracker.beforeFileEdited(fullFilePath)

    // Ensure parent directory exists before the atomic read-modify-write section.
    // Must stay OUTSIDE the critical section below (a yield between the staleness
    // check and writeTextContent lets concurrent edits interleave), and BEFORE the
    // write (lazy-mkdir-on-ENOENT would fire a spurious tengu_atomic_write_error
    // inside writeFileSyncAndFlush_DEPRECATED before ENOENT propagates back).
    await getFsImplementation().mkdir(dir)
    if (fileHistoryEnabled()) {
      // Backup captures pre-edit content — safe to call before the staleness
      // check (idempotent v1 backup keyed on content hash; if staleness fails
      // later we just have an unused backup, not corrupt state).
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        fullFilePath,
        parentMessage.uuid,
      )
    }

    // Load current state and confirm no changes since last read.
    // Please avoid async operations between here and writing to disk to preserve atomicity.
    let meta: ReturnType<typeof readFileSyncWithMetadata> | null
    try {
      meta = readFileSyncWithMetadata(fullFilePath)
    } catch (e) {
      if (isENOENT(e)) {
        meta = null
      } else {
        throw e
      }
    }

    let finalContent = content
    let concurrentNote: string | undefined
    if (meta !== null) {
      const lastRead = readFileState.get(fullFilePath)
      if (!lastRead) {
        throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
      }
      // 行尾/BOM/末尾换行差异不算并发修改；只有内容真变了才走合并。
      if (!readSnapshotMatchesDisk(lastRead.content, meta.content)) {
        const modifier = findFileModifier(fullFilePath, lastRead.timestamp)
        if (!isCompleteReadSnapshot(lastRead)) {
          throw new Error(
            formatConcurrentChangeError({ reason: 'no-merge-base', modifier }),
          )
        }
        const merged = mergeTextWithPolicy({
          base: lastRead.content,
          local: content,
          remote: meta.content,
          encoding: meta.encoding,
        })
        if (!merged.ok) {
          throw new Error(
            formatConcurrentChangeError({
              reason: merged.reason,
              modifier,
              conflictLine:
                merged.reason === 'conflict' ? merged.conflictLine : undefined,
              remoteChanges:
                merged.reason === 'conflict' ? merged.remoteChanges : undefined,
            }),
          )
        }
        finalContent = merged.text
        // Write 是整篇替换：换行风格与 BOM 跟随模型给出的内容。
        if (content.includes('\r\n')) {
          finalContent = finalContent.replaceAll('\n', '\r\n')
        }
        if (hasUtf8Bom(content)) finalContent = '\uFEFF' + finalContent
        concurrentNote = formatConcurrentMergeNote({
          modifier,
          changes: wkLineDelta(lastRead.content, meta.content),
        })
      }
    }

    const enc = meta?.encoding ?? 'utf8'
    const oldContent = meta?.content ?? null

    // Write is a full content replacement — the model sent explicit line endings
    // in `content` and meant them. Do not rewrite them. Previously we preserved
    // the old file's line endings (or sampled the repo via ripgrep for new
    // files), which silently corrupted e.g. bash scripts with \r on Linux when
    // overwriting a CRLF file or when binaries in cwd poisoned the repo sample.
    writeTextContent(fullFilePath, finalContent, enc, 'LF')

    // Notify LSP servers about file modification (didChange) and save (didSave)
    const lspManager = getLspServerManager()
    if (lspManager) {
      // Clear previously delivered diagnostics so new ones will be shown
      clearDeliveredDiagnosticsForFile(`file://${fullFilePath}`)
      // didChange: Content has been modified
      lspManager.changeFile(fullFilePath, finalContent).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file change for ${fullFilePath}: ${err.message}`,
        )
        logError(err)
      })
      // didSave: File has been saved to disk (triggers diagnostics in TypeScript server)
      lspManager.saveFile(fullFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file save for ${fullFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    // Notify VSCode about the file change for diff view
    notifyVscodeFileUpdated(fullFilePath, oldContent, finalContent)

    // Update read timestamp, to invalidate stale writes
    readFileState.set(fullFilePath, {
      content: finalContent,
      timestamp: getFileModificationTime(fullFilePath),
      offset: undefined,
      limit: undefined,
      source: 'tool-write',
    })
    recordFileModifier(fullFilePath)

    // Log when writing to CLAUDE.md
    if (fullFilePath.endsWith(`${sep}CLAUDE.md`)) {
      logEvent('tengu_write_claudemd', {})
    }

    let gitDiff: ToolUseDiff | undefined
    if (
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_quartz_lantern', false)
    ) {
      const startTime = Date.now()
      const diff = await fetchSingleFileGitDiff(fullFilePath)
      if (diff) gitDiff = diff
      logEvent('tengu_tool_use_diff_computed', {
        isWriteTool: true,
        durationMs: Date.now() - startTime,
        hasDiff: !!diff,
      })
    }

    if (oldContent) {
      const patch = getPatchForDisplay({
        filePath: file_path,
        fileContents: oldContent,
        edits: [
          {
            old_string: oldContent,
            new_string: finalContent,
            replace_all: false,
          },
        ],
      })

      const data = {
        type: 'update' as const,
        filePath: file_path,
        content: finalContent,
        structuredPatch: patch,
        originalFile: oldContent,
        ...(gitDiff && { gitDiff }),
        ...(concurrentNote && { concurrentNote }),
      }
      // Track lines added and removed for file updates, right before yielding result
      countLinesChanged(patch)

      logFileOperation({
        operation: 'write',
        tool: 'FileWriteTool',
        filePath: fullFilePath,
        type: 'update',
      })

      return {
        data,
      }
    }

    const data = {
      type: 'create' as const,
      filePath: file_path,
      content: finalContent,
      structuredPatch: [],
      originalFile: null,
      ...(gitDiff && { gitDiff }),
      ...(concurrentNote && { concurrentNote }),
    }

    // For creation of new files, count all lines as additions, right before yielding the result
    countLinesChanged([], finalContent)

    logFileOperation({
      operation: 'write',
      tool: 'FileWriteTool',
      filePath: fullFilePath,
      type: 'create',
    })

    return {
      data,
    }
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID) {
    const { filePath, type, content, structuredPatch, concurrentNote } = data
    const note = concurrentNote ? ` ${concurrentNote}.` : ''
    switch (type) {
      case 'create': {
        // 新文件：全行算新增
        const { added } = sumLinesChanged([], content)
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `File created successfully at: ${filePath} (+${added} -0).${note}`,
        }
      }
      case 'update': {
        // 真实增删行数（结构化 patch 统计），供遥测端「N 个文件已更改 +N -N」汇总卡片展示
        const { added, removed } = sumLinesChanged(structuredPatch)
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `The file ${filePath} has been updated successfully (+${added} -${removed}).${note}`,
        }
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
