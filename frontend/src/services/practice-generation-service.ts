import {
  clearGenerationJob,
  replaceGenerationJob,
} from '../utils/generation-job'
import {
  type PracticeMode,
  upsertStoredQuestions,
} from '../utils/question-bank'
import {
  replaceActivePracticeSession,
  type PracticeFeedbackMode,
} from '../utils/practice-session'
import { abortAllLlmRequests } from '../utils/llm'
import {
  cancelQuestionsGenerationRequestInBackend,
  createQuestionsGenerationJobInBackend,
} from '../utils/backend-sync'
import { BackendApiError } from '../utils/backend-api'

export interface StartPracticeGenerationInput {
  material: string
  type: 'single' | 'multi'
  difficulty: 'easy' | 'medium' | 'hard'
  mode: PracticeMode
  feedbackMode: PracticeFeedbackMode
  targetCount: number
  initialBatchCount: number
  userTags: string[]
  requestNonce: number
  timeoutMs: number
  imageDataUrl?: string
  imageName?: string
  imageMimeType?: string
}

export interface StartPracticeGenerationSuccess {
  savedCount: number
  sessionId: string
}

export type StartPracticeGenerationResult =
  | {
      success: true
      output: StartPracticeGenerationSuccess
    }
  | {
      success: false
      error: string
    }

const GENERATE_FAIL_MESSAGE = '生成失败，请稍后重试'
const GENERATE_TIMEOUT_MESSAGE = '生成超时，请检查网络或 API 配置后重试'
const GENERATE_INVALID_SESSION_MESSAGE = '生成结果缺少有效练习会话，请重试'

function isDevRuntime(): boolean {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env
    return Boolean(env?.DEV)
  } catch {
    return false
  }
}



function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      abortAllLlmRequests()
      onTimeout?.()
      reject(new Error(timeoutMessage))
    }, timeoutMs)

    promise
      .then((result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      })
      .catch((error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
  })
}

function shouldKeepGenerationJobAfterInitial(input: {
  targetCount: number
  loadedCount: number
  status?: string
}): boolean {
  const targetCount = Math.max(1, Math.floor(Number(input.targetCount || 1)))
  const loadedCount = Math.max(0, Math.floor(Number(input.loadedCount || 0)))
  const status = String(input.status || '').trim()
  if (status === 'completed' || status === 'canceled') return false
  return loadedCount < targetCount
}

export async function startPracticeGeneration(
  input: StartPracticeGenerationInput,
): Promise<StartPracticeGenerationResult> {
  clearGenerationJob()
  try {
    const backendPayload = {
      material: input.material,
      type: input.type,
      difficulty: input.difficulty,
      mode: input.mode,
      feedbackMode: input.feedbackMode,
      targetCount: input.targetCount,
      initialBatchCount: input.initialBatchCount,
      userTags: input.userTags,
      requestNonce: input.requestNonce,
      ...(input.imageDataUrl
        ? {
            imageDataUrl: input.imageDataUrl,
            imageName: input.imageName || '',
            imageMimeType: input.imageMimeType || '',
          }
        : {}),
    }
    const backendResult = await withTimeout(
      createQuestionsGenerationJobInBackend(backendPayload),
      input.timeoutMs,
      GENERATE_TIMEOUT_MESSAGE,
      () => {
        void cancelQuestionsGenerationRequestInBackend(backendPayload).catch(() => {
          // ignore backend cancel failure
        })
      },
    )

    if (!backendResult) {
      return {
        success: false,
        error: '后端返回空结果',
      }
    }

    const saved = upsertStoredQuestions(backendResult.session.questions, { syncBackend: false })
    const session = replaceActivePracticeSession(backendResult.session)
    const shouldKeepJob = shouldKeepGenerationJobAfterInitial({
      targetCount: input.targetCount,
      loadedCount: Math.max(
        Number(backendResult.generationJob?.loadedCount || 0),
        backendResult.session.questions.length,
      ),
      status: backendResult.generationJob?.status,
    })

    if (shouldKeepJob) {
      replaceGenerationJob(backendResult.generationJob)
    } else {
      clearGenerationJob()
    }

    if (!session) {
      throw new Error(GENERATE_INVALID_SESSION_MESSAGE)
    }

    return {
      success: true,
      output: {
        savedCount: Math.max(saved.length, Number(backendResult.savedCount || 0)),
        sessionId: session.id,
      },
    }
  } catch (error) {
    // 提取后端错误消息
    let message = ''
    if (error instanceof BackendApiError) {
      message = error.message
    } else if (error instanceof Error) {
      message = error.message
    } else {
      message = GENERATE_FAIL_MESSAGE
    }

    // 开发环境下记录日志
    if (isDevRuntime()) {
      console.error('Generate failed:', error)
    }

    return {
      success: false,
      error: message.trim() || GENERATE_FAIL_MESSAGE,
    }
  }
}

export function cancelPracticeGeneration(input: StartPracticeGenerationInput): void {
  const backendPayload = {
    material: input.material,
    type: input.type,
    difficulty: input.difficulty,
    mode: input.mode,
    feedbackMode: input.feedbackMode,
    targetCount: input.targetCount,
    initialBatchCount: input.initialBatchCount,
    userTags: input.userTags,
    requestNonce: input.requestNonce,
    ...(input.imageDataUrl
      ? {
          imageDataUrl: input.imageDataUrl,
          imageName: input.imageName || '',
          imageMimeType: input.imageMimeType || '',
        }
      : {}),
  }
  void cancelQuestionsGenerationRequestInBackend(backendPayload).catch(() => {
    // ignore backend cancel failure
  })
}
