# req-kit one-step installer for Windows PowerShell.
#
#   irm https://paseo-req-kit.vercel.app/install.ps1 | iex
#
# Piped into iex it is not a script file, so the execution policy does not block it.
# Options: set them as variables before the command, e.g.
#   $ReqKitBeta = $true; irm .../install.ps1 | iex
#   $ReqKitVersion = "1.8.0"; irm .../install.ps1 | iex
#   $ReqKitFrom = "release"     # npm | release (default: npm, falling back to the Release)
#   $ReqKitNoConfigure = $true  # skip the agent configuration wizard
#   $ReqKitSkipPaseo = $true    # do not check, install or start Paseo
#
# Same steps as install.sh: check Node.js 22+, npm install -g paseo-req-kit (from npm or the
# GitHub Release .tgz); make sure Paseo is there (install the Paseo CLI in the range req-kit
# supports when there is neither a paseo command nor a running daemon, turn on its web UI,
# start the daemon); req setup, req configure. Running it again upgrades in place.

& {
  # Not "Stop": in Windows PowerShell 5.1 a native command writing to stderr would then abort.
  # Every step checks its own result instead.
  $ErrorActionPreference = "Continue"
  $Repo = "yiyisf/paseo-req-kit"
  $Pkg = "paseo-req-kit"
  $Beta = [bool](Get-Variable -Name ReqKitBeta -ValueOnly -ErrorAction SilentlyContinue)
  $Version = [string](Get-Variable -Name ReqKitVersion -ValueOnly -ErrorAction SilentlyContinue)
  $From = [string](Get-Variable -Name ReqKitFrom -ValueOnly -ErrorAction SilentlyContinue)
  $NoConfigure = [bool](Get-Variable -Name ReqKitNoConfigure -ValueOnly -ErrorAction SilentlyContinue)
  $SkipPaseo = [bool](Get-Variable -Name ReqKitSkipPaseo -ValueOnly -ErrorAction SilentlyContinue)
  if (-not $From) { $From = "auto" }
  $Version = $Version.TrimStart("v")

  function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor White }
  function Ok($text) { Write-Host "  [ok] $text" -ForegroundColor Green }
  function Warn($text) { Write-Host "  [!] $text" -ForegroundColor Yellow }
  function Die($text) { Write-Host ""; Write-Host "[x] $text" -ForegroundColor Red; throw "req-kit 安装没有完成" }

  Write-Host "安装 req-kit：Paseo 上的需求开发体系"

  Step "检查环境"
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "没有找到 Node.js。请先安装 Node.js 22 或更新版本：https://nodejs.org" }
  $nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
  if ($nodeMajor -lt 22) { Die "需要 Node.js 22 或更新版本，当前是 $(node -v)。请升级：https://nodejs.org" }
  Ok "Node.js $(node -v)"
  # npm.cmd, not npm.ps1: the .ps1 shim is what the execution policy would block.
  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
  if (-not $npm) { Die "没有找到 npm（通常随 Node.js 一起安装）" }
  $npm = $npm.Source
  Ok "npm $(& $npm --version)"
  if (Get-Command git -ErrorAction SilentlyContinue) { Ok "$(git --version)" } else { Warn "没有找到 git：流水线需要在 git 仓库中工作，请稍后安装（https://git-scm.com）" }

  Step "确定要安装的版本"
  $source = $null
  if ($From -ne "release") {
    $spec = if ($Version) { $Version } elseif ($Beta) { "beta" } else { "latest" }
    $found = (& $npm view "$Pkg@$spec" version 2>$null | Select-Object -Last 1)
    if ($LASTEXITCODE -eq 0 -and $found) {
      $found = $found.Trim(" '`"")
      if (-not $Version -and $Beta) {
        # The beta tag can lag behind the release that followed it (1.8.0-beta.3 < 1.8.0).
        $stable = (& $npm view "$Pkg@latest" version 2>$null | Select-Object -Last 1)
        if ($LASTEXITCODE -eq 0 -and $stable) {
          $stable = $stable.Trim(" '`"")
          $key = { param($v) $p = $v -split "-", 2; $n = @($p[0].Split(".") | ForEach-Object { [int]$_ }); if ($p.Count -lt 2) { $n + @(1, "") } else { $n + @(0, $p[1]) } }
          $a = & $key $found; $b = & $key $stable; $pick = $found
          for ($i = 0; $i -lt 4; $i++) { if ($a[$i] -ne $b[$i]) { if ($a[$i] -lt $b[$i]) { $pick = $stable }; break } }
          $found = $pick
        }
      }
      $source = "$Pkg@$found"
      Ok "npm 上的 $source"
    } elseif ($From -eq "npm") {
      Die "npm 上没有找到 $Pkg@$spec。可以去掉 `$ReqKitFrom，改用 GitHub Release 的安装包"
    } else {
      Warn "npm 上没有找到 $Pkg@$spec，改用 GitHub Release 的安装包"
    }
  }
  if (-not $source) {
    try {
      $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=30" -Headers @{ "User-Agent" = "req-kit-installer" } -ErrorAction Stop
    } catch { Die "无法读取 GitHub Release 列表：$($_.Exception.Message)" }
    $usable = @($releases | Where-Object { -not $_.draft -and ($_.assets | Where-Object { $_.name -like "*.tgz" }) })
    if ($Version) { $pick = $usable | Where-Object { $_.tag_name.TrimStart("v") -eq $Version } | Select-Object -First 1 }
    else {
      $pick = $usable | Where-Object { $Beta -or -not $_.prerelease } | Select-Object -First 1
      if (-not $pick) { $pick = $usable | Select-Object -First 1; if ($pick) { Warn "还没有正式版，安装最新的 beta 版" } }
    }
    if (-not $pick) { Die "GitHub Release 中没有找到安装包（https://github.com/$Repo/releases）" }
    $source = ($pick.assets | Where-Object { $_.name -like "*.tgz" } | Select-Object -First 1).browser_download_url
    Ok "GitHub Release 中的 $($pick.tag_name)"
  }

  Step "安装 $Pkg"
  & $npm install -g $source
  if ($LASTEXITCODE -ne 0) { Die "npm 安装失败（见上面的输出）" }
  $root = (& $npm root -g).Trim()
  $reqMjs = Join-Path $root "$Pkg\bin\req.mjs"
  if (-not (Test-Path $reqMjs)) { Die "安装后没有找到 $reqMjs" }
  Ok "已安装到 $(Join-Path $root $Pkg)"
  $binDir = Split-Path $root -Parent

  $daemonUrl = if ($env:REQ_KIT_PASEO_URL) { $env:REQ_KIT_PASEO_URL } else { "http://127.0.0.1:6767" }
  if (-not $SkipPaseo) {
    Step "检查 Paseo"
    # Any HTTP answer (even 401 with a password set) means a daemon is listening.
    $probe = 'fetch(process.argv[1] + "/api/status", { signal: AbortSignal.timeout(3000) }).then((r) => r.json().catch(() => ({}))).then((j) => console.log("up " + (j.version || "")), () => console.log("down"))'
    function DaemonState { (& node -e $probe $daemonUrl 2>$null | Select-Object -Last 1) }
    $range = (& node -p "require(process.argv[1]).reqKit.paseo" (Join-Path $root "$Pkg\package.json")).Trim()
    $minor = if ($range -match '(\d+\.\d+)') { $Matches[1] } else { "" }
    $paseo = Get-Command paseo.cmd -ErrorAction SilentlyContinue
    if (-not $paseo) { $paseo = Get-Command paseo -ErrorAction SilentlyContinue }
    $paseo = if ($paseo) { $paseo.Source } else { $null }
    $state = DaemonState

    if (-not $paseo -and $state -like "up*") {
      # The desktop app runs its own daemon and does not put the paseo command on PATH.
      Ok "Paseo daemon 已在运行（$($state.Substring(2).Trim())），没有 paseo 命令（通常是桌面版 Paseo 管理的 daemon）"
      Warn "需要网页界面时，在桌面版的设置中开启，或安装 Paseo 命令行后运行 paseo daemon config set features.webUi.enabled true"
    } else {
      if (-not $paseo) {
        Write-Host "  没有找到 Paseo，安装 Paseo $minor 系列的最新版（@getpaseo/cli@~$minor.0，这个版本的 req-kit 支持 $range）"
        & $npm install -g "@getpaseo/cli@~$minor.0"
        if ($LASTEXITCODE -ne 0) { Die "Paseo 安装失败（见上面的输出）。也可以按 https://paseo.sh 的说明自己安装后重新运行" }
        $paseo = Join-Path $binDir "paseo.cmd"
        if (-not (Test-Path $paseo)) { $c = Get-Command paseo.cmd -ErrorAction SilentlyContinue; if ($c) { $paseo = $c.Source } }
        Ok "已安装 Paseo"
      }
      $v = (& $paseo --version 2>$null | Select-Object -First 1)
      if ($v -match '(\d+\.\d+\.\d+)') {
        $v = $Matches[1]
        if ($v.StartsWith("$minor.")) { Ok "Paseo $v" } else { Warn "Paseo 是 $v，这个版本的 req-kit 支持 $range。请换成匹配的 Paseo，或用 req upgrade 选择支持它的 req-kit" }
      }
      $changed = $false
      if ((& $paseo daemon config get features.webUi.enabled 2>$null) -match "true") { Ok "Paseo 网页界面已开启" }
      else {
        & $paseo daemon config set features.webUi.enabled true *> $null
        if ($LASTEXITCODE -eq 0) { Ok "已开启 Paseo 自带的网页界面（features.webUi.enabled）"; $changed = $true }
        else { Warn "没能开启 Paseo 的网页界面，之后可以运行：paseo daemon config set features.webUi.enabled true" }
      }
      if ((DaemonState) -like "up*") {
        if ($changed) { Warn "Paseo daemon 正在运行，网页界面要在重启后生效：paseo daemon restart（会中断正在运行的 agent，方便时再重启）" }
        else { Ok "Paseo daemon 正在运行" }
      } else {
        & $paseo daemon start *> $null
        if ($LASTEXITCODE -eq 0) {
          # Wait for it to answer: the wizard below asks the daemon for the agents.
          for ($i = 0; $i -lt 15 -and (DaemonState) -notlike "up*"; $i++) { Start-Sleep -Seconds 1 }
          Ok "已启动 Paseo daemon"
        } else { Warn "没能启动 Paseo daemon，请运行 paseo daemon start 查看原因" }
      }
      Write-Host "  Paseo 网页界面：$daemonUrl/"
    }

    $agents = @("claude", "codex", "opencode", "pi", "copilot") | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue }
    if ($agents) { Ok "agent 命令行：$($agents -join ' ')" }
    else { Warn "没有找到任何 agent 命令行（Claude Code、Codex、OpenCode、Pi、Copilot）。Paseo 要用它们干活：至少装一个并登录，再运行 req configure" }
  }

  Step "启用这个版本，安装 /req 等 skill"
  $config = Join-Path $(if ($env:REQ_KIT_HOME) { $env:REQ_KIT_HOME } else { Join-Path $HOME ".req-kit" }) "config.json"
  & node $reqMjs setup
  if ($LASTEXITCODE -ne 0) {
    # On a new machine setup ends with "fill in the agents", which the wizard below does.
    if (-not ((Test-Path $config) -and (Select-String -Path $config -Pattern "CHANGE-ME" -Quiet))) { Die "req setup 没有完成（见上面的输出）。修复后可以重新运行" }
  }

  if (-not $NoConfigure -and (Test-Path $config) -and (Select-String -Path $config -Pattern "CHANGE-ME" -Quiet)) {
    Step "选择 agent"
    & node $reqMjs configure
    if ($LASTEXITCODE -eq 0) { & node $reqMjs check } else { Warn "配置向导没有完成，之后可以运行 req configure" }
  }

  Step "完成"
  $onPath = ($env:Path -split ";") | Where-Object { $_.TrimEnd("\") -ieq $binDir.TrimEnd("\") }
  if ($onPath) { Ok "req 命令可用（在 PowerShell 中受执行策略限制时，输入 req.cmd）" }
  else { Warn "req 命令还不在 PATH 中：把 $binDir 加入用户的 Path 环境变量，然后重新打开终端" }
  & node $reqMjs version

  Write-Host ""
  Write-Host "下一步："
  Write-Host "  1. 运行 req doctor（PowerShell 中受限时用 req.cmd doctor）检查 Paseo daemon 和 agent 是否就绪；在浏览器打开 $daemonUrl/ 就是 Paseo 的网页界面"
  Write-Host "  2. 在项目的 Paseo 对话中运行 /req-setup 接入项目（每个项目一次）"
  Write-Host "  3. 在 Paseo 对话中输入 /req 和一句话需求"
  Write-Host "文档：https://paseo-req-kit.vercel.app/"
}
