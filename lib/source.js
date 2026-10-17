/**
 * 源码工程化体检：文件行数/函数长度/文件数/目录分层。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 *
 * ⚠️ v2.1.1：审查功能整体删除，本文件里**「五维真实性」那一整段也删了**
 * （`SOURCE_HITS` / `sourceVerdicts` / `trueHealthOf`）——它算的是「审查用的
 * 五维真实值」，审查没了就没有消费者。体检本身（`inspectSource` 等）照旧保留：
 * `op:source` 仍要报告源码根下有多少文件、有没有巨函数。
 */
import { statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PUZZLE_DIR, MAIN_FILE } from './constants.js'
import { listFiles, isFile } from './util.js'
import { puzzleDirOf, projectFolderOf, readText } from './docfs.js'
import { parseFrontMatter, parseSourceRoot } from './frontmatter.js'


/* --------------------------------- 源码工程化 --------------------------------- */

/**
 * 源码体检：**客观测出**「这个项目的代码有没有在变成屎山」。
 *
 * 为什么需要它（用户原话：模型不经约束很容易把源码写成屎山，文件少又长，
 * 导致可拓展性差、维护困难，甚至加大模型自己的施工难度）：
 * 文档写得再整齐，代码本身如果是一坨，五维里的「可拓展性 / 可维护性」就是假的。
 * 所以这里只看**可测量的东西**，不看文笔：
 *   - 文件数与规模分布（有没有「一个文件塞下整个项目」）；
 *   - 单文件最大行数、超过阈值的大文件；
 *   - 最长函数（用缩进/括号配对粗略估算，不引依赖）；
 *   - 模块化程度（顶层导出数、是否只有一个巨型文件）；
 *   - 命名与分层痕迹（是否有 src/ lib/ 之类的目录分层）。
 *
 * 阈值是**经验值**，不是真理：超过就报事实 + 给可执行的下一步，由模型/人决定怎么拆。
 */
export const SOURCE_RULES = {
  /**
   * 单文件行数上限：**只是「提示去看」的信号，不是「判定有病」的证据**。
   *
   * 工程化是一棵树：树干粗不是病，承重模块（核心调度、状态机、协议编解码）天然内聚，
   * 硬拆只会让调用链横跨十个文件。健康的标准是「每个部分的职责清晰」，不是「所有部分一样细」。
   * 所以行数超阈值只是**前置条件**：还得看函数粒度（见 `healthyTrunkMax`）——
   * 一个 1200 行、30 个平均 28 行小函数的文件是健康的树干；一个 300 行塞了 260 行函数的
   * 文件才是有病。同样行数、相反形状，按行数判两者得分一样，这就是判据失效的地方。
   */
  fileLinesWarn: 800,
  fileLinesFail: 2000,
  /** 单函数行数上限：超过就难读、难测、难改。**问题从来在函数，不在文件。** */
  functionLinesWarn: 60,
  functionLinesFail: 150,
  /**
   * 「承重模块」判据：大文件里每个函数都不超过这个行数 → 函数粒度健康，只出 `info`。
   * 大文件里只要有函数超过它 → `source_big_file` 的文案会**指向那个函数**，
   * 而真正的 fail/warn 由 `source_long_function` 承担（不重复扣分）。
   */
  healthyTrunkMax: 60,
  /** 巨函数逐条列出的上限（超出的只报总数，免得一个项目刷出几百条发现）。 */
  longFunctionMax: 12,
  /** 死代码（导出符号零引用）最多报几个**文件**（每个文件一条，列前几个符号名）。 */
  deadExportMax: 10,
  /** 一条死代码发现里最多列几个符号名（其余只给个数）。 */
  deadExportShowMax: 5,
  /** 一个目录里源码文件少于这个数，且总行数很大 → 是「一个文件装下整个项目」。 */
  fewFilesMax: 3,
  /** 源码总行数超过这个值才谈「工程化」（小脚本不必套这套）。 */
  totalLinesMin: 400,
}

/** 这些目录不算「项目源码」：依赖、产物、版本库、文档目录。 */
export const SOURCE_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.cache',
  '.next', 'vendor', 'target', 'tmp', '.tmp', PUZZLE_DIR, '拼图',
])

/** 算作源码的后缀。 */
export const SOURCE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.sh']


