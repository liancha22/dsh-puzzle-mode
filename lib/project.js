/**
 * 项目级读写：建项目、写小节、写健康性、汇总状态、项目定位。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 * v8（2.0.0）起「会话绑定」整体退场——项目与会话不再有关系，
 * 定位靠 `locate()` 两步（显式 project → 面板当前打开的项目 → 空）。
 */
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PUZZLE_DIR, MAIN_FILE, MODULE_DIR, MODES, DEFAULT_MODE, PUZZLE_VERSION, MODE_PUZZLE_WRITE, MODE_RENAME_VERSION, normalizeMode, HEALTH_HEADING, SECTION_ORDER, SECTION_HEADINGS, SECTION_KEYS, MODULE_SECTION_KEYS, MODULE_SECTION_HEADINGS, MODULE_SECTION_ORDER, ENTRY_LIMITS, SIZE_FIELD, DEFAULT_SIZE, normalizeSize, capsOfSize, limitsOfSize, SIZES } from './constants.js'
import { listFiles, isFile, isDir, isSkippableDirName, clampPercent, slugify, timestamp } from './util.js'
import { safeJoin, puzzleDirOf, atomicWrite, readTextCached } from './docfs.js'
import { formatFrontMatter, parseFrontMatter, parseSourceRoot, getSection, withSection, applySection, docVersion, safePlanned, extraSectionsIn } from './frontmatter.js'
import { entryLines, entryBody, normalizeEntries, conflictDigest, entryIssuesIn, citedSourceFiles, mainEntrySpecOf, moduleEntrySpecOf } from './entries.js'
import { HEALTH_KEYS, healthOf, projectHealthOf, dimensionAverages, sectionCounts } from './health.js'
import { collectSourceFiles } from './source.js'
import { mainTemplate, moduleTemplate } from './templates.js'
import { openProjectOf, setOpenProject } from './settings.js'


/**
 * 读一个项目的**规模档位**（主文档 front-matter 的 `规模:`）。
 *
 * 认不出 / 没写 → `中`。存量文档一个都不用改：`中` 档就是升级前的所有上限。
 * 读不出来（文档不在 / 权限）也回 `中`——规模只影响「能写多少条」，
 * 不该因为它让一次写入失败。
 */
export function sizeOfProject(projectRoot, projectName) {
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return DEFAULT_SIZE
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return DEFAULT_SIZE
  const text = readTextCached(mainDoc)
  if (text === null) return DEFAULT_SIZE
  const { fields } = parseFrontMatter(text)
  return normalizeSize(fields[SIZE_FIELD]) ?? DEFAULT_SIZE
}

