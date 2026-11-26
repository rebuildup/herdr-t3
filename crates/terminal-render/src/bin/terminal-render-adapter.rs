//! Batch adapter binary for the differential harness (issue #294).
//!
//! Speaks the same {"steps":[{"op","input"}]} -> {"observations":[...]}
//! protocol as the other Rust adapters and mirrors the `scene_*` ops of
//! `harness/lib/adapters/terminal.ts`, driving `terminal-render`'s
//! GhosttyScene (port of src/lib/ghostty/scene.ts, contract
//! terminal-render@1) over a product GhosttySession.
//!
//! Text measurement is the same deterministic fake the TS adapter uses:
//! advance = cellW * display columns (cp > U+2E7F counts 2, everything
//! else 1), except text containing '×' which returns 1.5*cellW so it
//! never joins a batched fillText; the font box is the canvas-fallback
//! (0.8/0.25 of fontSize).

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use terminal_core::{GhosttySession, ScreenRange, ScreenPoint, SessionOptions, SessionWidths};
use terminal_render::{
    GhosttyScene, GhosttySceneOptions, SceneBackgroundImage, SceneFrame, SceneMetrics,
    TextMetrics,
};

/// The deterministic text-metrics fake shared with the TS adapter.
pub struct FakeMetrics {
    pub cell_w: f64,
}

impl TextMetrics for FakeMetrics {
    fn measure(&self, text: &str, _font: &str) -> f64 {
        if text.contains('×') {
            return self.cell_w * 1.5;
        }
        let cols: usize = text
            .chars()
            .map(|c| if (c as u32) > 0x2e7f { 2 } else { 1 })
            .sum();
        cols as f64 * self.cell_w
    }
    fn font_box(&self, font_size: f64, _font_family: &str) -> (f64, f64) {
        (font_size * 0.8, font_size * 0.25)
    }
}

struct SceneState {
    scene: GhosttyScene<FakeMetrics>,
}

fn num(input: &Map<String, Value>, key: &str) -> Result<f64, String> {
    input
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("input.{key} must be a number"))
}

fn opt_num(input: &Map<String, Value>, key: &str) -> Option<f64> {
    input.get(key).and_then(Value::as_f64)
}

fn opt_str<'a>(input: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

fn state<'a>(
    sessions: &'a mut HashMap<String, SceneState>,
    input: &Map<String, Value>,
) -> Result<&'a mut SceneState, String> {
    let handle = input.get("handle").and_then(Value::as_str)
        .ok_or("input.handle must be a string")?;
    sessions.get_mut(handle).ok_or_else(|| format!("unknown scene handle \"{handle}\""))
}

fn parse_point(v: &Value) -> Result<ScreenPoint, String> {
    let o = v.as_object().ok_or("point must be an object")?;
    Ok(ScreenPoint {
        x: o.get("x").and_then(Value::as_u64).unwrap_or(0) as u16,
        y: o.get("y").and_then(Value::as_u64).unwrap_or(0) as u32,
    })
}

fn parse_range(v: &Value) -> Result<ScreenRange, String> {
    let o = v.as_object().ok_or("range must be an object")?;
    Ok(ScreenRange {
        start: parse_point(o.get("start").ok_or("range.start required")?)?,
        end: parse_point(o.get("end").ok_or("range.end required")?)?,
    })
}

fn parse_metrics(input: &Map<String, Value>) -> Result<SceneMetrics, String> {
    Ok(SceneMetrics {
        cols: num(input, "cols")? as u32,
        rows: num(input, "rows")? as u32,
        cell_w: num(input, "cellW")?,
        cell_h: num(input, "cellH")?,
        dpr: opt_num(input, "dpr").unwrap_or(1.0),
    })
}

