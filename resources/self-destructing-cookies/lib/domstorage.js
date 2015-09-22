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

const ERROR = -1;
const IDLE = 0;
const CLEANING = 1;
const CLOSED = 2;

var {Cc, Ci} = require("chrome");
var directoryService = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties);
var storageService = Cc["@mozilla.org/storage/service;1"].getService(Ci.mozIStorageService);
var ioService = Cc["@mozilla.org/network/io-service;1"].getService(Ci.nsIIOService);
var securityManager = Cc["@mozilla.org/scriptsecuritymanager;1"].getService(Ci.nsIScriptSecurityManager);
var eTLDService = Cc["@mozilla.org/network/effective-tld-service;1"].getService(Ci.nsIEffectiveTLDService);
var domStorageManager = null;
// the component was renamed since Firefox 23
try {
  domStorageManager = Cc["@mozilla.org/dom/localStorage-manager;1"].getService(Ci.nsIDOMStorageManager);
} catch (e) {
  domStorageManager = Cc["@mozilla.org/dom/storagemanager;1"].getService(Ci.nsIDOMStorageManager);
}

// this class is a translation layer between main.js (acts on a domain-level),
// Firefox's DOM services (act on a scope level) and cookietracker.js (acts on a
// a cookie level)
exports.DomStorageHelper = function(options) {
  this.filename = options.filename;
  this.tracker = options.tracker;
  this.isExpired = options.isExpired;
  this.onExpired = options.onExpired;
  this.gracePeriod = options.gracePeriod;
  this.scopeMap = {};
  this.stGetScopes = null;
  this.stGetDomainScopes = null;
  this.state = ERROR;

  try {
    // try to open the database that persists the localstorage
    // we need operate directly on it if we want to get a list of
    // all scopes. domStorageManager does not provide this function
    this.dbFile = directoryService.get("ProfD", Ci.nsIFile);
    this.dbFile.append(this.filename);

    if (!this.dbFile) {
      console.error("Could not find LocalStorage DB");
      return;
    }

    this.db = storageService.openDatabase(this.dbFile);
    if (!this.db) {
      console.error("Could not open LocalStorage DB");
      return;
    }
  } catch (e) {
    console.error("localstorage: ", e.message);
  }

  this.createStatements();

  this.state = IDLE;
}

// find all domains that have scopes and hand them over to the tracker
exports.DomStorageHelper.prototype.trackAll = function() {
  var domain, port, proto;

  if (this.state == ERROR) return;

  if (!this.createStatements()) return;

  try {
    while (this.stGetScopes.executeStep()) {
      [domain, proto, port] = splitScope(this.stGetScopes.row.scope);
      if (getLocalStorage(domain, proto, port)) {
        //console.log("ls trackall", domain, proto, port);
        this.addScopeMap(domain, proto, port);
        var cookie = this.tracker.localStorageCookie(domain);
        this.tracker.trackCookie(cookie);
      }
    }
  } catch (e) {
    console.exception(e);
  }
  this.stGetScopes.reset();
}

// track a single new domain that has a scope
exports.DomStorageHelper.prototype.track = function(url) {
  if (!url || url == "") return;
  if (this.state == ERROR) return;

  var uri = ioService.newURI(url, null, null);
  //console.log("ls track", uri.host);
  this.addScopeMap(uri.host, uri.scheme, uri.port >= 0 ? uri.port : (uri.scheme == "http" ? 80 : 443));
  var cookie = this.tracker.localStorageCookie(uri.host);
  this.tracker.trackCookie(cookie);
}

// remove all scopes for a domain
exports.DomStorageHelper.prototype.remove = function(domain) {
  if (this.state == ERROR) return 0;

  //console.log("ls remove", domain, ":");
  var removed = 0;
  try {
    var scopes = this.getScopeMap(domain);
    for (var i in scopes) {
      var dom, proto, port;
      [dom, proto, port] = scopes[i];
      //console.log("- ", dom, proto, port);

      var storage = getLocalStorage(dom, proto, port);
      // only go ahead if the scope also exists in Firefox's cache layer
      // otherwise, the scope is probably stale
      if (storage) {
        storage.clear();
        removed += 1;
      }
    }

    // also notify the tracker
    var cookie = this.tracker.localStorageCookie(domain);
    this.tracker.dropCookie(cookie);

    // scopeMap entry can be removed now
    this.removeScopeMap(domain);

    return removed;
  } catch(e) {
    console.exception(e);
  }

  // only reached when there was an exception

  return 0;
}

// find and remove all scopes without a reference. runs asynchronously
// in the background
exports.DomStorageHelper.prototype.cleanNow = function(removeSession) {
  if (this.state != IDLE) return;
  if (!this.createStatements()) return;

  this.state = CLEANING;
  //console.log("ls clean now");

  var _this = this;
  this.stGetScopes.executeAsync({
    handleResult: function(rs){ _this.handleCleanNowResult(rs, _this, removeSession); },
    handleError: function(error){ _this.handleError(error, _this); },
    handleCompletion: function(reason){ _this.handleCleanNowCompletion(reason, _this); }
  });
}

// are we done cleaning?
exports.DomStorageHelper.prototype.busy = function() {
  return this.state == CLEANING;
}

