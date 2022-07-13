/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
/* global _, DTM, $, $$, Utils, Preferences, getDefaultDownloadsDirectory, unloadWindow */
/* global $e, mapInSitu, filterMapInSitu, filterInSitu, mapFilterInSitu, setTimeoutOnlyFun */
/* global toURI, toURL, showPreferences, openUrl, getLargeIcon */
/* global TreeManager, Prefs, ConflictManager */
/* global QUEUED, PAUSED, CANCELED, FINISHING, COMPLETE, RUNNING, SPEED_COUNT, REFRESH_FREQ, MIN_CHUNK_SIZE */
/* jshint strict:true, globalstrict:true, browser:true, latedef:false */

var {CoThreadListWalker} = require("support/cothreads");
var Prompts = require("prompts");
var {ByteBucket} = require("support/bytebucket");
var {GlobalBucket} = require("manager/globalbucket");
var {defer} = require("support/defer");
var PrivateBrowsing = require("support/pbm");
var {ContentHandling} = require("support/contenthandling");
var GlobalProgress = new (require("manager/globalprogress").GlobalProgress)(window);
var RequestManipulation = require("support/requestmanipulation");
var Limits = require("support/serverlimits");
var {QueueStore} = require("manager/queuestore");
var {SpeedStats} = require("manager/speedstats");
var {FileExtensionSheet} = require("support/fileextsheet");
var {UrlManager} = require("support/urlmanager");
var {VisitorManager} = require("manager/visitormanager");
var Preallocator = require("manager/preallocator");
var {Chunk, hintChunkBufferSize} = require("manager/chunk");
var {Connection} = require("manager/connection");
var {createRenamer} = require("manager/renamer");
var {memoize, identity} = require("support/memoize");
var {moveFile} = require("support/movefile");

// Use the main OS.File here!
var {OS} = requireJSM("resource://gre/modules/osfile.jsm");

/* global Version, AlertService, Decompressor, Verificator, FileExts:true */
XPCOMUtils.defineLazyGetter(window, "Version", () => require("version"));
XPCOMUtils.defineLazyGetter(window, "AlertService", () => require("support/alertservice"));
XPCOMUtils.defineLazyGetter(window, "Decompressor", () => require("manager/decompressor").Decompressor);
XPCOMUtils.defineLazyGetter(window, "Verificator", () => require("manager/verificator"));
XPCOMUtils.defineLazyGetter(window, "FileExts", () => new FileExtensionSheet(window, Tree));
XPCOMUtils.defineLazyGetter(window, "ConflictManager", () => {
	return new (require("manager/conflicts"))(
		window, Utils.formatConflictName.bind(Utils), Prefs, _);
});

let speedElems;

/* global TextCache_PAUSED, TextCache_QUEUED, TextCache_COMPLETE, TextCache_CANCELED, TextCache_NAS */
/* global TextCache_UNKNOWN, TextCache_OFFLINE, TextCache_TIMEOUT, TextCache_STARTING, TextCache_DECOMPRESSING */
/* global TextCache_VERIFYING, TextCache_MOVING, TextCache_FINISHING */
addEventListener("load", function load_textCache() {
	removeEventListener("load", load_textCache, false);
	speedElems = $('listSpeeds', 'perDownloadSpeedLimitList');
	const texts = ['paused', 'queued', 'complete', 'canceled', 'nas', 'unknown',
		'offline', 'timeout', 'starting', 'decompressing', 'verifying', 'moving',
		'finishing',
	];
	for (let i = 0, text; i < texts.length; ++i) {
		text = texts[i];
		window["TextCache_" + text.toUpperCase()] = _(text);
	}
}, false);

function isOSError(ex, unix, win) {
	if (ex.unixErrno) {
		return OS.Constants.libc[unix] === ex.unixErrno;
	}
	if (ex.winLastError) {
		return OS.Constants.Win[win] === ex.winLastError;
	}
	return false;
}

function timeout(secs) {
	return new Promise(function(resolve) {
		setTimeoutOnlyFun(() => resolve(), secs);
	});
}

function _moveFile(destination, self) {
	let remakeDir = false;
	let move = async function() {
		for (let x = 0; x < 10; ++x) {
			if (remakeDir) {
				await Utils.makeDir(destination, Prefs.dirPermissions, true);
			}
			let df = destination.clone();
			df.append(self.destinationName);
			try {
				await moveFile(self.tmpFile.path, df.path, self.shouldOverwrite);
				return;
			}
			catch (ex) {
				if (isOSError(ex, "EEXIST", "ERROR_ALREADY_EXISTS") && !self.shouldOverwrite) {
					self.conflicts += 1;
					x--;
					continue;
				}
				if (isOSError(ex, "ENAMETOOLONG", "ERROR_PATH_NOT_FOUND")) {
					try {
						let pinned = self.destinationFile;
						self.shortenName();
						ConflictManager.unpin(pinned);
						pinned = self.destinationFile;
						ConflictManager.pin(pinned, !self.shouldOverwrite);
					}
					catch (iex) {
						log(LOG_ERROR, "Failed to shorten name", ex);
					}
				}
				if (ex.becauseNoSuchFile || isOSError(ex, "ENOENT", "NONE")) {
					remakeDir = true;
				}
				log(LOG_ERROR, ex);
				await timeout(x * 500);
			}
		}
		log(LOG_ERROR, "shit hit the fan!");
		throw new Exception("Failed to move file");
	};
	return move();
};

function dieEarly() {
	window.removeEventListener("unload", dieEarly, false);
	let evt = document.createEvent("Event");
	evt.initEvent("DTM:diedEarly", true, false);
	window.dispatchEvent(evt);
}
window.addEventListener("unload", dieEarly, false);

function _downloadChunk(download, chunk, header) {
	chunk.download = new Connection(download, chunk, header || download.mustGetInfo);
	chunk.running = true;
	download.mustGetInfo = false;
	download.setState(RUNNING);
	log(LOG_DEBUG, "started: " + chunk);
	++download.activeChunks;
	++download.sessionConnections;
}
function downloadNewChunk(download, start, end, header) {
	let chunk = new Chunk(download, start, end);
	download.chunks.push(chunk);
	download.chunks.sort(function(a,b) { return a.start - b.start; });
	_downloadChunk(download, chunk, header);
}
function downloadOldChunk(download, chunk, header) {
	if (chunk.wasOpened) {
		let idx = download.chunks.indexOf(chunk);
		if (idx < 0) {
			throw Error("Invalid chunk");
		}
		let newChunk = chunk.clone();
		download.chunks[idx] = newChunk;
		_downloadChunk(download, newChunk, header);
	}
	else {
		_downloadChunk(download, chunk, header);
	}
}

var Dialog_loadDownloads_props =
	['contentType', 'conflicts', 'postData', 'destinationName', 'resumable', 'compression',
		'fromMetalink', 'speedLimit', "cleanRequest"];
function Dialog_loadDownloads_get(down, attr, def) {
	return (attr in down) ? down[attr] : (def ? def : '');
};

var Dialog_serialize_props =
	['fileName', 'fileNameFromUser', 'postData', 'description', 'title', 'resumable', 'mask', 'pathName',
		'compression', 'contentType', 'conflicts', 'fromMetalink', 'speedLimit', "relaxSize", "cleanRequest"];

