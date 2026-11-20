// ランチャーの設定（imple 3節・6節）。アプリの設定フォルダの launcher.json を読む。
// なければ、雛形（config/launcher.default.json。ビルドに取り込む）を書き出してから読む。
// 文字列の {home} はユーザーのフォルダ、{repo} はリポジトリのフォルダに置き換える。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 雛形。リポジトリの config/launcher.default.json をビルドに取り込む。
pub const DEFAULT_CONFIG: &str = include_str!("../../../../config/launcher.default.json");

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConfig {
    pub id: String,
    /// 画面の詳細の列（モデル名など）
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 空ならリポジトリのフォルダ
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// 待ち受けるポート。起動前に使用中かを確かめる
    #[serde(default)]
    pub port: Option<u16>,
    /// ［すべて起動］で、これらが稼働中になってから起動する
    #[serde(default)]
    pub after: Vec<String>,
    /// 待機のサービス（副のLLM）。［すべて起動］では起動しない
    #[serde(default)]
    pub standby: bool,
    /// 200番台が返れば稼働中。空なら、ポートにつながれば稼働中（ポートもなければreadyDelayMs後）
    #[serde(default)]
    pub ready_url: String,
    #[serde(default)]
    pub ready_delay_ms: u64,
    /// この時間までに稼働中にならなければ失敗
    #[serde(default = "default_start_timeout")]
    pub start_timeout_ms: u64,
}

fn default_start_timeout() -> u64 {
    120_000
}

fn default_search_limit() -> u32 {
    1000
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatConfig {
    pub url: String,
    pub interval_ms: u64,
    pub timeout_ms: u64,
    pub failures: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailoverConfig {
    pub from: String,
    pub to: String,
    /// 正を終了してから、ポートが空くのを待つ上限
    pub release_timeout_ms: u64,
    /// ポートが空いてから副を起動するまで待つ時間（VRAMの解放を待つ）
    pub settle_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherConfig {
    #[serde(default)]
    pub repo_dir: String,
    #[serde(default)]
    pub log_dir: String,
    /// 起動したら［すべて起動］を行う
    #[serde(default)]
    pub start_all_on_launch: bool,
    /// サインイン時に自動で起動する（公式のautostartプラグイン）
    #[serde(default)]
    pub autostart: bool,
    pub admin_port: u16,
    /// 検索（Tavily）の無料枠（月あたり）。外部サービスの行の分母
    #[serde(default = "default_search_limit")]
    pub search_monthly_limit: u32,
    pub heartbeat: HeartbeatConfig,
    pub failover: FailoverConfig,
    pub services: Vec<ServiceConfig>,
}

/// 設定ファイルの場所（アプリの設定フォルダの launcher.json）。
pub fn config_path(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join("launcher.json")
}

/// 開発時のリポジトリの場所（このクレートの3つ上）。repoDirが空のときに使う。
fn build_repo_dir() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| manifest.to_path_buf())
}

fn home_dir() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default()
}

fn expand(value: &str, home: &str, repo: &str) -> String {
    value.replace("{home}", home).replace("{repo}", repo)
}

impl LauncherConfig {
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut config: LauncherConfig = serde_json::from_str(text).map_err(|e| e.to_string())?;
        config.resolve(&home_dir(), &build_repo_dir());
        config.validate()?;
        Ok(config)
    }

    /// 置き換えと既定値の補い。
    fn resolve(&mut self, home: &str, build_repo: &Path) {
        let repo = if self.repo_dir.is_empty() {
            build_repo.to_string_lossy().into_owned()
        } else {
            expand(&self.repo_dir, home, "")
        };
        self.repo_dir = repo.clone();
        self.log_dir = if self.log_dir.is_empty() {
            Path::new(&repo)
                .join("logs")
                .join("launcher")
                .to_string_lossy()
                .into_owned()
        } else {
            expand(&self.log_dir, home, &repo)
        };
        for s in &mut self.services {
            s.program = expand(&s.program, home, &repo);
            s.args = s.args.iter().map(|a| expand(a, home, &repo)).collect();
            s.cwd = if s.cwd.is_empty() {
                repo.clone()
            } else {
                expand(&s.cwd, home, &repo)
            };
            for v in s.env.values_mut() {
                *v = expand(v, home, &repo);
            }
        }
    }

    fn validate(&self) -> Result<(), String> {
        let ids: Vec<&str> = self.services.iter().map(|s| s.id.as_str()).collect();
        for (i, s) in self.services.iter().enumerate() {
            if ids[..i].contains(&s.id.as_str()) {
                return Err(format!("duplicate service id: {}", s.id));
            }
            for dep in &s.after {
                // 依存は記載順で前にあるものに限る（循環を作らない）
                if !ids[..i].contains(&dep.as_str()) {
                    return Err(format!("{}: unknown or later dependency {}", s.id, dep));
                }
            }
        }
        for id in [&self.failover.from, &self.failover.to] {
            if !ids.contains(&id.as_str()) {
                return Err(format!("failover: unknown service {id}"));
            }
        }
        Ok(())
    }
}

/// 設定を読む。ファイルがなければ雛形を書き出す。
pub fn load(app_config_dir: &Path) -> Result<LauncherConfig, String> {
    let path = config_path(app_config_dir);
    if !path.exists() {
        fs::create_dir_all(app_config_dir).map_err(|e| e.to_string())?;
        fs::write(&path, DEFAULT_CONFIG).map_err(|e| e.to_string())?;
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    LauncherConfig::parse(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_parses() {
        let mut config: LauncherConfig = serde_json::from_str(DEFAULT_CONFIG).unwrap();
        config.resolve("C:\\Users\\me", Path::new("C:\\repo"));
        config.validate().unwrap();
        let ids: Vec<&str> = config.services.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            ["llm.main", "llm.sub", "stt", "tts", "backend", "tunnel"]
        );
        let stt = &config.services[2];
        assert_eq!(stt.after, ["llm.main"]);
        assert!(stt.args.iter().any(|a| a == "--vad"));
        assert!(stt.program.starts_with("C:\\Users\\me\\"));
        assert_eq!(config.services[4].cwd, "C:\\repo");
        assert_eq!(config.services[3].after, Vec::<String>::new());
        assert!(config.services[1].standby);
    }

    #[test]
    fn rejects_later_dependency() {
        let mut config: LauncherConfig = serde_json::from_str(DEFAULT_CONFIG).unwrap();
        config.services[0].after = vec!["stt".into()];
        assert!(config.validate().is_err());
    }
}
