/**
 * HITT Ops — avatar helper (shared)
 * ---------------------------------------------------------------------------
 * Loaded on every page. Two jobs:
 *   HITT_AVATAR.cropSquareDataUrl(file) -> Promise<dataUrl>
 *     Reads an image File, auto center-crops it to a square and downscales
 *     to 256x256, returns a JPEG data URL (~15-25 KB). No crop UI — the
 *     centre of the image is kept.
 *   HITT_AVATAR.paint(el, { dataUrl, initials })
 *     Renders an avatar element as either the photo or the initials text.
 * ---------------------------------------------------------------------------
 */
window.HITT_AVATAR = (function () {
  var SIZE = 256;

  function cropSquareDataUrl(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) {
        reject(new Error("Pick an image file."));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("Could not read that file.")); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("That image could not be loaded.")); };
        img.onload = function () {
          var side = Math.min(img.naturalWidth, img.naturalHeight);
          var sx = (img.naturalWidth - side) / 2;
          var sy = (img.naturalHeight - side) / 2;
          var canvas = document.createElement("canvas");
          canvas.width = SIZE;
          canvas.height = SIZE;
          var ctx = canvas.getContext("2d");
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
          try {
            resolve(canvas.toDataURL("image/jpeg", 0.82));
          } catch (e) {
            reject(new Error("Could not process that image."));
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function paint(el, opts) {
    if (!el) return;
    opts = opts || {};
    if (opts.dataUrl) {
      el.textContent = "";
      el.style.backgroundImage = 'url("' + opts.dataUrl + '")';
      el.classList.add("avatar--photo");
    } else {
      el.style.backgroundImage = "";
      el.classList.remove("avatar--photo");
      if (opts.initials != null) el.textContent = opts.initials;
    }
  }

  return { cropSquareDataUrl: cropSquareDataUrl, paint: paint };
})();
