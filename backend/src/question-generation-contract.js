﻿const {
  ensureStoredQuestion,
  hashText,
  normalizeTags,
  safeJsonParse,
} = require("./utils");
const {
  DIFFICULTY_RULES,
  FEEDBACK_MODE_RULES,
  MODE_RULES,
  getRequestedKeypointCount,
} = require("./question-generation-rules");
const {
  buildPromptMaterial,
  extractQuestionSourceSnippets,
} = require("./question-quality");
const {
  formatQuestionCategoryList,
  inferQuestionCategory,
  getQuestionCategoryLabel,
} = require("./question-taxonomy");

function buildFallbackEvidenceQuotes(material, count) {
  const source = extractQuestionSourceSnippets(material, Math.max(count, 1));
  const items = source.length > 0 ? source : ["Fallback source material"];
  return Array.from({ length: count }, (_, index) => items[index % items.length]);
}

function buildFallbackKeypointTitle(index) {
  return `Keypoint ${index + 1}`;
}

function extractJsonObject(text) {
  const content = String(text || "").trim();
  if (!content) {
    return "";
  }

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }

  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return content.slice(firstBrace, lastBrace + 1);
  }

  return content;
}

function normalizeOptionText(option) {
  if (typeof option === "string") {
    return option.trim();
  }
  if (option && typeof option.text === "string") {
    return option.text.trim();
  }
  return "";
}