/** 扫出项目根下所有已有拼图项目（按修改时间倒序）。 */
export function listProjects(projectRoot) {  const found = []
  for (const entry of listFiles(projectRoot)) {
    const main = join(projectRoot, entry, PUZZLE_DIR, MAIN_FILE)
    if (!isFile(main)) continue
    let mtimeMs = 0
    try {
      mtimeMs = statSync(main).mtimeMs
    } catch (_error) {
      mtimeMs = 0
    }
    found.push({ name: entry, dir: join(projectRoot, entry, PUZZLE_DIR), mainDoc: main, mtimeMs })
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found
}

/**
 * 扫出工作区里**还没有拼图文档**的顶层目录（供面板「一次建多个项目文档」用）。
 *
 * 用户需求（v0.21.0）：「造着项目建文档加一个自动判断此会话是否有多个项目，
 * 若有多个项目则自动新建多个项目文档并绑定多个。」
 *
 * 为什么由**宿主**扫而不是让模型自己读工作区：目录清单是个客观事实，
 * 让模型去 `ls` 再自己数，不同轮次会给出不同答案；而且它看不到真实文件树时
 * 只能编。宿主扫一次、把结果连名字带证据交给面板与模型，判定才是确定的。
 *
 * 判定「是不是一个项目」刻意**宽松**：顶层目录 + 不是噪音目录（见 `isSkippableDirName`）
 * + 自己还没有 `拼图/主文档.md`。不做「必须有 package.json」这种判断——
 * 纯数据目录、脚本集合、笔记库也都是用户眼里的「项目」，漏掉比多列糟得多。
 * 用户还会在面板上勾选（他选的才算），所以这里宁多勿少。
 *
 * 每条带上 `entries`（顶层前几个名字）当**证据**：让用户一眼看出这是哪个目录，
 * 而不是只看一个可能重名的项目名。
 */
export function scanUnpuzzled(projectRoot, limit = 200) {
  const existing = new Set(listProjects(projectRoot).map((item) => item.name))
  const out = []
  for (const entry of listFiles(projectRoot)) {
    if (isSkippableDirName(entry)) continue
    if (existing.has(entry)) continue
    const dir = join(projectRoot, entry)
    if (!isDir(dir)) continue
    let entries = []
    try {
      entries = listFiles(dir)
        .filter((name) => !name.startsWith('.'))
        .slice(0, 5)
    } catch (_error) {
      entries = []
    }
    out.push({
      name: entry,
      // `slugify` 后的名字才是能落盘的目录名；与已有项目重名时面板会拦下来。
      slug: slugify(entry),
      entries,
    })
    if (out.length >= limit) break
  }
  return out
}

/**
 * 列出项目根下每个拼图项目的摘要（供 `op:'list'` 用）。
 *
 * 存在的意义：`op:'read'` 不给 `project` 时只能取「最新」那个，多项目工作区里
 * 模型看不出自己选错了。有了这个 op，模型可以先列出来再显式指定。
 */
export function projectSummaries(projectRoot) {
  return listProjects(projectRoot).map((entry) => {
    const state = readState(projectRoot, entry.name)
    return {
      name: entry.name,
      project: state.project,
      mode: state.mode,
      health: state.health,
      dimensions: state.dimensions,
      moduleCount: state.modules.length,
      builtModuleCount: state.modules.filter((module) => module.exists).length,
      updated: state.updated ?? null,
      updatedAt: new Date(entry.mtimeMs).toISOString(),
      degraded: state.degraded === true,
    }
  })
}

/** 原子写：先写同目录临时文件再 rename，避免读到半截文档。 */


/**
 * front-matter 里的模式 → 当前三种之一。
 *
 * **版本必给**（默认当前版）：v4 及更早的 `边拼边写` 表示「一轮做完才问」，
 * 归一成 `写后再拼`。见 `constants.normalizeMode` 与 `MODE_RENAME_VERSION`。
 */
export function modeOfFields(fields, version = PUZZLE_VERSION) {
  const raw = fields !== null && fields !== undefined ? fields['模式'] : undefined
  return normalizeMode(raw, version) ?? DEFAULT_MODE
}

/**
 * 「整份重写 front-matter」时，**模式与版本这两个字段**该怎么写。
 *
 * 凡是要重写 front-matter 的写入路径（写小节 / 改模块清单 / 改规模 / 改模式）都得走这里，
 * 否则 `模式: 边拼边写` 的旧文档会在某一次无关的写入里被静默改成 `只拼不写`
 * ——因为旧名字不在 `MODES` 里，随手写的 `MODES.includes(x) ? x : DEFAULT_MODE`
 * 就会把它替换掉。归一后名字变了，版本必须跟着到当前版，否则下次读又按旧含义解释。
 */
export function passThroughFields(fields, text) {
  const docVer = docVersion(text)
  const raw = typeof fields['模式'] === 'string' ? fields['模式'].trim() : ''
  const renamed = raw === MODE_PUZZLE_WRITE && docVer < MODE_RENAME_VERSION
  return {
    puzzle: renamed ? PUZZLE_VERSION : (fields.puzzle ?? 1),
    mode: modeOfFields(fields, docVer),
  }
}

/** 定位主文档并读出来；项目不存在或读不出来时返回 `{ ok:false }`（不抛错）。 */
function mainDocTarget(projectRoot, projectName) {
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  return { ok: true, mainDoc, text }
}

/**
 * 读主文档全文（供面板的「主文档」只读查看）。
 *
 * 面板查看是**只读**的（用户裁定）：主文档的形状由 `puzzle_mode` 统一维护，
 * 面板给一个能编辑的框就等于开了第二条写入通道，条目限长 / 条数上限 / slug 过滤
 * 全部会被绕过——那正是「文档锁」要防的事。所以这里只回原文，不回任何编辑入口。
 */
export function readMainDoc(projectRoot, projectName) {
  const located = mainDocTarget(projectRoot, projectName)
  if (located.ok !== true) return located
  const { mainDoc, text } = located
  return {
    ok: true,
    mainDoc,
    text,
    version: docVersion(text),
    outdated: docVersion(text) < PUZZLE_VERSION,
  }
}

/* --------------------------------- 状态读取 --------------------------------- */

export function moduleEntries(puzzleDir, modules, projectText, size = DEFAULT_SIZE) {
  // 条目规格**按档位取**（不是固定的中档字长）：大档的要点 / 已定放宽到 40 字，
  // 拿中档的 20 字去量会把每条合法条目都报成「超长」——写入放行、审查报警的「两把尺子」。
  const moduleSpec = moduleEntrySpecOf(size)
  return modules.map((name) => {
    const file = join(puzzleDir, MODULE_DIR, `${name}.md`)
    const text = isFile(file) ? readTextCached(file) : null
    const health = text === null
      ? { scores: Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0])), sources: {}, evidence: {}, health: 0 }
      : healthOf(text, projectText)
    const body = text === null ? '' : parseFrontMatter(text).body
    const progress = text === null ? null : getSection(body, MODULE_SECTION_HEADINGS.progress)
    const progressMatch = progress === null ? null : /完成度\s*[:：]\s*(\d{1,3})/.exec(progress)
    return {
      name,
      file,
      exists: text !== null,
      health: health.health,
      healthScores: health.scores,
      healthSources: health.sources,
      evidence: health.evidence,
      progress: progressMatch === null ? null : clampPercent(Number(progressMatch[1])),
      // 该模块文档**自己引用到的源码文件**（从 `（源码: lib/x.js:12）` 里抽）。
      // 审查做模块级源码判决时据此过滤：只拿这个模块真的指到的文件去扣分，
      // 否则每个模块都会继承同一份项目级硬伤，8 个模块的分会被拉平成一模一样。
      citedFiles: text === null ? [] : citedSourceFiles(body),
      // 不合规条目（超长 / 无出处）：审查据此点名，而不是只看条数。
      entryIssues: text === null ? [] : entryIssuesIn(body, moduleSpec),
      // 计数直接来自 health 的证据：悬而未决 / 已定是独立小节，不再按勾选框过滤。
      counts: {
        points: health.evidence.points ?? 0,
        pending: health.evidence.pending ?? 0,
        decided: health.evidence.decided ?? 0,
      },
    }
  })
}

