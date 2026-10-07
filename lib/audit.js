/**
 * 审查：规则化事实（findings）+ 可执行修复清单（fixPlanOf）+ 写提示词。
 *
 * **只给事实，不给分数结论**；也不代改源码——清单由模型/用户执行。
 *
 * 审查的口径（用户 2026-10 裁定）：审查**不再是「拆代码 + 看文档真实」这么简单**，
 * 它上升到**真正的执行方**：去找漏洞、找冗余、找落地问题，产出一份
 * 「文件:行 + 现状事实 + 具体改法 + 预期效果」的**可执行修复清单**。
 * 边界同样由用户裁定：**审查先出清单，用 ask_user_question 问过用户再动手改源码**，
 * 不是审查轮直接改（`AUDIT_PROMPT` 里写成硬规则）。
 *
 * 验收判据（预期数字 / 行为）：
 *   - `fixPlanOf(state, inspection, additions)` 恒返回 `{plan, additions, rejected}`，任何入参都不抛错（含 null / {}）；
 *   - `plan` 每条**恰好八个字段**：key / origin / kind / severity / target / fact / fix / expect；
 *   - **自动审查只报漏洞**（v0.30.0，用户裁定）：`plan` 里**不再出现** `kind: structure` 的
 *     结构类条目（巨函数 / 大文件 / 目录不分层 / 死导出）——唯一例外是「没查到源码」那条告警；
 *   - 没查到源码（`inspection` 为 null、`ok !== true`、或 `fileCount === 0`）时，
 *     只有那一条 structure 告警如实写「没查到源码」，**不编造**任何代码问题；
 *   - `inspection.findings` 里的 `source_*` **不进 plan**（照旧留在 `findings` 供手动审查）；
 *     每个 `entryIssues` 条目 → 1 条 doc；每个 `mainEntryIssues` 条目 → 1 条 doc；
 *     每条规范外小节 → 1 条 doc；
 *     声明分高出文档证据 ≥ 15 分 → 1 条 health（阈值与 `source.js` 的 inflation 一致）；
 *   - `additions` 里 kind / target(文件:行) / fact / fix / expect 缺一的条目 → 进 `rejected`，不进 `plan`；
 *   - `recheckPlan(previousKeys, plan)` 分出 resolved / remaining；没给 keys 时返回 null。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { PUZZLE_VERSION, PUZZLE_DIR, MAIN_FILE, MODULE_DIR, SECTION_ORDER, SECTION_HEADINGS, MODULE_SECTION_HEADINGS, DEFAULT_SIZE, capsOfSize } from './constants.js'
import { finding } from './util.js'
import { getSection } from './frontmatter.js'
import { countItems } from './entries.js'
import { HEALTH_DIMENSIONS, HEALTH_KEYS, DIMENSION_FIX, dimensionName, evidenceOf } from './health.js'
// ⚠️ v0.30.0 起**不再 import `SOURCE_RULES`**：结构类发现不进自动清单了，
// 那个阈值（healthyTrunkMax）只有旧的「大文件兜底」那段在用，整段已删。
// 源码体检本身仍在 `lib/source.js` 里照常算，手动审查看 findings。


/**
 * 给模型照着**执行**的指令。**不生成清单正文、不代改代码**——那是模型 + 用户的事。
 *
 * 与旧版的关键差别：主线从「写点评 + 改分数」换成「出可执行修复清单 + 问过用户再动手」。
 * 五维改真实值仍在，但**降级为清单里的一类条目**（kind: health）。
 */
