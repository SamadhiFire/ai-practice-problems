# 大模型出题实现流程与实现逻辑

本文说明当前产品从用户点击“一键生成”，到调用大模型生成题目，再到题目入库和进入练习页的完整实现链路。代码主体分为前端 `frontend/` 与后端 `backend/`，当前主链路以“后端一次性生成完整题量”为准。

## 1. 总体链路

核心流程如下：

```text
用户粘贴材料并选择出题设置
  ↓
前端校验材料、API Key、题量等输入
  ↓
前端携带登录 token 请求后端 POST /api/v1/questions/generate
  ↓
后端校验 payload，创建 practice session 和 generation job
  ↓
后端解析当前用户的大模型配置
  ↓
调用大模型抽取 keypoints
  ↓
基于 keypoints 调用大模型生成完整题集
  ↓
后端解析 JSON、规范化题目字段、执行质量校验
  ↓
如有失败题位，调用大模型做定向修复
  ↓
仍有硬失败时，用确定性兜底题补齐
  ↓
保存题库、当前练习会话、生成任务
  ↓
前端写入本地题库和当前 session，跳转到做题页
```

相关入口文件：

- 前端生成页：`frontend/src/pages/index/index.vue`
- 前端生成服务：`frontend/src/services/practice-generation-service.ts`
- 前后端请求封装：`frontend/src/utils/backend-sync.ts`
- 后端路由：`backend/src/app.js`
- 后端生成编排：`backend/src/generation.js`
- Prompt 与解析契约：`backend/src/question-generation-contract.js`
- 模型供应商适配：`backend/src/llm-provider.js`

## 2. 前端触发生成

用户在生成页输入学习材料，并选择：

- 出题模式：`modeA` 原文提取，或 `modeB` 知识拓展
- 反馈模式：`instant` 即时反馈，或 `after_all` 全做再看
- 题型：`single` 单选，或 `multi` 多选
- 难度：`easy`、`medium`、`hard`
- 题量：预设题量或 1-50 的自定义题量

`frontend/src/pages/index/index.vue` 中的 `onGenerate()` 会先做前端校验：

- API Key 是否已配置
- 材料是否为空
- `modeA` 材料长度至少 50，`modeB` 至少 2
- 题量是否在允许范围内

校验通过后，前端调用 `startPracticeGeneration()`，传入：

```ts
{
  material,
  type,
  difficulty,
  mode,
  feedbackMode,
  targetCount,
  initialBatchCount,
  userTags,
  requestNonce,
  timeoutMs,
}
```

这里当前实现会令 `initialBatchCount = targetCount`，也就是后端必须一次性返回完整题量。

## 3. 前端请求后端

`frontend/src/services/practice-generation-service.ts` 的 `startPracticeGeneration()` 会调用：

```ts
createQuestionsGenerationJobInBackend(...)
```

该函数位于 `frontend/src/utils/backend-sync.ts`，最终请求：

```http
POST /api/v1/questions/generate
```

请求有两个关键机制：

- `ensureBackendToken()`：保证用户已经登录，并把 `Authorization: Bearer <token>` 带给后端。
- `timeout: 600000`：题目生成允许较长等待时间，前端外层还会根据题量计算一个生成超时时间。

后端返回成功后，前端会：

- `upsertStoredQuestions()`：把题目写入本地题库缓存。
- `replaceActivePracticeSession()`：把本次生成结果设为当前练习会话。
- 根据 `generationJob` 状态决定是否保留本地生成任务。
- 跳转到 `/pages/practice/index` 开始做题。

## 4. 后端生成接口

后端入口在 `backend/src/app.js`：

```js
POST /api/v1/questions/generate
```

接口先调用 `validateGeneratePayload()` 校验请求：

- `material` 必须存在
- `type` 必须是 `single` 或 `multi`
- `difficulty` 必须是 `easy`、`medium`、`hard`
- `mode` 必须是 `modeA` 或 `modeB`
- `feedbackMode` 会规范化为 `instant` 或 `after_all`
- `targetCount` 必须是 1-100 的整数
- `initialBatchCount` 必须是 1-100 的整数，并且必须等于 `targetCount`
- `requestNonce` 必须是非负整数
- `userTags` 如果存在，必须是数组

随后后端构造幂等 key：

```js
buildIdempotencyKey(userId, payload)
```

这个 key 包含：

- 用户 ID
- `requestNonce`
- 材料 hash
- 题型
- 难度
- 模式
- 反馈模式
- 题量

如果同一个幂等 key 已经生成过完整结果，后端会直接返回已有的 `session` 和 `generationJob`，避免重复写题。

如果没有命中幂等结果，后端会创建：

- `session`：当前练习会话壳，初始 `questions` 为空。
- `job`：生成任务壳，状态为 `running`。

