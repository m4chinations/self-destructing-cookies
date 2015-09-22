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
var URL = require("sdk/url").URL;
var Panel = require("sdk/panel").Panel;
var tabs = require("sdk/tabs");
var windows = require("sdk/windows");
var Widget = require("sdk/widget").Widget;
var idnService = Cc["@mozilla.org/network/idn-service;1"].getService(Ci.nsIIDNService);
var eTLDService = Cc["@mozilla.org/network/effective-tld-service;1"].getService(Ci.nsIEffectiveTLDService);

var getDomainWhitelist;
var setDomainWhitelist;
var removeDomainWhitelist;
var setArmed;
var disarmAndUndelete;
var sdcpanel = null;
var sdcwidget = null;
var armed;
var controls;
var lastMsg = "";
var suppress = false;

// maximum number of domains to display in a notification
const MAX_DISPLAY = 10;

exports.setup = function(options) {
  getDomainWhitelist = options.getDomainWhitelist;
  setDomainWhitelist = options.setDomainWhitelist;
  removeDomainWhitelist = options.removeDomainWhitelist;
  setArmed = options.setArmed;
  disarmAndUndelete = options.disarmAndUndelete;
  armed = options.armed;
  controls = options.controls;

  // open a short introduction on first run
  if (options.introduction) tabs.open(self.data.url("introduction.html"));

  // nothing left to do if the user doesn't want the icon
  if (!controls) return;

  // the panel we will attach to the widget
  sdcpanel = Panel({
    width: 300,
    height: 230,
    contentURL: self.data.url("toolbar.html"),
    contentScriptFile: self.data.url("toolbar.js")
  });
  sdcpanel.port.on("click", exports.handlePanelClick);

  // install a widget in the add-on bar
  sdcwidget = Widget({
    id: "self-destructing-cookies",
    label: "Self-Destructing Cookies",
    contentURL: self.data.url("widget.html"),
    contentScriptFile: self.data.url("widget.js"),
    panel: sdcpanel
  });
  sdcwidget.on("click", exports.handleWidgetClick);

  // widget needs to be updated when users interact with tabs
  tabs.on("open", exports.handleTabChanged);
  tabs.on("ready", exports.handleTabChanged);
  tabs.on("activate", exports.handleTabChanged);

  // initialize all widgets
  for (var t in tabs) exports.handleTabChanged(tabs[t]);
}

exports.teardown = function() {
  // nothing to do
}

// show Firefox's permission editor
exports.editWhitelist = function() {
  var wm = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
  var win = wm.getMostRecentWindow("Browser:Permissions");
  if (win) {
      win.focus();
  } else {
      windowUtils.openDialog({
          url: "chrome://browser/content/preferences/permissions.xul",
          args: {
              blockVisible: false,
              sessionVisible: true,
              allowVisible: true,
              prefilledHost: "",
              permissionType: "cookie",
              windowTitle: "Cookie Whitelist",
              introText: "Enter domains whose cookies should not self-destruct.\
                          Important: You should always whitelist the base domain\
                          (e.g. example.com, not www.example.com), because most\
                          sites set their cookies there. All subdomains will be\
                          implicitly whitelisted."
              }
      });
  }
}

// returns the base domain and a utf-8 representation of it
exports.domainToBase = function(domain) {
    var basedomain;
    try {
      basedomain = eTLDService.getBaseDomainFromHost(domain, 0);
    } catch (e) {
      // fall back to domain itself
      basedomain = domain;
    }

    var ascii = {};
    var displaydomain = idnService.convertToDisplayIDN(basedomain, ascii);

    return [basedomain, displaydomain];
}

// update widgets when tabs change
exports.handleTabChanged = function(tab) {
  // should we care about this tab?
  var visible = false;

  if (tabs.activeTab == tab) {
    // the active tab in the current window
    visible = true;
  } else {
    // background action in another window?
    for (var w in windows.browserWindows) {
      if (windows.browserWindows[w].tabs.activeTab == tab) visible = true;
    }
  }

  if (visible) {
    // yes, we should care. update the widget.
    var view = sdcwidget.getView(tab.window);
    if (!view) return;

    if (!armed) {
      view.port.emit("icon", self.data.url("toolbar-w.png"));
      return;
    }

    var host = URL(tab.url).host;
    if (host == null) {
      view.port.emit("icon", self.data.url("toolbar-r.png"));
      return;
    }

    var basedomain;
    var displaydomain;
    [basedomain, displaydomain] = exports.domainToBase(host);

    switch (getDomainWhitelist(host)) {
      case Ci.nsICookiePermission.ACCESS_ALLOW:
      case Ci.nsICookiePermission.ACCESS_ALLOW_FIRST_PARTY_ONLY:
        view.port.emit("icon", self.data.url("toolbar-g.png"));
        break;
      case Ci.nsICookiePermission.ACCESS_SESSION:
        view.port.emit("icon", self.data.url("toolbar-y.png"));
        break;
      default:
        view.port.emit("icon", self.data.url("toolbar-r.png"));
        break;
    }
  }
}

