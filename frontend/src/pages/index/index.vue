<template>
  <view class="page-root">
    <view class="page-header-fixed" :style="pageHeaderStyle">
      <view class="title-wrap">
        <view class="title-head">
          <image
            class="page-logo"
            :src="logoSrc"
            mode="aspectFit"
            @error="onLogoImageError"
          />
        </view>
        <text class="page-subtitle">AI 负责出题，牛马负责变强，我爱刷题！！！</text>
      </view>
    </view>

    <view class="page-scroll" :style="pageScrollStyle">
      <view class="page-body">
        <view class="main-container">
          <view class="panel oa-card-surface material-panel">
            <view class="material-input-wrap">
              <transition name="mascot-watermark-fade">
                <image
                  v-if="!material.length"
                  class="material-watermark"
                  :src="mascotSrc"
                  mode="aspectFit"
                  @error="onMascotImageError"
                />
              </transition>
              <textarea
                v-model="material"
                class="material-input"
                :focus="materialInputFocus"
                maxlength="-1"
                placeholder="直接粘贴你的学习材料，或输入你想学习的内容，我会帮助你生成题目~"
                placeholder-style="color:#70757A;text-align:center;"
              />
              <view class="material-tool-row">
                <view
                  class="material-tool-btn"
                  :class="{ 'is-disabled': isMaterialToolDisabled }"
                  @click.stop="chooseMaterialImageFromAlbum"
                >
                  <text class="material-tool-plus">+</text>
                </view>
                <view
                  class="material-tool-btn"
                  :class="{ 'is-disabled': isMaterialToolDisabled }"
                  @click.stop="captureMaterialImage"
                >
                  <image
                    class="material-tool-icon"
                    :src="materialCameraIconSvg"
                    mode="aspectFit"
                  />
                </view>
                <view
                  v-if="material.length > 0"
                  class="material-clear-btn"
                  :class="{ 'is-disabled': isMaterialToolDisabled }"
                  @click.stop="clearMaterialInput"
                >
                  <image
                    class="material-clear-icon"
                    :src="materialClearIconSvg"
                    mode="aspectFit"
                  />
                </view>
              </view>
            </view>
          </view>

          <view class="panel oa-card-surface setting-panel">
            <text class="section-title">出题设置</text>

            <view class="setting-item">
              <view class="grid-row row-2">
                <view
                  v-for="item in modeOptions"
                  :key="item.value"
                  class="option-cell"
                  :class="[
                    mode === item.value ? 'is-active' : '',
                    isModeOptionDisabled(item.value) ? 'is-disabled' : '',
                  ]"
                  @click="selectModeOption(item.value)"
                >
                  {{ item.label }}
                </view>
              </view>
              <text class="mode-hint">{{ modeHintText }}</text>
            </view>

            <view class="setting-item">
              <view class="grid-row row-2 feedback-row">
                <view
                  v-for="item in feedbackOptions"
                  :key="item.value"
                  class="option-cell"
                  :class="feedbackMode === item.value ? 'is-active' : ''"
                  @click="feedbackMode = item.value"
                >
                  {{ item.label }}
                </view>
              </view>
              <text class="mode-hint">{{ feedbackHintText }}</text>
            </view>

            <view class="setting-item">
              <view class="grid-row row-2">
                <view
                  v-for="item in typeOptions"
                  :key="item.value"
                  class="option-cell"
                  :class="questionType === item.value ? 'is-active' : ''"
                  @click="questionType = item.value"
                >
                  {{ item.label }}
                </view>
              </view>
            </view>

            <view class="setting-item">
              <view class="grid-row row-3">
                <view
                  v-for="item in difficultyOptions"
                  :key="item.value"
                  class="option-cell"
                  :class="difficulty === item.value ? 'is-active' : ''"
                  @click="difficulty = item.value"
                >
                  {{ item.label }}
                </view>
              </view>
            </view>

            <view class="setting-item setting-item-count">
              <view class="grid-row row-4">
                <view
                  v-for="count in presetCounts"
                  :key="count"
                  class="option-cell"
                  :class="selectedPresetCount === count && countMode === 'preset' ? 'is-active' : ''"
                  @click="selectPresetCount(count)"
                >
                  {{ count }}题
                </view>

                <view
                  class="option-cell custom-count-cell"
                  :class="countMode === 'custom' ? 'is-active' : ''"
                  @click="openCustomCountDialog"
                >
                  <text class="custom-count-text">{{ customCountDisplay }}</text>
                </view>
              </view>
            </view>

            <view class="generate-btn-wrap">
              <button
                class="generate-btn"
                :class="generateBreathActive ? 'is-breathing' : ''"
                hover-class="generate-btn-hover"
                :loading="isLoading"
                :disabled="isLoading"
                @click="onGenerate"
              >
                一键生成
              </button>
              <view v-if="!isLoading && !isApiKeyReady" class="generate-btn-blocker" @click="handleGenerateBlocked" />
            </view>
            <view
              v-if="showApiGuide"
              class="api-guide-row"
              :class="[apiGuideIsError ? 'is-error' : '', apiGuideShakeActive ? 'is-shaking' : '']"
              @click="handleGoToApiConfig"
            >
              <text class="api-guide-text">
                请先填写API Key，
                <text class="api-guide-link">点击前往【我的】</text>
                页配置
                ~
              </text>
            </view>
            <view
              v-if="error"
              class="error-text"
              :class="{ 'is-center': shouldCenterError }"
            >
              {{ error }}
            </view>
          </view>

          <view v-if="lastGeneratedCount > 0" class="panel oa-card-surface latest-panel">
            最近一次已生成 {{ lastGeneratedCount }} 题，已自动进入做题页面
          </view>
        </view>
      </view>
    </view>

    <view v-if="showCustomCountDialog" class="count-dialog-mask oa-modal-mask" @click="closeCustomCountDialog">
      <view class="count-dialog oa-modal-panel" @click.stop>
        <text class="count-dialog-title">自定义题量</text>
        <input
          v-model="customCountDraft"
          class="count-dialog-input"
          type="number"
          maxlength="2"
          focus
          placeholder="请输入 1-50"
          placeholder-style="color:#CCCCCC;"
        />
        <view class="count-dialog-actions">
          <view class="count-dialog-btn is-clear" @click="clearCustomCount">清空</view>
          <view class="count-dialog-action-right">
            <view class="count-dialog-btn is-cancel" @click="closeCustomCountDialog">取消</view>
            <view class="count-dialog-btn is-primary" @click="confirmCustomCount">确定</view>
          </view>
        </view>
      </view>
    </view>

    <WorkMaskOverlay v-if="isLoading" @cancel="cancelGenerate" />

    <InsTabBar active="practice" />
  </view>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { onHide, onLoad, onShow, onUnload } from '@dcloudio/uni-app'