然后进入核心生成函数：

```js
buildGenerationResult({
  request: payload,
  session,
  job,
  llmConfig: await store.getLlmConfig(userId),
})
```

## 5. 大模型配置解析

模型配置由 `backend/src/llm-provider.js` 管理。

当前支持四类 provider：

- `qwen`
- `deepseek`
- `openai`
- `gemini`

配置来源按优先级合并：

```text
请求/用户保存的 apiKey
  ↓
managedKeys 中对应 provider 的 key
  ↓
环境变量中的 key
  ↓
默认 provider 配置
```

环境变量包括：

- `DASHSCOPE_API_KEY`
- `DEEPSEEK_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`

调用协议按 provider 分流：

- `qwen`、`deepseek`：OpenAI-compatible `chat.completions`
- `openai`：OpenAI `responses`
- `gemini`：Gemini `generateContent`

所有 provider 最终都会被归一成：

```js
{
  config,
  transport,
  raw,
  text
}
```

后续解析逻辑只关心 `text`。

## 6. 生成编排核心

核心文件是 `backend/src/generation.js`。

`buildGenerationResult()` 会先解析模型配置。如果没有可用 API Key，并且环境变量 `ALLOW_DETERMINISTIC_FALLBACK` 没有设置为 `"0"`，系统会走确定性兜底生成；否则会抛出生成失败。

有 API Key 时，主流程进入：

```js
buildLiveGenerationResult(...)
```

该函数分为五个阶段。

## 7. 阶段一：抽取知识点

后端先调用大模型抽取 keypoints。

Prompt 构建函数：

```js
buildKeypointExtractionMessages({ request })
```

解析函数：

```js
parseKeypointExtractionPayload({ text, request })
```

抽取前会先从材料里挑高信息片段：

- `question-quality.js` 的 `extractQuestionSourceSnippets()`
- `buildPromptMaterial()`

这些函数会尽量过滤：

- 太泛的表达
- 低信息量短句
- 纯标题/章节编号
- 客套话和填充句

模型需要返回 JSON：

```json
{
  "keypoints": [
    {
      "title": "...",
      "importance_score": 90,
      "evidence_quote": "...",
      "why_important": "...",
      "knowledge_type": "definition",
      "confusable_point": "...",
      "recommended_angle": "definition_distinction",
      "question_category": "basic_definition"
    }
  ]
}
```

知识点数量由 `getRequestedKeypointCount(targetCount)` 决定，范围是 1-10。模型返回后，后端会规范化每个 keypoint：

- 重新生成稳定的 `id`
- 截断 `evidence_quote`
- 补齐 `knowledge_type`
- 规范化 `question_category`
- 补齐缺失字段

抽取阶段参数大致偏稳：

- attempts：2
- temperature：0.25
- top_p：0.85

## 8. 阶段二：生成题目

有了 keypoints 后，后端会先生成一个题型/角度覆盖计划：

```js
buildCategoryCompositionPlan(...)
```

这个计划会根据材料和 keypoints 判断是否需要覆盖：

- 公式计算类题目
- 场景判断类题目
- 定义边界类题目
- 关系理解类题目
- 决策判断类题目
- 常见误区类题目

随后调用：

```js
buildQuestionGenerationMessages({
  request,
  keypoints,
  questionCount: targetCount,
  antiRepetitionContext,
})
```

Prompt 会明确写入：

- 模式规则：原文提取或知识拓展
- 题型规则：单选必须 4 选 1，多选必须 4 选 2 或 4 选 3
- 难度规则：简单、中等、困难对应不同干扰项强度
- 反馈规则：即时反馈解析更短，全做再看解析更有复盘价值
- 用户标签偏好
- 题量硬约束
- 每题必须绑定 `keypoint_index`
- 每题必须有 4 个选项
- 必须输出 `question_angle` 和 `question_category`
- 禁止“以上都对”“无法判断”等低质量选项
- 禁止围绕“材料标题/原文片段本身”出元问题
- 如果材料包含公式、数值、平台选择、竞价逻辑，则必须覆盖对应题型
- 同一批题必须避免题干、答案和选项池重复

模型需要返回 JSON：

```json
{
  "questions": [
    {
      "stem": "...",
      "tag": "...",
      "question_angle": "formula_application",
      "question_category": "formula_calculation",
      "options": ["...", "...", "...", "..."],
      "answer": ["B"],
      "explanation": "...",
      "evidence_quote": "...",
      "keypoint_index": 1,
      "distractor_notes": ["...", "..."]
    }
  ]
}
```

生成阶段参数更发散：

- attempts：3
- temperature：0.78
- top_p：0.93
- max output tokens：根据材料长度、题量、反馈模式动态估算，最高 4096

## 8.1 模式 A 示例：用 Temperature vs Top-P 材料生成题目

