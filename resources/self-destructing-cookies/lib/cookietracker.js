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

var timers = require("sdk/timers");
var {Cc, Ci} = require("chrome");
var DomainTree = require("./domaintree").DomainTree;
var cookieManager = Cc["@mozilla.org/cookiemanager;1"].getService(Ci.nsICookieManager2);
var eTLDService = Cc["@mozilla.org/network/effective-tld-service;1"].getService(Ci.nsIEffectiveTLDService);

const STYLE_TOP = 0;
const STYLE_FRAME = 1;

// this class tracks cookies and domain references to them, eventually expiring unused cookies
exports.CookieTracker = function CookieTracker(options) {
    options = options || {};

    this.onExpired = options.onExpired;
    this.isExpired = options.isExpired;
    this.canAccess = options.canAccess;
    this.setGracePeriod(options.gracePeriod);
    this.armed = options.armed;
    this.cookieHash = {};
    this.domainTree = new DomainTree();
    this.expirationHandles = {};
}

// introduce a new cookie to the tracker
exports.CookieTracker.prototype.trackCookie = function(cookie) {
  // ignore the cookie if we aren't armed
  if (!this.armed) return;
  // if it is new, count how many old workers can access it
  if (this.cookieHash[this.cookieToKey(cookie)] == undefined) {
    this.cookieHash[this.cookieToKey(cookie)] = this.countWorkers(cookie);
  }

  //console.debug("track "+cookie.host+": "+this.cookieHash[this.cookieToKey(cookie)]);

  // already expired?
  if (this.isExpired(cookie, this.cookieHash[this.cookieToKey(cookie)])) {
    this.scheduleExpiration(cookie, true);
  }
}

// no longer track a cookie
exports.CookieTracker.prototype.dropCookie = function(cookie) {
  // ignore the cookie if we aren't armed
  if (!this.armed) return;
  //console.debug("drop "+cookie.host+": "+this.cookieHash[this.cookieToKey(cookie)]);
  this.cancelExpiration(cookie);
  delete this.cookieHash[this.cookieToKey(cookie)];
}

// adjust refcounts for a new worker
exports.CookieTracker.prototype.incRefs = function(url, style) {
    //console.debug("incRefs "+url.host);
    if (url.host == null) return;

    // count a new worker for this url
    this.domainTree.incRefs(url.host, style, 1);

    // if we aren't armed, we only track domains, not cookies
    if (!this.armed) return;

    // find all of the host's cookies
    var e = cookieManager.getCookiesFromHost(url.host);
    while (e.hasMoreElements()) {
        var c = e.getNext().QueryInterface(Ci.nsICookie2);
        // getcookiesfromhost may be too coarse, filter further
        if (this.canAccess(url.host, c)) {
            if (!this.knowsCookie(c)) {
                // this will already count the new host
                this.trackCookie(c);
            } else {
                this.cookieHash[this.cookieToKey(c)][style] += 1;
            }
            //console.debug("-> "+c.host+": "+this.cookieHash[this.cookieToKey(c)]);

            // check if pending expirations must be cancelled
            if (!this.isExpired(c, this.cookieHash[this.cookieToKey(c)])) {
                this.cancelExpiration(c);
            }
        }
    }

    // process the localstorage pseudo-cookie if it exists for this host
    if (this.knowsCookie(this.localStorageCookie(url.host))) {
      var c = this.localStorageCookie(url.host);
      this.cookieHash[this.cookieToKey(c)][style] += 1;

      if (!this.isExpired(c, this.cookieHash[this.cookieToKey(c)])) {
        this.cancelExpiration(c);
      }
    }
}

// lower refcounts after a worker has left
exports.CookieTracker.prototype.decRefs = function(url, style) {
    //console.debug("decRefs "+url.host);
    if (url.host == null || this.domainTree.get(url.host) == undefined) return;

    this.domainTree.decRefs(url.host, style, 1);
    // removing will be a noop if the domain still has references or children
    this.domainTree.remove(url.host);

    // if we aren't armed, we only track domains, not cookies
    if (!this.armed) return;

    // find all of the host's cookies
    var e = cookieManager.getCookiesFromHost(url.host);
    while (e.hasMoreElements()) {
        var c = e.getNext().QueryInterface(Ci.nsICookie2);
        // getcookiesfromhost may be too coarse, filter further
        if (this.canAccess(url.host, c)) {
            if (this.knowsCookie(c)) {
                this.cookieHash[this.cookieToKey(c)][style] -= 1;
                //console.debug("-> "+c.host+": "+this.cookieHash[this.cookieToKey(c)]);
                if (this.cookieHash[this.cookieToKey(c)][style] < 0) {
                  // this should never happen
                  console.error("NEGATIVE REFCOUNT: " + c.host + ": " + this.cookieHash[this.cookieToKey(c)]);
                }

                // expire if necessary
                if (this.isExpired(c, this.cookieHash[this.cookieToKey(c)])) {
                    this.scheduleExpiration(c, (this.cookieHash[this.cookieToKey(c)][STYLE_FRAME] > 0 ? true : false));
                }
            } else {
                // not actually serious, but unexpected
                console.debug("unknown cookie: " + c.host);
            }
        }
    }

    // process the localstorage pseudo-cookie if it exists for this host
    if (this.knowsCookie(this.localStorageCookie(url.host))) {
      var c = this.localStorageCookie(url.host);
      this.cookieHash[this.cookieToKey(c)][style] -= 1;

      if (this.isExpired(c, this.cookieHash[this.cookieToKey(c)])) {
        this.scheduleExpiration(c, (this.cookieHash[this.cookieToKey(c)][STYLE_FRAME] > 0 ? true : false));
      }
    }
}