import InsTabBar from '../../components/InsTabBar.vue'
import WorkMaskOverlay from '../../components/WorkMaskOverlay.vue'
import { abortAllLlmRequests, hydrateLlmConfigFromBackend, loadLlmConfig } from '../../utils/llm'
import {
  cancelPracticeGeneration,
  startPracticeGeneration,
  type StartPracticeGenerationInput,
} from '../../services/practice-generation-service'
import { type PracticeMode } from '../../utils/question-bank'
import { type PracticeFeedbackMode } from '../../utils/practice-session'
import { hydrateUserTagsFromBackend, loadUserTags } from '../../utils/user-tags'

const modeOptions = [
  { label: '原文提取', value: 'modeA' },
  { label: '知识拓展', value: 'modeB' },
] as const

const typeOptions = [
  { label: '单选题', value: 'single' },
  { label: '多选题', value: 'multi' },
] as const

const feedbackOptions = [
  { label: '即时反馈', value: 'instant' },
  { label: '全做再看', value: 'after_all' },
] as const

const difficultyOptions = [
  { label: '简单', value: 'easy' },
  { label: '中等', value: 'medium' },
  { label: '困难', value: 'hard' },
] as const

const presetCounts = [5, 10, 15]
const FOCUS_MATERIAL_ONCE_KEY = 'study_quiz_focus_material_once'
const API_KEY_SYNC_EVENT = 'study_api_key_changed'
const MATERIAL_DRAFT_STORAGE_KEY = 'study_quiz_material_draft_v1'

type AppGuideGlobalData = {
  isFromApiGuide?: boolean
  tempInputContent?: string
}

const material = ref('')
const mode = ref<PracticeMode>('modeA')
const questionType = ref<'single' | 'multi'>('single')
const feedbackMode = ref<PracticeFeedbackMode>('instant')
const difficulty = ref<'easy' | 'medium' | 'hard'>('medium')
const countMode = ref<'preset' | 'custom'>('preset')
const selectedPresetCount = ref(10)
const customCount = ref<number | null>(null)
const showCustomCountDialog = ref(false)
const customCountDraft = ref('')
const logoCandidates: string[] = [
  '/static/niuma-logo-transparent-lite.webp',
  '/static/niuma-logo-transparent-lite.png',
]
const logoCandidateIndex = ref(0)
const logoSrc = ref(logoCandidates[0])
const mascotCandidates: string[] = [
  '/static/niuma13-2-lite.webp',
  '/static/niuma13-2-lite.png',
]
const mascotCandidateIndex = ref(0)
const mascotSrc = ref(mascotCandidates[0])
const materialClearIconSvg = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="%23CCCCCC" stroke-width="1.5"/><path d="M8.5 8.5L15.5 15.5M15.5 8.5L8.5 15.5" stroke="%23CCCCCC" stroke-width="1.5" stroke-linecap="round"/></svg>'
const materialCameraIconSvg = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M8.5 6.5L9.8 4.8C10.1 4.3 10.6 4 11.2 4H12.8C13.4 4 13.9 4.3 14.2 4.8L15.5 6.5H18C19.1 6.5 20 7.4 20 8.5V17.2C20 18.3 19.1 19.2 18 19.2H6C4.9 19.2 4 18.3 4 17.2V8.5C4 7.4 4.9 6.5 6 6.5H8.5Z" stroke="%2300B368" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.2" stroke="%2300B368" stroke-width="1.6"/><path d="M17 9.3H17.01" stroke="%2300B368" stroke-width="2" stroke-linecap="round"/></svg>'

type MaterialImageSource = 'album' | 'camera'

interface SelectedMaterialImage {
  path: string
  name: string
  size: number
  mimeType: string
  file?: unknown
}

interface RunPracticeGenerationOptions {
  materialText: string
  skipMaterialValidation?: boolean
  modeOverride?: PracticeMode
  imageDataUrl?: string
  imageName?: string
  imageMimeType?: string
}

const isLoading = ref(false)
const isImagePreparing = ref(false)
const error = ref('')
const lastGeneratedCount = ref(0)
const safeTopPx = ref(resolveTitleSafeTopPadding())
const screenWidthPx = ref(resolveScreenWidthPx())
const materialInputFocus = ref(false)
const showApiGuide = ref(false)
const isApiKeyReady = ref(false)
const apiGuideIsError = ref(false)
const apiGuideShakeActive = ref(false)
const generateBreathActive = ref(false)
const generateRequestNonce = ref(0)
const generateCanceled = ref(false)
const activeGenerationInput = ref<StartPracticeGenerationInput | null>(null)
const pageHeaderHeightPx = ref(resolvePageHeaderFallbackHeight(safeTopPx.value, screenWidthPx.value))
const pageHeaderStyle = computed(() => ({ paddingTop: `${safeTopPx.value}px` }))
const pageScrollStyle = computed(() => ({ paddingTop: `${Math.round(pageHeaderHeightPx.value)}px` }))
const isMaterialToolDisabled = computed(() => isLoading.value || isImagePreparing.value)
const trimmedMaterialLength = computed(() => material.value.trim().length)
const shouldLockToSourceExtraction = computed(() =>
  trimmedMaterialLength.value > 0 && trimmedMaterialLength.value <= 50,
)
const customCountDisplay = computed(() => (customCount.value === null ? '自定义' : String(customCount.value)))
const modeHintText = computed(() =>
  shouldLockToSourceExtraction.value
    ? '50字以内内容仅支持原文提取'
    : mode.value === 'modeA'
      ? '提取材料中的重要知识点后出题'
      : '提取知识点并适度拓展后出题',
)
const feedbackHintText = computed(() =>
  feedbackMode.value === 'instant' ? '答一题出一解析' : '完卷后统一查看',
)
const isMounted = ref(true)
let stopWatchMaterial: () => void
let stopWatchMaterialMode: () => void
const ERROR_INVALID_API_KEY = '请先填写正确的 API Key'
const ERROR_EMPTY_MATERIAL = '请先输入学习材料'
const ERROR_MODE_B_NEED_LONG_MATERIAL = '50字以内内容请使用【原文提取】'
const ERROR_GENERATE_TIMEOUT = '生成超时，请检查网络或 API 配置后重试'
const ERROR_IMAGE_INVALID = '请选择 JPG、PNG、WEBP 或 GIF 图片'
const ERROR_IMAGE_TOO_LARGE = '图片不能超过 8MB，请压缩后再上传'
const MAX_MATERIAL_IMAGE_BYTES = 8 * 1024 * 1024
const MATERIAL_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const PIPELINE_TIMEOUT_MIN_MS = 300000
const PIPELINE_TIMEOUT_MAX_MS = 600000
const PIPELINE_TIMEOUT_BASE_MS = 300000
const PIPELINE_TIMEOUT_PER_QUESTION_MS = 6000
const PIPELINE_TIMEOUT_MODE_B_EXTRA_MS = 30000
const MATERIAL_DRAFT_STORAGE_MAX_CHARS = 1200
const MATERIAL_DRAFT_STORAGE_DEBOUNCE_MS = 360
const HEADER_BASE_EXTRA_TOP_RPX = 32
const HEADER_TOP_COMPACT_RPX = 32
const HEADER_FIXED_CONTENT_RPX = 168
const materialErrorSet = new Set<string>([
  ERROR_EMPTY_MATERIAL,
  ERROR_MODE_B_NEED_LONG_MATERIAL,
])
const shouldCenterError = computed(() => {
  const message = String(error.value || '').trim()
  return message === ERROR_EMPTY_MATERIAL || message === ERROR_GENERATE_TIMEOUT || message.includes('生成超时')
})
let apiGuideResetTimer: ReturnType<typeof setTimeout> | null = null
let apiGuideShakeTimer: ReturnType<typeof setTimeout> | null = null
let generateBreathTimer: ReturnType<typeof setTimeout> | null = null
let materialDraftSyncTimer: ReturnType<typeof setTimeout> | null = null
let materialDraftStorageShadow = ''

