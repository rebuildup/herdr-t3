//! Port of `src/shell/router.ts` — the hash-route state machine behind
//! the app shell (issue #83/#84). The TS router stores the route in
//! `window.location.hash`; this port keeps the hash as explicit state so
//! both the Electron adapter and the GPUI host can drive identical
//! semantics without a URL bar.
//!
//! Fidelity notes vs the TS source:
//! - `parse` splits on `/` and drops empty segments (`filter(Boolean)`),
//!   so `#/w//ws` collapses to the legacy single-segment form.
//! - `navigate` to the current hash re-emits without touching the
//!   entry stack.
//! - `onHashChange` distinguishes back/forward moves (adjacent entries)
//!   from fresh navigation (truncate forward entries, push).
//! - `lastMainHash` tracks the most recent workspace-route hash so
//!   `closeSettings` can return to it.
//! - `navigateHistory` in TS delegates to `window.history`; here it is
//!   modeled as `history_target` + `apply_hash_change`, which reproduces
//!   the same observable stack/index transitions.
//! - `decodeURIComponent` failures surface as `Err` (the TS throws).

use serde_json::{json, Value};

/// `ShellRoute` — the two top-level shell destinations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShellRoute {
    Workspace {
        machine: Option<String>,
        workspace_id: Option<String>,
    },
    Settings {
        section: Option<String>,
    },
}

impl ShellRoute {
    pub fn name(&self) -> &'static str {
        match self {
            ShellRoute::Workspace { .. } => "workspace",
            ShellRoute::Settings { .. } => "settings",
        }
    }

    fn same_route(&self, other: &ShellRoute) -> bool {
        match (self, other) {
            (
                ShellRoute::Workspace {
                    machine: m1,
                    workspace_id: w1,
                },
                ShellRoute::Workspace {
                    machine: m2,
                    workspace_id: w2,
                },
            ) => m1 == m2 && w1 == w2,
            (
                ShellRoute::Settings { section: s1 },
                ShellRoute::Settings { section: s2 },
            ) => s1 == s2,
            _ => false,
        }
    }

    /// JSON view for adapter ops / observations.
    pub fn to_json(&self) -> Value {
        match self {
            ShellRoute::Workspace {
                machine,
                workspace_id,
            } => json!({
                "name": "workspace",
                "machine": machine,
                "workspaceId": workspace_id,
            }),
            ShellRoute::Settings { section } => {
                json!({ "name": "settings", "section": section })
            }
        }
    }
}

/// `parse(hash)` — hash string (with or without `#`) to a route.
pub fn parse_route(hash: &str) -> Result<ShellRoute, String> {
    let path = hash.strip_prefix('#').unwrap_or(hash);
    let path = if path.is_empty() { "/" } else { path };
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match segments.first().copied() {
        Some("settings") => Ok(ShellRoute::Settings {
            section: segments.get(1).map(|s| decode_component(s)).transpose()?,
        }),
        Some("w") => {
            let rest = &segments[1..];
            if rest.len() >= 2 {
                Ok(ShellRoute::Workspace {
                    machine: Some(decode_component(rest[0])?),
                    workspace_id: Some(decode_component(rest[1])?),
                })
            } else {
                Ok(ShellRoute::Workspace {
                    machine: None,
                    workspace_id: rest
                        .first()
                        .map(|s| decode_component(s))
                        .transpose()?,
                })
            }
        }
        _ => Ok(ShellRoute::Workspace {
            machine: None,
            workspace_id: None,
        }),
    }
}

