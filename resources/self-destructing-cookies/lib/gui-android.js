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

var self = require("sdk/self");
var {Cc, Ci} = require("chrome");
var windowUtils = require("sdk/window/utils");
var tabs = require("sdk/tabs");
var URL = require("sdk/url").URL;
var idnService = Cc["@mozilla.org/network/idn-service;1"].getService(Ci.nsIIDNService);
var eTLDService = Cc["@mozilla.org/network/effective-tld-service;1"].getService(Ci.nsIEffectiveTLDService);
var whitelistMenuIDs = [];
var disarmMenuIDs = [];
var undeleteMenuIDs = [];
var windows = [];
var armed;
var controls;
var checkDomainWhitelist;
var setDomainWhitelist;
var removeDomainWhitelist;
var disarmAndUndelete;
var setArmed;
var lastMsg = "";
var suppress = false;

// maximum number of domains to display in a notification
const MAX_DISPLAY = 3;

exports.setup = function(options) {
  checkDomainWhitelist = options.checkDomainWhitelist;
  setDomainWhitelist = options.setDomainWhitelist;
  removeDomainWhitelist = options.removeDomainWhitelist;
  setArmed = options.setArmed;
  disarmAndUndelete = options.disarmAndUndelete;
  armed = options.armed;
  controls = options.controls;

  // nothing left to do if the user doesn't want the menu entries
  if (!controls) return;

  // install menus in all browser windows
  var win = windowUtils.windows();
  for (var w in win) {
    if (windowUtils.isBrowser(win[w])) {
      whitelistMenuIDs.push(win[w].NativeWindow.menu.add("Cookie Whitelist", null, handleWhitelistClicked));
      disarmMenuIDs.push(win[w].NativeWindow.menu.add("Suspend/Resume SDC", null, handleDisarmClicked));
      undeleteMenuIDs.push(win[w].NativeWindow.menu.add("Undelete & Suspend", null, handleUndeleteClicked));
      windows.push(win[w]);
    }
  }
}

exports.teardown = function() {
  // nothing to do if the menu was disabled
  if (!controls) return;

  // remove our menu entries
  for (var i in whitelistMenuIDs) {
    windows[i].NativeWindow.menu.remove(whitelistMenuIDs[i]);
    windows[i].NativeWindow.menu.remove(disarmMenuIDs[i]);
    windows[i].NativeWindow.menu.remove(undeleteMenuIDs[i]);
  }
  whitelistMenuIDs = [];
  disarmMenuIDs = [];
  undeleteMenuIDs = [];
  windows = [];
}

exports.editWhitelist = function() {
  toast("1. Open site to be whitelisted in Firefox  2. Open main menu (top right)  3. Select Cookie Whitelist", "long");
}

exports.showStatistics = function(stats, numCookiesRemoved, numTrackingCookiesRemoved, numScopesRemoved, numTrackingScopesRemoved, dateLoaded) {
  var cookieText = "Removed " + numCookiesRemoved + " Cookies, incl. " + numTrackingCookiesRemoved + " Trackers ";
  var localStorageText = "";
  if (numScopesRemoved != null) {
    localStorageText = "as well as " + numScopesRemoved + " LocalStorage Scopes, incl. " + numTrackingScopesRemoved + " Trackers ";
  }
  var suffixText = "since " + dateLoaded.toLocaleDateString() + ", " + dateLoaded.toLocaleTimeString() + ". " + stats.toString();

  toast(cookieText + localStorageText + suffixText, "long");
}

exports.notify = function(msg, popup) {
  if (popup > 0) toast(msg, "long");
}


