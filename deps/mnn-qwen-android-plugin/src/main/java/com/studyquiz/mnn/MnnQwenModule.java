package com.studyquiz.mnn;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import io.dcloud.feature.uniapp.annotation.UniJSMethod;
import io.dcloud.feature.uniapp.bridge.UniJSCallback;
import io.dcloud.feature.uniapp.common.UniModule;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

public final class MnnQwenModule extends UniModule {
    private static final String TAG = "MnnQwenModule";
    private static final String DEFAULT_MODEL_SUBDIR = "models/qwen-mnn";
    private static final String PACKAGED_MODEL_ASSET_DIR = "models/qwen-mnn";
    private static final String JNI_LIB_NAME = "mnn_qwen_jni";
    private static final List<String> REQUIRED_MODEL_FILES = Arrays.asList(
            "config.json",
            "llm_config.json",
            "llm.mnn",
            "llm.mnn.weight",
            "tokenizer.mtok"
    );

    private static boolean nativeLibsLoaded;

    private volatile boolean modelLoaded;

    private native boolean nativeInit();
    private native boolean nativeLoadModel(String configPath);
    private native String nativeGenerate(String prompt, int maxTokens, float temperature, float topP);
    private native String nativeGetStatus();
    private native void nativeRelease();
    private native boolean nativeDetectSME2();

    public static synchronized void ensureNativeLibs() {
        if (nativeLibsLoaded) {
            return;
        }
        System.loadLibrary("MNN");
        System.loadLibrary(JNI_LIB_NAME);
        nativeLibsLoaded = true;
        Log.i(TAG, "Native libraries loaded successfully");
    }

    private Context requireContext() {
        if (mUniSDKInstance == null || mUniSDKInstance.getContext() == null) {
            throw new IllegalStateException("Context unavailable: the module is not attached yet");
        }
        return mUniSDKInstance.getContext();
    }

    private File defaultModelDir(Context context) {
        return new File(context.getFilesDir(), DEFAULT_MODEL_SUBDIR);
    }

    private File resolveModelDir(JSONObject options, Context context) {
        String explicit = options == null ? "" : options.optString("modelDir", "").trim();
        return explicit.isEmpty() ? defaultModelDir(context) : new File(explicit);
    }

    private List<String> listMissingModelFiles(File modelDir) {
        List<String> missing = new ArrayList<>();
        for (String fileName : REQUIRED_MODEL_FILES) {
            File file = new File(modelDir, fileName);
            if (!file.isFile() || file.length() <= 0L) {
                missing.add(fileName);
            }
        }
        return missing;
    }

    private Set<String> listPackagedAssetFiles(AssetManager assets) throws Exception {
        Set<String> files = new LinkedHashSet<>();
        collectAssetLeafPaths(assets, PACKAGED_MODEL_ASSET_DIR, "", files);
        return files;
    }

    private void collectAssetLeafPaths(
            AssetManager assets,
            String assetPath,
            String relativePath,
            Set<String> sink
    ) throws Exception {
        String[] children = assets.list(assetPath);
        if (children == null || children.length == 0) {
            if (!relativePath.isEmpty()) {
                sink.add(relativePath);
            }
            return;
        }
        for (String child : children) {
            String childRelativePath = relativePath.isEmpty() ? child : relativePath + "/" + child;
            collectAssetLeafPaths(assets, assetPath + "/" + child, childRelativePath, sink);
        }
    }

    private ModelDirectoryState inspectModelDirectory(Context context, File modelDir) throws Exception {
        Set<String> packagedFiles = listPackagedAssetFiles(context.getAssets());
        List<String> packagedMissing = new ArrayList<>();
        for (String fileName : REQUIRED_MODEL_FILES) {
            if (!packagedFiles.contains(fileName)) {
                packagedMissing.add(fileName);
            }
        }
        return new ModelDirectoryState(
                modelDir,
                defaultModelDir(context),
                packagedMissing.isEmpty(),
                packagedMissing,
                listMissingModelFiles(modelDir),
                false
        );
    }

    private ModelDirectoryState stagePackagedAssetsIfNeeded(
            Context context,
            File modelDir,
            boolean syncFromAssets
    ) throws Exception {
        ModelDirectoryState state = inspectModelDirectory(context, modelDir);
        boolean isDefaultTarget = modelDir.getAbsolutePath().equals(state.defaultModelDir.getAbsolutePath());
        boolean shouldSync = syncFromAssets
                && isDefaultTarget
                && state.packagedAssetsReady
                && !state.requiredFilesMissing.isEmpty();
        if (!shouldSync) {
            return state;
        }
        syncPackagedAssets(context.getAssets(), modelDir);
        state = inspectModelDirectory(context, modelDir);
        state.assetsSyncedAtLoad = true;
        return state;
    }

