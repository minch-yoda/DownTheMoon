/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/ */
"use strict";

const DTM = require("api");
const {getTextLinks} = require("support/textlinks");
const Version = require("version");
const {NS_DTM, NS_METALINKER3, NS_METALINK_RFC5854} = require("support/metalinker");
const {filterInSitu} = require("utils");

exports.parseTextFile = async function parseTextFile(aFile) {
	log(LOG_INFO, "Parsing text file: " + aFile.spec);

	let req = await fetch(Services.io.newFileURI(aFile).spec);
	req = await req.text();
	log(LOG_ERROR, req);
	
	let links = [];
	for (let l of getTextLinks(req, false)) {
		l = Services.io.newURI(l, null, null);
		links.push({
			url: new DTM.URL(l),
			referrer: null,
			description: 'imported from ' + aFile.leafName,
			isPrivate: false
		});
	}
	log(LOG_INFO, "parsed text file, links: " + links.length);
	return filterInSitu(links, function(e) {
		return (e = e.url.spec) && !((e in this) || (this[e] = null));
	}, {});
};

exports.exportToTextFile = function exportToTextFile(aDownloads, aFile, aPermissions) {
	let fs = new Instances.FileOutputStream(aFile, 0x02 | 0x08 | 0x20, aPermissions, 0);
	let cs = new Instances.ConverterOutputStream(fs, null, 0, null);
	for (let d of aDownloads) {
		let url = d.urlManager.spec;
		if (d.hashCollection) {
			url += '#hash(' + d.hashCollection.full.type + ":" + d.hashCollection.full.sum + ")";
		}
		url += "\r\n";
		cs.writeString(url);
	}
	cs.close();
	try { fs.close(); } catch (ex) { /* no op */ }
};

exports.exportToHtmlFile = function exportToHtmlFile(aDownloads, aDocument, aFile, aPermissions) {
	// do not localize?!
	let title = "DownTheMoon: exported on " + (new Date).toUTCString();

	let doctype = aDocument.implementation.createDocumentType('html', null, null);
	let document = aDocument.implementation.createDocument('http://www.w3.org/1999/xhtml', 'html', doctype);
	let root = document.documentElement;

	{
		let head = document.createElement('head');

		let n = document.createElement('title');
		n.textContent = title;
		head.appendChild(n);

		n = document.createElement('meta');
		n.setAttribute('http-equiv', 'content-type');
		n.setAttribute('content', 'application/xhtml+xml;charset=utf-8');
		head.appendChild(n);

		n = document.createElement('link');
		n.setAttribute('rel', 'stylesheet');
		n.setAttribute('type', 'text/css');
		n.setAttribute('href', 'chrome://dtm-public/skin/exporthtml.css');
		head.appendChild(n);

		root.appendChild(head);
	}
	{
		let addDesc = function(key, value, element) {
			let div = document.createElement('div');
			div.className = 'desc';

			div.appendChild(document.createTextNode(key + ": "));

			let b = document.createElement('strong');
			b.textContent = value;
			div.appendChild(b);

			element.appendChild(div);
		};


		let body = document.createElement('body');

		let n = document.createElement('h1');
		n.textContent = title;
		body.appendChild(n);

		let list = document.createElement('ol');
		for (let d of aDownloads) {
			let url = d.urlManager.spec;
			if (d.hashCollection) {
				url += '#hash(' + d.hashCollection.full.type + ":" + d.hashCollection.full.sum + ")";
			}
			let desc = d.description;
			if (!desc) {
				desc = d.fileName;
			}
			let li = document.createElement('li');

			let div = document.createElement('div');
			n = document.createElement('a');
			n.setAttribute('href', url);
			n.textContent = desc;
			div.appendChild(n);
			li.appendChild(div);

			addDesc('URL', d.urlManager.usable, li);
			if (d.referrer) {
				addDesc('Referrer', d.referrer.spec, li);
			}
			if (d.hashCollection) {
				addDesc(d.hashCollection.full.type, d.hashCollection.full.sum.toLowerCase(), li);
			}
			list.appendChild(li);
		}
		body.appendChild(list);

		let foot = document.createElement('p');
		foot.appendChild(document.createTextNode('Exported by '));
		n = document.createElement('a');
		n.setAttribute('href', 'http://www.downthemoon.nope/');
		n.textContent = 'DownTheMoon! ' + Version.VERSION;
		foot.appendChild(n);
		body.appendChild(foot);

		root.appendChild(body);
	}


	let fs = new Instances.FileOutputStream(aFile, 0x02 | 0x08 | 0x20, aPermissions, 0);
	Instances.domserializer.serializeToStream(document, fs, 'utf-8');
	fs.close();
};

