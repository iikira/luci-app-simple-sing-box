#!/usr/bin/env bash
# Build an OpenWrt .ipk from a staged filesystem tree.
#
# A .ipk is an `ar` archive of three members:
#   debian-binary   -> "2.0\n"
#   control.tar.gz  -> ./control, ./conffiles, ./postinst, ./prerm, ...
#   data.tar.gz     -> the payload tree (./usr/..., ./etc/..., ./www/...)
#
# Usage:
#   build_openwrt_ipk.sh <architecture> <version> <staging_dir> <output.ipk> [package_name]
#
#   staging_dir  A directory laid out exactly as it should appear on the
#                target (e.g. it contains ./www/..., ./etc/init.d/..., etc).

set -e -o pipefail

ARCHITECTURE="$1"
VERSION="$2"
STAGING_DIR="$3"
OUTPUT_PATH="$4"
PACKAGE_NAME="${5:-luci-app-simple-sing-box}"

if [ -z "$ARCHITECTURE" ] || [ -z "$VERSION" ] || [ -z "$STAGING_DIR" ] || [ -z "$OUTPUT_PATH" ]; then
  echo "Usage: $0 <architecture> <version> <staging_dir> <output_path> [package_name]" >&2
  exit 1
fi

if [ ! -d "$STAGING_DIR" ]; then
  echo "staging dir not found: $STAGING_DIR" >&2
  exit 1
fi

# ipk control Version field allows a single optional revision suffix
# ("-rN"); OpenWrt normally formats "<ver>-r<rel>". We keep the version as
# given and append -r1 if no revision suffix is present.
IPK_VERSION="$VERSION"
case "$IPK_VERSION" in
  *-r[0-9]*) ;;
  *) IPK_VERSION="${IPK_VERSION}-r1" ;;
esac

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# ---- data.tar.gz : the payload ---------------------------------------------
# Preserve modes. Avoid GNU-only tar flags (--owner/--group) so the script
# works under BusyBox tar as well as GNU tar. We normalise ownership by
# running as root in CI / on the device, where files are already root-owned.
DATA_TAR="$WORK_DIR/data.tar.gz"
( cd "$STAGING_DIR" && tar czf "$DATA_TAR" . )

# ---- control.tar.gz : control metadata -------------------------------------
CONTROL_DIR="$WORK_DIR/control"
mkdir -p "$CONTROL_DIR"

# Installed-Size is the sum of regular file sizes in bytes (rounded up to 1K
# is common, but raw bytes is fine). Use BusyBox-compatible `wc -c` over a
# `find` + `wc` pipeline rather than GNU's `find -printf`.
INSTALLED_SIZE=$(
  cd "$STAGING_DIR" && \
  find . -type f -exec wc -c {} \; 2>/dev/null \
    | awk '{ s += $1 } END { print s+0 }'
)

cat > "$CONTROL_DIR/control" <<EOF
Package: $PACKAGE_NAME
Version: $IPK_VERSION
Architecture: $ARCHITECTURE
Maintainer: iikira <iikira@users.noreply.github.com>
Section: luci
Priority: optional
Installed-Size: $INSTALLED_SIZE
Description: Simple sing-box daemon and subscription auto-update.
 Background daemon and subscription auto-update for sing-box. Manages a
 procd-supervised sing-box instance and optionally pulls a subscription on
 an interval, validating each download with sing-box check before
 swapping it in. Does not depend on sing-box itself.
EOF

# No dependency on sing-box: it is expected to be installed separately.

# Mark config files as conffiles so opkg preserves user edits across upgrade.
cat > "$CONTROL_DIR/conffiles" <<'EOF'
/etc/config/simple-sing-box
EOF

# postinst: enable + (if enabled) start the service, and ensure modes.
cat > "$CONTROL_DIR/postinst" <<'EOF'
#!/bin/sh
[ -d /etc/simple-sing-box ] || mkdir -p /etc/simple-sing-box
[ -d /usr/share/simple-sing-box ] || mkdir -p /usr/share/simple-sing-box
chmod 0755 /etc/init.d/simple-sing-box 2>/dev/null
chmod 0755 /usr/libexec/simple-sing-box-subscribe 2>/dev/null
/etc/init.d/simple-sing-box enable 2>/dev/null
/etc/init.d/simple-sing-box start 2>/dev/null
exit 0
EOF
chmod 0755 "$CONTROL_DIR/postinst"

CONTROL_TAR="$WORK_DIR/control.tar.gz"
( cd "$CONTROL_DIR" && tar czf "$CONTROL_TAR" . )

# ---- debian-binary ---------------------------------------------------------
printf '2.0\n' > "$WORK_DIR/debian-binary"

# ---- assemble the .ipk with ar ---------------------------------------------
# Order matters: debian-binary, control.tar.gz, data.tar.gz.
ar rc "$OUTPUT_PATH" \
  "$WORK_DIR/debian-binary" \
  "$CONTROL_TAR" \
  "$DATA_TAR"

echo "built: $OUTPUT_PATH"
