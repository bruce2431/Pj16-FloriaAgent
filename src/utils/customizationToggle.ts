/**
 * 插件/技能启停的目录内标记（2026-11-07 用户定案）。
 *
 * 判据唯一：自定义件目录（`.claude/plugins/<name>/`、`.claude/skills/<name>/`）内存在
 * `.disabled` 文件 = 停用，扫描时整条不加载；不存在 = 启用（默认态，向后兼容）。
 * 状态随目录走——不写 settings.json、不改 plugin.json / SKILL.md（前者是插件厂家的清单，
 * 后者是用户手写内容，web 改写会覆盖人工修订）。
 *
 * 消费点：
 *  - loadSkillsFromSkillsDir（skills）：目录层跳过，用户/项目/附加目录同一判据。
 *  - loadSkillsDirPlugins（plugins）：enabled 传 false → 命令/技能/agents/hooks/MCP 全不进 enabled 集。
 *  - localGateway 的 GET /gateway/plugins（en 字段）与 POST /gateway/plugins/enable（落/删标记）。
 *  - skillChangeDetector：标记文件变更触发会话内重载（热生效）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 停用标记文件名（放在自定义件目录根部）。 */
export const CUSTOMIZATION_DISABLED_MARKER = '.disabled'

/** 目录是否处于启用态（无停用标记）。 */
export function isCustomizationDirEnabled(dir: string): boolean {
  return !existsSync(join(dir, CUSTOMIZATION_DISABLED_MARKER))
}

/** 停用标记路径。 */
export function customizationDisabledMarkerPath(dir: string): string {
  return join(dir, CUSTOMIZATION_DISABLED_MARKER)
}
