/* Copyright (c) 2012, 2013, 2014 Ove Sörensen <sdc@elektro-eel.org>

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

/*
    IMPORTS
*/

var self = require("sdk/self");
var timers = require("sdk/timers");
var URL = require("sdk/url").URL;
var prefs = require("sdk/simple-prefs");
var prefservice = require("sdk/preferences/service");
var system = require("sdk/system");
var events = require("sdk/system/events");
var unload = require("sdk/system/unload");
var {Cc, Ci} = require("chrome");
var CookieTracker = require("./cookietracker").CookieTracker;
var Undelete = require("./undelete").Undelete;
var PagemodSrc = require("./src-pagemod").PagemodSrc;
var DomStorageHelper = require("./domstorage").DomStorageHelper;
// platform-specifics
if (system.id == "{aa3c5121-dab2-40e2-81ca-7ea25febc110}") {
  // Fennec
  var TabSrc = require("./src-simpletab").SimpleTabSrc;
  var GUI = require("./gui-android");
} else {
  // Firefox et al.
  var TabSrc = require("./src-smarttab").SmartTabSrc;
  if (parseInt(system.version.split(".")[0]) < 32) {
    // versions before 32 get the widget-based GUI
    var GUI = require("./gui-desktop");
  } else {
    // newer versions get the Australis-based GUI
    var GUI = require("./gui-australis");
  }
}
var cookieManager = Cc["@mozilla.org/cookiemanager;1"].getService(Ci.nsICookieManager2);
var permissionManager = Cc["@mozilla.org/permissionmanager;1"].getService(Ci.nsIPermissionManager);
var eTLDService = Cc["@mozilla.org/network/effective-tld-service;1"].getService(Ci.nsIEffectiveTLDService);
var ioService = Cc["@mozilla.org/network/io-service;1"].getService(Ci.nsIIOService);
// starting with Firefox 32, there is a new cache API; we need to handle both cases
var cacheService = null;
var cacheService2 = null;
try {
  // the new API
  cacheService2 = Cc["@mozilla.org/netwerk/cache-storage-service;1"].getService(Ci.nsICacheStorageService);
} catch (e) {}
try {
  cacheService = Cc["@mozilla.org/network/cache-service;1"].getService(Ci.nsICacheService);
} catch (e) {}

/*
    ADD-ON STATE
*/

const STYLE_TOP = 0;
const STYLE_FRAME = 1;

const MAX_UNDELETE = 16;

const INCOMPATIBLE = {
  "trackerblock%40privacychoice.org": "TrackerBlock",
  "optout%40dubfire.net": "TACO",
  "john%40velvetcache.org": "Beef Taco"
};

var removed = [];
var removedTracking = [];
var removedScopes = [];
var removedTrackingScopes = [];
var armed = true;
var arming = true;
var postRemovalHandle = null;
var topSrc = null;
var iFrameSrc = null;
var tabSrc = null;
var dateLoaded = new Date();
var idleSince = null;
var newInstall = (self.loadReason == "install");
var localStorage = false;
// a hidden and unsupported preference to make the add-on useful for users
// that block all cookies by default
var defaultBlock = prefservice.get("extensions." + self.id + ".defaultBlock", false);
// should we check for incompatible add-ons?
var compatibilityCheck = prefservice.get("extensions." + self.id + ".checkCompatibility", true);
var numCookiesRemoved = 0;
var numTrackingCookiesRemoved = 0;
var numScopesRemoved = 0;
var numTrackingScopesRemoved = 0;
var undelete = new Undelete(MAX_UNDELETE);
var tracker = new CookieTracker({
  isExpired: checkExpired,
  onExpired: handleExpired,
  canAccess: (prefs.prefs.strictAccess ? canAccessStrict : canAccessRelaxed),
  gracePeriod: prefs.prefs.gracePeriod,
  armed: false
});
var domStorageHelper = new DomStorageHelper({
  filename: "webappsstore.sqlite",
  tracker: tracker,
  isExpired: checkExpired,
  onExpired: handleDomExpired
});


/*
    INITIALIZATION & SETTINGS
*/

