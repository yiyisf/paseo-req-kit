#!/bin/sh
# req-kit one-step installer for macOS, Linux and Windows (Git Bash / WSL).
#
#   curl -fsSL https://paseo-req-kit.vercel.app/install.sh | sh
#
# The same as `npx -y paseo-req-kit@latest install` (1.13): this script only checks Node.js
# and npm, picks the version (from npm, or the GitHub Release .tgz when npm does not have it)
# and runs that version's own installer (bin/bootstrap.mjs) with npm exec. Inside a company
# network with only an npm mirror, the npx command alone is enough:
#   npx -y --registry=https://npm.example.internal/ paseo-req-kit@latest install
#
# Options (after `sh -s --` when piped):
#   --beta               also consider beta versions
#   --version <v>        install this version, e.g. 1.9.1
#   --from npm|release   where to get it: the npm registry, or the GitHub Release .tgz
#                        (default: npm, falling back to the Release when npm does not have it)
#   --registry <url>     use this npm registry (e.g. a company mirror) and save it for this machine
#   --no-save-registry   use --registry for this install only
#   --no-configure       skip the agent configuration wizard
#   --skip-paseo         do not check, install or start Paseo
#   --with-plugin        install the req-kit plugin for Paseo without asking (turns on Paseo's plugins)
#   --no-plugin          do not offer the plugin
#   --help
# On Windows PowerShell use install.ps1 instead.

set -eu

REPO="yiyisf/paseo-req-kit"
PKG="paseo-req-kit"
VERSION=""
CHANNEL="latest"
FROM="auto"
REGISTRY=""
PASS=""

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() {
  printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'HELP'
用法：curl -fsSL https://paseo-req-kit.vercel.app/install.sh | sh -s -- [选项]
（等同于 npx -y paseo-req-kit@latest install；公司内网只有 npm 镜像时直接用：
  npx -y --registry=<镜像地址> paseo-req-kit@latest install）

  --beta               也考虑 beta 版
  --version <版本>     安装指定版本，例如 1.9.1
  --from npm|release   从 npm 安装，或从 GitHub Release 的安装包安装（默认先 npm，没有再用 Release）
  --registry <地址>    使用这个 npm 源（例如公司的 npm 镜像），并保存为本机的 npm 源
  --no-save-registry   只在这次安装中使用 --registry，不保存
  --no-configure       不运行选择 agent 的配置向导
  --skip-paseo         不检查、不安装、不启动 Paseo
  --with-plugin        不询问，直接安装 Paseo 的 req-kit 插件（会打开 Paseo 的插件总开关）
  --no-plugin          不安装、也不询问 Paseo 插件
  -h, --help           显示这段说明

没有 Paseo 时会安装 Paseo 的命令行版本（@getpaseo/cli），开启它自带的网页界面并启动 daemon。

再次运行即升级。Windows PowerShell 请用 install.ps1。
HELP
}

while [ $# -gt 0 ]; do
  case "$1" in
    --beta) CHANNEL="beta" ;;
    --version)
      [ $# -ge 2 ] || die "--version 后面要写版本号，例如 --version 1.9.1"
      VERSION="${2#v}"
      shift
      ;;
    --version=*) VERSION="${1#--version=}" && VERSION="${VERSION#v}" ;;
    --from)
      [ $# -ge 2 ] || die "--from 后面要写 npm 或 release"
      FROM="$2"
      shift
      ;;
    --from=*) FROM="${1#--from=}" ;;
    --registry)
      [ $# -ge 2 ] || die "--registry 后面要写地址，例如 --registry https://npm.example.internal/"
      REGISTRY="$2"
      shift
      ;;
    --registry=*) REGISTRY="${1#--registry=}" ;;
    --no-save-registry | --no-configure | --skip-paseo | --with-plugin | --no-plugin) PASS="$PASS $1" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "不认识的选项：$1（--help 查看用法）" ;;
  esac
  shift
done

case "$FROM" in auto | npm | release) ;; *) die "--from 只能是 npm 或 release" ;; esac

say "安装 req-kit：Paseo 上的需求开发体系"

# ---------------------------------------------------------------------------
step "检查环境"

command -v node >/dev/null 2>&1 || die "没有找到 Node.js。请先安装 Node.js 22 或更新版本：https://nodejs.org"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || die "需要 Node.js 22 或更新版本，当前是 $(node -v)。请升级：https://nodejs.org"
ok "Node.js $(node -v)"

# Tests point REQ_KIT_NPM at a script standing in for npm.
npm_() {
  if [ -n "${REQ_KIT_NPM:-}" ]; then node "$REQ_KIT_NPM" "$@"; else npm "$@"; fi
}
if [ -z "${REQ_KIT_NPM:-}" ]; then
  command -v npm >/dev/null 2>&1 || die "没有找到 npm（通常随 Node.js 一起安装）"