exports.exportToMetalinkFile = function exportToMetalinkFile(aDownloads, aDocument, aFile, aPermissions) {
	let document = aDocument.implementation.createDocument(NS_METALINKER3, 'metalink', null);
	let root = document.documentElement;
	root.setAttribute('type', 'static');
	root.setAttribute('version', '3.0');
	root.setAttribute('generator', 'DownTheMoon!/' + Version.BASE_VERSION);
	root.setAttributeNS(NS_DTM, 'version', Version.VERSION);
	root.setAttribute('pubdate', new Date().toUTCString());

	root.appendChild(document.createComment(
			"metalink as exported by DownTheMoon! on " +
			Version.APP_NAME + "/" + Version.APP_VERSION +
			"\r\nMay contain DownTheMoon! specific information in the DownTheMoon! namespace: " +
			NS_DTM
			));

	let files = document.createElementNS(NS_METALINKER3, 'files');
	for (let d of aDownloads) {
		let f = document.createElementNS(NS_METALINKER3, 'file');
		f.setAttribute('name', d.fileName);
		f.setAttributeNS(NS_DTM, 'num', d.bNum);
		f.setAttributeNS(NS_DTM, 'startDate', d.startDate.getTime());
		if (d.referrer) {
			f.setAttributeNS(NS_DTM, 'referrer', d.referrer.spec);
		}

		if (d.description) {
			let n = document.createElementNS(NS_METALINKER3, 'description');
			n.textContent = d.description;
			f.appendChild(n);
		}
		let r = document.createElementNS(NS_METALINKER3, 'resources');
		for (let u of d.urlManager.all) {
			let n = document.createElementNS(NS_METALINKER3, 'url');
			let t = u.spec.match(/^(\w+):/);
			n.setAttribute('type', t[1]);
			n.setAttribute('preference', u.preference);
			n.setAttributeNS(NS_DTM, 'usable', u.usable);
			n.textContent = u.spec;
			r.appendChild(n);
		}
		if (d.hashCollection) {
			let v = document.createElementNS(NS_METALINKER3, 'verification');
			let h = document.createElementNS(NS_METALINKER3, 'hash');
			h.setAttribute('type', d.hashCollection.full.type.toLowerCase());
			h.textContent = d.hashCollection.full.sum.toLowerCase();
			v.appendChild(h);
			// XXX implement chunks
			f.appendChild(v);
		}
		f.appendChild(r);

		if (d.totalSize > 0) {
			let s = document.createElementNS(NS_METALINKER3, 'size');
			s.textContent = d.totalSize;
			f.appendChild(s);
		}

		files.appendChild(f);

	}
	root.appendChild(files);

	let fs = new Instances.FileOutputStream(aFile, 0x02 | 0x08 | 0x20, aPermissions, 0);
	let xml = '<?xml version="1.0"?>\r\n';
	fs.write(xml, xml.length);
	Instances.domserializer.serializeToStream(document, fs, 'utf-8');
	fs.close();
};

