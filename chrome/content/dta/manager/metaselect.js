/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
/* global $, _, Utils, getDefaultDownloadsDirectory, openUrl */
/* jshint browser:true */

var hidpi = window.matchMedia && window.matchMedia("(min-resolution: 2dppx)").matches;
var METALINK_LOGO = hidpi ? 'chrome://dta/skin/common/metalink64.png' : 'chrome://dta/skin/common/metalink32.png';

var Version = require("version");

var MetaSelect = {
	_insertDownload: function(d) {
		try {
			if (d.lang && ~d.lang.search(/^\w{2}(?:-\w{2})?$/)) {
				d.selected = Version.LOCALE.slice(0, 2) === d.lang.slice(0, 2);
			}
			let e = document.createElement('richlistitem');
			e.setAttribute("class", "item");
			e.download = d;
			$('downloads').appendChild(e);
		}
		catch (ex) {
			log(LOG_ERROR, "Failed to add download from metalink", ex);
		}
	},
	load: function() {
		$('cancelbutton').label = _('button-cancel');

		try {
			let downloads = window.arguments[0];
			if (downloads.length) {
				downloads.forEach(this._insertDownload, this);
			}
		}
		catch(ex) {
			log(LOG_ERROR, "Failed to load downloads from Metalink", ex);
			// no-op
		}
		let info = {
			'identity': _('mlidentity'),
			'description': _('ml.description'),
			'logo': null,
			'publisher': null,
			'license': null
		};
		try {
			let oi = window.arguments[1];
			for (let x in info) {
				if (x in oi && oi[x]) {
					info[x] = oi[x];
				}
			}
		}
		catch (ex) {
			// no-op
		}
		$('identity').value = info.identity;
		$('desc').appendChild(document.createTextNode(info.description));
		let logo = new Image();
		logo.addEventListener("load", function() {
			let canvas = $('icon');
			try {
				canvas.width = canvas.clientWidth;
				canvas.height = canvas.clientHeight;
				let ctx = canvas.getContext('2d');

				let w = logo.naturalWidth;
				let h = logo.naturalHeight;
				let d = Math.max(canvas.width, w, h);

				if (d !== canvas.width) {
					ctx.scale(canvas.width / d, canvas.height / d);
				}

				ctx.drawImage(logo, (d - w) /2, (d - h) / 2);
			}
			catch (ex) {
				log(LOG_ERROR, "Cannot load logo", ex);
				logo.src = METALINK_LOGO;
			}
		}, false);
		logo.addEventListener("error", function() {
			logo.src = METALINK_LOGO;
		}, false);
		logo.src = info.logo ? info.logo : METALINK_LOGO;
		if (info.publisher) {
			let e = $('publisher');
			e.value = info.publisher[0];
			e.link = info.publisher[1];
		}
		else {
			$('boxPublisher').hidden = true;
		}
		if (info.license) {
			let e = $('license');
			e.value = info.license[0];
			e.link = info.license[1];
		}
		else {
			$('boxLicense').hidden = true;
		}
		if (!$("directory").value) {
			getDefaultDownloadsDirectory(function(path) {
				$("directory").value = path;
			});
		}
	},
	browseDir: function() {
		// get a new directory
		Utils.askForDir(
			$('directory').value, // initialize dialog with the current directory
			_("valid.destination"),
			function(newDir) {
				if (newDir) {
					$('directory').value = newDir;
				}
			});
	},
	download: function(start) {
		let [notifications, directory, mask, ] = $('notifications', 'directory', 'renaming');
		let ignoreImportedSavePath = $("ignoreImportedSavePath").checked;
		let copyDirectoryStructure = $("copyDirectoryStructure").checked;
		let ignoreProxyPath = $("ignoreProxyPath").checked;
		notifications.removeAllNotifications(true);

		function err(msg) {
			notifications.appendNotification(msg, 0, null, notifications.PRIORITY_CRITICAL_MEDIUM, null);
		}

		directory.value = directory.value.trim();
		mask.value = mask.value.trim();

		if (!mask.value) {
			err(_('alert.mask'));
			return false;
		}
		if (!directory.value || !Utils.validateDir(directory.value)) {
			err(_(directory.value ? 'alert.invaliddir' : 'alert.nodir'));
			return false;
		}

		let selected = false;
		Array.forEach(
			document.getElementsByTagName('richlistitem'),
			function(n) {
				//to be sure we have trailing slash [todo] detect which slash to add dep. on OS
				function trailing_slash(local_url){
					if(local_url[local_url.length-1]!='/' && local_url[local_url.length-1]!='\\'){
						local_url+='\\';
					}
					return local_url;
				}
				//log(LOG_DEBUG, JSON.stringify(ignoreImportedSavePath));
				let subDir = '';
				let dirSave = '';
				let dirSaveDefault = trailing_slash(directory.value);
				let destinationPath = trailing_slash(n.download.destinationPath.trim());
				if(ignoreImportedSavePath){
					dirSave = dirSaveDefault;
				} else {
					if(destinationPath.indexOf('.')==0 || destinationPath.indexOf('..')==0){
						//it's subfolder
						dirSave = dirSaveDefault+destinationPath;
					} else {
						dirSave = destinationPath || dirSaveDefault;
					}
				}

				if(copyDirectoryStructure){
					//should form subdir structure
					let url = decodeURI(n.download.url.usable);
					if(url.indexOf('data:')==0){
						subDir = 'base64';
					} else {
						//detect which part we want to treat as dir structure root
						if(ignoreProxyPath){
							subDir = url.substring(url.lastIndexOf("://")+3, url.length);
						} else {
							subDir = url.substring(url.indexOf("://")+3, url.length);
						}

						//replacing illegal symbols with fullwidth counterparts ＼／：＊？＂＜＞｜
						subDir = subDir
						.replace(/\*/g,'＊')
						.replace(/\:/g,'：')
						.replace(/\?/g,'？')
						.replace(/\</g,'＜')
						.replace(/\>/g,'＞')
						.replace(/\|/g,'｜')
						.replace(/\\/g,'＼')
						;
						subDir = subDir.replace(/\/+/g,'\\');
						log(LOG_DEBUG, subDir); 
					}
					dirSave+=subDir;
				}
				n.download.dirSave = dirSave;
				n.download.mask = mask.value;
				n.download.selected = n.checked;
				selected |= n.checked;
			},
			this
		);
		if (!selected) {
			err(_('no.links'));
			return false;
		}
		window.arguments[1].start = start;
		close();
		if (window.arguments[2]) {
			window.arguments[2]();
		}
		return true;
	},
	cancel: function() {
		Array.forEach(
			document.getElementsByTagName('richlistitem'),
			function(n) {
				n.download.selected = false;
			},
			this
		);
		close();
		if (window.arguments[2]) {
			window.arguments[2]();
		}
		return true;
	},
	openLink: function(e) {
		openUrl(e.link);
	},
	select: function(type) {
		let f;
		switch (type) {
		case 'all':
			f = function(node) { return true; };
		break;
		case 'none':
			f = function(node) { return false; };
		break;
		case 'invert':
			f = function(node) { return !node.checked; };
		break;
		default:
		return;
		}
		let nodes = document.getElementsByTagName('richlistitem');
		for (let i = 0, e = nodes.length, node; i < e; ++i) {
			node = nodes[i];
			node.checked = f(node);
		}
	}
};
addEventListener('load', function loadSelf() {
	removeEventListener('load', loadSelf, false);
	try {
		MetaSelect.load();
	}
	catch (ex) {
		log(LOG_ERROR, "Failed to load", ex);
	}
}, false);
opener.addEventListener("unload", function unloadOpener() {
	opener.removeEventListener("unload", unloadOpener, false);
	MetaSelect.cancel();
}, false);
addEventListener('close', function unloadSelf() {
	removeEventListener('close', unloadSelf, false);
	MetaSelect.cancel();
}, false);
