// Universal additive layout generator. Dry-run by default; never deletes or reassigns existing units.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {generateLayout} from './lib/property-layout.mjs';
const option=name=>process.argv.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3);
const planPath=option('plan');if(!planPath)throw Error('Provide --plan=/path/to/layout.json. See docs/property-unit-layout.md');
const origin=process.env.PALTAS_API_ORIGIN;
if(!['https://paltas-api-staging.onrender.com','https://paltas-api-v2.onrender.com'].includes(origin))throw Error('Set PALTAS_API_ORIGIN explicitly to the PALTAS staging or production API');
const token=process.env.PALTAS_OPERATOR_TOKEN;if(!token)throw Error('Set PALTAS_OPERATOR_TOKEN to an authorised company session token; never put it in the plan or command arguments');
const plan=JSON.parse(readFileSync(planPath,'utf8'));assert(typeof plan.orgId==='string'&&typeof plan.propertyId==='string');assert(Array.isArray(plan.blocks)&&plan.blocks.length);
const path=`/api/v1/orgs/${encodeURIComponent(plan.orgId)}/property/properties/${encodeURIComponent(plan.propertyId)}`;
const api=async(method,path,body)=>{const r=await fetch(origin+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await r.json();if(!r.ok)throw Error(`PALTAS refused the request (${r.status}); no further changes were attempted`);return value};
const existing=await api('GET',path);const blockIds=new Set(existing.property.buildings.map(b=>b.id));
const units=plan.blocks.flatMap(block=>{if(block.buildingId&&!blockIds.has(block.buildingId))throw Error('A block is not part of the selected property');return generateLayout(block)});
if(units.length>500)throw Error('Limit the plan to 500 units per transaction');
for(const unit of units)if(existing.units.some(u=>(u.buildingId||'')===(unit.buildingId||'')&&u.floor!=null&&u.floor!==''&&Number(u.floor)===Number(unit.floor)))throw Error('A selected floor already has units in this block. Correct existing records rather than generating duplicates.');
const names=new Set(existing.units.map(u=>u.unitNo.toUpperCase()));for(const unit of units){const name=unit.unitNo.toUpperCase();if(names.has(name))throw Error('A generated name already exists or repeats. Existing units were kept.');names.add(name)}
const fingerprint=createHash('sha256').update(JSON.stringify({origin,orgId:plan.orgId,propertyId:plan.propertyId,units})).digest('hex');
console.log(JSON.stringify({mode:process.argv.includes('--apply')?'apply':'dry-run',origin,propertyId:plan.propertyId,existingUnits:existing.units.length,newUnits:units.length,confirmation:fingerprint}));
if(process.argv.includes('--apply')){if(option('confirm')!==fingerprint)throw Error('Run dry-run first, then pass its exact --confirm fingerprint');const result=await api('POST',path+'/units',{units});assert.equal(result.units.length,units.length);console.log(`Saved ${result.units.length} units. Existing records were not changed.`)}
