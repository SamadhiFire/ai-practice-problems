cmake_minimum_required(VERSION 3.18)
project(mnn_qwen_jni LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(CheckCXXCompilerFlag)

option(MNN_QWEN_ENABLE_SME2 "Compile JNI bridge with SME2 flags when the compiler supports them" ON)

# -------------------------------------------------------------------------- #
#  MNN 路径配置
#
#  比赛版编译时设置 MNN_ROOT 指向 MNN 预编译库或源码目录:
#   cmake -DMNN_ROOT=/path/to/MNN ...
#
#  MNN 预编译库目录结构要求:
#   ${MNN_ROOT}/
#     include/            # MNN C++ headers
#     include/MNN/
#     transformers/llm/include/  # MNN LLM headers (llm.hpp)
#     libs/arm64-v8a/     # libMNN.so (includes Express + LLM)
# -------------------------------------------------------------------------- #
if(NOT DEFINED MNN_ROOT)
    set(MNN_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../deps/mnn-android-sdk"
        CACHE PATH "Path to MNN SDK root (include/ + libs/arm64-v8a/)")
endif()

file(TO_CMAKE_PATH "${MNN_ROOT}" MNN_ROOT)

set(MNN_INCLUDE_DIRS
    "${MNN_ROOT}/include"
    "${MNN_ROOT}/include/MNN"
    "${MNN_ROOT}/transformers/llm/include"
)

set(MNN_LIBS_DIR "${MNN_ROOT}/libs/${ANDROID_ABI}")

message(STATUS "[mnn_qwen_jni] MNN_ROOT = ${MNN_ROOT}")
message(STATUS "[mnn_qwen_jni] MNN_INCLUDE_DIRS = ${MNN_INCLUDE_DIRS}")
message(STATUS "[mnn_qwen_jni] MNN_LIBS_DIR = ${MNN_LIBS_DIR}")

foreach(required_dir IN LISTS MNN_INCLUDE_DIRS)
    if(NOT EXISTS "${required_dir}")
        message(FATAL_ERROR
            "[mnn_qwen_jni] Missing required include directory: ${required_dir}\n"
            "Run deps/build_mnn_android.ps1 first, or set MNN_ROOT to deps/mnn-android-sdk.")
    endif()
endforeach()

if(NOT EXISTS "${MNN_LIBS_DIR}")
    message(FATAL_ERROR
        "[mnn_qwen_jni] Missing library directory: ${MNN_LIBS_DIR}\n"
        "Run deps/build_mnn_android.ps1 first, or set MNN_ROOT to deps/mnn-android-sdk.")
endif()

# -------------------------------------------------------------------------- #
#  源文件
# -------------------------------------------------------------------------- #
set(SOURCES
    MnnQwenRunner.cpp
    mnn_qwen_jni.cpp
)

add_library(${PROJECT_NAME} SHARED ${SOURCES})

# -------------------------------------------------------------------------- #
#  Include 路径
# -------------------------------------------------------------------------- #
target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${MNN_INCLUDE_DIRS}
)

# -------------------------------------------------------------------------- #
#  链接 MNN 预编译库
# -------------------------------------------------------------------------- #
find_library(MNN_LIB NAMES MNN PATHS "${MNN_LIBS_DIR}" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)

if(NOT MNN_LIB)
    message(FATAL_ERROR
        "[mnn_qwen_jni] Failed to resolve libMNN.so under ${MNN_LIBS_DIR}\n"
        "Run deps/build_mnn_android.ps1 to build the monolithic MNN + Express + LLM library.")
endif()

target_link_libraries(${PROJECT_NAME}
    ${MNN_LIB}
    android
    log
    ${CMAKE_DL_LIBS}
)

# -------------------------------------------------------------------------- #
#  编译选项
# -------------------------------------------------------------------------- #
target_compile_options(${PROJECT_NAME} PRIVATE
    -Wall
    -Wextra
    -O2
    -fvisibility=hidden
    -fexceptions
    -frtti
)

if(MNN_QWEN_ENABLE_SME2)
    check_cxx_compiler_flag("-march=armv8.6-a+sme2" MNN_QWEN_HAS_SME2_FLAG)
    if(MNN_QWEN_HAS_SME2_FLAG)
        target_compile_options(${PROJECT_NAME} PRIVATE -march=armv8.6-a+sme2)
        target_compile_definitions(${PROJECT_NAME} PRIVATE MNN_QWEN_ENABLE_SME2_COMPILE_FLAG=1)
        message(STATUS "[mnn_qwen_jni] SME2 compile flag enabled")
    else()
        message(WARNING
            "[mnn_qwen_jni] Compiler does not support -march=armv8.6-a+sme2. "
            "Continuing without the explicit SME2 compile flag.")
    endif()
endif()
