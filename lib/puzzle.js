/**
 * dsh-puzzle-mode —— 纯逻辑层（无 Cordis 依赖，可单独 import）。
 *
 * v0.11.0 起本文件是 **barrel**：真正的实现按职责拆在同目录下的
 *   constants / util / docfs / frontmatter / entries / health /
 *   source / migrate / templates / project / summary / dispatch
 * 里，这里只做 re-export，保证 `./puzzle.js` 这个入口不变。
 *
 * ⚠️ v2.1.1 起 **`audit.js` 已整体删除**（用户裁定「审查的 UI 和关于他的代码全删」）：
 * 审查能力（`op:audit`、`AUDIT_PROMPT`、`fixPlan`、`findings`、五维真实值）全部移除。
 * 它里面两个**与审查无关**的纯函数搬去了 `health.js`：
 * `sectionCounts`（主文档各节条数）与 `dimensionRanking`（五维升序）。
 *
 * 依赖是单向的（按下面 import 顺序）：constants → util → docfs →
 * frontmatter → entries → health → source → migrate →
 * templates → project → summary。新代码请放进对应文件，别塞回这里。
 */
export { PUZZLE_DIR, MAIN_FILE, MODULE_DIR, MODE_PUZZLE_ONLY, MODE_PUZZLE_AFTER, MODE_PUZZLE_WRITE, MODES, EXECUTABLE_MODES, DEFAULT_MODE, MODE_RENAME_VERSION, normalizeMode, PAUSE_QUESTION, PAUSE_OPTIONS, ASK_MAX_QUESTIONS, ASK_MAX_OPTIONS, SESSION_FIELD, CURRENT_SESSION_FIELD, BINDING_WARN_THRESHOLD, SOURCE_ROOT_FIELD, PUZZLE_VERSION, PROGRESS_TO_HEALTH, PUZZLE_ONLY_ALLOWED_TOOLS, HEALTH_HEADING, SECTION_ORDER, SECTION_HEADINGS, RELATED_HEADING, MODULE_SECTION_KEYS, MODULE_SECTION_HEADINGS, MODULE_SECTION_ORDER, ENTRY_LIMITS, ENTRY_CAPS, PANEL_LIMITS, SOURCE_MARK, SIZE_SMALL, SIZE_MEDIUM, SIZE_LARGE, SIZES, DEFAULT_SIZE, SIZE_FIELD, SIZE_CAPS, SIZE_ENTRY_LIMITS, normalizeSize, capsOfSize, limitsOfSize, limitsFor } from './constants.js'
export { slugify, defaultProjectName, timestamp, isDir, isSkippableDirName, makeContextMessage } from './util.js'
export { safeJoin, projectFolderOf, puzzleDirOf, isPuzzleDocPath, DOC_MUTATING_TOOLS, docMutationTarget, atomicWrite, readText, readTextCached, invalidateTextCache } from './docfs.js'
export { formatFrontMatter, parseFrontMatter, parseSourceRoot, getSection, withSection, applySection, docVersion, headingMatches, extraSectionsIn, PREAMBLE_LINES, OLD_PREAMBLE_LINES } from './frontmatter.js'
export { entryBody, charCount, checkEntry, normalizeEntries, entryIssuesIn, MAIN_ENTRY_SPEC, citedSourceFiles, measureWithoutMethod, conflictDigest, mainEntrySpecOf, moduleEntrySpecOf } from './entries.js'
export { HEALTH_DIMENSIONS, HEALTH_KEYS, healthLines, healthTemplateLines, parseHealthDeclarations, healthOf, projectHealthOf, dimensionAverages, dimensionRanking, sectionCounts } from './health.js'
export { SOURCE_RULES, collectSourceFiles, longestFunction, longFunctionsIn, isFunctionStart, inspectSource } from './source.js'
export { pendingMigrations, planRebuild, rebuildProject } from './migrate.js'
export { mainTemplate, moduleTemplate } from './templates.js'
export { listProjects, scanUnpuzzled, projectSummaries, readState, readModuleDetail, readMainDoc, modeOfFields, passThroughFields, setMainFields, boundProject, boundProjects, openProjectIn, setOpenProjectIn, locate, readProjectMode, createProject, updateMainSection, updateModuleSection, updateProjectHealth, setMode, setSourceRoot, sizeOfProject, setSize } from './project.js'
export { dimensionMeta, summarize, summarizeList, receipt, isExecutableMode, pauseFields } from './summary.js'
export { BOARD_COLUMNS, COLUMN_LABELS, LEFT_MOVES, FORBIDDEN_JUMPS, BOARD_FILE, BOARD_DIR, BLOCKED_CODES, DECOMPOSE_SYSTEM, moveVerdict, emptyCard, boardPath, boardDirPath, cardPath, cardFile, readBoard, writeBoard, readCard, writeCard, removeCard, migrateBoard, nextCardId, pushHistory, verdictOf, firstPromptOf, freezeCheck, freezeCard, groupByColumn, shortTitle, parseDecompose, DEFAULT_MAX_GOAL_ROUNDS, CLARIFIER_MAX_ROUNDS, STALL_MS, dispatchVerdict, clarifyVerdict, goalRequestOf, observeOf, CLARIFIER_SYSTEM, clarifierPromptOf } from './dispatch.js'
export { SETTINGS_FILE, MAX_DISABLED_SESSIONS, MAX_WIRED_SESSIONS, ASK_PAUSE_DEFAULT, CODE_WORKSPACE_MODES, DEFAULT_CODE_WORKSPACE_MODE, DISPATCH_MODEL_SLOTS, settingsDir, settingsPath, readSettings, patchSettings, isSessionDisabled, isSessionWired, markWired, isAskPauseEnabled, setAskPause, disableSession, enableSession, setWorkspaceBinding, dataWorkspaceRoot, openProjectOf, setOpenProject, setCodeWorkspace, setDispatchModel, brainSessionOf, setBrainSession, forgetBrainSession } from './settings.js'
export { SCOPED_TOOL_NAMES, ORIGINAL_TOOL_NAMES, PZ_READ_MAX_LINES, PZ_LINE_MAX, PZ_GREP_MAX_HITS, PZ_GLOB_MAX_HITS, visibleOriginalsOf, pathOfScopedCall, outsideWorkspaceOf, outsideNotice, globToRegExp, installScopedTools } from './scopedtools.js'
export { CLARIFIER_TOOL_NAME, CLARIFIER_SECTION_NAME, CLARIFIER_SECTION_ORDER, LOOKUP_MAX_HITS, LOOKUP_LINE_MAX, LOOKUP_MAX_NAMES, LOOKUP_MAX_QUERIES, LOOKUP_MAX_DOC_CHARS, LOOKUP_MAX_TOTAL_HITS, clarifierLookup, installClarifier } from './clarifier.js'
/**
 * `docio.js` 只导出**入口** `planWrites` / `describePlan`。
 *
 * ⚠️ **刻意不导出 `renderGroup`**：它要的是「待渲染的 write 记录」（带 `normalized` /
 * `append`），而 `planWrites` 返回的 groups 里 `writes` 是**输出记录**
 * （`{section, entries, dropped}`）。把 `planWrites` 的 group 再喂给它，
 * 会把 `undefined` 当正文写进去——**文档被清空**，且不报错。
 * 对外只有一条路：`planWrites` → 落 `group.next`。
 */