/**
 * 只读「项目是否存在 + 它是什么模式」——**热路径专用**，别拿它当 `readState` 用。
 *
 * 为什么必须单独有一个（实测数字，2026-10-02）：`tools/pre-execute` 挂在**每一次工具调用**上，
 * 而它只为回答一个问题——「本会话绑定的项目是不是『只拼不写』」。原先它调 `readState`，
 * 那会把主文档 + **全部模块文档**读一遍并算健康性 / 条目合规 / 引用源码，
 * 单次阻塞实测 **86–127ms**（工作区 9 项目 / 10 模块）。这个函数只读**一份主文档的
 * front-matter**，配合 `readTextCached` 后热路径降到 ~25ms。
 *
 * 语义与 `readState` 在这两个字段上**完全一致**（`initialized` / `mode`），因为它复用
 * 同一条模式判定链（`docVersion` + `normalizeMode`）——旧名字按版本归一这条规则不能漏，
 * 漏了会让 v4 及更早的文档在插件升级那一刻静默跳进高强度模式。
 *
 * 不返回的东西（有意）：健康性、模块、条目合规。热路径一个都用不上。
 */
export function readProjectMode(projectRoot, projectName) {
  const slug = slugify(projectName)
  const puzzleDir = slug === null ? null : puzzleDirOf(projectRoot, slug)
  const mainDoc = puzzleDir === null ? null : join(puzzleDir, MAIN_FILE)
  if (mainDoc === null) return { initialized: false, mode: DEFAULT_MODE, mainDoc: '' }
  const text = readTextCached(mainDoc)
  if (text === null) return { initialized: false, mode: DEFAULT_MODE, mainDoc }
  const fields = parseFrontMatter(text).fields
  return { initialized: true, mode: normalizeMode(fields['模式'], docVersion(text)) ?? DEFAULT_MODE, mainDoc }
}

/**
 * 读一个项目的最新状态。**从不抛错、从不写盘**：
 * 目录不存在 → initialized:false；主文档坏 → 记 degraded 并继续尽力解析。
 */
export function readState(projectRoot, projectName) {
  const slug = typeof projectName === 'string' ? slugify(projectName) : null
  const puzzleDir = slug === null ? null : puzzleDirOf(projectRoot, slug)
  const mainDoc = puzzleDir === null ? null : join(puzzleDir, MAIN_FILE)
  const base = {
    initialized: false,
    degraded: false,
    projectRoot: typeof projectRoot === 'string' ? projectRoot : '',
    project: slug ?? '',
    puzzleDir: puzzleDir ?? '',
    mainDoc: mainDoc ?? '',
    mode: DEFAULT_MODE,
    modeSource: 'default',
    /** 项目规模档位：没写就是 `中`（升级前的所有上限）。 */
    size: DEFAULT_SIZE,
    modules: [],
    dimensions: Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0])),
    health: 0,
    sections: {},
    findings: [],
    planned: [],
    /** 文档格式版本；base 里给当前值，未初始化就没有「旧格式」可言。 */
    version: PUZZLE_VERSION,
    outdated: false,
    error: null,
  }
  if (mainDoc === null || !isFile(mainDoc)) return base

  const text = readTextCached(mainDoc)
  if (text === null) return { ...base, error: '主文档存在但读不出来' }

  const { fields, body } = parseFrontMatter(text)
  let planned = []
  const rawModules = fields['计划模块']
  if (typeof rawModules === 'string' && rawModules.trim() !== '') {
    try {
      const parsed = JSON.parse(rawModules)
      if (Array.isArray(parsed)) planned = parsed.filter((item) => typeof item === 'string')
    } catch (_error) {
      base.degraded = true
    }
  }
  if (planned.length === 0) {
    for (const entry of listFiles(join(puzzleDir, MODULE_DIR))) {
      if (entry.endsWith('.md')) planned.push(entry.slice(0, -3))
    }
  }
  planned = [...new Set(planned.map((item) => slugify(item)).filter((item) => item !== null))]

  const modules = moduleEntries(puzzleDir, planned, text, normalizeSize(fields[SIZE_FIELD]) ?? DEFAULT_SIZE)
  // 模式判定**必须带文档版本**：v4 及更早的 `边拼边写` 是「一轮做完才问」的旧含义，
  // 归一成 `写后再拼`。不带版本会让每个旧项目在插件升级那一刻静默跳进高强度模式。
  const docVer = docVersion(text)
  const rawMode = normalizeMode(fields['模式'], docVer)
  const declaredMode = rawMode === null ? null : rawMode
  // 旧名字被归一过（`模式: 边拼边写` 但文档是 v4）→ 如实标出来，
  // 面板与工具返回都能看见「这个项目其实还没迁移」，而不是悄悄换个名字继续跑。
  const modeRenamed = declaredMode !== null && typeof fields['模式'] === 'string' && fields['模式'].trim() !== declaredMode
  const dimensions = dimensionAverages(modules)

  const state = {
    ...base,
    initialized: true,
    degraded: base.degraded,
    project: typeof fields['项目'] === 'string' && fields['项目'].trim() !== '' ? fields['项目'].trim() : slug,
    mode: declaredMode ?? DEFAULT_MODE,
    modeSource: declaredMode === null ? 'default' : 'front-matter',
    // 规模档位：认不出 / 没写 → `中`。存量文档一个都不用改。
    size: normalizeSize(fields[SIZE_FIELD]) ?? DEFAULT_SIZE,
    /** true 表示 front-matter 里写的是旧名字，已按旧含义（写后再拼）读。 */
    modeRenamed,
    updated: fields['更新时间'] ?? null,
    modules,
    dimensions,
    health: projectHealthOf(modules),
    sections: sectionCounts(body),
    planned,
    /** 源码根（front-matter 的 `源码根:`）；空串表示按默认规则找。 */
    sourceRoot: parseSourceRoot(fields),
    version: docVersion(text),
    outdated: docVersion(text) < PUZZLE_VERSION,
    /** 主文档四节里不合规的条目（超长 / 无出处），供审查点名。 */
    mainEntryIssues: entryIssuesIn(body, mainEntrySpecOf(normalizeSize(fields[SIZE_FIELD]) ?? DEFAULT_SIZE)),
    // 规范之外的小节（主文档 + 各模块）：审查据此报 unknown_section。
    // 它们既读不进任何 op、也不会被写入覆盖，只能靠 rebuild 清掉——
    // 所以必须**可见**，否则就是「删不掉又看不见」（实测踩过）。
    extraMainSections: extraSectionsIn(body, SECTION_ORDER.map((key) => SECTION_HEADINGS[key])),
    extraModuleSections: modules.flatMap((module) => (
      extraSectionsIn(readTextCached(module.file) ?? '', MODULE_SECTION_ORDER)
        .map((heading) => ({ name: module.name, heading }))
    )),
    goal: (body.split(/\r?\n/).find((line) => line.startsWith('> 目标：')) ?? '').replace(/^>\s*目标：/, '').trim(),
  }
  return state
}

