/*
 * PALTAS — the market configuration service.
 * =========================================================================
 *
 * ONE file answers every country question the platform asks. Which currency
 * do I format in, which language do I speak, which payment methods may I
 * offer, which services exist here, which promotions belong on this screen.
 * Before this file those five answers were written seven times across three
 * scripts, and every one of them said "Kenya" when it did not know.
 *
 *
 * THE PRINCIPLE
 * -------------
 * PALTAS is a global platform that must feel local. That is not the same as
 * a Kenyan platform shown everywhere, and the difference is entirely in what
 * happens when the market is UNKNOWN. A platform that defaults to Kenya shows
 * a Swedish visitor M-Pesa and prices in shillings and calls it localisation.
 * This file has no default country. Until a market is known the answer to
 * "which payment methods" is an empty list and the answer to "which currency"
 * is nothing — and the UI asks.
 *
 *
 * FOUR CONCEPTS THAT ARE NOT THE SAME THING
 * -----------------------------------------
 *     currentLocation      where the device appears to be, when detectable
 *     countryOfResidence   what the customer has declared about themselves
 *     selectedCountry      the MARKET being browsed — sets currency, language,
 *                          payment methods, services, promotions
 *     destination          where they want to go
 *
 * Conflating the last two is the bug this separation exists to kill: a guest
 * in Stockholm booking a room in Makkah is a SWEDISH market transaction with
 * a Saudi destination. They are offered Swedish payment methods. M-Pesa does
 * not appear because the destination is Makkah, and it does not appear because
 * the property owner banks in Nairobi. Only the market decides.
 *
 *
 * THE BACKEND IS THE AUTHORITY
 * ----------------------------
 * Everything below is a LOCAL FALLBACK that lets the frontend be built and
 * demonstrated before the API exists. `PALTAS.Market.Api` is the seam: point
 * `window.PALTAS_API_BASE` at a server and the same four questions are asked
 * over HTTP instead, against these endpoints:
 *
 *     GET /market/config
 *     GET /payment-methods/available
 *     GET /localization/config
 *     GET /services/available
 *
 * The frontend never decides that a payment method is available. It displays
 * what it was told is available. The table in this file is a stand-in for
 * being told, not a second opinion.
 * ========================================================================= */

