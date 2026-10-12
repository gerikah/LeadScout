import express from 'express';
import cors from 'cors';

const app=express();app.use(cors());app.use(express.json());
const PORT=Number(process.env.PORT||3001);
const UA='LeadScoutMVP/1.0 (local-business-research-tool; contact: leadscout-demo@example.com)';
const niches={
  cafe:{label:'Cafés',conditions:['["amenity"="cafe"]']},
  restaurant:{label:'Restaurants',conditions:['["amenity"="restaurant"]','["amenity"="fast_food"]']},
  salon:{label:'Beauty salons',conditions:['["shop"="hairdresser"]','["shop"="beauty"]']},
  gym:{label:'Gyms',conditions:['["leisure"="fitness_centre"]','["leisure"="sports_centre"]']},
  dental:{label:'Dental clinics',conditions:['["amenity"="dentist"]','["healthcare"="dentist"]']},
  hotel:{label:'Hotels',conditions:['["tourism"="hotel"]','["tourism"="guest_house"]']},
  retail:{label:'Retail shops',conditions:['["shop"="clothes"]','["shop"="shoes"]','["shop"="boutique"]']},
  bakery:{label:'Bakeries',conditions:['["shop"="bakery"]']},
  realestate:{label:'Real estate agencies',conditions:['["office"="estate_agent"]']}
};
const cache=new Map();
function cached(k){const x=cache.get(k);return x&&Date.now()-x.time<30*60*1000?x.value:null}
function put(k,value){cache.set(k,{time:Date.now(),value});if(cache.size>100)cache.delete(cache.keys().next().value)}
const waitFetch=async(url,opts={},timeout=22000)=>{const controller=new AbortController();const timeoutId=setTimeout(()=>controller.abort(),timeout);try{return await fetch(url,{...opts,signal:controller.signal})}finally{clearTimeout(timeoutId)}};
function pick(tags,...keys){for(const k of keys){if(typeof tags[k]==='string'&&tags[k].trim())return tags[k].trim()}return ''}
function website(raw){if(!raw)return '';try{const x=new URL(/^https?:\/\//i.test(raw)?raw:`https://${raw}`);return ['http:','https:'].includes(x.protocol)?x.href:''}catch{return ''}}
function normalize(el){const t=el.tags||{};const name=pick(t,'name','brand','operator');if(!name)return null;const full=[pick(t,'addr:housenumber'),pick(t,'addr:street'),pick(t,'addr:city')].filter(Boolean).join(' ');const loc=el.center||el;return {id:`${el.type}/${el.id}`,name,category:pick(t,'cuisine','shop','amenity','tourism','leisure','office','healthcare')||'Business',address:full||pick(t,'addr:full')||'',phone:pick(t,'contact:phone','phone','contact:mobile'),email:pick(t,'contact:email','email'),website:website(pick(t,'contact:website','website')),lat:loc.lat??null,lon:loc.lon??null,source:`https://www.openstreetmap.org/${el.type}/${el.id}`}}
app.get('/api/health',(req,res)=>res.json({status:'ok',provider:'OpenStreetMap Overpass + Nominatim'}));
app.get('/api/niches',(req,res)=>res.json(Object.entries(niches).map(([id,v])=>({id,label:v.label}))));
app.get('/api/search',async(req,res)=>{
  const location=String(req.query.location||'').trim();const niche=String(req.query.niche||'cafe');const limit=Math.min(250,Math.max(1,Number(req.query.limit)||100));const radius=Math.min(15000,Math.max(500,Number(req.query.radius)||5000));
  if(location.length<2||location.length>120||!niches[niche])return res.status(400).json({error:'Choose a valid niche and location.'});
  const key=JSON.stringify({location:location.toLowerCase(),niche,limit,radius});const old=cached(key);if(old)return res.json({...old,cached:true});
  try{
    const geo=await waitFetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`,{headers:{'User-Agent':UA,'Accept':'application/json'}});
    if(!geo.ok)throw new Error(`Location provider unavailable (${geo.status})`);
    const matches=await geo.json();if(!matches.length)return res.status(404).json({error:'Location not found. Try “Makati, Metro Manila, Philippines” or a more specific city.'});
    const lat=Number(matches[0].lat),lon=Number(matches[0].lon);
    const clauses=niches[niche].conditions.flatMap(cond=>['node','way','relation'].map(type=>`${type}${cond}(around:${radius},${lat},${lon});`)).join('');
    const query=`[out:json][timeout:25];(${clauses});out center ${Math.min(limit*5,1000)};`;
    const response=await waitFetch('https://overpass.kumi.systems/api/interpreter',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA},body:new URLSearchParams({data:query})},35000);
    if(!response.ok)throw new Error(`Business data provider busy (${response.status}). Please retry in a minute.`);
    const result=await response.json();if(!Array.isArray(result.elements))throw new Error('Unexpected response from business data provider.');
    const seen=new Set();const leads=[];for(const el of result.elements){const item=normalize(el);if(!item)continue;const fingerprint=`${item.name.toLowerCase()}|${(item.address||`${item.lat},${item.lon}`).toLowerCase()}`;if(seen.has(fingerprint))continue;seen.add(fingerprint);leads.push(item);if(leads.length===limit)break}
    const payload={leads,location:matches[0].display_name,center:{lat,lon},niche:niches[niche].label,provider:'OpenStreetMap contributors',fetchedAt:new Date().toISOString(),notice:'Publicly contributed business details may be missing or outdated. Verify before outreach.'};put(key,payload);res.json(payload);
  }catch(e){console.error('Search error:',e.message);res.status(502).json({error:e.name==='AbortError'?'Business data provider timed out. Try a smaller radius.':e.message||'Search failed.'})}
});
app.listen(PORT,()=>console.log(`LeadScout API running on http://localhost:${PORT}`));