export { DOCIO_MAX_WRITES, planWrites, describePlan } from './docio.js'
export { goalMoveOf, movedCardOf, reportTextOf, applyGoalChange } from './completion.js'
export { BRAIN_SYSTEM, BRAIN_SECTION_NAME, BRAIN_SECTION_ORDER, BRAIN_CONTEXT_SECTION_NAME, BRAIN_CONTEXT_SECTION_ORDER, BRAIN_TOOL_NAME, TASK_TOOL_NAME, brainDocHolder, noteBrainHolder, isBrainSession, refreshBrainDoc, brainDocOf, forgetBrainHolder, brainDocText, taskReports, brainPromptOf, installBrain, installTaskWriter } from './brain.js'
export { THEME_API_VERSION, DEFAULT_THEME_REPO, DEFAULT_THEME_BRANCH, MAX_THEME_BYTES, MAX_INDEX_BYTES, THEME_ID_RE, THEME_CHANNELS, themesDir, themesStatePath, themeCssPath, readThemeState, setThemeRepo, themeChannelsFor, fetchThemeFile, sha256Hex, validateThemeCss, validateThemeIndex, listThemes, installTheme, applyTheme, resetTheme, uninstallTheme, loadThemeCss, themeOverview, themeFilesOnDisk } from './themes.js'
export { UPDATE_REPO, UPDATE_PACKAGE_NAME, UPDATE_FETCH_TIMEOUT_MS, UPDATE_DOWNLOAD_TIMEOUT_MS, MAX_TARBALL_BYTES, UPDATE_DIR_NAME, UPDATE_STATE_NEWER, UPDATE_STATE_LATEST, UPDATE_STATE_AHEAD, UPDATE_INFO_CHANNELS, ASSET_CHANNELS, jsdelivrUrl, updatesDir, stagedDirOf, stagedTarballPath, normalizeVersion, compareVersions, isNewerVersion, sha256FromNotes, releaseInfoOf, changelogSectionOf, parseTar, isSafeTarPath, extractTarball, sha256OfBytes, checkUpdate, downloadUpdate, profileDirOf, installCommandOf, stagedVersions, pluginVersion, localVersion, installedVersionOf, resolveTagSha, RELEASE_LIST_LIMIT, RELEASE_SUMMARY_LINES, SUMMARY_HEADING, summarySectionOf, RELEASE_LIST_CHANNELS, summarizeNotes, releaseListOf, fetchReleaseList, UPDATER_SCRIPT, updaterScriptPath, updateResultPath, updaterSourcePath, stageUpdaterScript, updaterArgsOf, spawnUpdater, readUpdateRun, listBackups } from './updater.js'
export { toolArgs, stringField, docTargetOf } from './toolargs.js'
export { LOG_FILE, MAX_LOG_BYTES, logPath, logFailure } from './plog.js'
export { THEME_PACK_VERSION, THEME_PACK_EXT, MAX_PACK_BYTES, THEME_REPO_DIRNAME, GIT_TIMEOUT_MS, THEME_TOKENS, themeIdOf, manifestTemplate, cssTemplate, themeDevPrompt, createThemeScaffold, rebuildThemeIndex, validateThemePack, exportThemePack, importThemePack, installThemePack, isThemeRepo, findThemeRepo, gitRun, parseGitStatus, uploadTheme, themePackDir, writeThemePack, listThemePacks, themeRepoStatus, repoThermIds, readRepoTheme, writeRepoTheme } from './themedev.js'