(function (root) {
  "use strict";

  /* ===================================================================== 1
   * THE COUNTRY CATALOGUE
   *
   * A country is not a flag and a currency. It is a currency, a formatting
   * locale, the languages actually spoken in the product there, the dialling
   * code a phone field should hint at, the places PALTAS holds inventory for,
   * and an indicative price level so a demo can show plausible figures in the
   * local currency rather than converted shillings.
   *
   *   code      ISO 3166-1 alpha-2 — the only identifier used anywhere
   *   name      English display name
   *   flag      emoji
   *   currency  ISO 4217 — what prices are QUOTED in for this market
   *   locale    BCP-47 — what Intl formats numbers and dates with
   *   langs     language codes offered here, best first
   *   region    coarse grouping, used only for regional promotions
   *   dial      international dialling prefix
   *   perUsd    indicative units per US dollar, for DISPLAY conversion only
   *   base      typical nightly stay price in this currency
   *   cities    places PALTAS holds a list for; absent means "type it"
   *
   * `perUsd` deserves a warning. It is an indicative rate frozen at authoring
   * time so that a price can be SHOWN in a visitor's own currency. It is not a
   * quote, it is never used to charge anybody, and every figure derived from
   * it is labelled as approximate in the UI. The backend settles real money at
   * a real rate; see `Money.convert`.
   * ===================================================================== */

  var COUNTRIES = [
    /* ---- East & Central Africa ---- */
    { code:"KE", name:"Kenya",            flag:"🇰🇪", currency:"KES", locale:"en-KE", langs:["sw","en"], region:"africa", dial:"+254", perUsd:129,     base:11500,
      cities:["Nairobi","Mombasa","Diani Beach","Malindi","Watamu","Nakuru","Kisumu","Nanyuki","Naivasha","Lamu","Kilifi","Eldoret","Thika","Karen","Westlands","Kilimani"] },
    { code:"TZ", name:"Tanzania",         flag:"🇹🇿", currency:"TZS", locale:"en-TZ", langs:["sw","en"], region:"africa", dial:"+255", perUsd:2600,    base:120000,
      cities:["Dar es Salaam","Zanzibar","Arusha","Dodoma","Mwanza","Nungwi","Stone Town","Moshi"] },
    { code:"UG", name:"Uganda",           flag:"🇺🇬", currency:"UGX", locale:"en-UG", langs:["en","sw"], region:"africa", dial:"+256", perUsd:3700,    base:180000,
      cities:["Kampala","Entebbe","Jinja","Gulu","Mbarara","Fort Portal"] },
    { code:"RW", name:"Rwanda",           flag:"🇷🇼", currency:"RWF", locale:"en-RW", langs:["en","sw"], region:"africa", dial:"+250", perUsd:1300,    base:95000,
      cities:["Kigali","Musanze","Rubavu","Huye","Nyagatare"] },
    { code:"ET", name:"Ethiopia",         flag:"🇪🇹", currency:"ETB", locale:"en-ET", langs:["en"],      region:"africa", dial:"+251", perUsd:57,      base:5200,
      cities:["Addis Ababa","Bahir Dar","Hawassa","Gondar","Lalibela","Mekelle","Adama","Dire Dawa"] },
    { code:"SO", name:"Somalia",          flag:"🇸🇴", currency:"USD", locale:"en",    langs:["en","ar"], region:"africa", dial:"+252", perUsd:1,       base:60,
      cities:["Mogadishu","Hargeisa","Bosaso","Kismayo","Garowe","Berbera"] },
    { code:"ZM", name:"Zambia",           flag:"🇿🇲", currency:"ZMW", locale:"en-ZM", langs:["en"],      region:"africa", dial:"+260", perUsd:26,      base:1400,
      cities:["Lusaka","Kitwe","Ndola","Livingstone"] },

    /* ---- West & Southern Africa ---- */
    { code:"NG", name:"Nigeria",          flag:"🇳🇬", currency:"NGN", locale:"en-NG", langs:["en"],      region:"africa", dial:"+234", perUsd:1550,    base:95000,
      cities:["Lagos","Abuja","Port Harcourt","Ibadan","Lekki","Victoria Island","Enugu","Calabar","Kano"] },
    { code:"GH", name:"Ghana",            flag:"🇬🇭", currency:"GHS", locale:"en-GH", langs:["en"],      region:"africa", dial:"+233", perUsd:15,      base:1400,
      cities:["Accra","Kumasi","Takoradi","Cape Coast","Tamale","Ada"] },
    { code:"ZA", name:"South Africa",     flag:"🇿🇦", currency:"ZAR", locale:"en-ZA", langs:["en"],      region:"africa", dial:"+27",  perUsd:18,      base:2400,
      cities:["Cape Town","Johannesburg","Durban","Pretoria","Stellenbosch","Camps Bay","Sandton","Umhlanga","Franschhoek"] },

    /* ---- Middle East & North Africa ---- */
    { code:"SA", name:"Saudi Arabia",     flag:"🇸🇦", currency:"SAR", locale:"ar-SA", langs:["ar","en"], region:"mena",   dial:"+966", perUsd:3.75,    base:520,
      cities:["Riyadh","Jeddah","Makkah","Madinah","Dammam","Khobar","AlUla","Abha","Taif"] },
    { code:"AE", name:"United Arab Emirates", flag:"🇦🇪", currency:"AED", locale:"en-AE", langs:["ar","en"], region:"mena", dial:"+971", perUsd:3.67, base:650,
      cities:["Dubai","Abu Dhabi","Sharjah","Ras Al Khaimah","Palm Jumeirah","Fujairah","Ajman","Al Ain","Dubai Marina","Saadiyat Island","Yas Island"] },
    { code:"QA", name:"Qatar",            flag:"🇶🇦", currency:"QAR", locale:"en-QA", langs:["ar","en"], region:"mena",   dial:"+974", perUsd:3.64,    base:480,
      cities:["Doha","Al Wakrah","Lusail","Al Khor"] },
    { code:"KW", name:"Kuwait",           flag:"🇰🇼", currency:"KWD", locale:"en-KW", langs:["ar","en"], region:"mena",   dial:"+965", perUsd:0.31,    base:42,
      cities:["Kuwait City","Hawalli","Salmiya","Ahmadi"] },
    { code:"BH", name:"Bahrain",          flag:"🇧🇭", currency:"BHD", locale:"en-BH", langs:["ar","en"], region:"mena",   dial:"+973", perUsd:0.38,    base:50,
      cities:["Manama","Riffa","Muharraq","Amwaj Islands"] },
    { code:"OM", name:"Oman",             flag:"🇴🇲", currency:"OMR", locale:"en-OM", langs:["ar","en"], region:"mena",   dial:"+968", perUsd:0.385,   base:52,
      cities:["Muscat","Salalah","Sohar","Nizwa"] },
    { code:"JO", name:"Jordan",           flag:"🇯🇴", currency:"JOD", locale:"en-JO", langs:["ar","en"], region:"mena",   dial:"+962", perUsd:0.71,    base:78,
      cities:["Amman","Aqaba","Irbid","Zarqa","Petra"] },
    { code:"EG", name:"Egypt",            flag:"🇪🇬", currency:"EGP", locale:"ar-EG", langs:["ar","en"], region:"mena",   dial:"+20",  perUsd:48,      base:3400,
      cities:["Cairo","Alexandria","Giza","Hurghada","Sharm El Sheikh","New Cairo","Luxor","Aswan"] },
    { code:"MA", name:"Morocco",          flag:"🇲🇦", currency:"MAD", locale:"ar-MA", langs:["ar","en"], region:"mena",   dial:"+212", perUsd:9.9,     base:850,
      cities:["Casablanca","Marrakesh","Rabat","Tangier","Agadir","Fes","Essaouira","Chefchaouen"] },
    { code:"TR", name:"Türkiye",          flag:"🇹🇷", currency:"TRY", locale:"tr-TR", langs:["en"],      region:"mena",   dial:"+90",  perUsd:34,      base:2600,
      cities:["Istanbul","Ankara","Izmir","Antalya","Bodrum","Bursa","Cappadocia","Fethiye"] },

    /* ---- Europe ---- */
    { code:"GB", name:"United Kingdom",   flag:"🇬🇧", currency:"GBP", locale:"en-GB", langs:["en"],      region:"europe", dial:"+44",  perUsd:0.79,    base:150,
      cities:["London","Manchester","Edinburgh","Bath","Brighton","Liverpool","Oxford","Cambridge","Cornwall","Glasgow","Birmingham","Leeds","Bristol","Cardiff","Belfast"] },
    { code:"IE", name:"Ireland",          flag:"🇮🇪", currency:"EUR", locale:"en-IE", langs:["en"],      region:"europe", dial:"+353", perUsd:0.92,    base:140,
      cities:["Dublin","Cork","Galway","Limerick","Killarney"] },
    { code:"SE", name:"Sweden",           flag:"🇸🇪", currency:"SEK", locale:"sv-SE", langs:["sv","en"], region:"europe", dial:"+46",  perUsd:10.6,    base:1500,
      cities:["Stockholm","Gothenburg","Malmö","Uppsala","Västerås","Visby","Åre","Lund","Helsingborg"] },
    { code:"NO", name:"Norway",           flag:"🇳🇴", currency:"NOK", locale:"nb-NO", langs:["en"],      region:"europe", dial:"+47",  perUsd:10.9,    base:1600,
      cities:["Oslo","Bergen","Trondheim","Stavanger","Tromsø"] },
    { code:"DK", name:"Denmark",          flag:"🇩🇰", currency:"DKK", locale:"da-DK", langs:["en"],      region:"europe", dial:"+45",  perUsd:6.9,     base:1100,
      cities:["Copenhagen","Aarhus","Odense","Aalborg","Skagen"] },
    { code:"FI", name:"Finland",          flag:"🇫🇮", currency:"EUR", locale:"fi-FI", langs:["en"],      region:"europe", dial:"+358", perUsd:0.92,    base:130,
      cities:["Helsinki","Espoo","Tampere","Turku","Rovaniemi"] },
    { code:"FR", name:"France",           flag:"🇫🇷", currency:"EUR", locale:"fr-FR", langs:["en"],      region:"europe", dial:"+33",  perUsd:0.92,    base:120,
      cities:["Paris","Nice","Lyon","Cannes","Bordeaux","Marseille","Saint-Tropez","Chamonix","Provence","Toulouse"] },
    { code:"DE", name:"Germany",          flag:"🇩🇪", currency:"EUR", locale:"de-DE", langs:["en"],      region:"europe", dial:"+49",  perUsd:0.92,    base:130,
      cities:["Berlin","Munich","Hamburg","Frankfurt","Cologne","Düsseldorf","Stuttgart","Dresden"] },
    { code:"ES", name:"Spain",            flag:"🇪🇸", currency:"EUR", locale:"es-ES", langs:["en"],      region:"europe", dial:"+34",  perUsd:0.92,    base:110,
      cities:["Madrid","Barcelona","Valencia","Seville","Malaga","Marbella","Palma","Ibiza","Granada"] },
    { code:"PT", name:"Portugal",         flag:"🇵🇹", currency:"EUR", locale:"pt-PT", langs:["en"],      region:"europe", dial:"+351", perUsd:0.92,    base:120,
      cities:["Lisbon","Porto","Faro","Cascais","Madeira","Albufeira","Sintra","Lagos","Algarve"] },
    { code:"IT", name:"Italy",            flag:"🇮🇹", currency:"EUR", locale:"it-IT", langs:["en"],      region:"europe", dial:"+39",  perUsd:0.92,    base:125,
      cities:["Rome","Milan","Florence","Naples","Venice","Turin","Bologna","Amalfi","Como"] },
    { code:"NL", name:"Netherlands",      flag:"🇳🇱", currency:"EUR", locale:"nl-NL", langs:["en"],      region:"europe", dial:"+31",  perUsd:0.92,    base:135,
      cities:["Amsterdam","Rotterdam","The Hague","Utrecht","Eindhoven","Maastricht"] },
    { code:"PL", name:"Poland",           flag:"🇵🇱", currency:"PLN", locale:"pl-PL", langs:["en"],      region:"europe", dial:"+48",  perUsd:4,       base:450,
      cities:["Warsaw","Kraków","Gdańsk","Wrocław","Poznań","Zakopane"] },
    { code:"CH", name:"Switzerland",      flag:"🇨🇭", currency:"CHF", locale:"de-CH", langs:["en"],      region:"europe", dial:"+41",  perUsd:0.88,    base:190,
      cities:["Zurich","Geneva","Basel","Bern","Lausanne","Zug","Zermatt","Interlaken"] },

    /* ---- Americas ---- */
    { code:"US", name:"United States",    flag:"🇺🇸", currency:"USD", locale:"en-US", langs:["en"],      region:"americas", dial:"+1", perUsd:1,       base:240,
      cities:["New York","Miami","Los Angeles","Austin","Malibu","Lake Tahoe","Las Vegas","Orlando","San Francisco","Chicago","Aspen","Nashville","Boston","Seattle","Denver","Washington DC"] },
    { code:"CA", name:"Canada",           flag:"🇨🇦", currency:"CAD", locale:"en-CA", langs:["en"],      region:"americas", dial:"+1", perUsd:1.37,    base:220,
      cities:["Toronto","Vancouver","Montreal","Calgary","Whistler","Banff","Ottawa","Quebec City"] },
    { code:"MX", name:"Mexico",           flag:"🇲🇽", currency:"MXN", locale:"es-MX", langs:["en"],      region:"americas", dial:"+52", perUsd:20,     base:3200,
      cities:["Mexico City","Guadalajara","Monterrey","Cancún","Playa del Carmen","Tulum","Oaxaca"] },
    { code:"BR", name:"Brazil",           flag:"🇧🇷", currency:"BRL", locale:"pt-BR", langs:["en"],      region:"americas", dial:"+55", perUsd:5.7,    base:450,
      cities:["Rio de Janeiro","São Paulo","Florianópolis","Salvador","Búzios","Fortaleza","Paraty","Brasília"] },

    /* ---- Asia & Pacific ---- */
    { code:"IN", name:"India",            flag:"🇮🇳", currency:"INR", locale:"en-IN", langs:["en"],      region:"asia",   dial:"+91",  perUsd:84,      base:7500,
      cities:["Mumbai","Goa","Bengaluru","Delhi","Jaipur","Kerala","Udaipur","Manali","Pune","Hyderabad","Chennai","Kochi"] },
    { code:"PK", name:"Pakistan",         flag:"🇵🇰", currency:"PKR", locale:"en-PK", langs:["en","ar"], region:"asia",   dial:"+92",  perUsd:278,     base:22000,
      cities:["Karachi","Lahore","Islamabad","Rawalpindi","Faisalabad","Murree"] },
    { code:"BD", name:"Bangladesh",       flag:"🇧🇩", currency:"BDT", locale:"en-BD", langs:["en"],      region:"asia",   dial:"+880", perUsd:120,     base:9000,
      cities:["Dhaka","Chittagong","Sylhet","Khulna","Cox's Bazar"] },
    { code:"LK", name:"Sri Lanka",        flag:"🇱🇰", currency:"LKR", locale:"en-LK", langs:["en"],      region:"asia",   dial:"+94",  perUsd:295,     base:22000,
      cities:["Colombo","Kandy","Galle","Negombo","Ella","Sigiriya"] },
    { code:"JP", name:"Japan",            flag:"🇯🇵", currency:"JPY", locale:"ja-JP", langs:["en"],      region:"asia",   dial:"+81",  perUsd:150,     base:18000,
      cities:["Tokyo","Kyoto","Osaka","Okinawa","Sapporo","Hakone","Nara","Fukuoka","Hiroshima"] },
    { code:"SG", name:"Singapore",        flag:"🇸🇬", currency:"SGD", locale:"en-SG", langs:["en"],      region:"asia",   dial:"+65",  perUsd:1.34,    base:230,
      cities:["Singapore"] },
    { code:"MY", name:"Malaysia",         flag:"🇲🇾", currency:"MYR", locale:"en-MY", langs:["en"],      region:"asia",   dial:"+60",  perUsd:4.4,     base:400,
      cities:["Kuala Lumpur","Penang","Johor Bahru","Kota Kinabalu","Langkawi","Malacca"] },
    { code:"TH", name:"Thailand",         flag:"🇹🇭", currency:"THB", locale:"th-TH", langs:["en"],      region:"asia",   dial:"+66",  perUsd:34,      base:2600,
      cities:["Bangkok","Chiang Mai","Phuket","Pattaya","Koh Samui","Krabi"] },
    { code:"ID", name:"Indonesia",        flag:"🇮🇩", currency:"IDR", locale:"id-ID", langs:["en"],      region:"asia",   dial:"+62",  perUsd:15800,   base:1400000,
      cities:["Bali","Jakarta","Lombok","Yogyakarta","Bandung","Ubud","Seminyak","Canggu"] },
    { code:"PH", name:"Philippines",      flag:"🇵🇭", currency:"PHP", locale:"en-PH", langs:["en"],      region:"asia",   dial:"+63",  perUsd:58,      base:5200,
      cities:["Manila","Cebu City","Davao","Makati","Quezon City","Boracay","Palawan"] },
    { code:"AU", name:"Australia",        flag:"🇦🇺", currency:"AUD", locale:"en-AU", langs:["en"],      region:"pacific",dial:"+61",  perUsd:1.52,    base:210,
      cities:["Sydney","Melbourne","Gold Coast","Byron Bay","Perth","Brisbane","Cairns","Noosa","Adelaide"] },
    { code:"NZ", name:"New Zealand",      flag:"🇳🇿", currency:"NZD", locale:"en-NZ", langs:["en"],      region:"pacific",dial:"+64",  perUsd:1.66,    base:230,
      cities:["Auckland","Wellington","Christchurch","Queenstown","Rotorua"] },
  ];

  var BY_CODE = {};
  COUNTRIES.forEach(function (c) { BY_CODE[c.code] = c; });

  /* Name lookup, because the marketplace was written against country NAMES
     and rewriting every call site to codes at once would be a bigger change
     than this needs to be. Codes are canonical; names resolve to them. */
  var BY_NAME = {};
  COUNTRIES.forEach(function (c) { BY_NAME[c.name.toLowerCase()] = c; });
  /* Names PALTAS has used elsewhere for the same place. Held in a variable
     rather than written inline, because reindex() has to apply the very same
     list — an alias table that exists only on the load path disappears the
     first time the catalogue is replaced from the server. */
  var NAME_ALIASES = [["uae","AE"], ["united arab emirates","AE"], ["uk","GB"], ["britain","GB"],
   ["great britain","GB"], ["usa","US"], ["united states of america","US"],
   ["america","US"], ["turkey","TR"], ["holland","NL"], ["ksa","SA"],
   ["saudi","SA"]];
  NAME_ALIASES.forEach(function (p) { BY_NAME[p[0]] = BY_CODE[p[1]]; });

  /* ===================================================================== 2
   * THE PAYMENT METHOD CATALOGUE
   *
   * The shape below is the shape the backend will return. It is written here
   * so the frontend can be finished against it, and so that the day the API
   * arrives the only thing that changes is where the array comes from:
   *
   *     { id, name, type, countries, currencies, enabled, provider, eligibility }
   *
   * THE RULE THIS ENCODES. A payment method is not available because a country
   * exists. It is available when a provider is configured for that country,
   * that currency and that transaction. Four gates, all of which must pass:
   *
   *     countries     the market must be in the list
   *     currencies    the transaction currency must be in the list
   *     enabled       the provider integration must actually be switched on
   *     eligibility   the amount and any per-method rule must pass
   *
   * `enabled:false` is not decoration. It is how a method that PALTAS intends
   * to support but has not yet connected stays OUT of the list instead of
   * appearing as a promise the checkout cannot keep. Nothing renders a
   * disabled method as a greyed-out option — a payment method a customer
   * cannot press is worse than one they never saw.
   *
   * `type` groups the forms: every `mobile_money` asks for a handset, every
   * `card` asks for a PAN. The checkout renders from the type, so adding a
   * method is adding a row here and nothing else.
   * ===================================================================== */

  var EU_SEPA = ["IE","FR","DE","ES","PT","IT","NL","FI","SE","DK","PL","CH","NO"];

  var PAYMENT_METHODS = [
    /* ---- cards: the closest thing to universal, and still not universal --- */
    { id:"card", name:"Card", type:"card", provider:"stripe", enabled:true,
      blurb:"Visa, Mastercard",
      countries:"*",
      currencies:"*",
      eligibility:{ minUsd:1, maxUsd:50000 },
      icon:{ bg:"#2ea6ff", svg:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>' } },

    /* ---- mobile money: East and West Africa, and nowhere else ------------ */
    { id:"mpesa", name:"M-Pesa", type:"mobile_money", provider:"safaricom_daraja", enabled:true,
      blurb:"Pay from your M-Pesa wallet",
      /* Safaricom in Kenya and Vodacom in Tanzania are the two M-Pesa rails
         PALTAS has a provider for. M-Pesa also runs in other markets; they are
         absent here because absent means "not connected", not "does not
         exist", and the checkout must never offer what it cannot take. */
      countries:["KE","TZ"],
      currencies:["KES","TZS"],
      /* A real limit, not a placeholder. Safaricom caps a single customer-to-
         business payment, and a checkout that lets somebody choose M-Pesa for
         a figure above it has simply moved the failure later. */
      eligibility:{ perCurrencyMax:{ KES:250000, TZS:5000000 } },
      icon:{ bg:"#22a45d", svg:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M11 18h2"/>' } },

    { id:"airtel_money", name:"Airtel Money", type:"mobile_money", provider:"airtel_africa", enabled:true,
      blurb:"Pay from your Airtel wallet",
      countries:["KE","TZ","UG","RW","ZM","NG"],
      currencies:["KES","TZS","UGX","RWF","ZMW","NGN"],
      eligibility:{ maxUsd:3000 },
      icon:{ bg:"#e3000f", svg:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 18h6"/>' } },

    { id:"mtn_momo", name:"MTN MoMo", type:"mobile_money", provider:"mtn_momo", enabled:true,
      blurb:"MTN Mobile Money",
      countries:["UG","RW","GH","NG","ZM"],
      currencies:["UGX","RWF","GHS","NGN","ZMW"],
      eligibility:{ maxUsd:3000 },
      icon:{ bg:"#ffcc00", svg:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 6h6"/>' } },

    /* ---- Europe ---------------------------------------------------------- */
    { id:"swish", name:"Swish", type:"mobile_payment", provider:"swish", enabled:true,
      blurb:"Instant payment from your Swedish bank",
      countries:["SE"], currencies:["SEK"],
      eligibility:{ perCurrencyMax:{ SEK:150000 } },
      icon:{ bg:"#d4145a", svg:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 6h6"/>' } },

    { id:"sepa", name:"SEPA transfer", type:"bank_transfer", provider:"adyen", enabled:true,
      blurb:"European bank transfer",
      countries:EU_SEPA,
      currencies:["EUR","SEK","DKK","NOK","PLN","CHF"],
      eligibility:{ minUsd:5 },
      icon:{ bg:"#0b5cad", svg:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15h6"/>' } },

    { id:"ideal", name:"iDEAL", type:"bank_redirect", provider:"adyen", enabled:true,
      blurb:"Pay from your Dutch bank",
      countries:["NL"], currencies:["EUR"],
      eligibility:{ maxUsd:12000 },
      icon:{ bg:"#cc0066", svg:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 9v6M11 9v6"/>' } },

    { id:"vipps", name:"Vipps", type:"mobile_payment", provider:"vipps_mobilepay", enabled:true,
      blurb:"Approve in the Vipps app",
      countries:["NO"], currencies:["NOK"],
      eligibility:{},
      icon:{ bg:"#ff5b24", svg:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 18h6"/>' } },

    { id:"mobilepay", name:"MobilePay", type:"mobile_payment", provider:"vipps_mobilepay", enabled:true,
      blurb:"Approve in the MobilePay app",
      countries:["DK","FI"], currencies:["DKK","EUR"],
      eligibility:{},
      icon:{ bg:"#5a78ff", svg:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 18h6"/>' } },

    { id:"blik", name:"BLIK", type:"mobile_payment", provider:"adyen", enabled:true,
      blurb:"Six-digit code from your bank app",
      countries:["PL"], currencies:["PLN"],
      eligibility:{},
      icon:{ bg:"#000000", svg:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 10h6"/>' } },

    /* ---- Middle East ----------------------------------------------------- */
    { id:"mada", name:"mada", type:"card", provider:"checkout_com", enabled:true,
      blurb:"Saudi debit card",
      countries:["SA"], currencies:["SAR"],
      eligibility:{},
      icon:{ bg:"#1d4e89", svg:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>' } },

    { id:"stcpay", name:"stc pay", type:"wallet", provider:"checkout_com", enabled:true,
      blurb:"Pay from your stc pay wallet",
      countries:["SA"], currencies:["SAR"],
      eligibility:{ perCurrencyMax:{ SAR:60000 } },
      icon:{ bg:"#4f2d7f", svg:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 6h6"/>' } },

    { id:"knet", name:"KNET", type:"bank_redirect", provider:"checkout_com", enabled:true,
      blurb:"Kuwaiti bank debit",
      countries:["KW"], currencies:["KWD"],
      eligibility:{},
      icon:{ bg:"#00833e", svg:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M8 12h8"/>' } },

    { id:"benefit", name:"BENEFIT", type:"bank_redirect", provider:"checkout_com", enabled:true,
      blurb:"Bahraini bank debit",
      countries:["BH"], currencies:["BHD"],
      eligibility:{},
      icon:{ bg:"#d81e26", svg:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M8 12h8"/>' } },

    { id:"fawry", name:"Fawry", type:"voucher", provider:"fawry", enabled:true,
      blurb:"Pay at any Fawry point",
      countries:["EG"], currencies:["EGP"],
      eligibility:{ maxUsd:1500 },
      icon:{ bg:"#ffb81c", svg:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/>' } },

    /* Buy-now-pay-later across the Gulf. Written here as a worked example of
       a method whose eligibility is not just country and currency: it has a
       floor as well as a ceiling, because instalments on a very small amount
       are not a product anybody offers. */
    { id:"tabby", name:"Tabby", type:"bnpl", provider:"tabby", enabled:true,
      blurb:"Split into 4 payments",
      countries:["AE","SA","KW","QA","BH"],
      currencies:["AED","SAR","KWD","QAR","BHD"],
      eligibility:{ minUsd:25, maxUsd:3000 },
      icon:{ bg:"#3bffc2", svg:'<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M8 6v12M16 6v12"/>' } },

    /* ---- Americas -------------------------------------------------------- */
    { id:"ach", name:"Bank transfer (ACH)", type:"bank_transfer", provider:"stripe", enabled:true,
      blurb:"Direct from your US bank",
      countries:["US"], currencies:["USD"],
      eligibility:{ minUsd:5 },
      icon:{ bg:"#7c5cff", svg:'<path d="M3 21h18M5 21V10M19 21V10M3 10l9-6 9 6M9 21v-6h6v6"/>' } },

    { id:"interac", name:"Interac e-Transfer", type:"bank_transfer", provider:"interac", enabled:true,
      blurb:"Canadian bank e-Transfer",
      countries:["CA"], currencies:["CAD"],
      eligibility:{ perCurrencyMax:{ CAD:25000 } },
      icon:{ bg:"#f2b100", svg:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M8 12h8"/>' } },

    { id:"pix", name:"Pix", type:"bank_transfer", provider:"adyen", enabled:true,
      blurb:"Instant bank payment",
      countries:["BR"], currencies:["BRL"],
      eligibility:{},
      icon:{ bg:"#32bcad", svg:'<path d="M12 3l4 4-4 4-4-4z"/><path d="M12 13l4 4-4 4-4-4z"/>' } },

    /* ---- Asia and the Pacific -------------------------------------------- */
    { id:"upi", name:"UPI", type:"mobile_payment", provider:"razorpay", enabled:true,
      blurb:"Google Pay, PhonePe and more",
      countries:["IN"], currencies:["INR"],
      eligibility:{ perCurrencyMax:{ INR:100000 } },
      icon:{ bg:"#5f259f", svg:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 18h6"/>' } },

    { id:"paynow", name:"PayNow", type:"bank_transfer", provider:"adyen", enabled:true,
      blurb:"Scan with your bank app",
      countries:["SG"], currencies:["SGD"],
      eligibility:{},
      icon:{ bg:"#6f1d7c", svg:'<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>' } },

    { id:"promptpay", name:"PromptPay", type:"bank_transfer", provider:"adyen", enabled:true,
      blurb:"Thai QR payment",
      countries:["TH"], currencies:["THB"],
      eligibility:{},
      icon:{ bg:"#0b4ea2", svg:'<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>' } },

    { id:"gcash", name:"GCash", type:"wallet", provider:"xendit", enabled:true,
      blurb:"Pay from your GCash wallet",
      countries:["PH"], currencies:["PHP"],
      eligibility:{ maxUsd:2000 },
      icon:{ bg:"#0074e0", svg:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 18h6"/>' } },

    { id:"grabpay", name:"GrabPay", type:"wallet", provider:"adyen", enabled:true,
      blurb:"Pay from your Grab wallet",
      countries:["SG","MY","TH","PH"], currencies:["SGD","MYR","THB","PHP"],
      eligibility:{ maxUsd:2000 },
      icon:{ bg:"#00b14f", svg:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 18h6"/>' } },

    /* ---- wide, but never everywhere ------------------------------------- */
    { id:"paypal", name:"PayPal", type:"wallet", provider:"paypal", enabled:true,
      blurb:"Pay with your PayPal balance",
      countries:["US","CA","GB","IE","FR","DE","ES","PT","IT","NL","SE","NO","DK","FI","PL","CH","AU","NZ","JP","SG","MX","BR"],
      currencies:["USD","CAD","GBP","EUR","SEK","NOK","DKK","PLN","CHF","AUD","NZD","JPY","SGD","MXN","BRL"],
      eligibility:{ maxUsd:10000 },
      icon:{ bg:"#0070ba", svg:'<path d="M6 4h8a4 4 0 0 1 0 8H9l-1 8H5z"/>' } },

    { id:"bank_transfer", name:"Bank transfer", type:"bank_transfer", provider:"manual", enabled:true,
      blurb:"Direct from your bank",
      /* The universal fallback, and the one method that is genuinely almost
         everywhere — because it settles by reference rather than by rail. It
         is last in the list for the same reason: it is the slowest. */
      countries:"*", currencies:"*",
      eligibility:{ minUsd:20 },
      icon:{ bg:"#7c5cff", svg:'<path d="M3 21h18M5 21V10M19 21V10M3 10l9-6 9 6M9 21v-6h6v6"/>' } },

    /* ---- built, waiting on a provider ------------------------------------
       `enabled:false` keeps these out of every list until somebody switches
       them on. They are here so the catalogue is honest about what exists in
       the roadmap, and so switching one on is a one-word change. */
    { id:"apple_pay", name:"Apple Pay", type:"wallet", provider:"stripe", enabled:false,
      blurb:"Pay with Apple Pay", countries:"*", currencies:"*", eligibility:{},
      icon:{ bg:"#111318", svg:'<path d="M12 7c1-2 3-3 5-3 0 2-1 4-3 5"/><rect x="4" y="8" width="16" height="12" rx="4"/>' } },
    { id:"google_pay", name:"Google Pay", type:"wallet", provider:"stripe", enabled:false,
      blurb:"Pay with Google Pay", countries:"*", currencies:"*", eligibility:{},
      icon:{ bg:"#4285f4", svg:'<circle cx="12" cy="12" r="8"/><path d="M12 8v8"/>' } },
  ];

  /* ===================================================================== 3
   * MARKET CAPABILITIES
   *
   * What PALTAS can actually do in a country. Not what it sells globally —
   * what is live there. A capability is a promise the product makes to a
   * customer, and the rule is that the frontend never makes one the market
   * cannot keep: a service absent from this list is not rendered disabled or
   * "coming soon", it simply is not offered.
   *
   *     payments               resolved from the catalogue above
   *     currencies             what may be transacted in
   *     languages              what the interface may be shown in
   *     products               what a BUSINESS can buy here
   *     services               what a CUSTOMER can do here
   *     complianceRequirements what the law asks for before publishing
   *     features               platform behaviour that is not a product
   *
   * The base set is what a market gets by default; a market named in
   * MARKET_OVERRIDES adds or removes from it. Adding the next country is a
   * row in the catalogue and, if it differs, a row here — never a branch in
   * a component.
   */

  var BASE_CAPABILITIES = {
    products: ["PROPERTY_MANAGEMENT", "AGENT_HOST", "HOTEL_MANAGEMENT"],
    services: ["rent", "buy", "stay", "hotel", "land", "commercial", "project"],
    complianceRequirements: ["company_registration", "tax_id", "proof_of_address"],
    features: ["saved_listings", "reviews", "messaging", "search_alerts"],
  };

  /* Only the differences. A market absent from here gets the base set, which
     is the point: the catalogue can grow to two hundred countries without
     this object growing at all. */
  var MARKET_OVERRIDES = {
    KE: { add:{ products:["SECURITY_MANAGEMENT"], services:["airport_transfer"],
                features:["escrow","instant_payout"] },
          complianceRequirements:["company_registration","kra_pin","proof_of_address","title_deed_or_lease"] },
    TZ: { add:{ services:["airport_transfer"], features:["escrow"] } },
    UG: { add:{ services:["airport_transfer"] } },
    NG: { add:{ services:["airport_transfer"] } },
    ZA: { add:{ products:["SECURITY_MANAGEMENT"], features:["escrow"] } },

    SA: { add:{ services:["airport_transfer","hajj_umrah"], features:["escrow"] },
          complianceRequirements:["commercial_registration","vat_number","proof_of_address","municipality_licence"] },
    AE: { add:{ products:["SECURITY_MANAGEMENT"], services:["airport_transfer"],
                features:["escrow"] },
          complianceRequirements:["trade_licence","emirates_id","proof_of_address","rera_registration"] },
    QA: { add:{ services:["airport_transfer"] } },
    KW: { add:{ services:["airport_transfer"] } },
    BH: { add:{ services:["airport_transfer"] } },
    OM: { add:{ services:["airport_transfer"] } },
    EG: { add:{ services:["airport_transfer","hajj_umrah"] } },
    JO: { add:{ services:["hajj_umrah"] } },
    MA: { add:{ services:["hajj_umrah"] } },
    TR: { add:{ services:["airport_transfer","hajj_umrah"] } },

    GB: { complianceRequirements:["companies_house_number","vat_number","proof_of_address","epc_certificate"] },
    SE: { complianceRequirements:["organisationsnummer","vat_number","proof_of_address"] },
    IE: { complianceRequirements:["cro_number","vat_number","proof_of_address"] },
    DE: { complianceRequirements:["handelsregister","ust_idnr","proof_of_address"] },
    FR: { complianceRequirements:["siret","tva_number","proof_of_address"] },
    NL: { complianceRequirements:["kvk_number","btw_number","proof_of_address"] },

    US: { add:{ features:["escrow"] },
          complianceRequirements:["ein","state_registration","proof_of_address","w9"] },
    CA: { complianceRequirements:["business_number","gst_number","proof_of_address"] },

    IN: { add:{ services:["airport_transfer"] },
          complianceRequirements:["gstin","pan","proof_of_address"] },
    PK: { add:{ services:["hajj_umrah"] } },
    BD: { add:{ services:["hajj_umrah"] } },
    ID: { add:{ services:["airport_transfer","hajj_umrah"] } },
    MY: { add:{ services:["airport_transfer","hajj_umrah"] } },
    TH: { add:{ services:["airport_transfer"] } },
    PH: { add:{ services:["airport_transfer"] } },
    LK: { add:{ services:["airport_transfer"] } },
  };

  /* ===================================================================== 4
   * LOCALIZATION
   *
   * The architecture matters more than the coverage. Every visible string
   * goes through `t()`, every pack may be partial, and a missing key falls
   * back to English rather than rendering a key name or a blank. That is what
   * makes adding a language a data change: a new pack starts empty, is
   * correct from its first line, and improves without a code change.
   *
   * WHAT IS AND IS NOT TRANSLATED HERE. The four packs below carry the terms
   * the interface repeats — the chrome, the money words, the booking words.
   * They are deliberately not padded out: a wrong translation in a payment
   * screen is worse than an English one, so anything not confidently known is
   * simply absent and falls back. `coverage()` reports the real figure rather
   * than letting the build imply the product is fully translated.
   *
   * WHICH LANGUAGE WINS. An explicit choice, always. Below that, the market's
   * first language if the browser has no opinion; below that, the browser's
   * language if the market offers it; below that, English.
   */

  var LANGUAGES = {
    en: { code:"en", name:"English",  native:"English",   dir:"ltr" },
    sw: { code:"sw", name:"Swahili",  native:"Kiswahili", dir:"ltr" },
    sv: { code:"sv", name:"Swedish",  native:"Svenska",   dir:"ltr" },
    ar: { code:"ar", name:"Arabic",   native:"العربية",    dir:"rtl" },
  };

  var STRINGS = {
    en: {
      "nav.business":"For business", "nav.signin":"Log in", "nav.signup":"Sign up",
      "nav.guest":"Guest", "nav.wishlist":"Wishlist",
      "country.choose":"Choose your country", "country.search":"Search country...",
      "country.select":"Select your country", "country.none":"Country",
      "country.why":"Sets your currency, language and payment methods",
      "search.where":"Where to?", "search.when":"When", "search.who":"Who",
      "search.go":"Search", "search.guests":"Guests",
      "price.night":"night", "price.month":"month", "price.total":"Total",
      "price.from":"from", "price.approx":"approx.",
      "book.reserve":"Reserve", "book.checkin":"Check-in", "book.checkout":"Check-out",
      "book.cleaning":"Cleaning fee", "book.service":"Service fee",
      "book.confirm":"Confirm and pay", "book.confirmed":"Booking confirmed",
      "pay.method":"Payment method", "pay.methods":"Payment methods",
      "pay.available":"Showing the payment methods available in",
      "pay.none":"No payment method is configured for this country yet.",
      "pay.unknown":"Choose your country to see how you can pay.",
      "pay.fee":"fee", "pay.nofee":"No fee", "pay.pay":"Pay",
      "pay.phone":"Mobile money number", "pay.card":"Card number",
      "pay.expiry":"Expiry", "pay.cvc":"CVC", "pay.iban":"IBAN",
      "common.continue":"Continue", "common.back":"Back", "common.cancel":"Cancel",
      "common.save":"Save", "common.close":"Close", "common.language":"Language",
      "common.currency":"Currency", "common.country":"Country", "common.welcome":"Welcome",
    },

    /* Kiswahili. The terms below are the ones used consistently across East
       African products; anything less certain is absent and falls back. */
    sw: {
      "nav.business":"Kwa biashara", "nav.signin":"Ingia", "nav.signup":"Jisajili",
      "nav.guest":"Mgeni",
      "country.choose":"Chagua nchi yako", "country.search":"Tafuta nchi...",
      "country.select":"Chagua nchi yako", "country.none":"Nchi",
      "search.where":"Unaenda wapi?", "search.when":"Lini", "search.who":"Nani",
      "search.go":"Tafuta", "search.guests":"Wageni",
      "price.night":"usiku", "price.month":"mwezi", "price.total":"Jumla",
      "book.checkin":"Kuingia", "book.checkout":"Kutoka",
      "pay.method":"Njia ya malipo", "pay.methods":"Njia za malipo",
      "pay.pay":"Lipa", "pay.fee":"ada",
      "common.continue":"Endelea", "common.back":"Rudi", "common.cancel":"Ghairi",
      "common.save":"Hifadhi", "common.close":"Funga", "common.language":"Lugha",
      "common.currency":"Sarafu", "common.country":"Nchi", "common.welcome":"Karibu",
    },

    /* Svenska. */
    sv: {
      "nav.business":"För företag", "nav.signin":"Logga in", "nav.signup":"Skapa konto",
      "nav.guest":"Gäst",
      "country.choose":"Välj ditt land", "country.search":"Sök land...",
      "country.select":"Välj ditt land", "country.none":"Land",
      "search.where":"Vart vill du åka?", "search.when":"När", "search.who":"Vilka",
      "search.go":"Sök", "search.guests":"Gäster",
      "price.night":"natt", "price.month":"månad", "price.total":"Totalt",
      "price.from":"från",
      "book.checkin":"Incheckning", "book.checkout":"Utcheckning",
      "book.cleaning":"Städavgift", "book.service":"Serviceavgift",
      "pay.method":"Betalningsmetod", "pay.methods":"Betalningsmetoder",
      "pay.pay":"Betala", "pay.fee":"avgift", "pay.card":"Kortnummer",
      "common.continue":"Fortsätt", "common.back":"Tillbaka", "common.cancel":"Avbryt",
      "common.save":"Spara", "common.close":"Stäng", "common.language":"Språk",
      "common.currency":"Valuta", "common.country":"Land", "common.welcome":"Välkommen",
    },

    /* العربية. Right-to-left; `dir` above is what flips the document. */
    ar: {
      "nav.business":"للشركات", "nav.signin":"تسجيل الدخول", "nav.signup":"إنشاء حساب",
      "nav.guest":"ضيف",
      "country.choose":"اختر بلدك", "country.search":"ابحث عن بلد...",
      "country.select":"اختر بلدك", "country.none":"البلد",
      "search.where":"إلى أين؟", "search.when":"متى", "search.who":"من",
      "search.go":"بحث", "search.guests":"الضيوف",
      "price.night":"ليلة", "price.month":"شهر", "price.total":"الإجمالي",
      "price.from":"من",
      "book.checkin":"تسجيل الوصول", "book.checkout":"تسجيل المغادرة",
      "pay.method":"طريقة الدفع", "pay.methods":"طرق الدفع",
      "pay.pay":"ادفع", "pay.fee":"رسوم",
      "common.continue":"متابعة", "common.back":"رجوع", "common.cancel":"إلغاء",
      "common.save":"حفظ", "common.close":"إغلاق", "common.language":"اللغة",
      "common.currency":"العملة", "common.country":"البلد", "common.welcome":"مرحباً",
    },
  };

  /* ===================================================================== 5
   * DETECTION — a suggestion, never a decision
   *
   * The browser will tell you a time zone and a language. Neither is a
   * country, and the distance between "probably" and "certainly" is exactly
   * where a global platform goes wrong: a Kenyan phone in a Stockholm hotel
   * reports Europe/Stockholm, and a Swede's laptop set to en-GB reports GB.
   *
   * So detection returns a confidence alongside the guess. A high-confidence
   * guess is adopted silently because being right nine times in ten beats
   * making everybody choose. A low-confidence one is offered, not applied,
   * and nothing country-specific renders until it is confirmed.
   */

  var TZ_COUNTRY = {
    "Africa/Nairobi":"KE", "Africa/Dar_es_Salaam":"TZ", "Africa/Kampala":"UG",
    "Africa/Kigali":"RW", "Africa/Addis_Ababa":"ET", "Africa/Mogadishu":"SO",
    "Africa/Lusaka":"ZM", "Africa/Lagos":"NG", "Africa/Accra":"GH",
    "Africa/Johannesburg":"ZA", "Africa/Cairo":"EG", "Africa/Casablanca":"MA",
    "Asia/Riyadh":"SA", "Asia/Dubai":"AE", "Asia/Qatar":"QA", "Asia/Kuwait":"KW",
    "Asia/Bahrain":"BH", "Asia/Muscat":"OM", "Asia/Amman":"JO", "Europe/Istanbul":"TR",
    "Europe/London":"GB", "Europe/Dublin":"IE", "Europe/Stockholm":"SE",
    "Europe/Oslo":"NO", "Europe/Copenhagen":"DK", "Europe/Helsinki":"FI",
    "Europe/Paris":"FR", "Europe/Berlin":"DE", "Europe/Madrid":"ES",
    "Europe/Lisbon":"PT", "Europe/Rome":"IT", "Europe/Amsterdam":"NL",
    "Europe/Warsaw":"PL", "Europe/Zurich":"CH",
    "America/New_York":"US", "America/Chicago":"US", "America/Denver":"US",
    "America/Los_Angeles":"US", "America/Phoenix":"US", "America/Anchorage":"US",
    "Pacific/Honolulu":"US", "America/Toronto":"CA", "America/Vancouver":"CA",
    "America/Edmonton":"CA", "America/Winnipeg":"CA", "America/Halifax":"CA",
    "America/Mexico_City":"MX", "America/Cancun":"MX",
    "America/Sao_Paulo":"BR", "America/Bahia":"BR", "America/Fortaleza":"BR",
    "Asia/Kolkata":"IN", "Asia/Calcutta":"IN", "Asia/Karachi":"PK",
    "Asia/Dhaka":"BD", "Asia/Colombo":"LK", "Asia/Tokyo":"JP",
    "Asia/Singapore":"SG", "Asia/Kuala_Lumpur":"MY", "Asia/Bangkok":"TH",
    "Asia/Jakarta":"ID", "Asia/Makassar":"ID", "Asia/Manila":"PH",
    "Australia/Sydney":"AU", "Australia/Melbourne":"AU", "Australia/Brisbane":"AU",
    "Australia/Perth":"AU", "Australia/Adelaide":"AU", "Pacific/Auckland":"NZ",
  

    /*
     * THE ZONES A VISITOR ACTUALLY REPORTS.
     *
     * Sixty-nine zones covered fifty countries — roughly one apiece, when the
     * United States alone has thirty. Somebody in Detroit, Indianapolis, St
     * John's, Recife, Tijuana, Hobart or the Azores resolved to NO country,
     * and no country meant no market, which meant the marketplace asked a
     * wholesaler about nowhere and showed them an empty page.
     *
     * These are IANA zone-to-country facts, not guesses, and they add no new
     * markets: every code below was already in the catalogue. The legacy
     * aliases ("US/Eastern", "GB", "Turkey") are here because browsers still
     * report them.
     */
    "Africa/Ceuta": "ES",
    "Africa/Mombasa": "KE",
    "America/Adak": "US",
    "America/Araguaina": "BR",
    "America/Atikokan": "CA",
    "America/Bahia_Banderas": "MX",
    "America/Belem": "BR",
    "America/Blanc-Sablon": "CA",
    "America/Boa_Vista": "BR",
    "America/Boise": "US",
    "America/Cambridge_Bay": "CA",
    "America/Campo_Grande": "BR",
    "America/Chihuahua": "MX",
    "America/Ciudad_Juarez": "MX",
    "America/Creston": "CA",
    "America/Cuiaba": "BR",
    "America/Dawson": "CA",
    "America/Dawson_Creek": "CA",
    "America/Detroit": "US",
    "America/Eirunepe": "BR",
    "America/Fort_Nelson": "CA",
    "America/Glace_Bay": "CA",
    "America/Goose_Bay": "CA",
    "America/Hermosillo": "MX",
    "America/Indiana/Indianapolis": "US",
    "America/Indiana/Knox": "US",
    "America/Indiana/Marengo": "US",
    "America/Indiana/Petersburg": "US",
    "America/Indiana/Tell_City": "US",
    "America/Indiana/Vevay": "US",
    "America/Indiana/Vincennes": "US",
    "America/Indiana/Winamac": "US",
    "America/Indianapolis": "US",
    "America/Inuvik": "CA",
    "America/Iqaluit": "CA",
    "America/Juneau": "US",
    "America/Kentucky/Louisville": "US",
    "America/Kentucky/Monticello": "US",
    "America/Louisville": "US",
    "America/Maceio": "BR",
    "America/Manaus": "BR",
    "America/Matamoros": "MX",
    "America/Mazatlan": "MX",
    "America/Menominee": "US",
    "America/Merida": "MX",
    "America/Metlakatla": "US",
    "America/Moncton": "CA",
    "America/Monterrey": "MX",
    "America/Nipigon": "CA",
    "America/Nome": "US",
    "America/Noronha": "BR",
    "America/North_Dakota/Beulah": "US",
    "America/North_Dakota/Center": "US",
    "America/North_Dakota/New_Salem": "US",
    "America/Ojinaga": "MX",
    "America/Porto_Velho": "BR",
    "America/Rainy_River": "CA",
    "America/Rankin_Inlet": "CA",
    "America/Recife": "BR",
    "America/Regina": "CA",
    "America/Resolute": "CA",
    "America/Rio_Branco": "BR",
    "America/Santarem": "BR",
    "America/Sitka": "US",
    "America/St_Johns": "CA",
    "America/Swift_Current": "CA",
    "America/Thunder_Bay": "CA",
    "America/Tijuana": "MX",
    "America/Whitehorse": "CA",
    "America/Yakutat": "US",
    "America/Yellowknife": "CA",
    "Asia/Istanbul": "TR",
    "Asia/Jayapura": "ID",
    "Asia/Kuching": "MY",
    "Asia/Pontianak": "ID",
    "Atlantic/Azores": "PT",
    "Atlantic/Canary": "ES",
    "Atlantic/Madeira": "PT",
    "Australia/ACT": "AU",
    "Australia/Broken_Hill": "AU",
    "Australia/Canberra": "AU",
    "Australia/Currie": "AU",
    "Australia/Darwin": "AU",
    "Australia/Eucla": "AU",
    "Australia/Hobart": "AU",
    "Australia/Lindeman": "AU",
    "Australia/Lord_Howe": "AU",
    "Australia/NSW": "AU",
    "Australia/Queensland": "AU",
    "Australia/South": "AU",
    "Australia/Tasmania": "AU",
    "Australia/Victoria": "AU",
    "Australia/West": "AU",
    "Brazil/East": "BR",
    "Brazil/West": "BR",
    "Canada/Atlantic": "CA",
    "Canada/Central": "CA",
    "Canada/Eastern": "CA",
    "Canada/Mountain": "CA",
    "Canada/Newfoundland": "CA",
    "Canada/Pacific": "CA",
    "Eire": "IE",
    "Europe/Belfast": "GB",
    "Europe/Busingen": "DE",
    "Europe/Guernsey": "GB",
    "Europe/Isle_of_Man": "GB",
    "Europe/Jersey": "GB",
    "GB": "GB",
    "GB-Eire": "GB",
    "Mexico/General": "MX",
    "NZ": "NZ",
    "NZ-CHAT": "NZ",
    "Pacific/Chatham": "NZ",
    "Turkey": "TR",
    "US/Alaska": "US",
    "US/Central": "US",
    "US/Eastern": "US",
    "US/Hawaii": "US",
    "US/Mountain": "US",
    "US/Pacific": "US",
  };

  function detect() {
    var tz = "", lang = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
    try { lang = (navigator.languages && navigator.languages[0]) || navigator.language || ""; } catch (e) {}

    /* The time zone is the better signal of the two: it says where the device
       is, where the language says what the person reads. */
    if (tz && TZ_COUNTRY[tz] && BY_CODE[TZ_COUNTRY[tz]]) {
      return { code: TZ_COUNTRY[tz], confidence: "high", via: "timezone", tz: tz, lang: lang };
    }

    /* en-GB carries a region; plain `en` does not, and guessing a country
       from a bare language code is how every visitor becomes American. */
    var region = /^[a-z]{2,3}-([A-Z]{2})$/.exec(lang || "");
    if (region && BY_CODE[region[1]]) {
      return { code: region[1], confidence: "low", via: "language", tz: tz, lang: lang };
    }

    return { code: null, confidence: "none", via: tz ? "timezone-unmapped" : "nothing", tz: tz, lang: lang };
  }

  /* ===================================================================== 6
   * STATE — the four concepts, kept apart
   *
   * Nothing in the platform may read one of these when it means another. The
   * getters are the only way in, and each says in one line what question it
   * answers, because the whole class of bug here is answering the wrong one.
   */

  var STATE = {
    /* Where the device appears to be. Informational — it is never billed,
       never sets a currency, and never chooses a payment method. */
    currentLocation: null,
    /* What the customer has declared about themselves, when they have. Used
       for compliance and tax questions, not for what the screen shows. */
    countryOfResidence: null,
    /* THE MARKET. This, and only this, sets currency, language, payment
       methods, services, listings and promotions. Null means unknown, and
       unknown means the neutral experience — not Kenya. */
    selectedCountry: null,
    /* Where they want to go. Never affects payment: a Swede booking Makkah
       pays the Swedish way. */
    destination: null,
    /* An explicit language choice outranks everything the market suggests. */
    language: null,
    /* How the market came to be set, so the UI can say "we guessed" honestly. */
    source: "none",
    /* A low-confidence guess, offered but not applied. */
    suggestion: null,
  };

  /* Session storage rather than local: a market chosen on this visit should
     survive a page change, and should NOT greet the next person at the same
     machine with somebody else's country. The rest of this build deliberately
     remembers nothing between visits, and a country is not the exception. */
  var STORE_KEY = "paltas.market";

  function persist() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        selectedCountry: STATE.selectedCountry,
        countryOfResidence: STATE.countryOfResidence,
        language: STATE.language,
      }));
    } catch (e) { /* private mode, blocked storage — the session still works */ }
  }

  function restore() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return (v && v.selectedCountry && BY_CODE[v.selectedCountry]) ? v : null;
    } catch (e) { return null; }
  }

  /* ===================================================================== 7
   * MONEY
   *
   * Two rules. A figure always carries the currency it is IN — there is no
   * "amount" without one, because the day there is, two markets get added
   * together. And a figure shown in a currency other than its own is labelled
   * approximate, because it was converted at an indicative rate by a frontend
   * and the real one is settled by a bank.
   */

  /*
   * The formatting locale follows the LANGUAGE, not the country.
   *
   * `ar-SA` renders 1,234,567 in Arabic-Indic digits, which is right for an
   * Arabic interface and wrong for an English one looking at Saudi prices.
   * The country supplies the currency and the conventions; the language
   * supplies the script. Joining them is what makes en-SA and ar-SA two
   * correct answers to the same question rather than one of them a bug.
   */
  function localeFor(code, lang) {
    var c = code ? BY_CODE[code] : null;
    var l = lang || language();
    if (!c) return l || "en";
    return l + "-" + c.code;
  }

  function fmtMoney(amount, currency, locale) {
    var n = Number(amount);
    if (!isFinite(n)) return "";
    if (!currency) return String(n);
    /* Zero-decimal currencies exist and a Japanese price with two decimals
       reads as broken. Intl knows which; the fallback below has to be told. */
    var ZERO_DP = { JPY:1, KRW:1, VND:1, IDR:1, UGX:1, RWF:1, KES:1, TZS:1, CLP:1, ISK:1 };
    try {
      return new Intl.NumberFormat(locale || "en", {
        style: "currency", currency: currency,
        maximumFractionDigits: ZERO_DP[currency] ? 0 : (n % 1 ? 2 : 0),
      }).format(n);
    } catch (e) {
      return currency + " " + n.toLocaleString(locale || "en",
        { maximumFractionDigits: ZERO_DP[currency] ? 0 : 2 });
    }
  }

  function rateOf(currency) {
    for (var i = 0; i < COUNTRIES.length; i++) {
      if (COUNTRIES[i].currency === currency) return COUNTRIES[i].perUsd;
    }
    return null;
  }

  /* Indicative only. Never used to charge; see the header of section 1. */
  function convert(amount, from, to) {
    if (!from || !to || from === to) return Number(amount);
    var a = rateOf(from), b = rateOf(to);
    if (!a || !b) return null;
    var usd = Number(amount) / a;
    var out = usd * b;
    /* Round to something a price list would actually print rather than to
       the cent, which is what makes a converted figure look computed.
       BELOW TEN, KEEP THE DECIMALS. A 30-cent card fee converted to sterling
       is 24p, and rounding it to the nearest whole unit printed "2.9% + £0
       fee" — a fee of nothing, which is worse than no fee line at all. */
    if (out < 10) return Math.round(out * 100) / 100;
    var mag = out >= 100000 ? 1000 : out >= 10000 ? 100 : out >= 1000 ? 10 : out >= 100 ? 5 : 1;
    return Math.round(out / mag) * mag;
  }

  /* ===================================================================== 8
   * THE RESOLVERS
   */

  /* Per-method fees. Illustrative — the real figure comes from the provider
     agreement, which is why nothing here is presented to a customer without
     the backend having confirmed it. Expressed as a percentage of the
     transaction, plus a flat amount in the transaction currency where the
     rail charges one. */
  var FEES = {
    card:{ pct:2.9, flat:0.3, flatCur:"USD" }, mada:{ pct:1.0 },
    mpesa:{ pct:1.5 }, airtel_money:{ pct:1.8 }, mtn_momo:{ pct:1.8 },
    swish:{ pct:0 }, sepa:{ pct:0 }, ideal:{ pct:0 }, vipps:{ pct:1.0 },
    mobilepay:{ pct:1.0 }, blik:{ pct:0.9 }, stcpay:{ pct:1.4 },
    knet:{ pct:0.8 }, benefit:{ pct:0.8 }, fawry:{ pct:2.0 },
    tabby:{ pct:0 }, ach:{ pct:0.8 }, interac:{ pct:0 }, pix:{ pct:0.8 },
    upi:{ pct:0 }, paynow:{ pct:0 }, promptpay:{ pct:0.8 },
    gcash:{ pct:2.0 }, grabpay:{ pct:2.0 }, paypal:{ pct:3.4, flat:0.3, flatCur:"USD" },
    bank_transfer:{ pct:0 }, apple_pay:{ pct:2.9 }, google_pay:{ pct:2.9 },
  };

  function inList(list, value) {
    return list === "*" || (Array.isArray(list) && list.indexOf(value) >= 0);
  }

  /*
   * Which payment methods a transaction may actually use.
   *
   * ctx = { country, currency, amount }
   *
   * Every gate is explicit and every refusal carries a reason, because the
   * question asked in support is never "what is available" — it is "why is
   * M-Pesa not there", and a resolver that cannot answer that is a resolver
   * somebody works around.
   *
   * With NO country this returns an empty list. That is the whole point: the
   * neutral experience offers no payment method at all rather than guessing,
   * and the checkout asks for a country instead of showing a Kenyan rail to
   * somebody in Stockholm.
   */
  function availablePaymentMethods(ctx) {
    ctx = ctx || {};
    var code = ctx.country || STATE.selectedCountry;
    if (!code || !BY_CODE[code]) return [];
    var country = BY_CODE[code];
    var currency = ctx.currency || country.currency;
    var amount = typeof ctx.amount === "number" ? ctx.amount : null;

    var out = [];
    PAYMENT_METHODS.forEach(function (m) {
      if (!m.enabled) return;                                   /* not connected */
      if (!inList(m.countries, code)) return;                   /* not this market */
      if (!inList(m.currencies, currency)) return;              /* not this currency */

      var e = m.eligibility || {};
      var reason = null;

      if (amount !== null) {
        /* A per-currency ceiling is the real one where the rail publishes it;
           the USD bounds are a rough guard for everything else. */
        if (e.perCurrencyMax && e.perCurrencyMax[currency] && amount > e.perCurrencyMax[currency]) {
          reason = "Above the " + m.name + " limit of " +
                   fmtMoney(e.perCurrencyMax[currency], currency, localeFor(code));
        } else {
          var usd = convert(amount, currency, "USD");
          if (usd !== null && e.maxUsd && usd > e.maxUsd) reason = "Above the limit for " + m.name;
          if (usd !== null && e.minUsd && usd < e.minUsd) reason = "Below the minimum for " + m.name;
        }
      }
      if (reason) return;  /* ineligible is ABSENT, not greyed out — §29 */

      var fee = FEES[m.id] || { pct: 0 };
      out.push({
        id: m.id, name: m.name, type: m.type, provider: m.provider,
        enabled: true, blurb: m.blurb, icon: m.icon,
        country: code, currency: currency,
        feePct: fee.pct || 0,
        feeFlat: fee.flat || 0, feeFlatCurrency: fee.flatCur || null,
        feeLabel: buildFeeLabel(fee, currency, localeFor(code)),
        eligible: true,
      });
    });

    /*
     * The generic bank transfer is a FALLBACK, not a fifth option.
     *
     * Where the market already has a real bank rail — ACH in the States,
     * SEPA across Europe, Pix in Brazil — listing "Bank transfer" underneath
     * it offers the same thing twice under two names, and the customer has to
     * work out which of the two is the one their bank does. It drops out
     * whenever something better covers it.
     */
    var hasLocalBankRail = out.some(function (m) {
      return m.id !== "bank_transfer" &&
             (m.type === "bank_transfer" || m.type === "bank_redirect");
    });
    if (hasLocalBankRail) {
      out = out.filter(function (m) { return m.id !== "bank_transfer"; });
    }

    /* Cards and wallets are the generic rails; a local method is the one a
       customer recognises, so it leads. Within a group the catalogue order
       stands. */
    var GENERIC = { card:1, bank_transfer:1, paypal:1, apple_pay:1, google_pay:1 };
    return out.sort(function (a, b) { return (GENERIC[a.id] || 0) - (GENERIC[b.id] || 0); });
  }

  function buildFeeLabel(fee, currency, locale) {
    if (!fee || (!fee.pct && !fee.flat)) return "No fee";
    var parts = [];
    if (fee.pct) parts.push(fee.pct + "%");
    if (fee.flat) {
      var f = fee.flatCur === currency ? fee.flat : convert(fee.flat, fee.flatCur, currency);
      if (f !== null) parts.push(fmtMoney(f, currency, locale));
    }
    return parts.join(" + ") + " fee";
  }

  /* Capabilities for one market: the base set, plus and minus the overrides. */
  function capabilitiesOf(code) {
    if (!code || !BY_CODE[code]) return null;
    var country = BY_CODE[code];
    var o = MARKET_OVERRIDES[code] || {};
    var add = o.add || {}, drop = o.remove || {};

    function merge(key) {
      var base = (o[key] || BASE_CAPABILITIES[key] || []).slice();
      (add[key] || []).forEach(function (v) { if (base.indexOf(v) < 0) base.push(v); });
      return base.filter(function (v) { return (drop[key] || []).indexOf(v) < 0; });
    }

    return {
      country: code,
      payments: availablePaymentMethods({ country: code }).map(function (m) { return m.id; }),
      currencies: [country.currency],
      languages: country.langs.slice(),
      products: merge("products"),
      services: merge("services"),
      complianceRequirements: merge("complianceRequirements"),
      features: merge("features"),
    };
  }

  /*
   * Does this promotion belong on this screen?
   *
   * A promotion with no targeting is global and always shows. Every field
   * added narrows it, and an unknown market sees ONLY global promotions —
   * which is why "Pay with M-Pesa" cannot appear before a country is chosen,
   * and cannot appear in Sweden after one is.
   */
  function promotionTargets(promo, ctx) {
    if (!promo) return false;
    ctx = ctx || {};
    var code = ctx.country || STATE.selectedCountry;
    var country = code ? BY_CODE[code] : null;

    if (promo.excludeCountries && code && promo.excludeCountries.indexOf(code) >= 0) return false;
    if (promo.countries && promo.countries.length) {
      if (!code || promo.countries.indexOf(code) < 0) return false;
    }
    if (promo.regions && promo.regions.length) {
      if (!country || promo.regions.indexOf(country.region) < 0) return false;
    }
    if (promo.cities && promo.cities.length) {
      var here = ctx.city || STATE.destination || "";
      var hit = promo.cities.some(function (c) {
        return here && String(here).toLowerCase().indexOf(String(c).toLowerCase()) >= 0;
      });
      if (!hit) return false;
    }
    if (promo.currencies && promo.currencies.length) {
      if (!country || promo.currencies.indexOf(country.currency) < 0) return false;
    }
    if (promo.languages && promo.languages.length) {
      if (promo.languages.indexOf(language()) < 0) return false;
    }
    if (promo.audience && promo.audience.length) {
      var mine = ctx.audience || [];
      if (!promo.audience.some(function (a) { return mine.indexOf(a) >= 0; })) return false;
    }
    /* A promotion may also require a capability — "Pay with M-Pesa" requires
       M-Pesa to be resolvable here, which is stronger than naming Kenya and
       survives the day a provider is switched off. */
    if (promo.requiresPayment) {
      var ids = availablePaymentMethods({ country: code }).map(function (m) { return m.id; });
      if (ids.indexOf(promo.requiresPayment) < 0) return false;
    }
    if (promo.requiresService) {
      var caps = capabilitiesOf(code);
      if (!caps || caps.services.indexOf(promo.requiresService) < 0) return false;
    }
    /* A product PALTAS does not sell here is not advertised here. Security
       Management is live in three markets; a card selling it in Stockholm is
       a promise the signup cannot keep two screens later. */
    if (promo.requiresProduct) {
      var pcaps = capabilitiesOf(code);
      if (!pcaps || pcaps.products.indexOf(promo.requiresProduct) < 0) return false;
    }
    return true;
  }

  /* ===================================================================== 9
   * LANGUAGE AND TRANSLATION
   */

  /* Explicit choice, then the market, then the browser, then English. The
     order is the whole policy: once somebody has said which language they
     read, nothing is allowed to overrule it — not a market change, not a
     new device language, not a page navigation. */
  function language() {
    if (STATE.language && STRINGS[STATE.language]) return STATE.language;

    var country = STATE.selectedCountry ? BY_CODE[STATE.selectedCountry] : null;
    var browser = "";
    try { browser = ((navigator.languages && navigator.languages[0]) || navigator.language || "").slice(0, 2); } catch (e) {}

    /* The browser only wins when the market actually offers that language.
       A Swedish browser in the Kenyan market gets English, not Swedish that
       half the screen cannot speak. */
    if (country) {
      if (browser && country.langs.indexOf(browser) >= 0 && STRINGS[browser]) return browser;
      if (country.langs[0] && STRINGS[country.langs[0]]) return country.langs[0];
    }
    if (!country && browser && STRINGS[browser]) return browser;
    return "en";
  }

  function direction() { return (LANGUAGES[language()] || LANGUAGES.en).dir; }

  /*
   * One string.
   *
   * A missing key falls back to English and an English key missing from the
   * pack falls back to the key's own default, passed in. Nothing renders a
   * key name, and nothing renders blank — the two failure modes that make a
   * half-translated product look broken rather than partly translated.
   */
  function t(key, fallback) {
    var lang = language();
    var pack = STRINGS[lang];
    if (pack && pack[key] != null) return pack[key];
    if (STRINGS.en[key] != null) return STRINGS.en[key];
    return fallback != null ? fallback : key;
  }

  /* What proportion of the English pack each language actually covers. The
     build reports the real number so nobody ships believing Arabic is done. */
  function coverage() {
    var keys = Object.keys(STRINGS.en), out = {};
    Object.keys(STRINGS).forEach(function (lang) {
      var have = keys.filter(function (k) { return STRINGS[lang][k] != null; }).length;
      out[lang] = { keys: have, of: keys.length, pct: Math.round((have / keys.length) * 100) };
    });
    return out;
  }

  /* Adding a language is adding a pack. Nothing else in the platform changes,
     and a pack with four keys in it is legitimate — the other keys fall back. */
  function addLanguage(code, meta, strings) {
    LANGUAGES[code] = { code: code, name: meta.name, native: meta.native, dir: meta.dir || "ltr" };
    STRINGS[code] = strings || {};
  }

  /* ==================================================================== 10
   * EVENTS
   *
   * Changing the market changes currency, language, payment methods,
   * services, listings, destinations and promotions. Nothing in the platform
   * polls for that; everything subscribes, and the one place that writes the
   * market is the one place that announces it.
   */

  var LISTENERS = [];
  function on(fn) { if (typeof fn === "function") LISTENERS.push(fn); return function () { off(fn); }; }
  function off(fn) { var i = LISTENERS.indexOf(fn); if (i >= 0) LISTENERS.splice(i, 1); }
  function emit(what) {
    var snap = summary();
    LISTENERS.forEach(function (fn) { try { fn(snap, what); } catch (e) { /* one bad listener must not stop the rest */ } });
    try {
      document.documentElement.lang = language();
      document.documentElement.dir = direction();
    } catch (e) {}
    try { window.dispatchEvent(new CustomEvent("paltas:market", { detail: snap })); } catch (e) {}
  }

  /* ==================================================================== 11
   * THE SERVICE LAYER
   *
   * Four calls, matching the four endpoints the backend will expose. Today
   * they resolve from the configuration above; the day `PALTAS_API_BASE` is
   * set they resolve over HTTP against the same shapes. Every caller is
   * already asynchronous, so that switch changes nothing above this line.
   *
   *     GET /market/config
   *     GET /payment-methods/available
   *     GET /localization/config
   *     GET /services/available
   */

  /* ==================================================================== *
   * THE PRODUCTION API BASE, DECIDED ONCE, HERE.
   *
   * `window.PALTAS_API_BASE` stays the mechanism — architecture.md and
   * backend.md §4c both name it, and js43.js reads it too. This only gives it
   * a DEFAULT, because until now it was read and never assigned anywhere, so
   * the seam could never actually open.
   *
   * WHY HERE AND NOT IN EACH PAGE. Seventeen pages load this file and this
   * file is the only thing that reads the value. A <script> tag per page is
   * seventeen chances to miss one, and the page that was missed would talk to
   * a different base than its neighbours with nothing to show it. One place
   * cannot drift.
   *
   * WHY "/api" AND NOT THE RENDER URL. Relative keeps every request on the
   * app's own origin, which is what makes the session cookie FIRST-PARTY. A
   * cross-origin base makes it third-party, and Safari refuses to store those
   * at all — sign-in then works on a desktop and fails silently on every
   * iPhone. netlify.toml proxies /api/* through to Render.
   *
   * LOCAL DEVELOPMENT IS LEFT EXACTLY AS IT WAS, DELIBERATELY. There is no
   * /api proxy in front of a file:// page or a plain local static server, so
   * a relative base there would 404 every call. On localhost the value stays
   * empty and every resolver keeps using its local table — which is the
   * offline demo this file was built to support. To point a local backend at
   * it, set window.PALTAS_API_BASE before this script loads: an explicit
   * value always wins, because this only fills in an undefined one.
   * ==================================================================== */
  if (typeof root.PALTAS_API_BASE === "undefined") {
    root.PALTAS_API_BASE = (function () {
      try {
        var h = root.location && root.location.hostname;
        if (!h || h === "localhost" || h === "127.0.0.1" || h === "[::1]") return "";
        return "/api";
      } catch (e) { return ""; }
    })();
  }

  function apiBase() { return root.PALTAS_API_BASE || ""; }

  function get(path, query) {
    var url = apiBase() + path;
    var q = Object.keys(query || {})
      .filter(function (k) { return query[k] != null && query[k] !== ""; })
      .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(query[k]); })
      .join("&");
    if (q) url += (url.indexOf("?") < 0 ? "?" : "&") + q;
    return fetch(url, {
      headers: { Accept: "application/json" },
      /* The backend authenticates with an httpOnly session cookie, not a
         bearer token. Without this the browser sends no cookie at all and
         every authenticated endpoint answers 401 however correct CORS is. */
      credentials: "include",
    }).then(function (r) {
      if (!r.ok) throw new Error("PALTAS " + path + " → " + r.status);
      return r.json();
    });
  }

  var Api = {
    /*
     * GET /health — the cheapest proof that the base URL and the proxy work.
     *
     * THIS COMMENT USED TO SAY that the four resolvers below reached nothing:
     * that /market/config, /payment-methods/available, /localization/config
     * and /services/available were unbuilt and all answered 401, because an
     * unmatched path fell into the product router's session guard.
     *
     * THAT IS NO LONGER TRUE. All four are served — src/routes/market.js in
     * paltas-backend — all four are public, and all four answer 200 to an
     * anonymous caller. The last of them moved to /market/services, for the
     * reason given on availableServices below.
     *
     * /health stays, because it is still the only call that proves the
     * TRANSPORT rather than the answer: it touches the database on the way, so
     * a 200 here means the browser reached Render AND Render reached Postgres.
     *
     * It is NOT a health indicator for the UI and nothing renders it.
     */
    health: function () {
      return get("/health");
    },

    /* GET /market/config — the catalogue itself. A backend that returns a
       different country list is the supported way to open or close a market;
       nothing in the frontend needs redeploying for it. */
    marketConfig: function () {
      if (!apiBase()) return Promise.resolve({ countries: COUNTRIES, source: "local" });
      return get("/market/config").then(function (r) {
        if (r && Array.isArray(r.countries) && r.countries.length) {
          COUNTRIES = r.countries;
          reindex();
          emit("config");
        }
        return r;
      });
    },

    /* GET /payment-methods/available — THE authority. When this answers, its
       answer replaces the catalogue's for that transaction entirely; the
       local table is not consulted and not merged, because a frontend that
       adds a method the backend did not return has invented one. */
    availablePaymentMethods: function (ctx) {
      ctx = ctx || {};
      var code = ctx.country || STATE.selectedCountry;
      if (!apiBase()) return Promise.resolve(availablePaymentMethods(ctx));
      return get("/payment-methods/available", {
        country: code, currency: ctx.currency, amount: ctx.amount,
      }).then(function (r) {
        return (r && Array.isArray(r.methods)) ? r.methods : [];
      }).catch(function () {
        /* A failed call is not permission to guess. Nothing is offered, and
           the checkout says it could not load rather than falling back to a
           table that may be a release behind the provider configuration. */
        return [];
      });
    },

    /* GET /localization/config — which languages a market may be shown in,
       and the packs themselves once translation moves off the client. */
    localizationConfig: function (code) {
      code = code || STATE.selectedCountry;
      if (!apiBase()) {
        var c = code ? BY_CODE[code] : null;
        return Promise.resolve({
          languages: c ? c.langs : ["en"],
          current: language(), direction: direction(),
          available: Object.keys(LANGUAGES), coverage: coverage(), source: "local",
        });
      }
      return get("/localization/config", { country: code }).then(function (r) {
        if (r && r.strings) Object.keys(r.strings).forEach(function (l) {
          STRINGS[l] = Object.assign({}, STRINGS[l] || {}, r.strings[l]);
        });
        return r;
      });
    },

    /*
     * GET /market/services — what a customer can actually do here.
     *
     * WAS /services/available, WHICH COULD NEVER HAVE WORKED. `/services` is
     * a tenant RESOURCE on the API — model HotelService, one hotel's
     * restaurants, spas and airport transfer, behind a session. Express bound
     * `:id = "available"` and the request got a 401 from a router that had no
     * idea it had been asked a different question.
     *
     * Two unrelated things wanted one path. The tenant's outlets keep
     * /services, because twenty-seven console forms already post there; the
     * platform's market capabilities moved to /market/services. Same shape,
     * same caller, one word different.
     */
    availableServices: function (code) {
      code = code || STATE.selectedCountry;
      if (!apiBase()) {
        var caps = capabilitiesOf(code);
        return Promise.resolve({ country: code, services: caps ? caps.services : [], capabilities: caps, source: "local" });
      }
      return get("/market/services", { country: code });
    },
  };

  /*
   * THE SEAM, ACTUALLY CROSSED.
   *
   * This used to be a single call to /health whose only purpose was to prove
   * the base URL and the proxy worked — because at the time none of the four
   * catalogue endpoints existed, so there was nothing else to ask. The
   * resolvers above were written, exported, and never called by anything.
   * The backend now serves all four, and this is where that starts to matter.
   *
   * WHAT IS FETCHED AND WHAT IS NOT. Only /market/config, the catalogue
   * itself — the fifty markets, their currencies, their conversion rates and
   * their cities. It is the table every other answer in this file is computed
   * FROM, so refreshing it moves opening a market, closing one, or correcting
   * a rate to the backend, with no frontend deploy. That is precisely what
   * `Api.marketConfig()`'s own comment has always promised.
   *
   * The other three are left to their callers on purpose. Payment methods
   * depend on a country, a currency AND an amount, so there is no single
   * answer to prefetch; localisation returns no strings yet; services is
   * per-market. Each is a live call at the point of use, which is what those
   * screens already do.
   *
   * IT IS STILL SILENT AND STILL BLOCKS NOTHING. No await, no throw, and no
   * console noise when the backend is asleep — the local table is already
   * loaded and correct, so a failed refresh costs nothing and a visitor sees
   * the marketplace either way. Skipped entirely when no base is configured,
   * so the offline demo makes no network request at all.
   *
   * ON SUCCESS IT REPAINTS. marketConfig() calls reindex() and emit("config"),
   * and every screen that listens re-renders with the server's catalogue.
   */
  var apiReachable = null;
  if (apiBase()) {
    try {
      Api.marketConfig()
        .then(function () { apiReachable = true; })
        .catch(function () {
          apiReachable = false;
          /* The catalogue call failed. /health is asked ONLY now, and only to
             tell the two failures apart for whoever opens devtools: a backend
             that is down, versus one that is up and answering /market/config
             wrongly. Nothing on screen depends on which. */
          return Api.health()
            .then(function (r) { apiReachable = !!(r && r.ok) ? "catalogue" : false; })
            .catch(function () { apiReachable = false; });
        });
    } catch (e) { apiReachable = false; }
  }

  /* ==================================================================== 12
   * THE PUBLIC SURFACE
   */

  function country(code) { return BY_CODE[code || STATE.selectedCountry] || null; }

  /* ==================================================================== 11b
   * THE MARKET, IN THE ADDRESS BAR
   *
   * The market was already resolved correctly and kept in sessionStorage,
   * where nobody could see it. A visitor in Nairobi and a visitor in
   * Stockholm were both looking at paltas.io — the same bare address,
   * saying nothing about which of the fifty markets they were actually in,
   * and impossible to send to somebody else.
   *
   * So the resolved market is written into the path: /kenya, /sweden. When
   * no market resolves, the path says /smart-living rather than nothing.
   *
   * THREE THINGS THIS DELIBERATELY IS NOT:
   *
   *   Not a redirect. The server never sends anybody anywhere — the page is
   *   served at whatever address was asked for and the path is corrected in
   *   place with replaceState. paltas.io/ stays the canonical homepage, one
   *   entry in a search index, and the link nobody has to be bounced from.
   *
   *   Not a second country system. The slug is derived from the catalogue
   *   above, so a country cannot exist in one and be missing from the other.
   *
   *   Not applied to real pages. It only ever rewrites the homepage. A
   *   country slug replacing /partner.html would take a visitor's page away
   *   from them, so isHomePath() has to be true before anything is written.
   * ==================================================================== */

  /* "United Arab Emirates" -> "united-arab-emirates", "Türkiye" -> "turkiye".
     The diacritic is folded rather than dropped: a slug has to be typeable
     on a keyboard that has no ü on it. */
  function slugOf(c) {
    var name = String((c && c.name) || "");
    try { name = name.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  var BY_SLUG = {};

  /*
   * EVERY INDEX INTO THE CATALOGUE, REBUILT TOGETHER.
   *
   * There are three — by code, by name, by URL slug — plus the alias table,
   * and until this existed they were built in three different places and only
   * two of them were ever rebuilt.
   *
   * That was a real defect waiting on a feature. `Api.marketConfig()` replaces
   * COUNTRIES with the server's list, and it rebuilt BY_CODE and BY_NAME and
   * forgot BY_SLUG entirely — so the moment the backend actually answered,
   * /kenya would stop resolving and isHomePath() would stop recognising a
   * country path, while every code lookup carried on working perfectly. It
   * also rebuilt BY_NAME from names alone, which dropped "uae", "uk", "usa"
   * and the rest of NAME_ALIASES on the floor.
   *
   * Nobody had seen either, because nothing had ever called marketConfig().
   * One function now owns all of it, so a fourth index cannot be added and
   * half-wired.
   */
  function reindex() {
    BY_CODE = {};
    COUNTRIES.forEach(function (c) { BY_CODE[c.code] = c; });

    BY_NAME = {};
    COUNTRIES.forEach(function (c) { BY_NAME[c.name.toLowerCase()] = c; });
    NAME_ALIASES.forEach(function (p) { if (BY_CODE[p[1]]) BY_NAME[p[0]] = BY_CODE[p[1]]; });

    BY_SLUG = {};
    COUNTRIES.forEach(function (c) { BY_SLUG[slugOf(c)] = c; });
  }

  reindex();

  /* The branded path for a visitor whose market could not be worked out. */
  var NEUTRAL_PATH = "/smart-living";

  /*
   * Only the homepage may carry a market in its path. Anything else — a real
   * file, a directory, a page with its own identity — is left exactly alone.
   */
  function isHomePath(pathname) {
    var s = String(pathname || "/").replace(/\/+$/, "") || "/";
    if (s === "/" || s === "/index.html" || s === NEUTRAL_PATH) return true;
    return Object.prototype.hasOwnProperty.call(BY_SLUG, s.slice(1).toLowerCase());
  }

  /*
   * A market named in the URL. This is the strongest signal there is: a bare
   * paltas.io is a guess about where somebody is, and paltas.io/sweden is a
   * link somebody deliberately followed or was deliberately sent.
   *
   * Only a single top-level segment counts, so /auth/join.html and
   * /partner.html can never be read as a country.
   */
  function countryFromPath() {
    try {
      var p = String((root.location && root.location.pathname) || "");
      var seg = p.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
      if (!seg || seg.indexOf("/") >= 0) return null;
      return BY_SLUG[seg] || null;
    } catch (e) { return null; }
  }

  /*
   * Put the resolved market in the address bar. Query and fragment are
   * carried across untouched — ?go=stay is how the homepage routes, and
   * dropping it here would turn a market change into a navigation.
   */
  function reflectUrl() {
    try {
      var loc = root.location, hist = root.history;
      if (!loc || !hist || typeof hist.replaceState !== "function") return false;
      if (!isHomePath(loc.pathname)) return false;

      var c = BY_CODE[STATE.selectedCountry];
      var want = c ? "/" + slugOf(c) : NEUTRAL_PATH;
      if (loc.pathname === want) return false;

      hist.replaceState(hist.state, "", want + (loc.search || "") + (loc.hash || ""));
      return true;
    } catch (e) { return false; }
  }


  /* Name or code, either way in — the marketplace speaks names and the
     business half speaks codes, and neither has to learn the other's. */
  function lookup(value) {
    if (!value) return null;
    var s = String(value).trim();
    return BY_CODE[s.toUpperCase()] || BY_NAME[s.toLowerCase()] || null;
  }

  function summary() {
    var c = country();
    return {
      known: !!c,
      selectedCountry: STATE.selectedCountry,
      country: c,
      countryName: c ? c.name : null,
      currency: c ? c.currency : null,
      locale: localeFor(c && c.code),
      flag: c ? c.flag : "",
      region: c ? c.region : null,
      dial: c ? c.dial : null,
      language: language(),
      direction: direction(),
      currentLocation: STATE.currentLocation,
      countryOfResidence: STATE.countryOfResidence,
      destination: STATE.destination,
      source: STATE.source,
      suggestion: STATE.suggestion,
      capabilities: c ? capabilitiesOf(c.code) : null,
    };
  }

  /*
   * Choose a market. The single write point — everything country-specific in
   * the platform repaints from the event this fires, which is what makes
   * "Kenya → Sweden" a complete change of experience rather than a currency
   * label that moved while M-Pesa stayed on the screen.
   */
  function setCountry(value, how) {
    var c = lookup(value);
    if (!c) return false;
    if (STATE.selectedCountry === c.code) return true;
    STATE.selectedCountry = c.code;
    STATE.source = how || "chosen";
    STATE.suggestion = null;
    persist();
    /* The address bar is part of "everything country-specific repaints".
       Switching Kenya to Sweden and leaving /kenya in the URL would leave a
       link that reopens the market the visitor just left. */
    reflectUrl();
    emit("country");
    return true;
  }

  function setLanguage(code) {
    if (!STRINGS[code]) return false;
    STATE.language = code;
    persist();
    emit("language");
    return true;
  }

  /* The other three concepts. Each writes only itself, and none of them
     touches the market — which is the entire reason they are separate. */
  function setDestination(place) { STATE.destination = place || null; emit("destination"); }
  function setResidence(value) {
    var c = lookup(value); STATE.countryOfResidence = c ? c.code : null; persist(); emit("residence");
  }

  function clear() {
    STATE.selectedCountry = null; STATE.language = null; STATE.source = "none";
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) {}
    emit("cleared");
  }

  /*
   * Work out where we are, once, at boot.
   *
   * Order: what was chosen this session, then a high-confidence detection,
   * then nothing. "Then nothing" is the branch that matters — it leaves the
   * market unknown and lets the interface ask, instead of picking the country
   * the developer happened to live in.
   */
  function boot() {
    var det = detect();
    STATE.currentLocation = det.code;

    /*
     * A market named in the URL wins over everything, including a market
     * chosen earlier this session. Somebody opening paltas.io/sweden has
     * asked for Sweden in the most explicit way available, and honouring a
     * stale sessionStorage entry instead would make a shared link open the
     * wrong country for the person it was sent to.
     */
    var urlCountry = countryFromPath();
    if (urlCountry) {
      STATE.selectedCountry = urlCountry.code;
      STATE.source = "url";
      var priorLang = restore();
      STATE.countryOfResidence = (priorLang && priorLang.countryOfResidence) || null;
      STATE.language = (priorLang && priorLang.language) || null;
      persist();
      reflectUrl();
      emit("boot");
      return summary();
    }

    var saved = restore();
    if (saved) {
      STATE.selectedCountry = saved.selectedCountry;
      STATE.countryOfResidence = saved.countryOfResidence || null;
      STATE.language = saved.language || null;
      STATE.source = "session";
    } else if (det.confidence === "high") {
      STATE.selectedCountry = det.code;
      STATE.source = "detected";
    } else if (det.code) {
      /* Offered, not applied. */
      STATE.suggestion = det.code;
      STATE.source = "none";
    }
    /* Detected, remembered, or not known at all — the path says which. */
    reflectUrl();
    emit("boot");
    return summary();
  }

  root.PALTAS = root.PALTAS || {};
  root.PALTAS.Market = {
    /* data */
    countries: function () { return COUNTRIES.slice(); },

    /* The URL layer, exposed so the rest of the platform and the tests can
       ask the same questions this module answers internally. */
    slugFor: function (value) { var c = lookup(value); return c ? slugOf(c) : null; },
    countryFromPath: countryFromPath,
    isHomePath: isHomePath,
    pathSlugs: function () { return Object.keys(BY_SLUG).slice(); },
    neutralPath: function () { return NEUTRAL_PATH; },
    paymentCatalogue: function () { return PAYMENT_METHODS.slice(); },
    languages: function () { return LANGUAGES; },
    lookup: lookup,
    country: country,
    citiesIn: function (code) { var c = country(code); return c && c.cities ? c.cities.slice() : []; },

    /* state — the four concepts */
    get: summary,
    isKnown: function () { return !!country(); },
    setCountry: setCountry,
    setResidence: setResidence,
    setDestination: setDestination,
    destination: function () { return STATE.destination; },
    currentLocation: function () { return STATE.currentLocation; },
    countryOfResidence: function () { return STATE.countryOfResidence; },
    suggestion: function () { return STATE.suggestion ? BY_CODE[STATE.suggestion] : null; },
    clear: clear,
    detect: detect,
    boot: boot,

    /* money */
    currency: function (code) { var c = country(code); return c ? c.currency : null; },
    locale: function (code) { return localeFor(code || STATE.selectedCountry); },
    format: function (amount, currency, code) {
      var c = country(code);
      return fmtMoney(amount, currency || (c && c.currency), localeFor(c && c.code));
    },
    /* A price that is already in some currency, shown in the market's. The
       second half of the answer — whether it was converted — is returned
       rather than hidden, so the caller can label it honestly. */
    display: function (amount, fromCurrency, code) {
      var c = country(code);
      if (!c) return { text: "", currency: null, approximate: false, known: false };
      var loc = localeFor(c.code);
      if (!fromCurrency || fromCurrency === c.currency) {
        return { text: fmtMoney(amount, c.currency, loc), currency: c.currency, approximate: false, known: true };
      }
      var v = convert(amount, fromCurrency, c.currency);
      if (v === null) return { text: fmtMoney(amount, fromCurrency, loc), currency: fromCurrency, approximate: false, known: true };
      return { text: fmtMoney(v, c.currency, loc), currency: c.currency, approximate: true, known: true, from: fromCurrency };
    },
    convert: convert,

    /* payments, capabilities, promotions */
    availablePaymentMethods: availablePaymentMethods,
    capabilities: capabilitiesOf,
    can: function (what, code) {
      var caps = capabilitiesOf(code || STATE.selectedCountry);
      if (!caps) return false;
      return caps.services.indexOf(what) >= 0 || caps.features.indexOf(what) >= 0 ||
             caps.products.indexOf(what) >= 0;
    },
    promotionTargets: promotionTargets,

    /* localization */
    t: t,
    language: language,
    direction: direction,
    setLanguage: setLanguage,
    languagesFor: function (code) { var c = country(code); return c ? c.langs.slice() : ["en"]; },
    coverage: coverage,
    addLanguage: addLanguage,

    /* the seam */
    Api: Api,
    /*
     * What the boot-time catalogue refresh found. Four values, because "it
     * did not work" has more than one cause and they need different fixes:
     *
     *   null          not attempted — no base configured, i.e. local development
     *   true          the server's catalogue was fetched and is now in use
     *   "catalogue"   the backend is up (/health answered) but /market/config
     *                 did not — a routing or proxy fault, not an outage
     *   false         nothing answered; the local table is in use
     *
     * Nothing renders this. It is for whoever opens devtools.
     */
    apiReachable: function () { return apiReachable; },
    on: on, off: off,
  };

  /* Shorthand, because `PALTAS.Market.t("pay.method")` in a template string
     three times a line is how a translation layer stops being used. */
  root.PALTAS.t = t;

  boot();

})(typeof window !== "undefined" ? window : this);