export const AUDIT_PROMPT = [
  '现在你是**执行方**，不是评论员：审查的产出是一份**可执行修复清单**，不是一段点评。',
  '',
  '### 〇、自动审查只报漏洞（用户裁定，v0.30.0）',
  '**自动审查只找代码漏洞和修复漏洞。** 结构类问题（巨函数、大文件、目录不分层、死导出）',
  '**不进 `fixPlan`**——它们是重构建议，不是缺陷；混进来会淹掉真正的漏洞。',
  '要看那些：`findings` 里 `id` 以 `source:` 开头的条目**照旧全在**（含文件与行号），',
  '**手动审查**时读它们即可。所以本轮**不要**把「这个函数太长 / 文件太大 / 目录太平」写进清单。',
  '',
  '### 一、先看返回里的 `fixPlan`（插件已把可测量的事实翻成清单）',
  '每条固定六字段：`kind`（vulnerability / redundancy / doc / health）、`severity`（high / medium / low）、',
  '`target`（文件:行 或 文档小节）、`fact`（现状事实，带数字）、`fix`（具体改法）、`expect`（预期效果），外加一个 `key`（复测用）。',
  '你要做两件事：',
  '1. 逐条核对 `fact` 是否与 `findings` / `source` / `inflation` 对得上；对不上就直说，不要顺着写。',
  '2. **补插件给不出的两类，并把它们回传**——`kind: vulnerability` 与 `kind: redundancy`。',
  '   这是本轮的**主线**：自动审查只报漏洞，而漏洞恰好是插件唯一测不出的那一类。',
  '   插件只测行数、函数形状、目录分层与「导出符号文本计数」，**读不到函数体语义**，所以这两类它编不出来：',
  '   - 漏洞：边界（空数组 / 空串 / 0 个模块）、空值（`null` / `undefined` 未兜底）、',
  '     竞态（异步读写同一文件、先检查后使用）、错误被吞掉（`catch (_error) {}` 什么都不做）、',
  '     路径越界（`join` 后没校验是否还在根目录内、`..` 未过滤）。每条都必须给出 `文件:行`。',
  '   - 冗余：重复实现（两处算同一件事）、死代码（导出后无人调用）、可合并的抽象。',
  '   **回传方式**（不回传 = 它们不在清单里、复测也无从核对）：',
  '   `puzzle_mode{op:"audit", additions:[{kind:"vulnerability", severity:"high", target:"lib/x.js:120",',
  '   fact:"…", fix:"…", expect:"…"}, …]}`。插件会校验四段齐全且 `target` 带 `文件:行`，',
  '   合并进 `fixPlan` 并参与复测。校验不通过会**整条退回**并说明原因，别改写后重试同一句空话。',
  '',
  '### 二、每条必须写全四段（缺一段就是空话）',
  '`文件:行` + 现状事实（带数字）+ 具体改法（动哪个函数、拆成什么、加什么守卫）+ 预期效果。',
  '**禁止**「建议优化」「可以改进」「注意健壮性」这类没有落点的句子——写不出 `文件:行`，就说明你还没读代码。',
  '',
  '### 三、动手边界（硬规则，不许绕）',
  '1. 先把清单**给用户看**，并用 `ask_user_question` 问「哪些现在就改」（多选，按 `severity` 从高到低排）。',
  '2. **用户点了的才改源码**；没点的只留在清单里。用户没点头就改源码 = 违规。',
  '3. 改完**必须重跑一次 `op:audit`** 复测，并把上一轮的 `key` 数组原样带上：',
  '   `puzzle_mode{op:"audit", previousKeys:[…上一轮 fixPlan 的 key…]}`。',
  '   返回里的 `recheck.resolved` 是已消失的条目、`recheck.remaining` 是还在的——',
  '   没消失就是没改到点子上，如实说，别宣布修好了。',
  '4. 审查轮本身**不改源码**：审查只出清单，动手是下一轮、且有用户点头之后。',
  '',
  '### 四、五维分数（降级为清单里的一项，不再是审查主线）',
  '`inflation` 里 `declared` 是手写值、`trueValue` 是由文档证据 + 源码体检算出的真实值、`gap` 是差额。',
  '`ranking` / `weakest` 都是**按真实值**算的（与 `trueDimensions` 同一口径）；`declaredRanking` 才是手写值那套，',
  '两者不一致时，以真实值为准，并可以另说一句差异在哪。',
  '对 `kind: health` 的每条，用 `puzzle_mode{op:"health", name:"<模块名>", content:"<维度名>: <trueValue>…", append:false}`',
  '**一次把该模块五维都写上**（别只改被点名的那一维）。全局值不用手写（宿主按模块均值汇总）。',
  '**不许反过来**：不要为了保住高分去改文档凑证据——分数是结论，不是目标。',
  '',
  '### 五、两类条目级发现优先清（它们让「条数很多」变成假象）',
  '`entry_issue` / `main_entry_issue` 说明条目本身不合规格（超字数，或缺 `（源码: 文件:行）`）。',
  '修法固定：`op:main` / `op:module` 带 `append:false` 重写那一节。',
  '`fixPlan` 里 `kind: doc` 的条目**先清完**，再谈代码——不然数字漂亮、规格全破。',
  '',
  '### 六、诚实边界（插件能测什么 / 不能测什么）',
  '- **能测**：文件行数与函数形状（巨函数、承重模块）、文件数与目录分层、导出符号的文本计数。',
  '  ⚠️ 但按「〇」的裁定，**这些只写进 `findings`、不进 `fixPlan`**——所以别指望清单里出现它们。',
  '- **不能测**：函数体语义——真实漏洞、竞态、空值兜底、语义级冗余，**插件一概不测**，全靠你读代码补。',
  '  所以看到 `fixPlan` 里没有漏洞类条目，**不等于**没有漏洞。',
  '- 「文件大」本身**不是**缺陷：大文件里函数都小就是健康的承重模块（插件只出 `info`）。',
  '  要拆的是**函数**，不是文件——但那属于**手动审查**的活，本轮不要写进清单。',
  '- 某维 `fromSource` 是 `null` 表示**没有源码可查**（或该模块引用的文件都不存在），那一维不是实测值——要如实说。',
  '- `inspection.ok !== true` 时 `fixPlan` 只有一条「没查到源码」的告警条目：**不许编**代码问题；',
  '  先让用户用 `op:source` 指对源码根，再重跑审查。',
  '- 最后一句：这个项目现在最该补的**一件事**是什么（只能是一件）。',
].join('\n')


/** 主文档各节的证据条数（去掉空行与模板占位）。 */
export function sectionCounts(body) {
  const out = {}
  for (const key of SECTION_ORDER) out[key] = countItems(getSection(body, SECTION_HEADINGS[key]) ?? '')
  return out
}

/** 五维按分数升序排列——审查先说最弱的那一维。 */


/** 五维按分数升序排列——审查先说最弱的那一维。 */
export function dimensionRanking(dimensions) {
  const source = dimensions !== null && typeof dimensions === 'object' ? dimensions : {}
  return HEALTH_KEYS
    .map((key) => ({ key, name: dimensionName(key), value: source[key] ?? 0 }))
    .sort((left, right) => left.value - right.value)
}


/**
 * 把当前状态过一遍，输出**客观发现清单**。只陈述事实，不做评价。
 *
 * 不抛错：状态缺字段一律按 0 处理（未初始化的项目也会走到这里）。
 *
 * `trueDimensions`（可选）：五维**真实值**。给了就用它算「最弱一维」，否则退回
 * `state.dimensions`（手写值）。为什么要这个参数：审查的主线是「用真实值纠正手写值」，
 * 而最弱维以前按手写值算，会和同一份返回里的 `trueDimensions` / `ranking` 互相矛盾——
 * 一次审查里三个数字讲三个故事，还会优先引导模型去修一个其实已经满分的维度。
 */