function normalizeAnswerKeys(answer) {
  const values = Array.isArray(answer)
    ? answer
    : String(answer || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  return Array.from(
    new Set(
      values
        .map((item) => String(item || "").trim().toUpperCase())
        .filter((item) => /^[A-D]$/.test(item))
    )
  );
}

function clampScore(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(100, Math.max(1, Math.round(parsed)));
}

function normalizeQuestionTag(rawTag, tags, keypoint, index) {
  const candidates = String(rawTag || "")
    .split(/[\uFF0C,|/]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return candidates[0] || tags[index % tags.length] || keypoint.title || "untagged";
}

function normalizeKnowledgeType(value) {
  const text = String(value || "").trim();
  return text || "concept";
}

function normalizeQuestionAngle(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback || "";
}

function normalizeQuestionCategory(value, { questionAngle = "", knowledgeType = "", fallback = "" } = {}) {
  return inferQuestionCategory({
    questionAngle: value || questionAngle,
    knowledgeType,
    fallback,
  });
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function normalizeKeypoints(rawKeypoints, { targetCount, material }) {
  const count = getRequestedKeypointCount(targetCount);
  const fallbackQuotes = buildFallbackEvidenceQuotes(material, count);
  const source = Array.isArray(rawKeypoints) ? rawKeypoints : [];

  return Array.from({ length: count }, (_, index) => {
    const item = source[index] || {};
    const quote =
      String(item.evidence_quote || item.evidenceQuote || fallbackQuotes[index]).trim() ||
      fallbackQuotes[index];
    const title =
      String(item.title || buildFallbackKeypointTitle(index)).trim() ||
      buildFallbackKeypointTitle(index);

    return {
      id: `kp_${index + 1}_${hashText(`${title}:${quote}`).slice(0, 8)}`,
      title,
      importance_score: clampScore(item.importance_score, Math.max(100 - index * 6, 40)),
      evidence_quote: quote.slice(0, 160),
      why_important:
        String(item.why_important || item.whyImportant || "").trim() ||
        "This keypoint can support a focused, discriminative question.",
      knowledge_type: normalizeKnowledgeType(item.knowledge_type || item.knowledgeType),
      confusable_point: String(item.confusable_point || item.confusablePoint || "").trim(),
      recommended_angle: String(item.recommended_angle || item.recommendedAngle || "").trim(),
      question_category: normalizeQuestionCategory(
        item.question_category || item.questionCategory,
        {
          questionAngle: item.recommended_angle || item.recommendedAngle || "",
          knowledgeType: item.knowledge_type || item.knowledgeType || "",
          fallback: title,
        }
      ),
    };
  });
}

function validateOptions(options, index) {
  if (options.length !== 4) {
    throw new Error(`question ${index + 1} must contain exactly 4 options`);
  }

  const seenKeys = new Set();
  const seenTexts = new Set();
  for (const option of options) {
    if (!option.text) {
      throw new Error(`question ${index + 1} contains an empty option`);
    }
    if (seenKeys.has(option.key)) {
      throw new Error(`question ${index + 1} contains duplicate option keys`);
    }
    seenKeys.add(option.key);

    const signature = option.text.replace(/[\p{P}\p{S}\s]+/gu, "").toLowerCase();
    if (signature && seenTexts.has(signature)) {
      throw new Error(`question ${index + 1} contains duplicate option text`);
    }
    if (signature) {
      seenTexts.add(signature);
    }
  }
}

function normalizeQuestion({
  rawQuestion,
  request,
  jobId,
  position,
  createdAt,
  keypoints,
  tags,
}) {
  const type = request.type === "multi" ? "multi" : "single";
  const pointedIndex = Number(rawQuestion.keypoint_index || rawQuestion.keypointIndex || 0);
  const keypoint =
    keypoints[pointedIndex - 1] || keypoints[position % keypoints.length] || keypoints[0];
  const evidenceQuote =
    String(rawQuestion.evidence_quote || rawQuestion.evidenceQuote || keypoint.evidence_quote)
      .trim() || keypoint.evidence_quote;
  const sourceOptions = Array.isArray(rawQuestion.options) ? rawQuestion.options : [];
  const options = [];

  for (let optionIndex = 0; optionIndex < 4; optionIndex += 1) {
    options.push({
      key: String.fromCharCode(65 + optionIndex),
      text: normalizeOptionText(sourceOptions[optionIndex]),
    });
  }

  validateOptions(options, position);

  const validKeys = normalizeAnswerKeys(rawQuestion.answer).filter((key) =>
    options.some((option) => option.key === key)
  );
  if (type === "single" && validKeys.length !== 1) {
    throw new Error(`question ${position + 1} must contain exactly one correct answer`);
  }
  if (type === "multi" && (validKeys.length < 2 || validKeys.length > 3)) {
    throw new Error(`question ${position + 1} must contain two or three correct answers`);
  }

  const stem = String(rawQuestion.stem || "").trim();
  if (!stem) {
    throw new Error(`question ${position + 1} is missing stem`);
  }

  const explanation = String(rawQuestion.explanation || "").trim();
  if (!explanation) {
    throw new Error(`question ${position + 1} is missing explanation`);
  }

  const stored = ensureStoredQuestion({
    id: `q_${jobId}_${String(position + 1).padStart(3, "0")}`,
    type,
    stem,
    tag: normalizeQuestionTag(rawQuestion.tag, tags, keypoint, position),
    options,
    answer: validKeys.join(","),
    explanation,
    evidence_quote: evidenceQuote,
    keypoint_id: keypoint.id,
    difficulty: request.difficulty,
    createdAt,
    mode: request.mode,
    practiceCount: 0,
    wrongCount: 0,
    isMastered: false,
    category_order: position + 1,
    question_angle: normalizeQuestionAngle(
      rawQuestion.question_angle || rawQuestion.questionAngle,
      keypoint.recommended_angle || keypoint.knowledge_type || ""
    ),
    question_category: normalizeQuestionCategory(
      rawQuestion.question_category || rawQuestion.questionCategory,
      {
        questionAngle:
          rawQuestion.question_angle ||
          rawQuestion.questionAngle ||
          keypoint.recommended_angle ||
          keypoint.knowledge_type ||
          "",
        knowledgeType: keypoint.question_category || keypoint.knowledge_type || "",
        fallback:
          keypoint.question_category || keypoint.recommended_angle || keypoint.knowledge_type || "",
      }
    ),
  });

  return {
    ...stored,
    question_angle: stored.question_angle || normalizeQuestionAngle(
      rawQuestion.question_angle || rawQuestion.questionAngle,
      keypoint.recommended_angle || keypoint.knowledge_type || ""
    ),
    question_category:
      stored.question_category ||
      normalizeQuestionCategory(rawQuestion.question_category || rawQuestion.questionCategory, {
        questionAngle:
          rawQuestion.question_angle ||
          rawQuestion.questionAngle ||
          keypoint.recommended_angle ||
          keypoint.knowledge_type ||
          "",
        knowledgeType: keypoint.question_category || keypoint.knowledge_type || "",
        fallback:
          keypoint.question_category || keypoint.recommended_angle || keypoint.knowledge_type || "",
      }),
    distractor_notes: normalizeStringArray(
      rawQuestion.distractor_notes || rawQuestion.distractorNotes
    ),
  };
}

function stringifyTags(tags) {
  return tags.length > 0 ? tags.join(", ") : "auto_tag";
}

function materialLooksAdvertisingMetrics(material) {
  return /(eCPM|CPM|CPC|CPA|CTR|ad slot|advertiser|auction|bid|platform|\u5e7f\u544a|\u7ade\u4ef7|\u5c55\u793a|\u70b9\u51fb|\u8f6c\u5316|\u51fa\u4ef7|\u5e73\u53f0)/i.test(
    String(material || "")
  );
}

function buildAdvertisingMetricsFewShotExample(type) {
  if (type === "multi") {
    return [
      "Reference style only. Do not copy text verbatim.",
      '{"questions":[{"stem":"哪些表述直接表明 eCPM 是平台统一的收入衡量指标？","tag":"metric_relation","question_angle":"relationship_judgment","options":["不同的计费模式依然可以换算成 eCPM 进行比较","eCPM 本身就是广告主直接支付的计费方式","在展示量相同的情况下，收入越高意味着 eCPM 越高","平台只需要点击价格，从不需要展示级别的收入"],"answer":["A","C"],"explanation":"材料中提到平台会将不同的计费模式换算成 eCPM，并且 eCPM 衡量的是每一千次展示的有效收入。","evidence_quote":"平台会将不同的计费模式统一换算成 eCPM 来衡量收益","keypoint_index":1,"distractor_notes":["指标与计费方式混淆","忽略了展示量分母","过度关注点击价格"]},{"stem":"如果两个广告获得相同的展示量，哪些判断符合材料？","tag":"platform_decision","question_angle":"platform_decision","options":["eCPM 更高的广告更有可能获得曝光","CPA 出价更高的广告必然赢得广告位","即使单价较低，只要最终 eCPM 更高也能胜出","品牌知名度比千次展示收入更重要"],"answer":["A","C"],"explanation":"平台比较的是 eCPM 而非品牌知名度或单一出价，eCPM 更高的广告更符合平台的创收目标。","evidence_quote":"平台会更愿意给 eCPM 更高的选项展示机会","keypoint_index":2,"distractor_notes":["单一出价混淆","忽略 eCPM 作为最终标尺","引入无关的品牌因素"]}]}'
    ].join(" ");
  }

  return [
    "Reference style only. Do not copy text verbatim.",
    '{"questions":[{"stem":"某广告位获得了 10000 次展示，总收入为 100 元，它的 eCPM 是多少？","tag":"formula_application","question_angle":"formula_application","options":["1 元","5 元","10 元","100 元"],"answer":["C"],"explanation":"根据 eCPM = 总收入 / 总展示次数 * 1000，计算结果为 (100 / 10000) * 1000 = 10 元。","evidence_quote":"eCPM = 广告总收入 / 广告总展示次数 * 1000","keypoint_index":1,"distractor_notes":["忘记乘以1000的步骤","使用了点击量而非展示量","把总收入直接当成 eCPM"]},{"stem":"在展示量相同的情况下，平台更愿意优先展示哪个广告？","tag":"platform_decision","question_angle":"platform_decision","options":["点击价格更高但最终 eCPM 更低的广告","最终 eCPM 更高的广告","任何 CPA 出价更高的广告","品牌更大牌但千次展示收益较低的广告"],"answer":["B"],"explanation":"平台衡量的是千次展示的有效收入，因此相同曝光下，eCPM 更高的广告能带来更多收益。","evidence_quote":"平台会更愿意给 eCPM 更高的广告展示机会","keypoint_index":2,"distractor_notes":["单一价格混淆","误把高CPA当作高eCPM","引入非材料因素"]}]}'
  ].join(" ");
}

function buildDomainSpecificPromptSections({ request, phase }) {
  if (!materialLooksAdvertisingMetrics(request.material)) {
    return [];
  }

  if (phase === "keypoint") {
    return [
      "Ad-metrics material decomposition rule: if one concept supports definition, formula, scenario, platform decision, and competitiveness angles, split them into separate examinable keypoints instead of collapsing them into one vague point.",
      "Prioritize these keypoints for ad-metrics material: definition vs billing-method boundary, formula conversion, same-impression comparison, platform allocation logic, and how advertisers improve competitiveness through CTR or creative quality.",
    ];
  }

  const sections = [
    "Ad-metrics question design rule: cover definition boundary, formula application, A/B comparison, platform decision, and competitiveness reasoning. Do not turn the whole set into paraphrased definition questions.",
    "Every stem, answer, and explanation should be anchored to the extracted keypoint, while allowing reasonable related context where useful.",
    "Prefer distractor mechanisms such as metric-vs-billing confusion, forgetting the multiply-by-1000 step, focusing on unit price instead of unified eCPM, confusing platform view with advertiser view, or mistaking high payout for high eCPM.",
    buildAdvertisingMetricsFewShotExample(request.type),
  ];

  if (phase === "repair") {
    sections.unshift(
      "When repairing multiple failures around the same concept, change both the examinable angle and the distractor mechanism instead of doing surface-level paraphrasing."
    );
  }

  return sections;
}

function buildKeypointExtractionMessages({ request }) {
  const targetCount = Number(request.targetCount || 0);
  const keypointCount = getRequestedKeypointCount(targetCount);
  const promptMaterial = buildPromptMaterial(request.material, Math.max(keypointCount, 12));

  return [
    {
      role: "system",
      content: [
        "You are an expert assessment designer.",
        "Read the full source material first, then extract the most testable knowledge points.",
        "Ignore praise, filler, section numbers, and title wrappers.",
        "Prioritize definition boundaries, formulas, causal logic, comparisons, scenarios, and decision rules.",
        "You must write all generated text in Simplified Chinese (简体中文), but keep the enum keys in English.",
        "Return one valid JSON object only.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Extract ${keypointCount} distinct, testable keypoints from the source material.`,
        "Each keypoint must include title, evidence_quote, why_important, knowledge_type, confusable_point, recommended_angle, and question_category.",
        "Do not turn praise, quoted fragments, section titles, or chapter numbers into keypoints.",
        "knowledge_type should preferably come from: definition, boundary, formula, relationship, scenario, decision, causal, comparison.",
        "recommended_angle should preferably come from: definition_distinction, formula_application, scenario_choice, platform_decision, relationship_judgment, boundary_elimination, comparative_reasoning, error_analysis.",
        `question_category should come from: ${formatQuestionCategoryList()}.`,
        "importance_score must be an integer from 1 to 100.",
        "Keep evidence_quote concise and useful as the knowledge-point anchor; it does not need to be the only answer source.",
        ...buildDomainSpecificPromptSections({ request, phase: "keypoint" }),
        "JSON Schema:",
        '{"keypoints":[{"title":"...","importance_score":90,"evidence_quote":"...","why_important":"...","knowledge_type":"definition","confusable_point":"...","recommended_angle":"definition_distinction","question_category":"basic_definition"}]}',
        "High-information snippets:",
        promptMaterial || "1. Fallback source material",
        "Full source material:",
        request.material,
      ].join("\n\n"),
    },
  ];
}

function formatKeypointsForPrompt(keypoints) {
  return keypoints
    .map((keypoint, index) => {
      const lines = [
        `${index + 1}. ${keypoint.title}`,
        `- knowledge_type: ${keypoint.knowledge_type || "concept"}`,
        `- evidence_quote: ${keypoint.evidence_quote}`,
        `- question_category: ${getQuestionCategoryLabel(keypoint.question_category) || keypoint.question_category || "Basic Definition"}`,
      ];
      if (keypoint.confusable_point) {
        lines.push(`- confusable_point: ${keypoint.confusable_point}`);
      }
      if (keypoint.recommended_angle) {
        lines.push(`- recommended_angle: ${keypoint.recommended_angle}`);
      }
      if (keypoint.why_important) {
        lines.push(`- why_important: ${keypoint.why_important}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function buildQuestionGenerationMessages({
  request,
  keypoints,
  questionCount,
  antiRepetitionContext = "",
}) {
  const tags = normalizeTags(request.userTags || []);
  const modeRule = MODE_RULES[request.mode] || MODE_RULES.modeA;
  const difficultyRule = DIFFICULTY_RULES[request.difficulty] || DIFFICULTY_RULES.medium;
  const feedbackRule =
    FEEDBACK_MODE_RULES[request.feedbackMode] || FEEDBACK_MODE_RULES.instant;
  const answerRule =
    request.type === "multi"
      ? 'Each answer must be an array with 2 or 3 correct option keys, for example ["A", "C"].'
      : 'Each answer must be an array with exactly 1 correct option key, for example ["B"].';
  const explanationBudget =
    request.feedbackMode === "after_all"
      ? "Keep each explanation within 2 sentences, focusing on evidence and the main misconception."
      : "Keep each explanation within 1 sentence and point directly to the key evidence.";

  return [
    {
      role: "system",
      content: [
        "You are a high-signal exam writer.",
        "Plan the full set before writing individual questions.",
        "Generate the entire set in one response. Do not return only a partial batch.",
        "You must write the final questions, options, and explanations in Simplified Chinese (简体中文).",
        "Do not write meta stems about titles, section names, or the material itself.",
        "Stems must directly test concepts, conditions, calculations, scenarios, platform decisions, metric relationships, misconceptions, or boundaries.",
        "Correct options must be provable. Distractors must be plausible and use different error mechanisms.",
        "Each option must be a complete proposition, not a fragment, label, quoted phrase, or half sentence.",
        "Return one valid JSON object only.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Mode: ${modeRule.label}. ${modeRule.prompt}`,
        `Question type: ${request.type === "multi" ? "multiple choice" : "single choice"}. ${answerRule}`,
        `Difficulty: ${difficultyRule.label}. ${difficultyRule.prompt}`,
        `Feedback mode: ${feedbackRule.label}. ${feedbackRule.prompt}`,
        `Required question count: return exactly ${questionCount} questions.`,
        `Tag preference: ${stringifyTags(tags)}`,
        explanationBudget,
        "Hard count constraint: missing, duplicate, placeholder, or empty questions all count as failure.",
        ...buildDomainSpecificPromptSections({ request, phase: "generation" }),
        "Global constraints:",
        "1. Every question must bind to keypoint_index starting from 1.",
        "2. Every question must have exactly 4 options with comparable granularity, syntax shape, and length.",
        "3. Single-choice questions must have exactly one correct option; multiple-choice questions must have 2 to 3 correct options.",
        "4. Do not use low-quality options such as 'all of the above', 'none of the above', or 'cannot be determined'.",
        "5. Do not create meta stems about the source title, section heading, or a quoted phrase itself.",
        "6. question_angle is required and should preferably come from: definition_distinction, formula_application, scenario_choice, platform_decision, relationship_judgment, boundary_elimination, comparative_reasoning, error_analysis.",
        `6.1 question_category is required and should come from: ${formatQuestionCategoryList()}.`,
        "7. If the source includes formulas or numeric examples, at least one question must be formula_application or comparative_reasoning.",
        "8. If the source includes scenario contrast, platform choice, or auction logic, at least one question must be scenario_choice or platform_decision.",
        "9. Distractors should diversify across these error mechanisms: concept confusion, condition swap, formula misuse, causal inversion, scenario mismatch, or scope overclaim.",
        "10. explanation must explain why the answer is correct instead of restating the answer.",
        "11. Do not rewrite keypoint.title, source name, section name, or evidence_quote verbatim into an option.",
        antiRepetitionContext ? `12. Extra anti-repetition requirement: ${antiRepetitionContext}` : "",
        "Use only the following keypoints:",
        formatKeypointsForPrompt(keypoints),
        "JSON Schema:",
        '{"questions":[{"stem":"...","tag":"...","question_angle":"formula_application","question_category":"formula_calculation","options":["...","...","...","..."],"answer":["B"],"explanation":"...","evidence_quote":"...","keypoint_index":1,"distractor_notes":["...","...","..."]}]}',
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

function buildQuestionRepairMessages({
  request,
  keypoints,
  currentQuestions,
  failingIndexes,
  errorDetails,
}) {
  const validQuestionSummaries = currentQuestions
    .map((question, index) => ({ question, index }))
    .filter(({ index }) => !failingIndexes.includes(index))
    .map(({ question, index }) => {
      const options = (question.options || [])
        .map((option) => `${option.key}. ${option.text}`)
        .join(" | ");
      return [
        `Question ${index + 1}`,
        `- question_angle: ${question.question_angle || ""}`,
        `- question_category: ${question.question_category || ""}`,
        `- stem: ${question.stem}`,
        `- answer: ${question.answer}`,
        `- options: ${options}`,
      ].join("\n");
    })
    .join("\n\n");

  const failingSpec = failingIndexes
    .map((index) => {
      const keypoint = keypoints[index % keypoints.length] || keypoints[0];
      const errorText = Array.isArray(errorDetails[index])
        ? errorDetails[index].join("; ")
        : "quality validation failed";
      return [
        `slot_index: ${index + 1}`,
        `suggested_keypoint: ${keypoint.title}`,
        `recommended_angle: ${keypoint.recommended_angle || keypoint.knowledge_type || ""}`,
        `question_category: ${keypoint.question_category || "basic_definition"}`,
        `evidence_quote: ${keypoint.evidence_quote}`,
        `failure_reason: ${errorText}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    {
      role: "system",
      content: [
        "You are a question-repair specialist.",
        "Rewrite only the failed questions. Do not rewrite the questions that already passed.",
        "Fix meta stems, repeated options, homogeneous distractors, weak abstraction, angle monotony, and missing formula/scenario coverage first.",
        "You must write the final questions, options, and explanations in Simplified Chinese (简体中文).",
        "Return one valid JSON object only.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Rewrite ${failingIndexes.length} failed questions. Keep the type as ${request.type === "multi" ? "multiple choice" : "single choice"}.`,
        ...buildDomainSpecificPromptSections({ request, phase: "repair" }),
        "These questions already passed. Do not repeat their stem angles or distractor patterns:",
        validQuestionSummaries || "No passing questions are currently retained.",
        "Rewrite the following slots:",
        failingSpec,
        "Reusable keypoint pool:",
        formatKeypointsForPrompt(keypoints),
        "Each returned question must include slot_index, question_angle, and question_category.",
        "JSON Schema:",
        '{"questions":[{"slot_index":2,"stem":"...","tag":"...","question_angle":"scenario_choice","question_category":"scenario_application","options":["...","...","...","..."],"answer":["B"],"explanation":"...","evidence_quote":"...","keypoint_index":1,"distractor_notes":["...","...","..."]}]}',
      ].join("\n\n"),
    },
  ];
}

function normalizeJsonCandidate(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u00A0/g, " ")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

function safeJsonParseCandidate(text) {
  const primary = extractJsonObject(text);
  const candidates = [
    primary,
    normalizeJsonCandidate(primary),
    normalizeJsonCandidate(String(text || "")),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = safeJsonParse(candidate);
    if (parsed.ok && parsed.value && typeof parsed.value === "object") {
      return parsed;
    }
  }

  return { ok: false };
}

function parseKeypointExtractionPayload({ text, request }) {
  const parsed = safeJsonParseCandidate(text);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    throw new Error("provider response was not valid JSON");
  }

  const payload = parsed.value;
  const rawKeypoints = Array.isArray(payload.keypoints) ? payload.keypoints : [];
  const expectedCount = getRequestedKeypointCount(request.targetCount);
  if (rawKeypoints.length < expectedCount) {
    throw new Error(
      `provider returned too few keypoints: expected ${expectedCount}, got ${rawKeypoints.length}`
    );
  }

  return {
    keypoints: normalizeKeypoints(rawKeypoints, {
      targetCount: request.targetCount,
      material: request.material,
    }),
  };
}

function parseQuestionGenerationPayload({
  text,
  request,
  job,
  createdAt,
  keypoints,
  expectedCount,
  questionOffset = 0,
  allowPartial = false,
}) {
  const parsed = safeJsonParseCandidate(text);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    throw new Error("provider response was not valid JSON");
  }

  const payload = parsed.value;
  const rawQuestions = Array.isArray(payload.questions) ? payload.questions : [];
  if (rawQuestions.length < expectedCount && !allowPartial) {
    throw new Error(
      `provider returned too few questions: expected ${expectedCount}, got ${rawQuestions.length}`
    );
  }

  const tags = normalizeTags(request.userTags || []);
  const questions = rawQuestions.slice(0, expectedCount).map((rawQuestion, index) => {
    try {
      return normalizeQuestion({
        rawQuestion,
        request,
        jobId: job.jobId,
        position: questionOffset + index,
        createdAt,
        keypoints,
        tags,
      });
    } catch (_error) {
      return null;
    }
  });

  return { questions };
}

function parseQuestionRepairPayload({
  text,
  request,
  job,
  createdAt,
  keypoints,
  expectedCount,
  totalQuestionCount,
  allowPartial = false,
}) {
  const parsed = safeJsonParseCandidate(text);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    throw new Error("provider response was not valid JSON");
  }

  const payload = parsed.value;
  const rawQuestions = Array.isArray(payload.questions) ? payload.questions : [];
  if (rawQuestions.length < expectedCount && !allowPartial) {
    throw new Error(
      `provider returned too few repair questions: expected ${expectedCount}, got ${rawQuestions.length}`
    );
  }

  const tags = normalizeTags(request.userTags || []);
  const seenSlots = new Set();
  const repairs = [];
  for (let index = 0; index < Math.min(rawQuestions.length, expectedCount); index += 1) {
    const rawQuestion = rawQuestions[index];
    const slotIndex = Number(rawQuestion.slot_index || rawQuestion.slotIndex || 0) - 1;
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= totalQuestionCount) {
      continue;
    }
    if (seenSlots.has(slotIndex)) {
      continue;
    }
    seenSlots.add(slotIndex);

    let question = null;
    try {
      question = normalizeQuestion({
        rawQuestion,
        request,
        jobId: job.jobId,
        position: slotIndex,
        createdAt,
        keypoints,
        tags,
      });
    } catch (_error) {
      question = null;
    }

    repairs.push({
      slotIndex,
      question,
    });
  }

  return { repairs };
}

module.exports = {
  buildKeypointExtractionMessages,
  buildQuestionGenerationMessages,
  buildQuestionRepairMessages,
  parseKeypointExtractionPayload,
  parseQuestionGenerationPayload,
  parseQuestionRepairPayload,
};
