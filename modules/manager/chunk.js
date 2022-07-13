/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

/* global PIPE_SEGMENT_SIZE, MAX_PIPE_SEGMENTS */
requireJoined(this, "constants");
const Prefs = require("preferences");
const {ByteBucketTee} = require("support/bytebucket");
const {GlobalBucket} = require("./globalbucket");
const Limits = require("support/serverlimits");
const {getTimestamp, formatNumber, makeDir, randint} = require("utils");
const {memoryReporter} = require("./memoryreporter");
const {setTimeout} = require("support/defer");

const _thread = (function() {
	// Use a dedicated thread, so that we have serialized writes.
	// As we use a single sink for various reasons, we need to ensure the
	// shipped bytes arrive and are written to in the correct order.
	// The assumption that writes will be properly serialized is based on the
	// following assumptions
	//  1. The thread event queue processes events fifo, always
	//  2. The async stream copier writes a whole piped stream before processing
	//     another stream write request.
	//
	// Why do we want to use all this cruft?
	// - To keep the browser snappier by having the slow disk I/O stuff off the
	//   main thread.
	// - Having a single thread doing all the writes might reduce/avoid some
	//   nasty performance issues, such as excessive disk thrashing due to
	//   concurrency.
	// - We cannot use ChromeWorkers, because we cannot do file I/O there
	//   unless we reimplement file I/O using ctypes (and while it's feasible, it
	//   is not really reasonable)
	//
	// For the amo-validator context:
	// Editor note: Safe use, as an event target for nsIAsyncStreamCopier (no js use)
	let AsyncCopierThread = Services.tm.newThread(0);
	/*if (AsyncCopierThread instanceof Ci.nsISupportsPriority) {
		AsyncCopierThread.priority = AsyncCopierThread.PRIORITY_LOW;
		log(LOG_INFO, "Our async copier thread is low priority now!");
	}*/
	unload(() => {
		AsyncCopierThread.shutdown();
	});
	return AsyncCopierThread;
})();
unload(() => {
	try {
		_thread.shutdown();
	}
	catch (ex) {
		// ignored
	}
});

exports.hintChunkBufferSize = function() {
};

const Observer = {
    /* eslint-disable no-unused-vars */
	observe: function(s, topic, data) {
    /* eslint-enable no-unused-vars */
		let perms = Prefs.permissions = Prefs.getExt("permissions", 384);
		if (perms & 384) {
			perms |= 64;
		}
		if (perms & 48) {
			perms |= 8;
		}
		if (perms & 6) {
			perms |= 1;
		}
		Prefs.dirPermissions = perms;
	},
};
Prefs.addObserver("extensions.dtm.permissions", Observer);

function asyncCopy(instream, outstream, close) {
	let copier = new Instances.AsyncStreamCopier2(
		instream,
		outstream,
		_thread,
		PIPE_SEGMENT_SIZE,
		false, // close source
		close // close sink
		);
	return new Promise(function(resolve, reject) {
		copier.asyncCopy({
			/* eslint-disable no-unused-vars */
			onStartRequest: function(req, context) {},
			/* eslint-enable no-unused-vars */
			onStopRequest: function(req, context, status) {
				if (!Components.isSuccessCode(status)) {
					reject(status);
				}
				else {
					resolve();
				}
			}
		}, null);
	});
}

class Chunk {
	constructor(download, start, end, written) {
		// safeguard against null or strings and such
		this._parent = download;
		this._start = start;
		this._written = written > 0 ? written : 0;
		this._sessionBytes = 0;
		this.errored = false;
		this.running = false;

		this.end = end;
		this.startBytes = this.safeBytes = this._written;
		this.wasOpened = false;

		log(LOG_INFO, "chunk created: " + this);
	}

	clone() {
		return new Chunk(this._parent, this.start, this.end, this.safeBytes);
	}