export function auditOf(state, trueDimensions = null) {
  const safe = state !== null && typeof state === 'object' ? state : {}
  const modules = Array.isArray(safe.modules) ? safe.modules : []
  const sections = safe.sections !== null && typeof safe.sections === 'object' ? safe.sections : {}
  const dimensions = safe.dimensions !== null && typeof safe.dimensions === 'object' ? safe.dimensions : {}
  const findings = []

  // 旧格式先报：它是「数字可能偏低」的上游原因，排在其它发现前面。
  if (safe.outdated === true) {
    findings.push(finding('doc_outdated', 'warn', null, 'project',
      '文档格式是 puzzle ' + (safe.version ?? '?') + '，当前是 ' + PUZZLE_VERSION + '：旧格式主文档有六个小节（含已取消的 用户原话 / 撤销），模块文档缺 ## 悬而未决 / ## 已定，五维只能靠推导，分数会偏低。',
      "用 op:rebuild 看预览（默认 dry-run），确认后 apply:true 迁移；它只改形状，正文不动。"))
  }

  if (modules.length === 0) {
    findings.push(finding('no_modules', 'blocker', null, 'project',
      '项目里一个模块都没有，五维无从算起，项目健康性是 0。',
      '用 op:init 带 modules 一次建齐，或用 op:module 建第一个模块。'))
  }

  // 规范之外的小节：主文档只允许规范里的那几节、模块文档只允许固定几节。
  // 必须**报出来**——它们既读不进任何 op，也不会被写入覆盖，只能靠 rebuild 清掉；
  // 不报就等于默认它们不存在（实测就是这么漏掉的）。
  for (const name of Array.isArray(safe.extraMainSections) ? safe.extraMainSections : []) {
    findings.push(finding('unknown_section:main:' + name, 'warn', null, 'project',
      '主文档有一个规范之外的小节「' + name + '」：它不属于任何规范小节，op:main 写不到它，也不会被覆盖。',
      '用 op:rebuild 迁移（它会删掉非规范小节）；内容若有用，先搬进某个规范小节或对应的模块文档。'))
  }
  for (const item of Array.isArray(safe.extraModuleSections) ? safe.extraModuleSections : []) {
    findings.push(finding('unknown_section:' + item.name + ':' + item.heading, 'warn', null, item.name,
      '模块「' + item.name + '」有一个规范之外的小节「' + item.heading + '」：op:module 写不到它。',
      '用 op:rebuild 迁移（它会删掉非规范小节）；内容若有用，先搬进规范小节。'))
  }

  // 主文档只留规范小节，其中「坑」是所有模块共用的项目级证据。
  if ((sections.pit ?? 0) === 0) {
    findings.push(finding('pit_empty', 'warn', 'quality', 'project',
      '主文档「坑」0 条：踩过的坑没有沉淀下来，代码质量这一维只能靠模块的「已定」撑。',
      DIMENSION_FIX.quality))
  }
  if ((sections.source ?? 0) === 0) {
    findings.push(finding('source_empty', 'info', null, 'project',
      '主文档「源码索引」0 条：查找方向是 主文档 → 源码，索引为空就只能靠翻目录。',
      '把关键实现文件用 op:main section:source 记进去（一句话 + 源码: 文件:行）。'))
  }
  if ((sections.tools ?? 0) === 0) {
    findings.push(finding('tools_empty', 'info', null, 'project',
      '主文档「工具索引」0 条：本项目用到的 op / 脚本 / 外部命令没有一处索引。',
      '把常用入口用 op:main section:tools 记进去（一句话 + 源码: 文件:行）。'))
  }

  // 主文档的条目也逐条验：任何一条超长/无出处，都是规格破了。
  // 只报**条数与样例**，不逐条刷屏。
  for (const issue of Array.isArray(safe.mainEntryIssues) ? safe.mainEntryIssues : []) {
    const parts = []
    if (issue.tooLong > 0) parts.push(issue.tooLong + ' 条超 ' + issue.limit + ' 字')
    if (issue.noSource > 0) parts.push(issue.noSource + ' 条没出处')
    if ((issue.noMethod ?? 0) > 0) parts.push(issue.noMethod + ' 条数字没测法')
    findings.push(finding('main_entry_issue:' + issue.key, 'warn', null, 'project',
      '主文档「' + issue.heading + '」有 ' + parts.join('、') + '（例：' + issue.sample + '…）。',
      '用 op:main section:' + issue.key + ' append:false 重写这一节：每条一句话（≤' + issue.limit + ' 字）+（源码: 文件:行）。'))
  }

  // 「五维全靠公式推」的模块先收集起来：全都如此时只报一条，免得刷屏。
  const unreviewed = []
  for (const module of modules) {
    const name = String(module.name ?? '?')
    const counts = module.counts ?? {}
    const evidence = module.evidence ?? {}
    const progress = module.progress

    if (module.exists !== true) {
      findings.push(finding('module_missing:' + name, 'warn', null, name,
        '模块「' + name + '」只有图块、没有文档，五维全 0。',
        '用 op:module name:' + name + ' section:points 写下第一段事实。'))
      continue
    }

    // 已存在的条目不受写入校验约束（迁移不追溯），所以这里逐条查——
    // 否则「要点 15 条」看着充实，实则 15 条全超长且全无出处。
    for (const issue of Array.isArray(module.entryIssues) ? module.entryIssues : []) {
      const parts = []
      if (issue.tooLong > 0) parts.push(issue.tooLong + ' 条超 ' + issue.limit + ' 字')
      if (issue.noSource > 0) parts.push(issue.noSource + ' 条没出处')
      if ((issue.noMethod ?? 0) > 0) parts.push(issue.noMethod + ' 条数字没测法')
      findings.push(finding('entry_issue:' + name + ':' + issue.key, 'warn', null, name,
        '模块「' + name + '」的「' + issue.heading + '」有 ' + parts.join('、') + '。',
        '用 op:module name:' + name + ' section:' + issue.key + ' append:false 重写这一节：每条一句话（≤'
        + issue.limit + ' 字）+（源码: 文件:行）。'))
    }

    const content = (counts.points ?? 0) + (evidence.detail ?? 0) + (counts.pending ?? 0) + (counts.decided ?? 0)
    if (content === 0) {
      findings.push(finding('module_empty:' + name, 'blocker', null, name,
        '模块「' + name + '」文档里 0 条要点、0 条详细记录、0 条决策：五维全 0。',
        '先补 ## 要点（2-3 条事实），再补 ## 详细记录；空文档没有健康性可谈。'))
    } else if ((counts.pending ?? 0) === 0 && (counts.decided ?? 0) === 0) {
      findings.push(finding('no_open_questions:' + name, 'warn', 'extensibility', name,
        '模块「' + name + '」既没有悬而未决也没有已定：可拓展性拿不到分。',
        DIMENSION_FIX.extensibility))
    }

    // 上限**随规模档位变**（小 / 中 / 大），不是固定 4 / 10。
    //
    // ⚠️ 这里曾写死 `ENTRY_CAPS[key]`（中档值），于是大档项目（已定 ≤30 条）
    // 会被报成「超过上限 10 条」——**每条合法决策都成了假发现**。
    // 这正是本仓记过的「两把尺子」：写入侧按档位放行、审查侧按中档报警。
    const sizeCaps = capsOfSize(safe.size)
    for (const key of ['pending', 'decided']) {
      const cap = sizeCaps[key]
      const count = counts[key] ?? 0
      if (count <= cap) continue
      findings.push(finding('over_cap:' + name + ':' + key, 'warn', 'extensibility', name,
        '模块「' + name + '」的「' + MODULE_SECTION_HEADINGS[key] + '」有 ' + count + ' 条，超过上限 ' + cap + ' 条。',
        '写入时会自动删最旧的，保留末尾 ' + cap + ' 条；也可以自己先用 op:module section:' + key + ' append:false 重写一份。'))
    }

    if (typeof progress === 'number' && progress >= 80 && (counts.points ?? 0) === 0) {
      findings.push(finding('progress_no_points:' + name, 'blocker', 'maintenance', name,
        '模块「' + name + '」完成度写 ' + progress + '，但要点 0 条。',
        '要么把要点补上（完成度才有依据），要么把完成度改成真实值。'))
    }

    for (const dimension of HEALTH_DIMENSIONS) {
      const source = (module.healthSources ?? {})[dimension.key]
      if (source !== 'module' && source !== 'project') continue
      if (evidenceOf(evidence, dimension.key) > 0) continue
      const score = (module.healthScores ?? {})[dimension.key] ?? 0
      findings.push(finding('declared_without_evidence:' + name + ':' + dimension.key, 'warn', dimension.key, name,
        '模块「' + name + '」的「' + dimension.name + '」手写了 ' + score + ' 分，但对应证据 0 条。',
        DIMENSION_FIX[dimension.key]))
    }

    const allDerived = HEALTH_KEYS.every((key) => (module.healthSources ?? {})[key] === 'derived')
    if (allDerived && module.health > 0) unreviewed.push(name)
  }

  if (unreviewed.length > 0) {
    const scope = unreviewed.length === modules.length && modules.length > 0 ? 'project' : unreviewed.join('、')
    findings.push(finding('never_reviewed', 'info', null, scope,
      unreviewed.length + ' 个模块的五维全是公式推出来的，没有一处人工判断：' + unreviewed.join('、') + '。',
      '对最弱的一维写显式分数并说明理由（## 健康性 里写「维度名: 分数」）。'))
  }

  // 最弱一维：**优先按真实值**（与返回里的 ranking / trueDimensions 同一口径）。
  // 只有拿不到真实值（`op:read` 路径不做源码体检）时才退回手写值，并在文案里标明口径。
  const trueSet = trueDimensions !== null && typeof trueDimensions === 'object' ? trueDimensions : null
  const ranking = dimensionRanking(trueSet ?? dimensions)
  const basis = trueSet === null ? '手写值' : '真实值'
  if (modules.length > 0 && ranking[0].value < 100) {
    findings.push(finding('weakest_dimension', 'info', ranking[0].key, 'project',
      '最弱一维（按**' + basis + '**）是「' + ranking[0].name + '」= ' + ranking[0].value + '%（跨模块均值）。',
      DIMENSION_FIX[ranking[0].key]))
  }
  // 手写值那套排名与真实值不一致时，另出一条 info——差异本身就是有价值的信息。
  if (trueSet !== null) {
    const declaredRanking = dimensionRanking(dimensions)
    if (declaredRanking.length > 0 && declaredRanking[0].key !== ranking[0].key) {
      findings.push(finding('ranking_mismatch', 'info', null, 'project',
        '按手写值最弱的是「' + declaredRanking[0].name + '」= ' + declaredRanking[0].value + '%，'
        + '按真实值最弱的是「' + ranking[0].name + '」= ' + ranking[0].value + '%：两者不一致。',
        '以真实值为准（它由文档证据 + 源码体检算出）；手写值偏高就按 `inflation` 改成真实值。'))
    }
  }

  // 源码工程化的发现**不在这里**：`auditOf` 由 `readState` 调用，而 `op:read` 每轮都跑，
  // 不该每次都去扫源码树。源码体检只在 `op:audit` 里做，发现由调用方并进返回。
  return findings
}

