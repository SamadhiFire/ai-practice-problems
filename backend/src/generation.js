﻿const { ERROR_CODES } = require("./constants");
const {
  buildFallbackExplanation,
  buildFallbackOptions,
  buildFallbackStem,
  computeTextSimilarity,
  getRequestedKeypointCount,
} = require("./question-generation-rules");
const {
  createProviderText,
  formatProviderError,
  resolveLlmConfig,
} = require("./llm-provider");
const {
  buildKeypointExtractionMessages,
  buildQuestionGenerationMessages,
  buildQuestionRepairMessages,
  parseKeypointExtractionPayload,
  parseQuestionGenerationPayload,
  parseQuestionRepairPayload,
} = require("./question-generation-contract");
const {
  extractQuestionSourceSnippets,
  findQuestionQualityErrors,
} = require("./question-quality");
const { inferQuestionCategory } = require("./question-taxonomy");
const {
  ensureStoredQuestion,
  hashText,
  normalizeTags,
  validateStoredQuestion,
} = require("./utils");

const ZH_KEYPOINT_LENSES = [
  "Definition",
  "Boundary",
  "Formula",
  "Relationship",
  "Scenario",
  "Decision",
  "Cause",
  "Comparison",
  "Trap",
  "Transfer",
];
const EN_KEYPOINT_LENSES = [
  "Definition",
  "Boundary",
  "Formula",
  "Relationship",
  "Scenario",
  "Decision",
  "Cause",
  "Comparison",
  "Trap",
  "Transfer",
];
const DEFAULT_CATEGORY_ROTATION = [
  "basic_definition",
  "boundary_distinction",
  "formula_calculation",
  "relationship_comprehension",
  "scenario_application",
  "decision_judgment",
  "causal_inference",
  "comparative_analysis",
  "common_misconception",
  "comprehensive_application",
];

const MAX_EXTRACTION_ATTEMPTS = 2;
const MAX_GENERATION_ATTEMPTS = 3;
const MAX_REPAIR_ATTEMPTS = 2;
const MIN_GENERATION_OUTPUT_TOKENS = 1400;
const MAX_GENERATION_OUTPUT_TOKENS = 4096;
const EXTRACTION_TEMPERATURE = 0.25;
const EXTRACTION_TOP_P = 0.85;
const GENERATION_TEMPERATURE = 0.78;
const GENERATION_TOP_P = 0.93;
const REPAIR_TEMPERATURE = 0.92;
const REPAIR_TOP_P = 0.96;
const ALLOW_DETERMINISTIC_FALLBACK = process.env.ALLOW_DETERMINISTIC_FALLBACK === "1";

function estimateExtractionOutputTokens(request) {
  const keypointCount = getRequestedKeypointCount(request?.targetCount || 0);
  const materialLength = String(request?.material || "").length;
  return Math.min(
    2600,
    Math.max(1000, 520 + keypointCount * 140 + Math.min(480, Math.ceil(materialLength / 8)))
  );
}

function estimateGenerationOutputTokens(request) {
  const targetCount = Number(request?.targetCount || 0);
  const keypointCount = getRequestedKeypointCount(targetCount);
  const materialLength = String(request?.material || "").length;
  const perQuestionBudget = request?.feedbackMode === "after_all" ? 340 : 280;
  const baseBudget = 680;
  const keypointBudget = keypointCount * 90;
  const materialBudget = Math.min(720, Math.ceil(materialLength / 6));

  return Math.max(
    MIN_GENERATION_OUTPUT_TOKENS,
    Math.min(
      MAX_GENERATION_OUTPUT_TOKENS,
      baseBudget + targetCount * perQuestionBudget + keypointBudget + materialBudget
    )
  );
}

function estimateRepairOutputTokens(repairCount, request) {
  const materialLength = String(request?.material || "").length;
  const perQuestionBudget = request?.feedbackMode === "after_all" ? 380 : 320;
  const materialBudget = Math.min(320, Math.ceil(materialLength / 12));
  return Math.min(
    MAX_GENERATION_OUTPUT_TOKENS,
    Math.max(1100, 420 + repairCount * perQuestionBudget + materialBudget)
  );
}

function detectLocale(text) {
  return /[\u3400-\u9fff]/.test(String(text || "")) ? "zh" : "en";
}