const MIN_CUSTOM_COUNT = 1
const MAX_CUSTOM_COUNT = 50

function isBrowserTabBackgroundHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  } catch {
    return false
  }
}

onShow(() => {
  safeTopPx.value = resolveTitleSafeTopPadding()
  screenWidthPx.value = resolveScreenWidthPx()
  syncPageHeaderHeight()
  restoreMaterialDraft()
  hydrateUserTagsFromBackend()
  syncApiGuideVisibility()
  void hydrateApiConfigFromBackend()
  startGenerateBreathPulse()
  const shouldFocus = Number(uni.getStorageSync(FOCUS_MATERIAL_ONCE_KEY) || 0) === 1
  if (shouldFocus) {
    uni.removeStorageSync(FOCUS_MATERIAL_ONCE_KEY)
    materialInputFocus.value = true
    return
  }
  materialInputFocus.value = false
})

async function hydrateApiConfigFromBackend(): Promise<void> {
  try {
    await hydrateLlmConfigFromBackend()
  } catch {
    // ignore backend hydration failures and keep local fallback
  }
  syncApiGuideVisibility()
}

onLoad(() => {
  safeTopPx.value = resolveTitleSafeTopPadding()
  screenWidthPx.value = resolveScreenWidthPx()
  syncPageHeaderHeight()
  restoreMaterialDraft()
  void hydrateApiConfigFromBackend()
  uni.$on(API_KEY_SYNC_EVENT, syncApiGuideVisibility)
})

onHide(() => {
  // H5 浏览器标签切后台时不主动取消，允许生成任务继续进行。
  // 仅在真正离开当前页面（非 document.hidden）时终止本页生成态。
  if (!isBrowserTabBackgroundHidden()) {
    generateRequestNonce.value += 1
    generateCanceled.value = true
    isLoading.value = false
    if (activeGenerationInput.value) {
      cancelPracticeGeneration(activeGenerationInput.value)
      activeGenerationInput.value = null
    }
  }
  flushMaterialDraftSync()
  clearGenerateBreathPulse()
  clearApiGuideTimers()
})

onUnload(() => {
  isMounted.value = false
  // 页面真实销毁时终止本页请求回流，避免卸载后状态更新。
  generateRequestNonce.value += 1
  generateCanceled.value = true
  isLoading.value = false
  if (activeGenerationInput.value) {
    cancelPracticeGeneration(activeGenerationInput.value)
    activeGenerationInput.value = null
  }
  flushMaterialDraftSync()
  clearGenerateBreathPulse()
  clearApiGuideTimers()
  uni.$off(API_KEY_SYNC_EVENT, syncApiGuideVisibility)
})

function clearGenerateBreathPulse() {
  if (generateBreathTimer) {
    clearTimeout(generateBreathTimer)
    generateBreathTimer = null
  }
  generateBreathActive.value = false
}

async function startGenerateBreathPulse() {
  clearGenerateBreathPulse()
  await nextTick()
  generateBreathActive.value = true
  generateBreathTimer = setTimeout(() => {
    generateBreathTimer = null
    generateBreathActive.value = false
  }, 3000)
}

function resolveTitleSafeTopPadding(): number {
  try {
    const system = uni.getSystemInfoSync ? uni.getSystemInfoSync() : null
    const statusBarHeight = Math.max(0, Number(system?.statusBarHeight || 0))
    const screenWidth = Number(system?.screenWidth || 375)
    const extraTopRpx = Math.max(0, HEADER_BASE_EXTRA_TOP_RPX - HEADER_TOP_COMPACT_RPX)
    const extraPx = (extraTopRpx * screenWidth) / 750
    return Math.round(statusBarHeight + extraPx)
  } catch {
    return 44
  }
}

function resolveScreenWidthPx(): number {
  try {
    const system = uni.getSystemInfoSync ? uni.getSystemInfoSync() : null
    const screenWidth = Number(system?.screenWidth || 375)
    if (Number.isFinite(screenWidth) && screenWidth > 0) {
      return screenWidth
    }
  } catch {
    // ignore and fallback
  }
  return 375
}

function resolvePageHeaderFallbackHeight(topPx: number, widthPx: number): number {
  return Math.round(topPx + (HEADER_FIXED_CONTENT_RPX * widthPx) / 750)
}

function syncPageHeaderHeight() {
  const fallbackHeight = resolvePageHeaderFallbackHeight(safeTopPx.value, screenWidthPx.value)
  nextTick(() => {
    if (!isMounted.value) return
    const query = uni.createSelectorQuery()
    query.select('.page-header-fixed').boundingClientRect((rect) => {
      if (!isMounted.value) return
      const node = Array.isArray(rect) ? rect[0] : rect
      const measuredHeight = Math.round(Number(node?.height || 0))
      pageHeaderHeightPx.value = measuredHeight > 0 ? measuredHeight : fallbackHeight
    })
    query.exec()
  })
}