fi
ok "npm $(npm_ --version 2>/dev/null || echo '?')"
if [ -n "$REGISTRY" ]; then
  # For the lookups below and npm exec; the installer saves it (unless --no-save-registry).
  npm_config_registry="$REGISTRY"
  export npm_config_registry
  PASS="$PASS --registry $REGISTRY"
  ok "npm 源：$REGISTRY"
fi

# ---------------------------------------------------------------------------
step "确定要安装的版本"

SOURCE=""
if [ "$FROM" != "release" ]; then
  SPEC="${VERSION:-$CHANNEL}"
  if FOUND=$(npm_ view "$PKG@$SPEC" version 2>/dev/null) && [ -n "$FOUND" ]; then
    FOUND=$(printf '%s\n' "$FOUND" | tail -n 1 | tr -d "'\" ")
    if [ -z "$VERSION" ] && [ "$CHANNEL" = "beta" ]; then
      # The beta tag can lag behind the release that followed it (1.8.0-beta.3 < 1.8.0).
      STABLE=$(npm_ view "$PKG@latest" version 2>/dev/null | tail -n 1 | tr -d "'\" " || true)
      if [ -n "$STABLE" ]; then
        FOUND=$(node -e '
          const key = (v) => { const [core, pre] = v.split("-"); return [...core.split(".").map(Number), pre === undefined ? Infinity : 0, pre || ""]; };
          const cmp = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return x[4].localeCompare(y[4], "en", { numeric: true }); };
          const [a, b] = process.argv.slice(1);
          console.log(cmp(a, b) >= 0 ? a : b);' "$FOUND" "$STABLE")
      fi
    fi
    SOURCE="$PKG@$FOUND"
    ok "npm 上的 $PKG@$FOUND"
  elif [ -n "$REGISTRY" ] && [ "$FROM" = "auto" ]; then
    # A company mirror usually means GitHub is out of reach: say so instead of trying it.
    die "npm 源 $REGISTRY 上没有找到 $PKG@$SPEC。镜像可能还没有同步，稍后再试"
  elif [ "$FROM" = "npm" ]; then
    die "npm 上没有找到 $PKG@$SPEC。可以去掉 --from npm，改用 GitHub Release 的安装包"
  else
    warn "npm 上没有找到 $PKG@$SPEC，改用 GitHub Release 的安装包"
  fi
fi

if [ -z "$SOURCE" ]; then
  # GitHub Releases: the newest release (a beta only with --beta, or when there is no
  # other), or the one asked for. Tests point REQ_KIT_RELEASES_JSON at a local file.
  if [ -n "${REQ_KIT_RELEASES_JSON:-}" ]; then
    RELEASES=$(cat "$REQ_KIT_RELEASES_JSON")
  elif command -v curl >/dev/null 2>&1; then
    RELEASES=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30") || die "无法读取 GitHub Release 列表"
  elif command -v wget >/dev/null 2>&1; then
    RELEASES=$(wget -qO- "https://api.github.com/repos/$REPO/releases?per_page=30") || die "无法读取 GitHub Release 列表"
  else
    die "需要 curl 或 wget 来下载安装包"
  fi
  # shellcheck disable=SC2016 # the single-quoted text is JavaScript for node, not shell
  PICK=$(printf '%s' "$RELEASES" | WANT="$VERSION" CHANNEL="$CHANNEL" node -e '
    let text = "";
    process.stdin.on("data", (c) => (text += c)).on("end", () => {
      const releases = JSON.parse(text).filter((r) => !r.draft);
      const asset = (r) => (r.assets || []).find((a) => /\.tgz$/.test(a.name));
      const usable = releases.filter(asset);
      const want = process.env.WANT;
      let r;
      if (want) r = usable.find((x) => x.tag_name.replace(/^v/, "") === want);
      else r = usable.find((x) => process.env.CHANNEL === "beta" || !x.prerelease) || usable[0];
      if (!r) process.exit(1);
      console.log(`${r.tag_name.replace(/^v/, "")} ${r.prerelease ? "beta" : "stable"} ${asset(r).browser_download_url}`);
    });
  ') || die "GitHub Release 中没有找到${VERSION:+ $VERSION 的}安装包（https://github.com/$REPO/releases）"
  PICK_VERSION=${PICK%% *}
  PICK_URL=${PICK##* }
  SOURCE="$PICK_URL"
  case "$PICK" in
    *" beta "*) [ "$CHANNEL" = "beta" ] || [ -n "$VERSION" ] || warn "还没有正式版，安装最新的 beta 版" ;;
  esac
  ok "GitHub Release 中的 $PICK_VERSION"
fi

# ---------------------------------------------------------------------------
# The rest (install, Paseo, setup, agents, plugin) is the chosen version's own installer.
# Older versions (before 1.13) have none: install them with this script from their own tag.
# shellcheck disable=SC2086 # PASS holds separate options
npm_ exec --yes --package="$SOURCE" -- paseo-req-kit install --spec "$SOURCE" $PASS
