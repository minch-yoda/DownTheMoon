/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const DOMAINS_FILE = "domain-prefs.json";

const {notifyLocal} = require("./observers");
const {symbolize} = require("./stringfuncs");
const {DeferredSave} = requireJSM("resource://gre/modules/DeferredSave.jsm");

const storedDomains = new Map();
const privDomains = new LRUMap(200);

const PENDING = Symbol();

class Saver extends DeferredSave {
	constructor() {
		let file = require("api").getProfileFile(DOMAINS_FILE, true).path;
		super(file, () => this.serialize(), 1000);
		this.load();
	}
	get file() {
		return this._path || this._file;
	}
	load() {
		if (!this[PENDING]) {
			this[PENDING] = this._loadAsync();
		}
		return this[PENDING];
	}
	_deferredSave() {
		super._deferredSave();
		notifyLocal("DTM:domain-prefs", null, null);
	}
	serialize() {
		let rv = [];
		for (let [domain, prefs] of storedDomains.entries()) {
			domain = Symbol.keyFor(domain);
			if (!domain) {
				continue;
			}
			let cur = [];
			for (let [pref, value] of prefs.entries()) {
				pref = Symbol.keyFor(pref);
				cur.push([pref, value]);
			}
			if (cur.length) {
				rv.push([domain, cur]);
			}
		}
		return JSON.stringify(rv);
	}
	async _loadAsync() {
		try {
			let req = await fetch(Services.io.newFileURI(new Instances.LocalFile(this.file)).spec);
			let json = await req.json();
			for (let [domain, prefs] of json) {
				domain = Symbol.for(domain);
				for (let [pref, value] of prefs) {
					let prefs = storedDomains.get(domain);
					if (!prefs) {
						prefs = new Map();
						storedDomains.set(domain, prefs);
					}
					prefs.set(symbolize(pref), value);
				}
			}
		}
		catch (ex) {
			this.saveChanges();
		}
	}
}

let saver = new Saver();
unload(function() {
	if (saver) {
		saver.flush();
	}
	saver = null;
});

function domain(url, tld) {
	try {
		return Services.eTLD.getBaseDomain(url, tld ? 0 : 3);
	}
	catch (ex) {
		try {
			log(LOG_DEBUG, "Failed to get tld for " + (url.spec || url));
			return url.host;
		}
		catch (ex) {
			return null;
		}
	}
}

function _getPref(dom, pref, defaultValue, options) {
	let prefs = null;
	if (options && options.isPrivate) {
		prefs = privDomains.get(dom);
	}
	if (!prefs) {
		prefs = storedDomains.get(dom);
	}
	if (!prefs) {
		return defaultValue;
	}
	return prefs.get(symbolize(pref)) || defaultValue;
}

function getPref(url, pref, defaultValue, options) {
	let dom = domain(url, options && options.tld);
	if (!dom) {
		return defaultValue;
	}
	return _getPref(Symbol.for(dom), pref, defaultValue, options);
}

function getHost(host, pref, defaultValue) {
	return _getPref(symbolize(host), pref, defaultValue);
}

function _setPref(dom, pref, value, options) {
	let domains = (options && options.isPrivate) ? privDomains : storedDomains;
	let prefs = domains.get(dom);
	if (!prefs) {
		prefs = new Map();
		domains.set(dom, prefs);
	}
	prefs.set(symbolize(pref), value);
	saver.saveChanges();
}

function setPref(url, pref, value, options) {
	let dom = domain(url, options && options.tld);
	if (!dom) {
		// We cannot store for stuff we cannot get a domain from
		// then again, no big deal, since the prefs are not persistent anyway at the moment
		// XXX this may change
		return;
	}
	return _setPref(Symbol.for(dom), pref, value, options);
}

function setHost(host, pref, value) {
	return _setPref(symbolize(host), pref, value);
}

function _deletePref(dom, pref, options) {
	let domains = (options && options.isPrivate) ? privDomains : storedDomains;
	let prefs = domains.get(dom);
	if (!prefs) {
		return;
	}
	prefs.delete(symbolize(pref));
	if (!prefs.size) {
		domains.delete(dom);
	}
	saver.saveChanges();
}

function deletePref(url, pref, options) {
	let dom = domain(url, options && options.tld);
	if (!dom) {
		return;
	}
	return _deletePref(Symbol.for(dom), pref, options);
}

function deleteHost(host, pref) {
	return _deletePref(symbolize(host), pref);
}


function* enumHosts() {
	for (let domain of storedDomains.keys()) {
		domain = Symbol.keyFor(domain);
		if (domain) {
			yield domain;
		}
	}
}

Object.defineProperties(exports, {
	"load": {
		value: () => saver.load(),
		enumerable: true
	},
	"get": {
		value: getPref,
		enumerable: true
	},
	"getHost": {
		value: getHost,
		enumerable: true
	},
	"set": {
		value: setPref,
		enumerable: true
	},
	"setHost": {
		value: setHost,
		enumerable: true
	},
	"delete": {
		value: deletePref,
		enumerable: true
	},
	"deleteHost": {
		value: deleteHost,
		enumerable: true
	},
	"getTLD": {
		value: function(url, pref, defaultValue, isPrivate) {
			return getPref(url, pref, defaultValue, {
				tld: true,
				isPrivate
			});
		},
		enumerable: true
	},
	"setTLD": {
		value: function(url, pref, value, isPrivate) {
			return setPref(url, pref, value, {
				tld: true,
				isPrivate
			});
		},
		enumerable: true
	},
	"deleteTLD": {
		value: function(url, pref, isPrivate) {
			return deletePref(url, pref, {
				tld: true,
				isPrivate
			});
		},
		enumerable: true
	},
	"enumHosts": {
		value: enumHosts,
		enumerable: true
	}
});
