#!/bin/sh
# Builds the minimal LGPL ffmpeg of the desktop app (DESIGN §22; audio spike, normative): the configure flags in
# ffmpeg-min.flags, libopus linked statically, no ffprobe. Normally run by ffmpeg.mjs, which downloads and checks the
# sources and picks the build environment for the target:
#   sh desktop/scripts/build-ffmpeg.sh <rust triple> <ffmpeg source dir> <opus source dir> <out dir>
#   aarch64-apple-darwin, x86_64-apple-darwin   macOS with the Xcode command line tools, cmake and pkg-config
#                                               (nasm for x86_64; without it the x86 assembly is left out)
#   x86_64-unknown-linux-gnu,                   alpine:3.22 of the same architecture with build-base nasm cmake
#   aarch64-unknown-linux-gnu                   pkgconf linux-headers: a static musl binary that runs on every
#                                               distribution, inside the AppImage and on Arch
#   x86_64-pc-windows-msvc                      mingw-w64, nasm, cmake, pkg-config (ubuntu:22.04): ffmpeg is a
#                                               separate program, so the MSVC ABI of the app does not matter
# Writes <out>/ffmpeg[.exe], its licenses (COPYING.LGPLv2.1, LICENSE.md, opus-COPYING) and BUILD.txt (versions,
# sources with their SHA-256, the configure line: what LGPL-2.1 §6 asks to go with the binary).
# The environment may carry FFMPEG_URL, FFMPEG_SHA256, OPUS_URL, OPUS_SHA256 for BUILD.txt.
set -eu

[ $# -eq 4 ] || { echo "usage: build-ffmpeg.sh <rust triple> <ffmpeg source dir> <opus source dir> <out dir>" >&2; exit 2; }
TARGET=$1
FFSRC=$(cd "$2" && pwd)
OPUSSRC=$(cd "$3" && pwd)
mkdir -p "$4"
OUT=$(cd "$4" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/es-ffmpeg.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
if [ "$(uname -s)" = Darwin ]; then JOBS=$(sysctl -n hw.ncpu); else JOBS=$(nproc 2>/dev/null || echo 4); fi
FFVERSION=$(cat "$FFSRC/VERSION" 2>/dev/null || cat "$FFSRC/RELEASE")

EXE=
STRIP='strip'
OPUS_CMAKE=
# The configure arguments: the flag file, then the target's own.
# (Nothing is installed: the prefix only shows in `ffmpeg -version`.)
set -- --prefix=/usr/local --extra-version=easystudy-min
while IFS= read -r line || [ -n "$line" ]; do
  case $line in '' | '#'*) ;; *) set -- "$@" "$line" ;; esac
done < "$HERE/ffmpeg-min.flags"

case $TARGET in
  aarch64-apple-darwin | x86_64-apple-darwin)
    [ "$(uname -s)" = Darwin ] || { echo "$TARGET: build on macOS" >&2; exit 1; }
    ARCH=arm64
    [ "$TARGET" = x86_64-apple-darwin ] && ARCH=x86_64
    export MACOSX_DEPLOYMENT_TARGET=13.5
    CFL="-arch $ARCH -mmacosx-version-min=13.5"
    OPUS_CMAKE="-DCMAKE_OSX_ARCHITECTURES=$ARCH -DCMAKE_OSX_DEPLOYMENT_TARGET=13.5"
    # cmake calls the Apple-silicon CPU "arm64", not "aarch64": libopus would not assume NEON.
    [ "$ARCH" = arm64 ] && OPUS_CMAKE="$OPUS_CMAKE -DOPUS_PRESUME_NEON=ON"
    set -- "$@" --cc="clang $CFL" --extra-ldflags="$CFL" --pkg-config-flags=--static
    if [ "$ARCH" = x86_64 ]; then
      set -- "$@" --enable-cross-compile --arch=x86_64 --target-os=darwin
      command -v nasm > /dev/null || { echo "nasm is missing: building without x86 assembly (brew install nasm)" >&2; set -- "$@" --disable-x86asm; }
    fi
    STRIP="strip -x"
    ;;
  x86_64-unknown-linux-gnu | aarch64-unknown-linux-gnu)
    [ "$(uname -s)" = Linux ] || { echo "$TARGET: build on Linux (alpine)" >&2; exit 1; }
    case "$TARGET:$(uname -m)" in x86_64-*:x86_64 | aarch64-*:aarch64) ;; *) echo "$TARGET: build on a $(echo "$TARGET" | cut -d- -f1) machine" >&2; exit 1 ;; esac
    [ -f /etc/alpine-release ] || echo "not alpine: the static binary links glibc statically (musl is what the release uses)" >&2
    set -- "$@" --extra-ldflags=-static --pkg-config-flags=--static
    ;;
  x86_64-pc-windows-msvc)
    command -v x86_64-w64-mingw32-gcc > /dev/null || { echo "$TARGET: needs mingw-w64 (x86_64-w64-mingw32-gcc)" >&2; exit 1; }
    EXE=.exe
    STRIP=x86_64-w64-mingw32-strip
    # mingw: the default stack protector and FORTIFY break ffmpeg's link (__stack_chk_fail).
    OPUS_CMAKE="-DCMAKE_SYSTEM_NAME=Windows -DCMAKE_C_COMPILER=x86_64-w64-mingw32-gcc -DOPUS_STACK_PROTECTOR=OFF -DOPUS_FORTIFY_SOURCE=OFF"
    set -- "$@" --enable-cross-compile --target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32- \
      --extra-ldflags=-static --pkg-config=pkg-config --pkg-config-flags=--static
    ;;
  *)
    echo "unknown target $TARGET" >&2
    exit 2
    ;;
