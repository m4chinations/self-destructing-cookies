document.getElementById("cookies").appendChild(document.createTextNode(self.options.numCookiesRemoved));
document.getElementById("date").appendChild(document.createTextNode(self.options.dateLoaded));
document.getElementById("tracking").appendChild(document.createTextNode(self.options.numTrackingCookiesRemoved));
document.getElementById("trackdomains").appendChild(document.createTextNode(self.options.trackerStats.domains));
document.getElementById("trackcookies").appendChild(document.createTextNode(self.options.trackerStats.cookies));
document.getElementById("trackscopes").appendChild(document.createTextNode(self.options.trackerStats.scopes));
document.getElementById("trackexpiring").appendChild(document.createTextNode(self.options.trackerStats.expiring));
if (self.options.numScopesRemoved == null) {
  // localstorage is disabled
} else {
  // localstorage is enabled
  document.getElementById("localStorage").className = "";
  document.getElementById("scopes").appendChild(document.createTextNode(self.options.numScopesRemoved));
  document.getElementById("trackingScopes").appendChild(document.createTextNode(self.options.numTrackingScopesRemoved));
}
document.getElementById("close").addEventListener("click", function() {
    self.port.emit('close', null);
});

