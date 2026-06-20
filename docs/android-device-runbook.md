# Android 端侧运行手册

目标：在 Android ARM64 设备上使用 Qwen2.5-0.5B-Instruct + MNN 进行纯本地 CPU 推理，并在设备支持时启用 Arm SME2 加速。

## 当前状态

截至 2026-06-20，代码和本地构建部分已经完成：

- Qwen2.5-0.5B-Instruct 已转换为 MNN 4bit，模型权重约 250.7 MB。
- Android NDK r27d、Clang 18、Ninja 均可用。
- `libMNN.so` 已按 `arm64-v8a` 编译，并确认包含 SME2/KleidiAI 内核符号。
- `libmnn_qwen_jni.so` 已完成交叉编译、链接和 SME2 运行时检测修正。
- 模型、MNN、JNI 和 `libc++_shared.so` 已放入 AAR 构建源。
- uni-app 的 APP 资源编译已通过，输出目录为 `frontend/dist/build/app`。
- `MnnQwenPlugin.aar` 已离线生成，且仅打包业务 class，没有把编译桩打入产物。
- HBuilderX 的 `nativeplugins` 发布目录只保留最终 AAR，避免模型和原生库重复上传。
- 前端类型检查通过，前端调用名与原生模块导出方法一致。

当前 AAR：

```text
frontend/nativeplugins/MnnQwenPlugin/android/libs/MnnQwenPlugin.aar
大小：237,690,176 bytes（约 226.68 MB）
SHA256：C13000E803605347A0B02A52228018963579074F349AC0FB14FB4560BC33DE02
```

完整 Android 插件构建源位于 `deps/mnn-qwen-android-plugin`；不要把该目录复制回 `frontend/nativeplugins`。

## 可重复构建

### 1. 重新构建 Android MNN/JNI 并放置资源

只有修改 MNN、JNI、NDK 参数或模型资源后才需要执行：

```powershell
cd D:\桌面\AGithub\ai-practice-aliyun\deps

.\build_mnn_android.ps1 `
  -NdkPath "D:\Users\32530\Downloads\android-ndk-r27d-windows\android-ndk-r27d"

.\stage_mnn_android_assets.ps1 -CleanTarget
```

不要传入 `-DisableSme2`，否则会关闭 SME2 内核构建。

### 2. 重新生成原生插件 AAR

此脚本使用 HBuilderX 自带的 Amazon Corretto JDK，不依赖 Android SDK、Gradle 或网络：

```powershell
cd D:\桌面\AGithub\ai-practice-aliyun\deps
powershell -ExecutionPolicy Bypass -File .\build_mnn_qwen_aar.ps1
```

### 3. 重新编译 uni-app 的 APP 资源

```powershell
cd D:\桌面\AGithub\ai-practice-aliyun\frontend
npm.cmd install
npm.cmd run type-check
npm.cmd run build:app
```

`npm.cmd install` 只需在依赖发生变化或首次拉取项目时执行。

## 还需手动完成

以下两项必须由你在账号或手机上操作，代码无法代替：

1. 登录 [DCloud 开发者中心](https://dev.dcloud.net.cn/pages/user/info)，为当前账号绑定手机号。
2. 在 HBuilderX 打开 `frontend/src/manifest.json` 的可视化配置，获取或绑定一个有效的 DCloud AppID。当前 `__UNI__STUDY_QUIZ_TOOL` 只能作为项目占位标识，不应直接用于正式云打包。
3. 用 USB 连接一台 ARM64 Android 手机，开启“开发者选项”和“USB 调试”，并在手机弹窗中允许此电脑调试。

完成后，在 PowerShell 中检查设备：

```powershell
& "D:\Users\32530\Downloads\HBuilderX.5.07.2026041006\HBuilderX\plugins\launcher-tools\tools\adbs\adb.exe" devices -l
```

必须看到一行状态为 `device`；若为 `unauthorized`，需要解锁手机并同意授权。

## HBuilderX 上机流程

1. 在 HBuilderX 中打开 `D:\桌面\AGithub\ai-practice-aliyun\frontend`。
2. 确认 `manifest.json` 已取得有效 AppID，并保留原生插件 `MnnQwenPlugin` 配置。
3. 选择“发行 -> 原生App-云打包”或制作自定义调试基座，将本地原生插件纳入 Android 包。
4. 只选择 `arm64-v8a`。首次验证建议使用测试证书；正式发布再配置自己的包名和签名证书。
5. 安装到手机后，先在联网状态验证安装与启动，再断网执行一次本地生成。

注意：普通标准基座不包含这个本地原生插件，必须使用包含 `MnnQwenPlugin.aar` 的自定义基座或 APK。AAR 自带约 250 MB 模型，若 DCloud 云打包提示插件或上传体积超限，需要改用 App 离线 SDK 宿主，或调整为首次安装后导入模型；不能通过删除模型来假装完成离线推理。

## 真机验证

查看插件日志：

```powershell
& "D:\Users\32530\Downloads\HBuilderX.5.07.2026041006\HBuilderX\plugins\launcher-tools\tools\adbs\adb.exe" logcat -s MnnQwenModule:V MnnQwenRunner:V MnnQwenJNI:V MNNJNI:V
```

查看设备 ABI 和 SME/SME2 暴露情况：

```powershell
& "D:\Users\32530\Downloads\HBuilderX.5.07.2026041006\HBuilderX\plugins\launcher-tools\tools\adbs\adb.exe" shell getprop ro.product.cpu.abi
& "D:\Users\32530\Downloads\HBuilderX.5.07.2026041006\HBuilderX\plugins\launcher-tools\tools\adbs\adb.exe" shell cat /proc/cpuinfo
```

最终完成标准：

- 手机断网后仍可加载 Qwen 模型并生成文本。
- 运行状态显示 Android 原生 MNN CPU，而不是 H5 Mock 或远程 API。
- `modelLoaded=true`，且模型文件不存在缺失项。
- 目标手机真实支持 SME2 时，运行状态显示 `sme2Supported=true` 和 `sme2Enabled=true`。
- 记录首 token 延迟、总延迟和 tokens/s，作为端侧演示数据。

如果设备不支持 SME2，应用仍可使用普通 ARM64 CPU 路径，但不能宣称已在该设备上启用 SME2。编译产物包含 SME2 内核和手机实际执行 SME2，是两项必须分别验证的事情。