exports.main = function() {
  // check for incompatible add-ons
  if (compatibilityCheck) {
    var addons = prefservice.get("extensions.enabledAddons", "").split(",");
    for (var i in addons) {
      var addon = addons[i].split(":")[0];
      if (INCOMPATIBLE[addon]) {
        console.warn("incompatible add-on found: " + INCOMPATIBLE[addon]);
        GUI.notify("Self-Destructing Cookies was NOT enabled because a conflicting add-on was detected: " + INCOMPATIBLE[addon], 1);
        GUI.notify("Self-Destructing Cookies was NOT enabled because a conflicting add-on was detected: " + INCOMPATIBLE[addon], 2);
        return;
      }
    }
  }

  prefs.on("gracePeriod", handlePrefChange);
  prefs.on("strictAccess", handlePrefChange);
  prefs.on("keepIFrames", handlePrefChange);
  prefs.on("undelete", handlePrefChange);
  prefs.on("editWhitelist", editWhitelist);
  prefs.on("showStatistics", showStatistics);
  unload.when(handleUnload);

  GUI.setup({
    checkDomainWhitelist: checkDomainWhitelist,
    getDomainWhitelist: getDomainWhitelist,
    setDomainWhitelist: setDomainWhitelist,
    removeDomainWhitelist: removeDomainWhitelist,
    setArmed: setArmed,
    disarmAndUndelete: disarmAndUndelete,
    armed: armed,
    controls: prefs.prefs.controls,
    introduction: newInstall
  });

  localStorage = prefs.prefs.localStorage;

  // set up the infrastructure that monitors which sites are open

  // react to content changes of the toplevel page
  // fires even before the dom is ready, but does not survive error-pages
  // or lazy loads
  topSrc = new PagemodSrc(tracker, {top: true, existing: true});

  // watch for iframes if configured
  setupIFrameMod(true);

  // react to tab change events
  // tabs only fire once the dom is ready, but survive error-pages
  // and lazy-loads
  tabSrc = new TabSrc(tracker, {});

  // start the batch run in a few seconds
  timers.setTimeout(function(){setupBatchPhase(self.loadReason == "startup", setupAsyncPhase);}, 2000);
};

// prepare a batch run through cookies and localstorage
function setupBatchPhase(startup, callback) {
  var next = function() {
    batchPhase(cookieManager.enumerator, startup, callback);
  }

  if (localStorage) {
    cleanLocalStorage(startup, next);
  } else {
    next();
  }
}

// perform a batch run through the cookies, processing large collections in the background
function batchPhase(cookieEnum, startup, callback) {
  //console.log("entering batch phase");
  var cnt = 0;

  // cookies are processed in batches
  try {
    while (cookieEnum.hasMoreElements() && cnt < 500) {
      var c = cookieEnum.getNext().QueryInterface(Ci.nsICookie2);
      cnt += 1;
      if (checkExpired(c, tracker.countWorkers(c))) {
        // expunge cookie
        handleExpired(c, false, startup);
      }
    }
  } catch(e) {
    console.exception(e);
  }

  if (cookieEnum.hasMoreElements()) {
    // batch phase continues in a few seconds
    timers.setTimeout(function(){batchPhase(cookieManager.enumerator, startup, callback)}, 1000);
  } else {
    // initial run done, next phase starts in a few seconds
    timers.setTimeout(callback, 1000);
  }
}

// clean out the localstorage, operates asynchronously in the background
function cleanLocalStorage(removeSession, callback) {
  //console.log("cleaning ls");
  domStorageHelper.cleanNow(removeSession);
  var handle = timers.setInterval(function() {
    if (!domStorageHelper.busy()) {
      timers.clearInterval(handle);
      callback();
    }
  }, 500);
}

// batch phase finished, cookies can now be processed in realtime
function setupAsyncPhase() {
  //console.log("entering async phase");

  // we will be fully armed after this
  arming = false;
  tracker.setArmed(true);

  // introduce pre-existing cookies to the tracker and watch for changes
  refreshCookieRefs();
  events.on("cookie-changed", handleCookieChanged);
  if (localStorage) events.on("dom-storage2-changed", handleDomStorageChanged);
  events.on("user-interaction-active", function(event){ handleIdle("user-interaction-active", event); }, true);
  events.on("user-interaction-inactive", function(event){ handleIdle("user-interaction-inactive", event); }, true);
}

