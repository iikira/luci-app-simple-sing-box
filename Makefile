#
# Copyright (C) 2026 iikira <iikira@users.noreply.github.com>
#
# This is free software, licensed under the MIT License.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-simple-sing-box
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT License
PKG_MAINTAINER:=iikira <iikira@users.noreply.github.com>

# No dependency on sing-box: it is expected to be installed separately, so
# this LuCI app stays decoupled from any specific sing-box package.
LUCI_TITLE:=Simple sing-box daemon and subscription auto-update
LUCI_DEPENDS:=
LUCI_PKGARCH:=all

include $(TOPDIR)/package/luci/luci.mk

define Package/luci-app-simple-sing-box/description
  Background daemon and subscription auto-update for sing-box. Manages a
  procd-supervised sing-box instance and optionally pulls a subscription on an
  interval, validating each download with `sing-box check` before swapping it
  in. Does not depend on sing-box itself.
endef

$(eval $(call BuildPackage,luci-app-simple-sing-box))