export function isSourceFile(name) {
  const lower = String(name).toLowerCase()
  return SOURCE_EXTS.some((ext) => lower.endsWith(ext))
}


export function countLines(text) {
  if (typeof text !== 'string' || text === '') return 0
  return text.split(/\r?\n/).length
}

/**
 * 递归收集源码文件（限深度，避免钻进深层依赖）。
 *
 * 只读不写；任何读不了的目录直接跳过（不抛错）——审查不该因为一个坏软链就整个失败。
 */
export function collectSourceFiles(root, maxDepth = 6) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    for (const entry of listFiles(dir)) {
      if (entry.startsWith('.') && entry !== '.github') continue
      if (SOURCE_SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      let stat
      try {
        stat = statSync(full)
      } catch (_error) {
        continue
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!stat.isFile() || !isSourceFile(entry)) continue
      const text = readText(full)
      if (text === null) continue
      out.push({ file: full, name: entry, lines: countLines(text), text })
    }
  }
  walk(root, 0)
  return out
}

/**
 * 判断一行是不是**函数起点**。
 *
 * 老实现只看行尾字符（`/[{(]\s*$/`），于是 `class X {`、`if (a) {`、`try {`、
 * `const cfg = {` 全成了「函数开头」——任何用 class 的项目，类体一超阈值就必报，
 * 报出的「行数」是**类体总长**，读者无法据此定位。这是假阳性的最大来源。
 *
 * 现在要求**函数特征**：`function` 关键字、`名字(参数) {`、`get/set/async 名字(`、
 * `=> {`、或带名字的箭头函数赋值；并**显式排除**控制流与类型/命名空间关键字。
 * 类体、接口、枚举、对象字面量都不算函数起点（类内的方法各自成为候选起点）。
 */
