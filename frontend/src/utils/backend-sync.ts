import type { ApiKeyValidationSnapshot, LlmProvider } from './llm'
import type { PracticeSession } from './practice-session'
import type { StoredQuestion } from './question-bank'
import type { GenerationJob } from './generation-job'
import { BackendApiError, apiRequest } from './backend-api'
import { clearAuthState, ensureAuthenticated, loadAuthState, refreshAuthToken } from './account'

type ManagedKeysPayload = Record<string, string>

export interface AttemptResult {
  isCorrect: boolean
  correctAnswer: string
  explanation: string
  practiceCount: number
  wrongCount: number
  lastWrongAt: number
}

export interface RetagSummary {
  targetCount: number
  updatedCount: number
  remainingCount: number
  usedAi: boolean
  skipped: boolean
}

export interface GenerationJobPayload {
  savedCount: number
  keypoints: unknown[]
  session: PracticeSession
  generationJob: GenerationJob
}

export interface GenerationBatchPayload {
  appendedCount: number
  questions: StoredQuestion[]
  session: PracticeSession
  generationJob: GenerationJob
}

export interface ActiveGenerationJobPayload {
  session: PracticeSession | null
  generationJob: GenerationJob | null
}

export interface HealthCheckPayload {
  status: string
  timestamp: number
}

function getToken(): string {
  return String(loadAuthState()?.token || '').trim()
}

let pendingBackendAuthPromise: Promise<string> | null = null

async function ensureBackendToken(): Promise<string> {
  const currentToken = getToken()
  if (currentToken) return currentToken

  if (!pendingBackendAuthPromise) {
    pendingBackendAuthPromise = ensureAuthenticated()
      .then((result) => String(result.token || '').trim())
      .finally(() => {
        pendingBackendAuthPromise = null
      })
  }

  return pendingBackendAuthPromise
}

function normalizeBackendError(error: unknown): never {
  if (error instanceof BackendApiError && error.code === 40100) {
    clearAuthState()
  }
  throw error
}

function normalizeApiKeyValidationSnapshot(raw: unknown): ApiKeyValidationSnapshot | null {
  if (!raw || typeof raw !== 'object') return null

  const source = raw as {
    status?: unknown
    message?: unknown
    checkedAt?: unknown
  }
  const statusText = String(source.status || '').trim().toLowerCase()
  if (statusText !== 'success' && statusText !== 'error' && statusText !== 'unknown') {
    return null
  }

  return {
    status: statusText as ApiKeyValidationSnapshot['status'],
    message: String(source.message || '').trim(),
    checkedAt: Math.max(0, Number(source.checkedAt || Date.now())),
  }
}

async function requestWithAuth<TData>(
  options: {
    path: string
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    data?: unknown
    timeout?: number
  },
  allowRefresh = true,
): Promise<TData | null> {
  const token = await ensureBackendToken().catch(() => '')
  if (!token) return null

  try {
    return await apiRequest<TData>({
      ...options,
      token,
    })
  } catch (error) {
    const shouldRefresh = allowRefresh
      && error instanceof BackendApiError
      && error.code === 40100

    if (shouldRefresh) {
      const refreshed = await refreshAuthToken().catch(() => null)
      const nextToken = String(refreshed?.token || '').trim()
      if (nextToken) {
        try {
          return await apiRequest<TData>({
            ...options,
            token: nextToken,
          })
        } catch (retryError) {
          normalizeBackendError(retryError)
        }
      }
    }

    normalizeBackendError(error)
  }
}

export async function fetchBackendHealth(): Promise<HealthCheckPayload | null> {
  return apiRequest<HealthCheckPayload>({
    path: '/health',
  }).catch((error) => {
    if (isPlannedEndpointError(error)) return null
    throw error
  })
}

export async function syncLlmConfigToBackend(payload: {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  managedKeys: ManagedKeysPayload
}): Promise<void> {
  await requestWithAuth({
    path: '/llm/config',
    method: 'PUT',
    data: payload,
  })
}

export async function fetchLlmConfigFromBackend(): Promise<{
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  managedKeys?: ManagedKeysPayload
} | null> {
  return requestWithAuth({
    path: '/llm/config',
  })
}

export async function verifyLlmConfigInBackend(
  provider: LlmProvider,
  apiKey: string,
): Promise<ApiKeyValidationSnapshot | null> {
  try {
    const data = await requestWithAuth<{
      status?: unknown
      message?: unknown
      checkedAt?: unknown
    }>({
      path: '/llm/config/verify',
      method: 'POST',
      data: {
        provider,
        apiKey,
      },
    })

    return normalizeApiKeyValidationSnapshot(data)
  } catch (error) {
    if (error instanceof BackendApiError) {
      const snapshot = normalizeApiKeyValidationSnapshot(error.data)
      if (snapshot) return snapshot
    }
    throw error
  }
}

