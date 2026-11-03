const ID='xendrik-hexcrawl';
const defaults=()=>({active:false,paused:false,party:[],token:null,scene:null,hexes:0,timeHexes:0,days:0,dayLog:[],checks:[],pending:null,condition:null,successThreshold:4,failureThreshold:2,dc:15,difficultyMods:{common:-5,skilled:0,expert:5,outlandish:10},queuedHexes:0,encounterDie:3,hexesPerDay:1,frequency:'hex',exhaustionTiming:'end',curseDirection:'single',curseTime:'chance',exhaustionApplied:{},startTime:Date.now()});
const CONDITIONS=[['Favorable Weather',-1,0],['Clear Skies',0,0],['Calm Passage',-1,0],['Heavy Rainfall',-1,2],['Dense Jungle',1,2],['Ominous Signs',1,0],['Unstable Terrain',0,2],['Arcane Disturbance',1,-2],['Manifest Zone',0,0], ["Traveler’s Curse",0,0]];
let busy=false;
const lastTokenHex=new Map();
const priorTokenPositions=new Map();
const capturedRolls=new Set();
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

function eligible(s){let checks=s.checks.filter(c=>!c.undone&&!c.manual);let round=Math.floor(checks.length/Math.max(1,s.party.length));let used=new Set(checks.slice(round*s.party.length).map(c=>c.actor));return s.party.filter(id=>!used.has(id));}
function usedSkills(s){return new Set(s.checks.filter(c=>!c.undone).map(c=>c.skill));}
function score(s){let cs=s.checks.filter(c=>!c.undone&&(!c.manual||c.outcome));return {success:cs.filter(c=>c.success).length,failure:cs.filter(c=>!c.success).length};}
function penalties(s){let a=score(s);return Math.max(0,Math.floor(a.failure/s.failureThreshold)-Math.floor(a.success/s.successThreshold));}
async function chat(content,whisper=false){return ChatMessage.create({content,speaker:{alias:'Journey Guide'},...(whisper?{whisper:ChatMessage.getWhisperRecipients('GM').map(u=>u.id)}:{})});}
const escape=v=>foundry.utils.escapeHTML(String(v??''));
function skillOptions(actor){let data=actor?.system?.skills??{};return Object.entries(data).map(([id,v])=>({id,label:game.dnd5e?.config?.skills?.[id]?.label??CONFIG.DND5E?.skills?.[id]?.label??v.label??id,ability:v.ability??CONFIG.DND5E?.skills?.[id]?.ability??''})).sort((a,b)=>String(a.label).localeCompare(String(b.label),undefined,{sensitivity:'base'}));}
async function updateExhaustion(s){if(s.exhaustionTiming!=='immediate')return;await applyExhaustion(s,penalties(s));}
async function applyExhaustion(s,target){for(let id of s.party){let actor=game.actors.get(id);if(!actor)continue;let prior=s.exhaustionApplied[id]??0;let current=Number(actor.system?.attributes?.exhaustion??0);let next=Math.max(0,Math.min(10,current+target-prior));if(next!==current)await actor.update({'system.attributes.exhaustion':next});s.exhaustionApplied[id]=target;if(next>=10)await chat(`☠️ ${escape(actor.name)} has reached exhaustion level 10 and dies.`);}}
function hexCell(pos,scene){
 const grid=scene?.grid; if(!grid)return null;
 try {const cell=grid.getOffset?.(pos);if(cell&&Number.isFinite(cell.i)&&Number.isFinite(cell.j))return `${cell.i},${cell.j}`;}catch(e){}
 const size=Number(grid.size)||100;return `${Math.round(pos.x/size)},${Math.round(pos.y/size)}`;
}
function stepHexes(a,b,scene){
 const grid=scene?.grid;if(!grid)return 0;
 try {const from=grid.getOffset?.(a),to=grid.getOffset?.(b);if(from&&to){
   const ai=Number(from.i),aj=Number(from.j),bi=Number(to.i),bj=Number(to.j);
   if([ai,aj,bi,bj].every(Number.isFinite)){
     if(typeof grid.getDirectPath==='function'){const path=grid.getDirectPath([a,b]);if(Array.isArray(path)&&path.length>1)return path.length-1;}
     return Math.max(Math.abs(bi-ai),Math.abs(bj-aj),Math.abs((bi-ai)+(bj-aj)));
   }
 }}catch(e){console.warn('Xendrik grid path fallback',e);}
 const size=Number(grid.size)||100;return Math.max(0,Math.round(Math.hypot(b.x-a.x,b.y-a.y)/size));
}
async function condition(s){let n=await (new Roll('1d10')).evaluate();let idx=n.total-1;let [name,mod,dc]=CONDITIONS[idx];s.condition={name,mod,dc,roll:n.total};await chat(`🌿 <b>Travel condition:</b> ${escape(name)} (encounter modifier ${mod>=0?'+':''}${mod}; tracking DC ${s.dc+dc}).`);if(idx===9)await curse(s);else if(idx===8){s.pending={type:'special',name:'Manifest Zone'};s.paused=true;await chat('🌀 <b>Manifest Zone!</b> GM: resolve the special event in the Journey Manager.');} }
async function curse(s){let d=(await (new Roll('1d6')).evaluate()).total;let steps=d<=3?1:d<=5?2:3;let counted=0;for(let i=0;i<steps;i++)if(s.curseTime==='always'||(s.curseTime==='chance'&&(await new Roll('1d2')).evaluate()).total===2)counted++;s.timeHexes+=counted;let previous=s.days;s.days=Math.floor(s.timeHexes/s.hexesPerDay);await logDays(s,previous,"Traveler's Curse");await chat(`🧭 <b>Traveler's Curse:</b> ${steps} forced hex(es), ${counted} time-counted hex(es). Direction mode: ${escape(s.curseDirection)}. Move the token manually; curse movement is not rolled again.`);}
async function encounter(s){
 const die=Number(s.encounterDie)||3,roll=await (new Roll(`1d${die}`)).evaluate(),mod=s.condition?.mod??0,hit=roll.total+mod>=die;
 const total=roll.total+mod,dc=s.dc+(s.condition?.dc??0);
 await roll.toMessage({speaker:{alias:'Journey Guide'},flavor:`Journey Encounter — d${die} / DC ${die} | ${mod>=0?'+':''}${mod} condition modifier | ${hit?'ENCOUNTER':'No encounter'} (total ${total})`},{rollMode:'gmroll'});
 if(hit){s.paused=true;s.pending={type:'encounter',roll:roll.total,mod,dc};await chat(`⚠️ <b>Encounter triggered!</b> d${die}: ${roll.total} ${mod>=0?'+':''}${mod} = ${total} vs DC ${die}. Tracking DC ${dc}.`,true);}
 else await chat(`Travel encounter check: d${die}: ${roll.total} ${mod>=0?'+':''}${mod} = ${total} vs DC ${die}; no encounter.`,true);
}
async function logDays(s,previous,reason){s.dayLog??=[];for(let day=previous+1;day<=s.days;day++){let entry={day,reason,hexes:s.hexes,timeHexes:s.timeHexes,at:Date.now()};s.dayLog.push(entry);await chat(`📅 <b>Journey Day ${day}</b> — ${escape(reason)}. ${s.hexes} traveled hex(es); ${s.timeHexes} time-counted hex(es).`);}}
async function travel(s,hexes){for(let i=0;i<hexes;i++){if(s.paused||!s.active)break;s.hexes++;s.timeHexes++;let before=s.days;s.days=Math.floor(s.timeHexes/s.hexesPerDay);await logDays(s,before,'Normal travel');if(s.frequency==='hex'||s.days>before){await condition(s);if(!s.paused)await encounter(s);}}await save(s);}
// Foundry's token update hook is authoritative. Store the old position in preUpdateToken,
// then compare the actual new document position; do not depend on the change payload being complete.
function captureTokenPosition(doc,change){
 if(!gm()||(!Object.hasOwn(change,'x')&&!Object.hasOwn(change,'y')))return;
 priorTokenPositions.set(doc.uuid,{x:doc.x,y:doc.y});
}
async function movedToken(doc,change){
 if(!gm()||(!Object.hasOwn(change,'x')&&!Object.hasOwn(change,'y')))return;
 const before=priorTokenPositions.get(doc.uuid);priorTokenPositions.delete(doc.uuid);
 const s=state();if(!s.active||doc.id!==s.token||doc.parent?.id!==s.scene)return;
 const previous=before??lastTokenHex.get(doc.uuid);
 lastTokenHex.set(doc.uuid,{x:doc.x,y:doc.y});
 if(!previous)return;
 const count=stepHexes(previous,{x:doc.x,y:doc.y},doc.parent);if(!count)return;
 if(busy||s.paused){s.queuedHexes=(s.queuedHexes??0)+count;await save(s);ui.notifications.info(`${count} hex(es) queued for journey processing.`);return;}
 busy=true;try{await travel(s,count);}catch(err){console.error('Xendrik travel error',err);ui.notifications.error(`Journey movement error: ${err.message}`);}finally{busy=false;}
}
// Character sheet rolls are recognized by the dnd5e roll metadata attached to ChatMessages.
function identifySkillRoll(message){
 const flags=message.flags?.dnd5e??{},roll=message.rolls?.[0];
 const context=flags.roll??flags.test??{},subject=context.subject??{},details=context.options??{};
 const candidates=[flags.roll?.skill,flags.roll?.skillId,flags.roll?.skillKey,flags.test?.skill,flags.test?.skillId,flags.skill,subject.skill,details.skill,flags.activity?.skill];
 const type=String(context.type??flags.roll?.type??flags.test?.type??'').toLowerCase();
 if(type&&!type.includes('skill')&&!candidates.some(Boolean))return null;
 const actor=game.actors.get(message.speaker?.actor);if(!actor)return null;
 const opts=skillOptions(actor);
 let id=candidates.find(v=>typeof v==='string'&&opts.some(o=>o.id===v));
 if(!id){const flavor=String(message.flavor??'').toLowerCase();const matches=opts.filter(o=>flavor.includes(String(o.label).toLowerCase()));if(matches.length===1)id=matches[0].id;}
 if(!id||!roll||!Number.isFinite(Number(roll.total)))return null;
 return {actor,skill:id,total:Number(roll.total)};
}
async function captureSheetCheck(message){
 if(!gm()||!message?.id||capturedRolls.has(message.id))return;
 if(state().pending?.promptId)return;
 const s=state();if(!s.active||!s.pending||s.pending.type!=='encounter')return;
 const found=identifySkillRoll(message);if(!found||!s.party.includes(found.actor.id))return;
 capturedRolls.add(message.id);
 if(!eligible(s).includes(found.actor.id)){ui.notifications.warn(`${found.actor.name} already made a tracking check this rotation; roll not recorded.`);return;}
 if(usedSkills(s).has(found.skill)){ui.notifications.warn(`Oops, ${found.skill} has already been used on this journey. Roll not recorded.`);return;}
 const success=found.total>=Number(s.pending.dc??s.dc);
 try{await resolveCheck(found.actor.id,found.skill,found.total,success);}catch(err){console.error(err);ui.notifications.error(err.message);}
}
async function resolveCheck(actorId,skill,roll,success){let s=state();if(!s.active||!s.pending)throw Error('No active pending encounter');let actor=game.actors.get(actorId);if(!s.party.includes(actorId)||!actor)throw Error('Actor not participating');let avail=eligible(s);if(!avail.includes(actorId))throw Error('This character already checked this rotation');let options=skillOptions(actor);if(!options.some(x=>x.id===skill))throw Error('Skill not found on actor');if(usedSkills(s).has(skill))throw Error('Oops, that skill has already been used. Please try again.');let c={id:foundry.utils.randomID(),actor:actorId,skill,roll:Number(roll),success:!!success,undone:false};s.checks.push(c);let label=options.find(x=>x.id===skill)?.label??skill;await chat(`📜 <b>Tracking check:</b> ${escape(actor.name)} — ${escape(label)} (${escape(skill)}), result ${escape(roll)}. <b>${success?'Narrative / Success':'Hostile / Failure'}</b>. Skill locked for this journey. Check ID: ${c.id}`);s.pending=null;s.paused=false;await updateExhaustion(s);await save(s);await flushQueued();}
async function markManual(actorId,key,outcome='used'){
 const s=state(),actor=game.actors.get(actorId);
 if(!current()||!actor||!s.party.includes(actorId))throw Error('Choose a participating character');
 const skills=skillOptions(actor), abilities=['str','dex','con','int','wis','cha'];
 const valid=skills.some(x=>x.id===key)||(key.startsWith('ability:')&&abilities.includes(key.slice(8)));
 if(!valid)throw Error('Unknown skill or ability score');
 if(usedSkills(s).has(key))throw Error('This skill or ability score is already marked used');
 const label=skills.find(x=>x.id===key)?.label??({str:'Strength',dex:'Dexterity',con:'Constitution',int:'Intelligence',wis:'Wisdom',cha:'Charisma'}[key.slice(8)]+' (Ability Check)');
 const record={id:foundry.utils.randomID(),actor:actorId,skill:key,manual:true,outcome:outcome==='used'?null:outcome,success:outcome==='success',undone:false};
 s.checks.push(record);await save(s);
 await chat(`📝 <b>Manually marked used:</b> ${escape(actor.name)} — ${escape(label)}. ${outcome==='used'?'No success or failure awarded':outcome==='success'?'Success awarded':'Failure awarded'}. This entry can be undone.`);
}

