// Activation key gating + server-side entitlement (Option C).
//
// First-run model: the app shows an ActivationScreen until a valid key is in
// the macOS Keychain AND the server confirms the key still maps to a live club
// subscription. Contributors set JARVIS_DEV_MODE=1 to skip entirely.
//
// Why phone-home? The key format alone is trivial to fake (the client can't
// hold the minting secret). So the real gate lives on the server: POST
// /api/jarvis/verify checks the key against the owner's subscription, binds it
// to one Mac (machine_id), and can revoke it. The client caches the last
// positive answer in Keychain so it keeps working offline for a grace window.
//
// Key format: JRVS-XXXX-XXXX-XXXX where each XXXX is 4 uppercase hex chars.

use hmac::{Hmac, Mac};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const KEYCHAIN_SERVICE: &str = "ai.jarvis.app";
const KEYCHAIN_USER: &str = "activation-key";
const KEYCHAIN_ENTITLEMENT: &str = "entitlement";

const DEFAULT_API_BASE: &str = "https://guid.neurounit.ai";
/// Skip the network check when the last positive verify is younger than this.
const REVALIDATE_SECS: u64 = 6 * 3600; // 6 hours
/// Keep the app unlocked offline for at most this long after the last verify.
const GRACE_SECS: u64 = 7 * 24 * 3600; // 7 days

fn dev_mode() -> bool {
    matches!(std::env::var("JARVIS_DEV_MODE").as_deref(), Ok(v) if !v.is_empty() && v != "0")
}

fn entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| format!("keychain entry: {e}"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Pure format check. JRVS-XXXX-XXXX-XXXX, hex, uppercase.
pub fn validate_key_format(key: &str) -> bool {
    let k = key.trim();
    if k.len() != 19 {
        return false;
    }
    let parts: Vec<&str> = k.split('-').collect();
    if parts.len() != 4 || parts[0] != "JRVS" {
        return false;
    }
    for group in &parts[1..] {
        if group.len() != 4 || !group.chars().all(|c| c.is_ascii_hexdigit() && !c.is_lowercase()) {
            return false;
        }
    }
    true
}

/// Server-side helper kept here for parity with the bot. Not exposed to the
/// frontend — the client never sees the minting secret.
#[allow(dead_code)]
pub fn mint_key(secret: &[u8], email: &str, nonce: &str) -> String {
    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(secret).expect("hmac accepts any key length");
    mac.update(email.as_bytes());
    mac.update(b":");
    mac.update(nonce.as_bytes());
    let bytes = mac.finalize().into_bytes();
    // 6 bytes → 12 hex chars → three 4-char groups (matches JRVS-XXXX-XXXX-XXXX).
    let hex: String = bytes
        .iter()
        .take(6)
        .map(|b| format!("{:02X}", b))
        .collect();
    format!("JRVS-{}-{}-{}", &hex[0..4], &hex[4..8], &hex[8..12])
}

// ---------------- Server entitlement check ----------------

fn api_base() -> String {
    std::env::var("JARVIS_API_BASE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_API_BASE.to_string())
}

/// Stable per-Mac id, hashed so the raw hardware UUID never leaves the device.
/// Binds an activation key to one machine (sharing the key locks the 2nd Mac out).
fn machine_id() -> String {
    let raw = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    let uuid = raw
        .lines()
        .find(|l| l.contains("IOPlatformUUID"))
        .and_then(|l| l.split('"').nth(3))
        .unwrap_or("unknown-mac")
        .to_string();
    let digest = Sha256::digest(uuid.as_bytes());
    digest.iter().take(16).map(|b| format!("{:02x}", b)).collect()
}

#[derive(Deserialize)]
struct VerifyResp {
    ok: bool,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default, rename = "subscribedUntilEpoch")]
    subscribed_until_epoch: Option<u64>,
}

/// Call the server entitlement check. `Ok(resp)` is a clear server answer;
/// `Err(())` is a transport/network failure (caller decides offline grace).
fn server_verify(key: &str) -> Result<VerifyResp, ()> {
    let url = format!("{}/api/jarvis/verify", api_base());
    let body = serde_json::json!({ "key": key, "machineId": machine_id() }).to_string();
    let resp = ureq::post(&url)
        .timeout(Duration::from_secs(8))
        .set("Content-Type", "application/json")
        .send_string(&body);
    match resp {
        Ok(r) => r
            .into_string()
            .ok()
            .and_then(|t| serde_json::from_str::<VerifyResp>(&t).ok())
            .ok_or(()),
        // HTTP error status (e.g. 503) still carries a JSON {ok:false,reason} body.
        Err(ureq::Error::Status(_, r)) => r
            .into_string()
            .ok()
            .and_then(|t| serde_json::from_str::<VerifyResp>(&t).ok())
            .ok_or(()),
        Err(_) => Err(()),
    }
}

// ---------------- Entitlement cache (Keychain) ----------------

#[derive(Serialize, Deserialize, Clone)]
struct Entitlement {
    #[serde(default)]
    subscribed_until_epoch: Option<u64>,
    last_verified_at: u64,
}

impl Entitlement {
    /// Cache is usable when the subscription (if known) hasn't lapsed.
    fn not_expired(&self, now: u64) -> bool {
        self.subscribed_until_epoch.map_or(true, |e| e > now)
    }
}