下面用这段材料演示“原文提取”模式，也就是 `modeA`。这里假设用户选择：

```text
mode: modeA
type: single
feedbackMode: instant
targetCount: 2
userTags: []
```

材料主题是 `Temperature vs. Top-P`。在 `modeA` 下，系统不会要求模型自由拓展外部知识，而是要求每道题的正确答案都能被材料直接支持。它可以做一层非常轻的推理，例如“低温会让高概率词更占优势，所以模型更保守”，但不能引入材料没有讲过的新采样算法、新公式或模型细节。

### 8.1.1 先抽取可出题知识点

后端会先调用 `buildKeypointExtractionMessages()`，让模型把长材料拆成可考知识点。对这段材料，一个合理的 keypoints 结果大致会是：

```json
{
  "keypoints": [
    {
      "title": "Temperature 通过缩放 logits 改变概率分布形状",
      "importance_score": 95,
      "evidence_quote": "它通过缩放 Logits（未归一化的分数）来影响 Softmax 函数",
      "why_important": "这是理解 Temperature 作用机制的核心公式来源。",
      "knowledge_type": "formula",
      "confusable_point": "容易把 Temperature 误解成直接截断候选词集合。",
      "recommended_angle": "formula_application",
      "question_category": "formula_calculation"
    },
    {
      "title": "低温让模型更保守，高温让模型更随机",
      "importance_score": 92,
      "evidence_quote": "T < 1 夸大高概率词的优势；T > 1 让分布变得平滑",
      "why_important": "这是判断不同温度效果的直接依据。",
      "knowledge_type": "boundary",
      "confusable_point": "容易把高温理解为一定更正确，或把低温理解为扩大候选集。",
      "recommended_angle": "boundary_elimination",
      "question_category": "boundary_distinction"
    },
    {
      "title": "Top-P 按累计概率动态保留候选集",
      "importance_score": 90,
      "evidence_quote": "先将所有词按概率从高到低排序，然后只保留累计概率达到 P 的那一组词",
      "why_important": "这是 Top-P 区别于 Temperature 的关键。",
      "knowledge_type": "definition",
      "confusable_point": "容易把 Top-P 和固定取前 K 个词的 Top-K 混淆。",
      "recommended_angle": "definition_distinction",
      "question_category": "basic_definition"
    },
    {
      "title": "Top-P 能过滤长尾噪音",
      "importance_score": 86,
      "evidence_quote": "即使温度很高，Top-P 也能确保模型不会选到那些完全不合逻辑的极低概率词",
      "why_important": "这是理解 Temperature 与 Top-P 配合关系的关键。",
      "knowledge_type": "relationship",
      "confusable_point": "容易以为高温一定会让模型选到任意低概率词。",
      "recommended_angle": "relationship_judgment",
      "question_category": "relationship_comprehension"
    }
  ]
}
```

真实代码会在解析后重新生成 keypoint id，并把字段规范化。这里为了演示流程，只展示模型语义层面的结果。

### 8.1.2 模式 A 的题目生成边界

进入 `buildQuestionGenerationMessages()` 时，`modeA` 会使用 `MODE_RULES.modeA`：

```text
Answers must stay directly supportable by the source.
Prioritize definitions, conditions, causal logic, formulas, boundaries, and scenario judgments without drifting beyond the material.
```

翻成产品逻辑就是：

- 题干必须围绕材料中的概念、公式、边界、比较关系出题。
- 正确选项必须能在材料中找到依据。
- 干扰项可以制造混淆，但混淆必须来自材料内的相邻概念。
- 不能为了让题更难而引入材料没讲的新知识。
- `evidence_quote` 必须来自原文，不能凭空编。

### 8.1.3 easy / medium / hard 如何区分

难度不是简单改变字数，而是改变“考查深度”和“干扰项强度”。

| 难度 | 生成目标 | 题干表现 | 干扰项表现 |
| --- | --- | --- | --- |
| `easy` | 基础识别、直接理解 | 直接问定义、作用、显性结论 | 明显错误，通常是反向描述或偷换对象 |
| `medium` | 概念区分、常见误解 | 需要比较 Temperature 和 Top-P，或判断低温/高温差异 | 看起来接近材料，但混淆机制、范围或对象 |
| `hard` | 边界判断、跨句整合、隐含逻辑 | 需要同时使用两处以上材料信息，例如“高温 + Top-P 过滤”的组合判断 | 干扰项更像正确答案，常见错误是绝对化、因果倒置、把一个机制套到另一个机制上 |

在这段材料里，三档难度可以这样理解：

- `easy`：问“Temperature 主要改变什么”“Top-P 怎么选候选词”。
- `medium`：问“低温和高温分别造成什么效果”“Top-P 为什么比 Top-K 动态”。
- `hard`：问“为什么高温不一定会选到完全不合逻辑的词”“Temperature 和 Top-P 分别控制概率形状与候选范围，二者如何互补”。