exports.exportToMetalink4File = function exportToMetalink4File(aDownloads, aDocument, aFile, aPermissions) {
	let document = aDocument.implementation.createDocument(NS_METALINK_RFC5854, 'metalink', null);
	let root = document.documentElement;
	root.setAttribute('version', '4.0');
	root.setAttributeNS(NS_DTM, 'version', Version.VERSION);

	root.appendChild(document.createComment(
			"metalink as exported by DownTheMoon! on " +
			Version.APP_NAME + "/" + Version.APP_VERSION +
			"\r\nMay contain DownTheMoon! specific information in the DownTheMoon! namespace: " +
			NS_DTM
			));

	let generator = document.createElementNS(NS_METALINK_RFC5854, 'generator');
	generator.textContent = 'DownTheMoon!/' + Version.BASE_VERSION;
	root.appendChild(generator);

	let published = document.createElementNS(NS_METALINK_RFC5854, "published");
	published.textContent = new Date().toUTCString();
	root.appendChild(published);

	for (let d of aDownloads) {
		let f = document.createElementNS(NS_METALINK_RFC5854, 'file');
		f.setAttribute('name', d.fileName);
		f.setAttributeNS(NS_DTM, 'num', d.bNum);
		
		/* additions to include referrer and all file related params */
		/* _fileNameAndExtension;_destinationName;_destinationPath;_destinationNameFull;_destinationFile;_destinationLocalFile; */
		//f.setAttributeNS(NS_DTM, 'destinationLocalFile', d._destinationLocalFile);
		//f.setAttributeNS(NS_DTM, 'fileNameAndExtension', d._fileNameAndExtension);
		f.setAttributeNS(NS_DTM, 'destinationNameFull', d._destinationNameFull);
		f.setAttributeNS(NS_DTM, 'destinationFile', d._destinationFile);

		
		f.setAttributeNS(NS_DTM, 'destinationName', d._destinationName);
		f.setAttributeNS(NS_DTM, 'destinationPath', d._destinationPath);
		f.setAttributeNS(NS_DTM, 'pathName', d._pathName);
		f.setAttributeNS(NS_DTM, 'title', d._title);
		if (d.referrer) {
			f.setAttributeNS(NS_DTM, 'referrer', d.referrer.spec);
		}
		/* end additions */
		if(d.fileNameFromUser){
			f.setAttributeNS(NS_DTM, 'fileNameFromUser', d.fileNameFromUser);
		}
		
		f.setAttributeNS(NS_DTM, 'startDate', d.startDate.getTime());
		
		if (d.description) {
			let n = document.createElementNS(NS_METALINK_RFC5854, 'description');
			n.textContent = d.description;
			f.appendChild(n);
		}

		for (let u of d.urlManager.all) {
			let t = u.url.scheme;
			let n = {};
			if (t === "http" || t === "https" || t === "ftp") {
				n = document.createElementNS(NS_METALINK_RFC5854, 'url');
			}
			else {
				n = document.createElementNS(NS_METALINK_RFC5854, 'metaurl');
				n.setAttribute('mediatype', t[1]);
			}
			n.setAttribute('priority', Math.max(200 - u.preference, 1).toFixed(0));
			n.textContent = u.spec;

			/* extention to include usabality of the url */
			n.setAttributeNS(NS_DTM, 'usable', u.usable);
			f.appendChild(n);
		}
		if (d.hashCollection) {
			let v = document.createElementNS(NS_METALINK_RFC5854, 'hash');
			v.setAttribute('type', d.hashCollection.full.type.toLowerCase());
			v.textContent = d.hashCollection.full.sum.toLowerCase();

			f.appendChild(v);
			if (d.hashCollection.partials.length > 0) {
				let pieces = document.createElementNS(NS_METALINK_RFC5854, 'pieces');
				let partials = d.hashCollection.partials;
				pieces.setAttribute('length', d.hashCollection.parLength);
				pieces.setAttribute('type', partials[0].type);

				for (let k = 0, ke = partials.length; k < ke; k++) {
					let p = document.createElementNS(NS_METALINK_RFC5854, 'hash');
					p.textContent = partials[k].sum.toLowerCase();
					pieces.appendChild(p);
				}
				f.appendChild(pieces);
			}

		}

		if (d.totalSize > 0) {
			let s = document.createElementNS(NS_METALINK_RFC5854, 'size');
			s.textContent = d.totalSize;
			f.appendChild(s);
		}

		root.appendChild(f);

	}

	let fs = new Instances.FileOutputStream(aFile, 0x02 | 0x08 | 0x20, aPermissions, 0);
	let xml = '<?xml version="1.0"?>\r\n';
	fs.write(xml, xml.length);
	Instances.domserializer.serializeToStream(document, fs, 'utf-8');
	fs.close();
};
