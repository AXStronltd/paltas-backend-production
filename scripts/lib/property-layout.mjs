export function blockCode(name){const words=String(name||'').trim().split(/\s+/);return (/^(block|wing|tower)$/i.test(words[0])&&words[1]?words[1]:words[0]||'').slice(0,1).toUpperCase()}
export function generateLayout({buildingId,initial='',floors,common={}}){
  if(!Array.isArray(floors)||!floors.length)throw Error('Add at least one floor.');
  const code=String(initial).trim().toUpperCase();if(code&&!/^[A-Z0-9]{1,5}$/.test(code))throw Error('Use up to five letters or numbers for the block code.');
  const seen=new Set(),units=[];for(const row of floors){const f=Number(row.floor),doors=Number(row.doors);if(!Number.isInteger(f)||f<0||f>300||seen.has(f))throw Error('Each floor must have a unique number between 0 and 300.');if(!Number.isInteger(doors)||doors<1||doors>99)throw Error('Choose between 1 and 99 apartments for each floor.');seen.add(f);for(let door=1;door<=doors;door++)units.push({...common,unitNo:String(f).padStart(2,'0')+String(door).padStart(2,'0')+(code?' '+code:''),floor:String(f),...(buildingId?{buildingId}:{})})}
  if(units.length>500)throw Error('Generate up to 500 units at a time. Choose a smaller floor range.');return units;
}
export function blockFloors(property,units,buildingId){const block=(property.buildings||[]).find(b=>b.id===buildingId),selected=units.filter(u=>(u.buildingId||'')===buildingId),byFloor=new Map();for(const u of selected){const floor=u.floor==null||u.floor===''?'Unassigned':String(u.floor);if(!byFloor.has(floor))byFloor.set(floor,[]);byFloor.get(floor).push(u)}
  const count=Number(block?.floors);if(Number.isInteger(count)&&count>0&&count<=300)for(let f=1;f<=count;f++)if(!byFloor.has(String(f)))byFloor.set(String(f),[]);
  return [...byFloor].sort(([a],[b])=>a==='Unassigned'?1:b==='Unassigned'?-1:b.localeCompare(a,undefined,{numeric:true})).map(([floor,units])=>({floor,units:units.sort((a,b)=>a.unitNo.localeCompare(b.unitNo,undefined,{numeric:true}))}));
}
