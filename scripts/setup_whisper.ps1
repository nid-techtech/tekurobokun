# whisper.cpp（whisper-server）の準備：版を固定してソースを取り、ビルドし、モデルを取得する（imple 6節）。
#
#   .\scripts\setup_whisper.ps1                       Vulkan版をビルドし、既定のモデルを取得する（バックエンドPC）
#   .\scripts\setup_whisper.ps1 -Backend cpu          Vulkanなしのビルド（開発機。Vulkan SDKは要らない）
#   .\scripts\setup_whisper.ps1 -SkipModels           ビルドだけ
#   .\scripts\setup_whisper.ps1 -SkipBuild            モデルの取得だけ
#   .\scripts\setup_whisper.ps1 -Models large-v3-turbo-q5_0
#
# 置き場所は、リポジトリの外で、llama.cppとは別のフォルダ（ggmlのDLLを混ぜないため）。既定は
# $HOME\tekurobo_servers\whisper.cpp（llama-server・VOICEVOXと同じ親のフォルダ）。
#   {Root}\src                      whisper.cppのソース（-Versionのタグ）
#   {Root}\build-{Backend}          ビルドの作業フォルダ
#   {Root}\bin\{Backend}\           whisper-server.exe（静的リンクで、単独で動く）
#   {Root}\models\                  モデル（ggml形式の.bin）
# 必要なもの：Git、CMake（PATHにあるか、Visual Studioに付いてくるもの）、Visual Studio（C++のビルドツール）。
# Vulkan版は、あわせてVulkan SDK（環境変数VULKAN_SDKが設定されているもの）。
# Windows PowerShell 5.1・PowerShell 7のどちらでも動く（このファイルはUTF-8のBOM付き）。

[CmdletBinding()]
param(
    [string]$Root = (Join-Path $env:USERPROFILE 'tekurobo_servers\whisper.cpp'),
    [ValidateSet('vulkan', 'cpu')]
    [string]$Backend = 'vulkan',
    # 固定する版（whisper.cppのタグ）。上げるときは、WhisperSpeechRecognizerの項目名を確かめ直す
    [string]$Version = 'v1.9.5',
    [string[]]$Models = @('large-v3-turbo-q5_0', 'large-v3-turbo-q8_0', 'kotoba-whisper-v2.0-q5_0'),
    [switch]$SkipBuild,
    [switch]$SkipModels
)

$ErrorActionPreference = 'Stop'

# 取得できるモデル（名前 → 取得元とファイル名）。名前は、設定の stt.bench のモデルの指定にも使う
$ModelCatalog = @{
    'large-v3-turbo-q5_0'      = @{ File = 'ggml-large-v3-turbo-q5_0.bin'; Url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' }
    'large-v3-turbo-q8_0'      = @{ File = 'ggml-large-v3-turbo-q8_0.bin'; Url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin' }
    'large-v3-turbo'           = @{ File = 'ggml-large-v3-turbo.bin'; Url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin' }
    'kotoba-whisper-v2.0-q5_0' = @{ File = 'ggml-kotoba-whisper-v2.0-q5_0.bin'; Url = 'https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/resolve/main/ggml-kotoba-whisper-v2.0-q5_0.bin' }
    'kotoba-whisper-v2.0'      = @{ File = 'ggml-kotoba-whisper-v2.0.bin'; Url = 'https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/resolve/main/ggml-kotoba-whisper-v2.0.bin' }
}

function Invoke-Native {
    param([string]$What, [scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$What に失敗しました（終了コード $LASTEXITCODE）" }
}

function Find-CMake {
    $onPath = Get-Command cmake -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    # Visual Studioに付いてくるCMake
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $paths = & $vswhere -all -prerelease -products '*' -property installationPath
        foreach ($p in $paths) {
            $cand = Join-Path $p 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
            if (Test-Path $cand) { return $cand }
        }
    }
    throw 'CMakeが見つかりません。PATHに通すか、Visual StudioのインストーラーでCMakeのコンポーネントを入れてください。'
}

function Get-ModelFiles {
    $dir = Join-Path $Root 'models'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    foreach ($name in $Models) {
        $entry = $ModelCatalog[$name]
        if (-not $entry) {
            throw "未知のモデル: $name（取得できるのは $($ModelCatalog.Keys -join ', ')）"
        }
        $dest = Join-Path $dir $entry.File
        if (Test-Path $dest) {
            Write-Host "モデル $name は取得済み: $dest"
            continue
        }
        Write-Host "モデル $name を取得します: $($entry.Url)"
        # curl.exe（Windows 10以降に付属）。途中で切れたら、同じコマンドで続きから取れる
        $part = "$dest.part"
        Invoke-Native "モデル $name の取得" { curl.exe --fail --location --continue-at - --output $part $entry.Url }
        Move-Item -Force $part $dest
        Write-Host ('  → {0}（{1:N0}バイト）' -f $dest, (Get-Item $dest).Length)
    }
}

function Build-WhisperServer {
    foreach ($tool in 'git') {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool が見つかりません。" }
    }
    $cmake = Find-CMake
    Write-Host "CMake: $cmake"

    $vulkanFlag = 'OFF'
    if ($Backend -eq 'vulkan') {
        if (-not $env:VULKAN_SDK) {
            throw 'Vulkan版のビルドにはVulkan SDKが要ります（環境変数VULKAN_SDKが未設定）。入れたあと、新しいターミナルで実行してください。Vulkanなしで試すだけなら -Backend cpu。'
        }
        $vulkanFlag = 'ON'
    }

    $src = Join-Path $Root 'src'
    if (Test-Path (Join-Path $src '.git')) {
        $current = (& git -C $src describe --tags --exact-match 2>$null)
        if ($current -ne $Version) {
            throw "ソース（$src）は $current で、-Version $Version と違います。フォルダを消して、やり直してください。"
        }
        Write-Host "ソースは取得済み: $src（$Version）"
    } else {
        New-Item -ItemType Directory -Force -Path $Root | Out-Null
        Invoke-Native 'ソースの取得' { git clone --depth 1 --branch $Version https://github.com/ggml-org/whisper.cpp.git $src }
    }

    $build = Join-Path $Root "build-$Backend"
    # 静的リンク（whisper-server.exeを単独で動かし、ggmlのDLLを別のフォルダに混ぜない）
    Invoke-Native 'CMakeの構成' {
        & $cmake -S $src -B $build -DGGML_VULKAN="$vulkanFlag" -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF
    }
    Invoke-Native 'ビルド' { & $cmake --build $build --config Release --target whisper-server --parallel }

    $exe = Get-ChildItem -Path $build -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
    if (-not $exe) { throw "ビルドは終わりましたが、whisper-server.exe が見つかりません（$build）。" }
    $binDir = Join-Path $Root "bin\$Backend"
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Copy-Item -Force $exe.FullName $binDir
    Write-Host "whisper-server: $(Join-Path $binDir 'whisper-server.exe')"
}

if (-not $SkipBuild) { Build-WhisperServer }
if (-not $SkipModels) { Get-ModelFiles }

$exePath = Join-Path $Root "bin\$Backend\whisper-server.exe"
$model = if ($Models.Count -gt 0) { $ModelCatalog[$Models[0]].File } else { 'ggml-large-v3-turbo-q5_0.bin' }
Write-Host ''
Write-Host '起動の例（ポート8081。応答の確認は curl http://127.0.0.1:8081/health）:'
Write-Host "  & '$exePath' -m '$(Join-Path $Root "models\$model")' --host 127.0.0.1 --port 8081 -l ja"
