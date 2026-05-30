// Activation key gating.
//
// First-run model: app shows an ActivationScreen until a valid key is in
// the macOS Keychain. Contributors set JARVIS_DEV_MODE=1 to skip entirely.
//
// Key format: JRVS-XXXX-XXXX-XXXX where each XXXX is 4 uppercase hex chars.
// The server mints keys as HMAC-SHA256(secret, email+nonce) truncated to 16
// hex chars; the client only verifies the format, since it does not hold the
// minting secret. Trust derives from issuance, not from local crypto.

use hmac::{Hmac, Mac};
use keyring::Entry;
use sha2::Sha256;

const KEYCHAIN_SERVICE: &str = "ai.jarvis.app";
const KEYCHAIN_USER: &str = "activation-key";

fn dev_mode() -> bool {
    matches!(std::env::var("JARVIS_DEV_MODE").as_deref(), Ok(v) if !v.is_empty() && v != "0")
}

fn entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| format!("keychain entry: {e}"))
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

/// Server-side helper kept here for parity with the broker. Not exposed to
/// the frontend — the client never sees the minting secret.
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

// ---------------- Tauri commands ----------------

#[tauri::command]
pub fn activation_validate_key(key: String) -> Result<bool, String> {
    if dev_mode() {
        return Ok(true);
    }
    Ok(validate_key_format(&key))
}

#[tauri::command]
pub fn activation_save_key(key: String) -> Result<(), String> {
    if !validate_key_format(&key) {
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

#[tauri::command]
pub fn activation_has_valid_key() -> Result<bool, String> {
    if dev_mode() {
        return Ok(true);
    }
    match entry()?.get_password() {
        Ok(k) => Ok(validate_key_format(&k)),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("keychain check: {e}")),
    }
}

#[tauri::command]
pub fn activation_clear_key() -> Result<(), String> {
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
}