/* ------------------------------ 可执行修复清单 ------------------------------ */

/**
 * 把「客观发现」翻译成**可执行修复清单**。
 *
 * 为什么要有它（用户 2026-10 裁定）：审查要当**执行方**——找漏洞、找冗余、找落地问题，
 * 产出「文件:行 + 现状事实 + 具体改法 + 预期效果」。旧的审查止步于「写点评 + 改分数」，
 * 分数改了代码还是原样，等于没修。清单是**可执行**的：每条都能落到一个文件或一节文档。
 *
 * 边界（同样是用户裁定）：本函数**只出清单、不改源码**。动手要先给用户看清单、
 * 用 `ask_user_question` 问过「哪些现在就改」，用户点了才改，改完重跑 `op:audit` 复测。
 *
 * 数据来源与 `kind` 的对应：
 *   - `module.entryIssues` / `state.mainEntryIssues` / `state.extraMainSections` /
 *     `state.extraModuleSections` → `doc`；
 *   - 手写分高出文档证据 ≥ 15 分（阈值同 `source.js` 的 inflation）→ `health`；
 *   - `vulnerability` / `redundancy` **不由插件编**（体检读不到函数体），但**能收**：
 *     模型读代码后按 `AUDIT_PROMPT` 补的条目通过 `additions` 回传，本函数校验并合并，
 *     于是它们真的进入清单、也真的能参与复测（老实现只存在于模型的口头回答里）。
 *
 * ## 结构类（巨函数 / 大文件 / 目录不分层 / 死导出）**不进本清单**（v0.30.0）
 *
 * 用户裁定：「自动审查就不要再报巨函数问题了，这些留到手动审查再说，
 * 自动审查只找代码漏洞和修复漏洞」。
 *
 * 为什么这个收窄是对的：结构类是**重构建议**，不是缺陷——巨函数不会让代码跑错，
 * 只会让它难读。而自动审查每次都要给人一份「点单清单」，混进几十条「这个函数太长」
 * 会**淹掉真正的漏洞**：用户看到清单第一屏全是行数，就不会往下翻。
 *
 * 数据**照算照返回**：`inspection.findings` 里的 `source_*` 一条都没少，
 * 手动审查时读 `findings` 就能拿到（含行号与文件），零额外成本。
 * 本函数只是不再把它们翻译成清单条目。
 *
 * 每条清单项都带 `key`（`kind:target` 的稳定标识）与 `origin`（plugin / model）：
 * 复测时把上一轮的 key 数组传回来（`previousKeys`），就能算出哪些消失了、哪些还在。
 *
 * 纯函数：不抛错、不写盘、不引依赖。入参给 null / {} / 缺字段都按「没有」处理。
 *
 * @param {object} state `readState()` 的返回值。
 * @param {object} inspection `inspectSource()` 的返回值（可能是 `{ ok:false, error }`）。
 * @param {Array} additions 模型补的 vulnerability / redundancy 条目（可选）。
 * @returns {Array<{key:string, origin:string, kind:string, severity:string, target:string, fact:string, fix:string, expect:string}>}
 */
