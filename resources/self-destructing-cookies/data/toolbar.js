var domain;
var displaydomain;
var permissions;
var armed;

function update(id, text) {
  var node = document.getElementById(id);
  if(node.hasChildNodes()) node.removeChild(node.firstChild);
  node.appendChild(document.createTextNode(text));
}

function setClass(id, klass) {
  var node = document.getElementById(id);
  node.className = klass;
}

document.getElementById("permanent").onclick = function(event) {
  self.port.emit("click", {id: "permanent", domain: domain});
}

document.getElementById("session").onclick = function(event) {
  self.port.emit("click", {id: "session", domain: domain});
}

document.getElementById("default").onclick = function(event) {
  self.port.emit("click", {id: "default", domain: domain});
}

document.getElementById("arm").onclick = function(event) {
  self.port.emit("click", {id: "arm"});
}

document.getElementById("disarm").onclick = function(event) {
  self.port.emit("click", {id: "disarm"});
}

document.getElementById("undeleteArmed").onclick = function(event) {
  self.port.emit("click", {id: "undelete"});
}

document.getElementById("undeleteDisarmed").onclick = function(event) {
  self.port.emit("click", {id: "undelete"});
}

self.port.on("refresh", function(arg) {
  domain = arg.domain;
  displaydomain = arg.displaydomain;
  permissions = arg.permissions;
  armed = arg.armed;

  if (armed) {
    setClass("arm", "hidden");
    setClass("disarm", "");
    setClass("undeleteDisarmed", "hidden");
    setClass("undeleteArmed", "");
  } else {
    setClass("arm", "");
    setClass("disarm", "hidden");
    setClass("undeleteDisarmed", "");
    setClass("undeleteArmed", "hidden");
  }

  if (domain == null || domain == "" ) {
    setClass("whitelist", "hidden");
    setClass("permanent", "hidden");
    setClass("session", "hidden");
    setClass("default", "hidden");
    setClass("nodomain", "");
    update("domain", "Self-Destructing Cookies");
    return;
  }

  update("domain", displaydomain);
  setClass("whitelist", "");
  setClass("permanent", "");
  setClass("session", "");
  setClass("default", "");
  setClass("nodomain", "hidden");
  switch (permissions) {
    case 1:
      setClass("permanent", "bold");
      break;
    case 8:
      setClass("session", "bold");
      break;
    default:
      setClass("default", "bold");
      break
  }
});