fn parse_bg_image(v: &Value) -> Result<SceneBackgroundImage, String> {
    let o = v.as_object().ok_or("bgImage must be an object")?;
    Ok(SceneBackgroundImage {
        width: o.get("width").and_then(Value::as_f64).unwrap_or(0.0),
        height: o.get("height").and_then(Value::as_f64).unwrap_or(0.0),
        opacity: o.get("opacity").and_then(Value::as_f64).unwrap_or(1.0),
        position: o.get("position").and_then(Value::as_str).unwrap_or("center").to_string(),
        fit: o.get("fit").and_then(Value::as_str).unwrap_or("contain").to_string(),
        repeat: o.get("repeat").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn frame_json(frame: &SceneFrame) -> Value {
    json!({ "text": frame.text, "overlay": frame.overlay })
}

fn run_op(
    op: &str,
    input: &Map<String, Value>,
    scenes: &mut HashMap<String, SceneState>,
    next_handle: &mut u32,
) -> Result<Value, String> {
    match op {
        "scene_new" => {
            let metrics = parse_metrics(input)?;
            let options = input.get("options").and_then(Value::as_object);
            let get = |k: &str, default: &str| {
                options
                    .and_then(|o| o.get(k))
                    .and_then(Value::as_str)
                    .unwrap_or(default)
                    .to_string()
            };
            let scene_options = GhosttySceneOptions {
                font_family: get("fontFamily", "monospace"),
                font_size: options
                    .and_then(|o| o.get("fontSize"))
                    .and_then(Value::as_f64)
                    .unwrap_or(13.0),
                foreground: get("foreground", "#d4d4d4"),
                background: get("background", "#1e1e1e"),
                cursor: get("cursor", "#ffffff"),
                cursor_text: options
                    .and_then(|o| o.get("cursorText"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                selection: options
                    .and_then(|o| o.get("selection"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                search: options
                    .and_then(|o| o.get("search"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            };
            let session_options = SessionOptions {
                cols: metrics.cols as u16,
                rows: metrics.rows as u16,
                cell_w: Some(metrics.cell_w),
                cell_h: Some(metrics.cell_h),
                widths: match opt_str(input, "widths") {
                    Some("core") => SessionWidths::Core,
                    _ => SessionWidths::Xterm,
                },
                scrollback_lines: opt_num(input, "scrollback").map(|v| v as u32),
                ..SessionOptions::default()
            };
            let session = GhosttySession::new(session_options)?;
            let cell_w = metrics.cell_w;
            let scene = GhosttyScene::new(session, scene_options, FakeMetrics { cell_w });
            *next_handle += 1;
            let handle = format!("sc{next_handle}");
            scenes.insert(handle.clone(), SceneState { scene });
            Ok(json!({ "handle": handle }))
        }
        "scene_write" => {
            let s = state(scenes, input)?;
            let data = if let Some(d) = input.get("data").and_then(Value::as_str) {
                d.as_bytes().to_vec()
            } else {
                let hex_str = input.get("hex").and_then(Value::as_str).unwrap_or("");
                if hex_str.len() % 2 != 0 {
                    return Err("odd-length hex".into());
                }
                (0..hex_str.len() / 2)
                    .map(|i| u8::from_str_radix(&hex_str[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string()))
                    .collect::<Result<Vec<u8>, _>>()?
            };
            s.scene.session().write(&data)?;
            Ok(Value::Null)
        }
        "scene_collect" => {
            let s = state(scenes, input)?;
            Ok(json!(s.scene.collect()?))
        }
        "scene_render" => {
            let s = state(scenes, input)?;
            Ok(frame_json(&s.scene.render()?))
        }
        "scene_set" => {
            let s = state(scenes, input)?;
            if input.get("invalidate").and_then(Value::as_bool) == Some(true) {
                s.scene.invalidate();
            }
            if let Some(font) = input.get("font").and_then(Value::as_object) {
                s.scene.set_font(
                    font.get("fontFamily").and_then(Value::as_str),
                    font.get("fontSize").and_then(Value::as_f64),
                );
            }
            if let Some(m) = input.get("metrics").and_then(Value::as_object) {
                let metrics = parse_metrics(m)?;
                s.scene.set_metrics(metrics.clone());
                // keep the fake's advance scale in step with the new cell width
                s.scene.text_metrics_mut().cell_w = metrics.cell_w;
            }
            if let Some(sel) = input.get("selection") {
                s.scene.set_selection(if sel.is_null() {
                    None
                } else {
                    Some(parse_range(sel)?)
                });
            }
            if let Some(hs) = input.get("highlights").and_then(Value::as_array) {
                let mut ranges = Vec::with_capacity(hs.len());
                for h in hs {
                    ranges.push(parse_range(h)?);
                }
                s.scene.set_highlights(ranges);
            }
            if let Some(v) = input.get("cursorVisible").and_then(Value::as_bool) {
                s.scene.set_cursor_visible(v);
            }
            if let Some(shift) = input.get("viewportShift").and_then(Value::as_i64) {
                s.scene.set_viewport_shift(shift);
            }
            if let Some(colors) = input.get("colors").and_then(Value::as_object) {
                let own = |k: &str| colors.get(k).and_then(Value::as_str).map(str::to_string);
                s.scene.set_colors(
                    own("foreground"),
                    own("background"),
                    own("cursor"),
                    own("cursorText"),
                    own("selection"),
                    own("search"),
                );
            }
            if let Some(alpha) = opt_num(input, "bgOpacity") {
                s.scene.set_background_opacity(alpha);
            }
            if let Some(bg) = input.get("bgImage") {
                s.scene.set_background_image(if bg.is_null() {
                    None
                } else {
                    Some(parse_bg_image(bg)?)
                });
            }
            Ok(Value::Null)
        }
        "scene_dispose" => {
            if let Some(handle) = input.get("handle").and_then(Value::as_str) {
                if let Some(mut s) = scenes.remove(handle) {
                    s.scene.dispose();
                }
            }
            Ok(Value::Null)
        }
        _ => Err(format!("unknown op \"{op}\"")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: terminal-render-adapter <steps.json> <out.json>");
        std::process::exit(2);
    }
    let input: Value = serde_json::from_str(&fs::read_to_string(&args[1]).expect("read steps"))
        .expect("parse steps json");
    let steps = input["steps"].as_array().expect("steps array");
    let mut observations = Vec::with_capacity(steps.len());
    let mut scenes: HashMap<String, SceneState> = HashMap::new();
    let mut next_handle: u32 = 0;
    for step in steps {
        let op = step["op"].as_str().unwrap_or("");
        let input_map = step["input"].as_object().cloned().unwrap_or_default();
        let obs = match run_op(op, &input_map, &mut scenes, &mut next_handle) {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(error) => json!({ "ok": false, "error": error }),
        };
        observations.push(obs);
    }
    fs::write(&args[2], serde_json::to_string(&json!({ "observations": observations })).unwrap())
        .expect("write out");
}
