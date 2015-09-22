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

var {Cc, Ci} = require("chrome");
var cookieManager = Cc["@mozilla.org/cookiemanager;1"].getService(Ci.nsICookieManager2);

// this class stores batches of cookies and their previous values
// enabling the undelete feature
exports.Undelete = function(capacity) {
  this.capacity = capacity;
  this.clear();
}

// empty history
exports.Undelete.prototype.clear = function() {
  this.pointer = 0;
  this.buffers = [[]];
  this.values = [{}];
}

// set undelete to go back one step only
exports.Undelete.prototype.resetPointer = function() {
  this.pointer = 0;
}

// make this cookie restoreable
exports.Undelete.prototype.addCookie = function(cookie) {
  this.buffers[this.buffers.length - 1].push(cookie);
  this.values[this.buffers.length - 1][this.cookieToKey(cookie)] = cookie.value;
}

// creates a new step for the following cookies
exports.Undelete.prototype.nextBuffer = function() {
  // no need for a new buffer if the old one is still empty
  if (this.buffers[this.buffers.length - 1].length == 0) return;
  this.buffers.push([]);
  this.values.push({});
  if (this.buffers.length > this.capacity) {
    this.buffers.splice(0, 1);
    this.values.splice(0, 1);
  }
}

// restore one more step
exports.Undelete.prototype.restoreNext = function() {
  // undelete until this point
  this.pointer += 1;
  if (this.pointer == 1 && this.buffers[this.buffers.length - 1].length == 0) this.pointer += 1;
  if (this.pointer > this.buffers.length) {
    return [];
  }

  // ordering is important when undeleting, use for-loops
  var undeleted = [];
  for (var chunk = this.buffers.length - 1; chunk >= this.buffers.length - this.pointer; chunk--) {
    for (var i = 0; i < this.buffers[chunk].length; i++) {
      var c = this.buffers[chunk][i];
      if (chunk == this.buffers.length - this.pointer) undeleted.push(c);
      // for session cookies, we must work around a peculiar behaviour of nsicookiemanager:
      // an expiry time is mandatory, even for session cookies. this interface will
      // immediately dispose of them, when "0" or "null" is provided. we just provide
      // a date (very) far in the future. the cookie will still be removed when the
      // session ends and does not even have an expiry time , so it does not really matter.
      cookieManager.add(c.host, c.path, c.name, this.values[chunk][this.cookieToKey(c)], c.isSecure, c.isHttpOnly, c.isSession, c.isSession ? 9999999999 : c.expires);
    }
  }

  return undeleted;
}

// how many more steps can we go back?
exports.Undelete.prototype.stepsLeft = function() {
  return (this.buffers.length - this.pointer);
}

// generate a hash key for a cookie
exports.Undelete.prototype.cookieToKey = function(cookie) {
    return cookie.host + ";" + cookie.path +";" + cookie.name;
}

