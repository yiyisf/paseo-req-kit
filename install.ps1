# req-kit one-step installer for Windows PowerShell.
#
#   irm https://paseo-req-kit.vercel.app/install.ps1 | iex
#
# Piped into iex it is not a script file, so the execution policy does not block it.
# Options: set them as variables before the command, e.g.
#   $ReqKitBeta = $true; irm .../install.ps1 | iex
#   $ReqKitVersion = "1.9.1"; irm .../install.ps1 | iex
#   $ReqKitFrom = "release"     # npm | release (default: npm, falling back to the Release)
#   $ReqKitNoConfigure = $true  # skip the agent configuration wizard
#   $ReqKitSkipPaseo = $true    # do not check, install or start Paseo
#   $ReqKitPlugin = "yes"       # yes: install the req-kit plugin for Paseo without asking; no: do not offer it
#
#   $ReqKitRegistry = "https://npm.example.internal/"   # npm registry (e.g. a company mirror), saved for this machine
#   $ReqKitNoSaveRegistry = $true                         # use $ReqKitRegistry for this install only
#
# Like install.sh it only checks Node.js and npm, picks the version (npm, or the GitHub Release
# .tgz) and runs that version's own installer: the same as
#   npx -y paseo-req-kit@latest install
# which is all a company network with only an npm mirror needs:
#   npx -y --registry=https://npm.example.internal/ paseo-req-kit@latest install

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
  $PluginStep = [string](Get-Variable -Name ReqKitPlugin -ValueOnly -ErrorAction SilentlyContinue)
  $Registry = [string](Get-Variable -Name ReqKitRegistry -ValueOnly -ErrorAction SilentlyContinue)
  $NoSaveRegistry = [bool](Get-Variable -Name ReqKitNoSaveRegistry -ValueOnly -ErrorAction SilentlyContinue)
  if (-not $PluginStep) { $PluginStep = "ask" }
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

  if ($Registry) { $env:npm_config_registry = $Registry; Ok "npm 源：$Registry" }

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
    } elseif ($Registry -and $From -eq "auto") {
      # A company mirror usually means GitHub is out of reach: say so instead of trying it.
      Die "npm 源 $Registry 上没有找到 $Pkg@$spec。镜像可能还没有同步，稍后再试"
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

  # The rest (install, Paseo, setup, agents, plugin) is the chosen version's own installer
  # (bin/bootstrap.mjs, 1.13), the same as npx -y paseo-req-kit@latest install.
  $pass = @("--spec", $source)
  if ($Registry) { $pass += @("--registry", $Registry) }
  if ($NoSaveRegistry) { $pass += "--no-save-registry" }
  if ($NoConfigure) { $pass += "--no-configure" }
  if ($SkipPaseo) { $pass += "--skip-paseo" }
  if ($PluginStep -eq "yes") { $pass += "--with-plugin" } elseif ($PluginStep -eq "no") { $pass += "--no-plugin" }
  # Splatted, so that PowerShell passes "--" on to npm instead of treating it as its own.
  $execArgs = @("exec", "--yes", "--package=$source", "--", "paseo-req-kit", "install") + $pass
  & $npm @execArgs
  if ($LASTEXITCODE -ne 0) { throw "req-kit 安装没有完成" }
}
