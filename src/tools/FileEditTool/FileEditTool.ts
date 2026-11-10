import { dirname, isAbsolute, sep } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
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
  findFileModifier,
  recordFileModifier,
} from '../../utils/fileModifierRegistry.js'
import {
  formatConcurrentChangeError,
  formatConcurrentMergeNote,
  hasUtf8Bom,
  isCompleteReadSnapshot,
  mergeTextWithPolicy,
  readSnapshotMatchesDisk,
} from '../../utils/concurrentWrite.js'
import { wkLineDelta } from '../../utils/threeWayMerge.js'
import {
  countLinesChanged,
  getPatchForDisplay,
  sumLinesChanged,
} from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTime,
  suggestPathUnderCwd,
  writeTextContent,
} from '../../utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import {
  type LineEndingType,
  readFileSyncWithMetadata,
} from '../../utils/fileRead.js'
import { formatFileSize } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  fetchSingleFileGitDiff,
  type ToolUseDiff,
} from '../../utils/gitDiff.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'
import {
  FILE_EDIT_TOOL_NAME,
  FILE_UNEXPECTEDLY_MODIFIED_ERROR,
} from './constants.js'
import { getEditToolDescription } from './prompt.js'
import {
  type FileEditInput,
  type FileEditOutput,
  inputSchema,
  outputSchema,
} from './types.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'
import {
  areFileEditsInputsEquivalent,
  findActualString,
  getPatchForEdit,
  preserveQuoteStyle,
} from './utils.js'

// V8/Bun string length limit is ~2^30 characters (~1 billion). For typical
// ASCII/Latin-1 files, 1 byte on disk = 1 character, so 1 GiB in stat bytes
// ≈ 1 billion characters ≈ the runtime string limit. Multi-byte UTF-8 files
// can be larger on disk per character, but 1 GiB is a safe byte-level guard
// that prevents OOM without being unnecessarily restrictive.
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB (stat bytes)

