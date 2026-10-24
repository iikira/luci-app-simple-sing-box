#!/usr/bin/env bash
# Build an OpenWrt .apk from a staged filesystem tree.
#
# Adapted from https://github.com/SagerNet/sing-box/blob/stable/.github/build_openwrt_apk.sh
# which packs a single binary. This variant packs a whole directory tree,
# which is what a LuCI app needs.
#
# Usage:
#   build_openwrt_apk.sh <architecture> <version> <staging_dir> <output.apk> [sign_key]
#
#   staging_dir  A directory laid out exactly as it should appear on the
#                target (e.g. it contains ./www/..., ./etc/init.d/..., etc).

set -e -o pipefail

prepare_apk_root() {
  # apk mkpkg resolves owner/group names through --root/etc/{passwd,group}.
  APK_ROOT_DIR=$(mktemp -d)
  mkdir -p "$APK_ROOT_DIR/etc"
  cat > "$APK_ROOT_DIR/etc/passwd" <<EOF
root:x:$(id -u):$(id -g):root:/root:/sbin/nologin
EOF
  cat > "$APK_ROOT_DIR/etc/group" <<EOF
root:x:$(id -g):root
EOF
}

ARCHITECTURE="$1"
VERSION="$2"
STAGING_DIR="$3"
OUTPUT_PATH="$4"
SIGN_KEY="${5:-}"
PACKAGE_NAME="${6:-luci-app-simple-sing-box}"

if [ -z "$ARCHITECTURE" ] || [ -z "$VERSION" ] || [ -z "$STAGING_DIR" ] || [ -z "$OUTPUT_PATH" ]; then
  echo "Usage: $0 <architecture> <version> <staging_dir> <output_path> [sign_key] [package_name]" >&2
  exit 1
fi

if [ ! -d "$STAGING_DIR" ]; then
  echo "staging dir not found: $STAGING_DIR" >&2
  exit 1
fi

# Convert version to APK format:
#   9.99.9-DEV-20261024123456 -> 9.99.9_p20261024123456-r0
#   1.75.0-20261024123456    -> 1.75.0_p20261024123456-r0
#   1.13.0-beta.8            -> 1.13.0_beta8-r0
#   1.13.0-rc.3              -> 1.13.0_rc3-r0
#   1.13.0                   -> 1.13.0-r0
# A '-' is only legal in apk versions as the '-r<rev>' suffix, and a '_'
# must start a known suffix word (alpha/beta/pre/rc/cvs/svn/git/hg/p),
# so dash-separated pre-release parts are rewritten to '_p<digits>'.
APK_VERSION=$(echo "$VERSION" | sed -E 's/-([a-z]+)\.([0-9]+)/_\1\2/g')
APK_VERSION=$(echo "$APK_VERSION" | sed -E 's/-[A-Za-z][A-Za-z0-9.]*-([0-9]+)/_p\1/g')
APK_VERSION=$(echo "$APK_VERSION" | sed -E 's/-([0-9]+)/_p\1/g')
APK_VERSION="${APK_VERSION}-r0"

ROOT_DIR=$(mktemp -d)
prepare_apk_root
trap 'rm -rf "$ROOT_DIR" "$APK_ROOT_DIR"' EXIT

# Copy the staged tree into the apk rootfs as the package payload.
mkdir -p "$ROOT_DIR"
cp -a "$STAGING_DIR/." "$ROOT_DIR/"

# Make sure executable scripts keep their mode (cp -a preserves it).

# APK metadata
PACKAGES_DIR="$ROOT_DIR/lib/apk/packages"
mkdir -p "$PACKAGES_DIR"

# .list (all files, excluding lib/apk/packages/ metadata)
# Named per-package per OpenWrt convention so packages don't fight over a
# single .list when multiple are installed side-by-side.
# Emit files and symlinks separately to stay BusyBox-friendly.
( cd "$ROOT_DIR" && find . -type f; cd "$ROOT_DIR" && find . -type l ) \
  | sed 's|^\./|/|' \
  | grep -v '^/lib/apk/packages/' \
  | sort > "$PACKAGES_DIR/$PACKAGE_NAME.list"

# Build APK. No `depends:` line: this LuCI app deliberately does not declare a
# dependency on sing-box (the user is expected to install it separately).
# Build the optional sign-key argument as a plain string (not a bash array)
# so this script also runs under BusyBox ash.
SIGN_ARGS=""
if [ -n "$SIGN_KEY" ]; then
  SIGN_ARGS="--sign-key $SIGN_KEY"
fi
# shellcheck disable=SC2086  # intentional word-splitting of SIGN_ARGS
apk --root "$APK_ROOT_DIR" mkpkg \
  $SIGN_ARGS \
  --info "name:$PACKAGE_NAME" \
  --info "version:${APK_VERSION}" \
  --info "description:Simple sing-box daemon and subscription auto-update" \
  --info "arch:${ARCHITECTURE}" \
  --info "origin:$PACKAGE_NAME" \
  --info "maintainer:iikira <iikira@users.noreply.github.com>" \
  --files "$ROOT_DIR" \
  --output "$OUTPUT_PATH"

# Verify the signature when a signing key was used.
# The private key is all we require: derive the matching public key at
# runtime with openssl and verify against it, so the caller only needs to
# ship the private key (matching how the CI secret is a single private key).
# The public key is written next to the private key as "<privkey>.pub",
# which is the filename apk looks up in --keys-dir.
if [ -n "$SIGN_KEY" ]; then
  PUBKEY_DIR="$(dirname "$SIGN_KEY")"
  PUBKEY="${SIGN_KEY}.pub"
  openssl rsa -in "$SIGN_KEY" -pubout -out "$PUBKEY"
  apk verify --keys-dir "$PUBKEY_DIR" "$OUTPUT_PATH"
fi