	get starter() {
		return this.end <= 0;
	}
	get start() {
		return this._start;
	}
	get end() {
		return this._end;
	}
	set end(nv) {
		this._end = nv;
		this._total = this.end && (this._end - this._start + 1);
	}
	get total() {
		return this._total;
	}
	get written() {
		return this._written;
	}
	get buffered() {
		let rv = 0;
		try {
			if (this._inStream) {
				rv += this._inStream.available();
			}
		}
		catch (ex) {
			log(LOG_DEBUG, "Failed to get buffered size, which is probably OK", ex);
		}
		try {
			if (this._overflowPipe) {
				rv += this._overflowPipe.inputStream.available();
			}
		}
		catch (ex) {
			log(LOG_DEBUG, "Failed to get overflow size, which is probably OK", ex);
		}
		if (rv) {
			// Add a segment size on top to be on the safer side
			rv += PIPE_SEGMENT_SIZE;
		}
		return rv;
	}
	get currentPosition() {
		return this.start + this.written;
	}
	get remainder() {
		return this._total - this._written;
	}
	get complete() {
		if (this._end <= 0) {
			return this.written !== 0;
		}
		return this._total === this.written;
	}
	get parent() {
		return this._parent;
	}
	get sessionBytes() {
		return this._sessionBytes;
	}
	get buckets() {
		if (this._buckets) {
			return this._buckets;
		}
		this._buckets = new ByteBucketTee(
			this.parent.bucket,
			Limits.getServerBucket(this.parent),
			GlobalBucket
			);
		return this._buckets;
	}

	open() {
		if (this.wasOpened) {
			throw new Error("No recylcing");
		}
		if (this._openPromise) {
			log(LOG_DEBUG, `opening ${this}: already pending`);
			return this._openPromise;
		}

		const file = this.parent.tmpFile;
		let pos = this.start + this.safeBytes;
		log(LOG_DEBUG, `opening ${this}: ${file.path} at ${pos}`);
		this.wasOpened = true;
		return this._openPromise = this._openAsync(file, pos);
	}

	_noteBytesWritten(bytes) {
		this._written += bytes;
		this._sessionBytes += bytes;
		this.safeBytes =  Math.max(this.startBytes, this._written - this.buffered);
		memoryReporter.noteBytesWritten(bytes);

		this.parent.timeLastProgress = getTimestamp();
	}

	close() {
		log(LOG_DEBUG, `closing ${this}`);
		if (this._closing) {
			return this._closing;
		}
		this.running = false;
		this._closing = this._closeAsync();
	}

	merge(ch) {
		if (!this.complete && !ch.complete) {
			throw new Error("Cannot merge incomplete chunks this way!");
		}
		this.end = ch.end;
		this.safeBytes += ch.safeBytes;
		this._written += ch._written;
		this.safeBytes += ch.safeBytes;
	}

	rollback() {
		if (!this._sessionBytes || this._sessionBytes > this._written) {
			return;
		}
		this._written -= this._sessionBytes;
		this._sessionBytes = 0;
	}

	cancelChunk() {
		this.running = false;
		this.close();
		if (this.download) {
			this.download.cancel();
		}
	}

	suspend(aRequest, pending) {
		if (this._req) {
			this._reqPending += pending;
		}
		else {
			this._req = aRequest;
			this._req.suspend();
			this._reqPending = pending;
		}
		this.schedule();
	}