var Tree;
var Dialog = {
	_observes: [
		'quit-application-requested',
		'quit-application-granted',
		'network:offline-status-changed',
		'DTM:filterschanged',
		'DTM:clearedQueueStore',
		'DTM:shutdownQueueStore',
		"DTM:upgrade",
	],
	_initialized: false,
	_autoRetrying: [],
	_offline: false,
	_maxObservedSpeed: 0,

	get offline() {
		return this._offline || this._offlineForced || false;
	},
	set offline(nv) {
		this._offline = !!nv;
		$('cmdToggleOffline').setAttribute('disabled', this._offline);
		this._processOfflineChange();
		return this._offline;
	},
	get offlineForced() {
		return this._offlineForced;
	},
	set offlineForced(nv) {
		this._offlineForced = !!nv;
		let netstatus = $('netstatus');
		if (this._offlineForced) {
			netstatus.setAttribute('offline', true);
		}
		else if (netstatus.hasAttribute('offline')) {
			netstatus.removeAttribute('offline');
		}
		this._processOfflineChange();
		return this._offlineForced;
	},

	_wasRunning: false,
	_sum: 0,
	_speeds: new SpeedStats(10),
	_running: new Set(),
	_autoClears: [],
	completed: 0,
	finishing: 0,
	totalBytes: 0,
	init: function() {
		Prefs.init();

		this.statusText = $("statusText");
		this.statusSpeed = $("statusSpeed");

		// Set tooltip texts for each tb button lacking one (copy label)
		(function addTooltips() {
			for (let e of document.getElementsByTagName('toolbarbutton')) {
				if (!e.hasAttribute('tooltiptext')) {
					e.setAttribute('tooltiptext', e.getAttribute('label'));
				}
			}
			$('tbp_' + $('tools').getAttribute('mode')).setAttribute('checked', "true");
		})();


		(function initActions() {
			let tb = $('actions');
			for (let e of $$('#popup menuitem')) {
				e.className += " " + e.id;
			}
			for (let e of $$('#popup .action')) {
				if (e.localName === 'menuseparator') {
					tb.appendChild($e('toolbarseparator'));
					continue;
				}
				tb.appendChild($e('toolbarbutton', {
					id: 'act' + e.id,
					'class': e.id,
					command: e.getAttribute('command'),
					tooltiptext: e.getAttribute('tooltiptext') || e.label
				}));
			}
		})();

		(function initListeners() {
			addEventListener("unload", () => Dialog.unload(), false);
			addEventListener("close", evt => Dialog.onclose(evt), false);

			addEventListener("dragover", function(event) {
				try {
					if (event.dataTransfer.types.contains("text/x-moz-url")) {
						event.dataTransfer.dropEffect = "link";
						event.preventDefault();
					}
				}
				catch (ex) {
					log(LOG_ERROR, "failed to process ondragover", ex);
				}
			}, true);
			addEventListener("drop", function(event) {
				try {
					let url = event.dataTransfer.getData("URL");
					if (!url) {
						return;
					}
					let isPrivate = event.dataTransfer.mozSourceNode &&
						PrivateBrowsing.isWindowPrivate(event.dataTransfer.mozSourceNode.ownerDocument.defaultView);
					url = Services.io.newURI(url, null, null);
					let item = {
						"url": new DTM.URL(DTM.getLinkPrintMetalink(url) || url),
						"referrer": null,
						'description': "",
						"isPrivate": isPrivate
					};
					DTM.saveSingleItem(window, false, item);
				}
				catch (ex) {
					log(LOG_ERROR, "failed to process ondrop", ex);
				}
			}, true);

			$('tooldonate').addEventListener('click', function(evt) {
				if (evt.button === 0) {
					Dialog.openDonate();
				}
			}, false);
		})();

		this.paneSchedule = $("schedule");
		this.paneSchedule.addEventListener("command", function() {
			showPreferences("paneSchedule");
		}, false);

		let tree = $("downloads");
		Tree = new TreeManager(tree);
		addEventListener("unload", function unloadUnlink() {
			removeEventListener("unload", unloadUnlink, false);
			Tree.unlink();
		}, false);
		tree.addEventListener("change", () => {
			log(LOG_DEBUG, "tree change");
			Dialog.resetScheduler();
		}, true);
		try {
			defer(this._loadDownloads, this);
		}
		catch (ex) {
			log(LOG_ERROR, "Failed to load any downloads from queuefile", ex);
		}

		try {
			this.offline = Services.io.offline;
		}
		catch (ex) {
			log(LOG_ERROR, "Cannot get offline status", ex);
		}

		Preferences.makeObserver(this);
		const obs = require("support/observers");
		for (let topic of this._observes) {
			obs.add(this, topic);
		}
		const unload_obs = (function() {
			removeEventListener("unload", unload_obs, false);
			for (let topic of this._observes) {
				obs.remove(this, topic);
			}
		}).bind(this);
		addEventListener("unload", unload_obs, false);

		// Autofit
		(function autofit() {
			let de = document.documentElement;
			Version.getInfo(function(version) {
				let cv = version.VERSION + ".toolitems" + $('tools').childNodes.length;
				let shouldAutofit = !de.hasAttribute('dtmAutofitted');
				if (!shouldAutofit) {
					try {
						let lv = de.getAttribute('dtmAutofitted');
						shouldAutofit = !!version.compareVersion(cv, lv);
					}
					catch (ex) {
						shouldAutofit = true;
					}
				}
				if (shouldAutofit) {
					document.documentElement.setAttribute('dtmAutofitted', cv);
					$('tools').setAttribute('mode', 'icons');
					defer(
						function() {
							let tdb = $('tooldonate').boxObject;
							let db = de.boxObject;
							let cw = tdb.width + tdb.x;
							if (db.width < cw) {
								window.resizeTo(cw, window.outerHeight);
								log(LOG_DEBUG, "manager was autofit");
							}
						}
					);
				}
			});
		})();

		$('listSpeeds').limit = Prefs.speedLimit;
		$('listSpeedsSpinners').addEventListener('up', () => Dialog.changeSpeedLimitUp(), false);
		$('listSpeedsSpinners').addEventListener('down', () => Dialog.changeSpeedLimitDown(), false);

		(function nagging() {
			if (Preferences.getExt('nagnever', false)) {
				return;
			}
			let nb = $('notifications');
			try {
				let seq = QueueStore.getQueueSeq();
				let nagnext = Preferences.getExt('nagnext', 100);
				log(LOG_DEBUG, "nag: " + seq + "/" + nagnext + "/" + (seq - nagnext));
				if (seq < nagnext) {
					return;
				}
				for (nagnext = isFinite(nagnext) && nagnext > 0 ? nagnext : 100; seq >= nagnext;) {
					nagnext *= 2;
				}

				seq = Math.floor(seq / 100) * 100;

				setTimeoutOnlyFun(function() {
					let ndonation = nb.appendNotification(
							_('nagtext', [seq]),
							"donation",
							null,
							nb.PRIORITY_INFO_HIGH,
							[
								{
									accessKey: '',
									label: _('nagdonate'),
									callback: function() {
										nb.removeNotification(ndonation);
										Preferences.setExt('nagnext', nagnext);
										Preferences.setExt('nagnever', true);
										Dialog.openDonate();
									}
								},
								{
									accessKey: '',
									label: _('naghide'),
									callback: function() {
										Preferences.setExt('nagnext', nagnext);
										nb.removeNotification(ndonation);
									}
								},
								{
									accessKey: '',
									label: _('dontaskagain'),
									callback: function() {
										nb.removeNotification(ndonation);
										Preferences.setExt('nagnever', true);
									}
								}

							]
					);
				}, 1000);
			}
			catch (ex) {
				log(LOG_ERROR, 'nagger', ex);
			}
		})();

		(function checkLogging() {
			if (!log.enabled) {
				return;
			}
			let nb = $('notifications');
			nb.appendNotification(_("logging.enabled.warn"), 0, null, nb.PRIORITY_WARNING_MEDIUM, [
				{
					accessKey: "",
					label: _("keep"),
					callback: function() {}
				},
				{
					accessKey: "",
					label: _("disable"),
					callback: function() {
						Preferences.resetExt("logging");
					}
				},
				{
					accessKey: "",
					label: _("manualfix3"),
					callback: function() {
						showPreferences("panePrivacy");
					}
				}
			]);
		})();
	},

	customizeToolbar: function(evt) {
		$('tools').setAttribute('mode', evt.target.getAttribute('mode'));
	},

	changeSpeedLimit: function() {
		let list = $('listSpeeds');
		let val = list.limit;
		Preferences.setExt('speedlimit', val);
		this._speeds.clear();
	},
	changeSpeedLimitUp: function() {
		$('listSpeeds').limit = Math.max(0, $('listSpeeds').limit) + 102400;
		this.changeSpeedLimit();
	},
	changeSpeedLimitDown: function() {
		$('listSpeeds').limit -= 102400;
		this.changeSpeedLimit();
	},
	_loadDownloads: async function() {
		this._loading = $('loading');
		if (!this._loading) {
			this._loading = {};
		}
		Tree.beginUpdate();
		Tree.clear();
		this._brokenDownloads = [];
		log(LOG_INFO, "loading of the queue started!");
		GlobalProgress.reset();
		GlobalProgress.pause();
		try {
			let result = await QueueStore.loadItems();
			if (result && result.length) {
				log(LOG_INFO, "Result has arrived: " + result.length);
				await new Promise((resolve, reject) => {
					let loader = new CoThreadListWalker(
						this._loadDownloads_item,
						result,
						-1,
						this
					);
					loader.start(resolve);
				});
			}
			log(LOG_INFO, "Result was processed");
		}
		catch (ex) {
			log(LOG_ERROR, "Failed to load QueueStore items", ex);
		}

		Tree.savePositions();
		Tree.invalidate();
		Tree.doFilter();
		Tree.endUpdate();

		if (this._brokenDownloads.length) {
			QueueStore.beginUpdate();
			try {
				for (let id of this._brokenDownloads) {
					QueueStore.deleteDownload(id);
					log(LOG_ERROR, "Removed broken download #" + id);
				}
			}
			catch (ex) {
				log(LOG_ERROR, "failed to remove broken downloads", ex);
			}
			QueueStore.endUpdate();
		}
		delete this._brokenDownloads;
		delete this._loading;

		GlobalProgress.reset();
		this.statusText.hidden = false;

		this._timerProcess = setInterval(() => this.process(), REFRESH_FREQ);
		this.refresh();
		this.start();
	},
	_loadDownloads_item: function(dbItem, idx) {
		if (!idx) {
			GlobalProgress.total = dbItem.count;
		}
		if (!(idx % 250)) {
			GlobalProgress.value = idx;
		}
		if (!(idx % 500)) {
			this._loading.label = _('loading2', [idx, dbItem.count, Math.floor(idx * 100 / dbItem.count)]);
		}

		try {
			let down = dbItem.item;
			let d = new QueueItem(Dialog);
			d.dbId = dbItem.id;
			let state = Dialog_loadDownloads_get(down, "state");
			if (state) {
				d._setStateInternal(state);
			}
			d.urlManager = new UrlManager(down.urlManager);
			d.bNum = Dialog_loadDownloads_get(down, "numIstance");
			d.iNum = Dialog_loadDownloads_get(down, "iNum");

			let referrer = Dialog_loadDownloads_get(down, "referrer");
			if (referrer) {
				try {
					d.referrer = toURL(referrer);
				}
				catch (ex) {
					// We might have been fed with about:blank or other crap. so ignore.
				}
			}

			// only access the setter of the last so that we don't generate stuff trice.
			d._pathName = identity(Utils.addFinalSlash(Dialog_loadDownloads_get(down, "pathName")));
			d._description = identity(Dialog_loadDownloads_get(down, "description"));
			d._title = identity(Dialog_loadDownloads_get(down, "title"));
			d._mask = identity(Dialog_loadDownloads_get(down, "mask"));
			d._fileName = Dialog_loadDownloads_get(down, "fileName");
			if (down.fileNameFromUser) {
				d.fileNameFromUser = true;
			}

			let tmpFile = Dialog_loadDownloads_get(down, "tmpFile");
			if (tmpFile) {
				try {
					tmpFile = new Instances.LocalFile(tmpFile);
					if (tmpFile.exists()) {
						d._tmpFile = tmpFile;
					}
					else {
						// Download partfile is gone!
						// XXX find appropriate error message!
						d.fail(_("accesserror"), _("accesserror.long"), _("accesserror"));
					}
				}
				catch (ex) {
					log(LOG_ERROR, "tried to construct with invalid tmpFile", ex);
					d.cancel();
				}
			}

			d.startDate = new Date(Dialog_loadDownloads_get(down, "startDate"));
			d.visitors.load(down.visitors);

			for (let i = 0, e; i < Dialog_loadDownloads_props.length; ++i) {
				e = Dialog_loadDownloads_props[i];
				if (e in down) {
					d[e] = down[e];
				}
			}

			// don't trigger prealloc!
			d._totalSize = down.totalSize ? down.totalSize : 0;
			d.relaxSize = !!down.relaxSize;

			if (down.hashCollection) {
				d.hashCollection = DTM.HashCollection.load(down.hashCollection);
			}
			else if (down.hash) {
				d.hashCollection = new DTM.HashCollection(new DTM.Hash(down.hash, down.hashType));
			}
			if ('maxChunks' in down) {
				d._maxChunks = down.maxChunks;
			}

			d.started = !!d.partialSize;
			switch (d.state) {
				case PAUSED:
				case QUEUED:
				{
					for (let i = 0, c; i < down.chunks.length; ++i) {
						c = down.chunks[i];
						d.chunks.push(new Chunk(d, c.start, c.end, c.written));
					}
					d.refreshPartialSize();
					if (d.state === PAUSED) {
						d.status = TextCache_PAUSED;
					}
					else {
						d.status = TextCache_QUEUED;
					}
				}
				break;

				case COMPLETE:
					d.partialSize = d.totalSize;
					d.status = TextCache_COMPLETE;
				break;

				case CANCELED:
					d.status = TextCache_CANCELED;
				break;
			}

			// XXX better call this only once
			// See above
			d.rebuildDestination();
			Tree.fastLoad(d);
			d.position = dbItem.pos;
		}
		catch (ex) {
			log(LOG_ERROR, 'failed to init download #' + dbItem.id + ' from queuefile', ex);
			this._brokenDownloads.push(dbItem.id);
		}
		return true;
	},
	openAdd: function() {
		window.openDialog(
			'chrome://dtm/content/dtm/addurl.xul',
			'_blank',
			Version.OS === 'darwin' ? 'chrome,modal,dependent=yes' : 'chrome,centerscreen,dialog=no,dependent=yes'
		);
	},

	openDonate: function() {
		try {
			openUrl('http://www.downthemoon.nope/howto/donate/');
		}
		catch(ex) {
			window.alert(ex);
		}
	},
	openInfo: function(downloads) {
		let w = window.openDialog(
			"chrome://dtm/content/dtm/manager/info.xul","_blank",
			"chrome, centerscreen, dialog=no",
			downloads,
			this
			);
	},

	start: function() {
		if (this._initialized) {
			return;
		}

		this._initialized = true;
		for (let d of Tree.all) {
			if (d.state === FINISHING) {
				this.run(d);
			}
		}
		this._timerWritten = setInterval(() => this.refreshWritten(), 200);
		this._timerSave = setInterval(() => this.saveRunning(), 10000);

		$('loadingbox').parentNode.removeChild($('loadingbox'));
		window.removeEventListener("unload", dieEarly, false);
		let evt = document.createEvent("Event");
		evt.initEvent("DTM:ready", true, false);
		window.dispatchEvent(evt);
	},

	reinit: function(mustClear) {
		if (!this._initialized) {
			log(LOG_DEBUG, "reinit canceled");
		}
		let method = mustClear ? 'cancel' : 'pause';
		Tree.updateAll(function(download) {
			if (download.state !== COMPLETE) {
				download[method]();
			}
			return true;
		});
		try {
			log(LOG_INFO, "reinit initiated");
			defer(() => this.shutdown(this._continueReinit), this);
		}
		catch (ex) {
			log(LOG_DEBUG, "reinit: Failed to reload any downloads from queuefile", ex);
		}
	},
	_continueReinit: function() {
		this._running = new Set();
		delete this._forceQuit;
		this._speeds.clear();
		this.offlineForced = false;

		this._loadDownloads();
	},

	observe: function(subject, topic, data) {
		if (topic === 'quit-application-requested') {
			if (!this._canClose()) {
				delete this._forceClose;
				try {
					let cancelQuit = subject.QueryInterface(Ci.nsISupportsPRBool);
					cancelQuit.data = true;
				}
				catch (ex) {
					log(LOG_ERROR, "cannot set cancelQuit", ex);
				}
			}
		}
		else if (topic === "DTM:upgrade") {
			Preferences.setExt("rebootOnce", true);
			if (!this._canClose()) {
				delete this._forceClose;
				try {
					let cancelQuit = subject.QueryInterface(Ci.nsISupportsPRBool);
					cancelQuit.data = true;
					this._mustReload = true;
					for (let d of Tree.all) {
						if (d.state === RUNNING && d.canResumeLater) {
							d.pause();
							d.queue();
						}
					}
				}
				catch (ex) {
					log(LOG_ERROR, "cannot set cancelQuit on upgrade", ex);
				}
			}
		}
		else if (topic === 'quit-application-granted') {
			this._forceClose = true;
			delete this._mustReload;
		}
		else if (topic === 'network:offline-status-changed') {
			this.offline = data === "offline";
		}
		else if (topic === 'DTM:filterschanged') {
			Tree.assembleMenus();
		}
		else if (topic === 'DTM:clearedQueueStore') {
			this.reinit(true);
		}
		else if (topic === 'DTM:shutdownQueueStore') {
			log(LOG_INFO, "saving running");
			this.saveRunning();
		}
	},
	refresh: function() {
		try {
			const now = Utils.getTimestamp();
			for (let d of this._running) {
				if (!d) {
					continue;
				}
				d.refreshPartialSize();
				let advanced = d.speeds.add(d.partialSize + d.otherBytes, now);
				this._sum += advanced;

				// Calculate estimated time
				if (advanced !== 0 && d.totalSize > 0) {
					let remaining = Math.ceil((d.totalSize - d.partialSize) / d.speeds.avg);
					if (!isFinite(remaining)) {
						d.status = TextCache_UNKNOWN;
						d.estimated = 0;
					}
					else {
						d.status = Utils.formatTimeDelta(remaining);
						d.estimated = remaining;
					}
				}
				d.speed = Utils.formatSpeed(d.speeds.avg);
				if (d.speedLimit > 0) {
					d.speed += " (" + Utils.formatSpeed(d.speedLimit, 0) + ")";
				}
			}
			this._speeds.add(this._sum, now);
			let speed = Utils.formatSpeed(this._speeds.avg);
			this._maxObservedSpeed = Math.max(this._speeds.avg || this._maxObservedSpeed, this._maxObservedSpeed);
			for (let e of speedElems) {
				try {
					e.hint = this._maxObservedSpeed;
					hintChunkBufferSize(this._maxObservedSpeed);
				}
				catch (ex) {
					log(LOG_ERROR, "set hint threw; mos is " + this._maxObservedSpeed, ex);
				}
			}

			// Refresh status bar
			this.statusText.label = _("currentdownloadstats",
				[this.completed, Tree.downloadCount, Tree.rowCount, this._running.size]);
			if (!this._running.size) {
				this.statusSpeed.hidden = true;
			}
			else {
				this.statusSpeed.hidden = false;
				this.statusSpeed.label = speed;
			}

			// Refresh window title
			let fr = this._running.values().next().value || null;
			if (this._running.size === 1 && fr.totalSize > 0) {
				if (Tree.filtered) {
					document.title = _('titlespeedfiltered', [
						fr.percent,
						this.statusSpeed.label,
						this.completed,
						Tree.downloadCount,
						Tree.rowCount
					]);
				}
				else {
					document.title = _('titlespeed', [
						fr.percent,
						this.statusSpeed.label,
						this.completed,
						Tree.downloadCount,
					]);
				}
				if (fr.totalSize) {
					GlobalProgress.activate(fr.progress * 10, 1000);
				}
				else {
					GlobalProgress.unknown();
				}
			}
			else if (this._running.size > 0) {
				let p = Math.floor(this.completed * 1000 / Tree.downloadCount);
				let pt = Math.floor(this.completed * 100 / Tree.downloadCount) + '%';
				if (Tree.filtered) {
					document.title = _('titlespeedfiltered', [
						pt,
						this.statusSpeed.label,
						this.completed,
						Tree.downloadCount,
						Tree.rowCount
					]);
				}
				else {
					document.title = _('titlespeed', [
						pt,
						this.statusSpeed.label,
						this.completed,
						Tree.downloadCount
					]);
				}
				GlobalProgress.activate(p, 1000);
			}
			else {
				if (Tree.downloadCount) {
					let state = COMPLETE;
					for (let d of Tree.all) {
						const dstate = d.state;
						if (dstate === CANCELED) {
							state = CANCELED;
							break;
						}
						if (dstate === PAUSED) {
							state = PAUSED;
							break;
						}
					}
					let p = Math.floor(this.completed * 1000 / Tree.downloadCount);
					switch (state) {
					case CANCELED:
						GlobalProgress.error(p, 1000);
						break;
					case PAUSED:
						GlobalProgress.pause(p, 1000);
						break;
					default:
						GlobalProgress.hide();
					}
				}
				else {
					GlobalProgress.hide();
				}
				if (Tree.filtered) {
					document.title = _('titleidlefiltered', [
						this.completed,
						Tree.downloadCount,
						Tree.rowCount
					]);
				}
				else {
					document.title = _('titleidle', [
						this.completed,
						Tree.downloadCount
					]);
				}
			}
			($('titlebar') || {}).value = document.title;
		}
		catch(ex) {
			log(LOG_ERROR, "refresh():", ex);
		}
	},
	refreshWritten: function() {
		for (let d of this._running) {
			if (!d) {
				continue;
			}
			d.refreshPartialSize();
			d.invalidate();
		}
	},
	saveRunning: function() {
		if (!this._running.size) {
			return;
		}
		for (let d of this._running) {
			d.save();
		}
	},

	_processOfflineChange: function() {
		let de = $('downloads');
		if (this.offline === de.hasAttribute('offline')) {
			return;
		}

		if (this.offline) {
			de.setAttribute('offline', true);
			$('netstatus').setAttribute('offline', true);
			for (let d of Tree.all) {
				if (d.state === RUNNING) {
					d.pause();
					d.queue();
				}
			}
		}
		else if (de.hasAttribute('offline')) {
			de.removeAttribute('offline');
			$('netstatus').removeAttribute('offline');
		}
		Tree.box.invalidate();
	},

	_filterAutoRetrying(d) {
		return !d.autoRetry();
	},

	process: function() {
		try {
			Prefs.refreshConnPrefs(this._running);
			this.refresh();

			let ts = Utils.getTimestamp();
			for (let d of this._running) {
				if (!d || d.isCritical) {
					continue;
				}
				// checks for timeout
				if (d.state === RUNNING && (ts - d.timeLastProgress) >= Prefs.timeout * 1000) {
					if (d.resumable || !d.totalSize || !d.partialSize || Prefs.resumeOnError) {
						d.pauseAndRetry();
						d.status = TextCache_TIMEOUT;
					}
					else {
						d.cancel(TextCache_TIMEOUT);
					}
					log(LOG_ERROR, d + " is a timeout");
				}
			}

			this.processAutoClears();

			if (!this.offline && !this._mustReload) {
				if (Prefs.autoRetryInterval) {
					filterInSitu(this._autoRetrying, this._filterAutoRetrying);
				}
				this.startNext();
			}
		}
		catch(ex) {
			log(LOG_ERROR, "process():", ex);
		}
	},
	processAutoClears: (function() {
		function _m(e) {
			return e && e.get();
		}
		function _f(e) {
			return !!e;
		}
		return function() {
			if (Prefs.autoClearComplete && this._autoClears.length) {
				Tree.remove(this._autoClears);
				this._autoClears.length = 0;
			}
		};
	})(),
	scheduler: null,
	startNext: function() {
		try {
			var rv = false;
			// pre-condition, do check prior to loop, or else we'll have the generator cost.
			if (this._running.size >= Prefs.maxInProgress) {
				return false;
			}
			if (Prefs.schedEnabled) {
				this.paneSchedule.removeAttribute("disabled");

				let current = new Date();
				current = current.getHours() * 60 + current.getMinutes();
				let disabled;
				if (Prefs.schedStart < Prefs.schedEnd) {
					disabled = current < Prefs.schedStart || current > Prefs.schedEnd;
				}
				else {
					disabled = current < Prefs.schedStart && current > Prefs.schedEnd;
				}

				if (disabled) {
					this.paneSchedule.removeAttribute("running");
					this.paneSchedule.setAttribute("tooltiptext", _("schedule.paused"));
					return false;
				}

				this.paneSchedule.setAttribute("running", "true");
				this.paneSchedule.setAttribute("tooltiptext", _("schedule.running"));
			}
			else {
				this.paneSchedule.setAttribute("disabled", "true");
			}
			if (!this.scheduler) {
				this.scheduler = Limits.getConnectionScheduler(Tree.all);
				log(LOG_DEBUG, "rebuild scheduler");
			}
			let finishingPenality = Math.ceil(this.finishing / 10);
			while (this._running.size < Prefs.maxInProgress - finishingPenality) {
				let d = this.scheduler.next(this._running);
				if (!d) {
					break;
				}
				if (d.state !== QUEUED) {
					log(LOG_ERROR, "FIXME: scheduler returned unqueued download");
					continue;
				}
				if (!this.run(d)) {
					break;
				}
				rv = true;
			}
			return rv;
		}
		catch(ex){
			log(LOG_ERROR, "startNext():", ex);
		}
		return false;
	},
	run: function(download, forced) {
		if (this.offline) {
			return false;
		}
		download.forced = !!forced;
		download.status = TextCache_STARTING;
		if (download.partialSize) {
			// only ever consider downloads complete where there was actual data retrieved
			if (!download.totalSize || download.partialSize > download.totalSize) {
				// only ever consider downloads to be complete which a saane ammount of data retrieved
				// or where the totalSize is not known
				if (download.state === FINISHING || download.totalSize) {
					// So by now we got a download that
					// 1. always as data
					// 2. is set to FINISHING already
					// 3. or has partialSize > totalSize (and a totalSize) indicating it is complete
					download.setState(FINISHING);
					if (download.totalSize) {
						download.partialSize = download.totalSize;
					}
					log(LOG_INFO,
						"Download seems to be complete; likely a left-over from a crash, finish it:" + download);
					download.finishDownload();
					return true;
				}
			}
		}
		download.timeLastProgress = Utils.getTimestamp();
		download.timeStart = Utils.getTimestamp();
		download.setState(RUNNING);
		if (!download.started) {
			download.started = true;
			log(LOG_INFO, "Let's start " + download);
		}
		else {
			log(LOG_INFO, "Let's resume " + download + " at " + download.partialSize);
		}
		this._running.add(download);
		download.prealloc();
		download.resumeDownload();
		return true;
	},
	wasStopped: function(download) {
		this._running.delete(download);
	},
	wasFinished: function() {
		--this.finishing;
	},
	resetScheduler: function() {
		if (!Dialog.scheduler) {
			return;
		}
		Dialog.scheduler.destroy();
		Dialog.scheduler = null;
	},
	_signal_some: function(d) {
		return d.isOf(FINISHING | RUNNING | QUEUED);
	},
	signal: function(download) {
		download.save();
		const state = download.state;
		if (state === QUEUED) {
			Dialog.resetScheduler();
			return;
		}
		if (state === RUNNING) {
			this._wasRunning = true;
		}
		else if (Prefs.autoClearComplete && state === COMPLETE) {
			this._autoClears.push(download);
		}
		if (!this._initialized || !this._wasRunning || state !== COMPLETE) {
			return;
		}
		try {
			// check if there is something running or scheduled
			if (this._mustReload) {
				Dialog.close();
				return;
			}
			if (this.startNext() || Tree.some(this._signal_some)) {
				return;
			}
			this._speeds.clear();
			log(LOG_DEBUG, "signal(): Queue finished");
			if (Prefs.soundsDone) {
				$("sound_done").play();
			}

			let dp = Tree.at(0);
			if (dp) {
				dp = dp.destinationPath;
			}
			if (Prefs.alertingSystem === 1) {
				AlertService.show(_("suc.title"), _('suc'), () => Utils.launch(dp));
			}
			else if (dp && Prefs.alertingSystem === 0) {
				if (!Prompts.confirmYN(window, _('suc'),  _("openfolder"))) {
					try {
						Utils.launch(dp);
					}
					catch (ex){
						// no-op
					}
				}
			}
			if (Prefs.autoClose) {
				setTimeoutOnlyFun(() => Dialog.close(), 1500);
			}
		}
		catch(ex) {
			log(LOG_ERROR, "signal():", ex);
		}
	},
	markAutoRetry: function(download) {
		if (!~this._autoRetrying.indexOf(download)) {
			this._autoRetrying.push(download);
		}
	},
	wasRemoved: function(download) {
		this._running.delete(download);
		let idx = this._autoRetrying.indexOf(download);
		if (idx > -1) {
			this._autoRetrying.splice(idx, 1);
		}
	},
	onclose: function(evt) {
		let rv = Dialog.close();
		if (!rv) {
			evt.preventDefault();
		}
		return rv;
	},
	_canClose: function() {
		if (Tree.some(function(d) { return d.started && !d.canResumeLater && d.state === RUNNING; })) {
			let rv = Prompts.confirmYN(
				window,
				_("confclose.2"),
				_("nonresclose")
			);
			if (rv) {
				return false;
			}
		}
		if (Tree.some(d => d.isPrivate && d.state !== COMPLETE)) {
			let rv = Prompts.confirmYN(
				window,
				_("confclose.2"),
				_("privateclose")
			);
			if (rv) {
				return false;
			}
		}

		return (this._forceClose = true);
	},
	close: function() {
		return this.shutdown(this._doneClosing);
	},
	_doneClosing: function() {
		close();
	},
	shutdown: function(callback) {
		log(LOG_INFO, "Close request");
		if (!this._initialized) {
			log(LOG_INFO, "not initialized. Going down immediately!");
			callback.call(this);
			return true;
		}
		if (!this._forceClose && !this._canClose()) {
			delete this._forceClose;
			log(LOG_INFO, "Not going to close!");
			return false;
		}
		this.offlineForced = true;

		// stop everything!
		// enumerate everything we'll have to wait for!
		if (this._timerProcess) {
			clearInterval(this._timerProcess);
			delete this._timerProcess;
		}

		let chunks = 0;
		let finishing = 0;
		log(LOG_INFO, "Going to close all");
		Tree.updateAll(
			function(d) {
				if (!d.is(COMPLETE) && d.isPrivate) {
					d.cancel();
				}
				else if (d.is(RUNNING)) {
					// enumerate all running chunks
					for (let c of d.chunks) {
						if (c.running) {
							++chunks;
						}
					}
					d.pause();
					d.setState(QUEUED);
				}
				else if (d.state === FINISHING) {
					++finishing;
				}
				d.shutdown();
				return true;
			},
			this
		);
		log(LOG_INFO, "Still running: " + chunks + " Finishing: " + finishing);
		if (chunks || finishing) {
			if (!this._forceClose && this._safeCloseAttempts < 20) {
				++this._safeCloseAttempts;
				setTimeoutOnlyFun(() => this.shutdown(callback), 250);
				return false;
			}
			log(LOG_ERROR, "Going down even if queue was not probably closed yet!");
		}
		callback.call(this);
		this._initialized = false;
		return true;
	},
	_cleanTmpDir: function() {
		if (!Prefs.tempLocation || Preferences.getExt("tempLocation", "")) {
			// cannot perform this action if we don't use a temp file
			// there might be far too many directories containing far too many
			// tmpFiles.
			// or part files from other users.
			return;
		}
		let known = [];
		for (let d of Tree.all) {
			if (!d._tmpFile) {
				continue;
			}
			known.push(d.tmpFile.leafName);
		}
		let tmpEnum = Prefs.tempLocation.directoryEntries;
		let unknown = [];
		for (let f of new Utils.SimpleIterator(tmpEnum, Ci.nsIFile)) {
			if (f.leafName.match(/\.dtmpart$/) && !~known.indexOf(f.leafName)) {
				unknown.push(f);
			}
		}
		for (let f of unknown) {
			try {
				f.remove(false);
			}
			catch (ex) {}
		}
	},
	_safeCloseAttempts: 0,

	unload: function() {
		Limits.killServerBuckets();

		if(!!this._timerRunning){ clearInterval(this._timerRunning) };
		if(!!this._timerSave)	{ clearInterval(this._timerSave) 	};
		if(!!this._timerProcess){ clearInterval(this._timerProcess) };
		Prefs.shutdown();
		try {
			this._cleanTmpDir();
		}
		catch(ex) {
			log(LOG_ERROR, "_safeClose", ex);
		}

		// some more gc
		for (let d of Tree._downloads) {
			delete d._icon;
		}
		Tree.clear();
		QueueStore.flush();
		delete window.FileExts;
		this.resetScheduler();
		if (this._mustReload) {
			unload("shutdown");
			try {
				Cu.import("chrome://dtm-modules/content/glue.jsm", {});
			}
			catch (ex) {
				// may fail, if the add-on was disabled in between
				// not to worry!
			}
		}
		else {
			require("support/memorypressure").notify();
		}
		return true;
	}
};
addEventListener("load", function DialogInit() {
	removeEventListener("load", DialogInit, false);
	Dialog.init();
}, false);