async function flushQueued(){
 if(!gm())return;
 const s=state(),count=s.queuedHexes??0;
 if(!s.active||s.paused||!count)return;
 s.queuedHexes=0;await save(s);
 await travel(s,count);
}
async function postTrackingPrompt(skill,difficulty,recipient="all"){
 if(!gm())throw Error('Only the GM can create tracking prompts');
 const s=state();if(!s.active)throw Error('Start the journey first');
 if(usedSkills(s).has(skill))throw Error('That skill has already been used');
 if(!s.party.some(id=>skillOptions(game.actors.get(id)).some(x=>x.id===skill)))throw Error('No party actor has this skill');
 const modifiers={common:-5,skilled:0,expert:5,outlandish:10,...s.difficultyMods};
 const dc=Math.max(1,Number(s.dc)+(s.condition?.dc??0)+Number(modifiers[difficulty]??0));
 const promptId=foundry.utils.randomID();
 s.pending={type:'encounter',dc,promptId,skill,difficulty,recipient};s.paused=true;await save(s);
 const name=skillOptions(game.actors.get(s.party.find(id=>skillOptions(game.actors.get(id)).some(x=>x.id===skill)))).find(x=>x.id===skill)?.label??skill;
 const buttons=s.party.filter(id=>recipient==='all'||id===recipient).map(id=>game.actors.get(id)).filter(a=>a&&eligible(s).includes(a.id)&&skillOptions(a).some(x=>x.id===skill)).map(a=>`<button type="button" data-xh-roll="${escape(promptId)}" data-actor="${escape(a.id)}" data-skill="${escape(skill)}">🎲 ${escape(a.name)} — Roll ${escape(name)}</button>`).join('');
 await chat(`<div class="xh-chat-prompt"><h3>🧭 Tracking: ${escape(name)}</h3><p>Difficulty: ${escape(difficulty)} · DC ${dc}</p><p>Choose your character to roll:</p>${buttons}</div>`);
}
async function requestTrackingRoll(promptId,actorId,skill){
 const s=state(),a=game.actors.get(actorId);
 if(!s.active||s.pending?.promptId!==promptId||s.pending?.skill!==skill)throw Error('This prompt is no longer active');
 if(!a||!s.party.includes(actorId)||(s.pending.recipient&&s.pending.recipient!=='all'&&s.pending.recipient!==actorId)||!skillOptions(a).some(x=>x.id===skill))throw Error('Invalid actor or skill');
 if(!eligible(s).includes(actorId)||usedSkills(s).has(skill))throw Error('This character or skill has already been used for the current journey');
 if(!gm()&&!a.testUserPermission(game.user,'OWNER'))throw Error('You do not control this actor');
 let result;
 if(typeof a.rollSkill==='function')result=await a.rollSkill({skill,dialog:false});
 else if(typeof a.rollSkillCheck==='function')result=await a.rollSkillCheck(skill);
 else if(typeof a.rollSkillTest==='function')result=await a.rollSkillTest(skill);
 else throw Error('No supported skill rolling method was found on this actor');
 const total=Number(result?.total??result?.rolls?.[0]?.total??result?.roll?.total??result?.[0]?.total);
 if(!Number.isFinite(total))throw Error('Roll was not returned as a total. Try the actor sheet or GM manual resolution');
 if(gm())await acceptTrackingRoll(promptId,actorId,skill,total);
 else game.socket.emit(`module.${ID}`,{type:'tracking-roll',promptId,actorId,skill,total,userId:game.user.id});
}
async function acceptTrackingRoll(promptId,actorId,skill,total){
 if(!gm())return;
 const s=state();if(s.pending?.promptId!==promptId||s.pending?.skill!==skill)return;
 if(!Number.isFinite(total))return;
 await resolveCheck(actorId,skill,total,total>=s.pending.dc);
}