export function fixPlanOf(state, inspection, additions = null) {
  const safe = state !== null && typeof state === 'object' ? state : {}
  const modules = Array.isArray(safe.modules) ? safe.modules : []
  const seen = inspection !== null && typeof inspection === 'object' ? inspection : null
  const plan = []

  const mainDoc = PUZZLE_DIR + '/' + MAIN_FILE
  const moduleDoc = (name) => PUZZLE_DIR + '/' + MODULE_DIR + '/' + name + '.md'

  /* ---- 一、源码结构类发现：**不进清单**（v0.30.0，用户裁定） ----
   *
   * 这一段原先把 `inspection.findings` 里的 `source_*`（巨函数 / 大文件 /
   * 目录不分层 / 死导出）逐条翻成 `structure` 清单项。现在**整段不再产出清单条目**——
   * 那些发现仍然在 `findings` 里，手动审查时照旧能看。
   *
   * ⚠️ 不要「顺手」把这段删干净：`hasSource` 与 `base` 下面还要用（漏洞条目的落点
   * 与「没查到源码」的诚实边界都要它们）。删了会连带把「没做体检」这条也吞掉。
   */
  const hasSource = seen !== null && seen.ok === true && (seen.fileCount ?? 0) > 0
  const base = (seen !== null && typeof seen.base === 'string' && seen.base !== '')
    ? seen.base
    : (typeof safe.sourceRoot === 'string' && safe.sourceRoot !== '' ? safe.sourceRoot : '源码根')

  if (!hasSource) {
    // 诚实边界：**没查到源码就只说没查到**，绝不把「0 个文件」当成「代码很干净」，
    // 也不许编出任何文件级问题（那是无中生有）。
    //
    // 这条**保留在清单里**：它不是「结构建议」，而是一条**警告**——
    // 「这一轮没有实测漏洞」，正好是自动审查最该说清的事。
    const reason = seen === null
      ? '本次没有做源码体检（source:false 或调用方没传 inspection）。'
      : (seen.ok !== true
        ? '源码体检失败：' + String(seen.error ?? '未知原因')
        : '在 ' + base + ' 下没有找到源码文件。')
    plan.push({
      kind: 'structure',
      severity: 'medium',
      target: base,
      fact: '没查到源码：' + reason + ' —— 所以代码的漏洞 / 冗余 / 落地问题**这一轮没有实测**，不是「测出来没问题」。',
      fix: seen !== null && typeof seen.hint === 'string' && seen.hint !== ''
        ? seen.hint
        : '用 op:source 带 path 把源码根记进主文档，或 op:audit 时显式给 sourceRoot，然后重跑审查。',
      expect: '重跑 op:audit 后 source 段有 fileCount / totalLines / largest，结构类条目才作数。',
    })
  }
  // 结构类发现（巨函数 / 大文件 / 目录不分层 / 死导出）到此为止：**只算不报**。
  // 手动审查看 `op:audit` 返回的 `findings`（id 以 `source:` 开头）。

  /* ---- 二、文档条目与规范外小节（doc） ---- */
  for (const module of modules) {
    const name = String(module?.name ?? '?')
    for (const issue of Array.isArray(module?.entryIssues) ? module.entryIssues : []) {
      const parts = []
      if ((issue.tooLong ?? 0) > 0) parts.push(issue.tooLong + ' 条超 ' + issue.limit + ' 字')
      if ((issue.noSource ?? 0) > 0) parts.push(issue.noSource + ' 条没出处')
      if ((issue.noMethod ?? 0) > 0) parts.push(issue.noMethod + ' 条数字没测法')
      plan.push({
        kind: 'doc',
        severity: 'medium',
        target: moduleDoc(name) + ' ' + String(issue.heading ?? ''),
        fact: '模块「' + name + '」的「' + String(issue.heading ?? '') + '」有 ' + parts.join('、')
          + '（例：' + String(issue.sample ?? '') + '…）；条目本身不合规格，条数再多也不算证据。',
        fix: '用 op:module name:' + name + ' section:' + String(issue.key ?? '') + ' append:false 重写这一节：'
          + '每条一句话（≤' + (issue.limit ?? 0) + ' 字）+（源码: 文件:行）。',
        expect: '重跑 op:audit 时 entry_issue:' + name + ':' + String(issue.key ?? '') + ' 清零。',
      })
    }
  }

  for (const issue of Array.isArray(safe.mainEntryIssues) ? safe.mainEntryIssues : []) {
    const parts = []
    if ((issue.tooLong ?? 0) > 0) parts.push(issue.tooLong + ' 条超 ' + issue.limit + ' 字')
    if ((issue.noSource ?? 0) > 0) parts.push(issue.noSource + ' 条没出处')
    if ((issue.noMethod ?? 0) > 0) parts.push(issue.noMethod + ' 条数字没测法')
    plan.push({
      kind: 'doc',
      severity: 'medium',
      target: mainDoc + ' ' + String(issue.heading ?? ''),
      fact: '主文档「' + String(issue.heading ?? '') + '」有 ' + parts.join('、')
        + '（例：' + String(issue.sample ?? '') + '…）。',
      fix: '用 op:main section:' + String(issue.key ?? '') + ' append:false 重写这一节：'
        + '每条一句话（≤' + (issue.limit ?? 0) + ' 字）+（源码: 文件:行）。',
      expect: '重跑 op:audit 时 main_entry_issue:' + String(issue.key ?? '') + ' 清零。',
    })
  }

  for (const heading of Array.isArray(safe.extraMainSections) ? safe.extraMainSections : []) {
    plan.push({
      kind: 'doc',
      severity: 'medium',
      target: mainDoc + ' ' + String(heading),
      fact: '主文档有规范之外的小节「' + String(heading) + '」：op:main 写不到它，也不会被覆盖。',
      fix: '内容有用就先搬进某个规范小节或对应模块文档，再 op:rebuild（它会删掉非规范小节）。',
      expect: '重跑 op:audit 时 extraMainSections 为空。',
    })
  }

  for (const item of Array.isArray(safe.extraModuleSections) ? safe.extraModuleSections : []) {
    const name = String(item?.name ?? '?')
    plan.push({
      kind: 'doc',
      severity: 'low',
      target: moduleDoc(name) + ' ' + String(item?.heading ?? ''),
      fact: '模块「' + name + '」有规范之外的小节「' + String(item?.heading ?? '') + '」：op:module 写不到它。',
      fix: '内容有用就先搬进规范小节，再 op:rebuild 清掉这一节。',
      expect: '重跑 op:audit 时 extraModuleSections 里不再出现它。',
    })
  }

  /* ---- 三、声明分与真实值的虚高（health，降级为清单一项） ---- */
  // 这里只能用 `state` 里拿得到的声明值 + 文档证据算出的分做对比（纯函数，不做源码体检）。
  // 阈值 15 与 `source.js` 里 inflation 的判定一致，避免两处口径打架。
  // 项目级不另出一条：`state.dimensions` 本来就是各模块声明值的均值，逐模块列已经覆盖它。
  const inflated = new Set()
  for (const module of modules) {
    const name = String(module?.name ?? '?')
    if (module?.exists !== true) continue
    const evidence = module.evidence ?? {}
    for (const dimension of HEALTH_DIMENSIONS) {
      const declared = (module.healthScores ?? {})[dimension.key]
      if (typeof declared !== 'number') continue
      const fromDoc = dimension.derive(evidence)
      const gap = declared - fromDoc
      if (gap < 15) continue
      inflated.add(name + ':' + dimension.key)
      plan.push({
        kind: 'health',
        severity: gap >= 30 ? 'high' : 'medium',
        target: moduleDoc(name) + ' ' + MODULE_SECTION_HEADINGS.health,
        fact: '模块「' + name + '」的「' + dimension.name + '」手写 ' + declared + ' 分，'
          + '按文档里的证据只能推出 ' + fromDoc + ' 分（差 ' + gap + ' 分）。',
        fix: '用 op:health name:"' + name + '" content:"…: ' + fromDoc + '…" append:false '
          + '把该模块五维一次改成真实值（别只改这一维）。',
        expect: '重跑 op:audit 时 inflation 里不再出现「' + name + ' / ' + dimension.name + '」。',
      })
    }
  }

  // 手写了分但一条证据都没有：分数还没到 15 分差也要报（它同样是「自己封的分」）。
  for (const item of Array.isArray(safe.findings) ? safe.findings : []) {
    const id = String(item?.id ?? '')
    if (!id.startsWith('declared_without_evidence:')) continue
    if (inflated.has(id.slice('declared_without_evidence:'.length))) continue
    plan.push({
      kind: 'health',
      severity: 'medium',
      target: mainDocOrModule(id.slice('declared_without_evidence:'.length), moduleDoc),
      fact: String(item.fact ?? '手写了分数但对应证据 0 条。'),
      fix: String(item.fix ?? DIMENSION_FIX.quality),
      expect: '要么证据补上，要么分数改成真实值——重跑 op:audit 时这条不再出现。',
    })
  }

  /* ---- 四、其余客观发现（文档类 → doc，健康/流程类 → health） ---- */
  // `entry_issue` / `main_entry_issue` / `unknown_section` / `source:*` 已在上面各段处理过，
  // 这里跳过，免得同一件事在清单里出现两遍（清单里重复项会让人以为问题更多）。
  for (const item of Array.isArray(safe.findings) ? safe.findings : []) {
    const id = String(item?.id ?? '')
    if (id === '') continue
    if (id.startsWith('entry_issue:') || id.startsWith('main_entry_issue:')) continue
    if (id.startsWith('unknown_section:') || id.startsWith('declared_without_evidence:')) continue
    if (id.startsWith('source:')) continue
    const healthish = id.startsWith('progress_no_points:') || id.startsWith('no_open_questions:')
      || id === 'never_reviewed' || id === 'weakest_dimension'
    plan.push({
      kind: healthish ? 'health' : 'doc',
      severity: severityOfLevel(item.level),
      target: targetOfFinding(id, item.scope, mainDoc, moduleDoc),
      fact: String(item.fact ?? ''),
      fix: String(item.fix ?? ''),
      expect: healthish
        ? '重跑 op:audit 时这条发现不再出现（真实值应当随之回升）。'
        : '重跑 op:audit 时这条发现不再出现。',
    })
  }

  // 排序：severity 高的在前（清单是给人点单用的，先看最该修的）。
  // 同级保持上面各段的顺序（V8 的 sort 稳定），所以同类问题仍然聚在一起。
  const kindRank = { vulnerability: 0, redundancy: 1, structure: 2, doc: 3, health: 4 }
  const severityRank = { high: 0, medium: 1, low: 2 }
  const ordered = plan.sort((left, right) => (
    (severityRank[left.severity] ?? 3) - (severityRank[right.severity] ?? 3)
    || (kindRank[left.kind] ?? 9) - (kindRank[right.kind] ?? 9)
  ))
  for (const item of ordered) {
    item.origin = 'plugin'
    item.key = planKey(item.kind, item.target, item.fact)
  }
  // 模型回传的漏洞 / 冗余：校验后合并进清单，让它们**真的**能参与复测。
  const { accepted, rejected } = normalizeAdditions(additions)
  for (const item of accepted) {
    ordered.unshift(item)
  }
  return { plan: ordered, additions: accepted, rejected }
}

