const http = require("http");
const { URL } = require("url");
const {
  API_PREFIX,
  ERROR_CODES,
  MAX_AVATAR_BYTES,
  PROVIDERS,
} = require("./constants");
const { buildGenerationResult, appendBatch } = require("./generation");
const {
  HttpError,
  applyCors,
  getBearerToken,
  parseBody,
  sendError,
  sendOk,
} = require("./http");
const { createRouter } = require("./router");
const { MemoryStore } = require("./store");
const { verifyProviderConfig } = require("./llm-provider");
const {
  extractMaterialFromGenerationImage,
  normalizeGenerationImageDataUrl,
} = require("./material-extraction");
const {
  buildIdempotencyKey,
  clone,
  compareChoices,
  createDefaultLlmConfig,
  deriveGoalTags,
  ensureStoredQuestion,
  normalizeTags,
  now,
  toPositiveInt,
  validateAccount,
  validatePassword,
} = require("./utils");

function normalizeFeedbackMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["after_all", "afterall", "after-all"].includes(raw)) {
    return "after_all";
  }
  if (["instant", "immediate", "after_each", "realtime"].includes(raw)) {
    return "instant";
  }
  return "";
}

function validateGeneratePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new HttpError(
      400,
      ERROR_CODES.BAD_REQUEST,
      "generate payload is required"
    );
  }
  const rawImageDataUrl = String(
    payload.imageDataUrl ||
      payload.image?.dataUrl ||
      payload.image?.url ||
      ""
  ).trim();
  if (!String(payload.material || "").trim() && !rawImageDataUrl) {
    throw new HttpError(
      400,
      ERROR_CODES.BAD_REQUEST,
      "material or image is required"
    );
  }
  if (!["single", "multi"].includes(payload.type)) {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, "type is invalid");
  }
  if (!["easy", "medium", "hard"].includes(payload.difficulty)) {
    throw new HttpError(
      400,
      ERROR_CODES.BAD_REQUEST,
      "difficulty is invalid"
    );
  }
  if (!["modeA", "modeB"].includes(payload.mode)) {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, "mode is invalid");
  }
  const feedbackMode = normalizeFeedbackMode(payload.feedbackMode);
  if (!feedbackMode) {
    throw new HttpError(
      400,
      ERROR_CODES.BAD_REQUEST,
      "feedbackMode is invalid"
    );
  }
  payload.feedbackMode = feedbackMode;

  const targetCount = Number(payload.targetCount);
  if (!Number.isInteger(targetCount) || targetCount <= 0 || targetCount > 100) {
    throw new HttpError(
      400,
      ERROR_CODES.BAD_REQUEST,
      "targetCount must be an integer between 1 and 100"
    );
  }

  const initialBatchCount = Number(payload.initialBatchCount);
  if (
    !Number.isInteger(initialBatchCount) ||
    initialBatchCount <= 0 ||
    initialBatchCount > 100
  ) {
    throw new HttpError(
      400,
      ERROR_CODES.BAD_REQUEST,
      "initialBatchCount must be an integer between 1 and 100"
    );
  }
  if (initialBatchCount !== targetCount) {
    throw new HttpError(
      400,
      ERROR_CODES.BAD_REQUEST,
      "initialBatchCount must equal targetCount"
    );
  }
  if (payload.userTags !== undefined && !Array.isArray(payload.userTags)) {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, "userTags must be an array");
  }

  const requestNonce = Number(payload.requestNonce || 0);
  if (!Number.isInteger(requestNonce) || requestNonce < 0) {
    throw new HttpError(
      400,
      ERROR_CODES.BAD_REQUEST,
      "requestNonce must be a non-negative integer"
    );
  }

  payload.targetCount = targetCount;
  payload.initialBatchCount = initialBatchCount;
  payload.requestNonce = requestNonce;
}