function normalizeSnippetText(snippet) {
  return String(snippet || "")
    .replace(/\s+/g, " ")
    .replace(/["\u201c\u201d'\u2018\u2019`]/g, "")
    .trim();
}

function takeLeadingWords(text, count) {
  return String(text || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, count)
    .join(" ");
}

function buildKeypointFocus(snippet, index) {
  const locale = detectLocale(snippet);
  const lenses = locale === "zh" ? ZH_KEYPOINT_LENSES : EN_KEYPOINT_LENSES;
  const lens = lenses[index % lenses.length];

  if (locale === "zh") {
    const compact = snippet
      .replace(/[\u3000-\u303F\uFF00-\uFFEF()<>\[\]]/g, "")
      .replace(/\s+/g, "")
      .slice(0, 14);
    return compact ? `${lens}: ${compact}` : `${lens} focus`;
  }

  const words = takeLeadingWords(snippet.replace(/[,.!?;:()\[\]]+/g, " "), 6);
  return words ? `${lens}: ${words}` : `${lens} focus`;
}

function buildKeypointImportance(locale, mode, difficulty) {
  if (mode === "modeB") {
    return difficulty === "hard"
      ? "This point supports high-discrimination questions that require disciplined extension and boundary analysis."
      : "This point supports limited extension while staying anchored to the source.";
  }
  return difficulty === "hard"
    ? "This point is suitable for testing evidence boundaries, condition limits, or cross-sentence integration."
    : "This point can support a focused, discriminative question.";
}

function buildFallbackKnowledgeType(index) {
  return [
    "definition",
    "boundary",
    "formula",
    "relationship",
    "scenario",
    "decision",
    "causal",
    "comparison",
  ][index % 8];
}

function buildFallbackRecommendedAngle(knowledgeType) {
  const normalized = String(knowledgeType || "").toLowerCase();
  if (normalized === "definition") {
    return "definition_distinction";
  }
  if (normalized === "boundary") {
    return "boundary_elimination";
  }
  if (normalized === "formula") {
    return "formula_application";
  }
  if (normalized === "relationship") {
    return "relationship_judgment";
  }
  if (normalized === "scenario") {
    return "scenario_choice";
  }
  if (normalized === "decision") {
    return "platform_decision";
  }
  if (normalized === "causal") {
    return "causal_inference";
  }
  if (normalized === "comparison") {
    return "comparative_reasoning";
  }
  return "definition_distinction";
}

function inferCategoryId({ questionCategory = "", questionAngle = "", knowledgeType = "", fallback = "" }) {
  return inferQuestionCategory({
    questionAngle: questionCategory || questionAngle,
    knowledgeType: questionCategory || knowledgeType,
    fallback: fallback || "basic_definition",
  });
}

function createKeypoints(request) {
  const targetCount = Number(request.targetCount || 0);
  const requestedCount = getRequestedKeypointCount(targetCount);
  const snippets = extractQuestionSourceSnippets(
    request.material,
    Math.max(requestedCount, 1)
  ).map((item) => normalizeSnippetText(item));
  const sourceSnippets = snippets.length > 0 ? snippets : ["Fallback source material"];

  return Array.from({ length: requestedCount }, (_, index) => {
    const snippet = sourceSnippets[index % sourceSnippets.length] || sourceSnippets[0];
    const locale = detectLocale(snippet);
    const title = buildKeypointFocus(snippet, index);
    const evidenceQuote = snippet.slice(0, 160) || "Fallback source material";
    const knowledgeType = buildFallbackKnowledgeType(index);
    const recommendedAngle = buildFallbackRecommendedAngle(knowledgeType);
    const questionCategory = inferCategoryId({
      questionAngle: recommendedAngle,
      knowledgeType,
      fallback: title,
    });

    return {
      id: `kp_${index + 1}_${hashText(`${title}:${evidenceQuote}`).slice(0, 8)}`,
      title,
      importance_score: Math.max(96 - index * 7, 48),
      evidence_quote: evidenceQuote,
      why_important: buildKeypointImportance(locale, request.mode, request.difficulty),
      knowledge_type: knowledgeType,
      recommended_angle: recommendedAngle,
      question_category: questionCategory,
      confusable_point:
        "May be confused with a nearby concept, condition, or stronger conclusion.",
    };
  });
}

function buildQuestion({
  jobId,
  request,
  keypoint,
  index,
  tag,
  createdAt,
}) {
  const type = request.type === "multi" ? "multi" : "single";
  const fallbackOptions = buildFallbackOptions({
    request,
    keypoint,
    index,
  });
  const fallbackCategory = inferCategoryId({
    questionCategory: keypoint.question_category || "",
    questionAngle: keypoint.recommended_angle || keypoint.knowledge_type || "",
    knowledgeType: keypoint.knowledge_type || "",
    fallback: keypoint.title || "basic_definition",
  });

  return ensureStoredQuestion(
    {
      id: `q_${jobId}_${String(index + 1).padStart(3, "0")}`,
      type,
      stem: buildFallbackStem({ request, keypoint, index }),
      tag,
      options: fallbackOptions.options,
      answer: fallbackOptions.answer,
      explanation: buildFallbackExplanation({
        request,
        keypoint,
        answer: fallbackOptions.answer,
      }),
      evidence_quote: keypoint.evidence_quote,
      keypoint_id: keypoint.id,
      difficulty: request.difficulty,
      createdAt,
      mode: request.mode,
      practiceCount: 0,
      wrongCount: 0,
      isMastered: false,
      category_order: index + 1,
      question_angle: keypoint.recommended_angle || keypoint.knowledge_type || "fallback",
      question_category: fallbackCategory,
    },
    {}
  );
}

function normalizeQuestionText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

function normalizeAngle(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

function buildOptionSignature(question) {
  return (question.options || [])
    .map((option) => normalizeQuestionText(option.text))
    .filter(Boolean)
    .join("|");
}

function buildQuestionCorpus(question) {
  return [
    String(question?.stem || ""),
    String(question?.question_angle || ""),
    ...((question?.options || []).map((option) => String(option.text || ""))),
  ].join(" ");
}

function getQuestionCategory(question, fallback = "") {
  return inferCategoryId({
    questionCategory: question?.question_category || question?.questionCategory || "",
    questionAngle: question?.question_angle || question?.questionAngle || "",
    knowledgeType: question?.question_category || "",
    fallback: fallback || "basic_definition",
  });
}

function getKeypointCategory(keypoint, fallback = "") {
  return inferCategoryId({
    questionCategory: keypoint?.question_category || "",
    questionAngle: keypoint?.recommended_angle || "",
    knowledgeType: keypoint?.knowledge_type || "",
    fallback: fallback || keypoint?.title || "basic_definition",
  });
}

function derivePairwiseSimilarityThresholds(left, right) {
  const leftAngle = normalizeAngle(left?.question_angle || "");
  const rightAngle = normalizeAngle(right?.question_angle || "");
  const leftCategory = getQuestionCategory(left, "");
  const rightCategory = getQuestionCategory(right, "");
  const sameAngle = leftAngle && rightAngle ? leftAngle === rightAngle : true;
  const sameCategory = leftCategory && rightCategory ? leftCategory === rightCategory : true;

  if (sameAngle && sameCategory) {
    return { stem: 0.78, option: 0.76 };
  }
  if (sameAngle && !sameCategory) {
    return { stem: 0.84, option: 0.82 };
  }
  if (!sameAngle && sameCategory) {
    return { stem: 0.88, option: 0.85 };
  }
  return { stem: 0.9, option: 0.88 };
}

function relaxPairwiseSimilarityThresholds(base, left, right, request, expectedCount) {
  let stem = base.stem;
  let option = base.option;
  const differentKeypoints =
    left?.keypoint_id && right?.keypoint_id && left.keypoint_id !== right.keypoint_id;
  const leftCategory = getQuestionCategory(left, "");
  const rightCategory = getQuestionCategory(right, "");
  const differentCategories = leftCategory && rightCategory && leftCategory !== rightCategory;

  if (differentKeypoints) {
    stem += 0.04;
    option += 0.03;
  }

  if (differentCategories) {
    stem += 0.02;
    option += 0.02;
  }

  if (request?.mode === "modeA" && expectedCount <= 5) {
    stem += 0.02;
    option += 0.02;
  }

  return {
    stem: Math.min(stem, 0.92),
    option: Math.min(option, 0.9),
  };
}

function materialSuggestsQuantitativeCoverage(request, keypoints = []) {
  const corpus = [
    String(request?.material || ""),
    ...keypoints.map(
      (item) =>
        String(item.title || "") +
        " " +
        String(item.evidence_quote || "") +
        " " +
        String(item.knowledge_type || "") +
        " " +
        String(item.question_category || "")
    ),
  ].join(" ");

  return /(?:\u516c\u5f0f|\u8ba1\u7b97|\u6362\u7b97|\u5c55\u793a\u6b21\u6570|\u5343\u6b21|CTR|CPC|CPA|CPM|eCPM|1000|\u6536\u5165|\u70b9\u51fb\u7387|\u8f6c\u5316|formula|calculate|impression|revenue|click|conversion)/i.test(
    corpus
  );
}

function materialSuggestsScenarioCoverage(request, keypoints = []) {
  const corpus = [
    String(request?.material || ""),
    ...keypoints.map(
      (item) =>
        String(item.title || "") +
        " " +
        String(item.evidence_quote || "") +
        " " +
        String(item.knowledge_type || "") +
        " " +
        String(item.question_category || "")
    ),
  ].join(" ");

  return /(?:\u573a\u666f|\u5e73\u53f0|\u5e7f\u544a\u4f4d|\u7ade\u4ef7|\u66f4\u613f\u610f|\u9009\u62e9|\u5237\u5230|scenario|platform|auction|prefer|placement|decision)/i.test(
    corpus
  );
}

function questionLooksQuantitative(question) {
  return /(?:\u516c\u5f0f|\u8ba1\u7b97|\u6362\u7b97|\u6bd4\u8f83|\u66f4\u9ad8|\u66f4\u4f4e|\u54ea\u79cd\u573a\u666f|\u54ea\u4e2a\u573a\u666f|ecpm|cpc|cpa|cpm|1000|\u6536\u5165|\u5c55\u793a\u6b21\u6570|formula|calculate|compare|higher|lower|impression|revenue)/i.test(
    buildQuestionCorpus(question)
  );
}

function questionLooksScenario(question) {
  return /(?:\u573a\u666f|\u5e73\u53f0|\u5e7f\u544a\u4f4d|\u7ade\u4ef7|\u66f4\u613f\u610f|\u9009\u62e9|\u5237\u5230|scenario|platform|auction|prefer|placement|decision)/i.test(
    buildQuestionCorpus(question)
  );
}

function questionAngleMatches(question, expectedAngles) {
  const angle = normalizeAngle(question?.question_angle || "");
  if (!angle) {
    return false;
  }
  return expectedAngles.some((item) => angle.includes(item));
}

function questionCategoryMatches(question, expectedCategories) {
  const category = getQuestionCategory(question, "");
  if (!category) {
    return false;
  }
  return expectedCategories.includes(category);
}

function questionSatisfiesQuantitativeCoverage(question) {
  return (
    questionLooksQuantitative(question) ||
    questionCategoryMatches(question, [
      "formula_calculation",
      "comparative_analysis",
      "relationship_comprehension",
    ]) ||
    questionAngleMatches(question, [
      "formula application",
      "comparative reasoning",
      "relationship judgment",
    ])
  );
}

function questionSatisfiesScenarioCoverage(question) {
  return (
    questionLooksScenario(question) ||
    questionCategoryMatches(question, ["scenario_application", "decision_judgment"]) ||
    questionAngleMatches(question, ["scenario choice", "platform decision"])
  );
}

function getRequiredAngleDiversity(expectedCount) {
  if (expectedCount <= 2) {
    return 1;
  }
  if (expectedCount <= 5) {
    return 2;
  }
  return 3;
}

function getRequiredCategoryDiversity(expectedCount) {
  if (expectedCount <= 2) {
    return 1;
  }
  if (expectedCount <= 4) {
    return 2;
  }
  if (expectedCount <= 7) {
    return 3;
  }
  return 4;
}

function summarizeCategoryCounts(categorySequence) {
  const counts = new Map();
  for (const item of categorySequence) {
    counts.set(item, Number(counts.get(item) || 0) + 1);
  }
  return Object.fromEntries(counts.entries());
}

function buildCategoryCompositionPlan({ request, keypoints = [], targetCount }) {
  const count = Math.max(1, Number(targetCount || request?.targetCount || 0));
  const keypointCategories = keypoints
    .map((item) => getKeypointCategory(item, item?.title || "basic_definition"))
    .filter(Boolean);

  const forced = [];
  if (materialSuggestsQuantitativeCoverage(request, keypoints)) {
    forced.push("formula_calculation");
  }
  if (materialSuggestsScenarioCoverage(request, keypoints)) {
    forced.push("scenario_application");
  }

  const orderedPool = Array.from(
    new Set([...forced, ...keypointCategories, ...DEFAULT_CATEGORY_ROTATION])
  );
  const requiredDiversity = Math.min(
    orderedPool.length,
    getRequiredCategoryDiversity(count)
  );
  const cycleSize = Math.max(
    1,
    Math.min(orderedPool.length, Math.max(requiredDiversity, Math.min(count, requiredDiversity + 1)))
  );
  const cyclePool = orderedPool.slice(0, cycleSize);
  const sequence = Array.from({ length: count }, (_, index) => cyclePool[index % cyclePool.length]);

  const minimumByCategory = {};
  for (const category of cyclePool.slice(0, requiredDiversity)) {
    minimumByCategory[category] = 1;
  }
  for (const category of forced) {
    minimumByCategory[category] = Math.max(1, Number(minimumByCategory[category] || 0));
  }

  return {
    count,
    cyclePool,
    requiredDiversity,
    minimumByCategory,
    sequence,
    expectedCounts: summarizeCategoryCounts(sequence),
    maxPerCategory: Math.max(2, Math.ceil(count * 0.6)),
  };
}

function inspectQuestionSet(
  questions,
  expectedCount,
  { skipSimilarityChecks = false, request = null, keypoints = [], compositionPlan = null } = {}
) {
  const errors = [];
  const failingIndexes = new Set();
  const questionErrors = new Map();
  const seenIds = new Map();
  const seenStems = new Map();
  const optionTextMap = new Map();
  const angleIndexMap = new Map();
  const categoryIndexMap = new Map();

  function attachError(message, indexes = []) {
    errors.push(message);
    for (const index of indexes) {
      if (!Number.isInteger(index) || index < 0 || index >= questions.length) {
        continue;
      }
      failingIndexes.add(index);
      const existing = questionErrors.get(index) || [];
      existing.push(message);
      questionErrors.set(index, existing);
    }
  }

  if (questions.length !== expectedCount) {
    attachError(
      "generated question count mismatch: expected " + expectedCount + ", got " + questions.length,
      questions.map((_, index) => index)
    );
  }

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];

    if (!question || typeof question !== "object") {
      attachError("missing question at slot " + (index + 1), [index]);
      continue;
    }

    if (seenIds.has(question.id)) {
      attachError("duplicate question id: " + question.id, [index, seenIds.get(question.id)]);
    } else {
      seenIds.set(question.id, index);
    }

    const stemSignature = hashText(question.stem);
    if (seenStems.has(stemSignature)) {
      attachError("duplicate question stem detected: " + question.stem, [index, seenStems.get(stemSignature)]);
    } else {
      seenStems.set(stemSignature, index);
    }

    const localErrors = [
      ...validateStoredQuestion(question),
      ...findQuestionQualityErrors(question),
    ];
    if (localErrors.length > 0) {
      for (const message of localErrors) {
        attachError(message, [index]);
      }
    }

    const rawCategory = String(question.question_category || "").trim();
    const normalizedCategory = getQuestionCategory(question, question.question_angle || "basic_definition");
    if (!rawCategory) {
      attachError("question " + (index + 1) + " is missing question_category", [index]);
    }
    if (!normalizedCategory) {
      attachError("question " + (index + 1) + " has an invalid question_category", [index]);
    } else {
      const categoryBucket = categoryIndexMap.get(normalizedCategory) || [];
      categoryBucket.push(index);
      categoryIndexMap.set(normalizedCategory, categoryBucket);
    }

    if (!skipSimilarityChecks) {
      const angle = normalizeAngle(question.question_angle || "");
      if (!angle) {
        attachError("question " + (index + 1) + " is missing question_angle", [index]);
      } else {
        const bucket = angleIndexMap.get(angle) || [];
        bucket.push(index);
        angleIndexMap.set(angle, bucket);
      }
    }

    for (const option of question.options || []) {
      const signature = normalizeQuestionText(option.text);
      if (!signature || signature.length < 8) {
        continue;
      }
      const bucket = optionTextMap.get(signature) || [];
      bucket.push(index);
      optionTextMap.set(signature, bucket);
    }
  }

  if (!skipSimilarityChecks) {
    for (let leftIndex = 0; leftIndex < questions.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < questions.length; rightIndex += 1) {
        const left = questions[leftIndex];
        const right = questions[rightIndex];
        if (!left || typeof left !== "object" || !right || typeof right !== "object") {
          continue;
        }

        const stemSimilarity = computeTextSimilarity(left.stem, right.stem);
        const optionSimilarity = computeTextSimilarity(
          buildOptionSignature(left),
          buildOptionSignature(right)
        );

        const thresholds = relaxPairwiseSimilarityThresholds(
          derivePairwiseSimilarityThresholds(left, right),
          left,
          right,
          request,
          expectedCount
        );

        if (stemSimilarity > thresholds.stem) {
          attachError(
            "question " +
              (leftIndex + 1) +
              " and question " +
              (rightIndex + 1) +
              " have overly similar stems (" +
              Math.round(stemSimilarity * 100) +
              "%)",
            [leftIndex, rightIndex]
          );
        }
        if (optionSimilarity > thresholds.option) {
          attachError(
            "question " +
              (leftIndex + 1) +
              " and question " +
              (rightIndex + 1) +
              " have overly similar option sets (" +
              Math.round(optionSimilarity * 100) +
              "%)",
            [leftIndex, rightIndex]
          );
        }
      }
    }

    for (const [signature, indexes] of optionTextMap.entries()) {
      const uniqueIndexes = Array.from(new Set(indexes));
      if (uniqueIndexes.length >= 2) {
        attachError(
          "the same option text is reused across multiple questions: " + signature,
          uniqueIndexes
        );
      }
    }

    const uniqueAngles = Array.from(angleIndexMap.keys()).filter(Boolean);
    const requiredAngleDiversity = getRequiredAngleDiversity(expectedCount);
    if (questions.length >= 3 && uniqueAngles.length < requiredAngleDiversity) {
      attachError(
        "question set lacks enough angle diversity; do not make the whole set definition-style paraphrase questions",
        questions.map((_, index) => index)
      );
    }

    for (const [angle, indexes] of angleIndexMap.entries()) {
      if (!angle) {
        continue;
      }
      if (indexes.length > Math.ceil(questions.length / 2)) {
        attachError(
          "too many questions reuse the same question_angle: " + angle,
          indexes
        );
      }
    }

    const uniqueCategories = Array.from(categoryIndexMap.keys()).filter(Boolean);
    const requiredCategoryDiversity = Number(
      compositionPlan?.requiredDiversity || getRequiredCategoryDiversity(expectedCount)
    );
    if (questions.length >= 3 && uniqueCategories.length < requiredCategoryDiversity) {
      attachError(
        "question set lacks enough question_category diversity; do not collapse into one category",
        questions.map((_, index) => index)
      );
    }

    const maxPerCategory = Number(
      compositionPlan?.maxPerCategory || Math.max(2, Math.ceil(questions.length * 0.6))
    );
    for (const [category, indexes] of categoryIndexMap.entries()) {
      if (indexes.length > maxPerCategory) {
        attachError(
          "too many questions concentrate in the same question_category: " + category,
          indexes
        );
      }
    }

    const minimumByCategory = compositionPlan?.minimumByCategory || {};
    for (const [category, minimum] of Object.entries(minimumByCategory)) {
      const expectedMinimum = Math.max(0, Number(minimum || 0));
      if (!expectedMinimum) {
        continue;
      }
      const actual = (categoryIndexMap.get(category) || []).length;
      if (actual < expectedMinimum) {
        attachError(
          "question set misses required category coverage: " +
            category +
            " needs >= " +
            expectedMinimum +
            ", got " +
            actual,
          questions.map((_, index) => index)
        );
      }
    }

    if (
      materialSuggestsQuantitativeCoverage(request, keypoints) &&
      !questions.some((question) => questionSatisfiesQuantitativeCoverage(question))
    ) {
      attachError(
        "question set misses a formula/comparison question even though the material supports one",
        questions.map((_, index) => index)
      );
    }

    if (
      materialSuggestsScenarioCoverage(request, keypoints) &&
      !questions.some((question) => questionSatisfiesScenarioCoverage(question))
    ) {
      attachError(
        "question set misses a scenario/decision question even though the material supports one",
        questions.map((_, index) => index)
      );
    }
  }

  return {
    errors: Array.from(new Set(errors)),
    failingIndexes: Array.from(failingIndexes).sort((a, b) => a - b),
    questionErrors: Object.fromEntries(
      Array.from(questionErrors.entries()).map(([index, messages]) => [
        index,
        Array.from(new Set(messages)),
      ])
    ),
  };
}

