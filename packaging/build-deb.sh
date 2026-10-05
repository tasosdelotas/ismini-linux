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

# Fresh staging tree. The app installs to ~/ismini (user-owned, like install.sh)
# — dpkg-deb expands ~ in file paths at install time for each user.
rm -rf "$BUILD"
mkdir -p "$BUILD/root/.install-ismini"
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
    -cf - . ) | tar -C "$BUILD/root/.install-ismini" -xf -

# Ensure the launcher is executable inside the package.
chmod +x "$BUILD/root/.install-ismini/ismini"

# Maintainer scripts (must be root-owned, 0755).
cp "$PKG/debian/control"   "$BUILD/DEBIAN/control"
cp "$PKG/debian/postinst"  "$BUILD/DEBIAN/postinst"
cp "$PKG/debian/prerm"     "$BUILD/DEBIAN/prerm"
cp "$PKG/debian/postrm"    "$BUILD/DEBIAN/postrm"
chmod 0755 "$BUILD/DEBIAN/postinst" "$BUILD/DEBIAN/prerm" "$BUILD/DEBIAN/postrm"

# Build the .deb.
dpkg-deb --build "$BUILD" "$OUT" >/dev/null

echo ""
echo "Built: $OUT"
ls -lh "$OUT"