/**
 * 读某个模块文档的正文小节（供 UI 点开图块看详情，以及模型按需回读）。
 * 文件不存在时返回 exists:false，不抛错、不建文件。
 */
export function readModuleDetail(projectRoot, projectName, moduleName) {
  const slug = slugify(moduleName)
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (slug === null) return { ok: false, error: '模块名不合法' }
  if (puzzleDir === null) return { ok: false, error: '项目名不合法' }
  const file = safeJoin(puzzleDir, MODULE_DIR, `${slug}.md`)
  if (file === null) return { ok: false, error: '模块路径越界' }

  const mainDoc = join(puzzleDir, MAIN_FILE)
  const projectText = isFile(mainDoc) ? readTextCached(mainDoc) : null
  if (!isFile(file)) {
    return {
      ok: true,
      name: slug,
      exists: false,
      file,
      health: 0,
      dimensions: Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0])),
      points: null,
      pending: null,
      decided: null,
      reuse: null,
      detail: null,
    }
  }
  const text = readTextCached(file)
  if (text === null) return { ok: false, error: '模块文档读不出来' }
  const { body } = parseFrontMatter(text)
  const health = healthOf(text, projectText)
  return {
    ok: true,
    name: slug,
    exists: true,
    file,
    health: health.health,
    dimensions: health.scores,
    sources: health.sources,
    points: (getSection(body, MODULE_SECTION_HEADINGS.points) ?? '').trim(),
    pending: (getSection(body, MODULE_SECTION_HEADINGS.pending) ?? '').trim(),
    decided: (getSection(body, MODULE_SECTION_HEADINGS.decided) ?? '').trim(),
    reuse: (getSection(body, MODULE_SECTION_HEADINGS.reuse) ?? '').trim(),
    detail: (getSection(body, MODULE_SECTION_HEADINGS.detail) ?? '').trim(),
  }
}

/* --------------------------------- 写入 --------------------------------- */

/** 从 front-matter 里安全读出模块清单（坏 JSON 当空数组）。 */


/** 只改主文档的行为字段（模式 / 模块清单），保留其余内容。 */
export function setMainFields(text, patch) {
  const { fields, body } = parseFrontMatter(text)
  const carried = passThroughFields(fields, text)
  const next = {
    puzzle: carried.puzzle,
    project: patch.project ?? fields['项目'] ?? '',
    mode: patch.mode ?? carried.mode,
    modules: patch.modules ?? safePlanned(fields),
    // 源码根必须透传：漏一次，审查就找不到源码（退化成「查不到」）。
    sourceRoot: patch.sourceRoot ?? parseSourceRoot(fields),
    // 规模档位同理必须透传：漏一次，用户选的「大」就在改一次模式之后静默掉回「中」，
    // 而「中」的条数上限更小 → 下一次写入会**删掉超出的条目**。这种丢失是静默的。
    size: patch.size ?? fields[SIZE_FIELD],
    updated: timestamp(),
  }
  if (!Array.isArray(next.modules)) next.modules = []
  // patch.mode 是调用方给的**当前名字**（setMode 已按 MODES 校验过），所以按当前版判。
  if (normalizeMode(next.mode) === null) next.mode = DEFAULT_MODE
  return `${formatFrontMatter(next)}\n${body.replace(/^\n+/, '')}`
}
/* ------------------------- 项目定位（v8：全局，不再按会话绑定） ------------------------- */