function normalizeGenerateRequestPayload(payload) {
  validateGeneratePayload(payload);
  const rawImageDataUrl = String(
    payload.imageDataUrl ||
      payload.image?.dataUrl ||
      payload.image?.url ||
      ""
  ).trim();
  const image = rawImageDataUrl
    ? normalizeGenerationImageDataUrl(rawImageDataUrl)
    : null;
  const material = String(payload.material || "").trim();
  const normalizedMode = image || (material && material.length <= 50)
    ? "modeA"
    : payload.mode;
  return {
    material,
    type: payload.type,
    difficulty: payload.difficulty,
    mode: normalizedMode,
    feedbackMode: normalizeFeedbackMode(payload.feedbackMode),
    targetCount: payload.targetCount,
    initialBatchCount: payload.initialBatchCount,
    requestNonce: payload.requestNonce,
    userTags: normalizeTags(payload.userTags || []),
    ...(image
      ? {
          image: {
            dataUrl: image.dataUrl,
            imageBase64: image.imageBase64,
            mimeType: image.mimeType,
            byteLength: image.byteLength,
            fingerprint: image.fingerprint,
          },
          imageName: String(payload.imageName || "").trim().slice(0, 120),
        }
      : {}),
  };
}

function resolveAuthAccount(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  return String(payload.account || payload.email || payload.phone || "").trim();
}

function validateAuthCredentialPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, "auth payload is required");
  }

  const accountResult = validateAccount(resolveAuthAccount(payload));
  if (!accountResult.ok) {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, accountResult.message);
  }

  const passwordResult = validatePassword(payload.password);
  if (!passwordResult.ok) {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, passwordResult.message);
  }

  return {
    account: accountResult.normalized,
    password: passwordResult.value,
    nickname: String(payload.nickname || "").trim(),
    avatarUrl: String(payload.avatarUrl || ""),
  };
}

function filterQuestionBank(questions, mainTab, tag) {
  let list = clone(questions);
  if (mainTab === "wrong") {
    list = list.filter((question) => question.wrongCount > 0);
  } else if (mainTab === "mastered") {
    list = list.filter((question) => question.isMastered);
  }

  const tagStatsMap = new Map();
  for (const question of list) {
    tagStatsMap.set(question.tag, (tagStatsMap.get(question.tag) || 0) + 1);
  }

  if (tag) {
    list = list.filter((question) => question.tag === tag);
  }

  // 保证题库返回稳定时间序：createdAt DESC 优先，id DESC 兜底
  list.sort((a, b) => {
    const timeA = Number.isFinite(a.createdAt) ? a.createdAt : 0;
    const timeB = Number.isFinite(b.createdAt) ? b.createdAt : 0;
    if (timeB !== timeA) return timeB - timeA;
    const idA = String(a.id || "");
    const idB = String(b.id || "");
    return idA > idB ? -1 : (idA < idB ? 1 : 0);
  });

  return {
    list,
    tagStats: Array.from(tagStatsMap.entries()).map(([name, count]) => ({
      tag: name,
      count,
    })),
  };
}

function isCompletedOneShotGenerationResult(session, generationJob) {
  if (!session || !generationJob) {
    return false;
  }

  const targetCount = Number(generationJob.targetCount || 0);
  if (!Number.isInteger(targetCount) || targetCount <= 0) {
    return false;
  }

  return (
    session.id === generationJob.sessionId &&
    session.generationJobId === generationJob.jobId &&
    Array.isArray(session.questions) &&
    session.questions.length === targetCount &&
    Number(generationJob.loadedCount || 0) === targetCount &&
    generationJob.status === "completed"
  );
}

function assertCompletedOneShotGenerationResult(result, targetCount) {
  const sessionCount = Array.isArray(result?.session?.questions)
    ? result.session.questions.length
    : 0;
  const savedCount = Number(result?.savedCount || 0);
  const jobTargetCount = Number(result?.generationJob?.targetCount || 0);
  const loadedCount = Number(result?.generationJob?.loadedCount || 0);
  const status = String(result?.generationJob?.status || "");

  if (
    !result?.session ||
    !result?.generationJob ||
    savedCount !== targetCount ||
    sessionCount !== targetCount ||
    jobTargetCount !== targetCount ||
    loadedCount !== targetCount ||
    status !== "completed"
  ) {
    const error = new Error(
      `question generation must return a completed one-shot result with exactly ${targetCount} questions`
    );
    error.code = ERROR_CODES.LLM_FAILED;
    throw error;
  }
}

