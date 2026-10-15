#!/bin/sh
# req-kit one-step installer for macOS, Linux and Windows (Git Bash / WSL).
#
#   curl -fsSL https://paseo-req-kit.vercel.app/install.sh | sh
#
# Options (after `sh -s --` when piped):
#   --beta               also consider beta versions
#   --version <v>        install this version, e.g. 1.8.0
#   --from npm|release   where to get it: the npm registry, or the GitHub Release .tgz
#                        (default: npm, falling back to the Release when npm does not have it)
#   --no-configure       skip the agent configuration wizard
#   --skip-paseo         do not check, install or start Paseo
#   --help
#
# What it does: checks Node.js 22+, installs the paseo-req-kit package globally with npm
# (into ~/.req-kit/npm when the global npm directory is not writable); makes sure Paseo is
# there: installs the Paseo CLI in the version range req-kit supports when there is neither
# a paseo command nor a running daemon, turns on the daemon's built-in web UI and starts the
# daemon; then runs `req setup` (installs the version under ~/tools/req-kit/versions and the
# /req skills for your agents) and `req configure` to choose the agents. Running it again
# upgrades in place.
# On Windows PowerShell use install.ps1 instead.

set -eu

REPO="yiyisf/paseo-req-kit"
PKG="paseo-req-kit"
VERSION=""
CHANNEL="latest"
FROM="auto"
CONFIGURE=1
PASEO_STEP=1

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

  --beta               也考虑 beta 版
  --version <版本>     安装指定版本，例如 1.8.0
  --from npm|release   从 npm 安装，或从 GitHub Release 的安装包安装（默认先 npm，没有再用 Release）
  --no-configure       不运行选择 agent 的配置向导
  --skip-paseo         不检查、不安装、不启动 Paseo
  -h, --help           显示这段说明

没有 Paseo 时会安装 Paseo 的命令行版本（@getpaseo/cli），开启它自带的网页界面并启动 daemon。

再次运行即升级。Windows PowerShell 请用 install.ps1。
HELP
}

while [ $# -gt 0 ]; do
  case "$1" in
    --beta) CHANNEL="beta" ;;
    --version)
      [ $# -ge 2 ] || die "--version 后面要写版本号，例如 --version 1.8.0"
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
    --no-configure) CONFIGURE=0 ;;
    --skip-paseo) PASEO_STEP=0 ;;
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

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | sed 's/git version //')"
else
  warn "没有找到 git：流水线需要在 git 仓库中工作，请稍后安装"
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
step "安装 $PKG"

PREFIX=$(npm_ prefix -g 2>/dev/null || true)
OWN_PREFIX=0
if [ -z "$PREFIX" ] || { [ "$(id -u 2>/dev/null || echo 1)" != "0" ] && [ ! -w "$PREFIX" ]; }; then
  # A system Node.js (e.g. /usr/local) needs sudo for global installs; use a directory of our own.
  PREFIX="$HOME/.req-kit/npm"
  OWN_PREFIX=1
  mkdir -p "$PREFIX"
  warn "npm 的全局目录不可写，改装到 $PREFIX（不需要 sudo）"
fi
if [ "$OWN_PREFIX" = "1" ]; then
  npm_ install -g --prefix "$PREFIX" "$SOURCE" || die "npm 安装失败（见上面的输出）"
  ROOT=$(npm_ root -g --prefix "$PREFIX")
else
  npm_ install -g "$SOURCE" || die "npm 安装失败（见上面的输出）"
  ROOT=$(npm_ root -g)
fi
REQ_MJS="$ROOT/$PKG/bin/req.mjs"
[ -f "$REQ_MJS" ] || die "安装后没有找到 $REQ_MJS"
ok "已安装到 $ROOT/$PKG"

run_req() { node "$REQ_MJS" "$@"; }

BIN_DIR=$(dirname "$(dirname "$ROOT")")/bin
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW* | MSYS* | CYGWIN*) BIN_DIR=$(dirname "$ROOT") ;;
esac