/**
 * 项目根下**全部**项目名，顺序是「面板当前打开的那个」排第一。
 *
 * ## 为什么还叫 `boundProjects`
 *
 * 名字保留是为了不牵动 20 多个调用点，但**语义已经换了**：v7 及更早是「本会话绑定了
 * 哪些项目」，v8 起是「这个工作区根下有哪些项目」。两者在调用点的用法恰好一致
 * （都是「拿到一组项目名，第一个是默认落点」），所以换语义不换签名是安全的。
 *
 * `sessionId` 参数**保留但不再使用**——v8 里它没有任何判定作用。留着只为兼容调用点。
 *
 * ## 顺序 = 「面板当前打开的项目」优先
 *
 * 依据是全局设置的 `openProject`，**不是**列表顺序、也不是 mtime：用户点进项目 B，
 * 下一次工具调用就该落在 B。靠 mtime 会让「我刚往 A 写了一行」把默认落点偷偷拽回 A
 * ——那种漂移没有可见的起因。
 *
 * `openProject` 指向的项目**不在这条根下**时返回空串，默认落点回落到列表第一个。
 * 这里**不自愈写盘**：读函数写盘会让「读」产生副作用。
 *
 * ## 不缓存
 *
 * v7 的缓存是为「每次工具调用都要读每个项目的主文档找绑定」而加的（实测 37 个条目
 * → 36 次 statSync，每次白交 10ms）。v8 的判据是一个全局设置文件（`readSettings`
 * 自带 mtime 指纹缓存）+ 一次 `listProjects`，没有「按项目数放大」的那一项。
 */
export function boundProjects(projectRoot) {
  const names = listProjects(projectRoot).map((item) => item.name)
  const open = openProjectOf()
  if (open !== '' && names.includes(open)) {
    return [open, ...names.filter((name) => name !== open)]
  }
  return names
}

/**
 * 工具不给 `project` 时**默认落在哪个项目**（`boundProjects` 的第一个）。
 *
 * 保留这个名字与签名，是因为它在热路径与所有既有调用点上都是「一个项目」的语义。
 * 没有项目就返回 `null`——**不猜、不回退到「最新那个」**：那条回退会把新会话
 * 塞进上一个会话的项目，越写越混。
 */
export function boundProject(projectRoot) {
  const names = boundProjects(projectRoot)
  return names.length > 0 ? names[0] : null
}

/**
 * 面板当前打开的项目（全局设置的 `openProject`），**并且校验它真的在这个根下**。
 *
 * 校验是必要的：`openProject` 是全局的，而工作区可以被换掉——
 * 换了根之后那个项目名在新根下多半不存在，直接用它会让面板打开一个空项目。
 * 不匹配就回空串（= 停在项目列表首页），与「从没打开过」是同一种表现。
 */
export function openProjectIn(projectRoot) {
  const open = openProjectOf()
  if (open === '') return ''
  return listProjects(projectRoot).some((item) => item.name === open) ? open : ''
}

/**
 * 切换面板当前打开的项目（传空串 = 回到项目列表首页）。
 *
 * 这是 v8 里 `op:current` 的落点：从「切换本会话的当前项目」变成
 * 「切换**面板当前打开的项目**」——即一级列表里「点一行进下一级」那件事。
 */
export function setOpenProjectIn(projectRoot, projectName) {
  const slug = typeof projectName === 'string' && projectName.trim() !== '' ? slugify(projectName) : ''
  if (slug !== '' && !listProjects(projectRoot).some((item) => item.name === slug)) {
    return { ok: false, error: `项目「${slug}」不存在`, hint: '刷新项目列表再试' }
  }
  const done = setOpenProject(slug)
  return { ok: true, openProject: done.openProject, changed: done.changed }
}

/**
 * 定位本次调用要操作的项目。解析顺序**只有两步**（v8 去掉了「本会话绑定」那一档）：
 *   显式给了 project → 用它（source: 'explicit'，不存在也算显式，如实回报未初始化）；
 *   否则**面板当前打开的项目** → 用它（source: 'open'）；
 *   否则 → **空**（source: 'none'，project 为 ''）。
 *
 * 为什么第二档从「本会话绑定」换成「面板当前打开」：v8 之后面板是全局工作台，
 * 「我现在在看哪个项目」这件事只有面板知道（它落在全局设置里），会话不再参与。
 *
 * ⚠️ 这里**不读 `projectRoot` 之外的东西**：未绑定工作区时 `projectRoot` 是空串，
 * `listProjects('')` 会返回空数组，于是落到 `none`——这正是「先去绑一个工作区」的信号。
 */