function hasApiKeyConfigured(): boolean {
  const config = loadLlmConfig()
  const key = String(config.apiKey || '').trim()
  return key.length > 0
}

function syncApiGuideVisibility() {
  isApiKeyReady.value = hasApiKeyConfigured()
  showApiGuide.value = !isApiKeyReady.value
  if (!showApiGuide.value) {
    clearApiGuideTimers()
    apiGuideIsError.value = false
    apiGuideShakeActive.value = false
  }
}

function clearApiGuideTimers() {
  if (apiGuideResetTimer) {
    clearTimeout(apiGuideResetTimer)
    apiGuideResetTimer = null
  }
  if (apiGuideShakeTimer) {
    clearTimeout(apiGuideShakeTimer)
    apiGuideShakeTimer = null
  }
}

async function triggerApiGuideErrorState() {
  if (!showApiGuide.value) return

  clearApiGuideTimers()
  apiGuideIsError.value = true
  apiGuideShakeActive.value = false
  await nextTick()
  apiGuideShakeActive.value = true

  apiGuideShakeTimer = setTimeout(() => {
    apiGuideShakeTimer = null
    apiGuideShakeActive.value = false
  }, 320)

  apiGuideResetTimer = setTimeout(() => {
    apiGuideResetTimer = null
    apiGuideIsError.value = false
    apiGuideShakeActive.value = false
  }, 5000)
}

function getGuideGlobalData(): AppGuideGlobalData {
  const app = getApp<{ globalData?: AppGuideGlobalData }>()
  if (!app.globalData) {
    app.globalData = {}
  }
  return app.globalData
}

function normalizeMaterialDraftForStorage(value: string): string {
  return String(value || '').slice(0, MATERIAL_DRAFT_STORAGE_MAX_CHARS)
}

function clearMaterialDraftSyncTimer() {
  if (!materialDraftSyncTimer) return
  clearTimeout(materialDraftSyncTimer)
  materialDraftSyncTimer = null
}

function writeMaterialDraftToStorage(value: string): void {
  const next = normalizeMaterialDraftForStorage(value)
  if (next === materialDraftStorageShadow) return
  materialDraftStorageShadow = next
  try {
    if (next) {
      uni.setStorageSync(MATERIAL_DRAFT_STORAGE_KEY, next)
      return
    }
    uni.removeStorageSync(MATERIAL_DRAFT_STORAGE_KEY)
  } catch {
    // ignore sync failure
  }
}

function flushMaterialDraftSync(): void {
  clearMaterialDraftSyncTimer()
  writeMaterialDraftToStorage(material.value)
}

function clearMaterialDraftPersistence(): void {
  clearMaterialDraftSyncTimer()
  materialDraftStorageShadow = ''
  try {
    uni.removeStorageSync(MATERIAL_DRAFT_STORAGE_KEY)
  } catch {
    // ignore sync failure
  }
}

function syncMaterialDraft(value: string): void {
  const next = String(value || '')
  const normalizedNext = normalizeMaterialDraftForStorage(next)
  const globalData = getGuideGlobalData()
  globalData.tempInputContent = normalizedNext

  clearMaterialDraftSyncTimer()
  materialDraftSyncTimer = setTimeout(() => {
    materialDraftSyncTimer = null
    writeMaterialDraftToStorage(normalizedNext)
  }, MATERIAL_DRAFT_STORAGE_DEBOUNCE_MS)
}

function restoreMaterialDraft(): void {
  const globalData = getGuideGlobalData()
  const fromGlobal = typeof globalData.tempInputContent === 'string' ? globalData.tempInputContent : ''

  let next = fromGlobal
  if (!next) {
    try {
      const fromStorage = uni.getStorageSync(MATERIAL_DRAFT_STORAGE_KEY)
      if (typeof fromStorage === 'string') {
        next = fromStorage
      }
    } catch {
      next = ''
    }
  }

  if (typeof next !== 'string') return
  materialDraftStorageShadow = normalizeMaterialDraftForStorage(next)
  if (material.value !== next) {
    material.value = next
  }
  if (globalData.tempInputContent !== next) {
    globalData.tempInputContent = next
  }
}

function handleGoToApiConfig() {
  const globalData = getGuideGlobalData()
  globalData.isFromApiGuide = true

  const wxApi = (globalThis as {
    wx?: {
      switchTab?: (options: {
        url: string
        fail?: () => void
      }) => void
    }
  }).wx

  const fallback = () => {
    uni.reLaunch({ url: '/pages/profile/index' })
  }

  if (wxApi?.switchTab) {
    wxApi.switchTab({
      url: '/pages/profile/index',
      fail: fallback,
    })
    return
  }

  uni.switchTab({
    url: '/pages/profile/index',
    fail: fallback,
  })
}

function handleGenerateBlocked() {
  if (isLoading.value) return
  void triggerApiGuideErrorState()
  uni.showToast({
    title: ERROR_INVALID_API_KEY,
    icon: 'none',
  })
}

function cancelGenerate() {
  if (!isLoading.value) return
  generateCanceled.value = true
  generateRequestNonce.value += 1
  isLoading.value = false
  if (activeGenerationInput.value) {
    cancelPracticeGeneration(activeGenerationInput.value)
    activeGenerationInput.value = null
  }
  abortAllLlmRequests()
}

function onLogoImageError() {
  if (logoCandidateIndex.value >= logoCandidates.length - 1) return
  logoCandidateIndex.value += 1
  logoSrc.value = logoCandidates[logoCandidateIndex.value]
}

function onMascotImageError() {
  if (mascotCandidateIndex.value >= mascotCandidates.length - 1) return
  mascotCandidateIndex.value += 1
  mascotSrc.value = mascotCandidates[mascotCandidateIndex.value]
}

function clearMaterialInput() {
  if (isMaterialToolDisabled.value) return
  material.value = ''
  error.value = ''
  syncMaterialDraft('')

  const wxApi = (
    globalThis as {
      wx?: {
        vibrateShort?: (options?: { type?: 'light' | 'medium' | 'heavy'; fail?: () => void }) => void
      }
    }
  ).wx

  if (wxApi?.vibrateShort) {
    wxApi.vibrateShort({
      type: 'light',
      fail: () => {},
    })
    return
  }

  uni.vibrateShort?.({
    type: 'light',
    fail: () => {},
  })
}