unloadWindow(window, function () {
	Dialog._forceClose = true;
	Dialog.close();
});

var Metalinker = {
	handleDownload: function(download) {
		let file = download.tmpFile;

		this.handleFile(file, download.referrer, function() {
			try {
				file.remove(false);
			}
			catch (ex) {
				log(LOG_ERROR, "failed to remove metalink file!", ex);
			}
		}, download.isPrivate);

		download.setState(CANCELED);
		Tree.remove(download, false);
	},
	handleFile: function(aFile, aReferrer, aCallback, aIsPrivate) {
		aIsPrivate = !!aIsPrivate || false;
		let aURI = Services.io.newFileURI(aFile);
		this.parse(aURI, aReferrer, function (res, ex) {
			//log(LOG_DEBUG, JSON.stringify(res));
			try {
				if (ex) {
					throw ex;
				}
				if (!res.downloads.length) {
					throw new Error(_('ml.nodownloads'));
				}
				for (let e of res.downloads) {
					if (e.size) {
						e.size = Utils.formatBytes(e.size);
					}
					e.fileName = Utils.getUsableFileName(e.fileName);
					e.isPrivate = aIsPrivate;
				}
				window.openDialog(
					'chrome://dtm/content/dtm/manager/metaselect.xul',
					'_blank',
					'chrome,centerscreen,resizable,dialog=yes,modal',
					res.downloads,
					res.info
				);
				filterInSitu(res.downloads, function(d) { return d.selected; });
				if (res.downloads.length) {
					startDownloads(res.info.start, res.downloads);
				}
			}
			catch (e) {
				log(LOG_ERROR, "Metalinker::handleDownload", e);
				if (!(e instanceof Error)) {
					let msg = _('mlerror', [e.message ? e.message : (e.error ? e.error : e.toString())]);
					AlertService.show(_('mlerrortitle'), msg);
				}
				else {
					AlertService.show(_('mlerrortitle'), e.message);
				}
			}
			if (aCallback) {
				aCallback();
			}
		});
	}
};
requireJoined(Metalinker, "support/metalinker");