function setupIFrameMod(existing) {
  if (prefs.prefs.keepIFrames && iFrameSrc == null) {
    // react to iframes, if configured
    iFrameSrc = new PagemodSrc(tracker, {iframes: true, existing: existing});
  } else if (!prefs.prefs.keepIFrames && iFrameSrc != null) {
    iFrameSrc.shutdown();
    iFrameSrc = null;
  }
}

// show the cookie exception list
function editWhitelist() {
  GUI.editWhitelist();
}

// pop up a statistics panel
function showStatistics() {
  GUI.showStatistics(tracker.collectStatistics(), numCookiesRemoved, numTrackingCookiesRemoved, (localStorage ? numScopesRemoved : null), numTrackingScopesRemoved, dateLoaded);
}

// user changed some settings
function handlePrefChange(prefName) {
    switch(prefName) {
        case "gracePeriod":
            tracker.setGracePeriod(prefs.prefs.gracePeriod);
            break;
        case "keepIFrames":
            setupIFrameMod(false);
            break;
        case "undelete":
            undelete.clear();
            break;
        case "strictAccess":
            tracker.setCanAccess((prefs.prefs.strictAccess ? canAccessStrict : canAccessRelaxed));
            // cookies need to be retracked
            // XXX not while disarmed, but the tracker will ignore us anyway in this case
            var cookies = cookieManager.enumerator;
            while (cookies.hasMoreElements()) {
                var c = cookies.getNext().QueryInterface(Ci.nsICookie2);
                tracker.trackCookie(c);
            }
            if (localStorage) domStorageHelper.trackAll();
            break;
    }
}

// add-on shutting down
function handleUnload(reason) {
  GUI.teardown();
  domStorageHelper.shutdown();
  // clearing the tracker cancels pending expirations
  tracker.clear(true);
}

/*
    HELPER FUNCTIONS
*/

// when should a cookie be considered "unused"
function checkExpired(cookie, refs) {
    return (refs[STYLE_TOP] + (prefs.prefs.keepIFrames ? refs[STYLE_FRAME] : 0) < 1);
}

// check whether a cookie can be accessed by a host, strict version
/* Quoting draft-ietf-httpstate-cookie-08:
   A host-name domain-matches a cookie-domain if at least one of the
   following conditions hold:
   o  The cookie-domain and the host-name are identical.
   o  All of the following conditions hold:
      *  The cookie-domain is a suffix of the host-name.
      *  The last character of the host-name that is not included in the
         cookie-domain is a U+002E (".") character.
      *  The host-name is a host name (i.e., not an IP address).
*/
function canAccessStrict(host, cookie) {
    if (cookie.host.startsWith(".")) {
        // domain cookie
        if (cookie.host.substr(1) != host) {
            // not an exact match
            if (!host.endsWith(cookie.host)) return false;
        }
    } else {
        // non-domain cookie
        if (host != cookie.host) return false;
    }
    // XXX domain matches, should we check path
    // this would break some services e.g. persona
    // if (!url.path.startsWith(cookie.path)) return false;
    // TODO check protocol

    return true;
}

// check whether a cookie can be accessed by a host, relaxed version
// considers everything under the first domain below the TLD as one cookie-domain
function canAccessRelaxed(host, cookie) {
    try {
        var hbd = eTLDService.getBaseDomainFromHost(host, 0);
        var cbd = eTLDService.getBaseDomainFromHost((cookie.host.startsWith(".") ? cookie.host.substr(1) : cookie.host), 0);

        return (hbd == cbd);
    } catch (e) {
        // fall back to strict matching
        //console.log("relaxed: " + host + " <=> " + cookie.host);
        return canAccessStrict(host, cookie);
    }
    // NOTREACHED
}

