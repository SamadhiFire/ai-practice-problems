const MODE_RULES = {
  modeA: {
    label: "Keypoint Extraction",
    prompt:
      "Extract important knowledge points from the provided material first, then generate useful questions around those points. Answers, explanations, and evidence do not need to be copied directly from the material.",
  },
  modeB: {
    label: "Knowledge Extension",
    prompt:
      "Extract important knowledge points first, then expand them into broader but still relevant concepts, scenarios, misconceptions, and applications.",
  },
};

const DIFFICULTY_RULES = {
  easy: {
    label: "Easy",
    prompt:
      "Use direct stems and clearly distinguishable distractors; focus on basic recognition and direct understanding.",
  },
  medium: {
    label: "Medium",
    prompt:
      "Add common misconceptions and condition changes; test understanding, discrimination, and light reasoning.",
  },
  hard: {
    label: "Hard",
    prompt:
      "Test boundaries, counterexamples, cross-sentence integration, and implicit logic; distractors should feel plausibly wrong.",
  },
};

const FEEDBACK_MODE_RULES = {
  instant: {
    label: "Instant Feedback",
    prompt: "Keep explanation within 1 sentence and point to the key evidence plus the main misconception.",
  },
  after_all: {
    label: "After-All Feedback",
    prompt: "Keep explanation within 2 sentences and cover both evidence and review value.",
  },
};

const SINGLE_CORRECT_KEYS = ["A", "B", "C", "D"];
const MULTI_CORRECT_PATTERNS = [
  ["A", "C"],
  ["A", "D"],
  ["B", "C"],
  ["B", "D"],
  ["A", "B", "D"],
  ["A", "C", "D"],
];

function getRequestedKeypointCount(targetCount) {
  const count = Number(targetCount || 0);
  if (!Number.isFinite(count) || count <= 0) {
    return 4;
  }
  return Math.min(Math.max(count, 1), 10);
}

function detectLocale(text) {
  const value = String(text || "");
  const cjkCount = (value.match(/[\u3400-\u9fff]/g) || []).length;
  return cjkCount >= 2 ? "zh" : "en";
}

function getModeRule(mode) {
  return MODE_RULES[mode] || MODE_RULES.modeA;
}

function getDifficultyRule(difficulty) {
  return DIFFICULTY_RULES[difficulty] || DIFFICULTY_RULES.medium;
}

function getFeedbackModeRule(feedbackMode) {
  return FEEDBACK_MODE_RULES[feedbackMode] || FEEDBACK_MODE_RULES.instant;
}

function normalizeTextForSimilarity(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/keypoint\s*\d+/g, "")
    .replace(/\u8003\u70b9\s*\d+/g, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

function buildNGrams(text, size = 2) {
  const normalized = normalizeTextForSimilarity(text);
  if (!normalized) {
    return new Set();
  }
  if (normalized.length <= size) {
    return new Set([normalized]);
  }

  const grams = new Set();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

function computeTextSimilarity(left, right) {
  const leftNormalized = normalizeTextForSimilarity(left);
  const rightNormalized = normalizeTextForSimilarity(right);
  if (!leftNormalized || !rightNormalized) {
    return 0;
  }
  if (leftNormalized === rightNormalized) {
    return 1;
  }

  const leftGrams = buildNGrams(leftNormalized);
  const rightGrams = buildNGrams(rightNormalized);
  let intersection = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftGrams, ...rightGrams]).size || 1;
  const jaccard = intersection / union;
  const containment =
    leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)
      ? Math.min(leftNormalized.length, rightNormalized.length) /
        Math.max(leftNormalized.length, rightNormalized.length)
      : 0;

  return Math.max(jaccard, containment);
}

function chooseSingleCorrectKey(index) {
  return SINGLE_CORRECT_KEYS[index % SINGLE_CORRECT_KEYS.length];
}

function chooseMultiCorrectKeys(index) {
  return MULTI_CORRECT_PATTERNS[index % MULTI_CORRECT_PATTERNS.length];
}

function renderTemplate(template, values) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value || "")),
    template
  );
}

function pickTemplate(list, index) {
  const source = Array.isArray(list) && list.length > 0 ? list : ["{{title}}"];
  return source[index % source.length];
}

function getStemTemplates() {
  return {
    modeA: {
      single: {
        easy: [
          "Which statement is directly supported by the source point '{{title}}'?",
          "According to the material, which option best matches '{{title}}'?",
        ],
        medium: [
          "Which judgment about '{{title}}' is most defensible from the source evidence?",
          "Which option best captures the source meaning of '{{title}}'?",
        ],
        hard: [
          "After ruling out common misreadings, which conclusion about '{{title}}' remains valid?",
          "Which option keeps the strongest evidence discipline around '{{title}}'?",
        ],
      },
      multi: {
        easy: ["Which options are directly supported by the source point '{{title}}'?"],
        medium: ["Which options remain valid when '{{title}}' is checked against the source?"],
        hard: ["Which options survive a strict evidence check around '{{title}}'?"],
      },
    },
    modeB: {
      single: {
        easy: ["Using '{{title}}' as an anchor, which limited extension is most reasonable?"],
        medium: ["Which extended judgment stays closest to the source anchor '{{title}}'?"],
        hard: ["Which conclusion shows disciplined extension from '{{title}}' without drifting away?"],
      },
      multi: {
        easy: ["Which options are acceptable limited extensions of '{{title}}'?"],
        medium: ["Which options stay within a reasonable extension around '{{title}}'?"],
        hard: ["Which options remain valid after disciplined extension from '{{title}}'?"],
      },
    },
  };
}