### 8.1.4 easy 示例：直接识别

如果用户选择 `difficulty: easy`，Prompt 中会注入：

```text
Use direct stems and clearly distinguishable distractors; focus on basic recognition and direct understanding.
```

示例生成结果：

```json
{
  "questions": [
    {
      "stem": "根据材料，Temperature 主要通过什么方式影响模型下一个 token 的选择？",
      "tag": "综合",
      "question_angle": "definition_distinction",
      "question_category": "basic_definition",
      "options": [
        "通过缩放 logits 来改变 Softmax 后的概率分布形状",
        "通过固定保留概率最高的前 K 个 token",
        "通过删除所有高概率 token 来增加随机性",
        "通过直接改写用户输入的提示词"
      ],
      "answer": ["A"],
      "explanation": "材料明确说明 Temperature 通过缩放 logits 影响 Softmax 函数，从而改变概率分布形状。",
      "evidence_quote": "它通过缩放 Logits（未归一化的分数）来影响 Softmax 函数",
      "keypoint_index": 1,
      "distractor_notes": ["混淆 Top-K", "反向描述", "引入无关机制"]
    },
    {
      "stem": "根据材料，Top-P 的基本做法是什么？",
      "tag": "综合",
      "question_angle": "definition_distinction",
      "question_category": "basic_definition",
      "options": [
        "把所有词按概率从高到低排序，只保留累计概率达到 P 的词组",
        "把所有词的概率平均分配，让每个词机会完全相同",
        "只选择概率最低的一组词，以提升创造性",
        "只根据 Temperature 的大小决定最终答案"
      ],
      "answer": ["A"],
      "explanation": "材料说明 Top-P 会按概率排序，并保留累计概率达到 P 的候选词集合。",
      "evidence_quote": "先将所有词按概率从高到低排序，然后只保留累计概率达到 P 的那一组词",
      "keypoint_index": 3,
      "distractor_notes": ["平均化误解", "反向选择", "混淆 Temperature"]
    }
  ]
}
```

easy 的特征是：正确项基本就是材料中的核心句改写，错误项比较容易排除。

### 8.1.5 medium 示例：概念区分

如果用户选择 `difficulty: medium`，Prompt 中会注入：

```text
Add common misconceptions and condition changes; test understanding, discrimination, and light reasoning.
```

示例生成结果：

```json
{
  "questions": [
    {
      "stem": "关于低温和高温对生成结果的影响，哪一项最符合材料？",
      "tag": "综合",
      "question_angle": "boundary_elimination",
      "question_category": "boundary_distinction",
      "options": [
        "低温会夸大高概率词优势，使模型更保守；高温会平滑分布，使模型更随机",
        "低温会扩大候选集范围，高温会缩小候选集范围",
        "低温和高温都只改变候选词数量，不改变概率分布形状",
        "高温会保证模型输出更准确，因为低概率词机会增加"
      ],
      "answer": ["A"],
      "explanation": "材料把 Temperature 描述为改变概率分布形状：低温更确定，高温更随机但也更可能胡言乱语。",
      "evidence_quote": "T < 1 夸大高概率词的优势；T > 1 让分布变得平滑",
      "keypoint_index": 2,
      "distractor_notes": ["混淆候选集范围", "否认分布变化", "把随机性误解为准确性"]
    },
    {
      "stem": "为什么材料认为 Top-P 比传统 Top-K 更动态？",
      "tag": "综合",
      "question_angle": "comparative_reasoning",
      "question_category": "comparative_analysis",
      "options": [
        "因为 Top-P 会根据累计概率自动调整候选集大小，而不是固定取前 K 个词",
        "因为 Top-P 会让每次生成都固定只保留一个词",
        "因为 Top-P 会改变 logits 的缩放比例",
        "因为 Top-P 会取消概率排序，直接随机选择 token"
      ],
      "answer": ["A"],
      "explanation": "材料说明 Top-P 的候选集会随模型自信程度变化，而 Top-K 是固定取前 K 个词。",
      "evidence_quote": "如果模型很自信，候选集可能只有一个词；如果模型不确定，候选集会自动扩大",
      "keypoint_index": 3,
      "distractor_notes": ["绝对化动态范围", "混淆 Temperature", "反向描述排序过程"]
    }
  ]
}
```

medium 的特征是：题目开始考“区分”。错误项不再只是胡说，而是把 Temperature 和 Top-P 的机制互相套错。

### 8.1.6 hard 示例：边界与组合判断

如果用户选择 `difficulty: hard`，Prompt 中会注入：

```text
Test boundaries, counterexamples, cross-sentence integration, and implicit logic; distractors should feel plausibly wrong.
```

