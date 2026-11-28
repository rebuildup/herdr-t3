# xattr 0.2.3 local patch (herdr-t3 #634)

Vendored crates.io xattr 0.2.3 (MIT/Apache-2.0, licenses included)
selected via `[patch.crates-io]` because gpui 0.2.2's dependency chain
(gpui_http_client -> zed-async-tar -> xattr) fails to compile on
Linux/Android with libc >= 0.2.190: `libc::ENOATTR` was removed
(rust-lang/libc#1356; upstream report zed-industries/zed#67211).

Only `src/sys/mod.rs` differs from upstream: on Linux/Android the
crate-internal `ENOATTR` constant resolves to `libc::ENODATA` (the
errno Linux actually returns for a missing extended attribute).
macOS and the BSDs keep the real `libc::ENOATTR`.

Remove this patch when the GPUI dependency chain upgrades to a
maintained xattr release.

Manifest note: an empty `[workspace]` table was appended to the vendored
`Cargo.toml` so the crate is not absorbed into the herdr-t3 workspace
(patch dependencies must not be workspace members).