function validateQuestionSet(questions, expectedCount, options = {}) {
  return inspectQuestionSet(questions, expectedCount, options).errors;
}

function formatCategoryPlanHint(compositionPlan) {
  const expectedCounts = compositionPlan?.expectedCounts || {};
  const entries = Object.entries(expectedCounts);
  if (entries.length === 0) {
    return "";
  }
  return entries.map(([category, count]) => category + " x" + count).join(", ");
}

function buildCoverageExpectations(request, keypoints, compositionPlan = null) {
  const hints = [];
  if (materialSuggestsQuantitativeCoverage(request, keypoints)) {
    hints.push("Include at least one formula application, numeric comparison, or revenue-priority judgment question.");
  }
  if (materialSuggestsScenarioCoverage(request, keypoints)) {
    hints.push("Include at least one scenario judgment, platform choice, or auction-decision question.");
  }
  const categoryPlanHint = formatCategoryPlanHint(compositionPlan);
  if (categoryPlanHint) {
    hints.push("Category composition target: " + categoryPlanHint + ".");
  }
  return hints;
}

function buildAntiRepetitionContext(request, keypoints, compositionPlan = null) {
  const focus = keypoints
    .slice(0, Math.min(keypoints.length, Math.max(Number(request.targetCount || 0), 4)))
    .map(
      (item) =>
        String(item.title) + "(" + String(item.question_category || item.knowledge_type || "concept") + ")"
    )
    .join("; ");

  return [
    "Within one set, do not keep reusing the same stem skeletons such as metric-equivalence, click-rate-only, or the same higher-vs-lower wording.",
    "Across adjacent questions, switch question_angle and question_category whenever possible, for example definition distinction, formula application, scenario judgment, platform decision, or misconception elimination.",
    ...buildCoverageExpectations(request, keypoints, compositionPlan),
    focus ? "Distribute coverage across these keypoints first: " + focus : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function summarizeValidationErrors(errors, limit = 8) {
  return errors.slice(0, limit).join("; ");
}

function ensureUniqueQuestionStems(questions) {
  const seen = new Map();
  return questions.map((question, index) => {
    if (!question || typeof question !== "object") {
      return question;
    }

    const signature = normalizeQuestionText(question.stem || "");
    if (!signature) {
      return question;
    }

    const seenCount = Number(seen.get(signature) || 0);
    seen.set(signature, seenCount + 1);
    if (seenCount === 0) {
      return question;
    }

    return {
      ...question,
      stem: String(question.stem || "") + " (variant " + (index + 1) + ")",
    };
  });
}

function computeMissingQuestionIndexes(questions, targetCount) {
  const missing = [];
  for (let index = 0; index < targetCount; index += 1) {
    const question = questions[index];
    const options = Array.isArray(question?.options) ? question.options : [];
    const hasShape =
      question &&
      typeof question === "object" &&
      String(question.stem || "").trim() &&
      String(question.answer || "").trim() &&
      String(question.explanation || "").trim() &&
      String(question.question_angle || "").trim() &&
      String(question.question_category || "").trim() &&
      options.length === 4;

    if (!hasShape) {
      missing.push(index);
    }
  }
  return missing;
}

function isHardQuestionError(message) {
  const value = String(message || "").toLowerCase();
  if (!value) {
    return false;
  }

  return (
    value.includes("missing question at slot") ||
    (value.includes("question.") && value.includes("is required")) ||
    value.includes("must contain exactly") ||
    value.includes("contains an empty option") ||
    value.includes("contains duplicate option") ||
    value.includes("contains unknown option") ||
    value.includes("missing question_angle") ||
    value.includes("missing question_category") ||
    value.includes("invalid question_category")
  );
}

function collectHardFailureIndexes({ diagnostics, questions, targetCount }) {
  const hard = new Set(computeMissingQuestionIndexes(questions, targetCount));
  const questionErrors = diagnostics?.questionErrors || {};

  for (const [rawIndex, messages] of Object.entries(questionErrors)) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= targetCount) {
      continue;
    }
    if (!Array.isArray(messages)) {
      continue;
    }
    if (messages.some((message) => isHardQuestionError(message))) {
      hard.add(index);
    }
  }

  return Array.from(hard).sort((left, right) => left - right);
}