esac

echo "== libopus (static) for $TARGET"
# shellcheck disable=SC2086 # OPUS_CMAKE is a list of -D flags without spaces
cmake -S "$OPUSSRC" -B "$WORK/opus" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DOPUS_BUILD_PROGRAMS=OFF \
  -DOPUS_BUILD_TESTING=OFF -DCMAKE_INSTALL_PREFIX="$WORK/prefix" -DCMAKE_INSTALL_LIBDIR=lib $OPUS_CMAKE > "$WORK/opus.log" 2>&1 ||
  { tail -30 "$WORK/opus.log"; exit 1; }
# --config Release: multi-config generators (Visual Studio on Windows) ignore CMAKE_BUILD_TYPE and default to Debug.
if ! { cmake --build "$WORK/opus" --config Release --parallel "$JOBS" && cmake --install "$WORK/opus" --config Release; } >> "$WORK/opus.log" 2>&1; then
  tail -30 "$WORK/opus.log"
  exit 1
fi

echo "== ffmpeg $FFVERSION for $TARGET"
mkdir "$WORK/ff"
cd "$WORK/ff"
# Only this libopus: never a system copy (Homebrew's is a dylib).
PKG_CONFIG_PATH="$WORK/prefix/lib/pkgconfig" PKG_CONFIG_LIBDIR="$WORK/prefix/lib/pkgconfig" \
  "$FFSRC/configure" "$@" > "$WORK/configure.log" 2>&1 || { tail -30 "$WORK/configure.log"; tail -40 ffbuild/config.log 2>/dev/null; exit 1; }
# LGPL only: a GPL or nonfree part (a flag, a library found by accident) would change what may be shipped.
grep -q '^License: LGPL version 2.1 or later' "$WORK/configure.log" ||
  { grep '^License' "$WORK/configure.log" >&2; echo "the configured ffmpeg is not LGPL 2.1+" >&2; exit 1; }
make -j"$JOBS" "ffmpeg$EXE" > "$WORK/make.log" 2>&1 || { tail -40 "$WORK/make.log"; exit 1; }

rm -f "$OUT/ffmpeg" "$OUT/ffmpeg.exe"
cp "ffmpeg$EXE" "$OUT/"
# shellcheck disable=SC2086 # "strip -x"
$STRIP "$OUT/ffmpeg$EXE"
# Apple silicon runs only signed code: ad hoc here (a release build signs it again with its identity).
case $TARGET in *-apple-darwin) codesign --force --sign - "$OUT/ffmpeg$EXE" ;; esac
cp "$FFSRC/COPYING.LGPLv2.1" "$FFSRC/LICENSE.md" "$OUT/"
cp "$OPUSSRC/COPYING" "$OUT/opus-COPYING"
chmod 644 "$OUT/COPYING.LGPLv2.1" "$OUT/LICENSE.md" "$OUT/opus-COPYING" # the tarball has the LGPL text as 0640
OPUSVERSION=$(cat "$OPUSSRC/package_version" 2>/dev/null | sed -n 's/^PACKAGE_VERSION="\(.*\)"/\1/p')
{
  echo "FFmpeg $FFVERSION, built for $TARGET by easy-study's desktop/scripts/build-ffmpeg.sh"
  echo "License: LGPL version 2.1 or later (COPYING.LGPLv2.1, LICENSE.md); it links libopus ${OPUSVERSION:-} (BSD-3-Clause, opus-COPYING)."
  echo "Unmodified sources:"
  echo "  ${FFMPEG_URL:-https://ffmpeg.org/releases/ffmpeg-$FFVERSION.tar.xz}${FFMPEG_SHA256:+  sha256 $FFMPEG_SHA256}"
  echo "  ${OPUS_URL:-https://downloads.xiph.org/releases/opus/}${OPUS_SHA256:+  sha256 $OPUS_SHA256}"
  echo "Configured with:"
  for a in "$@"; do case $a in --prefix=*) ;; *) printf '  %s\n' "$a" ;; esac; done
} > "$OUT/BUILD.txt"
ls -l "$OUT"