function isModeOptionDisabled(value: PracticeMode): boolean {
  return value === 'modeB' && shouldLockToSourceExtraction.value
}

function selectModeOption(value: PracticeMode): void {
  if (isModeOptionDisabled(value)) {
    mode.value = 'modeA'
    error.value = ''
    showPlainToast(ERROR_MODE_B_NEED_LONG_MATERIAL)
    return
  }
  mode.value = value
}

function showPlainToast(title: string): void {
  uni.showToast({
    title,
    icon: 'none',
  })
}

function getFileNameFromPath(path: string): string {
  const cleanPath = String(path || '').split('?')[0] || ''
  const parts = cleanPath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || 'material-image'
}

function normalizeImageMimeType(rawType: unknown, path = ''): string {
  const raw = String(rawType || '').trim().toLowerCase()
  if (raw === 'image/jpg') return 'image/jpeg'
  if (MATERIAL_IMAGE_MIME_TYPES.includes(raw)) return raw

  const cleanPath = String(path || '').split('?')[0].toLowerCase()
  if (/\.(jpe?g)$/.test(cleanPath)) return 'image/jpeg'
  if (/\.png$/.test(cleanPath)) return 'image/png'
  if (/\.webp$/.test(cleanPath)) return 'image/webp'
  if (/\.gif$/.test(cleanPath)) return 'image/gif'
  return ''
}

function estimateBase64Bytes(base64: string): number {
  const clean = String(base64 || '').replace(/\s+/g, '')
  if (!clean) return 0
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

function parseDataUrl(value: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(String(value || '').trim())
  if (!match) return null
  return {
    mimeType: normalizeImageMimeType(match[1]),
    base64: String(match[2] || '').replace(/\s+/g, ''),
  }
}

function assertSelectedMaterialImage(image: SelectedMaterialImage): void {
  if (!MATERIAL_IMAGE_MIME_TYPES.includes(image.mimeType)) {
    throw new Error(ERROR_IMAGE_INVALID)
  }
  if (image.size > MAX_MATERIAL_IMAGE_BYTES) {
    throw new Error(ERROR_IMAGE_TOO_LARGE)
  }
}

function normalizeSelectedMaterialImage(raw: unknown): SelectedMaterialImage | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as {
    path?: unknown
    tempFilePath?: unknown
    name?: unknown
    size?: unknown
    type?: unknown
    file?: unknown
  }
  const fileLike = source.file as { name?: unknown; size?: unknown; type?: unknown } | undefined
  const path = String(source.path || source.tempFilePath || '').trim()
  if (!path && !source.file) return null

  const size = Math.max(0, Number(source.size || fileLike?.size || 0))
  const name = String(source.name || fileLike?.name || getFileNameFromPath(path)).trim() || 'material-image'
  const mimeType = normalizeImageMimeType(source.type || fileLike?.type, path || name)
  const image = {
    path,
    name,
    size,
    mimeType,
    file: source.file,
  }
  assertSelectedMaterialImage(image)
  return image
}

function isChooseImageCancelled(error: unknown): boolean {
  const message = String((error as { errMsg?: unknown })?.errMsg || error || '').toLowerCase()
  return message.includes('cancel') || message.includes('取消')
}

function chooseMaterialImage(sourceType: MaterialImageSource): Promise<SelectedMaterialImage | null> {
  return new Promise((resolve, reject) => {
    uni.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: [sourceType],
      success: (result) => {
        const payload = result as {
          tempFiles?: unknown[]
          tempFilePaths?: string[]
        }
        const first = Array.isArray(payload.tempFiles) && payload.tempFiles.length > 0
          ? payload.tempFiles[0]
          : {
              path: payload.tempFilePaths?.[0] || '',
            }
        try {
          resolve(normalizeSelectedMaterialImage(first))
        } catch (error) {
          reject(error)
        }
      },
      fail: (error) => {
        if (isChooseImageCancelled(error)) {
          resolve(null)
          return
        }
        reject(error)
      },
    })
  })
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择'))
    reader.readAsDataURL(blob)
  })
}

function readSelectedFileAsDataUrl(file: unknown): Promise<string> | null {
  const BlobCtor = (globalThis as { Blob?: new (...args: unknown[]) => Blob }).Blob
  if (!BlobCtor || !(file instanceof BlobCtor)) return null
  return readBlobAsDataUrl(file)
}

function readFilePathAsBase64(path: string): Promise<string> | null {
  const fsApi = (uni as unknown as {
    getFileSystemManager?: () => {
      readFile: (options: {
        filePath: string
        encoding: 'base64'
        success: (result: { data?: unknown }) => void
        fail: (error: unknown) => void
      }) => void
    }
  }).getFileSystemManager?.()
  if (!fsApi) return null

  return new Promise((resolve, reject) => {
    fsApi.readFile({
      filePath: path,
      encoding: 'base64',
      success: (result) => resolve(String(result.data || '')),
      fail: reject,
    })
  })
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let cursor = 0; cursor < bytes.length; cursor += chunkSize) {
    const chunk = bytes.subarray(cursor, cursor + chunkSize)
    let piece = ''
    for (let index = 0; index < chunk.length; index += 1) {
      piece += String.fromCharCode(chunk[index])
    }
    binary += piece
  }
  return btoa(binary)
}

async function readImagePathWithFetch(path: string): Promise<string> {
  if (typeof fetch !== 'function') {
    throw new Error('当前环境不支持读取图片，请换用相册或相机重新选择')
  }
  const response = await fetch(path)
  if (!response.ok) {
    throw new Error('图片读取失败，请重新选择')
  }
  const buffer = await response.arrayBuffer()
  return arrayBufferToBase64(buffer)
}

function resolveImageProviderError(): string {
  const config = loadLlmConfig()
  if (config.provider === 'deepseek') {
    return '当前 DeepSeek 不支持图片解析，请切换 OpenAI、Gemini 或千问视觉模型'
  }
  return ''
}

