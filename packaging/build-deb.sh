#!/bin/bash
# build-deb.sh — builds ismini_<version>_amd64.deb from the repo.
# Run from anywhere:  bash packaging/build-deb.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # repo root
PKG="$ROOT/packaging"
BUILD="$PKG/build"
VERSION="$(node -e "console.log(require('$ROOT/package.json').version)")"
ARCH="amd64"
OUT="$ROOT/ismini_${VERSION}_${ARCH}.deb"

echo "Building ismini ${VERSION} (${ARCH})..."

# Fresh staging tree.
rm -rf "$BUILD"
mkdir -p "$BUILD/opt/ismini"
mkdir -p "$BUILD/DEBIAN"

# Copy the app (everything except VCS, packaging scaffolding, and personal data).
( cd "$ROOT" && tar \
    --exclude='./.git' \
    --exclude='./packaging' \
    --exclude='./test' \
    --exclude='./sessions.json' \
    --exclude='./sessions.json.*' \
    --exclude='./memory.json' \
    --exclude='./memory.json.*' \
    --exclude='./ismini.log' \
    --exclude='./ismini.pid' \
    --exclude="./ismini_${VERSION}_${ARCH}.deb" \
    -cf - . ) | tar -C "$BUILD/opt/ismini" -xf -

# Ensure the launcher is executable inside the package.
chmod +x "$BUILD/opt/ismini/ismini"

# Maintainer scripts (must be root-owned, 0755).
cp "$PKG/debian/control"   "$BUILD/DEBIAN/control"
cp "$PKG/debian/postinst"  "$BUILD/DEBIAN/postinst"
cp "$PKG/debian/prerm"     "$BUILD/DEBIAN/prerm"
cp "$PKG/debian/postrm"    "$BUILD/DEBIAN/postrm"
chmod 0755 "$BUILD/DEBIAN/postinst" "$BUILD/DEBIAN/prerm" "$BUILD/DEBIAN/postrm"

# Build the .deb.
dpkg-deb --build --root-owner-group "$BUILD" "$OUT" >/dev/null

echo ""
echo "Built: $OUT"
ls -lh "$OUT"