# ---------------------------------------------------------------------------
# Paseo: req-kit runs on a Paseo daemon on this machine. Tests set REQ_KIT_PASEO_BIN to the
# paseo command to find (an empty or missing path: none) and REQ_KIT_PASEO_URL to a fake daemon.
DAEMON_URL="${REQ_KIT_PASEO_URL:-http://127.0.0.1:6767}"
PASEO_CMD=""
paseo_() { "$PASEO_CMD" "$@"; }
daemon_up() {
  # Any HTTP answer (even 401 with a password set) means a daemon is listening.
  node -e 'fetch(process.argv[1] + "/api/status", { signal: AbortSignal.timeout(3000) }).then(() => process.exit(0), () => process.exit(1))' "$DAEMON_URL" 2>/dev/null
}
daemon_version() {
  node -e 'fetch(process.argv[1] + "/api/status", { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).then((j) => console.log(j.version || ""), () => console.log(""))' "$DAEMON_URL" 2>/dev/null
}
web_ui() {
  if paseo_ daemon config get features.webUi.enabled 2>/dev/null | grep -q true; then
    ok "Paseo 网页界面已开启"
    return 1
  fi
  if paseo_ daemon config set features.webUi.enabled true >/dev/null 2>&1; then
    ok "已开启 Paseo 自带的网页界面（features.webUi.enabled）"
    return 0
  fi
  warn "没能开启 Paseo 的网页界面，之后可以运行：paseo daemon config set features.webUi.enabled true"
  return 1
}

if [ "$PASEO_STEP" = "1" ]; then
  step "检查 Paseo"
  PASEO_RANGE=$(node -p "require(process.argv[1]).reqKit.paseo" "$ROOT/$PKG/package.json")
  PASEO_MINOR=$(node -p "(/(\d+\.\d+)/.exec(process.argv[1]) || [])[1] || ''" "$PASEO_RANGE")
  if [ "${REQ_KIT_PASEO_BIN+set}" = "set" ]; then
    if [ -n "$REQ_KIT_PASEO_BIN" ] && [ -x "$REQ_KIT_PASEO_BIN" ]; then PASEO_CMD=$REQ_KIT_PASEO_BIN; fi
  elif command -v paseo >/dev/null 2>&1; then
    PASEO_CMD=$(command -v paseo)
  fi

  if [ -z "$PASEO_CMD" ] && daemon_up; then
    # The desktop app runs its own daemon and does not put the paseo command on PATH.
    V=$(daemon_version)
    ok "Paseo daemon 已在运行${V:+（$V）}，没有 paseo 命令（通常是桌面版 Paseo 管理的 daemon）"
    warn "需要网页界面时，在桌面版的设置中开启，或安装 Paseo 命令行后运行 paseo daemon config set features.webUi.enabled true"
  else
    if [ -z "$PASEO_CMD" ]; then
      say "  没有找到 Paseo，安装 Paseo $PASEO_MINOR 系列的最新版（@getpaseo/cli@~$PASEO_MINOR.0，这个版本的 req-kit 支持 $PASEO_RANGE）"
      if [ "$OWN_PREFIX" = "1" ]; then
        npm_ install -g --prefix "$PREFIX" "@getpaseo/cli@~$PASEO_MINOR.0" || die "Paseo 安装失败（见上面的输出）。也可以按 https://paseo.sh 的说明自己安装后重新运行这个脚本"
      else
        npm_ install -g "@getpaseo/cli@~$PASEO_MINOR.0" || die "Paseo 安装失败（见上面的输出）。也可以按 https://paseo.sh 的说明自己安装后重新运行这个脚本"
      fi
      PASEO_CMD="$BIN_DIR/paseo"
      [ -x "$PASEO_CMD" ] || [ -x "$PASEO_CMD.cmd" ] || PASEO_CMD=$(command -v paseo 2>/dev/null || echo "$BIN_DIR/paseo")
      ok "已安装 Paseo"
    fi
    V=$(paseo_ --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)
    if [ -n "$V" ]; then
      case "$V" in
        "$PASEO_MINOR".*) ok "Paseo $V" ;;
        *) warn "Paseo 是 $V，这个版本的 req-kit 支持 $PASEO_RANGE。请换成匹配的 Paseo，或用 req upgrade 选择支持它的 req-kit" ;;
      esac
    fi
    CHANGED=0
    if web_ui; then CHANGED=1; fi
    if daemon_up; then
      if [ "$CHANGED" = "1" ]; then
        warn "Paseo daemon 正在运行，网页界面要在重启后生效：paseo daemon restart（会中断正在运行的 agent，方便时再重启）"
      else
        ok "Paseo daemon 正在运行"
      fi
    elif paseo_ daemon start >/dev/null 2>&1; then
      # Wait for it to answer: the wizard below asks the daemon for the agents.
      i=0
      while [ "$i" -lt "${REQ_KIT_PASEO_WAIT:-15}" ] && ! daemon_up; do
        sleep 1
        i=$((i + 1))
      done
      ok "已启动 Paseo daemon"
    else
      warn "没能启动 Paseo daemon，请运行 paseo daemon start 查看原因"
    fi
    say "  Paseo 网页界面：$DAEMON_URL/"
  fi

  FOUND_AGENT=""
  for a in claude codex opencode pi copilot; do
    if command -v "$a" >/dev/null 2>&1; then FOUND_AGENT="$FOUND_AGENT $a"; fi
  done
  if [ -n "$FOUND_AGENT" ]; then
    ok "agent 命令行：$FOUND_AGENT"
  else
    warn "没有找到任何 agent 命令行（Claude Code、Codex、OpenCode、Pi、Copilot）。Paseo 要用它们干活：至少装一个并登录，再运行 req configure"
  fi