// user clicked the widget, prepare the panel
exports.handleWidgetClick = function() {
  var url = URL(tabs.activeTab.url);
  var basedomain = null;
  var displaydomain = null;
  if (url.host != null && url.host != "" && (url.scheme == "http" || url.scheme == "https")) {
    [basedomain, displaydomain] = exports.domainToBase(url.host);
  }

  sdcpanel.port.emit("refresh", {
    domain: basedomain,
    displaydomain: displaydomain,
    permissions: getDomainWhitelist(basedomain),
    armed: armed
  });
}

//user clicked something in the panel
exports.handlePanelClick = function(arg) {
  switch (arg.id) {
    case "default":
      removeDomainWhitelist(arg.domain);
      break;
    case "session":
      setDomainWhitelist(arg.domain, Ci.nsICookiePermission.ACCESS_SESSION);
      break;
    case "permanent":
      setDomainWhitelist(arg.domain, Ci.nsICookiePermission.ACCESS_ALLOW);
      break;
    case "arm":
      armed = setArmed(true);
      break;
    case "disarm":
      armed = setArmed(false);
      break;
    case "undelete":
      armed = disarmAndUndelete();
      break;
    default:
      console.error("panel click: invalid callback " + JSON.stringify(arg));
      break;
  }
  sdcpanel.hide();

  // refresh widgets
  for (var t in tabs) exports.handleTabChanged(tabs[t]);
}

// pop up the statistics page
exports.showStatistics = function(stats, numCookiesRemoved, numTrackingCookiesRemoved, numScopesRemoved, numTrackingScopesRemoved, dateLoaded) {
  var panel = Panel({
      width: 400,
      height: 300,
      contentURL: self.data.url("statistics.html"),
      contentScriptFile: self.data.url("statistics.js"),
      contentScriptOptions: {
        trackerStats: stats,
        numCookiesRemoved: numCookiesRemoved,
        numTrackingCookiesRemoved: numTrackingCookiesRemoved,
        numScopesRemoved: numScopesRemoved,
        numTrackingScopesRemoved: numTrackingScopesRemoved,
        dateLoaded: dateLoaded.toLocaleDateString() + ", " + dateLoaded.toLocaleTimeString()
      }
  });
  panel.port.on("close", function() {
      panel.destroy();
  });
  panel.show();
}

// show an action notification
exports.actionNotification = function(removed, removedTracking, removedScopes, removedTrackingScopes, action, popup) {
  var domains = {};
  var cookies = false;
  var localStorage = false;
  var trackers = false;

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

  // display results
  if (sdcwidget) {
    sdcwidget.tooltip = title + " " + msg;
    sdcwidget.port.emit("flash");
  }

  // suppress duplicate action notifications
  if (title + " " + msg == lastMsg && !suppress) {
    title = "Suppressing duplicate notifications";
    msg = null;
    suppress = true;
  } else if (title + " " + msg == lastMsg && suppress) {
    popup = 0;
  } else if (title + " " + msg != lastMsg) {
    lastMsg = title + " " + msg;
    suppress = false;
  }

  if (popup > 0) displayAlert(title, msg);
}

// display a plain notification
exports.notify = function(msg, popup) {
  // the widget is always updated
  if (sdcwidget) {
    sdcwidget.tooltip = msg;
    sdcwidget.port.emit("flash");
  }

  switch(popup){
    case 1:
      // a notification
      displayAlert(msg, null);
      break;
    case 2:
      // a persistent notification box
      displayNotificationBox(msg);
      break;
  }
}

function displayNotificationBox(message) {
  try {
    var active = windowUtils.getMostRecentBrowserWindow();
    var nb = active.gBrowser.getNotificationBox();
    nb.appendNotification(message, "SDC", self.data.url("sdc64.png"), "PRIORITY_WARNING_HIGH", null);
  } catch(e) {
    console.error(e);
  }
}

// wraps the alerts-service of firefox
function displayAlert(title, message) {
  var alertsService = Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService);
  alertsService.showAlertNotification(self.data.url("sdc64.png"), title, message);
  return true;
}

// handy helper to pluralize words
function plural(num, what) {
    return num.toString() + " " + what + (num == 1 ? "" : "s");
}

