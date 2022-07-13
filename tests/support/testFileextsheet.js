"use strict";
/* jshint browser:true */
/* globals module, test, asyncTest, expect, checkExports, QUnit, equal, strictEqual, deepEqual, arrayEqual, ok, throws*/
module("support/fileextsheet.js");

test("exports", function() {
	checkExports("support/fileextsheet", ["FileExtensionSheet"]);
});

test("getAtom", function() {
	const {FileExtensionSheet} = require("support/fileextsheet");
	var f = new FileExtensionSheet(window);
	ok(f.getAtom("file.ext"));
	strictEqual(f.getAtom("file.ext").toString(), f.getAtom("file2.ext").toString());
	strictEqual(f.getAtom("file.metalink", true).toString(), f.getAtom("file2.metalink", true).toString());
	strictEqual(f.getAtom("file.meta4", true).toString(), f.getAtom("file2.meta4", true).toString());
	strictEqual(f.getAtom("file.metalink", true).toString(), f.getAtom("file2.meta4", true).toString());
	strictEqual(f.getAtom("file.downthemoon is dope").toString(), "FileIconunknown");
	strictEqual(f.getAtom("file.downthemoon is dope").toString(), f.getAtom("file.downthemoon is doper").toString());
});