async function readMaterialImageAsDataUrl(image: SelectedMaterialImage): Promise<string> {
  const directData = image.path.startsWith('data:image/') ? parseDataUrl(image.path) : null
  if (directData) {
    const byteLength = estimateBase64Bytes(directData.base64)
    if (byteLength > MAX_MATERIAL_IMAGE_BYTES) throw new Error(ERROR_IMAGE_TOO_LARGE)
    if (!MATERIAL_IMAGE_MIME_TYPES.includes(directData.mimeType)) throw new Error(ERROR_IMAGE_INVALID)
    return `data:${directData.mimeType};base64,${directData.base64}`
  }

  const fileReaderResult = image.file ? await readSelectedFileAsDataUrl(image.file)?.catch(() => '') : ''
  const fileData = fileReaderResult ? parseDataUrl(fileReaderResult) : null
  if (fileData) {
    const byteLength = estimateBase64Bytes(fileData.base64)
    if (byteLength > MAX_MATERIAL_IMAGE_BYTES) throw new Error(ERROR_IMAGE_TOO_LARGE)
    if (!MATERIAL_IMAGE_MIME_TYPES.includes(fileData.mimeType)) throw new Error(ERROR_IMAGE_INVALID)
    return `data:${fileData.mimeType};base64,${fileData.base64}`
  }

  if (!image.path) {
    throw new Error('图片读取失败，请重新选择')
  }

  const fromFileSystem = readFilePathAsBase64(image.path)
  const base64 = fromFileSystem
    ? await fromFileSystem
    : await readImagePathWithFetch(image.path)
  const byteLength = estimateBase64Bytes(base64)
  if (byteLength > MAX_MATERIAL_IMAGE_BYTES) throw new Error(ERROR_IMAGE_TOO_LARGE)
  return `data:${image.mimeType};base64,${String(base64 || '').replace(/\s+/g, '')}`
}

