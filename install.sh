#!/bin/bash
# 从 GitHub 最新 release 安装 doorman：下载二进制与校验和，核对 sha256 后
# 交给 doorman install 完成配置与 launchd 注册。不需要本地仓库。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/adaex/doorman/main/install.sh | bash
#   参数原样传给 doorman install，例如：
#   curl -fsSL .../install.sh | bash -s -- --roots "$HOME/code,$HOME/work"
set -euo pipefail

base="https://github.com/adaex/doorman/releases/latest/download"
tmp="$(mktemp -t doorman)"
trap 'rm -f "$tmp" "$tmp.sums"' EXIT

curl -fsSL "$base/doorman" -o "$tmp"
curl -fsSL "$base/SHA256SUMS" -o "$tmp.sums"

expected="$(awk '$2 == "doorman" {print $1}' "$tmp.sums")"
actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "sha256 校验失败：下载内容与 SHA256SUMS 不符，已中止安装" >&2
    exit 1
fi

chmod +x "$tmp"
exec "$tmp" install "$@"
