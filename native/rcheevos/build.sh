#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright © 2026 Morten Øien Eriksen
# Build rcheevos (vendored in ./rcheevos: RetroAchievements' library, v12.5.0,
# MIT) with this project's glue (c64_cheevos.c) to WebAssembly, and embed it
# into src/achievements/rcheevos-wasm-blob.js.
#
# Needs LLVM's clang and wasm-ld with a WASI sysroot and compiler-rt builtins:
#   brew install llvm lld wasi-libc wasi-runtimes
# The hash keeps only whole-file hashing (all a C64 file needs): disc, ROM
# header, zip and encrypted hashing are compiled out.
set -e
cd "$(dirname "$0")"
LLVM="${LLVM:-$(brew --prefix llvm 2>/dev/null)/bin}"
SYSROOT="${WASI_SYSROOT:-$(brew --prefix 2>/dev/null)/share/wasi-sysroot}"
BUILTINS="${WASI_BUILTINS:-$(ls "$(brew --prefix wasi-runtimes 2>/dev/null)"/share/wasi-runtimes/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a 2>/dev/null)}"
OUT=build
mkdir -p "$OUT"
"$LLVM/clang" --target=wasm32-wasip1 --sysroot="$SYSROOT" -O2 -flto -mexec-model=reactor \
  -DRC_HASH_NO_DISC -DRC_HASH_NO_ROM -DRC_HASH_NO_ZIP -DRC_HASH_NO_ENCRYPTED \
  -Ircheevos/include -Ircheevos/src \
  -fvisibility=hidden -Wl,--no-entry -Wl,--strip-all -Wl,--gc-sections \
  -nodefaultlibs -lc "$BUILTINS" \
  -o "$OUT/rcheevos.wasm" \
  c64_cheevos.c rcheevos/src/rcheevos/*.c rcheevos/src/rhash/hash.c rcheevos/src/rhash/md5.c \
  rcheevos/src/rc_compat.c rcheevos/src/rc_util.c rcheevos/src/rc_version.c
node ../../tools/embed-rcheevos-wasm.mjs