示例生成结果：

```json
{
  "questions": [
    {
      "stem": "如果 Temperature 设置较高，但同时使用较低的 Top-P，哪种判断最符合材料中的机制关系？",
      "tag": "综合",
      "question_angle": "relationship_judgment",
      "question_category": "relationship_comprehension",
      "options": [
        "高温会增加低概率词机会，但 Top-P 仍会通过候选集截断过滤极低概率长尾词",
        "高温会让 Top-P 失效，因此模型一定会选到完全不合逻辑的词",
        "Top-P 会直接把高温变成低温，因为二者都通过缩放 logits 起作用",
        "只要使用 Top-P，Temperature 就不会再影响概率分布形状"
      ],
      "answer": ["A"],
      "explanation": "材料分别说明高温会让分布更平滑，而 Top-P 的作用是保留累计概率范围内的候选词并过滤长尾噪音。",
      "evidence_quote": "即使温度很高，Top-P 也能确保模型不会选到那些完全不合逻辑的极低概率词",
      "keypoint_index": 4,
      "distractor_notes": ["绝对化高温风险", "混淆两个参数的作用机制", "否认 Temperature 的作用"]
    },
    {
      "stem": "哪一项最准确地区分了 Temperature 和 Top-P 在采样中的作用边界？",
      "tag": "综合",
      "question_angle": "boundary_elimination",
      "question_category": "boundary_distinction",
      "options": [
        "Temperature 改变概率分布的形状，Top-P 改变可被采样的候选集范围",
        "Temperature 和 Top-P 都只负责固定候选词数量",
        "Temperature 负责过滤长尾噪音，Top-P 负责缩放 logits",
        "Temperature 只在模型不确定时生效，Top-P 只在模型自信时生效"
      ],
      "answer": ["A"],
      "explanation": "材料把 Temperature 对应为改变分布形状，把 Top-P 对应为改变候选集范围。",
      "evidence_quote": "Temperature：改变分布的形状；Top-P：改变候选集的范围",
      "keypoint_index": 1,
      "distractor_notes": ["共同机制误解", "作用互换", "错误限制生效条件"]
    }
  ]
}
```

hard 的特征是：正确答案需要同时抓住两段材料的关系。干扰项看起来像“技术解释”，但会犯作用机制互换、绝对化、条件错配这类错误。

### 8.1.7 到“生成完题目”为止的输出形态

到生成这一步，模型理想输出就是一个 JSON 对象：

```json
{
  "questions": [
    {
      "stem": "...",
      "tag": "综合",
      "question_angle": "...",
      "question_category": "...",
      "options": ["...", "...", "...", "..."],
      "answer": ["A"],
      "explanation": "...",
      "evidence_quote": "...",
      "keypoint_index": 1,
      "distractor_notes": ["...", "..."]
    }
  ]
}
```

也就是说，在“生成完题目”这一刻，大模型只负责返回结构化题目草稿；后端后面的解析、校验、修复、兜底和保存，是下一阶段的工程处理。

## 9. 阶段三：解析与规范化

模型返回后，后端不会直接信任文本，而是执行：

```js
parseQuestionGenerationPayload(...)
```

解析过程包括：

- 从代码块或普通文本中抽取 JSON 对象
- 修正常见 JSON 文本问题，例如中文引号、尾逗号
- 只读取顶层 `questions`
- 每题最多取期望数量
- 把选项统一为 `{ key: "A", text: "..." }` 结构
- 把答案统一成 `"A"` 或 `"A,C"` 字符串
- 根据 `keypoint_index` 绑定 keypoint
- 生成稳定题目 ID：`q_<jobId>_<序号>`
- 补齐题目存储字段：
  - `createdAt`
  - `mode`
  - `practiceCount`
  - `wrongCount`
  - `isMastered`
  - `category_order`
  - `question_angle`
  - `question_category`

如果单题结构不合法，例如缺题干、缺解析、选项不是 4 个、答案无法对应选项，该题会被置为 `null`，后续进入校验/修复阶段。

## 10. 阶段四：质量校验

题目解析后，后端调用：

```js
inspectQuestionSet(...)
```

校验维度包括：

- 数量必须等于 `targetCount`
- 题目 ID 不能重复
- 题干不能重复
- 基础字段必须存在：`id`、`type`、`stem`、`answer`、`evidence_quote`、`keypoint_id`
- 答案必须能在选项 key 中找到
- 选项不能空、不能重复
- 题干不能太泛
- 题干不能是“围绕材料/根据材料某标题”的元问题
- 证据片段不能太泛
- 选项不能只是低信息引用片段的重复
- `question_angle` 必须存在
- `question_category` 必须存在且属于题目分类体系
- 同批题的题干相似度不能过高
- 同批题的选项集合不能高度重合
- 正确选项文本不能跨题大量复用
- 角度和分类要有足够多样性
- 单一分类不能占比过高
- 如果材料支持公式/比较，题集中必须至少有一题覆盖
- 如果材料支持场景/决策，题集中必须至少有一题覆盖

