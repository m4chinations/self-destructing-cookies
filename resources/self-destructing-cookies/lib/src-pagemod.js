/* Copyright (c) 2013, 2014, 2015 Ove Sörensen <sdc@elektro-eel.org>

 This program is free software; you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation; either version 2, or (at your option)
 any later version.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU General Public License for more details.

 You should have received a copy of the GNU General Public License
 along with this program; if not, write to the Free Software
 Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA
 02110-1301, USA.
*/

"use strict";

var {PageMod} = require("sdk/page-mod");
var URL = require("sdk/url").URL;

const STYLE_TOP = 0;
const STYLE_FRAME = 1;

exports.PagemodSrc = function PagemodSrc(tracker, options) {
  options = options || {};
  this.tracker = tracker;
  this.top = options.top;
  this.iframes = options.iframes;
  this.existing = options.existing;
  this.topMod = null;
  this.iframeMod = null;

  // XXX it works, but it's kludgey. there must be a better way?
  var _this = this;

  if (this.top) this.topMod = PageMod({
      include: "*",
      contentScript: "",
      attachTo: this.existing ? ["top", "existing"] : ["top"],
      contentScriptWhen: "start",
      onAttach: function(worker){ exports.PagemodSrc.handleAttachTop(_this, worker); }
  });

  if (this.iframes) this.iframeMod = PageMod({
      include: "*",
      contentScript: "",
      attachTo: this.existing ? ["frame", "existing"] : ["frame"],
      contentScriptWhen: "start",
      onAttach: function(worker){ exports.PagemodSrc.handleAttachIFrame(_this, worker); }
  });
}

exports.PagemodSrc.prototype.shutdown = function() {
  if (this.topMod) this.topMod.destroy();
  if (this.iframeMod) this.iframeMod.destroy();
}

exports.PagemodSrc.handleAttachTop = function(_this, worker) {
  var u = URL(worker.url);
  worker.style = STYLE_TOP;
  worker.originalURL = u;
  // Firefox >= 36 has a bug where detach-events fire twice
  // we need to keep track of a worker's status separately
  worker.attached = true;
  _this.tracker.incRefs(u, STYLE_TOP);
  worker.on("detach", function(){ exports.PagemodSrc.handleDetach(_this, this) });
}

exports.PagemodSrc.handleAttachIFrame = function(_this, worker) {
  var u = URL(worker.url);
  worker.style = STYLE_FRAME;
  worker.originalURL = u;
  worker.attached = true;
  _this.tracker.incRefs(u, STYLE_FRAME);
  worker.on("detach", function(){ exports.PagemodSrc.handleDetach(_this, this) });
}

exports.PagemodSrc.handleDetach = function(_this, worker) {
  // check if we hit the Firefox >= 36 bug that causes a worker
  // to detach twice and ignore the worker in this case
  if (!worker.attached) return;
  _this.tracker.decRefs(worker.originalURL, worker.style);
  worker.attached = false;
}
