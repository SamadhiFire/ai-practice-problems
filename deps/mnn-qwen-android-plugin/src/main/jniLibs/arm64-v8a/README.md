# Android arm64-v8a native libraries

This directory receives the native libraries packaged by the Android plugin.

| File | Purpose | Source |
| --- | --- | --- |
| `libMNN.so` | Monolithic MNN runtime including Express and LLM | `deps/build_mnn_android.ps1` |
| `libc++_shared.so` | NDK shared C++ runtime | Android NDK |
| `libmnn_qwen_jni.so` | JNI bridge | Built automatically by the plugin CMake project |

Build and copy the required prebuilt libraries with:

```powershell
cd deps
.\build_mnn_android.ps1 -NdkPath "<android-ndk-root>"
```

The script enables `MNN_BUILD_LLM`, builds the monolithic `libMNN.so`, and copies it here.
