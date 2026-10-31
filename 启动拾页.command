#!/bin/zsh -l
cd -- "${0:A:h}" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  print "需要 Node.js 22 或更新版本，请先安装 Node.js。"
  read "reply?按回车关闭…"
  exit 1
fi
if [[ ! -d node_modules ]]; then
  npm ci || exit 1
fi
npm run start:open
