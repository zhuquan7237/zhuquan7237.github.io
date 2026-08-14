(function () {
  "use strict";

  var downloads = {
    win: {
      href: "https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.12/DeepSeek-0.1.12-win.exe",
      label: "下载 Windows 安装包",
      family: "win",
    },
    linux: {
      href: "https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.12/DeepSeek-0.1.12-linux-x64.tar.gz",
      label: "下载 Linux tar.gz",
      family: "linux",
    },
    "mac-arm": {
      href: "https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.12/DeepSeek-0.1.12-mac-arm64.dmg",
      label: "下载 macOS 安装包",
      family: "mac",
    },
    "mac-intel": {
      href: "https://github.com/zhuquan7237/zhuquan7237.github.io/releases/download/desktop-v0.1.12/DeepSeek-0.1.12-mac-x64.dmg",
      label: "下载 macOS 安装包",
      family: "mac",
    },
  };

  var userChoseTarget = false;

  function detectTargetSync() {
    var ua = navigator.userAgent || "";
    var platform =
      (navigator.userAgentData && navigator.userAgentData.platform) ||
      navigator.platform ||
      "";
    var source = ua + " " + platform;

    if (/Mac|iPhone|iPad|iPod/i.test(source)) {
      if (/arm64|aarch64|Apple\s?Silicon/i.test(source)) return "mac-arm";
      if (navigator.maxTouchPoints > 1) return "mac-arm";
      if (/Intel|x86_64|x64/i.test(source)) return "mac-intel";
      return "mac-arm";
    }

    if (/Linux/i.test(source) && !/Android/i.test(source)) return "linux";
    return "win";
  }

  function markMacVariant(target) {
    document.querySelectorAll("[data-mac-download]").forEach(function (link) {
      var matching =
        (target === "mac-arm" && link.getAttribute("data-mac-download") === "arm") ||
        (target === "mac-intel" && link.getAttribute("data-mac-download") === "intel");
      link.classList.toggle("is-mac-recommended", matching);
      if (matching) link.setAttribute("aria-label", link.textContent.trim() + "，为这台 Mac 推荐");
      else link.removeAttribute("aria-label");
    });
  }

  function applyTarget(target) {
    var selected = downloads[target] || downloads.win;

    document.querySelectorAll("[data-hero-download]").forEach(function (link) {
      link.href = selected.href;
      link.textContent = selected.label;
    });

    document.querySelectorAll("[data-os-choice]").forEach(function (button) {
      var active = button.getAttribute("data-os-choice") === target;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });

    document.querySelectorAll("[data-os-card]").forEach(function (card) {
      var recommended = card.getAttribute("data-os-card") === selected.family;
      card.classList.toggle("is-recommended", recommended);
      var badge = card.querySelector(".recommendation");
      if (badge) badge.hidden = !recommended;
    });

    markMacVariant(target);
    document.documentElement.setAttribute("data-download-target", target);
  }

  var initialTarget = detectTargetSync();
  applyTarget(initialTarget);

  document.querySelectorAll("[data-os-choice]").forEach(function (button) {
    button.addEventListener("click", function () {
      userChoseTarget = true;
      applyTarget(button.getAttribute("data-os-choice"));
    });
  });

  if (
    navigator.userAgentData &&
    typeof navigator.userAgentData.getHighEntropyValues === "function" &&
    downloads[initialTarget].family === "mac"
  ) {
    navigator.userAgentData
      .getHighEntropyValues(["architecture", "bitness"])
      .then(function (values) {
        if (userChoseTarget) return;
        var architecture = (values.architecture || "") + " " + (values.bitness || "");
        if (/arm/i.test(architecture)) applyTarget("mac-arm");
        else if (/x86|64/i.test(architecture)) applyTarget("mac-intel");
      })
      .catch(function () {
        /* Keep the synchronous choice when the browser withholds architecture. */
      });
  }

  var topbar = document.querySelector(".topbar");
  var navToggle = document.querySelector(".nav-toggle");
  var nav = document.querySelector(".nav-links");

  function setNav(open) {
    if (!topbar || !navToggle) return;
    topbar.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navToggle.setAttribute("aria-label", open ? "关闭导航" : "打开导航");
  }

  if (topbar && navToggle) {
    navToggle.addEventListener("click", function () {
      setNav(!topbar.classList.contains("is-open"));
    });

    if (nav) {
      nav.querySelectorAll("a").forEach(function (link) {
        link.addEventListener("click", function () {
          setNav(false);
        });
      });
    }

    document.addEventListener("click", function (event) {
      if (topbar.classList.contains("is-open") && !topbar.contains(event.target)) {
        setNav(false);
      }
    });

    var updateTopbar = function () {
      topbar.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    updateTopbar();
    window.addEventListener("scroll", updateTopbar, { passive: true });
  }

  var skinFrame = document.querySelector("[data-skin-frame]");
  document.querySelectorAll("[data-skin-set]").forEach(function (button) {
    button.addEventListener("click", function () {
      var mode = button.getAttribute("data-skin-set");

      document.querySelectorAll("[data-skin-set]").forEach(function (other) {
        var active = other === button;
        other.classList.toggle("is-active", active);
        other.setAttribute("aria-pressed", active ? "true" : "false");
      });

      if (skinFrame) {
        skinFrame.querySelectorAll("[data-skin]").forEach(function (image) {
          var visible = image.getAttribute("data-skin") === mode;
          image.classList.toggle("is-visible", visible);
          image.setAttribute("aria-hidden", visible ? "false" : "true");
        });
      }
    });
  });

  var lightbox = document.querySelector(".lightbox");
  var lightboxImage = lightbox && lightbox.querySelector("img");
  var lightboxClose = lightbox && lightbox.querySelector(".lightbox-close");
  var previousFocus = null;

  function imageForTrigger(trigger) {
    if (trigger.hasAttribute("data-skin-frame")) {
      return trigger.querySelector(".skin-image.is-visible");
    }
    if (trigger.tagName === "IMG") return trigger;
    return trigger.querySelector("img");
  }

  function openLightbox(trigger) {
    var image = imageForTrigger(trigger);
    if (!lightbox || !lightboxImage || !image) return;

    previousFocus = document.activeElement;
    lightboxImage.src = image.currentSrc || image.src;
    lightboxImage.alt = image.alt || "";
    lightbox.classList.add("is-open");
    lightbox.setAttribute("aria-hidden", "false");
    document.body.classList.add("lightbox-open");
    if (lightboxClose) lightboxClose.focus();
  }

  function closeLightbox() {
    if (!lightbox || !lightbox.classList.contains("is-open")) return;
    lightbox.classList.remove("is-open");
    lightbox.setAttribute("aria-hidden", "true");
    document.body.classList.remove("lightbox-open");
    lightboxImage.removeAttribute("src");
    if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
  }

  document.querySelectorAll("[data-lightbox]").forEach(function (trigger) {
    trigger.addEventListener("click", function () {
      openLightbox(trigger);
    });
    trigger.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openLightbox(trigger);
      }
    });
  });

  if (lightbox) {
    lightbox.addEventListener("click", function (event) {
      if (event.target === lightbox) closeLightbox();
    });
  }
  if (lightboxClose) lightboxClose.addEventListener("click", closeLightbox);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closeLightbox();
      setNav(false);
    }
  });
})();