fn entitlement_entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ENTITLEMENT)
        .map_err(|e| format!("keychain entitlement entry: {e}"))
}

fn save_entitlement(e: &Entitlement) {
    if let (Ok(entry), Ok(json)) = (entitlement_entry(), serde_json::to_string(e)) {
        let _ = entry.set_password(&json);
    }
}

fn load_entitlement() -> Option<Entitlement> {
    let json = entitlement_entry().ok()?.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

// ---------------- Tauri commands ----------------

/// Activate a freshly-entered key. Must be online — confirms the key against
/// the server (which binds it to this Mac) before we accept it. Returns
/// `Err(reason_code)` so the UI can show a specific message.
#[tauri::command]
pub fn activation_validate_key(key: String) -> Result<(), String> {
    if dev_mode() {
        return Ok(());
    }
    let key = key.trim().to_uppercase();
    if !validate_key_format(&key) {
        return Err("bad_format".into());
    }
    match server_verify(&key) {
        Ok(resp) if resp.ok => {
            save_entitlement(&Entitlement {
                subscribed_until_epoch: resp.subscribed_until_epoch,
                last_verified_at: now_secs(),
            });
            Ok(())
        }
        Ok(resp) => Err(resp.reason.unwrap_or_else(|| "denied".into())),
        Err(()) => Err("network".into()),
    }
}

#[tauri::command]
pub fn activation_save_key(key: String) -> Result<(), String> {
    if !validate_key_format(key.trim()) {
        return Err("invalid key format".into());
    }
    entry()?
        .set_password(key.trim())
        .map_err(|e| format!("keychain save: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn activation_load_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain load: {e}")),
    }
}

/// Launch gate. Valid = a well-formed key in Keychain that the server still
/// honours. Fast path skips the network if we verified recently; offline falls
/// back to the cached entitlement within the grace window.
#[tauri::command]
pub fn activation_has_valid_key() -> Result<bool, String> {
    if dev_mode() {
        return Ok(true);
    }
    let key = match entry()?.get_password() {
        Ok(k) => k,
        Err(keyring::Error::NoEntry) => return Ok(false),
        Err(e) => return Err(format!("keychain check: {e}")),
    };
    if !validate_key_format(&key) {
        return Ok(false);
    }

    let now = now_secs();
    let cache = load_entitlement();

    // Fast path: recently confirmed and not lapsed → no network.
    if let Some(c) = &cache {
        if c.not_expired(now) && now.saturating_sub(c.last_verified_at) < REVALIDATE_SECS {
            return Ok(true);
        }
    }

    match server_verify(&key) {
        Ok(resp) if resp.ok => {
            save_entitlement(&Entitlement {
                subscribed_until_epoch: resp.subscribed_until_epoch,
                last_verified_at: now,
            });
            Ok(true)
        }
        // Explicit server denial: subscription_expired / revoked / machine_mismatch.
        Ok(_) => Ok(false),
        // Network failure: keep working offline within the grace window.
        Err(()) => {
            if let Some(c) = &cache {
                if c.not_expired(now) && now.saturating_sub(c.last_verified_at) < GRACE_SECS {
                    return Ok(true);
                }
            }
            Ok(false)
        }
    }
}

#[tauri::command]
pub fn activation_clear_key() -> Result<(), String> {
    // Best-effort clear of the cached entitlement alongside the key.
    if let Ok(e) = entitlement_entry() {
        let _ = e.delete_credential();
    }
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain clear: {e}")),
    }
}

#[tauri::command]
pub fn activation_is_dev_mode() -> bool {
    dev_mode()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_format_accepted() {
        assert!(validate_key_format("JRVS-A1B2-C3D4-E5F6"));
        assert!(validate_key_format("JRVS-0000-0000-0000"));
        assert!(validate_key_format("JRVS-FFFF-FFFF-FFFF"));
    }

    #[test]
    fn invalid_format_rejected() {
        assert!(!validate_key_format(""));
        assert!(!validate_key_format("JRVS-A1B2-C3D4"));
        assert!(!validate_key_format("XXXX-A1B2-C3D4-E5F6"));
        assert!(!validate_key_format("JRVS-a1b2-C3D4-E5F6")); // lowercase
        assert!(!validate_key_format("JRVS-A1B2-C3D4-GHIJ")); // non-hex
    }

    #[test]
    fn mint_produces_valid_format() {
        let k = mint_key(b"secret", "user@example.com", "nonce-1");
        assert!(validate_key_format(&k), "minted key not valid: {k}");
    }

    #[test]
    fn machine_id_is_stable_hex() {
        let a = machine_id();
        let b = machine_id();
        assert_eq!(a, b, "machine id must be stable across calls");
        assert_eq!(a.len(), 32, "16 bytes → 32 hex chars");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn entitlement_expiry_logic() {
        let now = 1_000_000u64;
        let live = Entitlement { subscribed_until_epoch: Some(now + 100), last_verified_at: now };
        let lapsed = Entitlement { subscribed_until_epoch: Some(now - 100), last_verified_at: now };
        let unknown = Entitlement { subscribed_until_epoch: None, last_verified_at: now };
        assert!(live.not_expired(now));
        assert!(!lapsed.not_expired(now));
        assert!(unknown.not_expired(now));
    }
}