var QueueItem = class QueueItem {
	constructor(dialog) {
		this.dialog = dialog;

		this.visitors = new VisitorManager();
		this.chunks = [];
		this.speeds = new SpeedStats(SPEED_COUNT);
		this.rebuildDestination_renamer = createRenamer(this);
	}

	get maskURL() {
		return this.urlManager.usableURL;
	}

	get maskCURL() {
		return Utils.getCURL(this.maskURL);
	}

	get maskURLPath() {
		return this.urlManager.usableURLPath;
	}

	get maskReferrerURL() {
		return this.referrerUrlManager.usableURL;
	}

	get maskReferrerURLPath() {
		return this.referrerUrlManager.usableURLPath;
	}

	get maskReferrerCURL() {
		return Utils.getCURL(this.maskReferrerURL);
	}

	get autoRetrying() {
		return !!this._autoRetryTime;
	}

	get bucket() {
		return this._bucket;
	}
	set bucket(nv) {
		if (nv !== null) {
			throw new Exception("Bucket is only nullable");
		}
		if (this._bucket) {
			this._bucket = null;
		}
	}

	get speedLimit() {
		return this._speedLimit;
	}
	set speedLimit(nv) {
		nv = Math.max(nv, -1);
		if (this._speedLimit === nv) {
			return;
		}
		this._speedLimit = nv;
		if (this.state === RUNNING) {
			this._bucket.byteRate = this.speedLimit;
		}
		this.save();
	}

	get fileName() {
		return this._fileName;
	}
	set fileName(nv) {
		if (this._fileName === nv || this.fileNameFromUser) {
			return nv;
		}
		log(LOG_DEBUG, "fn is " + this._fileName + " nv: " + nv);
		this._fileName = nv;
		delete this._fileNameAndExtension;
		this.rebuildDestination();
		this.invalidate(0);
		return nv;
	}

	get fileNameAndExtension() {
		if (!this._fileNameAndExtension) {
			let fn = this.fileName;
			let ext = Utils.getExtension(fn);
			if (ext) {
				fn = fn.substring(0, fn.length - ext.length - 1);

				if (this.contentType && /htm/.test(this.contentType) && !/htm/.test(ext)) {
					ext += ".html";
				}
			}
			// mime-service method
			else if (this.contentType && /^(?:image|text)/.test(this.contentType)) {
				try {
					let info = Services.mime.getFromTypeAndExtension(this.contentType.split(';')[0], "");
					ext = info.primaryExtension;
				} catch (ex) {
					ext = '';
				}
			}
			else {
				fn = this.fileName;
				ext = '';
			}

			this._fileNameAndExtension = {name: fn, extension: ext };
		}
		return this._fileNameAndExtension;
	}

	get referrerUrlManager() {
		if (this.referrer && !this._referrerUrlManager) {
			this._referrerUrlManager = new UrlManager([this.referrer]);
		}
		return this._referrerUrlManager;
	}

	get referrerFileNameAndExtension() {
		if (!this.referrerUrlManager) {
			return null;
		}
		if (!this._referrerFileNameAndExtension) {
			let fn = Utils.getUsableFileName(this.referrerUrlManager.usable);
			let ext = Utils.getExtension(fn);
			if (ext) {
				fn = fn.substring(0, fn.length - ext.length - 1);
			}
			else {
				ext = '';
			}
			this._referrerFileNameAndExtension = {name: fn, extension: ext};
		}
		return this._referrerFileNameAndExtension;
	}

	get description() {
		return this._description;
	}
	set description(nv) {
		if (nv === this._description) {
			return nv;
		}
		this._description = nv;
		this.rebuildDestination();
		this.invalidate(0);
		return nv;
	}

	get title() {
		return this._title;
	}
	set title(nv) {
		if (nv === this._title) {
			return this._title;
		}
		this._title = nv;
		this.rebuildDestination();
		this.invalidate(0);
		return this._title;
	}

	get pathName() {
		return this._pathName;
	}
	set pathName(nv) {
		nv = nv.toString();
		if (this._pathName === nv) {
			return nv;
		}
		this._pathName = identity(Utils.addFinalSlash(nv));
		this.rebuildDestination();
		this.invalidate(0);
		return nv;
	}

	get mask() {
		return this._mask;
	}
	set mask(nv) {
		if (this._mask === nv) {
			return nv;
		}
		this._mask = identity(Utils.removeFinalSlash(Utils.removeLeadingSlash(Utils.normalizeSlashes(nv))));
		this.rebuildDestination();
		this.invalidate(7);
		return nv;
	}

	get destinationName() {
		return this._destinationNameFull;
	}
	set destinationName(nv) {
		if (this.destinationNameOverride === nv) {
			return this._destinationNameFull;
		}
		this.destinationNameOverride = nv;
		this.rebuildDestination();
		this.invalidate(0);
		return this._destinationNameFull;
	}

	get destinationFile() {
		if (!this._destinationFile) {
			this.rebuildDestination();
		}
		return this._destinationFile;
	}

	get destinationLocalFile() {
		if (!this._destinationLocalFile) {
			this.rebuildDestination();
		}
		return this._destinationLocalFile;
	}

	get conflicts() {
		return this._conflicts;
	}
	set conflicts(nv) {
		if (this._conflicts === nv) {
			return nv;
		}
		this._conflicts = nv;
		this.rebuildDestination();
		this.invalidate(0);
		return nv;
	}

	get tmpFile() {
		if (!this._tmpFile) {
			var dest = Prefs.tempLocation ?
				Prefs.tempLocation.clone() :
				new Instances.LocalFile(this.destinationPath);
			let fn = this.fileName;
			if (fn.length > 60) {
				fn = fn.substring(0, 60);
			}
			dest.append(fn + "-" + Utils.newUUIDString() + '.dtmpart');
			this._tmpFile = dest;
		}
		return this._tmpFile;
	}

	get hashCollection() {
		return this._hashCollection;
	}
	set hashCollection(nv) {
		if (nv && !(nv instanceof DTM.HashCollection)) {
			throw new Exception("Not a hash collection");
		}
		this._hashCollection = nv;
		this._prettyHash = this._hashCollection ?
			_('prettyhash', [this._hashCollection.full.type, this._hashCollection.full.sum]) :
			TextCache_NAS;
	}

	get prettyHash() {
		return this._prettyHash;
	}

	get contentType() {
		return this._contentType;
	}
	set contentType(nv) {
		if (nv === this._contentType) {
			return;
		}
		this._contentType = nv;
		delete this._fileNameAndExtension;
	}

	get totalSize() {
	 	return this._totalSize;
	}
	set totalSize(nv) {
		if (nv >= 0 && !isNaN(nv)) {
			this._totalSize = Math.floor(nv);
		}
		this.invalidate(3);
		this.prealloc();
	}

	get startDate() {
		return this._startDate || (this.startDate = new Date());
	}
	set startDate(nv) {
		this._startDate = nv;
	}

	get canResumeLater() {
		return this.resumable && !this.isPrivate;
	}

	get activeChunks() {
		return this._activeChunks;
	}
	set activeChunks(nv) {
		nv = Math.max(0, nv);
		if (!nv && this.state === RUNNING) {
			log(LOG_INFO, `active chunks set to zero while running: ${nv} ${this._activeChunks}`);
		}
		this._activeChunks = nv;
		this.invalidate(6);
		return this._activeChunks;
	}

	get maxChunks() {
		if (!this.urlManager) {
			return Prefs.maxChunks;
		}
		if (!this._maxChunks) {
			let limit = Limits.getLimitFor(this);
			this._maxChunks = (limit ? limit.segments : 0) || Prefs.maxChunks;
		}
		return this._maxChunks;
	}
	set maxChunks(nv) {
		this._maxChunks = nv;
		if (this._maxChunks < this._activeChunks) {
			let running = this.chunks.filter(function(c) { return c.running; });
			while (running.length && this._maxChunks < running.length) {
				let c = running.pop();
				if (c.remainder < 10240) {
					continue;
				}
				c.cancelChunk();
			}
		}
		else if (this._maxChunks > this._activeChunks && this.state === RUNNING) {
			this.resumeDownload();

		}
		this.invalidate(6);
		log(LOG_DEBUG, "mc set to " + nv);
		return this._maxChunks;
	}

	get iconProp() {
		if (!this._icon) {
			let icon = FileExts.getAtom(this.destinationName, 'metalink' in this).toString();
			this._icon = identity((this.isPrivate ? "iconic private file " : "iconic file ") + icon);
		}
		return this._icon;
	}

	get largeIcon() {
		return getLargeIcon(this.destinationName, 'metalink' in this);
	}

	get dimensionString() {
		if (this.partialSize <= 0) {
			return TextCache_UNKNOWN;
		}
		else if (this.totalSize <= 0) {
			return _('transfered', [Utils.formatBytes(this.partialSize), TextCache_NAS]);
		}
		else if (this.state === COMPLETE || this.state === FINISHING) {
			return Utils.formatBytes(this.totalSize);
		}
		return _('transfered', [Utils.formatBytes(this.partialSize), Utils.formatBytes(this.totalSize)]);
	}

	get status() {
		if (this.dialog.offline && this.isOf(QUEUED | PAUSED)) {
			return TextCache_OFFLINE;
		}
		return this._status + (this.autoRetrying ? ' *' : '');
	}

	set status(nv) {
		if (nv !== this._status) {
			this._status = nv;
			this.invalidate();
		}
		return this._status;
	}

	get parts() {
		if (this.maxChunks) {
			return (this.activeChunks) + '/' + this.maxChunks;
		}
		return '';
	}

	get percent() {
		const state = this.state;
		if (!this.totalSize && state === RUNNING) {
			return TextCache_NAS;
		}
		else if (!this.totalSize) {
			return "0%";
		}
		else if (state === COMPLETE) {
			return "100%";
		}
		return this.progress + "%";
	}

	get destinationPath() {
		return this._destinationPath;
	}

	get isCritical() {
		return this._criticals !== 0;
	}

	_setStateInternal(nv) {
		Object.defineProperty(this, "state", {value: nv, configurable: true, enumerable: true});
	}

	setState(nv) {
		if (this.state === nv) {
			return nv;
		}
		if (this.state === RUNNING) {
			// remove ourself from inprogresslist
			this.dialog.wasStopped(this);
			// kill the bucket via it's setter
			this.bucket = null;
		}
		else if (this.state === COMPLETE) {
			--this.dialog.completed;
		}
		else if (this.state === FINISHING) {
			--this.dialog.finishing;
		}
		this.speed = '';
		this._setStateInternal(nv);
		if (this.state === RUNNING) {
			// set up the bucket
			this._bucket = new ByteBucket(this.speedLimit, 1.2, "download");
		}
		else if (this.state === FINISHING) {
			++this.dialog.finishing;
			if (!this.totalSize) {
				// We are done now, just set indeterminate size downloads to what we actually downloaded
				this.refreshPartialSize();
				this.totalSize = this.partialSize;
			}
		}
		else if (this.state === COMPLETE) {
			++this.dialog.completed;
		}
		this.dialog.signal(this);
		this.invalidate();
		Tree.refreshTools();
		return nv;
	}

	setUserFileName(name) {
		try {
			Tree.beginUpdate();
			this.fileNameFromUser = false;
			this.fileName = name;
			this.fileNameFromUser = true;
			this.save();
			let dummy = this.iconProp; // set up initial icon to avoid display problems
		}
		finally {
			Tree.invalidate();
			Tree.endUpdate();
		}
	}

	shortenName() {
		let fn = this.destinationName;
		let ext = Utils.getExtension(fn);
		if (ext) {
			fn = fn.substring(0, fn.length - ext.length - 1);
		}
		let nn = fn.substr(0, Math.min(200, Math.max(fn.length - 25, 10)));
		if (nn === fn) {
			return;
		}
		if (ext) {
			nn += "." + ext;
		}
		this.destinationName = nn;
	}

	is(state) {
		return this.state === state;
	}

	isOf(states) {
		return (this.state & states) !== 0;
	}

	save() {
		if (this.deleting) {
			return false;
		}
		const state = this.state;
		if ((Prefs.removeCompleted && state === COMPLETE) ||
			(Prefs.removeCanceled && state === CANCELED) ||
			(Prefs.removeAborted && state === PAUSED)) {
			if (this.dbId) {
				this.remove();
			}
			return false;
		}
		if (this.isPrivate) {
			return false;
		}
		if (this.dbId) {
			QueueStore.saveDownload(this.dbId, JSON.stringify(this));
			return true;
		}
		this.dbId = QueueStore.queueDownload(JSON.stringify(this), this.position);
		return true;
	}

	remove() {
		QueueStore.deleteDownload(this.dbId);
		delete this.dbId;
	}

	invalidate(cell) {
		Tree.invalidate(this, cell);
	}

	safeRetry(resumable) {
		this.cancel().then(() => {
			// reset flags
			this.progress = this.totalSize = this.partialSize = 0;
			this.compression = null;
			this.activeChunks = this.maxChunks = 0;
			for (let c of this.chunks) {
				c.cancelChunk();
			}
			this.chunks.length = 0;
			this.speeds.clear();
			this.otherBytes = 0;
			this.visitors = new VisitorManager();
			this.resumable = resumable !== false;
			this.setState(QUEUED);
			this.dialog.run(this);
		});
	}

	refreshPartialSize() {
		let size = 0;
		for (let i = 0, e = this.chunks.length; i < e; ++i) {
			size += this.chunks[i].written;
		}
		if (isNaN(size) || size < 0) {
			if (log.enabled) {
				log(LOG_ERROR, "Bug: invalid partial size!", size);
				for (let [i,c] in Iterator(this.chunks)) {
					log(LOG_DEBUG, "Chunk " + i + ": " + c);
				}
			}
		}
		else {
			this.partialSize = size;
			this.progress = this._totalSize && Math.floor(size * 100.0 / this._totalSize);
			if (!this._totalSize && this.state === FINISHING) {
				this.progress = 100;
			}
		}
	}

	pause() {
		this.setState(PAUSED);
		if (this.chunks) {
			for (let c of this.chunks) {
				if (c.running) {
					c.cancelChunk();
				}
			}
		}
		this.activeChunks = 0;
		this.speeds.clear();
		this.otherBytes = 0;
	}

	async moveCompleted() {
		if (this.state === CANCELED) {
			throw Error("Cannot move incomplete file");
		}
		this.status = TextCache_MOVING;

		let pinned = (await this.resolveConflicts());
		if (!pinned) {
			return;
		}
		try {
			let destination = new Instances.LocalFile(this.destinationPath);
			await Utils.makeDir(destination, Prefs.dirPermissions);
			log(LOG_INFO, this.fileName + ": Move " + this.tmpFile.path + " to " + this.destinationFile);
			// move file
			if (this.compression) {
				this.status = TextCache_DECOMPRESSING;
				await new Promise(function(resolve, reject) {
					new Decompressor(this, function(ex) {
						if (ex) {
							reject(ex);
						}
						else {
							resolve(true);
						}
					});
				}.bind(this));
				return true;
			}
			await _moveFile(destination, this);
			return true;
		}
		finally {
			ConflictManager.unpin(pinned);
		}
		return false;
	}

	handleMetalink() {
		try {
			Metalinker.handleDownload(this);
		}
		catch (ex) {
			log(LOG_ERROR, "handleMetalink", ex);
		}
	}

	async verifyHash() {
		let oldStatus = this.status;
		this.status = TextCache_VERIFYING;
		let mismatches = await Verificator.verify(
			(await OS.File.exists(this.tmpFile.path)) ? this.tmpFile.path : this.destinationFile,
			this.hashCollection,
			progress => {
				this.partialSize = progress;
				this.invalidate();
			});
		if (!mismatches) {
			log(LOG_ERROR, "hash not computed");
			Prompts.alert(window, _('error', ["Metalink"]), _('verificationfailed', [this.destinationFile]));
			return true;
		}
		else if (mismatches.length) {
			log(LOG_ERROR, "Mismatches: " + mismatches.toSource());
			return (await this.verifyHashError(mismatches));
		}
		this.status = oldStatus;
		return true;
	}

	async verifyHashError(mismatches) {
		async function deleteFile(file) {
			try {
				await OS.File.remove(file.path);
			}
			catch (ex if ex.becauseNoSuchFile) {
				// no op
			}
		}

		function recoverPartials(download) {
			// merge
			for (let i = mismatches.length - 1; i > 0; --i) {
				if (mismatches[i].start === mismatches[i-1].end + 1) {
					mismatches[i-1].end = mismatches[i].end;
					mismatches.splice(i, 1);
				}
			}
			let chunks = [];
			let next = 0;
			for (let mismatch of mismatches) {
				if (next !== mismatch.start) {
					chunks.push(new Chunk(download, next, mismatch.start - 1, mismatch.start - next));
				}
				chunks.push(new Chunk(download, mismatch.start, mismatch.end));
				next = mismatch.end + 1;
			}
			if (next !== download.totalSize) {
				log(LOG_DEBUG, "Inserting last");
				chunks.push(new Chunk(download, next, download.totalSize - 1, download.totalSize - next));
			}
			download.chunks = chunks;
			download.refreshPartialSize();
			download.queue();
		}

		let file = this.destinationLocalFile;
		filterInSitu(mismatches, e => e.start !== e.end);

		if (mismatches.length && (await OS.File.exists(this.tmpFile.path))) {
			// partials
			let act = Prompts.confirm(
				window,
				_('verifyerror.title'),
				_('verifyerror.partialstext'),
				_('recover'),
				_('delete'),
				_('keep'));
			switch (act) {
				case 0:
					await deleteFile(file);
					recoverPartials(this, mismatches);
					return false;
				case 1:
					await deleteFile(file);
					this.cancel();
					return false;
			}
			return true;
		}
		let act = Prompts.confirm(
			window,
			_('verifyerror.title'),
			_('verifyerror.text'),
			_('retry'),
			_('delete'),
			_('keep'));
		switch (act) {
			case 0:
				await deleteFile();
				this.safeRetry();
				return false;
			case 1:
				await deleteFile();
				this.cancel();
				return false;
		}
		return true;
	}

	customFinishEvent() {
		new CustomAction(this, Prefs.finishEvent);
	}

	async setAttributes() {
		if (Prefs.setTime) {
			// XXX: async API <https://bugzilla.mozilla.org/show_bug.cgi?id=924916>
			try {
				let time = this.startDate.getTime();
				try {
					time = this.visitors.time;
				}
				catch (ex) {
					log(LOG_DEBUG, "no visitors time", ex);
				}
				// small validation. Around epoche? More than a month in future?
				if (time < 2 || time > Date.now() + 30 * 86400000) {
					throw new Exception("invalid date encountered: " + time + ", will not set it");
				}
				// have to unwrap
				this.destinationLocalFile.lastModifiedTime = time;
			}
			catch (ex) {
				log(LOG_ERROR, "Setting timestamp on file failed: ", ex);
			}
		}
		let file = null;
		if (!this.isOf(COMPLETE | FINISHING)) {
			file = this._tmpFile || null;
		}
		else {
			file = this.destinationLocalFile;
		}
		try {
			this.totalSize = this.partialSize = (await OS.File.stat(file.path)).size;
		}
		catch (ex) {
			log(LOG_ERROR, "failed to get filesize for " + file.path, ex);
			this.totalSize = this.partialSize = 0;
		}
		return true;
	}

	async closeChunks() {
		if (!this.chunks) {
			return;
		}
		for (let i = 0; i < this.chunks.length; ++i) {
			let c = this.chunks[i];
			await c.close();
			this.chunks[i] = c.clone();
		}
	}

	critical() {
		this._criticals++;
	}

	uncritical() {
		this._criticals = Math.max(0, this._criticals - 1);
	}

	finishDownload(exception) {
		if (this._finishDownloadTask) {
			return this._finishDownloadTask;
		}
		log(LOG_DEBUG, "finishDownload, connections: " + this.sessionConnections);

		// Last speed update
		this.refreshPartialSize();
		this.dialog._sum += this.speeds.add(this.partialSize + this.otherBytes, Utils.getTimestamp());
		if (!this.partialSize) {
			log(LOG_ERROR, "INVALID SIZE!!!!!");
			this.fail(_("accesserror"), _("accesserror.long"), _("accesserror"));
			return;
		}

		return this._finishDownloadTask = this._runFinishDownloadTask();
	}

	async _runFinishDownloadTask() {
		try {
			this.setState(FINISHING);
			this.status = TextCache_FINISHING;
			await this.closeChunks();
			if (this.hashCollection && !(await this.verifyHash())) {
				return;
			}
			if ("isMetalink" in this) {
				this.handleMetalink();
				return;
			}
			try {
				if (!(await this.moveCompleted())) {
					log(LOG_DEBUG, "moveCompleted scheduled!");
					return;
				}
			}
			catch (iex) {
				log(LOG_ERROR, "move failed", iex);
				this.fail(
					_("moveerror"),
					_("moveerror.long"),
					_("moveerror.status", iex.message || iex)
				);
				return;
			}
				
			await this.setAttributes();
			if (Prefs.finishEvent) {
				this.customFinishEvent();
			}
			this.chunks.length = 0;
			this.speeds.clear();
			this.activeChunks = 0;
			this.setState(COMPLETE);
			this.status = TextCache_COMPLETE;
			this.visitors = new VisitorManager();
			this.compression = null;
		}
		catch (ex) {
			log(LOG_ERROR, "complete: ", ex);
			this.fail(_("accesserror"), _("accesserror.long"), _("accesserror"));
		}
		finally {
			delete this._finishDownloadTask;
		}
	}

	rebuildDestination() {
		try {
			let mask = Utils.removeFinalSlash(Utils.normalizeSlashes(Utils.removeFinalChar(
					this.rebuildDestination_renamer(this.mask), "."
					)));
			let file = new Instances.LocalFile(this.pathName);
			if (!~mask.indexOf(Utils.SYSTEMSLASH)) {
				file.append(Utils.removeBadChars(mask).trim());
			}
			else {
				mask = mask.split(Utils.SYSTEMSLASH);
				for (let i = 0, e = mask.length; i < e; ++i) {
					file.append(Utils.removeBadChars(mask[i]).trim());
				}
			}
			this._destinationName = file.leafName;
			let pd = file.parent;
			this._destinationPath = identity(pd.path);
			this._destinationNameFull = Utils.formatConflictName(
					this.destinationNameOverride ? this.destinationNameOverride : this._destinationName,
					this.conflicts
				);
			pd.append(this.destinationName);
			this._destinationFile = pd.path;
			this._destinationLocalFile = pd;
		}
		catch(ex) {
			this._destinationName = this.fileName;
			this._destinationPath = Utils.addFinalSlash(this.pathName);
			this._destinationNameFull = Utils.formatConflictName(
					this.destinationNameOverride || this._destinationName,
					this.conflicts
				);
			let file = new Instances.LocalFile(this.destinationPath);
			file.append(this.destinationName);
			this._destinationFile = file.path;
			this._destinationLocalFile = file;
			log(LOG_ERROR, "rebuildDestination():", ex);
		}
		finally {
			this._icon = null;
			let dummy = this.iconProp; // set up initial icon to avoid display problems
			FileExts.add();
		}
	}

	checkConflicts() {
		return ConflictManager.check(this);
	}

	resolveConflicts() {
		return ConflictManager.resolve(this);

	}

	fail(title, msg, state) {
		log(LOG_INFO, "failDownload invoked");

		this.cancel(state);

		if (Prefs.soundsError) {
			$("sound_error").play();
		}

		switch (Prefs.alertingSystem) {
			case 1:
				AlertService.show(title, msg);
				break;
			case 0:
				window.alert(msg);
				break;
		}
	}

	cancel(message) {
		try {
			const state = this.state;
			if (state === RUNNING) {
				if (this.chunks) {
					// must set state here, already, to avoid confusing the connections
					this.setState(CANCELED);
					for (let c of this.chunks) {
						if (c.running) {
							c.cancelChunk();
						}
					}
				}
				this.activeChunks = 0;
			}
			this.setState(CANCELED);
			return this._cancelClose(message);
		}
		catch(ex) {
			log(LOG_ERROR, "cancel():", ex);
		}
	}

	async _cancelClose(message) {
		try {
			await this.closeChunks();
			if (this._preallocTask) {
				await this._preallocTask;
			}
			log(LOG_INFO, this.fileName + ": canceled");

			this.shutdown();
			await this.removeTmpFile();

			// gc
			if (this.deleting) {
				return;
			}
			if (!message) {
				message = _("canceled");
			}

			this.status = message;
			this.visitors = new VisitorManager();
			this.chunks.length = 0;
			this.progress = this.totalSize = this.partialSize = 0;
			this.conflicts = 0;
			this.resumable = true;
			this._maxChunks = this._activeChunks = 0;
			this._autoRetries = 0;
			delete this._autoRetryTime;
			this.speeds.clear();
			this.otherBytes = 0;
			this.save();
		}
		catch (ex) {
			log(LOG_ERROR, "cancel() Task", ex);
		}
	}

	async cleanup() {
		if (this.chunks) {
			await this.closeChunks();
		}
		delete this.visitors;
		delete this.chunks;
		delete this.speeds;
		delete this.urlManager;
		delete this.referrer;
		delete this._referrerUrlManager;
		delete this._destinationLocalFile;
		delete this._tmpFile;
		delete this.rebuildDestination_renamer;
	}

	prealloc() {
		let file = this.tmpFile;

		if (this.state !== RUNNING) {
			return;
		}

		if (!this.totalSize) {
			log(LOG_DEBUG, "pa: no totalsize");
			return;
		}
		if (this._preallocTask) {
			log(LOG_DEBUG, "pa: already working");
			return;
		}

		this._preallocTask = this._preallocInternal(file);
	}

	async _preallocInternal(file) {
		try {
			try {
				await Utils.makeDir(file.parent, Prefs.dirPermissions);
			}
			catch (ex if ex.becauseExists) {
				// no op
			}
			try {
				if (this.totalSize === (await OS.File.stat(file.path)).size) {
					log(LOG_INFO, "pa: already allocated");
					return;
				}
			}
			catch (ex if ex.becauseNoSuchFile) {
				// no op
			}
			let pa = Preallocator.prealloc(
				file,
				this.totalSize,
				Prefs.permissions,
				Prefs.sparseFiles
				);
			if (pa) {
				await pa;
				log(LOG_INFO, "pa: done");
			}
			else {
				log(LOG_INFO, "pa: not preallocating");
			}
		}
		catch(ex) {
			log(LOG_ERROR, "pa: failed", ex);
		}
		finally {
			this._preallocTask = null;
			this.maybeResumeDownload();
		}
	}

	shutdown() { }

	async removeTmpFile() {
		let tmpFile = this._tmpFile;
		delete this._tmpFile;
		if (!tmpFile) {
			return;
		}
		try {
			await OS.File.remove(tmpFile.path);
		}
		catch (ex if ex.becauseNoSuchFile) {
			// no op
		}
		catch (ex) {
			log(LOG_ERROR, "failed to remove tmpfile: " + tmpFile.path, ex);
		}
	}

	pauseAndRetry() {
		let retry = this.state === RUNNING;
		this.pause();
		this.resumable = true;

		if (retry && Prefs.autoRetryInterval && !(Prefs.maxAutoRetries && Prefs.maxAutoRetries <= this._autoRetries)) {
			this.dialog.markAutoRetry(this);
			this._autoRetryTime = Utils.getTimestamp();
			log(LOG_INFO, "marked auto-retry: " + this);
		}
		this.save();
	}

	autoRetry() {
		if (!this.autoRetrying || Utils.getTimestamp() - (Prefs.autoRetryInterval * 1000) < this._autoRetryTime) {
			return false;
		}

		this._autoRetryTime = 0;
		++this._autoRetries;
		this.queue();
		log(LOG_DEBUG, "Requeued due to auto-retry: " + this);
		return true;
	}
	clearAutoRetry() {
		this._autoRetryTime = 0;
		this._autoRetries = 0;
	}

	queue() {
		this._autoRetryTime = 0;
		this.setState(QUEUED);
		this.status = TextCache_QUEUED;
	}

	maybeResumeDownload() {
		if (this.state !== RUNNING) {
			return;
		}
		this.resumeDownload();
	}

	resumeDownload() {
		log(LOG_DEBUG, "resumeDownload: " + this);

		// merge finished chunks together, so that the scoreboard does not bloat
		// that much
		for (let i = this.chunks.length - 2; i > -1; --i) {
			let c1 = this.chunks[i], c2 = this.chunks[i + 1];
			if (c1.complete && c2.complete && !c1.buffered && !c2.buffered) {
				c1.merge(c2);
				this.chunks.splice(i + 1, 1);
			}
		}

		try {
			if (this.dialog.offline || this.maxChunks <= this.activeChunks) {
				return false;
			}

			var rv = false;

			// we didn't load up anything so let's start the main chunk (which will
			// grab the info)
			if (!this.chunks.length) {
				downloadNewChunk(this, 0, 0, true);
				this.sessionConnections = 0;
				return false;
			}


			// start some new chunks
			let paused = this.chunks.filter(chunk => !(chunk.running || chunk.complete));

			while (this.activeChunks < this.maxChunks) {
				if (this._preallocTask && this.activeChunks) {
					log(LOG_DEBUG, "not resuming download " + this + " because preallocating");
					return true;
				}

				// restart paused chunks
				if (paused.length) {
					let p = paused.shift();
					downloadOldChunk(this, p, p.end === 0);
					rv = true;
					continue;
				}

				if (this.chunks.length === 1 &&
					!!Prefs.loadEndFirst &&
					this.chunks[0].remainder > 3 * Prefs.loadEndFirst) {
					// we should download the end first!
					let c = this.chunks[0];
					let end = c.end;
					c.end -= Prefs.loadEndFirst;
					downloadNewChunk(this, c.end + 1, end);
					rv = true;
					continue;
				}

				// find biggest chunk
				let biggest = null;
				for (let chunk of this.chunks) {
					if (chunk.running && chunk.remainder > MIN_CHUNK_SIZE * 2) {
						if (!biggest || biggest.remainder < chunk.remainder) {
							biggest = chunk;
						}
					}
				}

				// nothing found, break
				if (!biggest) {
					break;
				}
				let end = biggest.end;
				biggest.end = biggest.start + biggest.written + Math.floor(biggest.remainder / 2);
				downloadNewChunk(this, biggest.end + 1, end);
				rv = true;
			}
			if (this.activeChunks < 1 &&
					this.chunks.some(chunk => !(chunk.running || chunk.complete))) {
				throw new Error("Nothing started but no actives, yet paused");
			}

			return rv;
		}
		catch(ex) {
			this.dumpScoreboard();
			log(LOG_ERROR, "resumeDownload():", ex, true);
		}
		return false;
	}

	replaceMirrors(mirrors) {
		let restart = this.urlManager.length < 3;
		this.urlManager.initByArray(mirrors);
		if (restart && this.resumable && this.state === RUNNING && this.maxChunks > 2) {
			// stop some chunks and restart them
			log(LOG_DEBUG, "Stopping some chunks and restarting them after mirrors change");
			let omc = this.maxChunks;
			this.maxChunks = 2;
			this.maxChunks = omc;
		}
		this.invalidate();
		this.save();
	}

	dumpScoreboard() {
		if (!log.enabled) {
			return;
		}
		let scoreboard = "";
		let len = this.totalSize.toString().length;
		for (let [i,c] in Iterator(this.chunks)) {
			scoreboard += i + ": " + c + "\n";
		}
		log(LOG_DEBUG, "scoreboard\n" + scoreboard);
	}

	toString() {
		return this.urlManager.usable;
	}

	toJSON() {
		let rv = Object.create(null);
		let p = Object.getPrototypeOf(this);
		for (let u of Dialog_serialize_props) {
			// only save what is changed
			if ( !!p[u] && !!this[u] && (p[u] !== this[u])) {
				rv[u] = this[u];
			}
		}
		if (this._maxChunks) {
			rv.maxChunks = this.maxChunks;
		}
		if (this.hashCollection) {
			rv.hashCollection = this.hashCollection;
		}
		if (this.autoRetrying || this.state === RUNNING) {
			rv.state = QUEUED;
		}
		else {
			rv.state = this.state;
		}
		if (this.destinationNameOverride) {
			rv.destinationName = this.destinationNameOverride;
		}
		if (this.referrer) {
			rv.referrer = this.referrer.spec;
		}
		rv.numIstance = this.bNum;
		rv.iNum = this.iNum;
		// Store this so we can later resume.
		if (!this.isOf(CANCELED | COMPLETE) && this.partialSize) {
			rv.tmpFile = this.tmpFile.path;
		}
		rv.startDate = this.startDate.getTime();

		rv.urlManager = this.urlManager;
		rv.visitors = this.visitors;

		if (!this.resumable && this.state !== COMPLETE) {
			rv.totalSize = 0;
		}
		else {
			rv.totalSize = this.totalSize;
		}
		if (this.isOf(RUNNING | PAUSED | QUEUED) && this.resumable) {
			rv.chunks = this.chunks;
		}
		return rv;
	}
};
Object.assign(QueueItem.prototype, {
	state: QUEUED,
	position: -1,

	_contentType: "",
	_description: null,
	_hashCollection: null,
	_mask: null,
	_pathName: null,
	_prettyHash: null,
	_status : '',
	_title: '',
	bNum: 0,
	compression: null,
	fromMetalink: false,
	iNum: 0,
	postData: null,
	visitors: null,

	_destinationFile: null,
	_destinationLocalFile: null,
	_destinationName: null,
	_destinationNameFull: null,
	_destinationPath: '',
	_fileName: null,
	_tmpFile: null,
	destinationNameOverride: null,
	fileNameFromUser: false,

	_totalSize: 0,
	otherBytes: 0,
	partialSize: 0,
	progress: 0,
	relaxSize: false,

	_activeChunks: 0,
	_maxChunks: 0,
	timeLastProgress: 0,
	timeStart: 0,

	_bucket: null,
	_icon: null,

	_autoRetries: 0,
	_autoRetryTime: 0,
	_conflicts: 0,
	_criticals: 0,
	_speedLimit: -1,
	mustGetInfo: false,
	resumable: true,
	sessionConnections: 0,
	started: false,
});