	write(aRequest, aInputStream, aCount) {
		try {
			// not running: do not write anything
			if (!this.running || !this._inStream || !this._outStream) {
				log(LOG_ERROR, "trying to write on a closed chunk");
				return -1;
			}
			let bytes = this.remainder;
			if (!this.total || aCount < bytes) {
				bytes = aCount;
			}
			if (!bytes) {
				// we got what we wanted
				return -1;
			}
			if (bytes < 0) {
				throw new Error(`bytes negative: ${bytes} ${this.remainder} ${aCount}`);
			}
			let got = this.requestBytes(bytes);

			// didn't get enough
			if (got < bytes) {
				this.suspend(aRequest, bytes - got);
			}

			// per e10n contract we must consume all bytes
			// or in our case all remainder bytes
			// reqPending from above makes sure that we won't re-schedule
			// the download too early
			if (this._overflowPipe) {
				// We still got overflow
				log(LOG_DEBUG, "writing to overflow");
				this._overflowPipe.outputStream.writeFrom(aInputStream, bytes);
			}
			else {
				let written = 0;
				// jshint -W116
				try {
					written = this._outStream.writeFrom(aInputStream, bytes);
				}
				catch (ex) {
					if (ex.result == Cr.NS_BASE_STREAM_WOULD_BLOCK || ex == Cr.NS_BASE_STREAM_WOULD_BLOCK) {
						// aka still nothing written
					}
					else {
						throw ex;
					}
				}
				// jshint +W116
				let remain = bytes - written;
				if (remain > 0) {
					if (!this._overflowPipe) {
						// If everything goes according to plan, we won't need much!
						// Having an overflow pipe will eventually suspend the request
						// until it clears up!
						log(LOG_DEBUG, "creating overflow pipe");
						this._overflowPipe = new Instances.Pipe(
							false,
							true,
							PIPE_SEGMENT_SIZE,
							MAX_PIPE_SEGMENTS * 10);
					}
					log(LOG_DEBUG, "writing to remainder to overflow");
					this._overflowPipe.outputStream.writeFrom(aInputStream, remain);
				}
			}
			this._noteBytesWritten(got);
			return bytes;
		}
		catch (ex) {
			log(LOG_ERROR, 'write: ' + this.parent.tmpFile.path, ex);
			throw ex;
		}
	}

	observe() {
		this.run();
	}

	_substractOverflow(requested) {
		let instream = this._overflowPipe.inputStream;
		let avail = instream.available();
		if (!avail) {
			this._overflowPipe.outputStream.close();
			this._overflowPipe.inputStream.close();
			delete this._overflowPipe;
			return requested;
		}

		log(LOG_DEBUG, `still overflow: ${avail}`);
		// decreasing requested will put the stream into suspended mode, need
		// to schedule
		requested = Math.max(requested - avail, 0);
		let written = 0;
		// jshint -W116
		try {
			written = this._outStream.writeFrom(instream, avail);
		}
		catch (ex) {
			if (ex.result == Cr.NS_BASE_STREAM_WOULD_BLOCK || ex == Cr.NS_BASE_STREAM_WOULD_BLOCK) {
				// nothing written
			}
			else {
				throw ex;
			}
		}
		// jshint +W116
		avail -= written;
		log(LOG_DEBUG, `overflow written: ${written} ${avail}`);
		if (!avail) {
			log(LOG_DEBUG, "overflow cleared");
			this._overflowPipe.outputStream.close();
			this._overflowPipe.inputStream.close();
			delete this._overflowPipe;
		}
		return requested;
	}

	requestBytes(requested) {
		if (this._overflowPipe) {
			requested = this._substractOverflow(requested);
		}

		if (memoryReporter.memoryPressure > 0) {
			log(LOG_INFO, "Under some pressure: " + memoryReporter.pendingBytes +
				" : " + memoryReporter.memoryPressure + " : " + requested);
			requested = Math.max(Math.min(requested, 256), Math.floor(requested / memoryReporter.memoryPressure));
			log(LOG_INFO, "Using instead: " + requested);
		}
		return this.buckets.requestBytes(requested);
	}

	schedule() {
		if (this._schedTimer) {
			return;
		}
		this._schedTimer = setTimeout(() => {
			delete this._schedTimer;
			this.run();
		}, randint(0, 150));
	}

	run() {
		if (!this._req) {
			return;
		}
		if (this._reqPending > 0) {
			// Still have pending bytes?
			let got = this.requestBytes(this._reqPending);
			if (!got) {
				this.schedule();
				return;
			}
			this._reqPending -= got;
			this.parent.timeLastProgress = getTimestamp();
			this._noteBytesWritten(got);
			this.schedule();
			return;
		}

		// Ready to resume the download
		if (this._req) {
			let req = this._req;
			delete this._req;
			delete this._reqPending;
			req.resume();
			this.parent.timeLastProgress = getTimestamp();
			this.schedule();
		}
	}