分类体系位于 `backend/src/question-taxonomy.js`，当前包括：

- `basic_definition`
- `boundary_distinction`
- `formula_calculation`
- `relationship_comprehension`
- `scenario_application`
- `decision_judgment`
- `causal_inference`
- `comparative_analysis`
- `common_misconception`
- `comprehensive_application`

## 11. 阶段五：失败题位修复

如果校验发现问题，系统不会立刻失败，而是最多执行 2 轮修复。

修复 Prompt 构建函数：

```js
buildQuestionRepairMessages(...)
```

修复逻辑只重写失败题位，不重写已经通过的题。Prompt 会把以下信息交给模型：

- 已通过题目的题干、角度、分类、答案和选项，用于避免重复
- 失败题位编号
- 失败原因
- 推荐 keypoint
- 推荐出题角度
- 证据片段
- 可复用 keypoint 池

修复返回 JSON：

```json
{
  "questions": [
    {
      "slot_index": 2,
      "stem": "...",
      "tag": "...",
      "question_angle": "scenario_choice",
      "question_category": "scenario_application",
      "options": ["...", "...", "...", "..."],
      "answer": ["B"],
      "explanation": "...",
      "evidence_quote": "...",
      "keypoint_index": 1,
      "distractor_notes": ["...", "..."]
    }
  ]
}
```

后端用 `slot_index` 把修复题覆盖回原位置，然后再次执行完整校验。

## 12. 确定性兜底逻辑

系统有两类兜底。

第一类是“没有 API Key 或实时调用失败”的整体兜底：

```js
buildDeterministicFallbackResult(...)
```

第二类是“实时生成后仍有硬失败题位”的局部兜底：

```js
patchQuestionSlotsWithFallback(...)
```

兜底题不再调用大模型，而是基于材料片段和 keypoints 生成：

- fallback keypoints
- fallback stem
- fallback options
- fallback explanation

相关规则在：

- `backend/src/question-generation-rules.js`
- `backend/src/generation.js`

环境变量：

```text
ALLOW_DETERMINISTIC_FALLBACK
```

默认允许兜底。设置为 `"0"` 时，如果缺少 API Key 或模型调用失败，会直接报错。

生成任务会记录执行模式：

- `live_llm`
- `live_llm_padded`
- `live_llm_soft_accepted`
- `deterministic_fallback_missing_provider`
- `deterministic_fallback_after_live_failure`

这些字段用于判断题目是纯模型生成、模型生成后局部补齐，还是完全兜底。

## 13. 最终结果入库

通过 `finalizeGenerationResult()` 后，后端返回：

```js
{
  savedCount,
  keypoints,
  session,
  generationJob
}
```

其中 `generationJob` 会被标记为：

```js
{
  loadedCount: targetCount,
  status: "completed",
  keypoints,
  batchState,
  executionMode,
  fallbackReason,
  provider,
  model,
  categoryPlan
}
```

接口层随后执行持久化：

- `store.saveQuestions(userId, result.session.questions)`：保存到用户题库
- `store.setPracticeSession(userId, result.session)`：保存当前练习会话
- `store.saveGenerationJob(userId, result.generationJob)`：保存生成任务
- `store.setIdempotency(...)`：保存幂等映射

存储实现位于 `backend/src/store.js`。当前支持：

- 文件存储：`MemoryStore`
- MongoDB 存储：`MongoStore`

默认存储驱动由 `STORAGE_DRIVER` 决定。

## 14. 做题页如何使用生成结果

生成成功后，前端跳转到 `frontend/src/pages/practice/index.vue`。

做题页从当前练习会话读取题目：

- `loadActivePracticeSession()`
- `hydrateActivePracticeSessionFromBackend()`

用户作答后，如果需要同步答题统计，会调用：

```http
POST /api/v1/question-bank/:questionId/attempt
```

后端会比较用户答案和标准答案：

```js
compareChoices(userChoice, question.answer)
```

然后更新：

- `practiceCount`
- `wrongCount`
- `lastWrongAt`
- 当前 session 中对应题目的状态

因此，大模型生成只负责“构造题目和解析”，练习状态由题库和 session 体系继续维护。

## 15. 当前批次机制的实际状态

前端仍保留了 `generation-job.ts` 中的分批加载逻辑，例如 batch2、batch3、自动触发后续题目等。

但当前后端生成接口明确要求：

```text
initialBatchCount === targetCount
```

并且 `POST /questions/generate` 会一次性返回完整 `targetCount` 道题。因此当前主路径是“一次性生成完整题集”，不是边做边生成。

