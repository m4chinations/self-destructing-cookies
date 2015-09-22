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

// how many ms should a url be open until we consider it legitimate
const MIN_ACTIVE = 1000;

// this class manages the history and current state of a tab
exports.History = function History(capacity) {
  this.capacity = capacity;
  this.domains = [];
  this.timestamps = [];
}

exports.History.prototype.add = function(domain) {
  var removed = [];
  var now = Date.now();
  var oldtimestamp = null;

  // remove previous instance of the domain
  var i = this.domains.indexOf(domain);
  if (i >= 0) {
    oldtimestamp = this.timestamps[i];
    this.domains.splice(i, 1);
    this.timestamps.splice(i, 1);
  }

  // we don't keep previous domains active if they
  // were only with us for a short time. this looks
  // suspiciously like someone tried to sneak in a
  // cookie in via redirect-trickery
  if (this.domains.length > 0 && now - this.timestamps[this.timestamps.length - 1] < MIN_ACTIVE) {
    // if the user adjusted his system clock back in time,
    // better do nothing
    if (this.timestamps[this.timestamps.length - 1] <= now) {
      removed.push(this.domains[this.domains.length - 1]);
      this.domains.splice(-1, 1);
      this.timestamps.splice(-1, 1);
    }
  }

  // add domain to the history
  this.domains.push(domain);
  // preserve the oldest known timestamp in the history for this domain
  this.timestamps.push(oldtimestamp ? Math.min(oldtimestamp, now) : now);

  // prune history if it is too long
  if (this.domains.length > this.capacity) {
    removed.push(this.domains[0]);
    this.domains.splice(0, 1);
    this.timestamps.splice(0, 1);
  }

  // return newly active domains and those that are no longer active.
  // if we just shuffled domains around, we don't have to report them
  // as active
  return [(i >= 0) ? [] : [domain], removed];
}

exports.History.prototype.activeDomains = function() {
  return this.domains;
}

exports.History.prototype.toString = function() {
  return this.activeDomains().toString();
}