	toString() {
		let len = this.parent.totalSize ? String(this.parent.totalSize).length  : 10;
		return formatNumber(this.start, len) +
			"/" + formatNumber(this.end, len) +
			"/" + formatNumber(this.total, len) +
			" running:" + this.running +
			" written/remain/sb:" + formatNumber(this.written, len) +
			"/" + formatNumber(this.remainder, len) +
			"/" + formatNumber(this._sessionBytes, len);
	}

	toJSON() {
		return {
			start: this.start,
			end: this.end,
			written: this.safeBytes
			};
	}
	async _openAsync(file, pos) {
		try {
			try {
				await makeDir(file.parent, Prefs.dirPermissions, true);
			}
			catch (ex) {
				if (ex.becauseExists) {
					// no op
				}
				else {
					throw ex;
				}
			}
			let outStream = new Instances.FileOutputStream(
				file,
				0x02 | 0x08,
				Prefs.permissions,
				Ci.nsIFileOutputStream.DEFER_OPEN
				);
			let closeStream = () => {
				if (outStream) {
					try {
						outStream.close();
					}
					catch (ex) {
						// might have been already closed
					}
				}
				outStream = null;
				this.close();
			};
			if (pos) {
				let seekable = outStream.QueryInterface(Ci.nsISeekableStream);
				seekable.seek(0x00, pos);
			}
			this._pipe = new Instances.Pipe(
				true,
				true,
				PIPE_SEGMENT_SIZE,
				MAX_PIPE_SEGMENTS);
			this._inStream = this._pipe.inputStream;
			this._outStream = this._pipe.outputStream;
			this._copier = asyncCopy(this._inStream, outStream, true);
			this._copier.then(closeStream);
			this._copier.catch(status => {
				this.errored = true;
				try {
					closeStream();
				}
				catch (ex) {
					this.download.writeFailed(ex);
					return;
				}
				this.download.writeFailed(status);
			});
		}
		finally {
			memoryReporter.registerChunk(this);
			delete this._openPromise;
		}
	}
	async _closeAsync() {
		try {
			if (this._openPromise) {
				await this._openPromise;
			}
			// drain the overflowPipe, if any
			if (this._overflowPipe && !this.errored) {
				log(LOG_DEBUG, "draining overflow");
				try {
					await asyncCopy(this._overflowPipe.inputStream, this._outStream, false);
				}
				catch (status) {
					this.errored = true;
					this.download.writeFailed(status);
				}
			}

			if (this._overflowPipe) {
				// Still got an overflow pipe, meaning we failed a write
				// Since we kill the pipe now, we need to adjust written sizes
				// beforehand accordingly so saveBytes and rollback() are still
				// correct
				try {
					let pending = this._overflowPipe.inputStream.available();
					this._written -= pending;
					this._sessionBytes -= pending;
				}
				catch (ex) {
					log(LOG_DEBUG, "failed to substract overflow, which is probably OK", ex);
				}
				this._overflowPipe.outputStream.close();
				this._overflowPipe.inputStream.close();
				delete this._overflowPipe;
			}
			// we are done writing to the pipe
			if (this._outStream) {
				this._outStream.close();
				delete this._pipe;
				delete this._outStream;
			}
			// but still need to wait for the copy into the file
			if (this._copier) {
				try {
					await this._copier;
				}
				catch (ex) {
					this.errored = true;
					// ignore here otherwise!
				}
				delete this._copier;
			}

			// upate the counters one last time
			this._noteBytesWritten(0);
			// and close the input stream end of the pipe
			if (this._inStream) {
				try {
					this._inStream.close();
				}
				catch (ex) {
					// no op
				}
				delete this._inStream; // ... before deleting the instream
			}

			// and do some cleanup
			if (this._buckets) {
				delete this._buckets;
			}
			delete this._req;

			this._sessionBytes = 0;
			if (this.errored || !this.complete) {
				this.startBytes = this._written = Math.max(this.startBytes, this.safeBytes - 2048);
			}
			else {
				this.startBytes = this._written = this.safeBytes;
			}
		}
		catch (ex) {
			log(LOG_ERROR, "Damn!", ex);
		}
		finally {
			memoryReporter.unregisterChunk(this);
			delete this.download;
			delete this._closing;
		}
	}
}

exports.Chunk = Chunk;
