# req-kit one-step installer for Windows PowerShell.
#
#   irm https://raw.githubusercontent.com/yiyisf/paseo-req-kit/main/install.ps1 | iex
#
# Piped into iex it is not a script file, so the execution policy does not block it.
# Options: set them as variables before the command, e.g.
#   $ReqKitBeta = $true; irm .../install.ps1 | iex
#   $ReqKitVersion = "1.7.0-beta.2"; irm .../install.ps1 | iex
#   $ReqKitFrom = "release"     # npm | release (default: npm, falling back to the Release)
#   $ReqKitNoConfigure = $true  # skip the agent configuration wizard
#
# Same steps as install.sh: check Node.js 22+, npm install -g paseo-req-kit (from npm or the
# GitHub Release .tgz), req setup, req configure. Running it again upgrades in place.

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
  $binDir = Split-Path $root -Parent
  $onPath = ($env:Path -split ";") | Where-Object { $_.TrimEnd("\") -ieq $binDir.TrimEnd("\") }
  if ($onPath) { Ok "req 命令可用（在 PowerShell 中受执行策略限制时，输入 req.cmd）" }
  else { Warn "req 命令还不在 PATH 中：把 $binDir 加入用户的 Path 环境变量，然后重新打开终端" }
  & node $reqMjs version

  Write-Host ""
  Write-Host "下一步："
  Write-Host "  1. 运行 req doctor（PowerShell 中受限时用 req.cmd doctor）检查 Paseo daemon 和 agent 是否就绪"
  Write-Host "  2. 在项目的 Paseo 对话中运行 /req-setup 接入项目（每个项目一次）"
  Write-Host "  3. 在 Paseo 对话中输入 /req 和一句话需求"
  Write-Host "文档：https://yiyisf.github.io/paseo-req-kit/"
}
