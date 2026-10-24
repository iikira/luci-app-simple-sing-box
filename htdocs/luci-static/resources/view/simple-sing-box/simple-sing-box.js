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
		// Saving and applying is handled automatically by the framework for
		// form.Map views, so we do not define handleSaveApply/handleSave/
		// handleReset here.
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
		const versionEl = E('div', { class: 'alert-message success' }, [
			E('strong', {}, _('sing-box version: ')),
			E('span', {}, _('(unknown)')),
			E('br'),
			E('strong', {}, _('Daemon: ')),
			runStatusEl,
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

		// Render the run-status text (Running (PID x) / Not running) into the
		// banner span. The subscription-loop state is intentionally not shown
		// here: it is implied by the auto-upgrade toggle below.
		function renderRunStatus(info) {
			if (!info) info = { running: false, pid: null };
			let text;
			if (info.running) {
				text = _('Running (PID %d)').format(info.pid);
			} else {
				text = _('Not running');
			}
			runStatusEl.textContent = text;
			// Recolor the banner based on daemon run state.
			if (info.running) {
				versionEl.classList.remove('warning');
				versionEl.classList.add('success');
			} else {
				versionEl.classList.remove('success');
				versionEl.classList.add('warning');
			}
		}
		renderRunStatus(statusInfo);

		// Poll the run state periodically so the banner reflects reality.
		this.pollFn = L.bind(function () {
			return L.resolveDefault(callStatus(), null).then(function (info) {
				if (info) renderRunStatus(info);
			});
		}, this);
		poll.add(this.pollFn, 5);
		poll.start();

		// One-shot subscription update button. Runs the updater immediately
		// via the ubus backend and reports the result as a notification.
		const updateBtn = E('button', {
			class: 'btn cbi-button cbi-button-action important',
			click: ui.createHandlerFn(this, function () {
				updateBtn.disabled = true;
				const original = updateBtn.textContent;
				updateBtn.textContent = _('Updating...');
				L.resolveDefault(callSubscribeOnce(), { success: false, message: _('no response') })
					.then(function (res) {
						updateBtn.disabled = false;
						updateBtn.textContent = original;
						if (res && res.success) {
							ui.addNotification(null,
								E('p', _('Subscription updated successfully.')), 'success');
						} else {
							const msg = (res && res.message) ? res.message : _('unknown error');
							ui.addNotification(null,
								E('p', _('Update failed: %s').format(msg)), 'danger');
						}
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