// returns a domain's cookie whitelist level
function getDomainWhitelist(domain) {
  var perm = 0;
  if (!domain) return perm;
  try {
    var uri = ioService.newURI("http://" + (domain.startsWith(".") ? domain.substr(1) : domain), null, null);
    perm = permissionManager.testPermission(uri, "cookie");
  } catch (e) {
    console.error(e);
  }
  return perm;
}

// check whether a domain's cookies are whitelisted
function checkDomainWhitelist(domain, ignoreSession) {
  // an empty domain indicates a file:// type url, keep those cookies
  if (domain == "") return true;
  // XXX assuming that subdomains are automatically whitelisted
  var perm = getDomainWhitelist(domain);
  return (perm == Ci.nsICookiePermission.ACCESS_ALLOW || perm == Ci.nsICookiePermission.ACCESS_ALLOW_FIRST_PARTY_ONLY || (!ignoreSession && perm == Ci.nsICookiePermission.ACCESS_SESSION));
}

// whitelist a domain for cookies
function setDomainWhitelist(domain, value) {
  try {
    domain = eTLDService.getBaseDomainFromHost(domain, 0);
  } catch(e) {
    // fall back to domain itself
    // this space intentionally left blank
  }
  var uri = ioService.newURI("http://"+domain, null, null);
  permissionManager.add(uri, "cookie", value);

  // warn the user if site permissions will be cleared
  if (prefservice.get("privacy.sanitize.sanitizeOnShutdown", false) && prefservice.get("privacy.clearOnShutdown.siteSettings", false)) {
    GUI.notify("Warning: You have set Firefox's privacy settings to clear Site Permissions on shutdown. Your whitelist will not persist between restarts.", 2);
  }

  return domain;
}

// remove a domain's entries in the whitelist
function removeDomainWhitelist(domain) {
  try {
    domain = eTLDService.getBaseDomainFromHost(domain, 0);
  } catch(e) {
    // fall back to domain itself
    // this space intentionally left blank
  }
  permissionManager.remove(domain, "cookie");
  return domain;
}


/*
    COOKIE & EVENT HANDLING
*/


// arm or disarm all cookies. effectively pauses cookie processing
function setArmed(state) {
  // nothing to do or still in the process of arming?
  if (state == armed) return armed;
  if (arming) {
    GUI.notify("Still resuming, please wait.", 1);
    return armed;
  }

  armed = state;
  //console.log("armed: " + armed);
  if (state) {
    // when arming, we do an initial batch run, just like during startup
    arming = true;
    undelete.resetPointer();
    timers.setTimeout(function(){
      setupBatchPhase(false, function() {
        // after the batch phase, arm the tracker and retrack all cookies
        tracker.setArmed(true);
        refreshCookieRefs();
        arming = false;
      })},
    1000);
  } else {
    // disarming
    tracker.setArmed(false);
  }

  return armed;
}

// bring back self-destructed cookies
function disarmAndUndelete() {
  // is this feature even enabled?
  if (!prefs.prefs.undelete && !newInstall) {
    GUI.notify("Please enable this feature in the add-on's settings first.", 1);
    return armed;
  }

  // must be disarmed to undelete
  setArmed(false);
  if (armed) return true;

  var undeleted = undelete.restoreNext();

  // display our results
  if (undeleted.length == 0) {
    GUI.notify("No more undeletes are possible. Still suspended.", 1);
  } else {
    GUI.actionNotification(undeleted, [], [], [], "undeleted. " + undelete.stepsLeft() + " more step(s) available", 1);
  }

  return armed;
}

// clear the browser cache if the user was idle long enough
function handleIdle(topic, event) {
  if (topic == "user-interaction-active") {
    if (idleSince) {
      if (armed && prefs.prefs.clearCache > 0 && (new Date() - idleSince) / 60000 >= prefs.prefs.clearCache) {
        try {
          clearCache();
          GUI.notify("Your browser cache self-destructed.", prefs.prefs.displayNotification ? 1 : 0);
        } catch (e) {
          console.exception(e);
        }
      }

      idleSince = null;
    }
  } else {
    idleSince = new Date();
  }
}