// add an entry to the scope map. the scope map stores all known
// localstorage scopes for a base domain. firefox does not provide
// an api to query this and the db state might be stale due to the caching
// layer. we have to keep track of these via the dom observer ourselves.
exports.DomStorageHelper.prototype.addScopeMap = function(domain, proto, port) {
  if (!domain || !proto || !port) return;
  // always index by base domain
  if (domain.startsWith(".")) domain = domain.substr(1);
  var bd = domain;
  try {
      bd = eTLDService.getBaseDomainFromHost(bd, 0);
  } catch (e) {
      // fall back to the domain itself
      // this space intentionally left blank
  }
  //console.log("scopemap add", bd, domain, proto, port);
  if (!this.scopeMap[bd]) this.scopeMap[bd] = {};
  if (!this.scopeMap[bd][domain]) this.scopeMap[bd][domain] = {};
  if (!this.scopeMap[bd][domain][proto]) this.scopeMap[bd][domain][proto] = {};
  if (!this.scopeMap[bd][domain][proto][port]) this.scopeMap[bd][domain][proto][port] = true;
}

// remove a base domain's entry from the scope map
exports.DomStorageHelper.prototype.removeScopeMap = function(domain) {
  if (!domain) return;
  // always index by base domain
  if (domain.startsWith(".")) domain = domain.substr(1);
  var bd = domain;
  try {
      bd = eTLDService.getBaseDomainFromHost(bd, 0);
  } catch (e) {
      // fall back to the domain itself
      // this space intentionally left blank
  }
  //console.log("scopemap remove", bd);
  delete this.scopeMap[bd];
}

// read a base domain's scopes from the scope map
exports.DomStorageHelper.prototype.getScopeMap = function(domain) {
  if (!domain) return [];
  var scopes = [];
  // always index by base domain
  if (domain.startsWith(".")) domain = domain.substr(1);
  var bd = domain;
  try {
      bd = eTLDService.getBaseDomainFromHost(bd, 0);
  } catch (e) {
      // fall back to the domain itself
      // this space intentionally left blank
  }
  if (!this.scopeMap[bd]) return scopes;
  for (var dom in this.scopeMap[bd]) {
    for (var proto in this.scopeMap[bd][dom]) {
      for (var port in this.scopeMap[bd][dom][proto]) {
        scopes.push([dom, proto, port]);
      }
    }
  }
  return scopes;
}

// a new chunk of scopes to clean
exports.DomStorageHelper.prototype.handleCleanNowResult = function(resultSet, _this, removeSession) {
  for (var row = resultSet.getNextRow(); row; row = resultSet.getNextRow()) {
    try {
      var domain, proto, port;
      [domain, proto, port] = splitScope(row.getResultByName("scope"));
      _this.addScopeMap(domain, proto, port);

      // expire the domain's pseudo-cookie if the tracker has no references
      var cookie = this.tracker.localStorageCookie(domain);
      if (_this.isExpired(cookie, _this.tracker.countWorkers(cookie))) {
        _this.onExpired(cookie, false, removeSession);
      }
    } catch (e) {
      console.exception(e);
    }
  }
}

// we are done cleaning.
exports.DomStorageHelper.prototype.handleCleanNowCompletion = function(reason, _this) {
  //console.log("ls cleannow complete");
  _this.scopeMap = {};
  _this.state = IDLE;
}

exports.DomStorageHelper.prototype.handleError = function(error, _this) {
  console.error("localstorage: " + error.message);
  _this.state = IDLE;
}

// close the database connection when we unload
exports.DomStorageHelper.prototype.shutdown = function() {
  if (this.stGetScopes) this.stGetScopes.finalize();
  if (this.stGetDomainScopes) this.stGetDomainScopes.finalize();
  if (this.db) this.db.asyncClose();
  this.state = CLOSED;
}

// try to create database statements. might fail if localstorage has not been used yet.
exports.DomStorageHelper.prototype.createStatements = function() {
  if (this.stGetScopes) return true;

  try {
    this.stGetScopes = this.db.createStatement("SELECT DISTINCT scope FROM webappsstore2;");
    this.stGetDomainScopes = this.db.createStatement("SELECT DISTINCT scope FROM webappsstore2 WHERE scope LIKE ? || '%';");
  } catch (e) {
    console.warn("LocalStorage has not yet been initialized.");
    return false;
  }

  return true;
}

// parse a scope as it appears in the db
function splitScope(scope) {
  var port, proto, host;
  [host, proto, port] = scope.split(":");
  for (var i = host.length - 1, r = ""; i >= 0; r += host[i--]) {}
  return [r, proto, port];
}

// try to get a scope's localstorage object through Firefox's cache layer
function getLocalStorage(domain, proto, port) {
  var uri, principal, storage;
  var s = proto + "://" + (domain.startsWith(".") ? domain.substr(1) : domain) + ":" + port;

  try {
    uri = ioService.newURI(s, null, null);
    principal = securityManager.getNoAppCodebasePrincipal(uri);
    storage = domStorageManager.getLocalStorageForPrincipal(principal, null);
  } catch (e) {
    console.error("localstorage: ", e.message);
    return null;
  }

  if (!storage || storage.length < 1) return null;
  return storage;
}

