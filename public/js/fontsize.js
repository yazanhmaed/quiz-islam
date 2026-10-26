// ===== حجم الخط لكامل الموقع =====
// يُحمَّل في <head> قبل ظهور الصفحة حتى لا يتغير الحجم أمام المستخدم.
(function () {
  var KEY = "nq_font_size";
  var SIZES = [
    { id: "md", label: "عادي" },
    { id: "lg", label: "كبير" },
    { id: "xl", label: "كبير جدًا" }
  ];

  function read() {
    try { return localStorage.getItem(KEY) || "md"; } catch (e) { return "md"; }
  }
  function apply(size) {
    document.documentElement.setAttribute("data-font", size);
  }

  apply(read());

  function buildControl() {
    var bar = document.querySelector(".topbar-inner");
    if (!bar || document.getElementById("font-btn")) return;

    var wrap = document.createElement("div");
    wrap.className = "font-control";
    wrap.innerHTML =
      '<button type="button" class="btn btn-small font-btn" id="font-btn" aria-haspopup="true" aria-expanded="false">' +
      'حجم الخط</button>' +
      '<div class="font-menu" id="font-menu" role="menu" hidden>' +
      '<p class="font-menu-title">اختر حجم الخط</p>' +
      SIZES.map(function (s) {
        return '<button type="button" class="font-option font-' + s.id + '" role="menuitemradio" data-size="' + s.id + '">' +
          '<span class="font-sample" aria-hidden="true">أ</span><span>' + s.label + '</span></button>';
      }).join("") +
      "</div>";

    // مجموعة الأزرار: حجم الخط ثم تسجيل الخروج (إن وُجد)، تنزل معًا لسطر ثانٍ في الشاشات الضيقة
    var actions = document.createElement("div");
    actions.className = "topbar-actions";
    actions.appendChild(wrap);
    var logout = document.getElementById("logout-btn");
    if (logout) actions.appendChild(logout);
    bar.appendChild(actions);

    var btn = wrap.querySelector("#font-btn");
    var menu = wrap.querySelector("#font-menu");

    function mark() {
      var current = read();
      menu.querySelectorAll(".font-option").forEach(function (o) {
        var on = o.getAttribute("data-size") === current;
        o.classList.toggle("on", on);
        o.setAttribute("aria-checked", on ? "true" : "false");
      });
    }
    function open(show) {
      menu.hidden = !show;
      btn.setAttribute("aria-expanded", show ? "true" : "false");
      if (show) mark();
    }

    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      open(menu.hidden);
    });
    menu.addEventListener("click", function (ev) {
      var opt = ev.target.closest(".font-option");
      if (!opt) return;
      var size = opt.getAttribute("data-size");
      try { localStorage.setItem(KEY, size); } catch (e) { /* تجاهل */ }
      apply(size);
      open(false);
      // إعادة حساب ارتفاع حقول النص في المحرر
      window.dispatchEvent(new Event("resize"));
    });
    document.addEventListener("click", function (ev) {
      if (!menu.hidden && !wrap.contains(ev.target)) open(false);
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") open(false);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildControl);
  else buildControl();
})();
