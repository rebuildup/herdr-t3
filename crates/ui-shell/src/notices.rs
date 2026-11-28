//! Port of `src/shell/notices.ts` — the transient notice (toast) store
//! (issue #113). Notices are ephemeral UI state; they never touch herdr.
//!
//! `NoticeAction.run` is a host-side callback in TS and is not
//! serializable, so the model keeps only the action's label — the
//! consumer wires behavior. `createdAt` is injected (`now_ms`) so tests
//! and the differential harness stay deterministic; the GPUI host passes
//! wall-clock time.

use serde_json::{json, Value};

/// `MAX_NOTICES` — the store keeps only the most recent five.
pub const MAX_NOTICES: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeKind {
    Attention,
    Info,
    Error,
}

impl NoticeKind {
    fn as_str(&self) -> &'static str {
        match self {
            NoticeKind::Attention => "attention",
            NoticeKind::Info => "info",
            NoticeKind::Error => "error",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "attention" => Some(NoticeKind::Attention),
            "info" => Some(NoticeKind::Info),
            "error" => Some(NoticeKind::Error),
            _ => None,
        }
    }
}

/// Action label only — `run` stays host-side (see module docs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoticeAction {
    pub label: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub id: String,
    pub kind: NoticeKind,
    pub title: String,
    pub body: Option<String>,
    pub action: Option<NoticeAction>,
    pub created_at: u64,
}

impl Notice {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "kind": self.kind.as_str(),
            "title": self.title,
            "body": self.body,
            "action": self.action.as_ref().map(|a| json!({ "label": a.label })),
            "createdAt": self.created_at,
        })
    }
}

/// Input to `push_notice` — everything except id/createdAt.
pub struct NoticeInput {
    pub kind: NoticeKind,
    pub title: String,
    pub body: Option<String>,
    pub action: Option<NoticeAction>,
}

/// `notices.ts` module state: list + id sequence.
#[derive(Default)]
pub struct NoticeStore {
    notices: Vec<Notice>,
    seq: u64,
}

impl NoticeStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// `pushNotice` — appends, caps at MAX_NOTICES (oldest dropped),
    /// returns the assigned id (`notice-{seq}`).
    pub fn push(&mut self, input: NoticeInput, now_ms: u64) -> String {
        self.seq += 1;
        let id = format!("notice-{}", self.seq);
        self.notices.push(Notice {
            id: id.clone(),
            kind: input.kind,
            title: input.title,
            body: input.body,
            action: input.action,
            created_at: now_ms,
        });
        if self.notices.len() > MAX_NOTICES {
            let excess = self.notices.len() - MAX_NOTICES;
            self.notices.drain(..excess);
        }
        id
    }

    /// `dismissNotice` — no-op for unknown ids (TS guards on `some`).
    pub fn dismiss(&mut self, id: &str) {
        self.notices.retain(|n| n.id != id);
    }

    /// `getNotices`.
    pub fn notices(&self) -> &[Notice] {
        &self.notices
    }

    pub fn to_json(&self) -> Value {
        Value::Array(self.notices.iter().map(Notice::to_json).collect())
    }
}

/// Parse a notice input from adapter JSON:
/// `{kind, title, body?, action?{label}}`.
pub fn parse_notice_input(v: &Value) -> Result<NoticeInput, String> {
    let kind = v
        .get("kind")
        .and_then(Value::as_str)
        .and_then(NoticeKind::parse)
        .ok_or_else(|| "notice kind must be attention|info|error".to_string())?;
    let title = v
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| "notice title required".to_string())?
        .to_string();
    let body = v.get("body").and_then(Value::as_str).map(str::to_string);
    let action = v.get("action").and_then(|a| {
        a.get("label")
            .and_then(Value::as_str)
            .map(|l| NoticeAction { label: l.to_string() })
    });
    Ok(NoticeInput {
        kind,
        title,
        body,
        action,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: NoticeKind) -> NoticeInput {
        NoticeInput {
            kind,
            title: "t".into(),
            body: None,
            action: None,
        }
    }

    #[test]
    fn push_assigns_sequential_ids_and_caps() {
        let mut s = NoticeStore::new();
        assert_eq!(s.push(input(NoticeKind::Info), 1), "notice-1");
        assert_eq!(s.push(input(NoticeKind::Error), 2), "notice-2");
        for i in 0..10 {
            s.push(input(NoticeKind::Attention), i);
        }
        assert_eq!(s.notices().len(), MAX_NOTICES);
        // oldest dropped, newest kept
        assert_eq!(s.notices().last().unwrap().id, "notice-12");
        assert_eq!(s.notices().first().unwrap().id, "notice-8");
    }

    #[test]
    fn dismiss_unknown_is_noop() {
        let mut s = NoticeStore::new();
        s.push(input(NoticeKind::Info), 0);
        s.dismiss("notice-99");
        assert_eq!(s.notices().len(), 1);
        s.dismiss("notice-1");
        assert!(s.notices().is_empty());
    }
}