/// `decodeURIComponent` — strict percent-decoding; malformed input is an
/// error, matching the TS throw.
fn decode_component(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                // need two hex digits after '%'
                if i + 2 >= bytes.len() {
                    return Err(format!("malformed percent escape in {s:?}"));
                }
                let hi = hex_val(bytes[i + 1]).ok_or_else(|| {
                    format!("malformed percent escape in {s:?}")
                })?;
                let lo = hex_val(bytes[i + 2]).ok_or_else(|| {
                    format!("malformed percent escape in {s:?}")
                })?;
                out.push((hi << 4) | lo);
                i += 3;
            }
            b'+' => {
                // decodeURIComponent does NOT translate '+' to space.
                out.push(b'+');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    // decodeURIComponent yields UTF-8; invalid sequences throw in JS.
    String::from_utf8(out).map_err(|_| format!("invalid UTF-8 escape in {s:?}"))
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `encodeURIComponent` — JS semantics: everything except
/// `A-Z a-z 0-9 - _ . ! ~ * ' ( )` becomes `%XX` (uppercase hex).
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        let unreserved = b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if unreserved {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `workspaceHash(machine, workspaceId)`.
pub fn workspace_hash(machine: &str, workspace_id: &str) -> String {
    format!(
        "#/w/{}/{}",
        encode_component(machine),
        encode_component(workspace_id)
    )
}

/// `settingsHash(section)`.
pub fn settings_hash(section: Option<&str>) -> String {
    match section {
        Some(s) => format!("#/settings/{}", encode_component(s)),
        None => "#/settings".to_string(),
    }
}

/// Where a history traversal should land, mirroring
/// `navigateHistory(direction)` -> `window.history.back/forward()`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryDirection {
    Back,
    Forward,
}

/// The router state machine. `hash` plays the role of
/// `window.location.hash`; `entries`/`index` mirror the TS entry stack.
#[derive(Clone, Debug)]
pub struct ShellRouter {
    hash: String,
    entries: Vec<String>,
    index: isize,
    route: ShellRoute,
    last_main_hash: String,
}

impl ShellRouter {
    /// `initRouter()` at the given starting hash (`#/` when the host has
    /// no location yet).
    pub fn new(initial_hash: &str) -> Result<Self, String> {
        let hash = if initial_hash.is_empty() {
            "#/".to_string()
        } else {
            initial_hash.to_string()
        };
        let route = parse_route(&hash)?;
        let last_main_hash = if route.name() == "workspace" {
            hash.clone()
        } else {
            "#/".to_string()
        };
        Ok(Self {
            hash,
            entries: vec![hash.clone()],
            index: 0,
            route,
            last_main_hash,
        })
    }

    pub fn route(&self) -> &ShellRoute {
        &self.route
    }

    pub fn hash(&self) -> &str {
        &self.hash
    }

    pub fn can_navigate_history(&self, direction: HistoryDirection) -> bool {
        match direction {
            HistoryDirection::Back => self.index > 0,
            HistoryDirection::Forward => self.index < self.entries.len() as isize - 1,
        }
    }

    /// `navigate(to)` — `to` may be a bare path (`/settings`) or a hash.
    /// Returns the normalized hash now current.
    pub fn navigate(&mut self, to: &str) -> Result<String, String> {
        let hash = if to.starts_with('#') {
            to.to_string()
        } else {
            format!("#{to}")
        };
        if self.hash == hash {
            // TS calls emit() — route unchanged, no stack mutation.
            return Ok(hash);
        }
        self.entries.truncate(self.index as usize + 1);
        self.entries.push(hash.clone());
        self.index = self.entries.len() as isize - 1;
        // TS sets window.location.hash then calls emit() directly —
        // onHashChange is NOT re-entered for self-initiated navigation.
        self.hash = hash.clone();
        self.emit_route()
    }

    /// The hash a history traversal would set. `None` when the direction
    /// cannot move (mirrors canNavigateHistory gating).
    pub fn history_target(&self, direction: HistoryDirection) -> Option<String> {
        if !self.can_navigate_history(direction) {
            return None;
        }
        let next = match direction {
            HistoryDirection::Back => self.index - 1,
            HistoryDirection::Forward => self.index + 1,
        };
        self.entries.get(next as usize).cloned()
    }

    /// Applies a hash change that did NOT come from `navigate` — i.e.
    /// browser back/forward or an external edit. Mirrors `onHashChange`.
    pub fn apply_hash_change(&mut self, new_hash: &str) -> Result<String, String> {
        self.hash = new_hash.to_string();
        if new_hash == self.entries.get(self.index as usize).map(String::as_str) {
            // Same entry — emit only (TS compares hash strings).
            return self.emit_route();
        }
        if self.index > 0
            && self.entries.get((self.index - 1) as usize).map(String::as_str)
                == Some(new_hash)
        {
            self.index -= 1;
        } else if self.index < self.entries.len() as isize - 1
            && self.entries.get((self.index + 1) as usize).map(String::as_str)
                == Some(new_hash)
        {
            self.index += 1;
        } else {
            self.entries.truncate(self.index as usize + 1);
            self.entries.push(new_hash.to_string());
            self.index = self.entries.len() as isize - 1;
        }
        self.emit_route()
    }

    /// `closeSettings()` — leave settings for the workspace route that
    /// opened it. Returns the hash navigated to, or None when not on a
    /// settings route.
    pub fn close_settings(&mut self) -> Result<Option<String>, String> {
        if self.hash.starts_with("#/settings") {
            let target = self.last_main_hash.clone();
            self.navigate(&target).map(Some)
        } else {
            Ok(None)
        }
    }

    /// `emit()` — recompute route from the current hash; updates
    /// `last_main_hash` on workspace routes. Returns true when the route
    /// changed (the TS notifies listeners only on change).
    fn emit_route(&mut self) -> Result<String, String> {
        let next = parse_route(&self.hash)?;
        if next.name() == "workspace" {
            self.last_main_hash = self.hash.clone();
        }
        if !next.same_route(&self.route) {
            self.route = next;
        }
        Ok(self.hash.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_forms() {
        assert_eq!(
            parse_route("#/").unwrap(),
            ShellRoute::Workspace {
                machine: None,
                workspace_id: None
            }
        );
        assert_eq!(
            parse_route("#/w/local/ws-1").unwrap(),
            ShellRoute::Workspace {
                machine: Some("local".into()),
                workspace_id: Some("ws-1".into())
            }
        );
        // legacy single-segment form => local machine (machine: None)
        assert_eq!(
            parse_route("#/w/ws-1").unwrap(),
            ShellRoute::Workspace {
                machine: None,
                workspace_id: Some("ws-1".into())
            }
        );
        assert_eq!(
            parse_route("#/settings/appearance").unwrap(),
            ShellRoute::Settings {
                section: Some("appearance".into())
            }
        );
        // empty segments collapse (filter(Boolean))
        assert_eq!(
            parse_route("#/w//ws-1").unwrap(),
            ShellRoute::Workspace {
                machine: None,
                workspace_id: Some("ws-1".into())
            }
        );
        assert_eq!(
            parse_route("#/w/a/b/c").unwrap(),
            ShellRoute::Workspace {
                machine: Some("a".into()),
                workspace_id: Some("b".into())
            }
        );
        assert!(parse_route("#/w/%zz").is_err());
    }

    #[test]
    fn navigate_stack_and_history() {
        let mut r = ShellRouter::new("#/").unwrap();
        r.navigate("/w/local/ws-1").unwrap();
        r.navigate("/settings").unwrap();
        assert!(r.can_navigate_history(HistoryDirection::Back));
        assert!(!r.can_navigate_history(HistoryDirection::Forward));
        // back
        let target = r.history_target(HistoryDirection::Back).unwrap();
        assert_eq!(target, "#/w/local/ws-1");
        r.apply_hash_change(&target).unwrap();
        assert!(matches!(r.route(), ShellRoute::Workspace { .. }));
        assert!(r.can_navigate_history(HistoryDirection::Forward));
        // forward
        let fwd = r.history_target(HistoryDirection::Forward).unwrap();
        r.apply_hash_change(&fwd).unwrap();
        assert!(matches!(r.route(), ShellRoute::Settings { .. }));
        // new navigation truncates forward entries
        r.navigate("/w/local/ws-2").unwrap();
        assert!(!r.can_navigate_history(HistoryDirection::Forward));
    }

    #[test]
    fn close_settings_returns_to_last_workspace() {
        let mut r = ShellRouter::new("#/w/local/ws-1").unwrap();
        r.navigate("/settings/appearance").unwrap();
        assert!(matches!(r.route(), ShellRoute::Settings { .. }));
        let back = r.close_settings().unwrap().unwrap();
        assert_eq!(back, "#/w/local/ws-1");
        assert!(matches!(r.route(), ShellRoute::Workspace { .. }));
        // not on settings -> None
        assert!(r.close_settings().unwrap().is_none());
    }

    #[test]
    fn hash_helpers_roundtrip() {
        assert_eq!(workspace_hash("local", "ws 1"), "#/w/local/ws%201");
        assert_eq!(settings_hash(Some("a b")), "#/settings/a%20b");
        assert_eq!(settings_hash(None), "#/settings");
        let mut r = ShellRouter::new(&workspace_hash("m c", "w's")).unwrap();
        match r.route() {
            ShellRoute::Workspace { machine, workspace_id } => {
                assert_eq!(machine.as_deref(), Some("m c"));
                assert_eq!(workspace_id.as_deref(), Some("w's"));
            }
            _ => panic!("wrong route"),
        }
        r.navigate(&settings_hash(None)).unwrap();
    }
}
