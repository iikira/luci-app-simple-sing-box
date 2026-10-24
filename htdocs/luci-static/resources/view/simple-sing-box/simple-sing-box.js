'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require rpc';
'require poll';

// RPC declarations against the luci.simple-sing-box ubus backend.
// Use `expect: {}` (empty) so the full response object is returned and we can
// read both `version` and `error`. A non-empty `expect` would collapse the
// result to its first key's value (a string), losing the object shape.
const callVersion = rpc.declare({
	object: 'luci.simple-sing-box',
	method: 'version',
	params: [],
	expect: {},
});

const callSubscribeOnce = rpc.declare({
	object: 'luci.simple-sing-box',
	method: 'subscribe_once',
	params: [],
	expect: {},
});

const callStatus = rpc.declare({
	object: 'luci.simple-sing-box',
	method: 'status',
	params: [],
	expect: {},
});

const callReload = rpc.declare({
	object: 'luci.simple-sing-box',
	method: 'reload',
	params: [],
	expect: {},
});

const callRestart = rpc.declare({
	object: 'luci.simple-sing-box',
	method: 'restart',
	params: [],
	expect: {},
});

// Interval presets shown in the UI. The stored value is always seconds.
const INTERVAL_PRESETS = [
	['0',      _('Disabled')],
	['3600',   _('Every 1 hour')],
	['21600',  _('Every 6 hours')],
	['43200',  _('Every 12 hours')],
	['86400',  _('Every 1 day')],
	['172800', _('Every 2 days')],
	['604800', _('Every 1 week')],
];