const CONTROL_KEYWORDS = /^(if|for|while|switch|catch|else|do|try|finally|return|with|await|case)\b/
const TYPE_KEYWORDS = /^(class|interface|namespace|enum|module|declare|type|struct|impl|trait|record|union)\b/
/** 修饰符前缀：判断关键字前先剥掉它们（`export abstract class C {` 仍是类，不是函数）。 */
const MODIFIER_PREFIX = /^(?:export\s+|default\s+|declare\s+|abstract\s+|public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|async\s+)+/
/** `name(args) {` / `get name() {` / `async name(a, b): Ret {` —— 方法或函数声明。 */
const METHOD_LIKE = /^(?:get\s+|set\s+|\*\s*)?[A-Za-z_$][\w$]*\s*(?:<[^<>]*>)?\s*\([^()]*\)\s*(?::\s*[^{;]+)?\s*\{$/

export function isFunctionStart(line) {
  const raw = String(line ?? '').trim()
  if (raw === '') return false
  if (raw.startsWith('//') || raw.startsWith('*') || raw.startsWith('/*') || raw.startsWith('@')) return false
  if (raw.startsWith('}') || raw.startsWith(')') || raw.startsWith(']')) return false
  const trimmed = raw.replace(MODIFIER_PREFIX, '')
  if (CONTROL_KEYWORDS.test(trimmed) || TYPE_KEYWORDS.test(trimmed)) return false
  // `function` / `func` / `fn` / `def` 关键字：无论后面跟不跟名字、行尾是不是 `{`（多行参数表也算）。
  if (/\b(?:function|func|fn|def)\s*[\w$]*\s*\(/.test(trimmed)) return true
  // 箭头函数：行尾 `=>` 或 `=> {`。
  if (/=>\s*\{?\s*$/.test(trimmed)) return true
  // 方法/函数声明：`name(args) {`、`get name() {`、`async name(a): Ret {`。
  if (METHOD_LIKE.test(trimmed)) return true
  return false
}

/**
 * 找出一个文件里所有**超过阈值的函数**（按行数降序）。
 *
 * 老实现只对**最大的那个文件**跑一次 `longestFunction`，其余文件的巨函数永不发现
 * （体检覆盖面被悄悄砍到 1/N）。现在对每个文件跑，结果带 `file`，于是
 * `source_long_function` 能像 `source_big_file` 一样被模块级 `scoped` 过滤正确归因。
 *
 * 返回 `{ functions, skipped }`：`functions` 是最长的若干条（`at` 是 1 起的行号），
 * `skipped` 是被上限截掉没列出的条数。**只报事实，不判分**。
 */
export function longFunctionsIn(lines, minLines = SOURCE_RULES.functionLinesWarn, max = SOURCE_RULES.longFunctionMax) {
  const found = []
  let start = -1
  let startIndent = 0
  const push = (from, to) => {
    const size = to - from + 1
    if (size < minLines) return
    found.push({ at: from + 1, lines: size })
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()
    if (start < 0) {
      if (!isFunctionStart(line)) continue
      start = i
      startIndent = indent
      continue
    }
    // 收尾：回到不深于起点的 `}`（或 `})` 等）。
    if (indent <= startIndent && /^[}\]);,]+$/.test(trimmed)) {
      push(start, i)
      start = -1
      // 同一行也可能是下一个函数的起点（`}, {` 之类），但极少见，不再回溯。
    }
  }
  // 文件在函数中途结束（缺右括号）：按到末行算，宁可报出来也不要静默吞掉。
  if (start >= 0) push(start, lines.length - 1)
  found.sort((left, right) => right.lines - left.lines)
  const kept = found.slice(0, max)
  return { functions: kept, skipped: Math.max(0, found.length - kept.length) }
}

/**
 * 粗估最长函数（兼容旧调用）：返回最长的那个函数，没有就 `{ lines: 0, at: 0 }`。
 */
export function longestFunction(lines) {
  const result = longFunctionsIn(lines, 1, 1)
  return result.functions.length > 0 ? result.functions[0] : { lines: 0, at: 0 }
}

/**
 * 体检一个项目的源码工程化程度。**只读**，返回可量化的客观事实。
 *
 * `sourceRoot` 优先级：显式参数 > 主文档 front-matter 的 `源码根:` > **拼图项目文件夹**
 * （`<数据工作区>/<项目名>`，即拼图目录的上一级）。
 *
 * 为什么要三级：**文档目录与源码目录常常不是同一处**。本项目实测：文档在
 * `/sdcard/dsha222/拼图模式插件/拼图/`，源码在 `/root/.dsh/plugin-src/dsh-puzzle-mode/`。
 * 找不到源码时**如实说「没查到」**，而不是把 0 个文件当成「代码很干净」。
 *
 * 第三级走 `projectFolderOf` 而不是 `resolve(projectDir, '..')`：两者**算出来是同一个路径**，
 * 但路径拼法只该有一份（v2.4.2 把「项目文件夹在哪」收进了 `docfs.js`）——
 * 两处各拼一遍，改了一处另一处就悄悄指到别的地方。
 */
export function inspectSource(projectRoot, projectName, sourceRoot = '') {
  const projectDir = puzzleDirOf(projectRoot, projectName)
  if (projectDir === null) return { ok: false, error: '项目名不合法' }
  let recorded = ''
  try {
    const mainDoc = join(projectDir, MAIN_FILE)
    if (isFile(mainDoc)) recorded = parseSourceRoot(parseFrontMatter(readText(mainDoc) ?? '').fields)
  } catch (_error) {
    recorded = ''
  }
  const explicit = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  const fallback = projectFolderOf(projectRoot, projectName) ?? projectDir
  const base = resolve(explicit !== '' ? explicit : (recorded !== '' ? recorded : fallback))
  let baseOk = false
  try {
    baseOk = statSync(base).isDirectory()
  } catch (_error) {
    baseOk = false
  }
  if (!baseOk) {
    return {
      ok: false,
      base,
      error: '源码目录不存在或读不了：' + base,
      hint: '把源码根记进主文档（op:source 带 path），或调用时显式给 sourceRoot。',
    }
  }
  const files = collectSourceFiles(base)
  if (files.length === 0) {
    return {
      ok: true,
      base,
      fileCount: 0,
      totalLines: 0,
      files: [],
      largest: null,
      oversized: [],
      longestFunction: null,
      dirs: [],
      findings: [],
      note: '在 ' + base + ' 下没有找到源码文件。**这不代表代码没问题，只代表没查到**——'
        + '源码若在别处，请用 op:source 带 path 指过去。',
    }
  }

  const totalLines = files.reduce((sum, item) => sum + item.lines, 0)
  // 相对路径：`lib/a/index.ts` 与 `src/b/index.ts` 必须能区分。老实现只留 basename，
  // 两条不同路径会被去重成一条，命中一个文件的扣分会错误地摊给引用同名文件的其它模块。
  for (const item of files) item.rel = relPath(base, item.file)
  const sorted = files.slice().sort((left, right) => right.lines - left.lines)
  const oversized = files
    .filter((item) => item.lines >= SOURCE_RULES.fileLinesWarn)
    .map((item) => ({ file: item.rel, name: item.rel, lines: item.lines }))
    .sort((left, right) => right.lines - left.lines)

  // 目录分层：看源码落在几个不同目录里。
  const dirSet = new Set(files.map((item) => {
    const rel = item.rel
    const at = rel.lastIndexOf(sep)
    return at < 0 ? '.' : rel.slice(0, at)
  }))
  const dirs = [...dirSet].sort()

  // 函数形状：**对每个文件**跑（老实现只跑最大的那个，其余文件的巨函数永不发现），
  // 结果带 `file`，于是巨函数能独立归因，不再依赖「文件大」这个代理信号。
  const longFunctions = []
  let longFunctionsSkipped = 0
  const shapeOf = new Map()
  const wrappers = new Set()
  for (const item of files) {
    const lines = item.text.split(/\r?\n/)
    // 打包器/模块加载器的外壳文件（`__ModuleLoader__.load({…})`、`define(…)`、
    // `System.register(…)`）整份就是一个闭包，拆不动也拆不得。
    // 报「一个 2600 行的函数」是**真的**（它确实是一个闭包），但对读者毫无用处：
    // 它不能被拆成小函数，改了还会破坏加载契约。所以单独标出来，不混进巨函数清单。
    if (isBundleWrapper(lines)) {
      wrappers.add(item.rel)
      shapeOf.set(item.rel, { count: 0, longest: 0, average: 0 })
      continue
    }
    const result = longFunctionsIn(lines)
    // 「最长函数」用于判断承重模块：这里不限阈值取全量函数，好算平均与最长。
    const functions = longFunctionsIn(lines, 1, Number.MAX_SAFE_INTEGER).functions
    const longest = functions.length > 0 ? functions[0].lines : 0
    const average = functions.length === 0 ? 0 : Math.round(functions.reduce((sum, fn) => sum + fn.lines, 0) / functions.length)
    shapeOf.set(item.rel, { count: functions.length, longest, average })
    for (const fn of result.functions) {
      longFunctions.push({ file: item.rel, name: item.rel, at: fn.at, lines: fn.lines })
    }
    longFunctionsSkipped += result.skipped
  }
  longFunctions.sort((left, right) => right.lines - left.lines)
  const biggest = sorted[0]
  const biggestShape = shapeOf.get(biggest.rel) ?? { count: 0, longest: 0, average: 0 }
  const longestFn = longFunctions.length > 0 ? longFunctions[0] : { file: biggest.rel, at: 0, lines: biggestShape.longest }

  const findings = []
  // 规则一：**形状**判据，不是行数判据。
  //
  // 行数超阈值只是「提示去看」的信号，不是「判定有病」的证据：工程化是一棵树，
  // 树干粗不是病。这条规则**永远只出 info**（不扣分）：
  //   - 大文件 + 函数都小 → 「承重模块，函数粒度健康」，明确告诉读者**别拆文件**；
  //   - 大文件 + 有超长函数 → 指出「问题不是行数，是第 N 行那个函数」，
  //     真问题（fail/warn）由下面的 `source_long_function` 承担，**不重复扣分**。
  for (const item of oversized) {
    const shape = shapeOf.get(item.file) ?? { count: 0, longest: 0, average: 0 }
    const shapeText = item.lines + ' 行，' + shape.count + ' 个函数（平均 ' + shape.average + ' 行、最长 ' + shape.longest + ' 行）'
    if (wrappers.has(item.file)) {
      findings.push({
        id: 'source_bundle_wrapper',
        level: 'info',
        file: item.file,
        fact: item.file + ' ' + item.lines + ' 行，是打包器 / 模块加载器的外壳（整份就是一个闭包）：'
          + '函数粒度这一项对它不适用。',
        fix: '不要为了行数去拆它——拆了会破坏加载契约。它的健康度取决于它**装载**的那些源文件。',
      })
      continue
    }
    const worst = longFunctions.find((fn) => fn.file === item.file)
    const bad = worst !== undefined
    findings.push({
      id: 'source_big_file',
      level: 'info',
      // `file` 只给「能归到某一个文件」的发现。模块级真实值靠它做过滤：
      // 没有 `file` 的是**项目级**事实（如「只有 3 个文件」），只算在项目头上。
      file: item.file,
      fact: item.file + ' ' + shapeText + (bad
        ? '——问题不是行数，是第 ' + worst.at + ' 行起那个约 ' + worst.lines + ' 行的函数。'
        : '——函数粒度健康，属承重模块，规模大是正常的。'),
      fix: bad
        ? '拆的是那个**函数**，不是这个文件：把函数体按步骤拆成几个小函数，每步一个名字。文件本身可以继续是承重模块。'
        : '不必拆文件。要拆就拆**函数**：这份文件里没有超长函数，先别动它。',
    })
  }
  // 规则二：一个文件装下整个项目。
  if (files.length <= SOURCE_RULES.fewFilesMax && totalLines >= SOURCE_RULES.totalLinesMin) {
    findings.push({
      id: 'source_too_few_files',
      level: 'fail',
      fact: '整个项目只有 ' + files.length + ' 个源码文件，却共 ' + totalLines + ' 行（' + dirs.length + ' 个目录）。',
      fix: '这是「一个文件装下整个项目」的形态：模型改任何一处都要先读完整文件，施工难度与出错率都会陡增。先按职责切成 4-8 个文件。',
    })
  }
  // 规则三：巨函数——**独立规则，带 file**，不再挂在「文件大」上。
  // 文件小但函数巨（300 行里塞一个 260 行函数）也能被命中；老实现完全漏掉这种。
  for (const fn of longFunctions) {
    const level = fn.lines >= SOURCE_RULES.functionLinesFail ? 'fail' : 'warn'
    findings.push({
      id: 'source_long_function',
      level,
      file: fn.file,
      fact: fn.file + ' 第 ' + fn.at + ' 行起有一个约 ' + fn.lines + ' 行的函数（阈值 '
        + SOURCE_RULES.functionLinesWarn + ' 行）。',
      fix: '把函数体按步骤拆成几个小函数，每步一个名字——名字就是文档，也是可测试点。',
    })
  }
  if (longFunctionsSkipped > 0) {
    findings.push({
      id: 'source_long_function',
      level: 'warn',
      fact: '另有 ' + longFunctionsSkipped + ' 个函数也超过 ' + SOURCE_RULES.functionLinesWarn
        + ' 行，未逐条列出（上限 ' + SOURCE_RULES.longFunctionMax + ' 条）。',
      fix: '先修最长的几个；修完再看这份体检，清单会接着往下报。',
    })
  }
  // 规则四：没有目录分层。
  if (files.length >= 6 && dirs.length === 1) {
    findings.push({
      id: 'source_flat',
      level: 'warn',
      fact: files.length + ' 个源码文件全在同一层目录（' + dirs[0] + '）。',
      fix: '按角色分目录（如 lib/ 纯逻辑、bin/ 入口、test/ 测试），让「东西该放哪」有答案。',
    })
  }
  // 规则五：导出符号零引用（轻量死代码扫描）。
  //
  // 老实现完全没有这一项，而 prompt 却让模型「找冗余 / 死代码」——暗示了一个不存在的能力。
  // 这里给一个**粗但真**的版本：对每个 `export function/const/class` 的名字做全项目文本计数，
  // 只在自己声明处出现（计数 ≤1）就报 `info`。**info 不参与扣分**：文本计数会漏掉
  // 「经 barrel re-export 后被外部消费」与「动态引用」，只作为「值得看一眼」的线索。
  //
  // **按文件归组**，一个文件只出一条：逐条列会把清单刷满（一个 30 函数的大文件
  // 能刷出 30 条 info），真问题反而被埋掉。
  const dead = findDeadExports(files)
  for (const item of dead.groups) {
    const shown = item.names.slice(0, SOURCE_RULES.deadExportShowMax)
    const more = item.names.length - shown.length
    findings.push({
      id: 'source_dead_export',
      level: 'info',
      file: item.file,
      fact: item.file + ' 有 ' + item.names.length + ' / ' + item.total + ' 个导出符号在本项目里找不到第二处引用：'
        + shown.map((one) => one.name + '（第 ' + one.at + ' 行）').join('、')
        + (more > 0 ? '，另有 ' + more + ' 个' : '')
        + '。文本计数，可能被 barrel / 动态引用漏掉。',
      fix: '逐个确认是否真没人用：真没人用就删掉（死代码会误导读者，也会让人以为有这条路径）。'
        + '若是经 re-export 对外暴露的公共 API，就在源码索引里记一笔，让计数有据可查。'
        + (item.total > item.names.length
          ? '⚠️ 这份文件导出很多（' + item.total + ' 个），可能是**对外 API 面**——'
            + '那种情况下内部零引用是正常的，先看导出少、或整份都没人引用的文件。'
          : ''),
    })
  }
  if (dead.skippedFiles > 0) {
    findings.push({
      id: 'source_dead_export',
      level: 'info',
      fact: '另有 ' + dead.skippedFiles + ' 个文件也有疑似零引用的导出符号，未逐条列出（每文件一条，上限 '
        + SOURCE_RULES.deadExportMax + ' 条）。',
      fix: '先看最可疑的几个；确认无用就删，有用就在主文档源码索引里记出处。',
    })
  }

  return {
    ok: true,
    base,
    fileCount: files.length,
    totalLines,
    files: sorted.map((item) => ({ name: item.rel, lines: item.lines })),
    largest: { name: biggest.rel, lines: biggest.lines },
    oversized,
    // 形状是**主判据**：巨函数独立成表，不再依附于「最大的那个文件」。
    longFunctions,
    longFunctionsSkipped,
    longestFunction: { file: longestFn.file, at: longestFn.at, lines: longestFn.lines },
    deadExports: dead.groups,
    dirs,
    avgLines: Math.round(totalLines / files.length),
    findings,
  }
}

/**
 * 打包器 / 模块加载器的外壳文件：整份就是一个闭包，函数粒度对它不适用。
 *
 * 判据保守：文件里出现 `__ModuleLoader__.load(`、`System.register(`、`define(`，
 * 或**整份文件只有一个顶层函数且行数占文件九成以上**（`load({ factory: () => {…} })` 的形态）。
 * 宁可漏判（当作普通文件报巨函数），也不要误判——误判会把真巨函数藏起来。
 */
function isBundleWrapper(lines) {
  const head = lines.slice(0, 40).join('\n')
  if (/__ModuleLoader__\.load\s*\(/.test(head)) return true
  if (/^\s*System\.register\s*\(/m.test(head)) return true
  if (/^\s*define\s*\(\s*\[/m.test(head)) return true
  return false
}

/** 绝对路径 → 相对 base 的路径，统一用 `/` 分隔（跨平台比较一致）。 */
function relPath(base, file) {
  const rel = file.slice(base.length + 1)
  return sep === '/' ? rel : rel.split(sep).join('/')
}

/**
 * 轻量死代码扫描：`export function/const/class/let` 的名字，全项目文本计数 ≤1 就报。
 *
 * 为什么只报 `info`：文本计数读不出语义——barrel re-export、动态引用、
 * 只在测试里用的导出都会误判。它给的是「值得看一眼」的线索，不是判决，
 * 所以**只进体检结果、不参与任何评分**。
 */
function findDeadExports(files) {
  const names = []
  const declarations = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm
  for (const item of files) {
    let match = declarations.exec(item.text)
    while (match !== null) {
      names.push({ name: match[1], file: item.rel, at: item.text.slice(0, match.index).split(/\r?\n/).length })
      match = declarations.exec(item.text)
    }
    declarations.lastIndex = 0
  }
  const byFile = new Map()
  const totals = new Map()
  for (const item of names) {
    totals.set(item.file, (totals.get(item.file) ?? 0) + 1)
    const re = new RegExp('\\b' + item.name.replace(/[$]/g, '\\$') + '\\b', 'g')
    let count = 0
    for (const file of files) {
      const found = file.text.match(re)
      if (found !== null) count += found.length
      if (count > 1) break
    }
    if (count > 1) continue
    if (!byFile.has(item.file)) byFile.set(item.file, [])
    byFile.get(item.file).push({ name: item.name, at: item.at })
  }
  const groups = [...byFile.entries()].map(([file, list]) => ({ file, names: list, total: totals.get(file) ?? list.length }))
  const kept = groups.slice(0, SOURCE_RULES.deadExportMax)
  return { groups: kept, skippedFiles: Math.max(0, groups.length - kept.length) }
}

/* --------------------------------- 状态读取 --------------------------------- */