export function locate(projectRoot, requested) {
  const slug = typeof requested === 'string' && requested.trim() !== '' ? slugify(requested) : null
  if (slug !== null) {
    return { project: slug, source: 'explicit', exists: listProjects(projectRoot).some((item) => item.name === slug) }
  }
  const open = openProjectIn(projectRoot)
  if (open !== '') return { project: open, source: 'open', exists: true }
  return { project: '', source: 'none', exists: false }
}

/* --------------------------------- 写入 --------------------------------- */

/**
 * 建目录 + 主文档 + N 份模块文档（已存在的模块文档不覆盖）。
 *
 * ⚠️ v8 起**不再写 `会话:` / `当前会话:`**（那两个字段整体退场），
 * 也**不再顺带绑定本会话**——`sessionId` 参数保留只为兼容调用点，
 * 它在本函数里没有任何作用。新建完要不要「打开它」由调用方决定
 * （面板走 `setOpenProjectIn`，工具走「建完即当前」那条：见 `createProject` 的返回）。
 */
export function createProject(projectRoot, projectName, goal, modules, mode = DEFAULT_MODE) {
  const slug = slugify(projectName)
  if (slug === null) return { ok: false, error: '项目名不合法', hint: '换一个不含路径符号的名字' }
  const projectDir = safeJoin(projectRoot, slug)
  if (projectDir === null) return { ok: false, error: '项目路径越界', hint: '项目名不能包含 ../' }
  const puzzleDir = join(projectDir, PUZZLE_DIR)
  const mainDoc = join(puzzleDir, MAIN_FILE)
  const names = []
  for (const raw of Array.isArray(modules) ? modules : []) {
    const name = slugify(raw)
    if (name === null) continue
    if (!names.includes(name)) names.push(name)
  }

  try {
    mkdirSync(join(puzzleDir, MODULE_DIR), { recursive: true })
    const mainCreated = !isFile(mainDoc)
    if (mainCreated) atomicWrite(mainDoc, mainTemplate(slug, names, goal, mode))
    const created = []
    for (const name of names) {
      const file = join(puzzleDir, MODULE_DIR, `${name}.md`)
      if (isFile(file)) continue
      atomicWrite(file, moduleTemplate(name))
      created.push(name)
    }
    /**
     * 新建的项目**成为面板当前打开的那个**。
     *
     * 为什么这条对：用户刚建完一个项目，下一步必然是「进去看看」；
     * 不切的话面板还停在列表页，而工具不给 project 时也落不到它上面。
     * 与 v7 的差别是**它不再是「绑定」**——只是「面板现在打开着它」，
     * 换工作区 / 关面板都不影响别的项目。
     *
     * 只在**真的新建**（主文档原本不存在）时才切：项目已存在时再走一次 `op:init`
     * 是模型很常见的「确保存在」写法，那一下不该改变用户当前在看哪个项目。
     */
    let opened = null
    if (mainCreated) {
      const done = setOpenProject(slug)
      opened = done.openProject
    }
    return {
      ok: true,
      project: slug,
      puzzleDir,
      mainDoc,
      mainCreated,
      created,
      modules: names,
      existing: names.filter((name) => !created.includes(name)),
      /** 这次是否把它设成了面板当前打开的项目（只有真新建才是 true）。 */
      rebound: mainCreated,
      bound: mainCreated,
      opened,
      released: [],
      bindError: null,
    }
  } catch (error) {
    return { ok: false, error: '创建文档失败', hint: String(error && error.message ? error.message : error) }
  }
}

/**
 * 更新主文档的一个小节；index 小节同时刷新 front-matter 的模块清单。
 *
 * v4 起四节都有**字数上限**；除 `index`（指向模块文档）外，
 * 每条还必须带源码出处（`ENTRY_LIMITS`）：
 * 校验不过就整次拒绝（不截断——半句话落进文档比报错更糟）。
 * `index` 小节是模块清单，条目格式不同，只做字数校验。
 */