// show an action notification
exports.actionNotification = function(removed, removedTracking, removedScopes, removedTrackingScopes, action, popup) {
  var domains = {};
  var cookies = false;
  var localStorage = false;
  var trackers = false;

  // a popup is the only option on android
  if (popup < 1) return;

  // collect all base domains
  for (var d in removed) {
    var h = removed[d].host.startsWith(".") ? removed[d].host.substr(1) : removed[d].host;
    try { h = eTLDService.getBaseDomainFromHost(h, 0); } catch (e) {}
    if (!domains[h]) domains[h] = {};
    domains[h]["cookie"] = true;
    cookies = true;
  }
  for (var d in removedTracking) {
    var h = removedTracking[d].host.startsWith(".") ? removedTracking[d].host.substr(1) : removedTracking[d].host;
    try { h = eTLDService.getBaseDomainFromHost(h, 0); } catch (e) {}
    if (!domains[h]) domains[h] = {};
    domains[h]["cookie"] = true;
    domains[h]["tracker"] = true;
    cookies = true;
    trackers = true;
  }
  for (var d in removedScopes) {
    var h = removedScopes[d][0].startsWith(".") ? removedScopes[d][0].substr(1) : removedScopes[d][0];
    try { h = eTLDService.getBaseDomainFromHost(h, 0); } catch (e) {}
    if (!domains[h]) domains[h] = {};
    domains[h]["localStorage"] = true;
    localStorage = true;
  }
  for (var d in removedTrackingScopes) {
    var h = removedTrackingScopes[d][0].startsWith(".") ? removedTrackingScopes[d][0].substr(1) : removedScopes[d][0];
    try { h = eTLDService.getBaseDomainFromHost(h, 0); } catch (e) {}
    if (!domains[h]) domains[h] = {};
    domains[h]["localStorage"] = true;
    domains[h]["tracker"] = true;
    localStorage = true;
    trackers = true;
  }

  // did something happen at all?
  if (!cookies && !localStorage) return;

  // build title
  var title = "";
  if (trackers) title = title + "Trackers, ";
  if (cookies) title = title + "Cookies, ";
  if (localStorage) title = title + "LocalStorage, ";
  title = title.substring(0, title.length - 2);

  // build message
  // TODO sort trackers first?
  var msg = "from ";
  var d = Object.keys(domains).sort();
  var n = Math.min(d.length, MAX_DISPLAY);
  if (n == d.length - 1) n = d.length;
  for (var i = 0; i < n; i++) {
    var ascii = {};
    msg = msg + idnService.convertToDisplayIDN(d[i], ascii);
    if (n > 1 && (domains[d[i]].tracker || (cookies && localStorage))) {
      // we should add a type indentifier
      msg = msg + " (";
      if (domains[d[i]].tracker) msg = msg + "T";
      if (domains[d[i]].cookie) msg = msg + "C";
      if (domains[d[i]].localStorage) msg = msg + "L";
      msg = msg + ")";
    }
    if (i < n - 1) msg = msg + ", ";
  }
  if (n < d.length) msg = msg + " and " + (d.length - n) + " more domains";
  msg = msg + " " + action + ".";

  // suppress duplicate action notifications
  if (title + " " + msg == lastMsg && !suppress) {
    toast("Suppressing duplicate notifications", "long");
    suppress = true;
  } else if (title + " " + msg != lastMsg) {
    lastMsg = title + " " + msg;
    suppress = false;
  }

  // display results
  if (!suppress) toast(title + " " + msg, "long");
}

// add or remove current site to/from whitelist
function handleWhitelistClicked() {
  var host = URL(tabs.activeTab.url).host;
  var perm = null;
  var ascii = {};
  if (host == null) {
    toast("Please open a site first.");
    return;
  }
  if (checkDomainWhitelist(host, false)) {
    // remove
    host = idnService.convertToDisplayIDN(removeDomainWhitelist(host), ascii);
    toast(host + " is no longer whitelisted for cookies.");
  } else {
    // add
    host = idnService.convertToDisplayIDN(setDomainWhitelist(host, Ci.nsICookiePermission.ACCESS_ALLOW), ascii);
    toast(host + " is now whitelisted for cookies.");
  }
}

function handleDisarmClicked() {
  armed = setArmed(!armed);
  if (armed) {
    toast("SDC is no longer suspended.", "long");
  } else {
    toast("SDC is now suspended.", "long");
  }
}

function handleUndeleteClicked() {
  armed = disarmAndUndelete();
}

// handy helper to pluralize words
function plural(num, what) {
    return num.toString() + " " + what + (num == 1 ? "" : "s");
}

// display a toast
function toast(text, duration) {
  if (duration == undefined) duration = "long";
  windowUtils.getMostRecentBrowserWindow().NativeWindow.toast.show(text, duration);
}

