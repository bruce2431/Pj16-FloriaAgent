import { useCallback, useEffect } from 'react'
import type { Command } from '../commands.js'
import {
  clearCommandMemoizationCaches,
  clearCommandsCache,
  getCommands,
} from '../commands.js'
import { onGrowthBookRefresh } from '../services/analytics/growthbook.js'
import { logError } from '../utils/log.js'
import { refreshActivePlugins } from '../utils/plugins/refresh.js'
import {
  skillChangeDetector,
  type SkillsChangeEvent,
} from '../utils/skills/skillChangeDetector.js'

/**
 * Keep the commands list fresh across two triggers:
 *
 * 1. Skill file changes (watcher) — full cache clear + disk re-scan, since
 *    skill content changed on disk.
 * 2. GrowthBook init/refresh — memo-only clear, since only `isEnabled()`
 *    predicates may have changed. Handles commands like /btw whose gate
 *    reads a flag that isn't in the disk cache yet on first session after
 *    a flag rename: getCommands() runs before GB init (main.tsx:2855 vs
 *    showSetupScreens at :3106), so the memoized list is baked with the
 *    default. Once init populates remoteEvalFeatureValues, re-filter.
 */
export function useSkillsChange(
  cwd: string | undefined,
  onCommandsChange: (commands: Command[]) => void,
  setAppState?: Parameters<typeof refreshActivePlugins>[0],
): void {
  const handleChange = useCallback(
    async (event?: SkillsChangeEvent) => {
      if (!cwd) return
      try {
        // 插件启停标记变化 = 插件集合身份变化（命令/技能/agents/hooks/MCP 全受影响）：
        // 走与 /reload-plugins 同一条全量刷新（refreshActivePlugins 内部也清全部缓存）。
        if (event?.pluginChanged && setAppState) {
          await refreshActivePlugins(setAppState)
        } else {
          clearCommandsCache()
        }
        const commands = await getCommands(cwd)
        onCommandsChange(commands)
      } catch (error) {
        // Errors during reload are non-fatal - log and continue
        if (error instanceof Error) {
          logError(error)
        }
      }
    },
    [cwd, onCommandsChange, setAppState],
  )

  useEffect(() => skillChangeDetector.subscribe(handleChange), [handleChange])

  const handleGrowthBookRefresh = useCallback(async () => {
    if (!cwd) return
    try {
      clearCommandMemoizationCaches()
      const commands = await getCommands(cwd)
      onCommandsChange(commands)
    } catch (error) {
      if (error instanceof Error) {
        logError(error)
      }
    }
  }, [cwd, onCommandsChange])

  useEffect(
    () => onGrowthBookRefresh(handleGrowthBookRefresh),
    [handleGrowthBookRefresh],
  )
}