export function updateMainSection(projectRoot, projectName, section, content, append = true) {
  if (!SECTION_KEYS.has(section)) {
    return { ok: false, error: `未知小节 ${section}`, hint: `可用：${SECTION_ORDER.join(' / ')}（主文档只有这四节）` }
  }
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }

  const { fields, body } = parseFrontMatter(text)
  // **规模档位**：同一个项目写多细由它定（没写 = `中`，即升级前的所有上限）。
  // 字数上限按档取——`大` 档放宽（已定 / 要点这类常要写下一句带取舍的结论）。
  const size = normalizeSize(fields[SIZE_FIELD]) ?? DEFAULT_SIZE
  const sizeLimits = limitsOfSize(size)

  // 模块索引指向的是模块文档（`模块/X.md` 就是回查路径），所以只限长、不强制 `（源码: …）`。
  const requireSource = section !== 'index'
  const checked = normalizeEntries(content, sizeLimits[section], undefined, requireSource)
  if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }

  let nextBody = applySection(body, SECTION_HEADINGS[section], checked.text, append !== false)
  let dropped = []
  // 规模档位在这里起作用：`坑` 是唯一按规模限条数的主文档小节
  // （`小` 10 / `中` 不限 / `大` 60）。
  const sizeCaps = capsOfSize(size)
  const cap = section === 'pit' ? sizeCaps.pit : undefined
  if (cap !== undefined && cap !== null) {
    // **数条目必须用「这一节自己的规则」**：早先这里对 `## 工作流` 另走一套
    // （解析 `### 块`），因为 `entryLines` 带着**模块文档**的 `PLACEHOLDER_PATTERNS`
    // （「待补」「轮汇报」「可被别处复用」「最多 N 条」）——后果有两个，都很糟：
    // ① 以括号开头的合法内容被当成占位行，数出 0 条 → 整节被替换成占位行，
    // 内容**静默消失**，而返回值还报 `ok:true`；② 8 条里 3 条被当占位 → 只数到 5 条，
    // 判定「没超上限」→ 硬上限被绕过（实测留下 8 条）。
    // 工作流已随功能删除，剩下的条目式小节（坑）都走 `entryLines`。
    const all = entryLines(getSection(parseFrontMatter(nextBody).body, SECTION_HEADINGS[section]) ?? '')
    if (all.length > cap) {
      const kept = all.slice(all.length - cap)
      dropped = all.slice(0, all.length - cap).map((line) => (line.startsWith('- ') ? line : '- ' + line))
      nextBody = withSection(nextBody, SECTION_HEADINGS[section], kept.join('\n'))
    }
  }
  let planned = null
  if (section === 'index') {
    // 模块索引里出现过的模块名，同步进 front-matter 的模块清单（UI 的图块据此建出来）。
    const names = []
    for (const line of String(content ?? '').split(/\r?\n/)) {
      const match = /模块\s*[:：]\s*([^\s—\-–]+)/.exec(line) ?? /模块\/([^\s./]+)\.md/.exec(line)
      if (match === null) continue
      const name = slugify(match[1])
      if (name !== null && !names.includes(name)) names.push(name)
    }
    planned = [...new Set([...safePlanned(fields), ...names])]
  }
  const next = [
    formatFrontMatter({
      puzzle: PUZZLE_VERSION,
      project: fields['项目'] ?? projectName,
      mode: modeOfFields(fields, docVersion(text)),
      modules: planned ?? safePlanned(fields),
      sourceRoot: parseSourceRoot(fields),
      // ⚠️ **规模档位必须透传**（v0.23.3 修的真丢数据 bug）：
      // 漏了它，追加一条「坑」就把 `规模: 大` 抹掉 → 下次读按中档 → 上限更严 →
      // **超出的条目在下一次写入被静默删除**。实测：坑 149 条被砍到 60 条，丢 93 条。
      // 这条路径就是当初把我 93 条数据删掉的那一条。
      size: fields[SIZE_FIELD],
      updated: timestamp(),
    }),
    nextBody.replace(/^\n+/, ''),
  ].join('\n')
  try {
    atomicWrite(mainDoc, next)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mainDoc, section, entries: checked.incoming, dropped }
}

/**
 * 更新（必要时创建）模块文档的一个小节。
 *
 * `points` / `pending` / `decided` / `detail` 都是**条目式**小节：
 * 每条限字数、必须带源码出处；`pending` ≤4、`decided` ≤10，超限**删最旧**。
 */
export function updateModuleSection(projectRoot, projectName, moduleName, section, content, append = true) {
  if (!MODULE_SECTION_KEYS.includes(section)) {
    return { ok: false, error: `未知模块小节 ${section}`, hint: `可用：${MODULE_SECTION_KEYS.join(' / ')}` }
  }
  const slug = slugify(moduleName)
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (slug === null) return { ok: false, error: '模块名不合法', hint: '换一个不含路径符号的名字' }
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const file = safeJoin(puzzleDir, MODULE_DIR, `${slug}.md`)
  if (file === null) return { ok: false, error: '模块路径越界', hint: '模块名不能包含 ../' }

  let text = isFile(file) ? readTextCached(file) : null
  const created = text === null
  if (text === null) text = moduleTemplate(slug)

  // **规模档位**：同一个项目写多细由主文档的 `规模:` 定（没写 = `中`）。
  // 模块文档自己不带这个字段——它是**项目级**决定，一个项目里的模块不该各写各的。
  const size = sizeOfProject(projectRoot, projectName)
  const sizeCaps = capsOfSize(size)
  const sizeLimits = limitsOfSize(size)

  let dropped = []
  let entries = 0
  /** ③ 写入「已定 / 悬而未决」时，把现有条目摊出来供模型对照（v0.19.9）。 */
  let conflicts = null
  if (section === 'progress') {
    const percent = clampPercent(Number(String(content).replace(/[^\d]/g, '')))
    text = applySection(text, MODULE_SECTION_HEADINGS.progress, `完成度: ${percent}`, false)
  } else if (section === 'health') {
    // 只接受五个已知维度名；其余行（说明文字）原样保留在正文里。
    text = applySection(text, HEALTH_HEADING, content, append !== false)
  } else {
    const checked = normalizeEntries(content, sizeLimits[section], sizeCaps[section])
    if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }
    entries = checked.incoming
    dropped = checked.dropped
    // ③ 在**改写之前**读现有条目：只对「决策类」小节做（悬而未决 / 已定）——
    // 它们是「当前有效的决定」，被取代却不删就会变成反向规则（实测踩过）。
    // 要点 / 详细记录 / 可复用 是事实与记录，追加即可，不需要对照。
    if (section === 'pending' || section === 'decided') {
      const before = entryLines(getSection(parseFrontMatter(text).body, MODULE_SECTION_HEADINGS[section]) ?? '')
        .map((line) => entryBody(line))
      conflicts = conflictDigest(section, before, entryLines(content).map((line) => entryBody(line)), sizeCaps[section])
    }
    // 条数上限是**硬规则**：先按 append 合并新旧，再整体裁到末尾 N 条（最旧的先删）。
    const merged = applySection(text, MODULE_SECTION_HEADINGS[section], checked.text, append !== false)
    const cap = sizeCaps[section]
    if (cap === undefined || cap === null) {
      text = merged
    } else {
      const all = entryLines(getSection(parseFrontMatter(merged).body, MODULE_SECTION_HEADINGS[section]) ?? '')
      const overflow = all.length > cap ? all.slice(0, all.length - cap) : []
      if (overflow.length > 0) {
        dropped = overflow
        text = withSection(merged, MODULE_SECTION_HEADINGS[section], all.slice(all.length - cap).join('\n'))
      } else {
        text = merged
      }
    }
  }

  try {
    mkdirSync(join(puzzleDir, MODULE_DIR), { recursive: true })
    atomicWrite(file, text)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }

  // 模块第一次出现时，把它补进主文档 front-matter 的模块清单。
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (isFile(mainDoc)) {
    const mainText = readTextCached(mainDoc)
    if (mainText !== null) {
      const { fields } = parseFrontMatter(mainText)
      const planned = safePlanned(fields)
      if (!planned.includes(slug)) {
        try {
          atomicWrite(mainDoc, setMainFields(mainText, { modules: [...planned, slug] }))
        } catch (_error) {
          /* 补清单失败不影响模块文档本身的写入结果 */
        }
      }
    }
  }

  return { ok: true, file, created, section, entries, dropped, conflicts }
}