export async function fetchLlmProvidersFromBackend(): Promise<Array<{ value: LlmProvider; label: string }> | null> {
  const data = await requestWithAuth<{
    providers?: Array<{ value?: unknown; label?: unknown }>
  }>({
    path: '/llm/providers',
  })

  if (!data || !Array.isArray(data.providers)) return null
  return data.providers
    .map((item) => {
      const value = String(item?.value || '').trim().toLowerCase()
      if (value !== 'qwen' && value !== 'deepseek' && value !== 'openai' && value !== 'gemini') {
        return null
      }

      return {
        value: value as LlmProvider,
        label: String(item?.label || '').trim() || value,
      }
    })
    .filter((item): item is { value: LlmProvider; label: string } => !!item)
}

export async function syncUserTagsToBackend(tags: string[]): Promise<void> {
  await requestWithAuth({
    path: '/tags',
    method: 'PUT',
    data: { tags },
  })
}

export async function fetchUserTagsFromBackend(): Promise<string[] | null> {
  const data = await requestWithAuth<{ tags?: unknown[] }>({
    path: '/tags',
  })
  if (!data || !Array.isArray(data.tags)) return null
  return data.tags.map((item) => String(item || '').trim()).filter(Boolean)
}

export async function generateTagsInBackend(goal: string): Promise<string[] | null> {
  const data = await requestWithAuth<{ tags?: unknown[] }>({
    path: '/tags/generate',
    method: 'POST',
    data: { goal },
  })
  if (!data || !Array.isArray(data.tags)) return null
  return data.tags.map((item) => String(item || '').trim()).filter(Boolean)
}

export async function retagHistoricalQuestionsInBackend(
  tags: string[],
  force = true,
): Promise<RetagSummary | null> {
  return requestWithAuth({
    path: '/tags/retag-historical',
    method: 'POST',
    data: { tags, force },
  })
}

export async function syncQuestionBankToBackend(questions: StoredQuestion[]): Promise<void> {
  await requestWithAuth({
    path: '/question-bank/full',
    method: 'PUT',
    data: { questions },
  })
}

export async function fetchQuestionBankFromBackend(): Promise<StoredQuestion[] | null> {
  const data = await requestWithAuth<{ questions?: unknown[] }>({
    path: '/question-bank/full',
  })
  if (!data || !Array.isArray(data.questions)) return null
  return data.questions as StoredQuestion[]
}

export async function queryQuestionBankFromBackend(params: {
  mainTab?: 'all' | 'wrong' | 'mastered'
  tag?: string
  page?: number
  pageSize?: number
}): Promise<{
  list: StoredQuestion[]
  total: number
  tagStats: Array<{ tag: string; count: number }>
} | null> {
  const search = new URLSearchParams()
  if (params.mainTab) search.set('mainTab', params.mainTab)
  if (params.tag) search.set('tag', params.tag)
  if (params.page) search.set('page', String(params.page))
  if (params.pageSize) search.set('pageSize', String(params.pageSize))

  const suffix = search.toString()
  return requestWithAuth({
    path: `/question-bank${suffix ? `?${suffix}` : ''}`,
  })
}

export async function deleteQuestionBankItemsInBackend(ids: string[]): Promise<number | null> {
  const data = await requestWithAuth<{ deletedCount?: unknown }>({
    path: '/question-bank',
    method: 'DELETE',
    data: { ids },
  })
  if (!data) return null
  return Math.max(0, Number(data.deletedCount || 0))
}

export async function submitQuestionAttemptInBackend(payload: {
  questionId: string
  userChoice: string
  feedbackMode: 'instant' | 'after_all'
}): Promise<AttemptResult | null> {
  return requestWithAuth({
    path: `/question-bank/${encodeURIComponent(payload.questionId)}/attempt`,
    method: 'POST',
    data: {
      userChoice: payload.userChoice,
      feedbackMode: payload.feedbackMode,
    },
  })
}

export async function updateQuestionMasteredInBackend(
  questionId: string,
  isMastered: boolean,
): Promise<boolean | null> {
  const data = await requestWithAuth<{ updated?: unknown }>({
    path: `/question-bank/${encodeURIComponent(questionId)}/mastered`,
    method: 'PATCH',
    data: { isMastered },
  })
  if (!data) return null
  return Boolean(data.updated)
}