async function startImageMaterialGeneration(sourceType: MaterialImageSource): Promise<void> {
  if (isMaterialToolDisabled.value) return
  error.value = ''
  lastGeneratedCount.value = 0

  if (!isApiKeyReady.value) {
    handleGenerateBlocked()
    return
  }
  const providerError = resolveImageProviderError()
  if (providerError) {
    error.value = providerError
    showPlainToast(providerError)
    return
  }

  isImagePreparing.value = true
  try {
    const selectedImage = await chooseMaterialImage(sourceType)
    if (!selectedImage) return
    const imageDataUrl = await readMaterialImageAsDataUrl(selectedImage)
    mode.value = 'modeA'
    await runPracticeGeneration({
      materialText: material.value.trim(),
      skipMaterialValidation: true,
      modeOverride: 'modeA',
      imageDataUrl,
      imageName: selectedImage.name,
      imageMimeType: selectedImage.mimeType,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message.trim() : ''
    error.value = message || '图片处理失败，请重新选择'
    showPlainToast(error.value)
  } finally {
    isImagePreparing.value = false
  }
}

function chooseMaterialImageFromAlbum(): void {
  void startImageMaterialGeneration('album')
}

function captureMaterialImage(): void {
  void startImageMaterialGeneration('camera')
}

function selectPresetCount(count: number) {
  countMode.value = 'preset'
  selectedPresetCount.value = count
}

function openCustomCountDialog() {
  customCountDraft.value = customCount.value === null ? '' : String(customCount.value)
  showCustomCountDialog.value = true
}

function closeCustomCountDialog() {
  showCustomCountDialog.value = false
}

function clearCustomCount() {
  customCountDraft.value = ''
  customCount.value = null
  if (countMode.value === 'custom') {
    countMode.value = 'preset'
  }
  showCustomCountDialog.value = false
}

function confirmCustomCount() {
  const raw = customCountDraft.value.trim()
  if (!raw) {
    customCount.value = null
    if (countMode.value === 'custom') {
      countMode.value = 'preset'
    }
    showCustomCountDialog.value = false
    return
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    uni.showToast({
      title: '请输入有效数字',
      icon: 'none',
    })
    return
  }

  const next = Math.min(MAX_CUSTOM_COUNT, Math.max(MIN_CUSTOM_COUNT, Math.round(parsed)))
  customCount.value = next
  countMode.value = 'custom'
  showCustomCountDialog.value = false
}

function parseQuestionCount(): number {
  if (countMode.value === 'custom' && customCount.value !== null) {
    return customCount.value
  }
  return Math.min(MAX_CUSTOM_COUNT, Math.max(MIN_CUSTOM_COUNT, selectedPresetCount.value))
}

function resolvePipelineTimeoutMs(requestedCount: number, currentMode: PracticeMode): number {
  const normalizedCount = Math.max(1, Math.floor(Number(requestedCount || 1)))
  const modeExtra = currentMode === 'modeB' ? PIPELINE_TIMEOUT_MODE_B_EXTRA_MS : 0
  const estimated = PIPELINE_TIMEOUT_BASE_MS + normalizedCount * PIPELINE_TIMEOUT_PER_QUESTION_MS + modeExtra
  return Math.min(PIPELINE_TIMEOUT_MAX_MS, Math.max(PIPELINE_TIMEOUT_MIN_MS, estimated))
}

function validateMaterialForMode(trimmedMaterial: string): string {
  if (!trimmedMaterial) return ERROR_EMPTY_MATERIAL
  return mode.value === 'modeB' && trimmedMaterial.length <= 50 ? ERROR_MODE_B_NEED_LONG_MATERIAL : ''
}

async function runPracticeGeneration(options: RunPracticeGenerationOptions): Promise<void> {
  if (isLoading.value) return

  error.value = ''
  lastGeneratedCount.value = 0
  generateCanceled.value = false
  const requestNonce = generateRequestNonce.value + 1
  generateRequestNonce.value = requestNonce

  if (!isApiKeyReady.value) {
    error.value = ''
    handleGenerateBlocked()
    return
  }

  const trimmedMaterial = String(options.materialText || '').trim()
  if (!options.skipMaterialValidation) {
    const materialValidationError = validateMaterialForMode(trimmedMaterial)
    if (materialValidationError) {
      error.value = materialValidationError
      return
    }
  }

  const count = parseQuestionCount()
  const initialBatchCount = count
  const requestMode = options.modeOverride || mode.value
  const pipelineTimeoutMs = resolvePipelineTimeoutMs(count, requestMode)
  const userTags = loadUserTags()

  isLoading.value = true
  let keepLoadingForNavigation = false
  try {
    const generationInput: StartPracticeGenerationInput = {
      material: trimmedMaterial,
      type: questionType.value,
      difficulty: difficulty.value,
      mode: requestMode,
      feedbackMode: feedbackMode.value,
      targetCount: count,
      initialBatchCount,
      userTags,
      requestNonce,
      timeoutMs: pipelineTimeoutMs,
      ...(options.imageDataUrl
        ? {
            imageDataUrl: options.imageDataUrl,
            imageName: options.imageName || '',
            imageMimeType: options.imageMimeType || '',
          }
        : {}),
    }
    activeGenerationInput.value = generationInput
    const generation = await startPracticeGeneration(generationInput)
    if (requestNonce !== generateRequestNonce.value || generateCanceled.value) return

    if (!generation.success) {
      error.value = generation.error
      return
    }

    clearMaterialDraftPersistence()
    getGuideGlobalData().tempInputContent = ''
    lastGeneratedCount.value = generation.output.savedCount

    const target = '/pages/practice/index'
    keepLoadingForNavigation = true
    uni.navigateTo({
      url: target,
      success: () => {
        if (requestNonce !== generateRequestNonce.value) return
        // 已完成跳转，清理当前页 loading，避免返回后残留
        keepLoadingForNavigation = false
        isLoading.value = false
      },
      fail: () => {
        uni.reLaunch({
          url: target,
          success: () => {
            if (requestNonce !== generateRequestNonce.value) return
            keepLoadingForNavigation = false
            isLoading.value = false
          },
          fail: () => {
            if (requestNonce !== generateRequestNonce.value) return
            keepLoadingForNavigation = false
            isLoading.value = false
          },
        })
      },
    })
  } catch (err) {
    if (requestNonce !== generateRequestNonce.value || generateCanceled.value) return
    const message = err instanceof Error ? err.message.trim() : ''
    error.value = message || '生成失败，请稍后重试'
  } finally {
    if (requestNonce !== generateRequestNonce.value) return
    activeGenerationInput.value = null
    if (!keepLoadingForNavigation) {
      isLoading.value = false
    }
  }
}

function onGenerate() {
  void runPracticeGeneration({
    materialText: material.value.trim(),
  })
}

stopWatchMaterial = watch(material, (nextMaterial) => {
  syncMaterialDraft(String(nextMaterial || ''))
})

watch([material, mode], () => {
  if (shouldLockToSourceExtraction.value && mode.value === 'modeB') {
    mode.value = 'modeA'
  }
})

watch([material, mode], () => {
  if (!materialErrorSet.has(error.value)) return
  const nextError = validateMaterialForMode(material.value.trim())
  error.value = nextError
})
</script>

<style scoped>
.page-root {
  min-height: 100vh;
  width: 100%;
  max-width: 600px;
  margin: 0 auto;
  background: #F8F8F8;
  color: #3C4043;
  position: relative;
  overflow-y: visible;
}

.page-header-fixed {
  position: fixed;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  max-width: 600px;
  width: 100%;
  z-index: 100;
  padding-left: 40rpx;
  padding-right: 40rpx;
  box-sizing: border-box;
  background: #F8F8F8;
}

.page-scroll {
  width: 100%;
  max-width: 600px;
  min-height: 100vh;
  padding-bottom: calc(env(safe-area-inset-bottom) + 112rpx);
  box-sizing: border-box;
  background: #F8F8F8;
  overflow-y: visible;
  -webkit-overflow-scrolling: touch;
}

.page-body {
  padding: 0 40rpx calc(12rpx + env(safe-area-inset-bottom));
  margin-top: 0;
}

.title-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding-top: 0;
  padding-bottom: 12rpx;
  margin-bottom: 0;
}

.title-head {
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  width: 100%;
  margin-top: 0;
}

.page-logo {
  display: block;
  width: 384rpx;
  height: 86.4rpx;
  flex: 0 0 384rpx;
  margin-top: 0;
  opacity: 1;
  will-change: transform;
}

.page-subtitle {
  display: block;
  margin-top: 12rpx;
  font-size: 30rpx;
  font-family: 'MiSans', 'PingFang SC', -apple-system, 'SF Pro Text', sans-serif;
  line-height: 1.45;
  color: #555555;
  font-weight: 500;
  letter-spacing: 0;
  align-self: flex-start;
  margin-left: calc(20rpx + 20rpx + 18rpx);
  padding-left: 0;
  text-align: left;
  max-width: 100%;
  animation: slogan-slide-in-down 420ms ease both;
}

/* #ifdef H5 || APP-PLUS */
.title-wrap {
  align-items: center;
}

.title-head {
  justify-content: center;
}

.page-logo {
  margin-left: auto;
  margin-right: auto;
}

.page-subtitle {
  align-self: center;
  margin-left: 0;
  text-align: center;
}
/* #endif */

.main-container {
  margin-top: 4rpx;
  margin-bottom: 20rpx;
  background: #FFFFFF;
  border-radius: 16rpx;
  box-shadow: 0 4rpx 20rpx rgba(0, 0, 0, 0.04);
  padding: 20rpx 20rpx calc(24rpx + env(safe-area-inset-bottom));
}

.page-root :deep(.oa-tab-wrap) {
  left: 50%;
  right: auto;
  width: 100%;
  max-width: 600px;
  transform: translateX(-50%);
}

.material-panel {
  padding: 20rpx;
}

.material-input-wrap {
  position: relative;
}

.material-watermark {
  position: absolute;
  left: 50%;
  top: calc(50% + 51rpx);
  width: 449.28rpx;
  height: 314.496rpx;
  transform: translate(-50%, -50%);
  z-index: 1;
  pointer-events: none;
  opacity: 1;
  transition: opacity 0.2s ease;
}

.material-input {
  width: 100%;
  min-height: 280rpx;
  border: 1rpx solid #E8EAED;
  border-radius: 16rpx;
  padding: 18rpx 176rpx 76rpx 18rpx;
  background: transparent;
  font-size: 28rpx;
  line-height: 1.6;
  color: #3C4043;
  text-align: center;
}

.material-tool-row {
  position: absolute;
  right: 14rpx;
  bottom: 14rpx;
  display: flex;
  align-items: center;
  z-index: 3;
}

.material-tool-btn,
.material-clear-btn {
  width: 52rpx;
  height: 52rpx;
  margin-left: 12rpx;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #FFFFFF;
  border: 1rpx solid #DADCE0;
  box-sizing: border-box;
}

.material-tool-row > view:first-child {
  margin-left: 0;
}

.material-tool-btn.is-disabled,
.material-clear-btn.is-disabled {
  opacity: 0.45;
  pointer-events: none;
}

.material-tool-plus {
  color: #00B368;
  font-size: 42rpx;
  line-height: 1;
  transform: translateY(-2rpx);
}

.material-tool-icon {
  width: 34rpx;
  height: 34rpx;
}

.material-clear-icon {
  width: 34rpx;
  height: 34rpx;
}

.mascot-watermark-fade-enter-active,
.mascot-watermark-fade-leave-active {
  transition: opacity 0.2s ease;
}

.mascot-watermark-fade-enter-from,
.mascot-watermark-fade-leave-to {
  opacity: 0;
}

.setting-panel {
  margin-top: 28rpx;
  padding: 20rpx;
}

.section-title {
  display: block;
  margin-bottom: 16rpx;
  font-size: 28rpx;
  line-height: 1.3;
  font-weight: 600;
  color: #1A1A1A;
}

.grid-row {
  display: grid;
  gap: 12rpx;
}

.grid-row + .grid-row {
  margin-top: 12rpx;
}

.setting-item {
  margin-bottom: 28rpx;
}

.setting-item-count {
  margin-bottom: 56rpx;
}

.mode-hint {
  display: block;
  margin-top: 8rpx;
  margin-bottom: 0;
  font-size: 22rpx;
  line-height: 1.4;
  font-weight: 400;
  color: #999999;
}

.row-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.feedback-row .option-cell {
  color: #1A1A1A;
}

.feedback-row .option-cell.is-active {
  border: 1rpx solid #07C160;
  color: #07C160;
}

.row-3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.row-4 {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.option-cell {
  min-height: 70rpx;
  border: 1rpx solid #E8EAED;
  border-radius: 16rpx;
  background: #ffffff;
  font-size: 28rpx;
  font-weight: 500;
  letter-spacing: 0.5rpx;
  color: #1A1A1A;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.option-cell.is-active {
  border: 2rpx solid #07C160;
  background: #ffffff;
  color: #1A1A1A;
  font-weight: 500;
}

.option-cell.is-disabled {
  color: #A8ADB3;
  background: #F7F8FA;
  border-color: #E8EAED;
}

.option-cell.is-disabled.is-active {
  color: #1A1A1A;
  background: #ffffff;
  border-color: #07C160;
}

.custom-count-cell {
  padding: 0 8rpx;
}

.custom-count-text {
  width: 100%;
  text-align: center;
}

.count-dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 40rpx;
}

.count-dialog {
  width: 100%;
  border-radius: 32rpx;
  background: #FFFFFF;
  box-shadow: 0 10rpx 40rpx rgba(0, 0, 0, 0.1);
  padding: 40rpx;
}

/* #ifdef H5 */
@media screen and (min-width: 768px) {
  .count-dialog-mask {
    padding: 0 24px;
  }

  .count-dialog {
    max-width: 760px;
  }
}
/* #endif */

.count-dialog-title {
  display: block;
  font-size: 36rpx;
  line-height: 1.3;
  font-weight: 600;
  color: #1A1A1A;
}

.count-dialog-input {
  width: 100%;
  height: 88rpx;
  margin-top: 40rpx;
  border: 0;
  border-radius: 16rpx;
  padding: 0 32rpx;
  font-size: 28rpx;
  color: #3C4043;
  background: #F8F8F8;
  text-align: left;
}

.count-dialog-actions {
  margin-top: 40rpx;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20rpx;
}

.count-dialog-action-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 20rpx;
}