fi


# ---------------------------------------------------------------------------
step "启用这个版本，安装 /req 等 skill"

CONFIG="${REQ_KIT_HOME:-$HOME/.req-kit}/config.json"
if ! run_req setup; then
  # On a new machine setup ends with "fill in the agents" (✗), which the wizard below does.
  if ! { [ -f "$CONFIG" ] && grep -q "CHANGE-ME" "$CONFIG" 2>/dev/null; }; then
    die "req setup 没有完成（见上面的输出）。修复后可以重新运行这个脚本"
  fi
fi

# ---------------------------------------------------------------------------
if [ "$CONFIGURE" = "1" ] && [ -f "$CONFIG" ] && grep -q "CHANGE-ME" "$CONFIG" 2>/dev/null; then
  step "选择 agent"
  # Piped into sh, stdin is the script: read the answers from the terminal.
  if [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; then
    if run_req configure </dev/tty; then
      run_req check || true
    else
      warn "配置向导没有完成，之后可以运行 req configure"
    fi
  else
    warn "没有可交互的终端，跳过配置向导。之后运行：req configure"
  fi
fi

# ---------------------------------------------------------------------------
step "完成"

FOUND_REQ=$(command -v req 2>/dev/null || true)
case "$FOUND_REQ" in
  "$BIN_DIR"/req | "$BIN_DIR"/req.cmd) ok "req 命令可用：$FOUND_REQ" ;;
  "")
    warn "req 命令还不在 PATH 中。把下面这行加到 ~/.bashrc 或 ~/.zshrc，然后重新打开终端："
    say "      export PATH=\"$BIN_DIR:\$PATH\""
    ;;
  *)
    warn "PATH 中的 req 是 $FOUND_REQ，不是刚装的这个；可以改用同名命令 req-kit，或把 $BIN_DIR 放到 PATH 的前面"
    ;;
esac
run_req version || true

say ""
say "下一步："
say "  1. 运行 req doctor 检查 Paseo daemon 和 agent 是否就绪；在浏览器打开 $DAEMON_URL/ 就是 Paseo 的网页界面"
say "  2. 在项目的 Paseo 对话中运行 /req-setup 接入项目（每个项目一次）"
say "  3. 在 Paseo 对话中输入 /req 和一句话需求，例如：/req 登录页增加短信验证码登录"
say "文档：https://paseo-req-kit.vercel.app/"
