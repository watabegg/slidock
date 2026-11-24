use crate::config::{self, LocalConfig};
use serde::{Deserialize, Serialize};
use slive_core::{Controller, Deck};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Light,
    Dark,
    System,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: Theme,
    pub remote: Option<LocalConfig>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub theme: Theme,
    pub connection: &'static str,
    pub url: String,
    pub local_available: bool,
}
pub fn path(base: &Path) -> PathBuf {
    let name = base.file_name().unwrap_or_default().to_string_lossy();
    base.with_file_name(format!(".{name}.slive-settings.json"))
}
pub fn load(base: &Path) -> Result<Preferences, String> {
    let file = path(base);
    match fs::read(file) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "設定を読み込めませんでした".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Preferences {
            theme: Theme::Light,
            remote: None,
        }),
        Err(_) => Err("設定を読み込めませんでした".into()),
    }
}
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("設定の保存先がありません")?)
            .map_err(|_| "設定を保存できませんでした")?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|_| "設定を保存できませんでした")?)
        .map_err(|_| "設定を保存できませんでした")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "設定を保存できませんでした")?;
    file.persist(path)
        .map_err(|_| "設定を保存できませんでした")?;
    Ok(())
}
pub fn view(base: &Path, preferences: &Preferences) -> Result<View, String> {
    let original = config::load(base)?;
    let remote = preferences.remote.as_ref().or_else(|| {
        if original.config.viewer_origin.is_some() {
            Some(&original.config)
        } else {
            None
        }
    });
    Ok(View {
        theme: preferences.theme,
        connection: if remote.is_some() { "web" } else { "local" },
        url: remote
            .and_then(|config| config.viewer_origin.clone())
            .unwrap_or_default(),
        local_available: matches!(original.playback, config::Playback::Local { .. }),
    })
}
pub fn active_config(base: &Path, preferences: &Preferences) -> Result<PathBuf, String> {
    if let Some(remote) = &preferences.remote {
        let file = path(base).with_extension("runtime.json");
        write_json(&file, remote)?;
        config::load(&file)?;
        Ok(file)
    } else {
        Ok(base.to_path_buf())
    }
}
pub fn fetch_remote(origin: &str, base: &Path) -> Result<LocalConfig, String> {
    let origin = config::normalize_remote_origin(origin)
        .map_err(|_| "Slidock の URL を入力してください（HTTPS または localhost）")?;
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "接続を開始できませんでした")?;
    let response = client
        .get(format!("{origin}/native-player.json"))
        .send()
        .map_err(|_| "接続できませんでした。URL とサーバーの起動状態を確認してください")?;
    if !response.status().is_success() {
        return Err("Slidock に接続できませんでした。URL とアクセス権を確認してください".into());
    }
    let mut bytes = Vec::new();
    response
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "スライド情報を取得できませんでした")?;
    if bytes.len() > 1024 * 1024 {
        return Err("スライド情報が大きすぎます".into());
    }
    let decks = validate_manifest(&bytes)?;
    Ok(LocalConfig {
        schema_version: Some(1),
        decks,
        notes: HashMap::new(),
        approved_source_root: base
            .parent()
            .ok_or("設定の保存先がありません")?
            .to_path_buf(),
        site_root: None,
        viewer_origin: Some(origin),
        auth_headers_file: None,
    })
}
fn validate_manifest(bytes: &[u8]) -> Result<Vec<Deck>, String> {
    let invalid = || "この URL には Slive で開けるスライド情報がありません".to_string();
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let version = value["schemaVersion"].as_u64().ok_or_else(invalid)?;
    if !matches!(version, 1 | 2) || value["protocolVersion"].as_u64() != Some(1) {
        return Err(invalid());
    }
    let mut raw = value["decks"].clone();
    if version == 1 {
        for deck in raw.as_array_mut().ok_or_else(invalid)? {
            deck.as_object_mut().ok_or_else(invalid)?.remove("playback");
        }
    }
    let decks: Vec<Deck> = serde_json::from_value(raw).map_err(|_| invalid())?;
    let mut seen = HashSet::new();
    for deck in &decks {
        if !deck.id.split('/').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }) || !seen.insert(deck.id.clone())
            || deck.revision.trim().is_empty()
            || deck.entry != format!("/{}/1", deck.id)
            || (version == 2 && deck.playback.is_none())
        {
            return Err(invalid());
        }
    }
    for item in value["unsupportedDecks"].as_array().ok_or_else(invalid)? {
        let id = item["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(invalid)?;
        if !seen.insert(id.to_string()) || !item["reason"].is_string() {
            return Err(invalid());
        }
    }
    Controller::new(decks.clone()).map_err(|_| invalid())?;
    Ok(decks)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest() -> serde_json::Value {
        serde_json::json!({"schemaVersion":2,"protocolVersion":1,"decks":[{"id":"a/b","revision":"r1","entry":"/a/b/1","clickTotals":[0,2],"playback":{"kind":"revision-query","parameter":"revision"}}],"unsupportedDecks":[]})
    }
    #[test]
    fn validates_remote_registry_before_connection() {
        let valid = manifest();
        assert!(validate_manifest(&serde_json::to_vec(&valid).unwrap()).is_ok());
        for bad in [
            {
                let mut v = valid.clone();
                v["decks"][0]["entry"] = "/other/1".into();
                v
            },
            {
                let mut v = valid.clone();
                v["decks"][0]["id"] = "../a".into();
                v
            },
            {
                let mut v = valid.clone();
                v["decks"][0]["playback"] = serde_json::Value::Null;
                v
            },
            {
                let mut v = valid.clone();
                v["decks"][0]["clickTotals"] = serde_json::json!([-1]);
                v
            },
            {
                let mut v = valid.clone();
                v["decks"] = serde_json::json!([]);
                v
            },
            {
                let mut v = valid.clone();
                v["unsupportedDecks"] = serde_json::json!([{"id":"a/b","reason":""}]);
                v
            },
        ] {
            assert!(validate_manifest(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
    }
    #[test]
    fn preferences_roundtrip_without_changing_original_config() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("local.json");
        fs::write(&base, "original").unwrap();
        let prefs = Preferences {
            theme: Theme::Dark,
            remote: None,
        };
        write_json(&path(&base), &prefs).unwrap();
        assert!(matches!(load(&base).unwrap().theme, Theme::Dark));
        assert_eq!(fs::read_to_string(&base).unwrap(), "original");
        assert_eq!(active_config(&base, &prefs).unwrap(), base);
    }
}
