<script>
/* ==================================================================== *
 * PROMOTIONS, OVER THE NETWORK.
 *
 * js40 defined PromoAPI against an in-memory store. This file replaces its
 * insides with fetch() when — and only when — an API has been configured:
 *
 *     window.PALTAS_API_BASE = "https://api.paltas.io";
 *
 * The same switch the market service already uses, so there is one place that
 * decides whether this build is talking to a server, not two.
 *
 * NOT ONE SCREEN CHANGES. js41 and js42 call `PromoAPI.list()`,
 * `PromoAPI.submit()` and the rest exactly as before; they never knew where a
 * promotion came from and they still do not. That was the point of putting a
 * service in front of the array in the first place.
 *
 * ── WHAT HAPPENS WHEN THE SERVER IS NOT THERE ───────────────────────────
 *
 * The screens already have a real error state, so a failed call surfaces as
 * "your promotions could not be loaded" with a Try again button, and NOT as a
 * silent fall back to the mock data. That distinction matters: a customer
 * looking at demo promotions while believing they are looking at their own is
 * worse than a customer looking at an error.
 *
 * With no API configured, this file does nothing at all and the mock store
 * stays exactly as it was — which is what keeps the offline demo working.
 * ==================================================================== */

(function () {
  "use strict";

  /*
   * ── WHICH SWITCH, AND WHY THERE ARE TWO ─────────────────────────────────
   *
   * `window.PALTAS_API_BASE` is the market service's switch (backend.md §4c).
   * Setting it makes `assets/market-config.js` stop using its local table and
   * call four endpoints instead: /market/config, /payment-methods/available,
   * /localization/config and /services/available.
   *
   * And §4c is explicit that a failed availability call is NOT permission to
   * guess — the frontend then offers no payment methods at all rather than
   * falling back to a table that may be a release behind. Which means that if
   * promotions borrowed that same global before those four endpoints existed,
   * turning promotions on would quietly turn payment selection OFF across the
   * whole marketplace. One switch, two services, one of them not built yet.
   *
   * So promotions has its own switch until the market endpoints are live:
   *
   *     window.PALTAS_PROMOTIONS_API = "https://api.paltas.io";   // now
   *     window.PALTAS_API_BASE       = "https://api.paltas.io";   // once §4c ships
   *
   * The second is still read, so the day the market endpoints exist the single
   * seam works exactly as intended and this override can be deleted.
   */
  var BASE = String(
    window.PALTAS_PROMOTIONS_API || window.PALTAS_API_BASE || ""
  ).replace(/\/+$/, "");
  if (!BASE) return;   /* no server configured — js40's mock store stands */

  /*
   * "/api" IS THE VALUE TO USE, not "https://api.paltas.io".
   *
   * netlify.toml proxies /api/* through to Render, so a relative base keeps
   * every request on the app's own origin. That is what makes the session
   * cookie first-party — and a third-party cookie is one Safari refuses to
   * store at all, which is sign-in failing on every iPhone with nothing in
   * the console to say why.
   *
   * An absolute cross-origin base still works here, and is still the right
   * thing for a local backend on another port. It is just not what should be
   * deployed.
   */

  /* ----------------------------------------------------------- the wire */

  function call(path, opts) {
    var o = opts || {};
    return fetch(BASE + path, {
      method: o.method || "GET",
      /* The session is an httpOnly cookie on the API's own domain, so every
         call has to opt in to sending it. Without this the API sees an
         anonymous request and answers 401 to everything. */
      credentials: "include",
      headers: o.body ? { "content-type": "application/json" } : undefined,
      body: o.body ? JSON.stringify(o.body) : undefined,
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}

        if (res.ok) return data;

        /*
         * AN ERROR A PERSON CAN READ.
         *
         * The API writes its refusals in sentences — "The role 'MARKETING'
         * cannot do that. Publishing belongs to a PALTAS publisher." — and the
         * screens show whatever is in `.message`. So the message is carried
         * through unchanged rather than replaced with a status code.
         */
        var err = new Error(
          (data && data.message) ||
          (res.status === 401 ? "Your sign-in has expired. Sign in again." :
           res.status === 403 ? "This account cannot do that." :
           res.status === 429 ? "That is more requests than the server allows just now. Wait a moment." :
           "The server could not do that (" + res.status + ").")
        );
        err.status = res.status;
        err.code = data && data.error;
        err.details = data && data.details;
        throw err;
      });
    }, function () {
      /* A network failure, not an HTTP error: no server, no connection, DNS.
         Worth saying differently, because the fix is different. */
      throw new Error("PALTAS could not be reached. Check your connection and try again.");
    });
  }

  var qs = function (o) {
    var parts = [];
    for (var k in o) {
      if (o[k] === undefined || o[k] === null || o[k] === "") continue;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(o[k]));
    }
    return parts.length ? "?" + parts.join("&") : "";
  };

  /* ------------------------------------------------- the same eight methods */

  var live = {
    list: function (filter) {
      var f = filter || {};
      return call("/promotions" + qs({
        scope: f.scope || "mine",
        status: f.status,
        queue: f.queue ? "true" : "",
        finalQueue: f.finalQueue ? "true" : "",
      })).then(function (d) { return (d && d.promotions) || []; });
    },

    get: function (id) { return call("/promotions/" + encodeURIComponent(id)); },

    create: function (data) {
      return call("/promotions", { method: "POST", body: data || {} });
    },

    update: function (id, data) {
      return call("/promotions/" + encodeURIComponent(id), { method: "PATCH", body: data || {} });
    },

    submit: function (id) {
      return call("/promotions/" + encodeURIComponent(id) + "/submit", { method: "POST" });
    },

    /*
     * The customer's three decisions and PALTAS's five are separate endpoints
     * on the server, because they are separate rights. The frontend's two
     * functions map onto them here rather than the server growing one
     * do-anything endpoint that decides from a string in the body.
     */
    review: function (id, decision, message) {
      var path = decision === "approve" ? "review/approve"
               : decision === "changes" ? "review/changes"
               : "review/reject";
      return call("/promotions/" + encodeURIComponent(id) + "/" + path,
        { method: "POST", body: { message: message || "" } });
    },

    publish: function (id, action, message) {
      var path = action === "publish" ? "publish"
               : action === "schedule" ? "schedule"
               : action === "pause" ? "pause"
               : action === "changes" ? "review/changes"
               : "review/reject";
      return call("/promotions/" + encodeURIComponent(id) + "/" + path,
        { method: "POST", body: { message: message || "" } });
    },

    publicFeed: function (today) {
      return call("/promotions/public" + qs({ today: today }))
        .then(function (d) { return (d && d.promotions) || []; });
    },
  };

  /* Replace the methods in place. PromoAPI is a closure over an array; the
     object it returned is what every screen holds a reference to, so writing
     over its methods is what swaps the implementation without anything above
     it noticing. */
  for (var k in live) PromoAPI[k] = live[k];

  /*
   * THE MOCK ROWS GO.
   *
   * Leaving them would mean a real customer's empty dashboard shows six
   * invented promotions — and the one in CHANGES_REQUESTED would tell them
   * PALTAS had asked for something PALTAS never asked for.
   */
  try { PROMOS.length = 0; } catch (e) {}

  if (window.console) {
    console.info("PALTAS promotions: talking to " + BASE);
  }
})();
</script>
