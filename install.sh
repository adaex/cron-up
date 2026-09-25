#!/bin/bash
# 从 GitHub 最新 release 安装 doorman：用 gh 下载二进制与校验和（仓库是
# 私有的，匿名下载只会拿到 404），核对 sha256 后交给 doorman install 完成
# 配置与 launchd 注册。不需要本地仓库。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/adaex/doorman/main/install.sh | bash
#   参数原样传给 doorman install，例如：
#   curl -fsSL .../install.sh | bash -s -- --roots "$HOME/code,$HOME/work"
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
    echo "需要 GitHub CLI：brew install gh 后运行 gh auth login" \
        "（release 下载走 gh 的登录态）" >&2
    exit 1
fi

tmp="$(mktemp -d -t doorman)"
trap 'rm -rf "$tmp"' EXIT

gh release download --repo adaex/doorman \
    --pattern doorman --pattern SHA256SUMS --dir "$tmp" --clobber \
    || { echo "下载失败：gh 未登录或网络不可达" >&2; exit 1; }

expected="$(awk '$2 == "doorman" {print $1}' "$tmp/SHA256SUMS")"
actual="$(shasum -a 256 "$tmp/doorman" | awk '{print $1}')"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "sha256 校验失败：下载内容与 SHA256SUMS 不符，已中止安装" >&2
    exit 1
fi

chmod +x "$tmp/doorman"
exec "$tmp/doorman" install "$@"
