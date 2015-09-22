function setClass(id, klass) {
  var node = document.getElementById(id);
  node.className = klass;
}

self.port.on("flash", function() {
  setClass("icon", "flash");
  window.setTimeout(function(){ setClass("icon", ""); }, 1500);
});

self.port.on("icon", function(arg) {
  document.getElementById("icon").src = arg;
});