// actually clears the browser cache
function clearCache() {
  try {
    // Firefox < 32
    cacheService.evictEntries(Ci.nsICache.STORE_IN_MEMORY);
    cacheService.evictEntries(Ci.nsICache.STORE_ON_DISK);
    // TODO STORE_OFFLINE?
  } catch (e) {
    // Firefox >= 32
    try {
      cacheService2.clear();
    } catch (e) {
      console.exception(e);
    }
  }
}

// react to change notifications from the cookie service
function handleCookieChanged(event) {
  // ignore all cookies if we aren't armed
  if (!armed) return;

  switch (event.data) {
    case "added":
      var cookie = event.subject.QueryInterface(Ci.nsICookie2);
      tracker.trackCookie(cookie);
      break;
    case "reload":
    case "cleared":
      refreshCookieRefs();
      break;
    case "deleted":
      var cookie = event.subject.QueryInterface(Ci.nsICookie2);
      tracker.dropCookie(cookie);
      break;
    case "batch-deleted":
      var cookies = event.subject.QueryInterface(Ci.nsIArray);
      var e = cookies.enumerate();
      while (e.hasMoreElements()) {
          var cookie = e.getNext().QueryInterface(Ci.nsICookie2);
          tracker.dropCookie(cookie);
      }
      break;
  }
}

// react to changes from the DOM layer
function handleDomStorageChanged(event) {
  // TODO we should ignore SessionStorage, but how?
  var de = event.subject;
  try {
    de = de.QueryInterface(Ci.nsIDOMStorageEvent);
  } catch(e) {
    // ignore
  }

  // ignore entries that just changed
  if (de.newValue && de.oldValue) return;

  if (de.oldValue != null && de.newValue == null) {
    // entry removed
    // ignored for now
  } else {
    // entry added
    domStorageHelper.track(de.url);
  }
}

// regenerate reference counts for all cookies, cancels running expirations
function refreshCookieRefs() {
    tracker.clear(false);

    var cookies = cookieManager.enumerator;
    while (cookies.hasMoreElements()) {
        var c = cookies.getNext().QueryInterface(Ci.nsICookie2);
        tracker.trackCookie(c);
    }

    if (localStorage) domStorageHelper.trackAll();
}

// actually remove a cookie
function handleExpired(cookie, tracking, removeSession) {
  // if the cookie is a localstorage pseudo-cookie, forward it to the appropriate handler
  if (cookie.localStorage) return handleDomExpired(cookie, tracking, removeSession);

  if (!checkDomainWhitelist(cookie.host, removeSession || defaultBlock)) {
    numCookiesRemoved += 1;
    if (tracking) {
      numTrackingCookiesRemoved += 1;
      removedTracking.push(cookie);
    } else {
      removed.push(cookie);
    }

    if (prefs.prefs.undelete || newInstall) undelete.addCookie(cookie);

    cookieManager.remove(cookie.host, cookie.name, cookie.path, false);
    // schedule the notification popup & clean up
    if (postRemovalHandle == null) postRemovalHandle = timers.setTimeout(postRemoval, 5000);
  }
}

// actually remove a domain's dom storage
function handleDomExpired(cookie, tracking, removeSession) {
  if (!checkDomainWhitelist(cookie.host, removeSession || defaultBlock)) {
    var removed = domStorageHelper.remove(cookie.host);
    if (removed > 0) {
      numScopesRemoved += removed;
      if (tracking) {
        numTrackingScopesRemoved += removed;
        removedTrackingScopes.push([cookie.host, removed]);
      } else {
        removedScopes.push([cookie.host, removed]);
      }

      // schedule the notification popup & clean up
      if (postRemovalHandle == null) postRemovalHandle = timers.setTimeout(postRemoval, 5000);
    }
  }
}

// display the notification popup, maintain undelete buffer
function postRemoval() {
  postRemovalHandle = null;

  GUI.actionNotification(removed, removedTracking, removedScopes, removedTrackingScopes, "self-destructed", prefs.prefs.displayNotification ? 1 : 0);

  removed = [];
  removedTracking = [];
  removedScopes = [];
  removedTrackingScopes = [];

  undelete.nextBuffer();
}