/**
 * 校验模型回传的 `additions`（vulnerability / redundancy）。
 *
 * 为什么要有校验：这两类是**模型自己写的事实断言**，插件测不出来。放开不问，
 * 清单里就会混进「建议优化」这类没有落点的话——那正是审查要消灭的东西。
 * 所以四段（fact / fix / expect）+ `target` 带 `文件:行` 缺一不可，缺了就**整条退回**
 * 并说明原因，而不是静默丢弃（静默丢弃会让模型以为已经进了清单）。
 */
export function normalizeAdditions(additions) {
  const accepted = []
  const rejected = []
  if (!Array.isArray(additions)) return { accepted, rejected }
  for (const raw of additions) {
    const item = raw !== null && typeof raw === 'object' ? raw : {}
    const kind = String(item.kind ?? '').trim()
    const target = String(item.target ?? '').trim()
    const fact = String(item.fact ?? '').trim()
    const fix = String(item.fix ?? '').trim()
    const expect = String(item.expect ?? '').trim()
    const reason = kind !== 'vulnerability' && kind !== 'redundancy'
      ? 'kind 只能是 vulnerability 或 redundancy（structure / doc / health 由插件自己算）'
      : (target === '' || !/:\d+/.test(target)
        ? 'target 必须是「文件:行」（例如 lib/source.js:136）——写不出行号就说明还没读代码'
        : (fact === '' || fix === '' || expect === ''
          ? 'fact / fix / expect 三段缺一不可（缺一段就是空话）'
          : null))
    if (reason !== null) {
      rejected.push({ kind: kind === '' ? '?' : kind, target: target === '' ? '?' : target, reason })
      continue
    }
    const severity = ['high', 'medium', 'low'].includes(String(item.severity)) ? String(item.severity) : 'medium'
    accepted.push({
      kind,
      severity,
      target,
      fact,
      fix,
      expect,
      origin: 'model',
      key: planKey(kind, target, fact),
    })
  }
  return { accepted, rejected }
}

