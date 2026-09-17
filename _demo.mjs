process.env.DATABASE_URL="postgresql://kaboole@localhost:5432/paltas_demo";
process.env.SESSION_SECRET="test-secret"; process.env.GOOGLE_CLIENT_ID="a.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET="b"; process.env.PUBLIC_URL="http://127.0.0.1:8080";
process.env.APP_URL="http://127.0.0.1:8899"; process.env.INSECURE_COOKIES="1";
import crypto from "node:crypto";
const {db}=await import("./src/db.js"); const {createApp}=await import("./src/server.js");

const org=await db.organization.create({data:{
  name:"Meridian Estates", country:"ke", city:"Nairobi", status:"ACTIVE",
  subscription:{create:{status:"ACTIVE"}}, verification:{create:{status:"COMPLETE"}},
  workspace:{create:{preferred:"PROPERTY_MANAGEMENT"}},
  entitlements:{create:[{product:"PROPERTY_MANAGEMENT"},{product:"SECURITY_MANAGEMENT"}]},
}});
const email="ops@meridian.example";
const user=await db.user.upsert({where:{email},create:{email,name:"Meridian Ops",googleSub:"sub_md"},update:{}});
const token=crypto.randomBytes(32).toString("base64url");
await db.session.create({data:{tokenHash:crypto.createHash("sha256").update(token).digest("hex"),
  userId:user.id,orgId:org.id,expiresAt:new Date(Date.now()+3600_000)}});
await db.membership.create({data:{userId:user.id,orgId:org.id,role:"OWNER"}});
const O={orgId:org.id};

/* ---- property ---- */
const site=await db.site.create({data:{...O,name:"Meridian Gardens",city:"Nairobi",country:"ke",unitCount:24}});
const bld =await db.building.create({data:{...O,siteId:site.id,name:"Acacia Block",city:"Nairobi",floors:8,unitCount:24}});
for (const [ref,rent,fl] of [["AC-101",95000,1],["AC-102",95000,1],["AC-204",128000,2],["AC-305",145000,3]])
  await db.unit.create({data:{...O,siteId:site.id,buildingId:bld.id,ref,buildingName:"Acacia Block",floor:fl,rent:BigInt(rent*100),currency:"KES"}});
const tenant=await db.party.create({data:{...O,name:"Njeri Wanjiku",email:"n@meridian.example",unit:"AC-101"}});
const u1=await db.unit.findFirst({where:{...O,ref:"AC-101"}});
await db.lease.create({data:{...O,unitId:u1.id,tenantId:tenant.id,ref:"LS-0001",tenantName:"Njeri Wanjiku",
  unitRef:"AC-101",rent:BigInt(9500000),currency:"KES",startsOn:new Date("2026-02-01"),endsOn:new Date("2027-01-31")}});
await db.workOrder.create({data:{...O,siteId:site.id,ref:"WO-0001",title:"Lift service overdue",place:"Acacia Block",department:"Engineering"}});
await db.project.create({data:{...O,siteId:site.id,name:"Meridian Phase 3",city:"Nairobi",units:40,currency:"KES"}});
await db.document.create({data:{...O,name:"Acacia Block insurance",about:"Compliance"}});

/* ---- security ---- */
const zone=await db.zone.create({data:{...O,siteId:site.id,name:"Main Gate",kind:"GATE"}});
await db.visit.create({data:{...O,siteId:site.id,visitor:"Daniel Otieno",hostName:"Njeri Wanjiku",
  purpose:"Delivery",status:"INSIDE",arrivedAt:new Date()}});
await db.visit.create({data:{...O,siteId:site.id,visitor:"Grace Muthoni",hostName:"AC-204",
  purpose:"Guest",status:"WAITING",arrivedAt:new Date()}});
await db.vehicle.create({data:{...O,siteId:site.id,plate:"KDA 118J",make:"Toyota Prado",colour:"Silver",ownerName:"Njeri Wanjiku"}});
await db.incident.create({data:{...O,siteId:site.id,ref:"IN-0001",title:"Perimeter light out",severity:"LOW",status:"OPEN",place:"Acacia Block"}});
await db.guardShift.create({data:{...O,siteId:site.id,guard:"Peter Kamau",post:"Main Gate",shift:"Night",
  startsAt:new Date(),endsAt:new Date(Date.now()+8*3600e3)}});
await db.patrol.create({data:{...O,siteId:site.id,route:"Night perimeter",guard:"Peter Kamau",points:12,pointsHit:0,dueAt:new Date()}});
await db.camera.create({data:{...O,siteId:site.id,name:"Gate 1 ANPR",place:"Main Gate",status:"ONLINE"}});

const app=createApp(); const srv=await new Promise(r=>{const s=app.listen(0,()=>r(s))});
console.log(JSON.stringify({port:srv.address().port, token}));
await new Promise(()=>{});
