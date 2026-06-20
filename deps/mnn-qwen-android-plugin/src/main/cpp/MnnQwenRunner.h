#pragma once

#include <string>
#include <memory>
#include <mutex>
#include <atomic>
#include <cstdint>

// Forward-declare the MNN LLM type so we don't leak the header into every TU.
namespace MNN {
namespace Transformer {
    class Llm;
}
}

// -------------------------------------------------------------------------- //
//  RuntimeStatus – mirrors the fields expected by the JS/Kotlin layer.
// -------------------------------------------------------------------------- //

struct RuntimeStatus {
    // ── Model info ──
    bool        modelLoaded       = false;
    std::string modelName         = "Qwen2.5-0.5B-Instruct";
    std::string modelPath;
    std::string backendType       = "cpu";
    int         threadNum         = 4;

    // ── CPU feature detection ──
    bool        sme2Supported     = false;
    bool        sme2Enabled       = false;
    bool        hasNEON           = true;  // always true on arm64-v8a

    // ── Inference metrics (most recent generate() call) ──
    int64_t     promptTokens      = 0;
    int64_t     outputTokens      = 0;
    double      prefillTimeMs     = 0.0;    // time-to-first-token
    double      decodeTimeMs      = 0.0;    // total decode wall-clock
    double      totalTimeMs       = 0.0;    // end-to-end latency (lastLatencyMs)
    double      tokensPerSec      = 0.0;    // output tokens / decode time
    double      firstTokenLatencyMs = 0.0;  // time-to-first-token (alias)

    // ── Cumulative counters (across all generate() calls in this session) ──
    int64_t     totalInferences   = 0;
    int64_t     totalOutputTokens = 0;
    double      totalInferenceMs  = 0.0;

    // ── Error message (empty = no error) ──
    std::string error;

    /** Serialise to a JSON string matching LocalMnnRuntimeStatus. */
    std::string toJson() const;
};

// -------------------------------------------------------------------------- //
//  MnnQwenRunner – thin wrapper around MNN's Llm API.
// -------------------------------------------------------------------------- //

class MnnQwenRunner {
public:
    MnnQwenRunner();
    ~MnnQwenRunner();

    // Non-copyable, non-movable.
    MnnQwenRunner(const MnnQwenRunner&)            = delete;
    MnnQwenRunner& operator=(const MnnQwenRunner&) = delete;

    /**
     * Load the model from the directory that contains config.json.
     * @param configPath  Absolute path to config.json.
     * @return true on success.
     */
    bool load(const std::string& configPath);

    /**
     * Run synchronous text generation.
     * @param prompt       The user prompt (may include chat template).
     * @param maxNewTokens Maximum tokens to generate.
     * @param temperature  Sampling temperature (0 = greedy).
     * @param topP         Nucleus sampling threshold.
     * @return Generated text, or an error string prefixed with "ERROR:".
     */
    std::string generate(const std::string& prompt,
                         int   maxNewTokens = 512,
                         float temperature  = 0.2f,
                         float topP         = 0.8f);

    /** Query the current runtime status (thread-safe snapshot). */
    RuntimeStatus status() const;

    /** Release the model and free all native memory. */
    void release();

    /** Detect ARM SME2 feature from /proc/cpuinfo. */
    static bool detectSME2();

private:
    mutable std::mutex           mu_;
    MNN::Transformer::Llm*      llm_       = nullptr;
    RuntimeStatus                status_;
    std::atomic<bool>            loaded_{false};

    /** One-shot CPU feature detection (called during construction). */
    void detectCpuFeatures();
};
