#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright © 2026 Morten Øien Eriksen
# Build the WASM SID engine and embed it into src/sid-wasm-blob.js.
# Toolchain pinned by rust-toolchain.toml (rustup installs it on demand).
set -e
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
node ../../tools/embed-sid-wasm.mjs
