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

var tabs = require("sdk/tabs");
var URL = require("sdk/url").URL;
var timers = require("sdk/timers");
var History = require("./history").History;

const STYLE_TOP = 0;
const STYLE_FRAME = 1;

// how many history entries should we keep
const MAX_HISTORY = 4;

// this class adds references for open tabs and some of their
// history entries. this preserves the required cookies for
// most inter-domain transactions.

exports.SmartTabSrc = function SmartTabSrc(tracker, options) {
  options = options || {};
  this.tracker = tracker;
  this.counter = 0;
  this.histories = {};

  for (var t in tabs) {
    this.registerTab(tabs[t]);
  }

  // XXX it works, but it's kludgey. there must be a better way?
  var _this = this;

  tabs.on("open", function(tab){ exports.SmartTabSrc.handleTabOpen(_this, tab); });
  tabs.on("close", function(tab){ exports.SmartTabSrc.handleTabClose(_this, tab); });
  tabs.on("ready", function(tab){ exports.SmartTabSrc.handleTabReady(_this, tab); });
}

exports.SmartTabSrc.prototype.registerTab = function(tab) {
  this.histories[tab.id] = new History(MAX_HISTORY);
  this.updateTab(tab);
}

exports.SmartTabSrc.prototype.unregisterTab = function(tab) {
  var active = this.histories[tab.id].activeDomains();
  for (var d in active) {
    this.tracker.decRefs(URL("http://" + active[d]), STYLE_TOP);
  }

  delete this.histories[tab.id];
}

exports.SmartTabSrc.prototype.updateTab = function(tab) {
  var u = URL(tab.url);
  if (!u.host || u.host == "") return;
  var active;
  var expired;
  [active, expired] = this.histories[tab.id].add(u.host);
  for (var d in active) {
    this.tracker.incRefs(URL("http://" + active[d]), STYLE_TOP);
  }

  for (var d in expired) {
    this.tracker.decRefs(URL("http://" + expired[d]), STYLE_TOP);
  }

}

exports.SmartTabSrc.prototype.shutdown = function() {
  // it seems like tab handlers can't be unregistered
  // we don't need that anyway
  throw "not implemented";
}

exports.SmartTabSrc.handleTabOpen = function(_this, tab) {
  _this.registerTab(tab);
}

exports.SmartTabSrc.handleTabClose = function(_this, tab) {
  _this.unregisterTab(tab);
}

exports.SmartTabSrc.handleTabReady = function(_this, tab) {
  _this.updateTab(tab);
}