/** 清单项的稳定标识：`kind:target:fact`（复测靠它比对，不靠数组下标）。 */
function planKey(kind, target, fact) {
  return [kind, String(target ?? ''), String(fact ?? '')].join(':')
}

/**
 * 复测：把上一轮的 key 与这一轮的清单比对，分出「已消失」与「仍在」。
 *
 * 为什么必须有它：审查承诺「改完重跑一次，条目应当消失」。没有这个比对，
 * 「消失了没」只能靠模型自己回忆上一轮有哪些条目——它记不住，于是永远宣布修好了。
 * `resolved` 只说明**清单里不再有这一条**，不等于「代码已经对了」（改错了也会消失），
 * 所以返回文案里如实标注这一点。
 */
export function recheckPlan(previousKeys, plan) {
  const keys = Array.isArray(previousKeys) ? previousKeys.filter((one) => typeof one === 'string' && one !== '') : []
  if (keys.length === 0) return null
  const now = new Set((Array.isArray(plan) ? plan : []).map((item) => item.key))
  const resolved = []
  const remaining = []
  for (const key of keys) {
    if (now.has(key)) remaining.push(key)
    else resolved.push(key)
  }
  return {
    checked: keys.length,
    resolved,
    remaining,
    note: '`resolved` 只表示这一轮清单里不再出现该条目（条目消失 = 插件/模型没再报它），'
      + '**不等于**代码一定改对了——改错方向、或把发现藏起来也会消失。'
      + '代码正确性仍要靠读代码与真机验收。'
      + '⚠️ 模型回传（`additions`）的条目**不会自动延续**：它们由模型每轮重新给出，'
      + '所以这一轮没再传回来的 `origin:model` 条目会显示成 resolved——那是「没再说」不是「已修好」。',
  }
}

