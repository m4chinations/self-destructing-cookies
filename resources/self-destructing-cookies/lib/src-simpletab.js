/* Copyright (c) 2013 Ove Sörensen <sdc@elektro-eel.org>

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

var tabs = require("sdk/tabs");
var URL = require("sdk/url").URL;
var timers = require("sdk/timers");

const STYLE_TOP = 0;
const STYLE_FRAME = 1;

// this class adds references for open tabs. all tabs are re-scanned
// every time a notification from the tabs-module is received. this
// method works at least some of the time considering the current state
// of the tabs-module on android

exports.SimpleTabSrc = function SimpleTabSrc(tracker, options) {
  options = options || {};
  this.tracker = tracker;
  this.refreshHandle = null;
  this.tabUrls = [];

  // XXX it works, but it's kludgey. there must be a better way?
  var _this = this;

  tabs.on("open", function(tab){ exports.SimpleTabSrc.handleTabChanged(_this, tab); });
  tabs.on("close", function(tab){ exports.SimpleTabSrc.handleTabChanged(_this, tab); });
  tabs.on("ready", function(tab){ exports.SimpleTabSrc.handleTabChanged(_this, tab); });

  this.refreshTabs(this);
}

exports.SimpleTabSrc.prototype.shutdown = function() {
  // it seems like tab handlers can't be unregistered
  // we don't need that anyway
  throw "not implemented";
}

exports.SimpleTabSrc.prototype.refreshTabs = function(_this) {
  var urls = [];
  _this.refreshHandle = null;

  // increase references for the new list first, avoids unnecessary expire/cancel cascades
  for (var t in tabs) {
    try {
      var u = URL(tabs[t].url);
      _this.tracker.incRefs(u, STYLE_TOP);
      urls.push(u);
    } catch(e) {
      // on android, this fails more often than not. see #844859 on bugzilla.
      console.error("refresh tabs: " + e);
    }
  }

  // decrease references for the old list
  for (var t in _this.tabUrls) {
    _this.tracker.decRefs(_this.tabUrls[t], STYLE_TOP);
  }

  _this.tabUrls = urls;
}

exports.SimpleTabSrc.handleTabChanged = function(_this, tab) {
  // delay tab refresh a bit to batch-process bulk
  // events (e.g. closing a window with lots of tabs)
  if (_this.refreshHandle == null) _this.refreshHandle = timers.setTimeout(function(){ _this.refreshTabs(_this); }, 500);
}

