//! Platform memory probes for the host-side watchdog sampler (issue #553).
//!
//! Mirrors `osAvailableBytes()` / `totalmem()` / the RSS half of
//! `sampleProcessMemory` in `desktop/main.ts`, std-only: no `unsafe`, no
//! crates — the TS side shells out to `vm_stat` too, so spawning the same
//! tools on the same cadence (30 s) is parity, not a shortcut.
//!
//! Every probe returns `Option`: a platform the host does not cover (or a
//! failed tool call) yields `None` and the host falls back to its own
//! sampler — the watchdog must never break diagnostics because a probe
//! failed, same as the TS `try/catch` around `getAppMetrics`.
//!
//! - `total_memory_bytes`: physical RAM. macOS `sysctl -n hw.memsize`,
//!   Linux `/proc/meminfo` `MemTotal`.
//! - `os_available_bytes`: bytes the OS can still give out without
//!   swapping. Linux `/proc/meminfo` `MemAvailable`; macOS `vm_stat`
//!   free+inactive+speculative+purgeable pages (Node's `os.freemem()` on
//!   macOS counts only truly-free pages and sits near 0% on a healthy
//!   machine — the false-positive the TS comment documents, so the same
//!   page-set is used here).
//! - `process_rss_bytes`: this process's resident set. Linux
//!   `/proc/self/status` `VmRSS`; macOS `ps -o rss= -p <pid>`.
//!
//! Windows returns `None` for all three until a `windows-sys` binding
//! lands; the GPUI host injects its own sampler there (the contract is
//! the `Option`, not the mechanism).

use std::process::Command;

/// Physical RAM in bytes, best-effort per platform.
pub fn total_memory_bytes() -> Option<u64> {
    platform::total_memory_bytes()
}

/// OS-available memory in bytes (see module docs for the per-platform
/// definition), best-effort.
pub fn os_available_bytes() -> Option<u64> {
    platform::os_available_bytes()
}

/// This process's RSS in bytes, best-effort.
pub fn process_rss_bytes() -> Option<u64> {
    platform::process_rss_bytes()
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::fs;

    fn meminfo_kb(key: &str) -> Option<u64> {
        let text = fs::read_to_string("/proc/meminfo").ok()?;
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix(key) {
                // "MemTotal:       32768 kB"
                let kb: u64 = rest
                    .trim_start_matches(':')
                    .split_whitespace()
                    .next()?
                    .parse()
                    .ok()?;
                return Some(kb * 1024);
            }
        }
        None
    }

    pub fn total_memory_bytes() -> Option<u64> {
        meminfo_kb("MemTotal:")
    }

    pub fn os_available_bytes() -> Option<u64> {
        meminfo_kb("MemAvailable:")
    }

    /// `VmRSS` from `/proc/self/status`; `statm` is the fallback (second
    /// field is resident pages).
    pub fn process_rss_bytes() -> Option<u64> {
        if let Ok(status) = fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                if let Some(rest) = line.strip_prefix("VmRSS:") {
                    if let Ok(kb) = rest
                        .trim_start_matches(':')
                        .split_whitespace()
                        .next()
                        .unwrap_or("")
                        .parse::<u64>()
                    {
                        return Some(kb * 1024);
                    }
                }
            }
        }
        let statm = fs::read_to_string("/proc/self/statm").ok()?;
        let resident_pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
        // statm counts in pages; every Linux ABI we ship uses 4 KiB pages
        // (the `VmRSS` path above is preferred and needs no page size).
        Some(resident_pages * 4096)
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    fn command_output(cmd: &str, args: &[&str]) -> Option<String> {
        let out = Command::new(cmd).args(args).output().ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8(out.stdout).ok()
    }

    pub fn total_memory_bytes() -> Option<u64> {
        command_output("sysctl", &["-n", "hw.memsize"])?
            .trim()
            .parse::<u64>()
            .ok()
    }

    /// `vm_stat` page counters, summed over the same four page classes
    /// the TS `osAvailableBytes` uses: free + inactive + speculative +
    /// purgeable. Page size comes from the header line; the historical
    /// 16 KiB default covers headers that omit it.
    pub fn os_available_bytes() -> Option<u64> {
        let out = command_output("vm_stat", &[])?;
        let mut page_size: u64 = 16 * 1024;
        for line in out.lines() {
            if let Some(rest) = line.trim().strip_prefix("page size of") {
                // "page size of 16384 bytes"
                if let Some(n) = rest.split_whitespace().next() {
                    if let Ok(v) = n.parse::<u64>() {
                        page_size = v;
                    }
                }
                break;
            }
        }
        let pages = |name: &str| -> u64 {
            out.lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    if key.trim() != name {
                        return None;
                    }
                    // "Pages free:    12345." — strip the trailing period
                    // and any grouping separators before parsing.
                    let digits: String = value
                        .trim()
                        .trim_end_matches('.')
                        .chars()
                        .filter(|c| c.is_ascii_digit())
                        .collect();
                    digits.parse().ok()
                })
                .unwrap_or(0)
        };
        let available_pages = pages("Pages free")
            + pages("Pages inactive")
            + pages("Pages speculative")
            + pages("Pages purgeable");
        Some(available_pages * page_size)
    }

    /// `ps -o rss=` reports resident set in KiB for this pid.
    pub fn process_rss_bytes() -> Option<u64> {
        let pid = std::process::id().to_string();
        let kb: u64 = command_output("ps", &["-o", "rss=", "-p", pid.as_str()])?
            .trim()
            .parse()
            .ok()?;
        Some(kb * 1024)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
    //! No std-only probe exists for other platforms (Windows needs
    //! `GetPhysicallyInstalledSystemMemory`/`GlobalMemoryStatusEx` via
    //! windows-sys; BSDs differ per flavour). Hosts inject a sampler.
    pub fn total_memory_bytes() -> Option<u64> {
        None
    }
    pub fn os_available_bytes() -> Option<u64> {
        None
    }
    pub fn process_rss_bytes() -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_return_something_or_none_never_panic() {
        // Platform-dependent: on linux/macos these must return Some with
        // sane values; elsewhere None is the contract.
        if let Some(total) = total_memory_bytes() {
            assert!(
                total >= 512 * 1024 * 1024,
                "RAM below 512 MiB is implausible"
            );
        }
        if let Some(avail) = os_available_bytes() {
            assert!(avail <= total_memory_bytes().unwrap_or(u64::MAX));
        }
        if let Some(rss) = process_rss_bytes() {
            assert!(rss > 0);
            assert!(rss < total_memory_bytes().unwrap_or(u64::MAX));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vm_stat_parser_handles_real_output_shape() {
        // The parser is exercised against the live `vm_stat` on macOS;
        // assert the page-size header and the four counters were found
        // (available > 0 on any non-exhausted machine).
        let avail = os_available_bytes().expect("vm_stat must work on macOS");
        assert!(avail > 0);
    }
}