/**
 * 写模块文档的「健康性」小节。
 *
 * **项目级健康性不写进文档**（主文档只留规范小节，没有它的容身处）：
 * 项目健康性 = 各模块健康性的均值，由宿主汇总，手写只会与事实矛盾。
 */
export function updateProjectHealth() {
  return {
    ok: false,
    error: '项目级健康性不再写进文档',
    hint: '主文档只有 模块索引 / 源码索引 / 工具索引 / 坑 四节。五维请用 op:health 并给 name 写到对应模块文档，项目健康性由宿主按模块均值汇总。',
  }
}

/** 写模式（主文档 front-matter）。 */
/**
 * 写主文档的**规模档位**（front-matter 的 `规模:`）。
 *
 * 为什么要有它：固定上限对两头都不合适——小项目的「已定 10 条」写不满，
 * 大项目的「悬而未决 4 条」一上午就顶满，于是**最旧的决策被静默挤掉**。
 * 规模让用户按项目体量选，而不是全仓一个数。
 *
 * 写 `中` 时**把这一行删掉**（它是默认值，留着是噪音）；读侧认不出就当 `中`，
 * 所以存量文档一个都不用改。
 */
export function setSize(projectRoot, projectName, size) {
  const value = normalizeSize(size)
  if (value === null) {
    return { ok: false, error: `未知规模 ${size}`, hint: `可用：${SIZES.join(' / ')}（也可以给 s / m / l）` }
  }
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  try {
    atomicWrite(mainDoc, setMainFields(text, { size: value }))
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, size: value, caps: capsOfSize(value), entryLimits: limitsOfSize(value), mainDoc }
}

export function setMode(projectRoot, projectName, mode) {
  if (!MODES.includes(mode)) return { ok: false, error: `未知模式 ${mode}`, hint: `可用：${MODES.join(' / ')}` }
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  try {
    atomicWrite(mainDoc, setMainFields(text, { mode }))
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mode, mainDoc }
}

/**
 * 写主文档的**源码根**（front-matter 的 `源码根:`）。
 *
 * 为什么要有它：审查要做源码体检（文件行数、巨函数、目录分层），而文档目录与源码目录
 * 常常不在一处。把它记进文档，之后每次审查都知道去哪看代码，不必每次手填。
 * 传空串 = 清掉这一行（回到默认规则：拼图目录的上一级）。
 */
export function setSourceRoot(projectRoot, projectName, sourceRoot) {
  const value = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  // 给了路径就校验它确实存在——写进去一个不存在的路径，等于给审查埋一个「查不到」。
  if (value !== '') {
    let ok = false
    try {
      ok = statSync(value).isDirectory()
    } catch (_error) {
      ok = false
    }
    if (!ok) return { ok: false, error: '源码目录不存在或读不了：' + value, hint: '给一个存在的绝对路径' }
    const found = collectSourceFiles(value)
    if (found.length === 0) {
      return { ok: false, error: '该目录下没有源码文件：' + value, hint: '确认路径指向的是源码目录（不是只有文档或产物的目录）' }
    }
  }
  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  try {
    atomicWrite(mainDoc, setMainFields(text, { sourceRoot: value }))
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, sourceRoot: value, mainDoc }
}

/* --------------------------------- 汇总输出 --------------------------------- */

/** 每次返回都带上的固定收尾问（三处口径一致：提示段 / 工具返回 / UI 模板）。 */
