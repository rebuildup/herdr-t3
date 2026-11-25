//! Links the native libghostty-vt built by scripts/ghostty-vt/build-native.sh
//! into <repo>/native/. The artifact is gitignored; CI builds it before
//! compiling this crate (see scripts/ci.sh).

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let native = manifest.join("../../native");
    // Link search dir holds ONLY the static archive: with the dylib beside it
    // ld64 prefers the dylib and the test/binary then needs an rpath.
    let lib = native.join("static/libghostty-vt.a");
    assert!(
        lib.exists(),
        "native libghostty-vt missing: run scripts/ghostty-vt/build-native.sh first"
    );
    println!("cargo:rustc-link-search=native={}", native.join("static").display());
    println!("cargo:rustc-link-lib=static=ghostty-vt");
    println!("cargo:rerun-if-changed={}", lib.display());
}
