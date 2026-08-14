(function () {
  var ua = navigator.userAgent || "";
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  var os = "win";
  if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) os = "mac";
  else if (/Linux/i.test(platform) || /Linux/i.test(ua)) os = "linux";

  var links = {
    win: "https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.12/DeepSeek-0.1.12-win.exe",
    linux: "https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.12/DeepSeek-0.1.12-linux-x64.tar.gz",
    mac: /ARM|aarch64|Apple/i.test(ua + platform)
      ? "https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.12/DeepSeek-0.1.12-mac-arm64.dmg"
      : "https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.12/DeepSeek-0.1.12-mac-x64.dmg",
  };
  var labels = { win: "下载 Windows 安装包", linux: "下载 Linux tar.gz", mac: "下载 macOS 安装包" };

  document.querySelectorAll("[data-hero-download]").forEach(function (hero) {
    hero.href = links[os];
    hero.textContent = labels[os];
  });
  document.querySelectorAll(".card[data-os]").forEach(function (card) {
    if (card.getAttribute("data-os") !== os) return;
    card.classList.add("recommended");
    var badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "适合这台电脑";
    card.appendChild(badge);
  });

  var topbar = document.querySelector(".topbar");
  var toggle = document.querySelector(".nav-toggle");
  if (toggle && topbar) {
    toggle.addEventListener("click", function () {
      var open = topbar.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }
  window.addEventListener("scroll", function () {
    if (!topbar) return;
    topbar.classList.toggle("is-scrolled", window.scrollY > 12);
  }, { passive: true });

  var dock = document.querySelector(".dock");
  var hero = document.querySelector(".splash");
  if (dock && hero) {
    var io = new IntersectionObserver(function (entries) {
      dock.classList.toggle("is-on", !entries[0].isIntersecting);
    }, { threshold: 0.15 });
    io.observe(hero);
  }

  var frame = document.querySelector("[data-skin-frame]");
  document.querySelectorAll("[data-skin-set]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var mode = btn.getAttribute("data-skin-set");
      if (frame) frame.classList.toggle("is-light", mode === "light");
      document.querySelectorAll("[data-skin-set]").forEach(function (other) {
        other.classList.toggle("is-on", other === btn);
      });
    });
  });

  var box = document.querySelector(".lightbox");
  var boxImg = box && box.querySelector("img");
  function openLight(src, alt) {
    if (!box || !boxImg) return;
    boxImg.src = src;
    boxImg.alt = alt || "";
    box.classList.add("is-on");
  }
  function closeLight() {
    if (!box) return;
    box.classList.remove("is-on");
  }
  document.querySelectorAll("[data-lightbox]").forEach(function (el) {
    el.addEventListener("click", function () {
      var img = el.tagName === "IMG" ? el : el.querySelector("img");
      if (!img) return;
      openLight(img.currentSrc || img.src, img.alt);
    });
  });
  if (box) box.addEventListener("click", closeLight);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeLight();
  });
})();
