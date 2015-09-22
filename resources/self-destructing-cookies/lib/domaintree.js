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

const STYLE_TOP = 0;
const STYLE_FRAME = 1;

// this class tracks references to domains, exploiting their hierarchical
// nature to store them in a tree, offering fast lookups of subdomains
exports.DomainTree = function() {
    this.root = this.makeDomain(null, "");
}

// increase worker count
exports.DomainTree.prototype.incRefs = function(domain, style, count) {
    var a = this.get(domain);
    if (a == undefined) {
        // this is the first time we see this host, add it
        var x = domain.split(".").reverse();
        // start inserting here
        var [y, n] = this.closestAncestor(x);
        // add each segment
        for (var i = n; i < x.length; i++) {
            var z = this.makeDomain(y, x[i]);
            y.children[x[i]] = z;
            y.childCount += 1;
            y = z;
        }
        a = y;
        a.childCount = 0;
    }

    a.refCounts[style] += count;
    //console.debug(this.root.toString());
}

// decrease worker count
exports.DomainTree.prototype.decRefs = function(domain, style, count) {
    var a = this.get(domain);
    if (a != undefined) {
        a.refCounts[style] -= count;
    }
   //console.debug(this.root.toString());
}

// return our node for the domain, or undefined if we don't know it
exports.DomainTree.prototype.get = function(domain) {
    var x = domain.split(".").reverse();
    var [y, n] = this.closestAncestor(x);

    if (n != x.length) {
        // not found
        return undefined;
    }
    return y;
}

// return refcounts for the domain, or undefined if we don't know
exports.DomainTree.prototype.getRefCounts = function(domain) {
    var a = this.get(domain);
    if (a == undefined) return undefined;
    return a.refCounts;
}

// remove a domain from the tree
exports.DomainTree.prototype.remove = function(domain) {
    var a = this.get(domain);
    if (a == undefined) return;

    // we can only remove those segments that have no children and no references
    // walk upwards until we hit a segment that is still in use, or the root
    while (a.childCount == 0 && a.refCounts[STYLE_TOP] == 0 && a.refCounts[STYLE_FRAME] == 0 && a.parent != null) {
        a.parent.childCount -= 1;
        delete a.parent.children[a.segment];
        a = a.parent;
    }
}

// return all subdomains with a reference, including the domain itself
exports.DomainTree.prototype.allSubDomains = function(domain, node) {
    var subdomains = [];
    if (node == undefined) {
        // top call
        node = this.get(domain);
        if (node == undefined) return undefined;
        if (node.refCounts[STYLE_TOP] > 0 || node.refCounts[STYLE_FRAME] > 0) subdomains = [domain];
    }

    for (var c in node.children) {
        if (node.children[c].refCounts[STYLE_TOP] > 0 || node.children[c].refCounts[STYLE_FRAME] > 0) subdomains.push(c + "." + domain);
        subdomains = subdomains.concat(this.allSubDomains(c + "." + domain, node.children[c]));
    }

    return subdomains;
}

// return true iff the domain has no references
exports.DomainTree.prototype.allZero = function(domain) {
    var a = this.get(domain);
    if (a == undefined) return undefined;
    return (a.refCounts[STYLE_TOP] == 0 && a.refCounts[STYLE_FRAME] == 0);
}

// count and return the number of all domain segments in the tree
exports.DomainTree.prototype.countDomains = function(node) {
    var count = 0;
    if (node == undefined) {
        // top call, let's not count the empty root node
        count = -1;
        node = this.root;
    }

    for (var c in node.children) {
        count += this.countDomains(node.children[c]);
    }

    return count + 1;
}

// the closest node we have to the argument segment list
exports.DomainTree.prototype.closestAncestor = function(segments) {
    var x = this.root;
    var i = 0;
    while (x.children[segments[i]] != undefined) {
        x = x.children[segments[i]];
        i += 1;
    }
    return [x, i];
}

// create a new empty domain object
exports.DomainTree.prototype.makeDomain = function(parent, segment) {
    return {
        children: {},
        childCount: 0,
        parent: parent,
        segment: segment,
        refCounts: [0, 0],
        toString: function() {
            var s = "";
            for (var i in this.children) {
                s = s + i + "[" + this.children[i].refCounts + "]" + this.children[i].toString() + " ";
            }
            return " { "+s+"}";
        }
    };
}

// for debugging
exports.DomainTree.prototype.toString = function() {
    return this.root.toString();
}