function createApp(store = new MemoryStore()) {
  const router = createRouter();

  router.register("GET", `${API_PREFIX}/health`, { auth: false }, async (ctx) => {
    sendOk(ctx.res, {
      status: "ok",
      timestamp: now(),
    });
  });

  router.register(
    "POST",
    `${API_PREFIX}/auth/register`,
    { auth: false, bodyType: "json" },
    async (ctx) => {
      const payload = validateAuthCredentialPayload(ctx.body);
      const result = await store.registerAccount(payload);
      if (!result || !result.ok) {
        if (result && result.reason === "account_exists") {
          throw new HttpError(409, ERROR_CODES.CONFLICT, "account already exists");
        }
        throw new HttpError(400, ERROR_CODES.BAD_REQUEST, "account is invalid");
      }
      sendOk(ctx.res, result.data);
    }
  );

  router.register(
    "POST",
    `${API_PREFIX}/auth/login`,
    { auth: false, bodyType: "json" },
    async (ctx) => {
      const payload = validateAuthCredentialPayload(ctx.body);
      const data = await store.loginAccount(payload);
      if (!data) {
        throw new HttpError(401, ERROR_CODES.UNAUTHORIZED, "account or password is invalid");
      }
      sendOk(ctx.res, data);
    }
  );

  router.register(
    "POST",
    `${API_PREFIX}/auth/guest`,
    { auth: false, bodyType: "json" },
    async (ctx) => {
      const payload = ctx.body || {};
      const data = await store.createGuestLogin({
        nickname: payload.nickname,
        avatarUrl: payload.avatarUrl,
      });
      sendOk(ctx.res, data);
    }
  );

  router.register(
    "POST",
    `${API_PREFIX}/auth/refresh`,
    { auth: false, bodyType: "json" },
    async (ctx) => {
      const refreshToken = String((ctx.body || {}).refreshToken || "");
      const data = await store.refreshAuth(refreshToken);
      if (!data) {
        throw new HttpError(
          401,
          ERROR_CODES.UNAUTHORIZED,
          "refresh token is invalid or expired"
        );
      }
      sendOk(ctx.res, data);
    }
  );

  router.register("GET", `${API_PREFIX}/users/me`, {}, async (ctx) => {
    sendOk(ctx.res, clone(ctx.user));
  });

  router.register(
    "PATCH",
    `${API_PREFIX}/users/me`,
    { bodyType: "json" },
    async (ctx) => {
      const updated = await store.updateUser(ctx.user.userId, ctx.body || {});
      if (!updated) {
        throw new HttpError(404, ERROR_CODES.NOT_FOUND, "user not found");
      }
      sendOk(ctx.res, updated);
    }
  );

  router.register("GET", `${API_PREFIX}/llm/config`, {}, async (ctx) => {
    sendOk(ctx.res, await store.getLlmConfig(ctx.user.userId));
  });

  router.register(
    "PUT",
    `${API_PREFIX}/llm/config`,
    { bodyType: "json" },
    async (ctx) => {
      const payload = ctx.body || {};
      if (!PROVIDERS.some((item) => item.value === payload.provider)) {
        throw new HttpError(
          400,
          ERROR_CODES.BAD_REQUEST,
          "provider is invalid"
        );
      }
      if (!String(payload.baseUrl || "").trim()) {
        throw new HttpError(400, ERROR_CODES.BAD_REQUEST, "baseUrl is required");
      }
      if (!String(payload.model || "").trim()) {
        throw new HttpError(400, ERROR_CODES.BAD_REQUEST, "model is required");
      }

      const current = createDefaultLlmConfig();
      const nextValue = await store.setLlmConfig(ctx.user.userId, {
        ...current,
        ...payload,
        managedKeys: {
          ...current.managedKeys,
          ...((payload && payload.managedKeys) || {}),
        },
      });
      sendOk(ctx.res, nextValue);
    }
  );

  router.register(
    "POST",
    `${API_PREFIX}/llm/config/verify`,
    { bodyType: "json" },
    async (ctx) => {
      const payload = ctx.body || {};
      const result = await verifyProviderConfig(payload);
      if (!result.ok) {
        sendError(ctx.res, 400, result.code, result.message, {
          status: result.status || "error",
          message: result.message,
          checkedAt: now(),
          provider: result.provider,
          model: result.model,
          baseUrl: result.baseUrl,
        });
        return;
      }
      sendOk(ctx.res, {
        status: result.status || "success",
        message: result.message,
        checkedAt: now(),
        provider: result.provider,
        model: result.model,
        baseUrl: result.baseUrl,
      });
    }
  );

  router.register("GET", `${API_PREFIX}/llm/providers`, {}, async (ctx) => {
    sendOk(ctx.res, {
      providers: clone(PROVIDERS),
    });
  });

  router.register("GET", `${API_PREFIX}/tags`, {}, async (ctx) => {
    sendOk(ctx.res, {
      tags: await store.getTags(ctx.user.userId),
    });
  });

  router.register(
    "PUT",
    `${API_PREFIX}/tags`,
    { bodyType: "json" },
    async (ctx) => {
      const tags = normalizeTags((ctx.body || {}).tags || []);
      sendOk(ctx.res, {
        tags: await store.setTags(ctx.user.userId, tags),
      });
    }
  );

  router.register(
    "POST",
    `${API_PREFIX}/tags/generate`,
    { bodyType: "json" },
    async (ctx) => {
      const goal = String((ctx.body || {}).goal || "");
      sendOk(ctx.res, {
        tags: deriveGoalTags(goal),
      });
    }
  );

  router.register(
    "POST",
    `${API_PREFIX}/tags/retag-historical`,
    { bodyType: "json" },
    async (ctx) => {
      const tags = normalizeTags((ctx.body || {}).tags || []);
      const force = Boolean((ctx.body || {}).force);
      const questions = await store.getQuestionBank(ctx.user.userId);
      let updatedCount = 0;
      const updatedQuestions = questions.map((question, index) => {
        const hasExistingTag = Boolean(question.tag);
        if (!force && hasExistingTag) {
          return question;
        }
        const nextTag = tags[index % tags.length] || question.tag || "untagged";
        if (nextTag !== question.tag) {
          updatedCount += 1;
        }
        return {
          ...question,
          tag: nextTag,
        };
      });
      const normalizedQuestions = updatedQuestions.map((question) =>
        ensureStoredQuestion(question)
      );
      await store.overwriteQuestionBank(ctx.user.userId, normalizedQuestions);

      const currentSession = await store.getPracticeSession(ctx.user.userId);
      if (currentSession) {
        currentSession.questions = currentSession.questions.map((question, index) => {
          const matched = normalizedQuestions.find((item) => item.id === question.id);
          if (matched) {
            return matched;
          }
          if (!force && question.tag) {
            return question;
          }
          return {
            ...question,
            tag: tags[index % tags.length] || question.tag || "untagged",
          };
        });
        await store.setPracticeSession(ctx.user.userId, currentSession);
      }

      sendOk(ctx.res, {
        targetCount: questions.length,
        updatedCount,
        remainingCount: Math.max(questions.length - updatedCount, 0),
        usedAi: false,
        skipped: questions.length === 0,
      });
    }
  );

  router.register(
    "POST",
    `${API_PREFIX}/files/avatar`,
    { bodyType: "raw" },
    async (ctx) => {
      const contentType = String(ctx.req.headers["content-type"] || "");
      if (!contentType.includes("multipart/form-data")) {
        throw new HttpError(
          400,
          ERROR_CODES.BAD_REQUEST,
          "avatar upload must use multipart/form-data"
        );
      }
      if (ctx.body.length === 0 || ctx.body.length > MAX_AVATAR_BYTES) {
        throw new HttpError(
          400,
          ERROR_CODES.BAD_REQUEST,
          "avatar payload is empty or exceeds the size limit"
        );
      }
      const bodyText = ctx.body.toString("utf8");
      if (!bodyText.includes('name="file"')) {
        throw new HttpError(
          400,
          ERROR_CODES.BAD_REQUEST,
          'multipart field "file" is required'
        );
      }

      const url = `https://cdn.example.com/avatar/${ctx.user.userId}-${now()}.png`;
      const updated = await store.updateUser(ctx.user.userId, { avatarUrl: url });
      sendOk(ctx.res, {
        url,
        user: updated,
      });
    }
  );

  router.register(
    "GET",
    `${API_PREFIX}/practice-session/current`,
    {},
    async (ctx) => {
      const session = await store.getPracticeSession(ctx.user.userId);
      sendOk(ctx.res, {
        session,
      });
    }
  );

  router.register(
    "PUT",
    `${API_PREFIX}/practice-session/current`,
    { bodyType: "json" },
    async (ctx) => {
      const session = (ctx.body || {}).session;
      if (!session || typeof session !== "object") {
        throw new HttpError(
          400,
          ERROR_CODES.BAD_REQUEST,
          "session payload is required"
        );
      }
      const normalizedSession = {
        id: String(session.id || (await store.createSessionShell("modeA", "instant")).id),
        createdAt: Number.isFinite(session.createdAt) ? session.createdAt : now(),
        mode: session.mode === "modeB" ? "modeB" : "modeA",
        feedbackMode:
          session.feedbackMode === "after_all" ? "after_all" : "instant",
        generationJobId:
          typeof session.generationJobId === "string" ? session.generationJobId : null,
        questions: Array.isArray(session.questions)
          ? session.questions.map((question) => ensureStoredQuestion(question))
          : [],
      };
      await store.saveQuestions(ctx.user.userId, normalizedSession.questions);
      await store.setPracticeSession(ctx.user.userId, normalizedSession);
      sendOk(ctx.res, {
        session: normalizedSession,
      });
    }
  );

  router.register(
    "DELETE",
    `${API_PREFIX}/practice-session/current`,
    {},
    async (ctx) => {
      await store.clearPracticeSession(ctx.user.userId);
      sendOk(ctx.res, {});
    }
  );

  router.register(
    "POST",
    `${API_PREFIX}/questions/generate/cancel`,
    { bodyType: "json" },
    async (ctx) => {
      const payload = normalizeGenerateRequestPayload(ctx.body);
      const idempotencyKey = buildIdempotencyKey(ctx.user.userId, payload);
      const existing = await store.getIdempotency(ctx.user.userId, idempotencyKey);
      let cancelled = false;

      if (existing?.jobId) {
        const generationJob = await store.getGenerationJob(ctx.user.userId, existing.jobId);
        if (generationJob && generationJob.status === "running") {
          generationJob.status = "canceled";
          generationJob.updatedAt = now();
          await store.saveGenerationJob(ctx.user.userId, generationJob);
          cancelled = true;
        }
      }

      sendOk(ctx.res, {
        cancelled,
      });
    }
  );

  router.register(
    "POST",
    `${API_PREFIX}/questions/generate`,
    { bodyType: "json" },
    async (ctx) => {
      const payload = normalizeGenerateRequestPayload(ctx.body);
      const idempotencyKey = buildIdempotencyKey(ctx.user.userId, payload);
      const existing = await store.getIdempotency(ctx.user.userId, idempotencyKey);

      if (existing) {
        const existingJob = await store.getGenerationJob(ctx.user.userId, existing.jobId);
        const existingSession = await store.getPracticeSession(ctx.user.userId);
        if (
          existingJob &&
          existingSession &&
          existingSession.id === existing.sessionId &&
          isCompletedOneShotGenerationResult(existingSession, existingJob)
        ) {
          sendOk(ctx.res, {
            savedCount: existingSession.questions.length,
            keypoints: existingJob.keypoints,
            session: existingSession,
            generationJob: existingJob,
          });
          return;
        }
      }

      const session = await store.createSessionShell(payload.mode, payload.feedbackMode);
      const job = await store.createJobShell(payload, session.id);
      session.generationJobId = job.jobId;
      await store.saveGenerationJob(ctx.user.userId, job);
      await store.setIdempotency(ctx.user.userId, idempotencyKey, {
        jobId: job.jobId,
        sessionId: session.id,
      });

      let generationPayload = payload;
      if (payload.image) {
        try {
          const extractedMaterial = await extractMaterialFromGenerationImage({
            request: payload,
            llmConfig: await store.getLlmConfig(ctx.user.userId),
          });
          generationPayload = {
            ...payload,
            material: extractedMaterial,
          };
          job.material = extractedMaterial;
          job.updatedAt = now();
          await store.saveGenerationJob(ctx.user.userId, job);
        } catch (error) {
          const failedJob = {
            ...job,
            status: "canceled",
            updatedAt: now(),
          };
          await store.saveGenerationJob(ctx.user.userId, failedJob);
          throw new HttpError(
            error.code === ERROR_CODES.VALIDATION_FAILED ? 400 : 500,
            error.code || ERROR_CODES.LLM_FAILED,
            error.message || "image material extraction failed"
          );
        }

        const currentJobAfterExtraction = await store.getGenerationJob(
          ctx.user.userId,
          job.jobId
        );
        if (currentJobAfterExtraction && currentJobAfterExtraction.status === "canceled") {
          throw new HttpError(
            409,
            ERROR_CODES.CONFLICT,
            "question generation was canceled"
          );
        }
      }

      let result;
      try {
        result = await buildGenerationResult({
          request: generationPayload,
          session,
          job,
          llmConfig: await store.getLlmConfig(ctx.user.userId),
        });
      } catch (error) {
        const failedJob = {
          ...job,
          status: "canceled",
          updatedAt: now(),
        };
        await store.saveGenerationJob(ctx.user.userId, failedJob);
        throw new HttpError(
          error.code === ERROR_CODES.VALIDATION_FAILED ? 400 : 500,
          error.code || ERROR_CODES.LLM_FAILED,
          error.message || "question generation failed"
        );
      }

      const currentJob = await store.getGenerationJob(ctx.user.userId, job.jobId);
      if (currentJob && currentJob.status === "canceled") {
        throw new HttpError(
          409,
          ERROR_CODES.CONFLICT,
          "question generation was canceled"
        );
      }

      assertCompletedOneShotGenerationResult(result, payload.targetCount);

      await store.saveQuestions(ctx.user.userId, result.session.questions);
      await store.setPracticeSession(ctx.user.userId, result.session);
      await store.saveGenerationJob(ctx.user.userId, result.generationJob);
      await store.setIdempotency(ctx.user.userId, idempotencyKey, {
        jobId: result.generationJob.jobId,
        sessionId: result.session.id,
      });

      sendOk(ctx.res, result);
    }
  );

  router.register("GET", `${API_PREFIX}/question-bank/full`, {}, async (ctx) => {
    sendOk(ctx.res, {
      questions: await store.getQuestionBank(ctx.user.userId),
    });
  });

  router.register(
    "PUT",
    `${API_PREFIX}/question-bank/full`,
    { bodyType: "json" },
    async (ctx) => {
      const questions = Array.isArray((ctx.body || {}).questions)
        ? ctx.body.questions.map((question) => ensureStoredQuestion(question))
        : [];
      const savedCount = await store.overwriteQuestionBank(ctx.user.userId, questions);
      sendOk(ctx.res, {
        savedCount,
      });
    }
  );

  router.register("GET", `${API_PREFIX}/question-bank`, {}, async (ctx) => {
    const page = toPositiveInt(ctx.query.page, 1);
    const pageSize = toPositiveInt(ctx.query.pageSize, 20);
    const mainTab = ["all", "wrong", "mastered"].includes(ctx.query.mainTab)
      ? ctx.query.mainTab
      : "all";
    const tag = String(ctx.query.tag || "").trim();
    const allQuestions = await store.getQuestionBank(ctx.user.userId);
    const filtered = filterQuestionBank(allQuestions, mainTab, tag);
    const start = (page - 1) * pageSize;
    const pagedList = filtered.list.slice(start, start + pageSize);

    sendOk(ctx.res, {
      list: pagedList,
      total: filtered.list.length,
      tagStats: filtered.tagStats,
    });
  });

  router.register(
    "DELETE",
    `${API_PREFIX}/question-bank`,
    { bodyType: "json" },
    async (ctx) => {
      const ids = Array.isArray((ctx.body || {}).ids)
        ? ctx.body.ids.map((id) => String(id))
        : [];
      const deletedCount = await store.deleteQuestions(ctx.user.userId, ids);
      sendOk(ctx.res, {
        deletedCount,
      });
    }
  );

  router.register(
    "PATCH",
    `${API_PREFIX}/question-bank/tags`,
    { bodyType: "json" },
    async (ctx) => {
      const tagById =
        ctx.body && typeof ctx.body.tagById === "object" && ctx.body.tagById
          ? ctx.body.tagById
          : {};
      let updatedCount = 0;
      for (const [questionId, tag] of Object.entries(tagById)) {
        const updated = await store.updateQuestion(
          ctx.user.userId,
          questionId,
          (question) => ({
            ...question,
            tag: String(tag || "").trim() || question.tag,
          })
        );
        if (updated) {
          updatedCount += 1;
        }
      }

      const session = await store.getPracticeSession(ctx.user.userId);
      if (session) {
        session.questions = session.questions.map((question) =>
          tagById[question.id]
            ? {
                ...question,
                tag: String(tagById[question.id] || "").trim() || question.tag,
              }
            : question
        );
        await store.setPracticeSession(ctx.user.userId, session);
      }

      sendOk(ctx.res, {
        updatedCount,
      });
    }
  );

  router.register(
    "POST",
    `${API_PREFIX}/question-bank/:questionId/attempt`,
    { bodyType: "json" },
    async (ctx) => {
      const question = await store.getQuestion(ctx.user.userId, ctx.params.questionId);
      if (!question) {
        throw new HttpError(404, ERROR_CODES.NOT_FOUND, "question not found");
      }

      const userChoice = String((ctx.body || {}).userChoice || "");
      const isCorrect = compareChoices(userChoice, question.answer);
      const timestamp = now();
      const updatedQuestion = await store.updateQuestion(
        ctx.user.userId,
        ctx.params.questionId,
        (current) => ({
          ...current,
          practiceCount: current.practiceCount + 1,
          wrongCount: isCorrect ? current.wrongCount : current.wrongCount + 1,
          ...(isCorrect ? {} : { lastWrongAt: timestamp }),
        })
      );

      const session = await store.getPracticeSession(ctx.user.userId);
      if (session) {
        session.questions = session.questions.map((item) =>
          item.id === question.id ? clone(updatedQuestion) : item
        );
        await store.setPracticeSession(ctx.user.userId, session);
      }

      sendOk(ctx.res, {
        isCorrect,
        correctAnswer: question.answer,
        explanation: question.explanation,
        practiceCount: updatedQuestion.practiceCount,
        wrongCount: updatedQuestion.wrongCount,
        lastWrongAt: updatedQuestion.lastWrongAt || 0,
      });
    }
  );

  router.register(
    "PATCH",
    `${API_PREFIX}/question-bank/:questionId/mastered`,
    { bodyType: "json" },
    async (ctx) => {
      const isMastered = Boolean((ctx.body || {}).isMastered);
      const updated = await store.updateQuestion(
        ctx.user.userId,
        ctx.params.questionId,
        (question) => ({
          ...question,
          isMastered,
        })
      );
      if (!updated) {
        throw new HttpError(404, ERROR_CODES.NOT_FOUND, "question not found");
      }

      const session = await store.getPracticeSession(ctx.user.userId);
      if (session) {
        session.questions = session.questions.map((question) =>
          question.id === updated.id ? clone(updated) : question
        );
        await store.setPracticeSession(ctx.user.userId, session);
      }

      sendOk(ctx.res, {
        updated: true,
      });
    }
  );

  router.register(
    "GET",
    `${API_PREFIX}/generation-jobs/active`,
    {},
    async (ctx) => {
      const generationJob = await store.getActiveGenerationJob(ctx.user.userId);
      const session = generationJob
        ? await store.getPracticeSession(ctx.user.userId)
        : null;
      sendOk(ctx.res, {
        generationJob,
        session: session && session.generationJobId === generationJob?.jobId ? session : null,
      });
    }
  );

  router.register(
    "GET",
    `${API_PREFIX}/generation-jobs/:jobId`,
    {},
    async (ctx) => {
      const generationJob = await store.getGenerationJob(
        ctx.user.userId,
        ctx.params.jobId
      );
      if (!generationJob) {
        throw new HttpError(404, ERROR_CODES.NOT_FOUND, "generation job not found");
      }
      sendOk(ctx.res, {
        generationJob,
      });
    }
  );

  router.register(
    "POST",
    `${API_PREFIX}/generation-jobs/:jobId/batches/:batchIndex`,
    { bodyType: "json" },
    async (ctx) => {
      const generationJob = await store.getGenerationJob(
        ctx.user.userId,
        ctx.params.jobId
      );
      if (!generationJob) {
        throw new HttpError(404, ERROR_CODES.NOT_FOUND, "generation job not found");
      }

      const session = await store.getPracticeSession(ctx.user.userId);
      if (!session || session.id !== generationJob.sessionId) {
        throw new HttpError(
          409,
          ERROR_CODES.CONFLICT,
          "current practice session does not match the generation job"
        );
      }

      const batchIndex = Number(ctx.params.batchIndex);
      if (![2, 3].includes(batchIndex)) {
        throw new HttpError(400, ERROR_CODES.BAD_REQUEST, "batchIndex is invalid");
      }

      const result = appendBatch({
        job: generationJob,
        session,
        batchIndex,
      });

      await store.saveQuestions(ctx.user.userId, result.session.questions);
      await store.setPracticeSession(ctx.user.userId, result.session);
      await store.saveGenerationJob(ctx.user.userId, result.generationJob);

      sendOk(ctx.res, result);
    }
  );

  router.register(
    "POST",
    `${API_PREFIX}/generation-jobs/:jobId/cancel`,
    { bodyType: "json" },
    async (ctx) => {
      const generationJob = await store.getGenerationJob(
        ctx.user.userId,
        ctx.params.jobId
      );
      if (!generationJob) {
        throw new HttpError(404, ERROR_CODES.NOT_FOUND, "generation job not found");
      }

      if (generationJob.status !== "completed") {
        generationJob.status = "canceled";
        generationJob.updatedAt = now();
        await store.saveGenerationJob(ctx.user.userId, generationJob);
      }

      sendOk(ctx.res, {
        cancelled: generationJob.status === "canceled",
      });
    }
  );

  async function handle(req, res) {
    applyCors(res, req);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const match = router.match(req.method, url.pathname);
    if (!match) {
      sendError(res, 404, ERROR_CODES.NOT_FOUND, "route not found");
      return;
    }

    try {
      let user = null;
      if (match.route.options.auth) {
        const token = getBearerToken(req);
        if (!token) {
          throw new HttpError(
            401,
            ERROR_CODES.UNAUTHORIZED,
            "missing bearer token"
          );
        }
        user = await store.getUserByToken(token);
        if (!user) {
          throw new HttpError(
            401,
            ERROR_CODES.UNAUTHORIZED,
            "token is invalid or expired"
          );
        }
      }

      const body = await parseBody(req, match.route.options.bodyType);
      const query = Object.fromEntries(url.searchParams.entries());
      await match.route.handler({
        req,
        res,
        store,
        user,
        body,
        query,
        params: match.params,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, error.message, error.data);
        return;
      }
      sendError(
        res,
        500,
        error.code || ERROR_CODES.INTERNAL_ERROR,
        error.message || "internal error"
      );
    }
  }

  return {
    store,
    server: http.createServer(handle),
    handle,
  };
}

module.exports = {
  createApp,
};
