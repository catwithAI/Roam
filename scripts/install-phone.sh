# scripts/install-phone.sh — 手机后端依赖，按平台自适应检测安装。
#   Linux → Android：确保 adb（platform-tools）。redroid 容器另由 scripts/android-redroid.sh 起。
#   macOS → iOS：确保 idb（点按/输入/读结构）+ adb（Mac 也能接 Android 真机）。
# 依赖编排器导出的 OS / 包管理助手（can_autoinstall / pkg_do / pkg_cmd）与 head2/info/step/warn。
# shellcheck shell=bash

# 确保 adb（Android 真机 / 远程 redroid 都靠它）。
phone_adb() {
    if command -v adb &>/dev/null; then
        info "adb 已就绪（$(adb version 2>/dev/null | head -1)）"
        return 0
    fi
    if can_autoinstall; then
        step "安装 adb（platform-tools）..."
        pkg_do adb 2>/dev/null || pkg_do android-tools 2>/dev/null || pkg_do android-platform-tools 2>/dev/null || true
    fi
    if command -v adb &>/dev/null; then
        info "adb 已安装"
    else
        warn "未装 adb —— 手动：$(pkg_cmd adb 2>/dev/null || echo '安装 Android SDK platform-tools')"
    fi
}

# 确保 idb（iOS 模拟器点按/输入/读结构；仅 macOS）。
phone_idb() {
    command -v xcrun &>/dev/null || warn "未检测到 Xcode 命令行工具（iOS 需要）：xcode-select --install"
    if command -v idb &>/dev/null; then
        info "idb 已就绪"
        return 0
    fi
    if command -v brew &>/dev/null; then
        step "安装 idb-companion（brew）..."
        brew install idb-companion >/dev/null 2>&1 || warn "idb-companion 安装失败，手动：brew install idb-companion"
    else
        warn "未装 Homebrew，无法自动装 idb-companion（https://brew.sh）"
    fi
    if command -v pip3 &>/dev/null; then
        step "安装 fb-idb（pip3）..."
        pip3 install --user fb-idb >/dev/null 2>&1 || warn "fb-idb 安装失败，手动：pip3 install fb-idb"
    else
        warn "未装 pip3，无法自动装 fb-idb"
    fi
    command -v idb &>/dev/null && info "idb 已安装" || warn "idb 未就绪 —— 手动：brew install idb-companion && pip3 install fb-idb"
}

module_phone() {
    head2 "手机后端依赖（自适应，可选）"
    if [[ "${OS:-}" == mac ]]; then
        info "平台 macOS → 默认 iOS 模拟器（也支持接 Android 真机）"
        phone_idb
        phone_adb
    else
        info "平台 Linux → 默认 Android（本地 redroid）"
        phone_adb
        info "起本地 Android：bash scripts/android-redroid.sh up（需 Docker + 内核 binder）"
    fi
}
