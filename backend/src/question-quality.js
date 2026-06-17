const { splitMaterial } = require("./utils");
const { computeTextSimilarity } = require("./question-generation-rules");

const ZH_GENERIC_PATTERNS = [
  /\u975e\u5e38\u68d2\u7684\u95ee\u9898/,
  /\u597d\u95ee\u9898/,
  /\u503c\u5f97\u601d\u8003/,
  /\u503c\u5f97\u5173\u6ce8/,
  /\u6211\u4eec\u6765\u770b\u770b/,
  /\u4e0b\u9762\u6765/,
  /\u63a5\u4e0b\u6765/,
  /\u8fd9\u662f\u4e2a.+\u95ee\u9898/,
];

const EN_GENERIC_PATTERNS = [
  /great question/i,
  /excellent question/i,
  /interesting question/i,
  /let'?s look at/i,
  /next we/i,
];

const META_STEM_PATTERNS = [
  /\u56f4\u7ed5.?\u6750\u6599/,
  /\u6839\u636e.?\u6750\u6599.?["\u201c]/,
  /\u6750\u6599.?["\u201c][^"\u201d]+["\u201d]/,
  /\u672c\u6587.?["\u201c][^"\u201d]+["\u201d]/,
  /source material/i,
  /quoted phrase/i,
];

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectLocale(text) {
  return /[\u3400-\u9fff]/.test(String(text || "")) ? "zh" : "en";
}

function containsGenericFiller(text) {
  const value = normalizeWhitespace(text);
  if (!value) {
    return false;
  }

  const patterns = detectLocale(value) === "zh" ? ZH_GENERIC_PATTERNS : EN_GENERIC_PATTERNS;
  return patterns.some((pattern) => pattern.test(value));
}

function containsMetaStem(text) {
  const value = normalizeWhitespace(text);
  if (!value) {
    return false;
  }
  return META_STEM_PATTERNS.some((pattern) => pattern.test(value));
}

function countMeaningfulUnits(text) {
  const value = normalizeWhitespace(text);
  if (!value) {
    return 0;
  }

  const hanCount = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const numericTokens = value.match(/\b\d+(?:\.\d+)?\b/g) || [];
  const latinTerms = value.match(/\b[a-zA-Z][a-zA-Z0-9_-]{1,}\b/g) || [];
  const formulaMarks = value.match(/[=*+\-/()%]/g) || [];

  if (detectLocale(value) === "zh") {
    return (
      hanCount +
      numericTokens.length * 2 +
      latinTerms.length * 2 +
      Math.min(formulaMarks.length, 6)
    );
  }

  const segmentCount = value
    .split(/[\u002C\uFF0C\u3001\uFF1B;]/)
    .map((item) => item.trim())
    .filter(Boolean).length;

  return Math.max(segmentCount, latinTerms.length + numericTokens.length);
}

function looksFormulaDense(text) {
  return /(=|\b1000\b|x\s*1000|CTR|CPC|CPA|CPM|eCPM|revenue|impression|click|conversion|formula|calculate|metric|bid|\u516c\u5f0f|\u6362\u7b97|\u6536\u76ca|\u6536\u5165|\u5c55\u793a|\u70b9\u51fb|\u8f6c\u5316|\u51fa\u4ef7|\u7ade\u4ef7|\u5343\u6b21|\u6bcf\u5343\u6b21|\u70b9\u51fb\u7387|\u4e0b\u8f7d)/i.test(
    String(text || "")
  );
}

function isLowInformationSnippet(text) {
  const value = normalizeWhitespace(text);
  if (!value) {
    return true;
  }

  const locale = detectLocale(value);
  const unitCount = countMeaningfulUnits(value);
  if (
    looksFormulaDense(value) ||
    /(\u4e0b\u8f7d|\u8f6c\u5316|\u51fa\u4ef7|\u7ade\u4ef7|\u70b9\u51fb\u7387|\u5c55\u793a\u91cf|\u6536\u5165|\u6536\u76ca|\u6bcf\u5343\u6b21|\u5343\u6b21\u5c55\u793a|\u5e73\u53f0|\u5e7f\u544a\u4f4d|\u573a\u666f|\u9009\u62e9|\u66f4\u613f\u610f)/i.test(value)
  ) {
    return false;
  }
  if (locale === "zh" && unitCount < 10) {
    return true;
  }
  if (locale !== "zh" && unitCount < 4) {
    return true;
  }
  if (containsGenericFiller(value) && unitCount < 20) {
    return true;
  }
  if (/^["\u201c\u201d'\u2018\u2019\u300c\u300e].+["\u201c\u201d'\u2018\u2019\u300d\u300f]$/.test(value) && unitCount < 18) {
    return true;
  }

  return false;
}

function explodeLongSnippet(snippet) {
  const value = normalizeWhitespace(snippet);
  if (!value) {
    return [];
  }

  if (value.length <= 90 || looksFormulaDense(value)) {
    return [value];
  }

  const secondary = value
    .split(/[\u002C\uFF0C\u3001\uFF1B;]/)
    .map((item) => normalizeWhitespace(item))
    .filter((item) => countMeaningfulUnits(item) >= 8);

  return secondary.length > 1 ? secondary : [value];
}

function dedupeSnippets(snippets, limit) {
  const unique = [];
  for (const snippet of snippets) {
    const duplicated = unique.some(
      (existing) => computeTextSimilarity(existing, snippet) >= 0.9
    );
    if (!duplicated) {
      unique.push(snippet);
    }
    if (unique.length >= limit) {
      break;
    }
  }
  return unique;
}

function extractQuestionSourceSnippets(material, limit = 12) {
  const rawSnippets = splitMaterial(material)
    .flatMap((snippet) => explodeLongSnippet(snippet))
    .map((snippet) => normalizeWhitespace(snippet))
    .filter(Boolean);

  const filtered = rawSnippets.filter((snippet) => !isLowInformationSnippet(snippet));
  const chosen = dedupeSnippets(filtered.length > 0 ? filtered : rawSnippets, limit);

  if (chosen.length > 0) {
    return chosen;
  }

  const fallback = normalizeWhitespace(String(material || "")).slice(0, 160);
  return fallback ? [fallback] : [];
}

function buildPromptMaterial(material, limit = 12) {
  const snippets = extractQuestionSourceSnippets(material, limit);
  return snippets.map((snippet, index) => `${index + 1}. ${snippet}`).join("\n");
}

function extractQuotedFragments(text) {
  const value = String(text || "");
  const matches = [];
  const patterns = [/["\u201c\u201d]([^"\u201c\u201d]{2,40})["\u201c\u201d]/g, /[\u300c\u300e]([^\u300c\u300e\u300d\u300f]{2,40})[\u300d\u300f]/g];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const fragment = normalizeWhitespace(match[1]);
      if (fragment) {
        matches.push(fragment);
      }
    }
  }

  return Array.from(new Set(matches));
}

function normalizeComparableText(text) {
  return normalizeWhitespace(text)
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .toLowerCase();
}

function isTrivialFragment(text) {
  const value = normalizeWhitespace(text);
  if (!value) {
    return true;
  }
  return containsGenericFiller(value);
}

function findQuestionQualityErrors(question, context = {}) {
  const errors = [];
  const stem = String(question?.stem || "");
  const evidenceQuote = String(question?.evidence_quote || "");
  const options = Array.isArray(question?.options) ? question.options : [];

  if (containsGenericFiller(stem)) {
    errors.push(`question stem is too generic: ${stem}`);
  }
  if (containsMetaStem(stem)) {
    errors.push(`question stem is meta rather than examinable: ${stem}`);
  }
  if (containsGenericFiller(evidenceQuote) && countMeaningfulUnits(evidenceQuote) < 20) {
    errors.push(`question evidence is too generic: ${evidenceQuote}`);
  }

  const referenceFragments = new Set(
    [...extractQuotedFragments(stem), ...extractQuotedFragments(evidenceQuote)].filter(
      (fragment) => isTrivialFragment(fragment)
    )
  );
  const fragmentCounts = new Map();

  for (const text of [stem, ...options.map((option) => option.text)]) {
    for (const fragment of extractQuotedFragments(text)) {
      if (countMeaningfulUnits(fragment) <= 24 && isTrivialFragment(fragment)) {
        fragmentCounts.set(fragment, (fragmentCounts.get(fragment) || 0) + 1);
      }
    }
  }

  for (const [fragment, count] of fragmentCounts.entries()) {
    if (count >= 3) {
      errors.push(`question overuses the same quoted fragment: ${fragment}`);
    }
  }

  for (const option of options) {
    const optionText = String(option?.text || "");
    if (containsGenericFiller(optionText)) {
      errors.push(`option is too generic: ${optionText}`);
      continue;
    }
    if (containsMetaStem(optionText)) {
      errors.push(`option is meta rather than an answer choice: ${optionText}`);
      continue;
    }

    const normalizedOption = normalizeComparableText(optionText);
    if (!normalizedOption) {
      continue;
    }

    for (const fragment of referenceFragments) {
      const normalizedFragment = normalizeComparableText(fragment);
      if (!normalizedFragment) {
        continue;
      }
      if (normalizedOption === normalizedFragment && countMeaningfulUnits(fragment) <= 24) {
        errors.push(
          `option is a trivial restatement of a low-information quoted fragment: ${optionText}`
        );
        break;
      }
    }

    const normalizedEvidence = normalizeComparableText(evidenceQuote);
    if (
      normalizedEvidence &&
      normalizedOption === normalizedEvidence &&
      countMeaningfulUnits(evidenceQuote) <= 24 &&
      isTrivialFragment(evidenceQuote)
    ) {
      errors.push(`option is a trivial restatement of low-information evidence quote: ${optionText}`);
    }
  }

  return Array.from(new Set(errors));
}

module.exports = {
  buildPromptMaterial,
  containsGenericFiller,
  extractQuestionSourceSnippets,
  findQuestionQualityErrors,
};
