# luci-app-simple-sing-box

A minimal OpenWrt LuCI app for managing a sing-box background daemon and
subscription auto-update. It does **not** declare a dependency on sing-box —
sing-box must be installed separately (the app just calls `sing-box run` and
`sing-box check`).

## Features

- Background daemon via procd (`/etc/init.d/simple-sing-box`) that runs
  `sing-box run` under supervision with respawn, file-watch reload, and raised
  `nofile`/`core` limits.
- Optional subscription auto-update: periodically downloads the configured URL
  with `wget`, validates it with `sing-box check`, and only swaps the new
  config in once it passes — a broken download never replaces a working config.
- LuCI frontend (modern client-side JS view) that:
  - shows the installed sing-box version, or a clear warning if sing-box is
    missing;
  - toggles `enabled`, `subscribe_url`, `subscribe_auto_upgrade`,
    `subscribe_upgrade_interval` (presets + custom seconds, stored as seconds),
    `verify` (TLS certificate validation on download), and `log_stderr`;
  - exposes an "Update subscription now" button;
  - shows the live daemon run state (Running (PID x) / Not running), refreshed
    via a poller.

## UCI config

`/etc/config/simple-sing-box`:

```
config simple-sing-box 'main'
	option enabled '0'
	option subscribe_url ''
	option subscribe_auto_upgrade '0'
	option subscribe_upgrade_interval_second '0'
	option verify '1'
	option log_stderr '1'
```

- `subscribe_upgrade_interval_second` is stored in seconds. `0` disables the
  scheduler. The frontend exposes common presets (1h / 6h / 12h / 1d / 2d / 1w)
  plus free numeric entry (any custom value in seconds).
- `verify` (default on) controls TLS certificate validation when downloading
  the subscription. Off passes `--no-check-certificate` to wget.
- When `subscribe_auto_upgrade=1` and the interval is non-zero, the init script
  starts a second procd-supervised instance that pulls the subscription on that
  interval.
- If `subscribe_url` is empty, the updater does nothing and never touches the
  existing config.json.
- The sing-box config file (`/etc/simple-sing-box/config.json`) and working
  directory (`/usr/share/simple-sing-box`) are fixed by the package and are not
  configurable via UCI. They are shown (read-only) on the status banner.

## Packaging

Built as both `.ipk` (opkg, `Architecture: all`) and `.apk` (`arch: noarch`),
since this is a pure-script package with no compiled binaries (no architecture
dependency). GitHub Actions (`.github/workflows/build.yml`) builds both on push
to `main` and on tags, uploading the artifacts and attaching them to a **draft**
release on tag push (reviewed and published manually).

## Layout

```
htdocs/luci-static/resources/view/simple-sing-box/simple-sing-box.js  # LuCI view
root/etc/init.d/simple-sing-box                                       # procd daemon
root/usr/libexec/simple-sing-box-subscribe                            # updater (once / loop)
root/usr/share/rpcd/ucode/luci.simple-sing-box                        # ubus RPC backend
root/usr/share/rpcd/acl.d/luci-app-simple-sing-box.json               # ACL
root/usr/share/ucitrack/simple-sing-box.json                          # uci -> reload
root/etc/config/simple-sing-box                                       # default config
root/etc/uci-defaults/simple-sing-box                                 # first-boot setup
Makefile                                                              # buildroot package def
.github/build_openwrt_apk.sh                                           # .apk packer
.github/build_openwrt_ipk.sh                                           # .ipk packer
.github/workflows/build.yml                                           # CI
```

## License

MIT License. See [LICENSE](LICENSE).