function buildFallbackStem({ request, keypoint, index }) {
  const templates = getStemTemplates();
  const modeTemplates = templates[request.mode] || templates.modeA;
  const typeTemplates = modeTemplates[request.type === "multi" ? "multi" : "single"];
  const difficultyTemplates = typeTemplates[request.difficulty] || typeTemplates.medium;
  return renderTemplate(pickTemplate(difficultyTemplates, index), {
    title: keypoint.title || `Keypoint ${index + 1}`,
  });
}

function buildFallbackOptionText({
  kind,
  keypoint,
  mode,
  difficulty,
  variantSeed,
}) {
  const quote = String(keypoint.evidence_quote || keypoint.title || "source point").slice(0, 64);
  const title = String(keypoint.title || quote || "source point").slice(0, 24);
  const seed = Number.isFinite(variantSeed) ? variantSeed : 0;

  const bank = {
    correct:
      mode === "modeB"
        ? [
            `Extends '${title}' in a controlled way without leaving the source theme.`,
            `Uses '${quote}' as an anchor for a limited and defensible extension.`,
            `Builds on '${title}' while keeping the same core condition and logic.`,
          ]
        : [
            `Matches the source meaning of '${title}' without adding unsupported claims.`,
            `Stays within the evidence boundary implied by '${quote}'.`,
            `Faithfully reflects what the source actually supports about '${title}'.`,
          ],
    trap: [
      "Looks close to the source, but quietly swaps a key condition.",
      "Starts from a real detail, then stretches it into the wrong conclusion.",
      "Uses familiar wording while changing the actual point being tested.",
    ],
    overclaim: [
      "Turns a local conclusion into an absolute claim the source never guarantees.",
      "Sounds stronger than the evidence can support.",
      "Converts a conditional statement into a universal rule.",
    ],
    contradiction: [
      "Runs against the source evidence or reverses the original direction of meaning.",
      "Conflicts with the source condition or judgment.",
      "Looks related, but actually negates the source conclusion.",
    ],
    drift: [
      `Seems plausible, but answers a different question from '${title}'.`,
      `Touches the same theme while drifting away from the actual examinable point.`,
      `Sounds relevant, but leaves the source focus unresolved.`,
    ],
  };

  const source =
    kind === "trap" && difficulty === "hard"
      ? [
          "Looks highly similar to the source, but drifts at a critical boundary condition.",
          "Changes just one detail, but that change breaks the original conclusion.",
          "Feels like a real exam distractor, yet its logic no longer matches the source.",
        ]
      : bank[kind] || bank.drift;

  return pickTemplate(source, seed);
}

function buildFallbackOptions({ request, keypoint, index }) {
  const keys = ["A", "B", "C", "D"];
  const wrongKinds = ["trap", "overclaim", "contradiction", "drift"];

  if (request.type === "multi") {
    const correctKeys = chooseMultiCorrectKeys(index);
    const options = keys.map((key, optionIndex) => ({
      key,
      text: buildFallbackOptionText({
        kind: correctKeys.includes(key)
          ? "correct"
          : wrongKinds[(index + optionIndex) % wrongKinds.length],
        keypoint,
        mode: request.mode,
        difficulty: request.difficulty,
        variantSeed: index * keys.length + optionIndex,
      }),
    }));

    return {
      options,
      answer: correctKeys.join(","),
    };
  }

  const correctKey = chooseSingleCorrectKey(index);
  let wrongPointer = 0;
  const options = keys.map((key, optionIndex) => ({
    key,
    text: buildFallbackOptionText({
      kind: key === correctKey ? "correct" : wrongKinds[wrongPointer++ % wrongKinds.length],
      keypoint,
      mode: request.mode,
      difficulty: request.difficulty,
      variantSeed: index * keys.length + optionIndex,
    }),
  }));

  return {
    options,
    answer: correctKey,
  };
}

function buildFallbackExplanation({ keypoint, answer }) {
  return `The correct answer is ${answer}, because only it stays aligned with '${keypoint.evidence_quote}'.`;
}

module.exports = {
  MODE_RULES,
  DIFFICULTY_RULES,
  FEEDBACK_MODE_RULES,
  getRequestedKeypointCount,
  getModeRule,
  getDifficultyRule,
  getFeedbackModeRule,
  computeTextSimilarity,
  buildFallbackStem,
  buildFallbackOptions,
  buildFallbackExplanation,
  detectLocale,
};