export async function updateQuestionTagsInBackend(tagById: Record<string, string>): Promise<number | null> {
  const data = await requestWithAuth<{ updatedCount?: unknown }>({
    path: '/question-bank/tags',
    method: 'PATCH',
    data: { tagById },
  })
  if (!data) return null
  return Math.max(0, Number(data.updatedCount || 0))
}

export async function syncPracticeSessionToBackend(session: PracticeSession): Promise<void> {
  await requestWithAuth({
    path: '/practice-session/current',
    method: 'PUT',
    data: { session },
  })
}

export async function fetchPracticeSessionFromBackend(): Promise<PracticeSession | null> {
  const data = await requestWithAuth<{ session?: unknown }>({
    path: '/practice-session/current',
  })
  if (!data || !data.session || typeof data.session !== 'object') return null
  return data.session as PracticeSession
}

export async function clearPracticeSessionInBackend(): Promise<void> {
  await requestWithAuth({
    path: '/practice-session/current',
    method: 'DELETE',
  })
}

export async function createQuestionsGenerationJobInBackend(payload: {
  material: string
  type: 'single' | 'multi'
  difficulty: 'easy' | 'medium' | 'hard'
  mode: 'modeA' | 'modeB'
  feedbackMode: 'instant' | 'after_all'
  targetCount: number
  initialBatchCount: number
  userTags: string[]
  requestNonce: number
  imageDataUrl?: string
  imageName?: string
  imageMimeType?: string
}): Promise<GenerationJobPayload | null> {
  return requestWithAuth({
    path: '/questions/generate',
    method: 'POST',
    data: payload,
    timeout: 600000,
  })
}

export async function cancelQuestionsGenerationRequestInBackend(payload: {
  material: string
  type: 'single' | 'multi'
  difficulty: 'easy' | 'medium' | 'hard'
  mode: 'modeA' | 'modeB'
  feedbackMode: 'instant' | 'after_all'
  targetCount: number
  initialBatchCount: number
  userTags: string[]
  requestNonce: number
  imageDataUrl?: string
  imageName?: string
  imageMimeType?: string
}): Promise<boolean | null> {
  const data = await requestWithAuth<{ cancelled?: unknown }>({
    path: '/questions/generate/cancel',
    method: 'POST',
    data: payload,
  })
  if (!data) return null
  return Boolean(data.cancelled)
}

export async function fetchGenerationJobFromBackend(jobId: string): Promise<GenerationJob | null> {
  const data = await requestWithAuth<{ generationJob?: unknown }>({
    path: `/generation-jobs/${encodeURIComponent(jobId)}`,
  })
  if (!data || !data.generationJob || typeof data.generationJob !== 'object') return null
  return data.generationJob as GenerationJob
}

export async function fetchActiveGenerationJobFromBackend(): Promise<ActiveGenerationJobPayload | null> {
  try {
    const data = await requestWithAuth<{
      session?: unknown
      generationJob?: unknown
      job?: unknown
      activeJob?: unknown
    }>({
      path: '/generation-jobs/active',
    })
    if (!data || typeof data !== 'object') return null

    const generationJobCandidate = data.generationJob ?? data.job ?? data.activeJob
    const generationJob = generationJobCandidate && typeof generationJobCandidate === 'object'
      ? (generationJobCandidate as GenerationJob)
      : null
    const session = data.session && typeof data.session === 'object'
      ? (data.session as PracticeSession)
      : null

    if (!generationJob && !session) return null
    return {
      session,
      generationJob,
    }
  } catch (error) {
    if (isPlannedEndpointError(error)) return null
    throw error
  }
}

export async function triggerGenerationBatchInBackend(
  jobId: string,
  batchIndex: 2 | 3,
): Promise<GenerationBatchPayload | null> {
  return requestWithAuth({
    path: `/generation-jobs/${encodeURIComponent(jobId)}/batches/${batchIndex}`,
    method: 'POST',
    timeout: 600000,
  })
}

export async function cancelGenerationJobInBackend(jobId: string): Promise<boolean | null> {
  const data = await requestWithAuth<{ cancelled?: unknown }>({
    path: `/generation-jobs/${encodeURIComponent(jobId)}/cancel`,
    method: 'POST',
  })
  if (!data) return null
  return Boolean(data.cancelled)
}

export function isPlannedEndpointError(error: unknown): boolean {
  if (!(error instanceof BackendApiError)) return false
  return error.statusCode === 404 || error.code === 40400 || error.code === 40001
}
