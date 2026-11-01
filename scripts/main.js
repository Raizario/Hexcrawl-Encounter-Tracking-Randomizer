const ID='xendrik-hexcrawl';
const defaults=()=>({active:false,paused:false,party:[],token:null,scene:null,hexes:0,timeHexes:0,days:0,dayLog:[],checks:[],pending:null,condition:null,successThreshold:4,failureThreshold:2,dc:15,encounterDie:3,hexesPerDay:1,frequency:'hex',exhaustionTiming:'end',curseDirection:'single',curseTime:'chance',exhaustionApplied:{},startTime:Date.now()});
const CONDITIONS=[['Favorable Weather',-1,0],['Clear Skies',0,0],['Calm Passage',-1,0],['Heavy Rainfall',-1,2],['Dense Jungle',1,2],['Ominous Signs',1,0],['Unstable Terrain',0,2],['Arcane Disturbance',1,-2],['Manifest Zone',0,0], ["Traveler’s Curse",0,0]];
let busy=false;
const gm=()=>game.user.isGM;
const library=()=>foundry.utils.deepClone(game.settings.get(ID,'journeys'));
const activeId=()=>game.settings.get(ID,'activeJourneyId');
const current=()=>library().items.find(j=>j.id===activeId())??null;
const state=()=>current()?.data??defaults();
async function save(s){
  const id=activeId(); if(!id) throw Error('Open a journey from the Journeys tab first.');
  const db=library(), item=db.items.find(j=>j.id===id);
  if(!item) throw Error('Journey not found');
  item.data=foundry.utils.deepClone(s);
  await game.settings.set(ID,'journeys',db);
  Hooks.callAll('xendrikJourneysChanged');
}
async function createJourney(name,folder=''){
  if(!gm()) return;
  const db=library(), j={id:foundry.utils.randomID(),name:name.trim()||'New Journey',folder,data:defaults()};
  db.items.push(j); await game.settings.set(ID,'journeys',db);
  await game.settings.set(ID,'activeJourneyId',j.id);
  Hooks.callAll('xendrikJourneysChanged'); return j;
}
async function openJourney(id){
  if(!library().items.some(j=>j.id===id)) return;
  await game.settings.set(ID,'activeJourneyId',id);
  manager?.render(true);
}