export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  searchHint: 'modify file contents in place',
  // Fork: defer core tool — GLM-compatible upstreams drop undiscovered inline
  // core tools; ToolSearch (select:) is the reliable fetch path.
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return 'A tool for editing files'
  },
  async prompt() {
    return getEditToolDescription()
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Editing ${summary}` : 'Editing file'
  },
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    return `${input.file_path}: ${input.new_string}`
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
      FileEditTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  async validateInput(input: FileEditInput, toolUseContext: ToolUseContext) {
    const { file_path, old_string, new_string, replace_all = false } = input
    // Use expandPath for consistent path normalization (especially on Windows
    // where "/" vs "\" can cause readFileState lookup mismatches)
    const fullFilePath = expandPath(file_path)

    // Reject edits to team memory files that introduce secrets
    const secretError = checkTeamMemSecrets(fullFilePath, new_string)
    if (secretError) {
      return { result: false, message: secretError, errorCode: 0 }
    }
    if (old_string === new_string) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'No changes to make: old_string and new_string are exactly the same.',
        errorCode: 1,
      }
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
        behavior: 'ask',
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 2,
      }
    }

    // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
    // On Windows, fs.existsSync() on UNC paths triggers SMB authentication which could
    // leak credentials to malicious servers. Let the permission check handle UNC paths.
    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    const fs = getFsImplementation()

    // Prevent OOM on multi-GB files.
    try {
      const { size } = await fs.stat(fullFilePath)
      if (size > MAX_EDIT_FILE_SIZE) {
        return {
          result: false,
          behavior: 'ask',
          message: `File is too large to edit (${formatFileSize(size)}). Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`,
          errorCode: 10,
        }
      }
    } catch (e) {
      if (!isENOENT(e)) {
        throw e
      }
    }

    // Read the file as bytes first so we can detect encoding from the buffer
    // instead of calling detectFileEncoding (which does its own sync readSync
    // and would fail with a wasted ENOENT when the file doesn't exist).
    let fileContent: string | null
    try {
      const fileBuffer = await fs.readFileBytes(fullFilePath)
      const encoding: BufferEncoding =
        fileBuffer.length >= 2 &&
        fileBuffer[0] === 0xff &&
        fileBuffer[1] === 0xfe
          ? 'utf16le'
          : 'utf8'
      fileContent = fileBuffer.toString(encoding).replaceAll('\r\n', '\n')
    } catch (e) {
      if (isENOENT(e)) {
        fileContent = null
      } else {
        throw e
      }
    }

    // File doesn't exist
    if (fileContent === null) {
      // Empty old_string on nonexistent file means new file creation — valid
      if (old_string === '') {
        return { result: true }
      }
      // Try to find a similar file with a different extension
      const similarFilename = findSimilarFile(fullFilePath)
      const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
      let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`

      if (cwdSuggestion) {
        message += ` Did you mean ${cwdSuggestion}?`
      } else if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }

      return {
        result: false,
        behavior: 'ask',
        message,
        errorCode: 4,
      }
    }

    // File exists with empty old_string — only valid if file is empty
    if (old_string === '') {
      // Only reject if the file has content (for file creation attempt)
      if (fileContent.trim() !== '') {
        return {
          result: false,
          behavior: 'ask',
          message: 'Cannot create new file - file already exists.',
          errorCode: 3,
        }
      }

      // Empty file with empty old_string is valid - we're replacing empty with content
      return {
        result: true,
      }
    }

    if (fullFilePath.endsWith('.ipynb')) {
      return {
        result: false,
        behavior: 'ask',
        message: `File is a Jupyter Notebook. Use the ${NOTEBOOK_EDIT_TOOL_NAME} to edit this file.`,
        errorCode: 5,
      }
    }

    const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
    if (!readTimestamp || readTimestamp.isPartialView) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'File has not been read yet. Read it first before writing to it.',
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
        errorCode: 6,
      }
    }

    const file = fileContent
    const diskChanged = !readSnapshotMatchesDisk(readTimestamp.content, file)
    const actualOldString = findActualString(file, old_string)

    if (!diskChanged) {
      // 磁盘与读快照一致：沿用原有的存在性/唯一性/设置文件校验。
      if (!actualOldString) {
        return {
          result: false,
          behavior: 'ask',
          message: `String to replace not found in file.\nString: ${old_string}`,
          meta: {
            isFilePathAbsolute: String(isAbsolute(file_path)),
          },
          errorCode: 8,
        }
      }

      const matches = file.split(actualOldString).length - 1

      if (matches > 1 && !replace_all) {
        return {
          result: false,
          behavior: 'ask',
          message: `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
          meta: {
            isFilePathAbsolute: String(isAbsolute(file_path)),
            actualOldString,
          },
          errorCode: 9,
        }
      }

      // Additional validation for Claude settings files
      const settingsValidationResult = validateInputForSettingsFileEdit(
        fullFilePath,
        file,
        () => {
          // Simulate the edit to get the final content using the exact same logic as the tool
          return replace_all
            ? file.replaceAll(actualOldString, new_string)
            : file.replace(actualOldString, new_string)
        },
      )

      if (settingsValidationResult !== null) {
        return settingsValidationResult
      }
    }

    // 磁盘已被并发改动：old_string 可能被改掉或数量变化，这里不判死。
    // call 先在当前磁盘上重放意图，不行再做三方合并；设置文件校验也在 call 内对最终内容重做。
    return {
      result: true,
      meta: { actualOldString: actualOldString ?? old_string },
    }
  },
  inputsEquivalent(input1, input2) {
    return areFileEditsInputsEquivalent(
      {
        file_path: input1.file_path,
        edits: [
          {
            old_string: input1.old_string,
            new_string: input1.new_string,
            replace_all: input1.replace_all ?? false,
          },
        ],
      },
      {
        file_path: input2.file_path,
        edits: [
          {
            old_string: input2.old_string,
            new_string: input2.new_string,
            replace_all: input2.replace_all ?? false,
          },
        ],
      },
    )
  },
  async call(
    input: FileEditInput,
    {
      readFileState,
      userModified,
      updateFileHistoryState,
      dynamicSkillDirTriggers,
    },
    _,
    parentMessage,
  ) {
    const { file_path, old_string, new_string, replace_all = false } = input

    // 1. Get current state
    const fs = getFsImplementation()
    const absoluteFilePath = expandPath(file_path)

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    // Skip in simple mode - no skills available
    const cwd = getCwd()
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths(
        [absoluteFilePath],
        cwd,
      )
      if (newSkillDirs.length > 0) {
        // Store discovered dirs for attachment display
        for (const dir of newSkillDirs) {
          dynamicSkillDirTriggers?.add(dir)
        }
        // Don't await - let skill loading happen in the background
        addSkillDirectories(newSkillDirs).catch(() => {})
      }

      // Activate conditional skills whose path patterns match this file
      activateConditionalSkillsForPaths([absoluteFilePath], cwd)
    }

    await diagnosticTracker.beforeFileEdited(absoluteFilePath)

    // Ensure parent directory exists before the atomic read-modify-write section.
    // These awaits must stay OUTSIDE the critical section below — a yield between
    // the staleness check and writeTextContent lets concurrent edits interleave.
    await fs.mkdir(dirname(absoluteFilePath))
    if (fileHistoryEnabled()) {
      // Backup captures pre-edit content — safe to call before the staleness
      // check (idempotent v1 backup keyed on content hash; if staleness fails
      // later we just have an unused backup, not corrupt state).
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        absoluteFilePath,
        parentMessage.uuid,
      )
    }

    // 2. Load current state and compare against the read snapshot.
    // 读盘→合并→写盘之间不插 await；外部进程仍可能在窗口内写入（残余竞态，见 docs/core.md）。
    const {
      content: diskContent,
      fileExists,
      encoding,
      lineEndings: endings,
    } = readFileForEdit(absoluteFilePath)

    const lastRead = readFileState.get(absoluteFilePath)
    const diskChanged =
      fileExists &&
      (!lastRead || !readSnapshotMatchesDisk(lastRead.content, diskContent))

    let patch: ReturnType<typeof getPatchForEdit>['patch']
    let finalContent: string
    let concurrentNote: string | undefined

    if (!diskChanged) {
      // 3. Use findActualString to handle quote normalization
      const actualOldString =
        findActualString(diskContent, old_string) || old_string

      // Preserve curly quotes in new_string when the file uses them
      const actualNewString = preserveQuoteStyle(
        old_string,
        actualOldString,
        new_string,
      )

      // 4. Generate patch
      const result = getPatchForEdit({
        filePath: absoluteFilePath,
        fileContents: diskContent,
        oldString: actualOldString,
        newString: actualNewString,
        replaceAll: replace_all,
      })
      patch = result.patch
      finalContent = result.updatedFile
    } else {
      if (!lastRead) {
        throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
      }
      const modifier = findFileModifier(absoluteFilePath, lastRead.timestamp)

      // 3a. 意图重放：改动位置在磁盘上仍可唯一确定 → 直接落到当前磁盘。
      const replayed = replayEditOnDisk({
        diskContent,
        baseContent: lastRead.content,
        oldString: old_string,
        newString: new_string,
        replaceAll: replace_all,
      })
      if (replayed) {
        finalContent = replayed.text
        concurrentNote = `replayed (${replayed.replacements} replacement${replayed.replacements === 1 ? '' : 's'})`
      } else {
        // 3b. 三方合并：base = 读快照，local = 意图应用到 base，remote = 当前磁盘。
        if (!isCompleteReadSnapshot(lastRead)) {
          throw new Error(
            formatConcurrentChangeError({ reason: 'no-merge-base', modifier }),
          )
        }
        const baseOldString =
          findActualString(lastRead.content, old_string) || old_string
        const baseNewString = preserveQuoteStyle(
          old_string,
          baseOldString,
          new_string,
        )
        const { updatedFile: local } = getPatchForEdit({
          filePath: absoluteFilePath,
          fileContents: lastRead.content,
          oldString: baseOldString,
          newString: baseNewString,
          replaceAll: replace_all,
        })
        const merged = mergeTextWithPolicy({
          base: lastRead.content,
          local,
          remote: diskContent,
          encoding,
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
        // 合并结果按磁盘 BOM 还原；EOL 由 writeTextContent 按 endings 还原。
        finalContent = (hasUtf8Bom(diskContent) ? '\uFEFF' : '') + merged.text
        concurrentNote = formatConcurrentMergeNote({
          modifier,
          changes: wkLineDelta(lastRead.content, diskContent),
        })
      }

      patch = getPatchForDisplay({
        filePath: absoluteFilePath,
        fileContents: diskContent,
        edits: [
          {
            old_string: diskContent,
            new_string: finalContent,
            replace_all: false,
          },
        ],
      })

      // 合并/重放结果必须重新过 settings schema 校验（validateInput 校验的是磁盘原文上的模拟）。
      const settingsValidationResult = validateInputForSettingsFileEdit(
        absoluteFilePath,
        diskContent,
        () => finalContent,
      )
      if (settingsValidationResult !== null) {
        throw new Error(settingsValidationResult.message)
      }
    }

    // 5. Write to disk
    writeTextContent(absoluteFilePath, finalContent, encoding, endings)

    // Notify LSP servers about file modification (didChange) and save (didSave)
    const lspManager = getLspServerManager()
    if (lspManager) {
      // Clear previously delivered diagnostics so new ones will be shown
      clearDeliveredDiagnosticsForFile(`file://${absoluteFilePath}`)
      // didChange: Content has been modified
      lspManager
        .changeFile(absoluteFilePath, finalContent)
        .catch((err: Error) => {
          logForDebugging(
            `LSP: Failed to notify server of file change for ${absoluteFilePath}: ${err.message}`,
          )
          logError(err)
        })
      // didSave: File has been saved to disk (triggers diagnostics in TypeScript server)
      lspManager.saveFile(absoluteFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file save for ${absoluteFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    // Notify VSCode about the file change for diff view
    notifyVscodeFileUpdated(absoluteFilePath, diskContent, finalContent)

    // 6. Update read timestamp, to invalidate stale writes
    readFileState.set(absoluteFilePath, {
      content: finalContent,
      timestamp: getFileModificationTime(absoluteFilePath),
      offset: undefined,
      limit: undefined,
      source: 'tool-write',
    })
    recordFileModifier(absoluteFilePath)

    // 7. Log events
    if (absoluteFilePath.endsWith(`${sep}CLAUDE.md`)) {
      logEvent('tengu_write_claudemd', {})
    }
    countLinesChanged(patch)

    logFileOperation({
      operation: 'edit',
      tool: 'FileEditTool',
      filePath: absoluteFilePath,
    })

    logEvent('tengu_edit_string_lengths', {
      oldStringBytes: Buffer.byteLength(old_string, 'utf8'),
      newStringBytes: Buffer.byteLength(new_string, 'utf8'),
      replaceAll: replace_all,
    })

    let gitDiff: ToolUseDiff | undefined
    if (
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_quartz_lantern', false)
    ) {
      const startTime = Date.now()
      const diff = await fetchSingleFileGitDiff(absoluteFilePath)
      if (diff) gitDiff = diff
      logEvent('tengu_tool_use_diff_computed', {
        isEditTool: true,
        durationMs: Date.now() - startTime,
        hasDiff: !!diff,
      })
    }

    // 8. Yield result
    const data = {
      filePath: file_path,
      oldString: findActualString(diskContent, old_string) || old_string,
      newString: new_string,
      originalFile: diskContent,
      structuredPatch: patch,
      userModified: userModified ?? false,
      replaceAll: replace_all,
      ...(gitDiff && { gitDiff }),
      ...(concurrentNote && { concurrentNote }),
    }
    return {
      data,
    }
  },
  mapToolResultToToolResultBlockParam(data: FileEditOutput, toolUseID) {
    const { filePath, userModified, replaceAll, structuredPatch } = data
    const modifiedNote = userModified
      ? '.  The user modified your proposed changes before accepting them. '
      : ''
    const concurrentSuffix = data.concurrentNote
      ? ` ${data.concurrentNote}.`
      : ''

    // 真实增删行数（结构化 patch 统计），供遥测端「N 个文件已更改 +N -N」汇总卡片展示
    const { added, removed } = sumLinesChanged(structuredPatch)
    const changeSuffix = ` (+${added} -${removed})`

    if (replaceAll) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `The file ${filePath} has been updated${modifiedNote}. All occurrences were successfully replaced${changeSuffix}.${concurrentSuffix}`,
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `The file ${filePath} has been updated successfully${modifiedNote}${changeSuffix}.${concurrentSuffix}`,
    }
  },
} satisfies ToolDef<ReturnType<typeof inputSchema>, FileEditOutput>)

// --

function readFileForEdit(absoluteFilePath: string): {
  content: string
  fileExists: boolean
  encoding: BufferEncoding
  lineEndings: LineEndingType
} {
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    const meta = readFileSyncWithMetadata(absoluteFilePath)
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
    }
  } catch (e) {
    if (isENOENT(e)) {
      return {
        content: '',
        fileExists: false,
        encoding: 'utf8',
        lineEndings: 'LF',
      }
    }
    throw e
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  return haystack.split(needle).length - 1
}