function pickKeypointForSlot({ request, keypoints, slotIndex, compositionPlan }) {
  const fallbackPool =
    Array.isArray(keypoints) && keypoints.length > 0 ? keypoints : createKeypoints(request);
  const targetCategory = compositionPlan?.sequence?.[slotIndex] || "";
  if (targetCategory) {
    const matched = fallbackPool.filter(
      (item) => getKeypointCategory(item, item?.title || "basic_definition") === targetCategory
    );
    if (matched.length > 0) {
      return matched[slotIndex % matched.length] || matched[0];
    }
  }
  return fallbackPool[slotIndex % fallbackPool.length] || fallbackPool[0];
}

function buildFallbackQuestionForSlot({
  request,
  job,
  keypoints,
  slotIndex,
  createdAt,
  compositionPlan,
}) {
  const tags = normalizeTags(request.userTags || []);
  const keypoint = pickKeypointForSlot({
    request,
    keypoints,
    slotIndex,
    compositionPlan,
  });
  return buildQuestion({
    jobId: job.jobId,
    request,
    keypoint,
    index: slotIndex,
    tag: tags[slotIndex % tags.length] || keypoint.title || "untagged",
    createdAt,
  });
}

function patchQuestionSlotsWithFallback({
  questions,
  indexes,
  request,
  job,
  keypoints,
  createdAt,
  targetCount,
  compositionPlan,
}) {
  const next = Array.from({ length: targetCount }, (_, index) => questions[index] || null);
  for (const slotIndex of indexes) {
    next[slotIndex] = buildFallbackQuestionForSlot({
      request,
      job,
      keypoints,
      slotIndex,
      createdAt,
      compositionPlan,
    });
  }
  return ensureUniqueQuestionStems(next);
}