// reset tracker state, cancels pending expirations
exports.CookieTracker.prototype.clear = function(cleardomains) {
    //console.debug("clear");
    for (var e in this.expirationHandles) {
        timers.clearTimeout(this.expirationHandles[e]);
    }
    this.expirationHandles = {};
    this.cookieHash = {};
    if (cleardomains) this.domainTree = new DomainTree();
}

// set a new access policy and clears all tracked cookies and expirations
exports.CookieTracker.prototype.setCanAccess = function(cafunc) {
    this.canAccess = cafunc;
    this.clear(false);
}

// update the grace period
exports.CookieTracker.prototype.setGracePeriod = function(t) {
    // grace period must be at least 1 second and not too long
    this.gracePeriod = Math.min(t, 1000);
    this.gracePeriod = Math.max(this.gracePeriod, 1);
}

// arm or disarm the tracker
exports.CookieTracker.prototype.setArmed = function(state) {
  this.armed = state;
  // untrack all cookies and cancel all expirations if we are no longer armed
  if (!state) this.clear(false);
}

// do we track this cookie?
exports.CookieTracker.prototype.knowsCookie = function(cookie) {
    return (this.cookieHash[this.cookieToKey(cookie)] != undefined);
}

// generate a pseudo-cookie for a domain's localstorage
exports.CookieTracker.prototype.localStorageCookie = function(domain) {
  var bd = domain;
  try {
    bd = "." + eTLDService.getBaseDomainFromHost((domain.startsWith(".") ? domain.substr(1) : domain), 0);
  } catch (e) {
    // fall back to the domain itself
    // this space intentionally left blank
  }
  var cookie = {
    host: bd,
    name: "localstorage",
    path: "",
    localStorage: true
  };

  return cookie;
}

// generate a hash key for a cookie
exports.CookieTracker.prototype.cookieToKey = function(cookie) {
    return (cookie.localStorage ? "l;" : "c;") + cookie.host + ";" + cookie.path +";" + cookie.name;
}

// count the number of workers that can access the cookie
exports.CookieTracker.prototype.countWorkers = function(cookie) {
    var cnt = [0, 0]
    // start looking from the base domain, sufficient for strict and relaxed access policies
    var bd = cookie.host.startsWith(".") ? cookie.host.substr(1) : cookie.host;
    try {
        bd = eTLDService.getBaseDomainFromHost(bd, 0);
    } catch (e) {
        // fall back to the domain itself
        // this space intentionally left blank
        // FIXME we really should start from the tld instead
    }

    var hosts = this.domainTree.allSubDomains(bd);

    for (var h in hosts) {
        if (this.canAccess(hosts[h], cookie)) {
            var refs = this.domainTree.getRefCounts(hosts[h]);
            cnt[STYLE_TOP] += refs[STYLE_TOP];
            cnt[STYLE_FRAME] += refs[STYLE_FRAME];
        }
    }

    return cnt;
}

// the cookie can now expire after the grace period
exports.CookieTracker.prototype.scheduleExpiration = function(cookie, tracking) {
    var handler = this.onExpired;
    var key = this.cookieToKey(cookie);
    var handles = this.expirationHandles;
    this.cancelExpiration(cookie);
    this.expirationHandles[key] = timers.setTimeout(function(){delete handles[key]; handler(cookie, tracking, false)}, this.gracePeriod * 1000);
}

// cookie was used during the grace period
exports.CookieTracker.prototype.cancelExpiration = function(cookie) {
    if (this.expirationHandles[this.cookieToKey(cookie)] != undefined) {
        timers.clearTimeout(this.expirationHandles[this.cookieToKey(cookie)]);
        //console.debug("cancel expiration: "+this.cookieToKey(cookie));
        delete this.expirationHandles[this.cookieToKey(cookie)];
    }
}

// statistics for debugging etc.
exports.CookieTracker.prototype.collectStatistics = function() {
    var countProps = function(x, filter) {
      var cnt = 0;
      for (var i in x) {
        if (filter) {
          if (i.startsWith(filter)) cnt++;
        } else {
          cnt++;
        }
      }
      return cnt;
    }

    var stats = {
        cookies: countProps(this.cookieHash, "c"),
        scopes: countProps(this.cookieHash, "l"),
        domains: this.domainTree.countDomains(),
        expiring: countProps(this.expirationHandles),
        toString: function(){ return "Domains: "+this.domains+"  Cookies: "+this.cookies+"  Scopes: "+this.scopes+"  Expiring: "+this.expiring }
    }

    return stats;
}