XPCOMUtils.defineLazyGetter(QueueItem.prototype, 'AuthPrompts', function() {
	const {LoggedPrompter} = require("support/loggedprompter");
	return new LoggedPrompter(window);
});

function CustomAction(download, command) {
	try {
		// may I introduce you to a real bastard way of commandline parsing?! :p
		var uuids = {};
		let callback = function (u) {
			u = u.substr(1, u.length - 2);
			let id = Utils.newUUIDString();
			uuids[id] = u;
			return id;
		};
		let mapper = function(arg, i) {
			if (arg === "%f") {
				if (!i) {
					throw new Error("Will not execute the file itself");
				}
				arg = download.destinationFile;
			}
			else if (arg in uuids) {
				arg = uuids[arg];
			}
			return arg;
		};
		var args = mapInSitu(
			command
				.replace(/(["'])(.*?)\1/g, callback)
				.split(/ /g),
			mapper);
		var program = new Instances.LocalFile(args.shift());
		var process = new Instances.Process(program);
		process.run(false, args, args.length);
	}
	catch (ex) {
		log(LOG_ERROR, "failed to execute custom event", ex);
		window.alert("failed to execute custom event", ex);
	}
	download.complete();
}

var startDownloads = (function() {
	const series = {};
	lazy(series, "num", function() {
		let rv = DTM.currentSeries();
		DTM.incrementSeries();
		return rv;
	});
	let busy = false;
	let queue = [];

	let next = function (start, downloads, scroll) {
		busy = true;

		let iNum = 0;
		let first = null;
		let g = downloads;
		if ('length' in downloads) {
			g = (function*() {
				for (let i of downloads) {
					yield i;
				}
			})();
		}

		let addItem = function(e) {
			try {
				let qi = new QueueItem(Dialog);
				let lnk = e.url;
				if (typeof lnk === 'string') {
					qi.urlManager = new UrlManager([new DTM.URL(Services.io.newURI(lnk, null, null))]);
				}
				else if (lnk instanceof UrlManager) {
					qi.urlManager = lnk;
				}
				else {
					qi.urlManager = new UrlManager([lnk]);
				}
				qi.bNum = e.numIstance || series.num;
				qi.iNum = ++iNum;

				if (e.referrer) {
					try {
						if (typeof(e.referrer) === "string") {
							qi.referrer = toURL(e.referrer);
						}
						else if (e.referrer.spec) {
							qi.referrer = toURL(e.referrer.spec);
						}
						else if (e.referrer.url && e.referrer.url.spec) {
							qi.referrer = toURL(e.referrer.url.spec);
						}
						else {
							throw new Error("Don't know how to handle");
						}
					}
					catch (ex) {
						log(LOG_ERROR, "Failed to ref", ex);
						// We might have been fed with about:blank or other crap. so ignore.
					}
				}
				// only access the setter of the last so that we don't generate stuff trice.
				qi._pathName = identity(Utils.addFinalSlash(e.dirSave));
				qi._description = identity(!!e.description ? e.description : '');
				qi._title = identity(!!e.title ? e.title : '');
				qi._mask = identity(Utils.removeFinalSlash(Utils.removeLeadingSlash(Utils.normalizeSlashes(e.mask))));
				qi.fromMetalink = !!e.fromMetalink;
				if (e.fileName) {
					qi._fileName = Utils.getUsableFileName(e.fileName);
					qi.fileNameFromUser = true;
				}
				else {
					qi._fileName = Utils.getUsableFileName(qi.urlManager.usable);
				}
				if (e.destinationName) {
					qi._destinationNameOverride = Utils.getUsableFileName(e.destinationName);
				}
				if (e.startDate) {
					qi.startDate = e.startDate;
				}

				// hash?
				if (e.hashCollection) {
					qi.hashCollection = e.hashCollection;
				}
				else if (e.url.hashCollection) {
					qi.hashCollection = e.url.hashCollection;
				}
				else if (e.hash) {
					qi.hashCollection = new DTM.HashCollection(e.hash);
				}
				else if (e.url.hash) {
					qi.hashCollection = new DTM.HashCollection(e.url.hash);
				}
				else {
					qi.hashCollection = null; // to initialize prettyHash
				}

				qi.isPrivate = !!e.isPrivate || false;

				let postData = ContentHandling.getPostDataFor(qi.urlManager.url, qi.isPrivate);
				if (e.url.postData) {
					postData = e.url.postData;
				}
				if (postData) {
					qi.postData = postData;
				}

				qi.cleanRequest = !!e.cleanRequest || false;

				if (start) {
					qi._setStateInternal(QUEUED);
					qi.status = TextCache_QUEUED;
				}
				else {
					qi._setStateInternal(PAUSED);
					qi.status = TextCache_PAUSED;
				}

				if (!("isPrivate" in e)) {
					log(LOG_INFO,
							"A queued item has no isPrivate property. Defaulting to false. " +
							"Please check the code path for proper PBM support!");
				}

				qi.rebuildDestination();
				RequestManipulation.modifyDownload(qi);
				Tree.add(qi);
				qi.save();
				first = first || qi;
			}
			catch (ex) {
				log(LOG_ERROR, "addItem", ex);
			}

			return true;
		};

		Tree.beginUpdate();
		QueueStore.beginUpdate();
		let ct = new CoThreadListWalker(
			addItem,
			g,
			-1
		).start(function() {
			QueueStore.endUpdate();
			Tree.invalidate();
			Tree.endUpdate();
			ct = null;
			g = null;
			if (scroll && Prefs.scrollToNew) {
				Tree.scrollToNearest(first);
			}

			while (queue.length) {
				try {
					let {start, downloads, scrollNext} = queue.shift();
					next(start, downloads, scrollNext);
					return;
				}
				catch (ex) {
					log(LOG_ERROR, "Failed to run next startDownloads", ex);
				}
			}
			busy = false;
		});
	};

	return function startDownloads(start, downloads, scroll) {
		scroll = !(scroll === false);
		if (busy) {
			queue.push({start: start, downloads: downloads, scroll: scroll});
		}
		else {
			next(start, downloads, scroll);
		}
	};
})();

addEventListener(
	"load",
	function  minimize_on_load() {
		removeEventListener("load", minimize_on_load, false);
		if (!Preferences.getExt('startminimized', false)) {
			return;
		}
		if (!window.arguments || !window.arguments[0]) {
			return;
		}
		setTimeoutOnlyFun(
			function() {
				try {
					window.QueryInterface(Ci.nsIDOMChromeWindow).minimize();
					if (window.opener) {
						window.opener.focus();
					}
				}
				catch (ex) {
				}
			},
			0
		);
	},
	false
);