function buildCompletedBatchState(job, targetCount) {
  const source = job && job.batchState && typeof job.batchState === "object" ? job.batchState : {};
  return {
    batch1: {
      index: 1,
      requestedCount: targetCount,
      loadedCount: targetCount,
      status: "completed",
      attempts: Math.max(Number(source.batch1?.attempts || 0), 1),
      error: "",
    },
    batch2: {
      index: 2,
      requestedCount: 0,
      loadedCount: 0,
      status: "completed",
      attempts: Number(source.batch2?.attempts || 0),
      error: String(source.batch2?.error || ""),
    },
    batch3: {
      index: 3,
      requestedCount: 0,
      loadedCount: 0,
      status: "completed",
      attempts: Number(source.batch3?.attempts || 0),
      error: String(source.batch3?.error || ""),
    },
  };
}

function appendBatch({ job, session, batchIndex }) {
  const batchKey = `batch${batchIndex}`;
  const nextJob = {
    ...job,
    batchState: {
      ...(job.batchState || {}),
      [batchKey]: {
        index: batchIndex,
        requestedCount: 0,
        loadedCount: 0,
        status: "completed",
        attempts: Number(job.batchState?.[batchKey]?.attempts || 0) + 1,
        error: "",
      },
    },
    updatedAt: Date.now(),
  };

  return {
    savedCount: Array.isArray(session?.questions) ? session.questions.length : 0,
    keypoints: Array.isArray(nextJob.keypoints) ? nextJob.keypoints : [],
    session,
    generationJob: nextJob,
  };
}

