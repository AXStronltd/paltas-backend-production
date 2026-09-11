/* ======================================================================
 * WHAT THE PUSHED HOMEPAGE DOES WITH A ROW FROM THIS API.
 *
 * Copied verbatim out of `index.html` in the paltas-frontend repository —
 * the targeting rules and `fromPromotion()`, which is the one function that
 * turns a row from GET /promotions/public into a card on the carousel.
 *
 * It is here so `test/contract.test.js` can check this service against the
 * frontend's real behaviour by default, without carrying a 1.4 MB copy of a
 * page that would be stale within a week.
 *
 * THIS FILE IS A FIXTURE. It is never imported by the service and never runs.
 * To check against the live frontend instead, which is always better:
 *
 *     FRONTEND_INDEX=../paltas-frontend/index.html npm test
 *
 * If the two disagree, the frontend is right and this copy is out of date.
 * ====================================================================== */

  /*
   * Is this campaign running, and is it running HERE?
   *
   * Two questions, and the second is the one that was missing. A promotion
   * used to be global by construction: every card rendered for every visitor,
   * so "Pay with M-Pesa" greeted Stockholm and "Stay in Stockholm" greeted
   * Nairobi. Targeting now narrows a campaign by market, and a campaign with
   * no targeting stays global — which is the right default, because most
   * campaigns are.
   *
   * The fields a campaign may carry (all optional, all narrowing):
   *
   *     countries        ["KE"]         only these markets
   *     excludeCountries ["SE"]         everywhere but these
   *     regions          ["africa"]     coarser than a country
   *     cities           ["Makkah"]     matched against the DESTINATION
   *     currencies       ["KES"]        only where prices are in these
   *     languages        ["sw"]         only to readers of these
   *     audience         ["traveller"]  who this is for
   *     requiresPayment  "mpesa"        only where that rail actually resolves
   *     requiresService  "hajj_umrah"   only where that service exists
   *
   * The last two are the strongest, and the ones worth reaching for. Naming
   * Kenya is a guess that M-Pesa is on there; asking whether M-Pesa resolves
   * is the fact, and it stays true the day a provider is switched off.
   */
  function running(p) {
    if (p.active === false) return false;
    var today = new Date().toISOString().slice(0, 10);
    if (p.startDate && today < p.startDate) return false;
    if (p.endDate && today > p.endDate) return false;
    return window.PALTAS.Market.promotionTargets(p, {
      city: window.PALTAS.Market.destination(),
      audience: ["traveller"],
    });
  }

  function fromPromotion(p) {
    if (!p || p.status !== "PUBLISHED") return null;
    var today = new Date().toISOString().slice(0, 10);
    if (p.startDate && today < p.startDate) return null;
    if (p.endDate && today > p.endDate) return null;
    if (!p.headline || !p.ctaLabel) return null;
    var kind = String(p.type || "product");
    var like = null;
    for (var i = 0; i < PALTAS_PROMOS.length; i++) {
      if (PALTAS_PROMOS[i].type === kind) { like = PALTAS_PROMOS[i]; break; }
    }
    return {
      id: "cust-" + p.id,
      type: kind,
      active: true,
      priority: typeof p.priority === "number" ? p.priority : 50,
      badge: p.offer || (p.organization || "On PALTAS"),
      title: p.headline,
      subtitle: p.subtitle || "",
      desc: p.description || "",
      /* No artwork of PALTAS's own is put on somebody else's promotion: it
         borrows the gradient its type already uses, and nothing else. */
      art: (like && like.art) || "linear-gradient(150deg,#152238,#2c4a7a 55%,#131f33)",
      motif: (like && like.motif) || "",
      image: p.image && p.image.indexOf("art:") !== 0 ? p.image : "",
      ctaLabel: p.ctaLabel,
      ctaHref: p.ctaDestination || "",
      destination: p.destination || "",
      startDate: p.startDate || "",
      /* Targeting survives the intake. A customer promotion that named
         Sweden must still only reach Sweden once it is in the feed. */
      countries: p.countries || null, excludeCountries: p.excludeCountries || null,
      regions: p.regions || null, cities: p.cities || null,
      currencies: p.currencies || null, languages: p.languages || null,
      audience: p.audience || null,
      requiresPayment: p.requiresPayment || null,
      requiresService: p.requiresService || null,
      requiresProduct: p.requiresProduct || null,
      endDate: p.endDate || "",
    };
  }
