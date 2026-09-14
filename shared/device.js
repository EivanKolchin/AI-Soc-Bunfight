/* ==========================================================================
   Phone detection, shared by the shell and both demos.

   A classic script in <head>, so html.phone is set before anything is drawn
   and each page's CSS can lay itself out for a phone straight away.
   Tablets and touch-screen laptops are deliberately NOT phones: they keep the
   keyboard shortcuts and the bottom switcher.
   ========================================================================== */
(function () {
  var ua = navigator.userAgent || "";
  var hint = navigator.userAgentData && navigator.userAgentData.mobile;
  var phone = hint === true ||
    /iPhone|iPod|Windows Phone|Android.+Mobile/i.test(ua) ||
    // browsers that hide the device model: a small, touch-only screen
    (!!window.matchMedia && matchMedia("(pointer: coarse) and (hover: none)").matches &&
     Math.min(screen.width, screen.height) <= 540);
  window.IS_PHONE = !!phone;
  if (phone) document.documentElement.classList.add("phone");
})();
