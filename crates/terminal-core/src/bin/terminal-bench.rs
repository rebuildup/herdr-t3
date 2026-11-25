//! Rust port of scripts/perf-terminal-bench.ts (issue #231 workload, #286
//! evidence): 400 ticks of ANSI streaming decode + base64 hop + engine
//! frame on a 120x40 grid, same fixed LCG seed 42 and the same chunk
//! generator, so TS(wasm) and Rust(native) numbers are comparable.
//!
//!   cargo run --release -p terminal-core --bin terminal-bench

use std::time::Instant;
use terminal_core::{EngineOptions, GhosttyEngine, Widths};

const COLS: u16 = 120;
const ROWS: u16 = 40;
const TICKS: usize = 400;

const WORDS: &[&str] = &[
    "src/components/PaneTerminal.tsx",
    "server/bridge-core.ts",
    "shared/protocol.ts",
    "compiled",
    "passed",
    "failed",
    "warning",
    "error",
    "12ms",
    "1.2s",
    "ok",
    "herdr-t3",
    "workspace",
    "snapshot",
    "attach",
    "scrollback",
    "render",
];

struct Lcg(u32);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(1103515245)
            .wrapping_add(12345)
            & 0x7fffffff;
        self.0 as f64 / 0x7fffffff as f64
    }
}

fn pick<'a>(rand: f64, words: &'a [&'a str]) -> &'a str {
    words[(rand * words.len() as f64) as usize % words.len()]
}

fn make_chunk(rng: &mut Lcg) -> Vec<u8> {
    let mut parts: Vec<String> = Vec::new();
    let lines = 30 + (rng.next() * 40.0) as usize;
    for _ in 0..lines {
        let r = rng.next();
        if r < 0.15 {
            parts.push(format!(
                "\x1b[1;32m✓\x1b[0m {} done in {}ms\n",
                pick(rng.next(), WORDS),
                (rng.next() * 900.0 + 10.0) as u32
            ));
        } else if r < 0.3 {
            parts.push(format!(
                "\x1b[33m⚠ warning\x1b[0m: unused import in {}\n",
                pick(rng.next(), WORDS)
            ));
        } else if r < 0.4 {
            parts.push(format!(
                "\x1b[31m✗ test failed\x1b[0m {} assertion at line {}\n",
                pick(rng.next(), WORDS),
                (rng.next() * 500.0) as u32
            ));
        } else if r < 0.5 {
            parts.push(format!(
                "\x1b[36m→\x1b[0m agent: thinking about {} …\n",
                pick(rng.next(), WORDS)
            ));
        } else if r < 0.6 {
            parts.push(format!(
                "  {} = {}\n",
                pick(rng.next(), WORDS),
                ((rng.next() * 1000.0) as u32) as f64 / 10.0
            ));
        } else {
            let mut line = String::new();
            while line.len() < COLS as usize - 10 {
                line.push_str(pick(rng.next(), WORDS));
                line.push(' ');
            }
            line.truncate(COLS as usize - 1);
            parts.push(format!("{line}\n"));
        }
    }
    parts.push("日本語のテキストと絵文字 👨‍💻🚀 テスト出力\n".into());
    parts.push(format!("progress: {}{} 62%\n", "█".repeat(40), "░".repeat(20)));
    parts.concat().into_bytes()
}

// Minimal base64 for the bridge-hop parity with the TS bench.
const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() * 4 / 3 + 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn b64_decode(s: &str) -> Vec<u8> {
    let mut table = [255u8; 256];
    for (i, &c) in B64.iter().enumerate() {
        table[c as usize] = i as u8;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut acc = 0u32;
    let mut nbits = 0u32;
    for &c in bytes {
        if c == b'=' {
            break;
        }
        let v = table[c as usize];
        if v == 255 {
            continue;
        }
        acc = (acc << 6) | v as u32;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            out.push((acc >> nbits) as u8);
        }
    }
    out
}

fn main() {
    let mut engine = GhosttyEngine::new(
        COLS,
        ROWS,
        EngineOptions {
            widths: Widths::Core,
            images: None,
            scrollback_lines: Some(10000),
            events: None,
        },
    )
    .unwrap();
    let mut rng = Lcg(42);
    let mut cells = 0usize;
    let mut rows = 0usize;
    let t0 = Instant::now();
    for _ in 0..TICKS {
        let bytes = make_chunk(&mut rng);
        // server->client hop: terminal bytes cross the bridge as base64
        let b64 = b64_encode(&bytes);
        let back = b64_decode(&b64);
        engine.write(&back).unwrap();
        engine
            .frame(false, |_y, runs| {
                rows += 1;
                for run in runs {
                    cells += run.cells.len();
                }
            })
            .unwrap();
    }
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    println!("ticks={TICKS} rowsDrawn={rows} cellsDecoded={cells} total={ms:.0}ms");
}
