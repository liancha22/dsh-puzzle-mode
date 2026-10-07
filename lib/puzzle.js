/**
 * dsh-puzzle-mode —— 纯逻辑层（无 Cordis 依赖，可单独 import）。
 *
 * v0.11.0 起本文件是 **barrel**：真正的实现按职责拆在同目录下的
 *   constants / util / docfs / frontmatter / entries / health /
 *   audit / source / migrate / templates / project / summary
 * 里，这里只做 re-export，保证 `./puzzle.js` 这个入口不变。
 *
 * 依赖是单向的（按下面 import 顺序）：constants → util → docfs →
 * frontmatter → entries → health → audit → source → migrate →
 * templates → project → summary。新代码请放进对应文件，别塞回这里。
 */
export { PUZZLE_DIR, MAIN_FILE, MODULE_DIR, MODE_PUZZLE_ONLY, MODE_PUZZLE_AFTER, MODE_PUZZLE_WRITE, MODES, EXECUTABLE_MODES, DEFAULT_MODE, MODE_RENAME_VERSION, normalizeMode, PAUSE_QUESTION, PAUSE_OPTIONS, ASK_MAX_QUESTIONS, ASK_MAX_OPTIONS, SESSION_FIELD, CURRENT_SESSION_FIELD, BINDING_WARN_THRESHOLD, SOURCE_ROOT_FIELD, WORKFLOW_ARCHIVE_FIELD, PUZZLE_VERSION, CURRENT_SESSION_VERSION, PROGRESS_TO_HEALTH, PUZZLE_ONLY_ALLOWED_TOOLS, HEALTH_HEADING, SECTION_ORDER, SECTION_HEADINGS, RELATED_HEADING, MODULE_SECTION_KEYS, MODULE_SECTION_HEADINGS, MODULE_SECTION_ORDER, ENTRY_LIMITS, ENTRY_CAPS, PANEL_LIMITS, WORKFLOW_ARCHIVE_CAP, WORKFLOW_NAME_LIMIT, WORKFLOW_STEP_LIMIT, WORKFLOW_MAX_STEPS, SOURCE_MARK, PIECE_MAX, SIZE_SMALL, SIZE_MEDIUM, SIZE_LARGE, SIZES, DEFAULT_SIZE, SIZE_FIELD, SIZE_CAPS, SIZE_ENTRY_LIMITS, normalizeSize, capsOfSize, limitsOfSize, limitsFor } from './constants.js'
export { slugify, defaultProjectName, timestamp, isDir, isSkippableDirName } from './util.js'
export { safeJoin, puzzleDirOf, isPuzzleDocPath, DOC_MUTATING_TOOLS, docMutationTarget, atomicWrite, readText, readTextCached, invalidateTextCache } from './docfs.js'
export { formatFrontMatter, parseFrontMatter, parseSessionList, parseCurrentSessionList, parseSourceRoot, parseWorkflowArchive, normalizeArchive, getSection, sectionMap, withSection, applySection, docVersion, headingMatches, extraSectionsIn, PREAMBLE_LINES, OLD_PREAMBLE_LINES } from './frontmatter.js'
export { entryBody, charCount, checkEntry, normalizeEntries, entryIssuesIn, MAIN_ENTRY_SPEC, citedSourceFiles, measureWithoutMethod, conflictDigest, mainEntrySpecOf, moduleEntrySpecOf } from './entries.js'
export { HEALTH_DIMENSIONS, HEALTH_KEYS, healthLines, healthTemplateLines, parseHealthDeclarations, healthOf, projectHealthOf, dimensionAverages, DIMENSION_FIX } from './health.js'
export { AUDIT_PROMPT, sectionCounts, dimensionRanking, auditOf, fixPlanOf, normalizeAdditions, recheckPlan, internEvidence, indexVerdicts, expectOfSource } from './audit.js'
export { SOURCE_RULES, collectSourceFiles, longestFunction, longFunctionsIn, isFunctionStart, sameFile, inspectSource, sourceVerdicts, trueHealthOf } from './source.js'
export { pendingMigrations, planRebuild, rebuildProject } from './migrate.js'
export { mainTemplate, moduleTemplate } from './templates.js'
export { listProjects, scanUnpuzzled, projectSummaries, readState, readModuleDetail, readMainDoc, readWorkflow, writeWorkflow, writeWorkflowDoc, normalizeWorkflowEntries, parseWorkflowBlocks, workflowsTriggeredBy, removeWorkflowItem, restoreWorkflowItem, dropWorkflowArchiveItem, normalizeArchiveCapped, modeOfFields, passThroughFields, setMainFields, writeSessionList, boundProject, boundProjects, forgetBound, readProjectMode, unbindSession, unbindOne, bindSession, setCurrentProject, addBinding, createProject, updateMainSection, updateModuleSection, updateProjectHealth, setMode, setSourceRoot, sizeOfProject, setSize } from './project.js'
export { dimensionMeta, summarize, summarizeList, receipt, isExecutableMode, pauseFields } from './summary.js'
export { SETTINGS_FILE, MAX_DISABLED_SESSIONS, ASK_PAUSE_DEFAULT, settingsDir, settingsPath, readSettings, isSessionDisabled, isAskPauseEnabled, setAskPause, disableSession, enableSession } from './settings.js'
export { FIRST_RUN_MARK, FIRST_RUN_CONDITIONS, makeContextMessage, isSkipRequest, textOfMessage, isUserMessage, isDelegatedSession, detectFirstRun, firstRunHint, markFired, hasFired } from './firstrun.js'
export { LOOP_REPEAT_THRESHOLD, LOOP_ESCALATE_EVERY, LOOP_MAX_LEVEL, LOOPGUARD_MAX_SESSIONS, LOOP_BREAK_MARK, stableStringify, actionSignature, noteAction, streakOf, clearStreak, resetLoopGuard, loopBreakText } from './loopguard.js'
export { NUDGE_EVERY, NUDGE_MAX_LEVEL, NUDGE_SAME_FILE, NUDGE_MAX_SESSIONS, NUDGE_MARK, READ_ONLY_TOOLS, NUDGE_REASON_CADENCE, NUDGE_REASON_REPEAT, isReadOnlyTool, readTargetOf, noteCall, nudgeStateOf, clearNudge, resetNudge, nudgeText } from './nudge.js'
export { SPEECH_MARK, SPEECH_KIND_ENGLISH, SPEECH_KIND_ECHO, ENGLISH_LINE_MIN_WORDS, ENGLISH_MIN_WORDS, ENGLISH_HEADING_MIN_WORDS, ENGLISH_HEADING_MIN_LETTERS, ECHO_WINDOW, ECHO_STEP, SPEECH_USER_KEEP, SPEECH_TOOL_KEEP, stripCode, collapse, englishProse, detectEnglish, detectEcho, speechViolation, rememberInput, inputsOf, noteStatement, peekViolation, takeViolation, clearSpeech, resetSpeech, speechFixText } from './speech.js'
export { THEME_API_VERSION, DEFAULT_THEME_REPO, DEFAULT_THEME_BRANCH, MAX_THEME_BYTES, MAX_INDEX_BYTES, THEME_ID_RE, THEME_CHANNELS, themesDir, themesStatePath, themeCssPath, readThemeState, setThemeRepo, themeChannelsFor, fetchThemeFile, sha256Hex, validateThemeCss, validateThemeIndex, listThemes, installTheme, applyTheme, resetTheme, uninstallTheme, loadThemeCss, themeOverview, themeFilesOnDisk } from './themes.js'