后端的：

```http
POST /api/v1/generation-jobs/:jobId/batches/:batchIndex
```

当前主要是兼容任务状态的接口，`appendBatch()` 不会真正再调用模型追加新题。

## 16. 质量保障的核心思路

这套生成链路的关键不是“把 prompt 发给模型后直接用结果”，而是把大模型放在一个受控流水线中：

1. 先抽知识点，避免直接从长材料里盲目出题。
2. 再生成题目，Prompt 中强制 JSON 结构、题量、题型、角度和证据。
3. 对返回值做结构化解析，非法单题会被置空。
4. 对整套题做批量质量校验，检查重复、空字段、低质量题干、分类多样性和覆盖率。
5. 对失败题位做定向修复，而不是整体重试。
6. 对硬失败题位使用确定性兜底，保证产品可用性。
7. 最终统一写入题库和当前练习 session，前端只消费结构化题目。

## 17. 排查问题时的阅读顺序

如果生成失败，建议按这个顺序看代码：

1. `frontend/src/pages/index/index.vue`：前端是否通过输入校验，传参是否正确。
2. `frontend/src/services/practice-generation-service.ts`：是否超时或捕获到后端错误。
3. `frontend/src/utils/backend-sync.ts`：请求路径、token、timeout 是否正确。
4. `backend/src/app.js`：payload 是否被 `validateGeneratePayload()` 拒绝。
5. `backend/src/llm-provider.js`：provider、baseUrl、model、apiKey 是否解析正确。
6. `backend/src/question-generation-contract.js`：Prompt 和 JSON 解析是否符合模型输出。
7. `backend/src/generation.js`：生成、校验、修复、兜底在哪一阶段失败。
8. `backend/src/question-quality.js` 和 `backend/src/question-taxonomy.js`：是否被质量规则或分类规则拦下。

## 18. 如果我是面试官：会围绕 3 / 4 / 5 追问什么

下面这组问题，假设候选人拿“AI 出题产品”或类似的 AI workflow 产品来讲项目。我会重点围绕三块追问：

- `3` AI 产品方法论能力
- `4` 评测与 Bad Case 分析能力
- `5` 技术理解深度

这些问题不是让候选人背定义，而是看他能不能把“模型能力”讲成“产品能力”，再把“产品能力”讲成“可验证、可优化、可落地的系统”。

### 18.1 AI 产品方法论能力：我会问什么

1. 你为什么把这套出题流程拆成“知识点抽取 → 题目生成 → 失败修复”三段，而不是直接一步让模型出题？
2. 你们这个产品里，`modeA` 和 `modeB` 的产品边界到底是什么？怎么避免 `modeB` 一拓展就开始胡编？
3. 你刚才说“不是让模型自由回答，而是让模型在可控范围内完成任务”，那你们具体做了哪些“可控”设计？
4. 如果只用一句 prompt 写“请严格基于原文出题”，为什么不够？你们还额外加了什么约束？
5. 你们为什么要同时设计 `question_angle` 和 `question_category`？它们分别解决什么问题？
6. 如果用户给的是一大段很长的材料，你们为什么不是全文直接塞给模型，而是先做 snippet 抽取？
7. 你怎么判断一段材料适不适合生成“公式题”“场景题”“判断题”？这是靠规则、靠模型，还是两者结合？
8. 在这个产品里，Prompt 分层体现在哪里？哪些属于系统角色 prompt，哪些属于工作流 prompt，哪些属于结构化输出 prompt？
9. 结构化输出为什么重要？如果模型文本答得“看起来不错”，但 JSON 不合法，在产品里为什么仍然算失败？
10. 如果模型经常输出格式错误，你会优先改 prompt、改解析器、加重试，还是改产品流程？为什么？
11. 这套流程里，哪些环节你愿意让模型自由发挥，哪些环节你一定要用规则或 schema 卡死？
12. 你们为什么没有把这个产品做成典型 RAG 问答？在你看来它更像什么类型的 AI 产品？
13. 如果以后要把题目生成能力从“出题”扩展到“生成讲解”“生成学习路径”，你会复用哪一层，重做哪一层？
14. 你会怎么向非技术面试官解释：为什么 AI 产品的关键不是“接上模型”，而是“设计一条可控链路”？
15. 你觉得这套出题产品里，最能体现你产品方法论的一处设计是什么？为什么？

### 18.2 评测与 Bad Case 分析能力：我会问什么

