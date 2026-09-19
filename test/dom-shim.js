/* ====================================================================== *
 * A DOM SMALL ENOUGH TO READ, BIG ENOUGH TO LOAD A PAGE'S SCRIPTS.
 *
 * Not a browser. It cannot lay out, paint, or tell you a button is the wrong
 * colour. What it CAN do is run every line of top-level code in the
 * frontend's script tags, in the order the page loads them, and report
 * anything that throws — which is the one class of failure that blanks a
 * page and that no amount of backend testing can catch.
 *
 * Hand-written rather than jsdom because the frontend has no package.json
 * and no bundler, and adding a dependency to test a dependency-free thing
 * is a poor trade. This is ~120 lines and every stub in it is visible.
 *
 * TWO DELIBERATE CHOICES:
 *
 *   getElementById returns a NODE, not null. A real page has these elements.
 *   Returning null makes `getElementById(x).addEventListener(…)` throw on a
 *   page that works perfectly, which is a false finding — and false findings
 *   are how a test gets ignored.
 *
 *   fetch REJECTS, and every call is recorded. Nothing in a test should
 *   reach the network, and a page that calls out at load time is something
 *   worth knowing about either way.
 * ====================================================================== */

import vm from "node:vm";
import { readFileSync } from "node:fs";

export function makeWindow({ href = "https://paltas.io/" } = {}) {
  const calls = { fetch: [], warn: [], error: [] };

  const node = (tag = "div") => {
    const el = {
      tagName: String(tag).toUpperCase(), nodeType: 1,
      children: [], childNodes: [], attributes: {}, style: {}, dataset: {},
      classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
      innerHTML: "", textContent: "", value: "", checked: false,
      appendChild(c){ this.children.push(c); this.childNodes.push(c); return c; },
      removeChild(c){ const i=this.children.indexOf(c); if(i>=0){this.children.splice(i,1);} return c; },
      insertBefore(c){ return this.appendChild(c); },
      setAttribute(k,v){ this.attributes[k]=v; }, getAttribute(k){ return this.attributes[k] ?? null; },
      removeAttribute(k){ delete this.attributes[k]; },
      hasAttribute(k){ return k in this.attributes; },
      addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
      /* An ELEMENT's querySelector answers like the document's, for the same
         reason: returning null makes `el.querySelector(x).addEventListener(…)`
         throw on a page that works. The two were inconsistent, and the
         inconsistency read as a page bug. */
      querySelector(){ return (this.__q ||= node("div")); },
      querySelectorAll(){ return []; },
      closest(){ return null; }, contains(){ return false; }, focus(){}, blur(){}, click(){},
      scrollIntoView(){}, getBoundingClientRect: () => ({top:0,left:0,width:0,height:0,bottom:0,right:0}),
      /* A real element can be scrolled. A carousel calls these on its rail, and
         without them the page throws where a browser would not. */
      scrollTo(){}, scrollBy(){}, animate: () => ({ cancel(){}, finished: Promise.resolve() }),
      get scrollWidth(){ return 0; }, get clientWidth(){ return 0; },
      get offsetWidth(){ return 0; }, get offsetHeight(){ return 0; },
      /*
       * A real element can have markup put beside or inside it, and pages do
       * it constantly — paintShell() prepends a switcher to its own bar. The
       * shim had appendChild and not this, so a page that works in a browser
       * threw here and the failure read as a product bug.
       *
       * There is no HTML parser in this file by design (see the header), so
       * the markup is kept as text at the right end rather than parsed into
       * nodes. That is enough for what these tests ask: did the page run, and
       * what did it produce.
       */
      insertAdjacentHTML(where, html){
        const w = String(where || "").toLowerCase();
        if (w === "afterbegin") this.innerHTML = String(html) + this.innerHTML;
        else if (w === "beforeend") this.innerHTML = this.innerHTML + String(html);
        else if (w === "beforebegin" || w === "afterend") { /* a sibling; nothing reads it */ }
        return undefined;
      },
      insertAdjacentElement(where, el){ this.appendChild(el); return el; },
      remove(){}, cloneNode(){ return node(tag); },
    };
    return el;
  };

  const byId = {}, bySel = {};
  const asked = { ids: new Set(), sel: new Set() };

  const document = {
    nodeType: 9, readyState: "loading", title: "", cookie: "",
    documentElement: node("html"), head: node("head"), body: node("body"),
    createElement: node, createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    createDocumentFragment: () => node("fragment"),
    /* A real page HAS these elements. Returning null makes every
       `getElementById(x).addEventListener` crash on a page that works, which
       is a false finding — so hand back a node and remember which ids were
       asked for. Same element each time, so identity comparisons hold. */
    getElementById(id) { asked.ids.add(id); return (byId[id] ||= node("div")); },
    querySelector(sel) { asked.sel.add(sel); return (bySel[sel] ||= node("div")); },
    getElementsByTagName: () => [], getElementsByClassName: () => [],
    querySelectorAll: () => [],
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  };

  const storage = () => { const m = new Map(); return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k,v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k), clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null, get length(){ return m.size; },
  }; };

  const url = new URL(href);
  const win = {
    document, navigator: { userAgent: "node-smoke", language: "en-GB", languages: ["en-GB"], onLine: true },
    /*
     * `search` and `hash` come FROM THE URL, not hard-coded to "".
     *
     * They were empty strings, so any page that reads a query parameter was
     * untestable: a sign-in page checking ?signin=cancelled saw nothing and the
     * test passed while the page would have shown no message at all. Parsed
     * from the href, like a browser does.
     */
    location: { href, origin: url.origin, protocol: url.protocol, host: url.host,
                hostname: url.hostname, pathname: url.pathname,
                search: url.search, hash: url.hash,
                assign(){}, replace(){}, reload(){} },
    localStorage: storage(), sessionStorage: storage(),
    history: { pushState(){}, replaceState(){}, back(){}, forward(){}, go(){} },
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
    matchMedia: () => ({ matches: false, addListener(){}, removeListener(){},
                         addEventListener(){}, removeEventListener(){} }),
    CustomEvent: class { constructor(t,o){ this.type=t; Object.assign(this,o||{}); } },
    Event: class { constructor(t){ this.type=t; } },
    requestAnimationFrame: (f) => { const t = setTimeout(f, 0); t.unref?.(); return t; },
    cancelAnimationFrame: clearTimeout,
    /*
     * TIMERS THAT DO NOT HOLD THE PROCESS OPEN.
     *
     * A page with a carousel calls setInterval, and Node keeps running until
     * every timer is cleared — so loading index.html hung forever instead of
     * finishing. unref() lets the callback still fire while the process is
     * free to exit, which is what a test needs and what a browser tab does
     * anyway when it is closed.
     */
    setTimeout: (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t.unref?.(); return t; },
    setInterval: (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); t.unref?.(); return t; },
    clearTimeout, clearInterval, queueMicrotask,
    alert(){}, confirm: () => true, prompt: () => null, scrollTo(){}, getComputedStyle: () => ({}),
    /* Nothing may reach the network. A load-time fetch is itself a finding. */
    fetch: (u, o) => { calls.fetch.push(String(u)); return Promise.reject(new Error("network disabled in smoke test")); },
    URL, URLSearchParams, FormData: class {}, Headers: class {}, Request: class {}, Response: class {},
    AbortController, AbortSignal, TextEncoder, TextDecoder, btoa, atob,
    /* Pages preload photographs with `new Image()`. Without it the very first
       inline script throws and nothing after it runs — which looked like a page
       bug and was a hole in this shim. */
    Image: class { constructor(){ this.onload=null; this.onerror=null; }
                   set src(v){ this._src=v; } get src(){ return this._src; } },
    IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
    ResizeObserver: class { observe(){} unobserve(){} disconnect(){} },
    MutationObserver: class { observe(){} disconnect(){} takeRecords(){ return []; } },
    crypto: { getRandomValues: (a) => a, randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    Intl, JSON, Math, Date, Promise, Array, Object, String, Number, Boolean, RegExp, Error, Map, Set,
    WeakMap, WeakSet, Symbol, BigInt, Proxy, Reflect, isNaN, isFinite, parseInt, parseFloat, escape, unescape,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  };
  win.window = win; win.self = win; win.globalThis = win; win.top = win; win.parent = win;
  win.console = { log(){}, info(){}, debug(){}, table(){}, group(){}, groupEnd(){}, trace(){},
                  warn: (...a) => calls.warn.push(a.map(String).join(" ")),
                  error: (...a) => calls.error.push(a.map(String).join(" ")) };
  document.defaultView = win;

  const ctx = vm.createContext(win);
  return {
    win, calls, asked,
    /* One context per window, so each script sees what the ones before it
       defined — which is exactly how a page loads them. */
    loadCode(code, filename) {
      new vm.Script(code, { filename }).runInContext(ctx, { timeout: 30000 });
    },
    load(path) {
      this.loadCode(readFileSync(path, "utf8"), path);
    },
  };
}
