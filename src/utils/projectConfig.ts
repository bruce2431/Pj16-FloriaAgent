import { join } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'

/**
 * Project-scoped session-runtime directory: <projectRoot>/.claude/<subdir>.
 *
 * Analog of getProjectDir (sessions) and getProjectDirsUpToHome (skills) for
 * the session-runtime data directories (file-history, paste-cache, plans,
 * sessions, shell-snapshots, tasks, backups). Anchored on getProjectRoot() —
 * the stable session project root — so these follow the project (e.g. running
 * <Pj1>\cli-dev.exe from Pj1 resolves to <Pj1>\.claude\file-history), fully
 * independent of where getClaudeConfigHomeDir resolves.
 *
 * Cross-project lookup is intentionally NOT performed: each project exe only
 * reads/writes its own project's data. Pass `cwd`-independent — this is
 * project identity, not a per-cwd file operation.
 */
export function getProjectRuntimeDir(
  subdir: string,
  projectRoot: string = getProjectRoot(),
): string {
  return join(projectRoot, '.claude', subdir)
}
