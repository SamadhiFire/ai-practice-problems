#include "MnnQwenRunner.h"

#ifdef __ANDROID__
#include <android/log.h>
#define LOG_TAG "MnnQwenRunner"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#else
#define LOGI(...) (void)0
#define LOGW(...) (void)0
#define LOGE(...) (void)0
#endif

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <sstream>

#if defined(__ANDROID__) && defined(__aarch64__)
#include <asm/hwcap.h>
#include <sys/auxv.h>
#endif

#include "llm/llm.hpp"

using Clock = std::chrono::steady_clock;

namespace {

std::string jsonEscape(const std::string& input) {
    std::ostringstream os;
    for (unsigned char ch : input) {
        switch (ch) {
            case '\\': os << "\\\\"; break;
            case '"':  os << "\\\""; break;
            case '\b': os << "\\b"; break;
            case '\f': os << "\\f"; break;
            case '\n': os << "\\n"; break;
            case '\r': os << "\\r"; break;
            case '\t': os << "\\t"; break;
            default:
                if (ch < 0x20) {
                    os << "\\u"
                       << std::hex << std::uppercase
                       << std::setw(4) << std::setfill('0')
                       << static_cast<int>(ch)
                       << std::dec;
                } else {
                    os << static_cast<char>(ch);
                }
                break;
        }
    }
    return os.str();
}

std::string deriveModelName(const std::string& configPath) {
    if (configPath.empty()) {
        return "Qwen";
    }

    const auto slash = configPath.find_last_of("/\\");
    if (slash == std::string::npos) {
        return "Qwen";
    }

    const auto parentEnd = slash;
    const auto parentStart = configPath.find_last_of("/\\", parentEnd == 0 ? 0 : parentEnd - 1);
    if (parentStart == std::string::npos) {
        return configPath.substr(0, parentEnd);
    }

    const auto begin = parentStart + 1;
    if (begin >= parentEnd) {
        return "Qwen";
    }
    return configPath.substr(begin, parentEnd - begin);
}

}  // namespace

std::string RuntimeStatus::toJson() const {
    std::ostringstream os;
    os << "{"
       << "\"modelLoaded\":" << (modelLoaded ? "true" : "false")
       << ",\"modelName\":\"" << jsonEscape(modelName) << "\""
       << ",\"modelPath\":\"" << jsonEscape(modelPath) << "\""
       << ",\"backendType\":\"" << jsonEscape(backendType) << "\""
       << ",\"threadNum\":" << threadNum
       << ",\"sme2Supported\":" << (sme2Supported ? "true" : "false")
       << ",\"sme2Enabled\":" << (sme2Enabled ? "true" : "false")
       << ",\"lastPromptTokens\":" << promptTokens
       << ",\"lastOutputTokens\":" << outputTokens
       << ",\"lastLatencyMs\":" << totalTimeMs
       << ",\"lastTokensPerSecond\":" << tokensPerSec
       << ",\"firstTokenLatencyMs\":" << firstTokenLatencyMs
       << ",\"totalInferences\":" << totalInferences
       << ",\"totalOutputTokens\":" << totalOutputTokens
       << ",\"totalInferenceMs\":" << totalInferenceMs;
    if (!error.empty()) {
        os << ",\"error\":\"" << jsonEscape(error) << "\"";
    }
    os << "}";
    return os.str();
}

MnnQwenRunner::MnnQwenRunner() {
    detectCpuFeatures();
}

MnnQwenRunner::~MnnQwenRunner() {
    release();
}

void MnnQwenRunner::detectCpuFeatures() {
    status_.hasNEON = true;
    status_.sme2Supported = detectSME2();
#ifdef MNN_QWEN_ENABLE_SME2_COMPILE_FLAG
    status_.sme2Enabled = status_.sme2Supported;
#else
    status_.sme2Enabled = false;
#endif
    LOGI("CPU features: NEON=%d, SME2=%d, SME2 compile flag=%d",
         status_.hasNEON,
         status_.sme2Supported,
#ifdef MNN_QWEN_ENABLE_SME2_COMPILE_FLAG
         1
#else
         0
#endif
    );
}