function eligible(s){let checks=s.checks.filter(c=>!c.undone);let round=Math.floor(checks.length/Math.max(1,s.party.length));let used=new Set(checks.slice(round*s.party.length).map(c=>c.actor));return s.party.filter(id=>!used.has(id));}
function usedSkills(s){return new Set(s.checks.filter(c=>!c.undone).map(c=>c.skill));}
function score(s){let cs=s.checks.filter(c=>!c.undone);return {success:cs.filter(c=>c.success).length,failure:cs.filter(c=>!c.success).length};}
function penalties(s){let a=score(s);return Math.max(0,Math.floor(a.failure/s.failureThreshold)-Math.floor(a.success/s.successThreshold));}
async function chat(content,whisper=false){return ChatMessage.create({content,speaker:{alias:'Journey Guide'},...(whisper?{whisper:ChatMessage.getWhisperRecipients('GM').map(u=>u.id)}:{})});}
const escape=v=>foundry.utils.escapeHTML(String(v??''));
function skillOptions(actor){let data=actor?.system?.skills??{};return Object.entries(data).map(([id,v])=>({id,label:game.dnd5e?.config?.skills?.[id]?.label??CONFIG.DND5E?.skills?.[id]?.label??v.label??id,ability:v.ability??CONFIG.DND5E?.skills?.[id]?.ability??''}));}
async function updateExhaustion(s){if(s.exhaustionTiming!=='immediate')return;await applyExhaustion(s,penalties(s));}
async function applyExhaustion(s,target){for(let id of s.party){let actor=game.actors.get(id);if(!actor)continue;let prior=s.exhaustionApplied[id]??0;let current=Number(actor.system?.attributes?.exhaustion??0);let next=Math.max(0,Math.min(10,current+target-prior));if(next!==current)await actor.update({'system.attributes.exhaustion':next});s.exhaustionApplied[id]=target;if(next>=10)await chat(`☠️ ${escape(actor.name)} has reached exhaustion level 10 and dies.`);}}
function stepHexes(a,b,scene){const grid=scene.grid;if(!grid||grid.type<2)return 0;let size=grid.size||100;let dx=(b.x-a.x)/size,dy=(b.y-a.y)/size;return Math.max(0,Math.round(Math.hypot(dx,dy)));}
async function condition(s){let n=await (new Roll('1d10')).evaluate();let idx=n.total-1;let [name,mod,dc]=CONDITIONS[idx];s.condition={name,mod,dc,roll:n.total};await chat(`🌿 <b>Travel condition:</b> ${escape(name)} (encounter modifier ${mod>=0?'+':''}${mod}; tracking DC ${s.dc+dc}).`);if(idx===9)await curse(s);else if(idx===8){s.pending={type:'special',name:'Manifest Zone'};s.paused=true;await chat('🌀 <b>Manifest Zone!</b> GM: resolve the special event in the Journey Manager.');} }
async function curse(s){let d=(await new Roll('1d6')).evaluate().then(r=>r.total);let steps=d<=3?1:d<=5?2:3;let counted=0;for(let i=0;i<steps;i++)if(s.curseTime==='always'||(s.curseTime==='chance'&&(await new Roll('1d2')).evaluate()).total===2)counted++;s.timeHexes+=counted;let previous=s.days;s.days=Math.floor(s.timeHexes/s.hexesPerDay);await logDays(s,previous,"Traveler's Curse");await chat(`🧭 <b>Traveler's Curse:</b> ${steps} forced hex(es), ${counted} time-counted hex(es). Direction mode: ${escape(s.curseDirection)}. Move the token manually; curse movement is not rolled again.`);}
async function encounter(s){let die=s.encounterDie;let roll=(await new Roll(`1d${die}`)).evaluate();let mod=s.condition?.mod??0;let hit=roll.total+mod>=die;if(hit){s.paused=true;s.pending={type:'encounter',roll:roll.total,mod,dc:s.dc+(s.condition?.dc??0)};await chat(`⚠️ <b>Encounter triggered!</b> Tracking DC ${s.pending.dc}. GM: open Journey Manager to resolve.`,true);}else await chat(`Travel encounter check: ${roll.total}${mod>=0?'+':''}${mod} vs ${die}; no encounter.`,true);}
async function logDays(s,previous,reason){s.dayLog??=[];for(let day=previous+1;day<=s.days;day++){let entry={day,reason,hexes:s.hexes,timeHexes:s.timeHexes,at:Date.now()};s.dayLog.push(entry);await chat(`📅 <b>Journey Day ${day}</b> — ${escape(reason)}. ${s.hexes} traveled hex(es); ${s.timeHexes} time-counted hex(es).`);}}
async function travel(s,hexes){for(let i=0;i<hexes;i++){if(s.paused||!s.active)break;s.hexes++;s.timeHexes++;let before=s.days;s.days=Math.floor(s.timeHexes/s.hexesPerDay);await logDays(s,before,'Normal travel');if(s.frequency==='hex'||s.days>before){await condition(s);if(!s.paused)await encounter(s);}}await save(s);}
async function move(doc,change){if(!gm()||busy||!current())return;let s=state();if(!s.active||s.paused||doc.id!==s.token||doc.parent?.id!==s.scene||(!('x'in change)&&!('y'in change)))return;let before={x:doc.x,y:doc.y},after={x:change.x??doc.x,y:change.y??doc.y};let count=stepHexes(before,after,doc.parent);if(!count)return;busy=true;try{await travel(s,count);}finally{busy=false;}}
async function resolveCheck(actorId,skill,roll,success){let s=state();if(!s.active||!s.pending)throw Error('No active pending encounter');let actor=game.actors.get(actorId);if(!s.party.includes(actorId)||!actor)throw Error('Actor not participating');let avail=eligible(s);if(!avail.includes(actorId))throw Error('This character already checked this rotation');let options=skillOptions(actor);if(!options.some(x=>x.id===skill))throw Error('Skill not found on actor');if(usedSkills(s).has(skill))throw Error('Oops, that skill has already been used. Please try again.');let c={id:foundry.utils.randomID(),actor:actorId,skill,roll:Number(roll),success:!!success,undone:false};s.checks.push(c);let label=options.find(x=>x.id===skill)?.label??skill;await chat(`📜 <b>Tracking check:</b> ${escape(actor.name)} — ${escape(label)} (${escape(skill)}), result ${escape(roll)}. <b>${success?'Narrative / Success':'Hostile / Failure'}</b>. Skill locked for this journey. Check ID: ${c.id}`);s.pending=null;s.paused=false;await updateExhaustion(s);await save(s);}
async function undo(id){let s=state(),c=s.checks.find(c=>c.id===id);if(!c||c.undone)return;c.undone=true;await updateExhaustion(s);await save(s);await chat(`↩️ Tracking check ${escape(id)} reversed. Character and skill availability recalculated.`);}
class Manager extends foundry.applications.api.ApplicationV2{static DEFAULT_OPTIONS={id:'xendrik-journey-manager',window:{title:'Xen’drik Journey Manager',resizable:true},position:{width:620,height:700},actions:{}};async _renderHTML(){let j=current(),s=state(),sc=score(s),p=penalties(s),actors=s.party.map(id=>game.actors.get(id)).filter(Boolean),available=eligible(s),locked=usedSkills(s);let actor=game.actors.get(available[0])??actors[0],skills=skillOptions(actor);let options=(arr,selected)=>arr.map(([v,l])=>`<option value="${escape(v)}" ${String(v)===String(selected)?'selected':''}>${escape(l)}</option>`).join('');return `<section class="xh"><h2>${escape(j?.name??'No Journey Selected')} — ${s.active?'Active':'Inactive'} ${s.paused?'⏸':''}</h2><p>Hexes: ${s.hexes} · <b>Day ${s.days+1}</b> (${s.days} completed) · Successes: ${sc.success} · Failures: ${sc.failure} · Net penalties: ${p}</p><h3>Party (drop Actors below)</h3><div class="xh-drop">${actors.map(a=>`<div>${escape(a.name)} ${available.includes(a.id)?'✓ Eligible':'⏳ Waiting'} <button data-remove="${a.id}">Remove</button></div>`).join('')||'Drag actors here'}</div><h3>Configuration</h3><div class="xh-grid">${[['successThreshold','Successes per offset',[1,2,3,4,5,6,8,10]],['failureThreshold','Failures per penalty',[1,2,3,4,5,6]],['dc','Tracking DC',[5,10,12,13,14,15,16,17,18,20,22,25,30]],['encounterDie','Encounter die',[3,4,6,8,10,12]],['hexesPerDay','Hexes per day',[1,2,3,4,5,6,8,10]],['frequency','Condition frequency',[['hex','Each hex'],['day','Each day']]],['exhaustionTiming','Exhaustion timing',[['end','Journey end'],['immediate','Immediate']]],['curseDirection','Curse direction',[['single','One direction'],['each','Each step random']]],['curseTime','Curse time',[['none','None'],['always','Every hex'],['chance','50% per hex']]]].map(([key,label,values])=>`<label>${label}<select data-setting="${key}">${options(values.map(v=>Array.isArray(v)?v:[v,v]),s[key])}</select></label>`).join('')}</div><h3>Tracked Token</h3><p>${escape(s.token??'Not selected')}</p><button data-act="token">Use selected token</button> <button data-act="start">Start journey</button> <button data-act="pause">${s.paused?'Resume':'Pause'}</button> <button data-act="end">End journey</button><h3>Encounter & Tracking</h3><p>${s.pending?`Pending: ${escape(s.pending.type)} · DC ${s.pending.dc??s.dc}`:'No pending encounter'}</p><button data-act="manual">Create encounter prompt</button> <button data-act="neutral">Resolve special / neutral</button><div class="xh-grid"><label>Character<select id="xh-actor">${options(available.map(id=>[id,game.actors.get(id)?.name??id]),actor?.id)}</select></label><label>Skill<select id="xh-skill">${options(skills.map(x=>[x.id,`${x.label}${locked.has(x.id)?' (USED)':''}`]),'')}</select></label><label>Roll total<input id="xh-roll" type="number" value="15"></label></div><button data-act="success">Narrative / Success</button> <button data-act="failure">Hostile / Failure</button><h3>Journey Day Log</h3><div class="xh-daylog">${(s.dayLog??[]).map(d=>`<div class="xh-entry">📅 Day ${d.day} — ${escape(d.reason)} · ${d.hexes} traveled hex(es) · ${d.timeHexes} time-counted</div>`).join('')||'No completed travel days yet'}</div><h3>Used Skills & History</h3>${s.checks.map(c=>`<div class="xh-entry">${escape(game.actors.get(c.actor)?.name)} · ${escape(c.skill)} · ${c.success?'Success':'Failure'} ${c.undone?'(reversed)':`<button data-undo="${c.id}">Undo</button>`}</div>`).join('')||'No checks yet'}<p><button data-act="reset">Reset all used skills (GM)</button></p><small>Exhaustion 10 = death. Exhaustion penalties to rolls require the D&D system's exhaustion handling or additional integration.</small></section>`;}
_replaceHTML(result,content){content.replaceChildren(result instanceof Node?result:document.createRange().createContextualFragment(result));this.bind(content);}
async _onRender(context,options){await super._onRender(context,options);}
bind(root){root.querySelectorAll('[data-setting]').forEach(el=>el.addEventListener('change',async()=>{let s=state();s[el.dataset.setting]=['frequency','exhaustionTiming','curseDirection','curseTime'].includes(el.dataset.setting)?el.value:Number(el.value);await save(s);this.render();}));root.querySelector('.xh-drop')?.addEventListener('drop',async e=>{e.preventDefault();try{let data=TextEditor.getDragEventData(e),a=await fromUuid(data.uuid);if(a?.documentName!=='Actor')return;let s=state();if(!s.party.includes(a.id))s.party.push(a.id);await save(s);this.render();}catch(err){ui.notifications.error(err.message);}});root.querySelector('.xh-drop')?.addEventListener('dragover',e=>e.preventDefault());root.querySelectorAll('[data-remove]').forEach(el=>el.onclick=async()=>{let s=state();s.party=s.party.filter(id=>id!==el.dataset.remove);await save(s);this.render();});root.querySelectorAll('[data-undo]').forEach(el=>el.onclick=async()=>{await undo(el.dataset.undo);this.render();});root.querySelectorAll('[data-act]').forEach(el=>el.onclick=async()=>{try{let s=state(),a=el.dataset.act;if(a==='token'){let t=canvas.tokens.controlled[0];if(!t)throw Error('Select a token first');s.token=t.document.id;s.scene=canvas.scene.id;await save(s);}if(a==='start'){if(!current())throw Error('Create a journey in the Journeys tab first');if(!s.party.length||!s.token)throw Error('Select party and tracked token first');s.active=true;s.paused=false;s.hexes=0;s.timeHexes=0;s.days=0;s.dayLog=[];s.checks=[];s.pending=null;s.exhaustionApplied={};await save(s);await chat('🚩 Journey started — Day 1.');}if(a==='pause'){s.paused=!s.paused;await save(s);}if(a==='end'){if(s.exhaustionTiming==='end')await applyExhaustion(s,penalties(s));s.active=false;s.paused=false;await save(s);await chat(`🏁 Journey ended on Day ${s.days+1} (${s.days} completed travel days). Net travel exhaustion: ${penalties(s)}.`);}if(a==='manual'){s.pending={type:'encounter',dc:s.dc+(s.condition?.dc??0)};s.paused=true;await save(s);await chat('⚠️ GM has initiated a tracking encounter.',true);}if(a==='neutral'){s.pending=null;s.paused=false;await save(s);}if(a==='success'||a==='failure'){await resolveCheck(root.querySelector('#xh-actor').value,root.querySelector('#xh-skill').value,root.querySelector('#xh-roll').value,a==='success');}if(a==='reset'){if(!await Dialog.confirm({title:'Reset skill restrictions?',content:'This will reverse every recorded check and recalculate penalties. Continue?'}))return;for(let c of s.checks)c.undone=true;await updateExhaustion(s);await save(s);}this.render();}catch(err){console.error(err);ui.notifications.error(err.message);}});root.querySelector('#xh-actor')?.addEventListener('change',e=>{let actor=game.actors.get(e.target.value);let select=root.querySelector('#xh-skill');if(select)select.innerHTML=skillOptions(actor).map(x=>`<option value="${escape(x.id)}">${escape(x.label)}${usedSkills(state()).has(x.id)?' (USED)':''}</option>`).join('');});}}
// Native Foundry V14 sidebar tab, using the same AbstractSidebarTab API as Dice So Nice.
const { HandlebarsApplicationMixin }=foundry.applications.api;
const { AbstractSidebarTab }=foundry.applications.sidebar;
class JourneySidebar extends HandlebarsApplicationMixin(AbstractSidebarTab){
 static tabName='xendrik-journeys';
 static DEFAULT_OPTIONS={id:'xendrik-journeys',classes:['xendrik-journeys'],window:{title:'Journeys',icon:'fa-solid fa-route'},actions:{}};
 static PARTS={content:{template:'modules/xendrik-hexcrawl/templates/sidebar.hbs',root:true}};
 async _prepareContext(options){
   const c=await super._prepareContext(options),db=library();
   return {...c,isGM:gm(),folders:db.folders.map(f=>({...f,items:db.items.filter(j=>j.folder===f.id).map(j=>({...j,selected:j.id===activeId(),active:j.data.active,day:j.data.days+1}))})),ungrouped:db.items.filter(j=>!j.folder||!db.folders.some(f=>f.id===j.folder)).map(j=>({...j,selected:j.id===activeId(),active:j.data.active,day:j.data.days+1}))};
 }
 async _onRender(context,options){
   await super._onRender(context,options);
   const root=this.element;
   root.querySelector('[data-new-journey]')?.addEventListener('click',async()=>{
     const name=prompt('New journey name:','New Journey');if(name===null)return;
     const j=await createJourney(name);if(j){this.render();manager?.render(true);}
   });
   root.querySelector('[data-new-folder]')?.addEventListener('click',async()=>{
     const name=prompt('New folder name:','Journeys');if(!name?.trim())return;
     const db=library();db.folders.push({id:foundry.utils.randomID(),name:name.trim()});await game.settings.set(ID,'journeys',db);this.render();
   });
   root.querySelectorAll('[data-open-journey]').forEach(el=>el.addEventListener('click',()=>openJourney(el.dataset.openJourney)));
   root.querySelectorAll('[data-rename-journey]').forEach(el=>el.addEventListener('click',async e=>{
     e.stopPropagation();const db=library(),j=db.items.find(j=>j.id===el.dataset.renameJourney);if(!j)return;
     const name=prompt('Rename journey:',j.name);if(!name?.trim())return;j.name=name.trim();await game.settings.set(ID,'journeys',db);this.render();
   }));
   root.querySelectorAll('[data-move-journey]').forEach(el=>el.addEventListener('change',async()=>{
     const db=library(),j=db.items.find(j=>j.id===el.dataset.moveJourney);if(!j)return;
     j.folder=el.value;await game.settings.set(ID,'journeys',db);this.render();
   }));
   root.querySelectorAll('[data-delete-journey]').forEach(el=>el.addEventListener('click',async e=>{
     e.stopPropagation();const id=el.dataset.deleteJourney,j=library().items.find(j=>j.id===id);if(!j)return;
     if(j.data.active){ui.notifications.warn('End this journey before deleting it.');return;}
     if(!confirm(`Delete journey "${j.name}"? This cannot be undone.`))return;
     const db=library();db.items=db.items.filter(j=>j.id!==id);await game.settings.set(ID,'journeys',db);
     if(activeId()===id)await game.settings.set(ID,'activeJourneyId','');this.render();
   }));
   root.querySelectorAll('[data-rename-folder]').forEach(el=>el.addEventListener('click',async()=>{
     const db=library(),f=db.folders.find(f=>f.id===el.dataset.renameFolder);if(!f)return;
     const name=prompt('Rename folder:',f.name);if(!name?.trim())return;f.name=name.trim();await game.settings.set(ID,'journeys',db);this.render();
   }));
 }
}
let manager;
Hooks.once('init',()=>{
 game.settings.register(ID,'journey',{scope:'world',config:false,type:Object,default:defaults()}); // Legacy data retained for migration
 game.settings.register(ID,'journeys',{scope:'world',config:false,type:Object,default:{items:[],folders:[]}});
 game.settings.register(ID,'activeJourneyId',{scope:'world',config:false,type:String,default:''});
 CONFIG.ui['xendrik-journeys']=JourneySidebar;
 const tabs=CONFIG.ui.sidebar?.TABS;
 if(tabs&&!tabs['xendrik-journeys']){
   const settings=tabs.settings;
   if(settings)delete tabs.settings;
   tabs['xendrik-journeys']={icon:'fa-solid fa-route',tooltip:'Journeys'};
   if(settings)tabs.settings=settings;
 }
});
Hooks.once('ready',async()=>{
 manager=new Manager();
 if(gm()){
   // One-time migration of the original v0.1.2 journey without deleting it.
   const db=library();
   if(!db.items.length){const legacy=game.settings.get(ID,'journey');
     if(legacy?.active||legacy?.party?.length||legacy?.checks?.length||legacy?.dayLog?.length){
       const j={id:foundry.utils.randomID(),name:'Imported Journey (v0.1.2)',folder:'',data:legacy};
       db.items.push(j);await game.settings.set(ID,'journeys',db);await game.settings.set(ID,'activeJourneyId',j.id);
     }
   }
 }
 game.xendrikHexcrawl={open:()=>manager.render(true),getState:state,openJourney,createJourney};
 Hooks.on('xendrikJourneysChanged',()=>ui.sidebar?.tabs?.['xendrik-journeys']?.render(false));
});
Hooks.on('preUpdateToken',move);
