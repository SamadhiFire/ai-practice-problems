/**
 * mnn_qwen_jni.cpp — JNI bridge between Kotlin MnnQwenModule and C++ MnnQwenRunner
 *
 * Responsibilities:
 * 1. Map Kotlin external methods to MnnQwenRunner instance methods
 * 2. Serialize/deserialize parameters (Kotlin String ↔ C++ std::string)
 * 3. Manage MnnQwenRunner singleton lifecycle via JNI_OnLoad/JNI_OnUnload
 */

#include <jni.h>
#include <string>
#include <android/log.h>

#include "MnnQwenRunner.h"

#define LOG_TAG "MnnQwenJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// -------------------------------------------------------------------------- //
//  Global singleton runner instance
// -------------------------------------------------------------------------- //
static MnnQwenRunner* g_runner = nullptr;

// -------------------------------------------------------------------------- //
//  Helper: convert jstring → std::string
// -------------------------------------------------------------------------- //
static std::string jstringToStd(JNIEnv* env, jstring js) {
    if (!js) return "";
    const char* raw = env->GetStringUTFChars(js, nullptr);
    std::string result(raw);
    env->ReleaseStringUTFChars(js, raw);
    return result;
}

// ========================================================================== //
//  JNI_OnLoad / JNI_OnUnload
// ========================================================================== //

extern "C" JNIEXPORT jint JNICALL
JNI_OnLoad(JavaVM* /*vm*/, void* /*reserved*/) {
    if (!g_runner) {
        g_runner = new MnnQwenRunner();
        LOGI("MnnQwenRunner singleton created in JNI_OnLoad");
    }
    return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT void JNICALL
JNI_OnUnload(JavaVM* /*vm*/, void* /*reserved*/) {
    if (g_runner) {
        delete g_runner;
        g_runner = nullptr;
        LOGI("MnnQwenRunner singleton destroyed in JNI_OnUnload");
    }
}

// ========================================================================== //
//  JNI exports  – Java class: com.studyquiz.mnn.MnnQwenModule
//
//  JNI name mangling (instance methods, NOT companion object):
//    com.studyquiz.mnn.MnnQwenModule  →  Java_com_studyquiz_mnn_MnnQwenModule_<method>
// ========================================================================== //

extern "C" {

// ── nativeInit ─────────────────────────────────────────────────────────────
// Optional explicit init — returns true if runner is available.

JNIEXPORT jboolean JNICALL
Java_com_studyquiz_mnn_MnnQwenModule_nativeInit(
        JNIEnv* /*env*/,
        jobject /*thiz*/) {
    return (g_runner != nullptr) ? JNI_TRUE : JNI_FALSE;
}

// ── nativeLoadModel ────────────────────────────────────────────────────────

JNIEXPORT jboolean JNICALL
Java_com_studyquiz_mnn_MnnQwenModule_nativeLoadModel(
        JNIEnv* env,
        jobject /*thiz*/,
        jstring configPath) {
    if (!g_runner) {
        LOGE("nativeLoadModel: runner not initialized");
        return JNI_FALSE;
    }

    std::string path = jstringToStd(env, configPath);
    LOGI("nativeLoadModel: %s", path.c_str());

    bool ok = g_runner->load(path);
    return static_cast<jboolean>(ok ? JNI_TRUE : JNI_FALSE);
}

// ── nativeGenerate ─────────────────────────────────────────────────────────

JNIEXPORT jstring JNICALL
Java_com_studyquiz_mnn_MnnQwenModule_nativeGenerate(
        JNIEnv* env,
        jobject /*thiz*/,
        jstring prompt,
        jint    maxTokens,
        jfloat  temperature,
        jfloat  topP) {
    if (!g_runner) {
        return env->NewStringUTF("ERROR: Runner not initialized");
    }

    std::string promptStr = jstringToStd(env, prompt);

    std::string result = g_runner->generate(
        promptStr,
        static_cast<int>(maxTokens),
        static_cast<float>(temperature),
        static_cast<float>(topP)
    );

    return env->NewStringUTF(result.c_str());
}

// ── nativeGetStatus ────────────────────────────────────────────────────────

JNIEXPORT jstring JNICALL
Java_com_studyquiz_mnn_MnnQwenModule_nativeGetStatus(
        JNIEnv* env,
        jobject /*thiz*/) {
    if (!g_runner) {
        return env->NewStringUTF(
            "{\"modelLoaded\":false,\"error\":\"RUNNER_NOT_INITIALIZED\"}");
    }

    RuntimeStatus st = g_runner->status();
    std::string json = st.toJson();
    return env->NewStringUTF(json.c_str());
}

// ── nativeRelease ──────────────────────────────────────────────────────────

JNIEXPORT void JNICALL
Java_com_studyquiz_mnn_MnnQwenModule_nativeRelease(
        JNIEnv* /*env*/,
        jobject /*thiz*/) {
    LOGI("nativeRelease");
    if (g_runner) {
        g_runner->release();
    }
}

// ── nativeDetectSME2 ───────────────────────────────────────────────────────

JNIEXPORT jboolean JNICALL
Java_com_studyquiz_mnn_MnnQwenModule_nativeDetectSME2(
        JNIEnv* /*env*/,
        jobject /*thiz*/) {
    bool sme2 = MnnQwenRunner::detectSME2();
    return static_cast<jboolean>(sme2 ? JNI_TRUE : JNI_FALSE);
}

} // extern "C"
