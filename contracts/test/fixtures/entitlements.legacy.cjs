/* PALTAS entitlement rules: ONE implementation shared by the browser demo (inlined into platform.js) and the PALTAS
   server (backend/src/entitlements.js re-exports it). Pure functions: no storage, no clock, no network.
   Inputs:  cat = catalogue {modules:[...], plans:[...]}, org = organisation record with `ent`, today = "YYYY-MM-DD".
   Products: an organisation's first product is `type` with its subscription in `ent`; every further product is a separate
   subscription in `subs[product]` (same shape). viewOf(cat, org, product, today) gives the per-product record the other
   functions work on. Subscribing to one product never activates another. A module's `scope` decides whether a plan or
   add-on covers one product ("product", default) or the whole organisation ("organisation" — never charged twice).
   Nothing here charges money; it only answers "what is this organisation entitled to, and what would a change cost". */
(function(root,factory){var E=factory();if(typeof module==="object"&&module&&module.exports)module.exports=E;if(root)root.PaltasEntitlements=E})(typeof self!=="undefined"?self:this,function(){
  "use strict";
  // always available, never sold, never switched off
  var ESSENTIALS=[["auth","Sign-in and identity"],["access","Roles and access control"],["isolation","Organisation isolation"],["sec","Security settings"],["audit","Audit trail"]];
  // what keeps working without any optional module, so a plan never breaks a dependent workflow
  var FLOOR={property:["Properties, units and tenants","Leases","Invoices and payment status","Tenant identity and contact details","Maintenance requests"],
    developer:["Projects and units","Buyers and reservations","Sales and payment-plan status","Documents"],
    agency:["Listings","Contacts and enquiries"],hotel:["Rooms and reservations"],security:["Sites, guards and incidents"]};
  var TIER_RANK={Standard:1,Pro:2,Enterprise:3};
  var addDays=function(d,n){var t=new Date(d+"T00:00:00Z");t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10)};
  var addMonths=function(d,n){var t=new Date(d+"T00:00:00Z"),day=t.getUTCDate();t.setUTCDate(1);t.setUTCMonth(t.getUTCMonth()+n);var last=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()+1,0)).getUTCDate();t.setUTCDate(Math.min(day,last));return t.toISOString().slice(0,10)};
  var r2=function(n){return Math.round(n*100)/100};
  var productOf=function(org){var t=org&&org.type;return t==="agents"?"agency":t||"property"};
  function plan(cat,id){for(var i=0;i<cat.plans.length;i++)if(cat.plans[i].id===id)return cat.plans[i];return null}
  function mod(cat,key){for(var i=0;i<cat.modules.length;i++)if(cat.modules[i].key===key)return cat.modules[i];return null}
  function corePlan(org){return {id:"CORE",name:"Core product — no plan assigned yet",tier:null,products:[productOf(org)],modules:[],buildingsIncluded:1,extraBuilding:null,base:null,frequency:"monthly",trialDays:30,taxPct:0,taxNote:"Set when PALTAS assigns a plan",capacity:{sites:null,units:null}}}
  // a price applies only in its own currency (or a currency PALTAS has set for it); nothing is converted or invented
  function priceIn(price,ccy){if(!price)return null;if(price.byCcy&&price.byCcy[ccy]!=null)return {amount:+price.byCcy[ccy],ccy:ccy,per:price.per||"month"};
    if(price.amount==null)return null;if(!ccy||price.ccy===ccy)return {amount:+price.amount,ccy:price.ccy,per:price.per||"month"};return null}
  // pending changes (cancellation, downgrade) take effect on their date; before it the current entitlement stands
  function effectivePlanId(org,today){var e=org.ent,id=e.plan;(e.pending||[]).forEach(function(p){if(p.type==="plan"&&p.effective<=today)id=p.plan});return id}
  function cancelledAddons(org,today){return (org.ent.pending||[]).filter(function(p){return p.type==="cancelAddon"&&p.effective<=today}).map(function(p){return p.key})}
  function nextBilling(org,today){var e=org.ent;if(e.status==="trial"&&e.trialEnds)return e.trialEnds;var a=e.anchor;if(!a)return null;var n=a;var guard=0;while(n<=today&&guard++<600)n=addMonths(a,guard);return n}

  var PRODUCT_NAME={property:"Property Management",agents:"Agent & Host",agency:"Agent & Host",developer:"Real Estate Development",hotel:"Hotel",security:"Security Services"};
  function productsOf(org){var a=org&&org.type?[org.type]:[];Object.keys((org&&org.subs)||{}).forEach(function(k){if(org.subs[k]&&a.indexOf(k)<0)a.push(k)});return a}
  function subOf(org,product){if(!org)return null;if(!product||product===org.type)return org.ent||null;return ((org.subs||{})[product])||null}
  // the record for one product subscription; organisation-wide modules held through another product are passed in `shared`
  function viewOf(cat,org,product,today){var p=product||org.type,s=subOf(org,p);if(!s)return null;var all=productsOf(org),me=all.indexOf(p),shared={};
    all.forEach(function(q,qi){if(q===p)return;var o2={id:org.id,name:org.name,type:q,currency:org.currency,demo:org.demo,ent:subOf(org,q)};var r=resolve(cat,o2,today);if(!r.usable)return;
      cat.modules.forEach(function(m){var st=r.moduleState[m.key];if(m.scope!=="organisation"||!st||!st.on||shared[m.key])return;
        // a plan module is shared both ways; an add-on bought for an earlier product is paid there and shared to later ones
        if(st.source==="plan"||(st.source==="addon"&&qi<me))shared[m.key]=PRODUCT_NAME[q]||q})});
    return {id:org.id,name:org.name,type:p,currency:org.currency,demo:!!org.demo,ent:s,shared:shared,products:all}}
  function resolve(cat,org,today){if(!org)return null;var e=org.ent||{};e.addons=e.addons||[];e.disabled=e.disabled||[];e.buildings=e.buildings||{extra:0,override:null};
    var pl=plan(cat,effectivePlanId(org,today))||corePlan(org),prod=productOf(org);
    var trialOver=e.status==="trial"&&e.trialEnds&&e.trialEnds<today,ended=(e.pending||[]).some(function(p){return p.type==="cancel"&&p.effective<=today}),status=ended?"cancelled":trialOver?"expired":e.status||"trial";
    var gone=cancelledAddons(org,today),pend=e.pending||[];
    var on={},state={};
    var shared=org.shared||{};
    cat.modules.forEach(function(m){var inPlan=pl.modules.indexOf(m.key)>=0,addon=e.addons.indexOf(m.key)>=0&&gone.indexOf(m.key)<0,offered=(m.products||[]).indexOf(prod)>=0||(pl.products||[]).some(function(p){return (m.products||[]).indexOf(p)>=0});
      var viaOrg=!inPlan&&m.scope==="organisation"&&!!shared[m.key]&&offered;
      var v=(inPlan||addon||viaOrg)&&e.disabled.indexOf(m.key)<0&&m.available!==false;
      var cancelOn=(pend.filter(function(p){return p.type==="cancelAddon"&&p.key===m.key&&p.effective>today})[0]||{}).effective||null;
      on[m.key]=v;state[m.key]={on:v,source:inPlan?"plan":viaOrg?"organisation":addon?"addon":null,sharedFrom:viaOrg?shared[m.key]:null,scope:m.scope||"product",offered:offered,available:m.available!==false,cancelsOn:cancelOn,why:""}});
    // a module without its dependency is unavailable (records kept)
    cat.modules.forEach(function(m){if(on[m.key]&&(m.dep||[]).some(function(d){return !on[d]})){on[m.key]=false;state[m.key].on=false;state[m.key].why="Needs "+(m.dep||[]).map(function(d){return (mod(cat,d)||{name:d}).name}).join(", ")}});
    cat.modules.forEach(function(m){var s=state[m.key];if(s.on||s.why)return;s.why=!s.offered?"Not offered for this product":!s.available?"Not available yet":e.disabled.indexOf(m.key)>=0?"Switched off by PALTAS":"Not in your plan"});
    var included=e.buildings.override!=null?e.buildings.override:pl.buildingsIncluded,allowed=included+(e.buildings.extra||0),used=(e.usage||{}).buildings||0;
    var family=cat.plans.filter(function(x){return (x.products||[])[0]===(pl.products||[])[0]&&x.tier}).sort(function(a,b){return (TIER_RANK[a.tier]||0)-(TIER_RANK[b.tier]||0)});
    var rank=TIER_RANK[pl.tier]||0;
    return {org:org.id,name:org.name,demo:!!org.demo,product:prod,productKey:org.type,productName:PRODUCT_NAME[org.type]||org.type,orgProducts:org.products||[org.type],status:status,usable:status==="active"||status==="trial",readOnly:!(status==="active"||status==="trial"),
      plan:pl,planId:pl.id,tier:pl.tier||null,trialEnds:e.trialEnds||null,products:pl.products,modules:on,moduleState:state,
      essentials:ESSENTIALS.map(function(x){return x[1]}),floor:FLOOR[prod]||[],
      buildings:{included:included,extra:e.buildings.extra||0,allowed:allowed,used:used,left:Math.max(0,allowed-used),over:used>allowed},
      extraBuilding:pl.extraBuilding,frequency:pl.frequency,taxPct:pl.taxPct,taxNote:pl.taxNote,terms:e.terms||{discountPct:0,note:""},billing:e.billing||{status:""},
      nextBilling:nextBilling(org,today),pending:pend.filter(function(p){return p.effective>today}),
      upgrades:family.filter(function(x){return (TIER_RANK[x.tier]||0)>rank}).map(function(x){return {id:x.id,tier:x.tier,name:x.name,contactSales:x.tier==="Enterprise"||!x.base}}),
      downgrades:family.filter(function(x){return (TIER_RANK[x.tier]||0)<rank&&rank<3}).map(function(x){return {id:x.id,tier:x.tier,name:x.name}})}}

  // the monthly charge for an organisation: plan base + paid add-ons (never a module already in the plan) + extra buildings
  function charges(cat,org,today,ccy){var en=resolve(cat,org,today),pl=en.plan,c=ccy||org.currency,lines=[],missing=[];
    var base=priceIn(pl.base,c);if(pl.base&&pl.base.amount!=null&&!base)missing.push(pl.name);if(base)lines.push({kind:"plan",what:pl.name,amount:base.amount});
    (org.ent.addons||[]).forEach(function(k){var s=en.moduleState[k];if(!s||s.source!=="addon"||!s.on)return;var m=mod(cat,k),p=priceIn(m&&m.price,c);if(!p){missing.push(m?m.name:k);return}lines.push({kind:"addon",key:k,what:m.name,amount:p.amount})});
    var xb=priceIn(pl.extraBuilding,c);if(en.buildings.extra>0){if(xb)lines.push({kind:"buildings",what:"Additional buildings × "+en.buildings.extra,amount:xb.amount*en.buildings.extra});else missing.push("Additional buildings")}
    var gross=lines.reduce(function(a,l){return a+l.amount},0),disc=r2(gross*((en.terms.discountPct||0)/100)),net=r2(gross-disc),tax=r2(net*((pl.taxPct||0)/100));
    return {ccy:c,lines:lines,gross:r2(gross),discount:disc,net:net,taxPct:pl.taxPct||0,taxNote:pl.taxNote||"",tax:tax,total:r2(net+tax),missing:missing,priced:!missing.length&&lines.length>0}}

  // can this organisation buy this module? (never twice, never one its product cannot use, never without its dependency)
  function canBuy(cat,org,key,today){var en=resolve(cat,org,today),m=mod(cat,key);if(!m)return {ok:false,why:"Unknown module"};var s=en.moduleState[key];
    if(!en.usable)return {ok:false,why:"Your subscription is "+en.status+" — renew or choose a plan first"};
    if(s.source==="plan")return {ok:false,included:true,why:m.name+" is already included in your plan — there is nothing to buy"};
    if(s.source==="organisation")return {ok:false,included:true,why:m.name+" already covers your whole organisation through your "+s.sharedFrom+" subscription — there is nothing to buy"};
    if(s.source==="addon"&&!s.cancelsOn)return {ok:false,owned:true,why:m.name+" is already active on your subscription"};
    if(!s.offered)return {ok:false,why:m.name+" is not offered for "+en.product+" workspaces"};
    if(m.available===false)return {ok:false,why:m.name+" is not available yet"};
    var clash=(m.excludes||[]).filter(function(x){return en.modules[x]});if(clash.length)return {ok:false,why:m.name+" cannot be combined with "+clash.map(function(x){return (mod(cat,x)||{name:x}).name}).join(", ")};
    var need=(m.dep||[]).filter(function(d){return !en.modules[d]});if(need.length)return {ok:false,needs:need,why:m.name+" needs "+need.map(function(d){return (mod(cat,d)||{name:d}).name}).join(", ")+" first"};
    if(en.tier==="Enterprise")return {ok:false,contactSales:true,why:"Enterprise packages are agreed with PALTAS — ask your account manager"};
    var p=priceIn(m.price,org.currency);if(!p)return {ok:false,contactSales:true,why:"PALTAS has not set a price for "+m.name+" in "+org.currency+" yet — ask PALTAS for a quote"};
    var disc=r2(p.amount*((en.terms.discountPct||0)/100)),net=r2(p.amount-disc),tax=r2(net*((en.plan.taxPct||0)/100));
    return {ok:true,module:m,price:p,discount:disc,net:net,tax:tax,total:r2(net+tax),taxNote:en.plan.taxNote,from:today,nextBilling:en.nextBilling}}

  // plan change: upgrades now, downgrades at the next billing date, never below the buildings in use, Enterprise via PALTAS
  function canChangePlan(cat,org,planId,today){var en=resolve(cat,org,today),to=plan(cat,planId);if(!to)return {ok:false,why:"Unknown plan"};
    var renew=to.id===en.planId&&(en.status==="expired"||en.status==="cancelled");if(to.id===en.planId&&!renew)return {ok:false,why:"You are already on "+to.name};
    if((to.products||[])[0]!==(en.plan.products||[])[0]&&en.planId!=="CORE")return {ok:false,why:to.name+" is for a different product"};
    if(to.tier==="Enterprise"||!to.base)return {ok:false,contactSales:true,why:"Enterprise is agreed with PALTAS — send a request and an account manager will contact you"};
    var up=renew||(TIER_RANK[to.tier]||0)>(TIER_RANK[en.tier]||0)||en.planId==="CORE"||!en.usable;
    var allow=(to.buildingsIncluded||0)+(en.buildings.extra||0);if(!up&&en.buildings.used>allow)return {ok:false,why:"You use "+en.buildings.used+" buildings; "+to.name+" allows "+allow+". Keep your extra buildings or stay on your plan."};
    var lost=en.plan.modules.filter(function(k){return to.modules.indexOf(k)<0&&(org.ent.addons||[]).indexOf(k)<0}).map(function(k){return (mod(cat,k)||{name:k}).name});
    var p=priceIn(to.base,org.currency);if(!p)return {ok:false,contactSales:true,why:"PALTAS has not set a price for "+to.name+" in "+org.currency+" yet"};
    var effective=up?today:(en.nextBilling||today);
    var dup=(org.ent.addons||[]).filter(function(k){return to.modules.indexOf(k)>=0}).map(function(k){return (mod(cat,k)||{name:k}).name});
    return {ok:true,upgrade:up,renew:renew,plan:to,price:p,effective:effective,readOnlyAfter:lost,addonsBecomeIncluded:dup}}

  // catalogue validation used by Super Admin before a plan or module is saved
  function validatePlan(cat,pl){var errs=[];if(!pl||String(pl.name||"").trim().length<3)errs.push("Name the plan");var prods=pl.products||[];if(!prods.length)errs.push("Pick the product this plan is for");
    (pl.modules||[]).forEach(function(k){var m=mod(cat,k);if(!m){errs.push("Unknown module "+k);return}
      if(!prods.some(function(p){return (m.products||[]).indexOf(p)>=0}))errs.push(m.name+" is not offered for "+prods.join(", "));
      (m.dep||[]).forEach(function(d){if((pl.modules||[]).indexOf(d)<0)errs.push(m.name+" needs "+((mod(cat,d)||{name:d}).name)+" in the same plan")});
      (m.excludes||[]).forEach(function(x){if((pl.modules||[]).indexOf(x)>=0)errs.push(m.name+" cannot be sold with "+((mod(cat,x)||{name:x}).name))})});
    if(!(pl.buildingsIncluded>=0))errs.push("Included buildings must be 0 or more");
    if(pl.base&&pl.base.amount!=null&&!(+pl.base.amount>0))errs.push("Base price must be above zero, or leave it for PALTAS to agree (Enterprise)");
    if(pl.taxPct!=null&&!(pl.taxPct>=0&&pl.taxPct<=100))errs.push("Tax 0–100%");
    if(["monthly","quarterly","yearly"].indexOf(pl.frequency||"monthly")<0)errs.push("Billing period must be monthly, quarterly or yearly");
    if(pl.trialDays!=null&&!(pl.trialDays>=0&&pl.trialDays<=90))errs.push("Trial 0–90 days");
    return errs}
  function validateModule(cat,key,m){var errs=[];if((m.dep||[]).indexOf(key)>=0)errs.push("A module cannot depend on itself");if((m.excludes||[]).indexOf(key)>=0)errs.push("A module cannot exclude itself");
    (m.dep||[]).forEach(function(d){if((m.excludes||[]).indexOf(d)>=0)errs.push("A module cannot both need and exclude "+d)});
    if(m.price&&m.price.amount!=null&&!(+m.price.amount>0))errs.push("Price must be above zero, or unset");
    if(m.scope!=null&&["product","organisation"].indexOf(m.scope)<0)errs.push("Scope must be per product or organisation-wide");
    // a module already sold inside a plan can still be bought separately only by organisations whose plan lacks it (checked at purchase)
    return errs}
  return {v:1,ESSENTIALS:ESSENTIALS,FLOOR:FLOOR,TIER_RANK:TIER_RANK,addDays:addDays,addMonths:addMonths,priceIn:priceIn,resolve:resolve,charges:charges,canBuy:canBuy,canChangePlan:canChangePlan,validatePlan:validatePlan,validateModule:validateModule,nextBilling:nextBilling,productOf:productOf,productsOf:productsOf,subOf:subOf,viewOf:viewOf,PRODUCT_NAME:PRODUCT_NAME}
});
