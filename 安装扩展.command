#!/bin/bash
# 一键安装辅助：把扩展复制到稳定位置，并打开 chrome://extensions
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/社媒采集助手"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC" "$DEST/extension"
echo "=============================================="
echo "扩展已就位：$DEST/extension"
echo ""
echo "接下来在 Chrome 里做 3 步："
echo "  1) 打开右上角【开发者模式】开关"
echo "  2) 点【加载已解压的扩展程序】"
echo "  3) 选择上面的文件夹  extension"
echo "（也可以直接把文件夹拖进 chrome://extensions 页面）"
echo "=============================================="
sleep 1

CHROME=""
for name in "/Applications/Google Chrome.app" /Applications/Google\ Chrome*.app /Applications/Microsoft\ Edge.app; do
  if [ -d "$name" ]; then CHROME="$name"; break; fi
done
if [ -n "$CHROME" ]; then
  open -a "$CHROME" "chrome://extensions" 2>/dev/null || open "chrome://extensions"
else
  open "chrome://extensions"
fi