function buildDeterministicFallbackResult({
  request,
  session,
  job,
  resolvedConfig,
  executionMode = "deterministic_fallback",
  fallbackReason = "",
}) {
  const targetCount = Number(request.targetCount) || 0;
  const createdAt = Date.now();
  const tags = normalizeTags(request.userTags || []);
  const keypoints = createKeypoints(request);
  const compositionPlan = buildCategoryCompositionPlan({
    request,
    keypoints,
    targetCount,
  });

  const questions = ensureUniqueQuestionStems(
    Array.from({ length: targetCount }, (_, index) => {
      const keypoint = pickKeypointForSlot({
        request,
        keypoints,
        slotIndex: index,
        compositionPlan,
      });

      return buildQuestion({
        jobId: job.jobId,
        request,
        keypoint,
        index,
        tag: tags[index % tags.length] || keypoint.title || "untagged",
        createdAt,
      });
    })
  );

  return finalizeGenerationResult(
    {
      session,
      job,
      keypoints,
      questions,
      targetCount,
      request,
      resolvedConfig,
      compositionPlan,
    },
    {
      skipSimilarityChecks: true,
      executionMode,
      fallbackReason,
      compositionPlan,
      allowSoftValidationErrors: true,
    }
  );
}

function finalizeGenerationResult(
  { session, job, keypoints, questions, targetCount, request, resolvedConfig, compositionPlan = null },
  {
    skipSimilarityChecks = false,
    executionMode = "live_llm",
    fallbackReason = "",
    compositionPlan: overrideCompositionPlan = null,
    allowSoftValidationErrors = false,
  } = {}
) {
  const activeCompositionPlan = overrideCompositionPlan || compositionPlan || null;

  const diagnostics = inspectQuestionSet(questions, targetCount, {
    skipSimilarityChecks,
    request,
    keypoints,
    compositionPlan: activeCompositionPlan,
  });
  if (diagnostics.errors.length > 0) {
    const hardFailureIndexes = collectHardFailureIndexes({
      diagnostics,
      questions,
      targetCount,
    });

    if (!allowSoftValidationErrors || hardFailureIndexes.length > 0) {
      const error = new Error(
        "generated questions failed validation: " + summarizeValidationErrors(diagnostics.errors)
      );
      error.code = ERROR_CODES.LLM_FAILED;
      throw error;
    }
  }

  return {
    savedCount: targetCount,
    keypoints,
    session: { ...session, questions },
    generationJob: {
      ...job,
      loadedCount: targetCount,
      status: "completed",
      keypoints,
      batchState: buildCompletedBatchState(job, targetCount),
      executionMode,
      fallbackReason: fallbackReason || "",
      provider: resolvedConfig?.provider || null,
      model: resolvedConfig?.model || null,
      categoryPlan: activeCompositionPlan
        ? {
            requiredDiversity: activeCompositionPlan.requiredDiversity,
            expectedCounts: activeCompositionPlan.expectedCounts,
          }
        : null,
    },
  };
}

