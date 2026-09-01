/**
 * HITT Ops — header user menu (shared)
 * ---------------------------------------------------------------------------
 * Turns the header avatar + name into a dropdown ("Profile" / "Sign out"),
 * replacing the old standalone "Sign out" button. "Profile" opens a
 * self-service edit modal backed by GET/PATCH /api/me/profile — the same
 * fields as the admin edit-user modal, but username / work email /
 * onboarding date are read-only and the termination date only shows for
 * admins.
 *
 * Loaded on every page after js/permissions.js and js/avatar.js. Injects
 * its own stylesheet (…/js/usermenu.js -> …/css/usermenu.css), same trick
 * js/chat.js uses.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  var SELF_SRC = document.currentScript && document.currentScript.src;
  function injectStylesheet() {
    if (!SELF_SRC || document.querySelector("link[data-usermenu-css]")) return;
    var href = SELF_SRC.replace(/\/js\/usermenu\.js(\?.*)?$/, "/css/usermenu.css");
    if (href === SELF_SRC) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-usermenu-css", "");
    document.head.appendChild(link);
  }

  function t(key, fallback) {
    return window.HITT_I18N ? HITT_I18N.t(key) : fallback;
  }
  function signInPath() {
    return location.pathname.indexOf("/pages/") !== -1 ? "../index.html" : "index.html";
  }

  var perms = null; // resolved GET /api/permissions/me (best-effort)

  /* ============================ THE MENU ================================ */
  function buildMenu() {
    var host = document.querySelector(".app-header__user");
    if (!host || host.querySelector(".usermenu")) return;

    var avatar = document.getElementById("userAvatar");
    var name = document.getElementById("userName");
    var oldSignOut = document.getElementById("btnSignOut");
    if (oldSignOut) oldSignOut.remove();
    if (!avatar) return;

    var wrap = document.createElement("div");
    wrap.className = "usermenu";

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "usermenu-trigger";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");

    // Move the existing avatar + name into the trigger so permissions.js /
    // avatar.js keep updating the very same elements.
    avatar.parentNode.insertBefore(wrap, avatar);
    trigger.appendChild(avatar);
    if (name) trigger.appendChild(name);
    var caret = document.createElement("span");
    caret.className = "usermenu-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "▾";
    trigger.appendChild(caret);

    var dd = document.createElement("div");
    dd.className = "usermenu-dropdown";
    dd.setAttribute("role", "menu");
    dd.hidden = true;
    dd.innerHTML =
      '<button type="button" role="menuitem" class="usermenu-item" data-act="profile" data-i18n="usermenu.profile">Profile</button>' +
      '<button type="button" role="menuitem" class="usermenu-item" data-act="signout" data-i18n="action.signOut">Sign out</button>';

    wrap.appendChild(trigger);
    wrap.appendChild(dd);
    if (window.HITT_I18N) HITT_I18N.apply(dd);

    function close() {
      dd.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    }
    function toggle(e) {
      e.stopPropagation();
      var open = dd.hidden;
      dd.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
    }
    trigger.addEventListener("click", toggle);
    document.addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
    dd.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-act]");
      if (!btn) return;
      close();
      if (btn.dataset.act === "signout") {
        HITT_AUTH.signOut(signInPath());
      } else if (btn.dataset.act === "profile") {
        openProfileModal();
      }
    });
  }

  /* ========================== THE PROFILE MODAL ======================== */
  var modal = null;
  var pfAvatarImage = null;
  var pfAvatarUsePhoto = false;

  var FIELDS = [
    // id, employeesinfo column, type
    ["pfBirthday", "birthdaydate", "date"],
    ["pfPhonePersonal", "phone_personal", "text"],
    ["pfEmailPersonal", "email_personal", "text"],
    ["pfContact1", "contact_emergency1", "text"],
    ["pfPhone1", "phone_emergency1", "text"],
    ["pfContact2", "contact_emergency2", "text"],
    ["pfPhone2", "phone_emergency2", "text"],
    ["pfBankName", "bankname", "text"],
    ["pfBankAcct", "bankacctemp", "text"],
  ];

  function field(id, i18nKey, fallback, type, opts) {
    opts = opts || {};
    return (
      '<label class="usermenu-field">' +
      '<span data-i18n="' + i18nKey + '">' + fallback + "</span>" +
      '<input id="' + id + '" type="' + (type || "text") + '"' +
      (opts.disabled ? " disabled" : "") + ' autocomplete="off" />' +
      "</label>"
    );
  }

  function buildModal() {
    if (modal) return;
    modal = document.createElement("div");
    modal.className = "usermenu-modal hidden";
    modal.innerHTML =
      '<div class="usermenu-modal-panel">' +
      '<div class="usermenu-modal-head">' +
      '<h2 data-i18n="usermenu.profile">Profile</h2>' +
      '<button type="button" class="usermenu-modal-x" data-close title="Close">✕</button>' +
      "</div>" +
      '<div class="usermenu-modal-body">' +
      '<div class="usermenu-avatar-row">' +
      '<div class="avatar usermenu-avatar-preview" id="pfAvatarPreview">?</div>' +
      '<div class="usermenu-avatar-actions">' +
      '<span class="usermenu-field-label" data-i18n="settings.user.avatar">Avatar</span>' +
      "<div>" +
      '<label class="btn btn-secondary usermenu-avatar-upload"><span data-i18n="settings.user.uploadPhoto">Upload photo</span><input type="file" id="pfAvatarFile" accept="image/*" hidden /></label> ' +
      '<button type="button" class="btn btn-secondary" id="pfAvatarUseInitials" data-i18n="settings.user.useInitials">Use initials</button>' +
      "</div></div></div>" +
      '<div class="usermenu-grid">' +
      field("pfFirstName", "settings.user.firstName", "First name", "text") +
      field("pfLastName", "settings.user.lastName", "Last name", "text") +
      field("pfUsername", "settings.user.username", "Username", "text", { disabled: true }) +
      field("pfEmail", "settings.user.workEmail", "Work email", "text", { disabled: true }) +
      field("pfOnboard", "settings.user.onboard", "Onboard date", "date", { disabled: true }) +
      '<label class="usermenu-field" id="pfTerminationWrap" hidden><span data-i18n="settings.user.termination">Termination date</span><input id="pfTermination" type="date" disabled /></label>' +
      field("pfBirthday", "settings.user.birthday", "Birthday", "date") +
      "</div>" +
      '<label class="usermenu-toggle"><input type="checkbox" id="pfShowBirthday" /> <span data-i18n="settings.user.showBirthday">Show this birthday in the team calendar</span></label>' +
      '<div class="usermenu-grid usermenu-grid--mt">' +
      field("pfPhonePersonal", "settings.user.personalPhone", "Personal phone", "text") +
      field("pfEmailPersonal", "settings.user.personalEmail", "Personal email", "text") +
      field("pfContact1", "settings.user.contact1", "Contact 1", "text") +
      field("pfPhone1", "settings.user.phone1", "Phone 1", "text") +
      field("pfContact2", "settings.user.contact2", "Contact 2", "text") +
      field("pfPhone2", "settings.user.phone2", "Phone 2", "text") +
      field("pfBankName", "settings.user.bankName", "Bank name", "text") +
      field("pfBankAcct", "settings.user.account", "Account", "text") +
      "</div>" +
      '<p class="usermenu-err" id="pfErr"></p>' +
      "</div>" +
      '<div class="usermenu-modal-foot">' +
      '<button type="button" class="btn btn-secondary" data-close data-i18n="form.cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary" id="pfSave" data-i18n="form.save">Save</button>' +
      "</div></div>";
    document.body.appendChild(modal);
    if (window.HITT_I18N) HITT_I18N.apply(modal);

    modal.addEventListener("click", function (e) {
      if (e.target === modal || e.target.closest("[data-close]")) closeProfileModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) closeProfileModal();
    });

    modal.querySelector("#pfAvatarFile").addEventListener("change", async function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        pfAvatarImage = await HITT_AVATAR.cropSquareDataUrl(f);
        pfAvatarUsePhoto = true;
        paintPfAvatar();
      } catch (err) {
        setErr(err.message || "Could not use that image.");
      }
    });
    modal.querySelector("#pfAvatarUseInitials").addEventListener("click", function () {
      pfAvatarUsePhoto = false; // keeps pfAvatarImage as a rollback
      paintPfAvatar();
    });
    ["pfFirstName", "pfLastName"].forEach(function (id) {
      modal.querySelector("#" + id).addEventListener("input", paintPfAvatar);
    });
    modal.querySelector("#pfSave").addEventListener("click", saveProfile);
  }

  function setErr(msg) {
    var el = modal.querySelector("#pfErr");
    el.textContent = msg || "";
  }
  function pfInitials() {
    var n = (modal.querySelector("#pfFirstName").value + " " + modal.querySelector("#pfLastName").value).trim();
    return n ? HITT_AUTH.initials({ displayName: n }) : "?";
  }
  function paintPfAvatar() {
    HITT_AVATAR.paint(modal.querySelector("#pfAvatarPreview"), {
      dataUrl: pfAvatarUsePhoto ? pfAvatarImage : null,
      initials: pfInitials(),
    });
  }

  var isoDay = function (v) { return v ? String(v).slice(0, 10) : ""; };

  async function openProfileModal() {
    buildModal();
    setErr("");
    modal.classList.remove("hidden");
    var save = modal.querySelector("#pfSave");
    save.disabled = true;
    try {
      var p = await HITT_API.getMyProfile();
      var info = p.info || {};
      modal.querySelector("#pfFirstName").value = p.firstName || "";
      modal.querySelector("#pfLastName").value = p.lastName || "";
      modal.querySelector("#pfUsername").value = p.username || "";
      modal.querySelector("#pfEmail").value = p.emailid || "";
      modal.querySelector("#pfOnboard").value = isoDay(info.onboarddate);
      var termWrap = modal.querySelector("#pfTerminationWrap");
      termWrap.hidden = !p.isAdmin;
      modal.querySelector("#pfTermination").value = isoDay(info.terminationdate);
      FIELDS.forEach(function (f) {
        modal.querySelector("#" + f[0]).value = f[2] === "date" ? isoDay(info[f[1]]) : (info[f[1]] || "");
      });
      modal.querySelector("#pfShowBirthday").checked = !!info.showbirthday;
      pfAvatarImage = info.avatarimage || null;
      pfAvatarUsePhoto = !!info.avatarusephoto;
      paintPfAvatar();
      save.disabled = false;
    } catch (err) {
      setErr(err.message || "Could not load your profile.");
    }
  }
  function closeProfileModal() {
    if (modal) modal.classList.add("hidden");
  }

  async function saveProfile() {
    var firstName = modal.querySelector("#pfFirstName").value.trim();
    var lastName = modal.querySelector("#pfLastName").value.trim();
    if (!firstName || !lastName) {
      setErr(t("common.nameRequired", "Name is required"));
      return;
    }
    var info = { showbirthday: modal.querySelector("#pfShowBirthday").checked,
                 avatarimage: pfAvatarImage, avatarusephoto: pfAvatarUsePhoto };
    FIELDS.forEach(function (f) {
      info[f[1]] = modal.querySelector("#" + f[0]).value.trim() || null;
    });
    var save = modal.querySelector("#pfSave");
    save.disabled = true;
    setErr("");
    try {
      await HITT_API.updateMyProfile({ firstName: firstName, lastName: lastName, info: info });
      // Reflect the new name + avatar in the header right away.
      var nameEl = document.getElementById("userName");
      if (nameEl) nameEl.textContent = (firstName + " " + lastName).trim();
      var avatarEl = document.getElementById("userAvatar");
      if (avatarEl) {
        HITT_AVATAR.paint(avatarEl, {
          dataUrl: pfAvatarUsePhoto ? pfAvatarImage : null,
          initials: HITT_AUTH.initials({ displayName: firstName + " " + lastName }),
        });
      }
      closeProfileModal();
    } catch (err) {
      setErr(err.message || "Could not save your profile.");
      save.disabled = false;
    }
  }

  /* ============================== INIT ================================= */
  injectStylesheet();
  function start() {
    buildMenu();
    if (window.HITT_PERMS) {
      HITT_PERMS.get().then(function (p) { perms = p; }).catch(function () {});
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