/** 体检发现的 `level` → 清单的 `severity`（fail/blocker 是必须修的）。 */
function severityOfLevel(level) {
  const value = String(level ?? '')
  if (value === 'fail' || value === 'blocker') return 'high'
  if (value === 'warn') return 'medium'
  return 'low'
}

/**
 * 结构类发现的「预期效果」文案表——**v0.30.0 起不再被调用**。
 *
 * 为什么留着而不是删掉：结构类发现（巨函数 / 大文件 / 目录不分层 / 死导出）
 * 现在不进自动清单了（用户裁定），但**手动审查**时仍要看 `findings` 里那些
 * `source_*` 条目。这份表是「每条结构发现该怎么修」的唯一沉淀——
 * 删了它，下次谁想给手动审查补上「怎么改」就得从头再想一遍。
 *
 * 用 `expectOfSource` 保持可达：它是 `export` 的纯函数，测试直接钉它的返回值，
 * 所以不会因为「没人调用」被当成死代码删掉。
 */
export function expectOfSource(id) {
  if (id === 'source_big_file') return '拆的是那个超长**函数**，不是文件——拆完后重跑 op:audit 时这条清零，文件仍可以是承重模块。'
  if (id === 'source_too_few_files') return '切成 4-8 个文件后，「一个文件装下整个项目」消失，可拓展性真实值回升。'
  if (id === 'source_long_function') return '拆成若干小函数（每个 ≤60 行）后，每一步都能单独改、单独看。'
  if (id === 'source_flat') return '按角色分目录后，「新文件该放哪」有答案，不再全堆在一层。'
  if (id === 'source_bundle_wrapper') return '打包器外壳拆不得——它的健康度取决于它装载的源文件，不要为了行数动它。'
  if (id === 'source_dead_export') return '确认无用就删掉（死代码会误导读者）；确属公共 API 就在源码索引里记出处。'
  return '该条体检事实消失，重跑 op:audit 时对应发现清零。'
}

/** 文档类发现的落点：主文档还是某个模块文档。 */
function targetOfFinding(id, scope, mainDoc, moduleDoc) {
  const at = id.indexOf(':')
  const tail = at < 0 ? '' : id.slice(at + 1)
  if (id.startsWith('no_modules') || id === 'doc_outdated' || id === 'weakest_dimension' || id === 'never_reviewed') {
    return mainDoc
  }
  if (tail !== '' && tail !== 'project') return moduleDoc(tail)
  return String(scope ?? '') !== '' && scope !== 'project' ? moduleDoc(String(scope)) : mainDoc
}

/** `模块名:维度名` → 模块文档；解析不出来就退回主文档（宁可指粗也不指错）。 */
function mainDocOrModule(key, moduleDoc) {
  const at = key.indexOf(':')
  return at <= 0 ? 'project' : moduleDoc(key.slice(0, at))
}

/* ------------------------------- 版本与迁移 ------------------------------- */

/** 读一份文档的 front-matter 版本；缺失或坏值都按 1（最早的那版）。 */


/* --------------------------- 证据去重（interned 表） --------------------------- */

/**
 * 把散落在各处的**同一批证据文本**抽成一张顶部去重表，各处只留下标。
 *
 * 为什么需要（实测数字）：一份 10 个模块的 `op:audit` 返回里，
 * 「lib/index.js 第 320 行起有一个约 945 行的函数（阈值 60 行）」这句话
 * **出现了 39 次**；全部证据句合计 114 次出现、**只有 12 条唯一**。
 * 现状 5542 字符 → 去重表 + 下标约 1041 字符，**省 4KB / 省 81%**。
 *
 * 为什么可以安全去重：`verdicts` 是**纯文本证据**，不含模块私有状态——
 * 同一句话在哪个模块下都是同一句话。去重后模型读到的信息**一字不少**，
 * 只是「同一句话只说一遍，其余地方给下标」。
 *
 * 返回 `{table, indexOf}`：`table` 是唯一句数组（放进返回的 `evidenceTable`），
 * `indexOf` 把任意句子映射成它在表里的下标。
 */
export function internEvidence(sentences) {
  const list = Array.isArray(sentences) ? sentences : []
  const table = []
  const seen = new Map()
  for (const sentence of list) {
    const text = typeof sentence === 'string' ? sentence : String(sentence ?? '')
    if (text === '') continue
    if (seen.has(text)) continue
    seen.set(text, table.length)
    table.push(text)
  }
  return {
    table,
    indexOf(sentence) {
      const text = typeof sentence === 'string' ? sentence : String(sentence ?? '')
      return seen.has(text) ? seen.get(text) : -1
    },
  }
}

/**
 * 把一棵结构里所有 `verdicts: string[]` 就地换成 `evidence: number[]`（下标）。
 *
 * 就地遍历而不是逐处手改：`reasons` 的形状由 `trueHealthOf` 决定，
 * 这里只认「有 verdicts 数组」这一个特征，形状变了也不会漏。
 * 同时把原句收进 `intern`，供调用方输出 `evidenceTable`。
 */
export function indexVerdicts(node, intern) {
  if (Array.isArray(node)) {
    for (const item of node) indexVerdicts(item, intern)
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (key === 'verdicts' && Array.isArray(value)) {
      node.evidence = value.map((sentence) => intern.indexOf(sentence))
      delete node.verdicts
      continue
    }
    indexVerdicts(value, intern)
  }
}