1. 如果让你定义这套 AI 出题链路的核心指标，你会选哪 3 个？为什么不是只看生成成功率？
2. 你怎么定义“一道题是可用的”？是模型返回了就算，还是必须满足别的条件？
3. 你们现在的 bad case 会怎么分类？哪些是理解错误，哪些是幻觉，哪些是格式错误，哪些是流程问题？
4. 如果题目 JSON 合法，但用户觉得题很水，这在你们体系里算哪一类问题？
5. 你怎么区分“模型能力不够”与“产品链路设计不对”？
6. 如果线上出现大量“题目数量不够”“有空题位”，你会先查哪里？为什么？
7. 如果 schema 通过率很高，但用户满意度还是低，说明问题更可能出在哪？
8. 你们会怎么构建评测集？样本从哪来，多久更新一次，谁来标注好坏？
9. 你会如何设计离线评测和线上评测的分工？
10. 如果你改了 prompt，怎么证明这次改动真的让题目质量变好了，而不是只是换了一种错误？
11. 对这类出题产品来说，你觉得“幻觉率”该怎么定义？是只看事实错误，还是也包括超出原文边界的扩写？
12. 如果模型生成了两道结构正确、语义相近的重复题，这个问题应该被归到哪个 bad case 类别？
13. 你会怎么设计一套 bad case 回流机制，让线上问题能真正进入下一轮迭代？
14. 当 bad case 很多时，你会先修哪一类？按严重程度、按频次，还是按用户感知排序？
15. 如果面试官让你举一个“最典型 bad case”，你会选哪一种来讲，为什么它最能体现你处理 AI 问题的能力？

### 18.3 技术理解深度：我会问什么

1. 你们为什么要做多 provider 适配，而不是只绑定一个模型供应商？
2. 为什么 `qwen/deepseek` 走兼容的 `chat.completions`，而 `openai` 用 `responses`，`gemini` 用 `generateContent`？这背后说明了什么？
3. 你们为什么在“知识点抽取”“题目生成”“修复”三个阶段用了不同的 `temperature` 和 `top_p`？
4. 如果让我只改一个参数来提升稳定性，你会优先改 `temperature`、`top_p`、`maxOutputTokens` 还是 prompt？为什么？
5. 你们为什么要动态估算 `maxOutputTokens`，而不是写一个固定值？
6. 如果模型输出被截断了，你从返回结果里一般会看到什么现象？产品上怎么处理？
7. 你怎么理解 `idempotency` 在这个接口里的作用？如果没有它，会出现什么问题？
8. 为什么后端要先创建 `session` 和 `generationJob` 壳，再去调模型，而不是等模型返回后一次性落库？
9. 你们为什么要在后端做题目解析和校验，而不是让前端直接吃模型原始输出？
10. 这套系统里，规则校验和模型修复分别承担什么角色？为什么两者都不能少？
11. 为什么要设计“确定性兜底题”，它的价值是什么，它的代价又是什么？
12. 你怎么看“soft accept”和“hard failure”的边界？什么情况下你宁愿放行，什么情况下必须判失败？
13. 题目重复检测为什么不能只用字符串完全相等？为什么还要做相似度比较？
14. 如果后续要支持真正的分批生成和边做边加载，你觉得现在这套接口和数据结构还差什么？
15. 如果让你给这套链路补一层可观测性，你最想加哪些日志或指标？例如 provider 返回、解析失败原因、token 统计、修复命中率？
16. 如果面试官继续问 RAG，你会怎么解释：为什么这个项目当前核心不是 RAG，但未来哪些地方可以接入 RAG？
17. 如果以后模型上下文更贵、材料更长，你会优先优化哪部分：snippet 抽取、prompt 压缩、记忆摘要，还是模型切换？
18. 你觉得这套产品里，最体现“你懂技术但不是纯工程视角”的一个设计点是什么？

### 18.4 如果面试官继续深挖，最容易追问的几个组合题

1. 你刚才说用 schema 压制幻觉，那 schema 只能约束格式，不能约束事实，对吧？那事实可靠性你怎么解决？
2. 你刚才说用修复轮次解决 bad case，那为什么不直接整体重跑一遍生成？
3. 你刚才说 `modeA` 要严格基于原文，那“轻推理”和“越界发挥”的边界你怎么定义？
4. 如果用户满意度低，但技术指标都还不错，你会怀疑是题目难度设计问题、产品交互问题，还是评测口径问题？
5. 如果让你下一轮只做一个迭代，你会优先提升哪一段：抽知识点、出题 prompt、修复策略、评测体系，还是可观测性？为什么？

### 18.5 这组问题背后，面试官真正想听什么

如果我是面试官，我不会只想听“你知道这些词”。我真正想确认的是：

- 你能不能把 AI 系统拆成产品链路，而不是只会说“接了大模型”。
- 你能不能定义成功，知道什么叫“生成了”和什么叫“生成得好”。
- 你能不能把 bad case 管起来，而不是把问题都甩给模型。
- 你有没有技术判断力，知道为什么这套系统要这么设计。
- 你能不能在回答时，把问题重新拉回“用户价值、流程可控、结果可评估”这条主线上。