/**
 * 把「读快照上的意图」重放到当前磁盘。命中位置/数量无法唯一确定时返回 null，
 * 交给三方合并处理。
 * - 单次替换：磁盘命中必须恰为 1（沿用原唯一性约束）。
 * - replace_all：磁盘命中数必须与 base 命中数一致，防止连带改掉用户新加的同名片段。
 */
function replayEditOnDisk(args: {
  diskContent: string
  baseContent: string
  oldString: string
  newString: string
  replaceAll: boolean
}): { text: string; replacements: number } | null {
  const diskOld = findActualString(args.diskContent, args.oldString)
  if (!diskOld) return null
  const diskCount = countOccurrences(args.diskContent, diskOld)
  if (diskCount === 0) return null

  if (!args.replaceAll) {
    if (diskCount !== 1) return null
  } else {
    const baseOld =
      findActualString(args.baseContent, args.oldString) || args.oldString
    const baseCount = countOccurrences(args.baseContent, baseOld)
    if (baseCount === 0 || diskCount !== baseCount) return null
  }

  const diskNew = preserveQuoteStyle(
    args.oldString,
    diskOld,
    args.newString,
  )
  const text = args.replaceAll
    ? args.diskContent.split(diskOld).join(diskNew)
    : args.diskContent.replace(diskOld, () => diskNew)
  if (text === args.diskContent) return null
  return {
    text,
    replacements: args.replaceAll ? diskCount : 1,
  }
}