.count-dialog-btn {
  min-height: 72rpx;
  padding: 0 24rpx;
  border-radius: 16rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26rpx;
  color: #3C4043;
  background: transparent;
  transition: all var(--oa-fast-transition-duration) ease;
}

.count-dialog-btn.is-clear {
  color: #FA5151;
}

.count-dialog-btn.is-cancel {
  color: #999999;
}

.count-dialog-btn.is-clear,
.count-dialog-btn.is-cancel {
  padding-left: 0;
  padding-right: 0;
}

.count-dialog-btn.is-primary {
  min-width: 156rpx;
  border: 1rpx solid #07C160;
  background: #07C160;
  color: #FFFFFF;
  font-weight: 600;
}

.generate-btn-wrap {
  position: relative;
  width: 85%;
  margin: 0 auto;
}

.generate-btn {
  width: 100%;
  min-height: 84rpx;
  margin: 0;
  border: 1rpx solid #07C160;
  border-radius: 100rpx;
  background: #07C160;
  color: #ffffff;
  font-size: 30rpx;
  font-weight: 600;
  letter-spacing: 4rpx;
  box-shadow: 0 12rpx 24rpx rgba(7, 193, 96, 0.15);
}

.generate-btn.is-breathing {
  animation: generate-btn-breath 3s ease-in-out 1;
}

.generate-btn-hover {
  opacity: 0.92;
}

@keyframes generate-btn-breath {
  0% {
    transform: scale(1);
    box-shadow: 0 12rpx 24rpx rgba(7, 193, 96, 0.15);
  }
  50% {
    transform: scale(1.03);
    box-shadow: 0 18rpx 34rpx rgba(7, 193, 96, 0.24);
  }
  100% {
    transform: scale(1);
    box-shadow: 0 12rpx 24rpx rgba(7, 193, 96, 0.15);
  }
}

.generate-btn-blocker {
  position: absolute;
  inset: 0;
  z-index: 2;
}

.api-guide-row {
  margin-top: 12rpx;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 44rpx;
  border-radius: 8rpx;
  background: transparent;
  box-shadow: none;
  transition: background-color 280ms ease, box-shadow 280ms ease;
}

.api-guide-text {
  font-size: 24rpx;
  line-height: 1.5;
  color: #8E8E93;
  font-weight: 500;
  white-space: nowrap;
  transition: color 280ms ease;
}

.api-guide-link {
  font-size: 24rpx;
  line-height: 1.5;
  color: #07C160;
  font-weight: 600;
  transition: color 280ms ease;
}

.api-guide-row.is-error {
  background: #FFF2F0;
  box-shadow: inset 0 0 0 1rpx #FFCCC7;
}

.api-guide-row.is-error .api-guide-text,
.api-guide-row.is-error .api-guide-link {
  color: #FF4D4F;
}

.api-guide-row.is-shaking {
  animation: api-guide-shake 0.1s linear 3;
}

@keyframes api-guide-shake {
  0% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-4rpx);
  }
  50% {
    transform: translateX(4rpx);
  }
  75% {
    transform: translateX(-4rpx);
  }
  100% {
    transform: translateX(0);
  }
}

@keyframes slogan-slide-in-down {
  0% {
    opacity: 0;
    transform: translateY(-10rpx);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

.error-text {
  margin-top: 24rpx;
  color: #FF4D4F;
  font-size: 24rpx;
  line-height: 1.5;
  word-break: break-all;
}

.error-text.is-center {
  text-align: center;
  word-break: normal;
}

.latest-panel {
  margin-top: 20rpx;
  padding: 14rpx 16rpx;
  font-size: 22rpx;
  line-height: 1.5;
  color: #70757A;
}

</style>