return view.extend({
	// Fetch the sing-box version string, daemon run state, and the UCI config.
	load: function () {
		return Promise.all([
			L.resolveDefault(callVersion(), { version: '', error: '' }),
			L.resolveDefault(callStatus(), { running: false, pid: null }),
			uci.load('simple-sing-box'),
		]);
	},

	render: function (data) {
		const versionInfo = data[0] || {};
		const statusInfo = data[1] || { running: false, pid: null };

		// Build the config form bound to the simple-sing-box.main section.
		// Saving is handled by the framework; see the save handlers below,
		// which restart the service only when that is actually needed.
		const m = new form.Map('simple-sing-box',
			_('Simple Sing-Box'),
			_('Background daemon and subscription auto-update for sing-box.'));

		const s = m.section(form.NamedSection, 'main', 'simple-sing-box', _('Main Settings'));
		s.addremove = false;
		s.anonymous = true;

		let o;

		o = s.option(form.Flag, 'enabled', _('Enabled'),
			_('Run the sing-box background daemon on boot.'));
		o.rmempty = false;

		o = s.option(form.Value, 'subscribe_url', _('Subscribe URL'),
			_('Subscription endpoint fetched by wget. Leave empty to disable downloads (no config.json update).'));
		o.placeholder = 'https://example.com/config.json';
		// Allow empty: `optional` lets the field pass validation when blank.
		o.optional = true;
		o.rmempty = true;

		o = s.option(form.Flag, 'subscribe_auto_upgrade', _('Auto upgrade'),
			_('Periodically download and apply the subscription.'));
		o.rmempty = false;

		// Upgrade interval: a Value (free numeric input, in seconds) that also
		// offers presets from the dropdown. Stored as seconds. 0 disables.
		o = s.option(form.Value, 'subscribe_upgrade_interval_second',
			_('Upgrade interval (seconds)'),
			_('How often the subscription is pulled, in seconds. Pick a preset or enter a custom value. 0 disables.'));
		for (let i = 0; i < INTERVAL_PRESETS.length; i++) {
			o.value(INTERVAL_PRESETS[i][0], INTERVAL_PRESETS[i][1]);
		}
		o.datatype = 'uinteger';
		o.default = '0';
		o.rmempty = false;
		// Show the interval row only when auto upgrade is enabled.
		o.depends('subscribe_auto_upgrade', '1');

		o = s.option(form.Flag, 'verify', _('Verify TLS'),
			_('Validate the TLS certificate when downloading the subscription.'));
		o.rmempty = false;
		o.default = '1';

		o = s.option(form.Flag, 'log_stderr', _('Log stderr'),
			_('Forward sing-box stderr to the system log.'));
		o.rmempty = false;
		o.default = '1';

		// conffile and workdir are intentionally not editable from the UI:
		// they are fixed in the package (and not stored in UCI at all).
		// They are still shown in the status banner below for visibility.
		const conffile = '/etc/simple-sing-box/config.json';
		const workdir = '/usr/share/simple-sing-box';
		const runStatusEl = E('span', { id: 'simple-sing-box-runstatus' });

		// Force a full service restart (stop+start, ignoring the settings
		// fingerprint). It lives here, inline in the status banner next to the
		// daemon run state, because that is where a restart action belongs and
		// where it is visible without scrolling to the bottom of the page.
		// This is a synchronous ubus call — procd's stop+start is fast (a few
		// seconds at most), well under the ~30s uhttpd ceiling, so unlike the
		// subscription update we can simply wait for the result.
		// ui.createHandlerFn keeps the button disabled while the returned
		// promise is pending, so a double-click cannot trigger two restarts.
		const restartBtn = E('button', {
			class: 'btn cbi-button cbi-button-neutral',
			style: 'margin-left:.5em',
			click: ui.createHandlerFn(this, function () {
				const label = restartBtn.textContent;
				restartBtn.textContent = _('Restarting...');
				return L.resolveDefault(callRestart(), { success: false, message: _('no response') })
					.then(function (res) {
						restartBtn.textContent = label;
						if (res && res.success) {
							ui.addNotification(null,
								E('p', _('Service restarted.')), 'success');
						} else {
							ui.addNotification(null,
								E('p', _('Restart failed: %s')
									.format((res && res.message) || _('no response'))), 'danger');
						}
					});
			}),
		}, _('Restart service'));

		const versionEl = E('div', { class: 'alert-message success' }, [
			E('strong', {}, _('sing-box version: ')),
			E('span', {}, _('(unknown)')),
			E('br'),
			E('strong', {}, _('Daemon: ')),
			runStatusEl,
			restartBtn,
			E('br'),
			E('strong', {}, _('Config file: ')),
			E('span', {}, conffile),
			E('br'),
			E('strong', {}, _('Working directory: ')),
			E('span', {}, workdir),
		]);
		let statusEl;
		if (versionInfo.error || !versionInfo.version) {
			statusEl = E('div', { class: 'alert-message warning' }, [
				E('strong', {}, _('sing-box not installed: ')),
				E('span', {}, _('Install sing-box before enabling the service.')),
			]);
		} else {
			statusEl = versionEl;
			// Fix the version text now that we know it.
			versionEl.querySelector('span').textContent = versionInfo.version;
		}

		// The last subscription-update result we have seen; used to detect when a
		// background update started from this page has finished.
		let lastUpdateTime = (statusInfo.last_update && statusInfo.last_update.time) || 0;
		// Non-null while we are waiting for a background update to report back.
		let watchingUpdate = null;

		// Render the run-status text (Running (PID x) / Not running) into the banner
		// span. The subscription-loop state is intentionally not shown here: it is
		// implied by the auto-upgrade toggle below.
		function renderRunStatus(info) {
			if (!info) info = { running: false, pid: null };
			runStatusEl.textContent = info.running
				? _('Running (PID %d)').format(info.pid)
				: _('Not running');
			// Recolor the banner based on daemon run state.
			versionEl.classList.toggle('warning', !info.running);
			versionEl.classList.toggle('success', !!info.running);
		}
		renderRunStatus(statusInfo);

		// Stop watching for a background update and report its outcome.
		function stopWatching(update) {
			if (update) {
				if (update.ok) {
					ui.addNotification(null,
						E('p', _('Subscription updated successfully.')), 'success');
				} else {
					ui.addNotification(null,
						E('p', _('Update failed: %s')
							.format(update.message || _('unknown error'))), 'danger');
				}
			}
			if (watchingUpdate) {
				updateBtn.textContent = watchingUpdate.label;
				// Resolve the button handler's promise; LuCI re-enables the
				// button when it settles.
				watchingUpdate.resolve();
				watchingUpdate = null;
			}
		}

		// Poll the run state so the banner reflects reality, and pick up the result
		// of a background update started from this page.
		this.pollFn = L.bind(function () {
			return L.resolveDefault(callStatus(), null).then(function (info) {
				if (!info) return;
				renderRunStatus(info);
				const t = (info.last_update && info.last_update.time) || 0;
				if (watchingUpdate) {
					if (t && t !== watchingUpdate.baseline) {
						stopWatching(info.last_update);
					} else if (Date.now() > watchingUpdate.deadline) {
						ui.addNotification(null,
							E('p', _('The update is still running in the background; check the log for the result.')),
							'info');
						stopWatching(null);
					}
				}
				if (t) lastUpdateTime = t;
			});
		}, this);
		poll.add(this.pollFn, 5);
		poll.start();

		// One-shot subscription update button. The download may take up to 60s,
		// which is longer than a synchronous ubus call may block for (uhttpd closes
		// the connection at ~30s), so this only *starts* the update in the
		// background; the poller above reports the result.
		const updateBtn = E('button', {
			class: 'btn cbi-button cbi-button-action important',
			click: ui.createHandlerFn(this, function () {
				// Ignore extra clicks while an update is in flight.
				if (watchingUpdate)
					return;
				const label = updateBtn.textContent;
				updateBtn.textContent = _('Updating...');
				return L.resolveDefault(callSubscribeOnce(), { started: false, message: _('no response') })
					.then(function (res) {
						if (!res || !res.started) {
							updateBtn.textContent = label;
							ui.addNotification(null,
								E('p', _('Could not start the update: %s')
									.format((res && res.message) || _('no response'))), 'danger');
							return;
						}
						ui.addNotification(null,
							E('p', _('Subscription update started.')), 'info');
						// Keep the returned promise pending until the background update
						// reports back, so LuCI keeps the button disabled meanwhile.
						return new Promise(function (resolve) {
							watchingUpdate = {
								baseline: lastUpdateTime,
								deadline: Date.now() + 150000,
								label: label,
								resolve: resolve,
							};
						});
					});
			}),
		}, _('Update subscription now'));

		const buttonRow = E('div', { class: 'cbi-page-actions' }, [updateBtn]);

		return m.render().then(function (node) {
			node.insertBefore(statusEl, node.firstChild);
			node.appendChild(buttonRow);
			return node;
		});
	},

	// Save handlers. We mirror LuCI's default view handlers exactly: the map's
	// `save()` stages+commits the UCI changes, and `ui.changes.apply()` runs
	// the platform apply (restarting affected services). A bare
	// `map.save(null, true)` does NOT commit, so the enabled toggle never took
	// effect. After the platform apply we additionally call our own ubus
	// `reload` (stop+start), because on OpenWrt 25 (apk) the platform apply does
	// not reliably restart this app's service.
	handleSave: function (ev) {
		const tasks = [];
		document.getElementById('maincontent').querySelectorAll('.cbi-map').forEach(function (map) {
			tasks.push(DOM.callClassMethod(map, 'save'));
		});
		return Promise.all(tasks);
	},

	handleSaveApply: function (ev, mode) {
		return this.handleSave(ev).then(L.bind(function () {
			return ui.changes.apply(mode == '0');
		}, this)).then(function () {
			// Ask the init script to reload; it restarts the service only when
			// a setting the instances depend on actually changed, so e.g. an
			// URL-only edit does not drop the running connections.
			return L.resolveDefault(callReload(),
				{ success: false, message: _('no response') });
		});
	},

	handleReset: function (ev) {
		const tasks = [];
		document.getElementById('maincontent').querySelectorAll('.cbi-map').forEach(function (map) {
			tasks.push(DOM.callClassMethod(map, 'reset'));
		});
		return Promise.all(tasks);
	},
});