async function undo(id){let s=state(),c=s.checks.find(c=>c.id===id);if(!c||c.undone)return;c.undone=true;await updateExhaustion(s);await save(s);await chat(`↩️ Tracking check ${escape(id)} reversed. Character and skill availability recalculated.`);}
class Manager extends foundry.applications.api.ApplicationV2{static DEFAULT_OPTIONS={id:'xendrik-journey-manager',window:{title:'Xen’drik Journey Manager',resizable:true},position:{width:620,height:700},actions:{}};async _renderHTML(){let j=current(),s=state(),sc=score(s),p=penalties(s),actors=s.party.map(id=>game.actors.get(id)).filter(Boolean),available=eligible(s),locked=usedSkills(s);let actor=game.actors.get(available[0])??actors[0],skills=skillOptions(actor);let options=(arr,selected)=>arr.map(([v,l])=>`<option value="${escape(v)}" ${String(v)===String(selected)?'selected':''}>${escape(l)}</option>`).join('');return `<section class="xh"><h2>${escape(j?.name??'No Journey Selected')} — ${s.active?'Active':'Inactive'} ${s.paused?'⏸':''}</h2><p>Hexes: ${s.hexes} · <b>Day ${s.days+1}</b> (${s.days} completed) · Successes: ${sc.success} · Failures: ${sc.failure} · Net penalties: ${p}</p><h3>Party (drop Actors below)</h3><div class="xh-drop">${actors.map(a=>`<div class="xh-party-member"><img src="${escape(a.prototypeToken?.texture?.src||a.img||'icons/svg/mystery-man.svg')}" alt="">${escape(a.name)} ${available.includes(a.id)?'✓ Eligible':'⏳ Waiting'} <button data-remove="${a.id}">Remove</button></div>`).join('')||'Drag actors here'}</div><h3>Configuration</h3><div class="xh-grid">${[['successThreshold','Successes per offset',[1,2,3,4,5,6,8,10]],['failureThreshold','Failures per penalty',[1,2,3,4,5,6]],['encounterDie','Encounter die',[3,4,6,8,10,12]],['frequency','Condition frequency',[['hex','Each hex'],['day','Each day']]],['exhaustionTiming','Exhaustion timing',[['end','Journey end'],['immediate','Immediate']]],['curseDirection','Curse direction',[['single','One direction'],['each','Each step random']]],['curseTime','Curse time',[['none','None'],['always','Every hex'],['chance','50% per hex']]]].map(([key,label,values])=>`<label>${label}<select data-setting="${key}">${options(values.map(v=>Array.isArray(v)?v:[v,key==='encounterDie'?`d${v} / DC ${v}`:v]),s[key])}</select></label>`).join('')}</div><label class="xh-number-field">Base tracking DC<input type="number" min="1" step="1" data-setting="dc" value="${escape(s.dc)}"></label><label class="xh-number-field">Hexes per day<input type="number" min="0.01" step="any" data-setting="hexesPerDay" value="${escape(s.hexesPerDay)}"></label><h3>Tracked Token</h3><p>${escape(s.token??'Not selected')}</p><button data-act="token">Use selected token</button> <button data-act="start">Start journey</button> <button data-act="pause">${s.paused?'Resume':'Pause'}</button> <button data-act="end">End journey</button><h3>Encounter & Tracking</h3><p>${s.pending?`Pending: ${escape(s.pending.type)} · DC ${s.pending.dc??s.dc}`:'No pending encounter'}</p><div class="xh-grid"><label>Prompt skill<select id="xh-prompt-skill">${options([...new Map(actors.flatMap(a=>skillOptions(a)).map(x=>[x.id,x.label])).entries()].map(([id,label])=>[id,label]),'')}</select></label><label>Difficulty<select id="xh-prompt-difficulty">${options([['common','Common Sense'],['skilled','Skilled'],['expert','Expert'],['outlandish','Outlandish']],'skilled')}</select></label><label>Who can roll?<select id="xh-prompt-recipient">${options([['all','Entire party'],...actors.map(a=>[a.id,a.name])],'all')}</select></label></div><button data-act="prompt">Post skill roll buttons in chat</button> <button data-act="manual">Create encounter (GM)</button> <button data-act="neutral">Resolve special / neutral</button><div class="xh-grid"><label>Character<select id="xh-actor">${options(available.map(id=>[id,game.actors.get(id)?.name??id]),actor?.id)}</select></label><label>Skill<select id="xh-skill">${options(skills.map(x=>[x.id,`${x.label}${locked.has(x.id)?' (USED)':''}`]),'')}</select></label><label>Roll total<input id="xh-roll" type="number" value="15"></label></div><button data-act="success">Narrative / Success</button> <button data-act="failure">Hostile / Failure</button><h3>Manually Mark Used (GM)</h3><p>Lock a skill or ability check without rolling or changing journey successes/failures.</p><div class="xh-grid"><label>Character<select id="xh-manual-actor">${options(actors.map(a=>[a.id,a.name]),actor?.id)}</select></label><label>Skill or Ability<select id="xh-manual-key">${options([...skills.map(x=>[x.id,x.label]),...Object.entries({str:'Strength',dex:'Dexterity',con:'Constitution',int:'Intelligence',wis:'Wisdom',cha:'Charisma'}).map(([k,v])=>['ability:'+k,v+' (Ability Check)'])].sort((a,b)=>a[1].localeCompare(b[1],undefined,{sensitivity:'base'})).map(([k,v])=>[k,v+(locked.has(k)?' (USED)':'')]),'')}</select></label></div><label>Manual outcome<select id="xh-manual-outcome"><option value="used">Used only</option><option value="success">Success</option><option value="failure">Failure</option></select></label><button data-act="mark-used">Record</button><h3>Journey Day Log</h3><div class="xh-daylog">${(s.dayLog??[]).map(d=>`<div class="xh-entry">📅 Day ${d.day} — ${escape(d.reason)} · ${d.hexes} traveled hex(es) · ${d.timeHexes} time-counted</div>`).join('')||'No completed travel days yet'}</div><h3>Used Skills & History</h3>${s.checks.map(c=>`<div class="xh-entry">${escape(game.actors.get(c.actor)?.name)} · ${escape(c.skill)} · ${c.manual?(c.outcome==='success'?'Manual success':c.outcome==='failure'?'Manual failure':'Manually marked used'):c.success?'Success':'Failure'} ${c.undone?'(reversed)':`<button data-undo="${c.id}">Undo</button>`}</div>`).join('')||'No checks yet'}<p><button data-act="reset">Reset all used skills (GM)</button></p><small>Exhaustion 10 = death. Exhaustion penalties to rolls require the D&D system's exhaustion handling or additional integration.</small></section>`;}
_replaceHTML(result,content){const old=content.querySelector('.xh');const y=old?.scrollTop??content.scrollTop;content.replaceChildren(result instanceof Node?result:document.createRange().createContextualFragment(result));this.bind(content);const fresh=content.querySelector('.xh');if(fresh)fresh.scrollTop=y;content.scrollTop=y;}
async _onRender(context,options){await super._onRender(context,options);}
bind(root){root.querySelectorAll('[data-setting]').forEach(el=>el.addEventListener('change',async()=>{let s=state();s[el.dataset.setting]=['frequency','exhaustionTiming','curseDirection','curseTime'].includes(el.dataset.setting)?el.value:Number(el.value);if(el.dataset.setting==='dc'&&(!Number.isSafeInteger(s.dc)||s.dc<1))throw Error('Tracking DC must be a positive integer');if(el.dataset.setting==='hexesPerDay'&&(!Number.isFinite(s.hexesPerDay)||s.hexesPerDay<=0))throw Error('Hexes per day must be greater than zero');await save(s);this.render();}));root.querySelector('.xh-drop')?.addEventListener('drop',async e=>{e.preventDefault();try{let data=TextEditor.getDragEventData(e),a=await fromUuid(data.uuid);if(a?.documentName!=='Actor')return;let s=state();if(!s.party.includes(a.id))s.party.push(a.id);await save(s);this.render();}catch(err){ui.notifications.error(err.message);}});root.querySelector('.xh-drop')?.addEventListener('dragover',e=>e.preventDefault());root.querySelectorAll('[data-remove]').forEach(el=>el.onclick=async()=>{let s=state();s.party=s.party.filter(id=>id!==el.dataset.remove);await save(s);this.render();});root.querySelectorAll('[data-undo]').forEach(el=>el.onclick=async()=>{await undo(el.dataset.undo);this.render();});root.querySelectorAll('[data-act]').forEach(el=>el.onclick=async()=>{try{let s=state(),a=el.dataset.act;if(a==='token'){let t=canvas.tokens.controlled[0];if(!t)throw Error('Select a token first');s.token=t.document.id;s.scene=canvas.scene.id;lastTokenHex.set(t.document.uuid,{x:t.document.x,y:t.document.y});await save(s);}if(a==='start'){if(!current())throw Error('Create a journey in the Journeys tab first');if(!s.party.length||!s.token)throw Error('Select party and tracked token first');s.active=true;s.paused=false;s.hexes=0;s.timeHexes=0;s.days=0;s.dayLog=[];s.checks=[];s.pending=null;s.exhaustionApplied={};s.queuedHexes=0;{const t=canvas.scene?.tokens?.get(s.token);if(t)lastTokenHex.set(t.uuid,{x:t.x,y:t.y});}await save(s);await chat('🚩 Journey started — Day 1.');}if(a==='pause'){s.paused=!s.paused;await save(s);}if(a==='end'){if(s.exhaustionTiming==='end')await applyExhaustion(s,penalties(s));s.active=false;s.paused=false;await save(s);await chat(`🏁 Journey ended on Day ${s.days+1} (${s.days} completed travel days). Net travel exhaustion: ${penalties(s)}.`);}if(a==='prompt'){await postTrackingPrompt(root.querySelector('#xh-prompt-skill').value,root.querySelector('#xh-prompt-difficulty').value,root.querySelector('#xh-prompt-recipient').value);}if(a==='manual'){s.pending={type:'encounter',dc:s.dc+(s.condition?.dc??0)};s.paused=true;await save(s);await chat('⚠️ GM has initiated a tracking encounter.',true);}if(a==='neutral'){s.pending=null;s.paused=false;await save(s);await flushQueued();}if(a==='success'||a==='failure'){await resolveCheck(root.querySelector('#xh-actor').value,root.querySelector('#xh-skill').value,root.querySelector('#xh-roll').value,a==='success');}if(a==='mark-used'){await markManual(root.querySelector('#xh-manual-actor').value,root.querySelector('#xh-manual-key').value,root.querySelector('#xh-manual-outcome').value);}if(a==='reset'){if(!await Dialog.confirm({title:'Reset skill restrictions?',content:'This will reverse every recorded check and recalculate penalties. Continue?'}))return;for(let c of s.checks)c.undone=true;await updateExhaustion(s);await save(s);}this.render();}catch(err){console.error(err);ui.notifications.error(err.message);}});root.querySelector('#xh-manual-actor')?.addEventListener('change',e=>{let a=game.actors.get(e.target.value),select=root.querySelector('#xh-manual-key');if(select){let vals=[...skillOptions(a).map(x=>[x.id,x.label]),...Object.entries({str:'Strength',dex:'Dexterity',con:'Constitution',int:'Intelligence',wis:'Wisdom',cha:'Charisma'}).map(([k,v])=>['ability:'+k,v+' (Ability Check)'])].sort((x,y)=>x[1].localeCompare(y[1],undefined,{sensitivity:'base'}));select.innerHTML=vals.map(([k,v])=>`<option value="${escape(k)}">${escape(v)}${usedSkills(state()).has(k)?' (USED)':''}</option>`).join('');}});root.querySelector('#xh-actor')?.addEventListener('change',e=>{let actor=game.actors.get(e.target.value);let select=root.querySelector('#xh-skill');if(select)select.innerHTML=skillOptions(actor).map(x=>`<option value="${escape(x.id)}">${escape(x.label)}${usedSkills(state()).has(x.id)?' (USED)':''}</option>`).join('');});}}
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
     const db=library();
     const folderChoices=db.folders.map(f=>`<option value="${escape(f.id)}">${escape(f.name)}</option>`).join('');
     const result=await foundry.applications.api.DialogV2.wait({window:{title:'Create Journey'},content:`<form class="xh-create"><div class="form-group"><label>Journey Name</label><input name="journeyName" type="text" value="New Journey" required autofocus></div><div class="form-group"><label>Folder</label><select name="journeyFolder"><option value="">None</option>${folderChoices}</select></div></form>`,buttons:[{action:'create',label:'Create Journey',icon:'fa-solid fa-plus',default:true,callback:(event,button,dialog)=>{const root=dialog.element;return {name:root.querySelector('[name=journeyName]').value,folder:root.querySelector('[name=journeyFolder]').value};}},{action:'cancel',label:'Cancel',callback:()=>null}]});
     if(!result?.name?.trim())return;
     const j=await createJourney(result.name,result.folder);if(j){this.render();manager?.render(true);}
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
Hooks.on('preUpdateToken',captureTokenPosition);
Hooks.on('updateToken',movedToken);
// Chat card rolls are handled explicitly to avoid duplicate captures.

Hooks.on('renderChatMessageHTML',(message,html)=>{
 const root=html instanceof HTMLElement?html:html?.[0];if(!root)return;
 root.querySelectorAll('[data-xh-roll]').forEach(button=>button.addEventListener('click',async()=>{
  button.disabled=true;
  try{await requestTrackingRoll(button.dataset.xhRoll,button.dataset.actor,button.dataset.skill);}
  catch(e){ui.notifications.error(e.message);button.disabled=false;}
 }));
});
Hooks.once('ready',()=>game.socket.on(`module.${ID}`,async data=>{
 if(!gm()||data?.type!=='tracking-roll')return;
 const actor=game.actors.get(data.actorId),user=game.users.get(data.userId);
 if(!actor||!user||!actor.testUserPermission(user,'OWNER'))return;
 try{await acceptTrackingRoll(data.promptId,data.actorId,data.skill,Number(data.total));}catch(e){console.error('Xendrik tracking roll',e);}
}));