    private void syncPackagedAssets(AssetManager assets, File modelDir) throws Exception {
        Set<String> packagedFiles = listPackagedAssetFiles(assets);
        if (!modelDir.isDirectory() && !modelDir.mkdirs()) {
            throw new IllegalStateException("Cannot create model directory: " + modelDir);
        }
        byte[] buffer = new byte[1024 * 1024];
        for (String relativePath : packagedFiles) {
            File target = new File(modelDir, relativePath);
            File parent = target.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                throw new IllegalStateException("Cannot create model asset directory: " + parent);
            }
            try (InputStream input = assets.open(PACKAGED_MODEL_ASSET_DIR + "/" + relativePath);
                 OutputStream output = new FileOutputStream(target)) {
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    output.write(buffer, 0, read);
                }
            }
        }
        Log.i(TAG, "Packaged model assets synced to " + modelDir.getAbsolutePath());
    }

    private JSONArray toJsonArray(List<String> items) {
        JSONArray array = new JSONArray();
        for (String item : items) {
            array.put(item);
        }
        return array;
    }

    private void appendModelDirectoryState(JSONObject target, ModelDirectoryState state) {
        target.put("modelDir", state.modelDir.getAbsolutePath());
        target.put("defaultModelDir", state.defaultModelDir.getAbsolutePath());
        target.put("packagedAssetsReady", state.packagedAssetsReady);
        target.put("packagedAssetsMissing", toJsonArray(state.packagedAssetsMissing));
        target.put("requiredModelFiles", toJsonArray(REQUIRED_MODEL_FILES));
        target.put("requiredFilesMissing", toJsonArray(state.requiredFilesMissing));
        target.put("assetsSyncedAtLoad", state.assetsSyncedAtLoad);
    }

    private JSONObject safeNativeStatusJson() {
        try {
            return new JSONObject(nativeGetStatus());
        } catch (Throwable error) {
            Log.w(TAG, "Failed to parse native status JSON: " + error.getMessage());
            return null;
        }
    }

    private void appendRuntimeMetrics(JSONObject target, JSONObject status) {
        if (status == null) {
            return;
        }
        double latencyMs = status.optDouble("lastLatencyMs", Double.NaN);
        double tokensPerSecond = status.optDouble("lastTokensPerSecond", Double.NaN);
        int outputTokens = status.optInt("lastOutputTokens", -1);
        int promptTokens = status.optInt("lastPromptTokens", -1);
        double firstTokenLatencyMs = status.optDouble("firstTokenLatencyMs", Double.NaN);
        if (!Double.isNaN(latencyMs)) target.put("latencyMs", latencyMs);
        if (!Double.isNaN(tokensPerSecond)) target.put("tokensPerSecond", tokensPerSecond);
        if (outputTokens >= 0) target.put("outputTokens", outputTokens);
        if (promptTokens >= 0) target.put("promptTokens", promptTokens);
        if (!Double.isNaN(firstTokenLatencyMs)) target.put("firstTokenLatencyMs", firstTokenLatencyMs);
    }

    private JSONObject errorResult(String message, String code, JSONObject extras) {
        JSONObject result = new JSONObject();
        result.put("success", false);
        result.put("error", message);
        if (code != null && !code.isEmpty()) result.put("errorCode", code);
        if (extras != null) {
            Iterator<String> keys = extras.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                result.put(key, extras.get(key));
            }
        }
        return result;
    }

    private JSONObject errorResult(String message, String code) {
        return errorResult(message, code, null);
    }

    @UniJSMethod(uiThread = false)
    public void loadModel(JSONObject options, UniJSCallback callback) {
        try {
            ensureNativeLibs();
            if (!nativeInit()) {
                if (callback != null) callback.invoke(errorResult("Native runtime init failed", "MODEL_INIT_FAILED"));
                return;
            }
            Context context = requireContext();
            File modelDir = resolveModelDir(options, context);
            boolean syncFromAssets = options == null || options.optBoolean("syncFromAssets", true);
            ModelDirectoryState state = stagePackagedAssetsIfNeeded(context, modelDir, syncFromAssets);
            JSONObject diagnostics = new JSONObject();
            appendModelDirectoryState(diagnostics, state);
            if (!state.requiredFilesMissing.isEmpty()) {
                modelLoaded = false;
                String message = state.packagedAssetsReady
                        ? "Model files are incomplete under " + modelDir + ": " + state.requiredFilesMissing
                        : "Packaged model assets are incomplete. Run deps/stage_mnn_android_assets.ps1 before building the APK.";
                String code = state.packagedAssetsReady ? "MODEL_FILE_NOT_FOUND" : "MODEL_ASSETS_NOT_PACKAGED";
                if (callback != null) callback.invoke(errorResult(message, code, diagnostics));
                return;
            }
            boolean ok = nativeLoadModel(new File(modelDir, "config.json").getAbsolutePath());
            modelLoaded = ok;
            JSONObject nativeStatus = safeNativeStatusJson();
            JSONObject result = new JSONObject();
            result.put("success", ok);
            result.put("sme2Detected", nativeDetectSME2());
            appendModelDirectoryState(result, state);
            if (nativeStatus != null) result.put("runtimeStatus", nativeStatus);
            if (!ok) {
                result.put("errorCode", "MODEL_INIT_FAILED");
                String nativeError = nativeStatus == null ? "" : nativeStatus.optString("error", "");
                result.put("error", nativeError.isEmpty() ? "Native load returned false" : nativeError);
            }
            if (callback != null) callback.invoke(result);
        } catch (Throwable error) {
            Log.e(TAG, "loadModel error", error);
            if (callback != null) callback.invoke(errorResult("loadModel failed: " + error.getMessage(), "MODEL_INIT_FAILED"));
        }
    }

    @UniJSMethod(uiThread = false)
    public void generate(JSONObject options, UniJSCallback callback) {
        try {
            if (!modelLoaded) {
                if (callback != null) callback.invoke(errorResult("Model not loaded. Call loadModel first.", "MODEL_INIT_FAILED"));
                return;
            }
            String prompt = options == null ? "" : options.optString("prompt", "");
            if (prompt.trim().isEmpty()) {
                if (callback != null) callback.invoke(errorResult("prompt is required", "EMPTY_OUTPUT"));
                return;
            }
            int maxTokens = options.optInt("maxNewTokens", 512);
            float temperature = (float) options.optDouble("temperature", 0.2);
            float topP = (float) options.optDouble("topP", 0.8);
            String rawText = nativeGenerate(prompt, maxTokens, temperature, topP);
            JSONObject nativeStatus = safeNativeStatusJson();
            JSONObject result = new JSONObject();
            if (rawText.startsWith("ERROR:")) {
                result.put("success", false);
                result.put("error", rawText.substring("ERROR:".length()).trim());
            } else {
                result.put("success", true);
                result.put("text", rawText);
                appendRuntimeMetrics(result, nativeStatus);
            }
            if (nativeStatus != null) result.put("runtimeStatus", nativeStatus);
            if (callback != null) callback.invoke(result);
        } catch (Throwable error) {
            Log.e(TAG, "generate error", error);
            if (callback != null) callback.invoke(errorResult("generate failed: " + error.getMessage(), "UNKNOWN"));
        }
    }

    @UniJSMethod(uiThread = false)
    public void getRuntimeStatus(UniJSCallback callback) {
        try {
            ensureNativeLibs();
            Context context = requireContext();
            JSONObject nativeStatus = safeNativeStatusJson();
            String modelPath = nativeStatus == null ? "" : nativeStatus.optString("modelPath", "").trim();
            File inspectedModelDir = modelPath.isEmpty()
                    ? defaultModelDir(context)
                    : new File(modelPath).getParentFile();
            ModelDirectoryState state = inspectModelDirectory(context, inspectedModelDir);
            JSONObject result = new JSONObject();
            result.put("available", true);
            result.put("modelLoaded", modelLoaded);
            result.put("sme2Detected", nativeDetectSME2());
            appendModelDirectoryState(result, state);
            if (nativeStatus != null) {
                Iterator<String> keys = nativeStatus.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    result.put(key, nativeStatus.get(key));
                }
            }
            if (callback != null) callback.invoke(result);
        } catch (Throwable error) {
            Log.e(TAG, "getRuntimeStatus error", error);
            JSONObject result = new JSONObject();
            result.put("available", false);
            result.put("modelLoaded", false);
            result.put("error", "getRuntimeStatus failed: " + error.getMessage());
            if (callback != null) callback.invoke(result);
        }
    }

    @UniJSMethod(uiThread = false)
    public void releaseModel(UniJSCallback callback) {
        try {
            if (modelLoaded) {
                nativeRelease();
                modelLoaded = false;
            }
            JSONObject result = new JSONObject();
            result.put("success", true);
            result.put("message", "Model released");
            if (callback != null) callback.invoke(result);
        } catch (Throwable error) {
            Log.e(TAG, "releaseModel error", error);
            if (callback != null) callback.invoke(errorResult("releaseModel failed: " + error.getMessage(), "UNKNOWN"));
        }
    }

    private static final class ModelDirectoryState {
        final File modelDir;
        final File defaultModelDir;
        final boolean packagedAssetsReady;
        final List<String> packagedAssetsMissing;
        final List<String> requiredFilesMissing;
        boolean assetsSyncedAtLoad;

        ModelDirectoryState(
                File modelDir,
                File defaultModelDir,
                boolean packagedAssetsReady,
                List<String> packagedAssetsMissing,
                List<String> requiredFilesMissing,
                boolean assetsSyncedAtLoad
        ) {
            this.modelDir = modelDir;
            this.defaultModelDir = defaultModelDir;
            this.packagedAssetsReady = packagedAssetsReady;
            this.packagedAssetsMissing = packagedAssetsMissing;
            this.requiredFilesMissing = requiredFilesMissing;
            this.assetsSyncedAtLoad = assetsSyncedAtLoad;
        }
    }
}