async function runModelStep({
  llmConfig,
  messages,
  temperature,
  topP,
  maxOutputTokens,
  attempts,
  parse,
}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await createProviderText({
        config: llmConfig,
        messages,
        temperature,
        topP,
        maxOutputTokens,
      });
      const parsed = parse(result.text);
      return {
        ...parsed,
        providerText: result.text,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("model step failed without a specific error");
}

function createFatalProviderError(error, resolvedConfig, phaseLabel) {
  const detail = error?.providerText ? error.message : formatProviderError(error);
  const provider = resolvedConfig?.provider || "provider";
  const fatal = new Error(`${provider} ${phaseLabel} failed: ${detail}`);
  fatal.code = ERROR_CODES.LLM_FAILED;
  return fatal;
}

function applyRepairs(questions, repairs, targetCount = questions.length) {
  const next = Array.from({ length: Math.max(targetCount, questions.length) }, (_, index) =>
    questions[index] || null
  );
  for (const repair of repairs || []) {
    if (!repair || !Number.isInteger(repair.slotIndex)) {
      continue;
    }
    if (repair.slotIndex < 0 || repair.slotIndex >= next.length) {
      continue;
    }
    if (!repair.question || typeof repair.question !== "object") {
      continue;
    }
    next[repair.slotIndex] = repair.question;
  }
  return next;
}

async function buildLiveGenerationResult({ request, session, job, llmConfig }) {
  const targetCount = Number(request.targetCount) || 0;
  const createdAt = Date.now();
  const resolvedConfig = resolveLlmConfig(llmConfig);

  let keypoints;
  try {
    const extraction = await runModelStep({
      llmConfig: resolvedConfig,
      messages: buildKeypointExtractionMessages({ request }),
      temperature: EXTRACTION_TEMPERATURE,
      topP: EXTRACTION_TOP_P,
      maxOutputTokens: estimateExtractionOutputTokens(request),
      attempts: MAX_EXTRACTION_ATTEMPTS,
      parse: (text) => parseKeypointExtractionPayload({ text, request }),
    });
    keypoints = extraction.keypoints;
  } catch (error) {
    throw createFatalProviderError(error, resolvedConfig, "keypoint extraction");
  }

  const compositionPlan = buildCategoryCompositionPlan({
    request,
    keypoints,
    targetCount,
  });

  let questions;
  try {
    const generation = await runModelStep({
      llmConfig: resolvedConfig,
      messages: buildQuestionGenerationMessages({
        request,
        keypoints,
        questionCount: targetCount,
        antiRepetitionContext: buildAntiRepetitionContext(request, keypoints, compositionPlan),
      }),
      temperature: GENERATION_TEMPERATURE,
      topP: GENERATION_TOP_P,
      maxOutputTokens: estimateGenerationOutputTokens(request),
      attempts: MAX_GENERATION_ATTEMPTS,
      parse: (text) =>
        parseQuestionGenerationPayload({
          text,
          request,
          job,
          createdAt,
          keypoints,
          expectedCount: targetCount,
          allowPartial: true,
        }),
    });
    questions = Array.from({ length: targetCount }, (_, index) => generation.questions[index] || null);
  } catch (error) {
    throw createFatalProviderError(error, resolvedConfig, "question generation");
  }

  let diagnostics = inspectQuestionSet(questions, targetCount, {
    request,
    keypoints,
    compositionPlan,
  });
  let repairRound = 0;

  while (diagnostics.errors.length > 0 && repairRound < MAX_REPAIR_ATTEMPTS) {
    repairRound += 1;
    const failingIndexes =
      diagnostics.failingIndexes.length > 0
        ? diagnostics.failingIndexes
        : questions.map((_, index) => index);
    const missingIndexes = computeMissingQuestionIndexes(questions, targetCount);
    const repairIndexes = Array.from(new Set([...failingIndexes, ...missingIndexes])).sort(
      (left, right) => left - right
    );

    try {
      const repair = await runModelStep({
        llmConfig: resolvedConfig,
        messages: buildQuestionRepairMessages({
          request,
          keypoints,
          currentQuestions: questions,
          failingIndexes: repairIndexes,
          errorDetails: diagnostics.questionErrors,
        }),
        temperature: REPAIR_TEMPERATURE,
        topP: REPAIR_TOP_P,
        maxOutputTokens: estimateRepairOutputTokens(repairIndexes.length, request),
        attempts: 1,
        parse: (text) =>
          parseQuestionRepairPayload({
            text,
            request,
            job,
            createdAt,
            keypoints,
            expectedCount: repairIndexes.length,
            totalQuestionCount: targetCount,
            allowPartial: true,
          }),
      });
      questions = applyRepairs(questions, repair.repairs, targetCount);
      diagnostics = inspectQuestionSet(questions, targetCount, {
        request,
        keypoints,
        compositionPlan,
      });
    } catch (error) {
      throw createFatalProviderError(error, resolvedConfig, "question repair round " + repairRound);
    }
  }

  let executionMode = "live_llm";

  if (diagnostics.errors.length > 0) {
    const salvageIndexes = collectHardFailureIndexes({
      diagnostics,
      questions,
      targetCount,
    });

    if (salvageIndexes.length > 0) {
      questions = patchQuestionSlotsWithFallback({
        questions,
        indexes: salvageIndexes,
        request,
        job,
        keypoints,
        createdAt,
        targetCount,
        compositionPlan,
      });
      executionMode = "live_llm_padded";
      diagnostics = inspectQuestionSet(questions, targetCount, {
        request,
        keypoints,
        compositionPlan,
      });
    } else {
      executionMode = "live_llm_soft_accepted";
    }
  }

  return finalizeGenerationResult(
    {
      session,
      job,
      keypoints,
      questions,
      targetCount,
      request,
      resolvedConfig,
      compositionPlan,
    },
    {
      executionMode,
      skipSimilarityChecks: executionMode === "live_llm_padded",
      compositionPlan,
      allowSoftValidationErrors: true,
    }
  );
}

async function buildGenerationResult({ request, session, job, llmConfig }) {
  const resolvedConfig = resolveLlmConfig(llmConfig);
  if (!resolvedConfig.apiKey) {
    const reason = `missing API key for provider ${resolvedConfig.provider}`;
    if (!ALLOW_DETERMINISTIC_FALLBACK) {
      const error = new Error(
        `${reason}; live quiz generation is required because deterministic fallback is disabled`
      );
      error.code = ERROR_CODES.LLM_FAILED;
      throw error;
    }

    return buildDeterministicFallbackResult({
      request,
      session,
      job,
      resolvedConfig,
      executionMode: "deterministic_fallback_missing_provider",
      fallbackReason: reason,
    });
  }

  try {
    return await buildLiveGenerationResult({
      request,
      session,
      job,
      llmConfig: resolvedConfig,
    });
  } catch (error) {
    if (!ALLOW_DETERMINISTIC_FALLBACK) {
      throw error;
    }

    return buildDeterministicFallbackResult({
      request,
      session,
      job,
      resolvedConfig,
      executionMode: "deterministic_fallback_after_live_failure",
      fallbackReason: formatProviderError(error),
    });
  }
}

module.exports = {
  appendBatch,
  buildGenerationResult,
  createKeypoints,
  buildQuestion,
  validateQuestionSet,
};