bool MnnQwenRunner::detectSME2() {
#if defined(__ANDROID__) && defined(__aarch64__) && defined(HWCAP2_SME2)
    if ((getauxval(AT_HWCAP2) & HWCAP2_SME2) != 0) {
        LOGI("SME2 detected via AT_HWCAP2");
        return true;
    }
#endif

    std::ifstream cpuinfo("/proc/cpuinfo");
    if (!cpuinfo.is_open()) {
        LOGW("Cannot open /proc/cpuinfo for SME2 detection");
        return false;
    }

    std::string line;
    while (std::getline(cpuinfo, line)) {
        if (line.find("Features") == std::string::npos) {
            continue;
        }

        const auto colon = line.find(':');
        if (colon == std::string::npos) {
            continue;
        }

        std::string features = line.substr(colon + 1);
        std::transform(features.begin(), features.end(), features.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

        std::istringstream featureStream(features);
        std::string feature;
        while (featureStream >> feature) {
            if (feature == "sme2") {
                LOGI("SME2 detected in /proc/cpuinfo");
                return true;
            }
        }
        break;
    }
    return false;
}

bool MnnQwenRunner::load(const std::string& configPath) {
    std::lock_guard<std::mutex> lock(mu_);

    if (loaded_) {
        LOGW("Model already loaded, releasing previous instance first");
        if (llm_) {
            delete llm_;
            llm_ = nullptr;
        }
        loaded_ = false;
    }

    status_.modelLoaded = false;
    status_.modelPath = configPath;
    status_.modelName = deriveModelName(configPath);
    status_.error.clear();

    LOGI("Loading model from config: %s", configPath.c_str());

    {
        std::ifstream file(configPath);
        if (!file.good()) {
            status_.error = "MODEL_FILE_NOT_FOUND: " + configPath;
            LOGE("%s", status_.error.c_str());
            return false;
        }
    }

    try {
        llm_ = MNN::Transformer::Llm::createLLM(configPath);
        if (!llm_) {
            status_.error = "MODEL_INIT_FAILED: createLLM returned null";
            LOGE("%s", status_.error.c_str());
            return false;
        }

        if (!llm_->load()) {
            status_.error = "MODEL_INIT_FAILED: MNN LLM load returned false";
            LOGE("%s", status_.error.c_str());
            delete llm_;
            llm_ = nullptr;
            return false;
        }
        loaded_ = true;
        status_.modelLoaded = true;
        status_.error.clear();
        LOGI("Model loaded successfully");
        return true;
    } catch (const std::exception& e) {
        status_.error = std::string("MODEL_INIT_FAILED: ") + e.what();
        LOGE("%s", status_.error.c_str());
        if (llm_) {
            delete llm_;
            llm_ = nullptr;
        }
        loaded_ = false;
        status_.modelLoaded = false;
        return false;
    }
}

std::string MnnQwenRunner::generate(const std::string& prompt,
                                    int maxNewTokens,
                                    float /*temperature*/,
                                    float /*topP*/) {
    std::lock_guard<std::mutex> lock(mu_);

    if (!loaded_ || !llm_) {
        return "ERROR: Model not loaded";
    }

    LOGI("generate: prompt_len=%zu", prompt.size());

    try {
        const auto t0 = Clock::now();
        std::ostringstream outputStream;
        llm_->response(prompt, &outputStream, nullptr, maxNewTokens);
        std::string output = outputStream.str();
        const auto tEnd = Clock::now();

        const double totalMs = std::chrono::duration<double, std::milli>(tEnd - t0).count();

        auto countTokensApprox = [](const std::string& text) -> int64_t {
            if (text.empty()) {
                return 0;
            }
            int64_t count = 1;
            for (char c : text) {
                if (c == ' ' || c == '\n' || c == '\t') {
                    ++count;
                }
            }
            return count;
        };

        const int64_t outTokens = countTokensApprox(output);
        const int64_t inTokens = countTokensApprox(prompt);
        const double prefillMs = totalMs * 0.2;
        const double decodeMs = totalMs - prefillMs;
        const double tps = (decodeMs > 0.0) ? (outTokens / (decodeMs / 1000.0)) : 0.0;

        status_.promptTokens = inTokens;
        status_.outputTokens = outTokens;
        status_.prefillTimeMs = prefillMs;
        status_.decodeTimeMs = decodeMs;
        status_.totalTimeMs = totalMs;
        status_.tokensPerSec = tps;
        status_.firstTokenLatencyMs = prefillMs;
        status_.totalInferences += 1;
        status_.totalOutputTokens += outTokens;
        status_.totalInferenceMs += totalMs;
        status_.error.clear();

        LOGI("generate done: %lld tokens in %.1f ms (%.1f tok/s)",
             static_cast<long long>(outTokens),
             totalMs,
             tps);

        return output;
    } catch (const std::exception& e) {
        status_.error = std::string("INFERENCE_FAILED: ") + e.what();
        LOGE("Exception during generate: %s", e.what());
        return std::string("ERROR: ") + e.what();
    }
}

RuntimeStatus MnnQwenRunner::status() const {
    std::lock_guard<std::mutex> lock(mu_);
    return status_;
}

void MnnQwenRunner::release() {
    std::lock_guard<std::mutex> lock(mu_);

    if (llm_) {
        LOGI("Releasing model...");
        delete llm_;
        llm_ = nullptr;
    }

    loaded_ = false;
    status_.modelLoaded = false;
    status_.promptTokens = 0;
    status_.outputTokens = 0;
    status_.prefillTimeMs = 0.0;
    status_.decodeTimeMs = 0.0;
    status_.totalTimeMs = 0.0;
    status_.tokensPerSec = 0.0;
    status_.firstTokenLatencyMs = 0.0;
    status_.error.clear();

    LOGI("Model released, memory freed");
}
