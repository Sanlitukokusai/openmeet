#!/usr/bin/env bash
# 大陆访问检查（规格书 §8.1 / §8.3 的机器可查部分）。有输出即失败，exit 1。
# WP-6 会把本脚本挂进 CI；本地随时可跑：bash scripts/check-china-safe.sh
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
DIRS=""
for d in app components lib src; do [ -d "$d" ] && DIRS="$DIRS $d"; done
if [ -z "$DIRS" ]; then echo "（尚无代码目录，跳过）"; exit 0; fi

echo "== §8.1 被屏蔽第三方资源（googleapis/gstatic/GA/GTM/Google Fonts/reCAPTCHA）=="
out=$(grep -rEn "googleapis|gstatic|google-analytics|googletagmanager|fonts\.google|recaptcha" \
  $DIRS --include="*.ts" --include="*.tsx" --include="*.js" --include="*.css" 2>/dev/null || true)
if [ -n "$out" ]; then echo "$out"; fail=1; else echo "OK"; fi

echo "== §8.3 浏览器直连 Supabase（createBrowserClient 禁用）=="
out=$(grep -rEn "createBrowserClient" $DIRS --include="*.ts" --include="*.tsx" 2>/dev/null || true)
if [ -n "$out" ]; then echo "$out"; fail=1; else echo "OK"; fi

echo "== §3.1 livekit-client / @livekit/track-processors 只许出现在 lib/media/providers/livekit/ =="
out=$(grep -rlnE "from '(livekit-client|@livekit/track-processors)'|from \"(livekit-client|@livekit/track-processors)\"" $DIRS 2>/dev/null | grep -v "^lib/media/providers/livekit/" || true)
if [ -n "$out" ]; then echo "$out"; fail=1; else echo "OK"; fi

if [ "$fail" -ne 0 ]; then
  echo "—— 检查未通过（详见上方输出）"; exit 1
fi
echo "—— 全部通过（§8.3 的运行时 Network 面板核验仍需在 WP-6 人工做一次）"
