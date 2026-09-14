/* ==========================================================================
   file:// guard.

   Double-clicking any page in this folder opens it as file://. Browsers block
   JavaScript modules on file:// pages, so every import fails and the page
   looks broken - or worse, a test page blames WebGL for it.

   This is deliberately a CLASSIC script, not a module: classic scripts still
   load over file://, so this is the one thing that can run and explain.
   ========================================================================== */
(function () {
  // Map this page's file path to its URL on the local server. Kept pure and
  // exposed so it can be tested without actually opening a file:// page.
  window.__fileGuardUrl = function (pathname, port) {
    var p = decodeURIComponent(pathname || "").replace(/\\/g, "/");
    var m = p.match(/\/(demos|shared)\/([^\/]+)$/i);
    var rel;
    if (m) rel = m[1] + "/" + m[2];
    else if (/\/index\.html?$/i.test(p) || /\/$/.test(p)) rel = "";
    else rel = p.split("/").pop();
    return "http://localhost:" + (port || 8124) + "/" + rel;
  };

  // Browsers only expose the camera on secure pages. A deployed copy reached
  // over plain http:// (a custom domain without forced HTTPS) would never even
  // ask for it, so move to https:// first. localhost is already secure, which
  // is why start.bat never needed this; bare IP addresses are left alone
  // because they usually have no certificate to move to.
  if (location.protocol === "http:" && !window.isSecureContext &&
      !/^(localhost|[\d.]+|\[[\da-f:]+\])$/i.test(location.hostname)) {
    location.replace("https://" + location.host + location.pathname + location.search + location.hash);
    return;
  }

  if (location.protocol !== "file:") return;
  window.__FILE_PROTOCOL = true;

  var url = window.__fileGuardUrl(location.pathname);

  function show() {
    document.title = "Open this through start.bat";
    document.body.style.cssText = "margin:0;background:#050507;color:#fff;" +
      "font-family:'Helvetica Neue',Arial,sans-serif;min-height:100vh;display:flex;" +
      "align-items:center;justify-content:center;padding:5vw;box-sizing:border-box";
    document.body.innerHTML =
      "<div style='max-width:760px;line-height:1.7;font-size:clamp(14px,1.5vw,18px)'>" +
      "<div style='font-size:clamp(26px,4vw,48px);font-weight:900;letter-spacing:-.02em;" +
      "color:#FFE600;line-height:1.05;margin-bottom:18px'>OPEN THIS THROUGH START.BAT</div>" +
      "<div style='opacity:.9'>This page was opened straight from the folder " +
      "(<code>file://</code>). Browsers block the JavaScript modules these demos are " +
      "built from when a page is opened that way, so nothing can load.</div>" +
      "<div style='opacity:.9;margin-top:10px'><b>This is not a WebGL or camera " +
      "problem.</b></div>" +
      "<div style='margin-top:22px'><b>1.</b> Double-click <code>start.bat</code> in the " +
      "bunfight folder and leave the black window open.</div>" +
      "<div style='margin-top:8px'><b>2.</b> Then open " +
      "<a href='" + url + "' style='color:#00E5FF'>" + url + "</a></div>" +
      "<div style='opacity:.55;margin-top:8px;font-size:.9em'>If the black window shows a " +
      "different port than 8124, use that number instead.</div>" +
      "</div>";
    var codes = document.body.querySelectorAll("code");
    for (var i = 0; i < codes.length; i++) {
      codes[i].style.cssText = "background:rgba(255,255,255,.12);padding:2px 7px;" +
        "border-radius:3px;font-family:ui-monospace,Consolas,monospace;font-size:.92em";
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show);
  else show();
})();
