import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const norm = (value) => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
const slug = (value) => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");

const TITLE_RE = /\b(CAMISA|CONJUNTO|KIT|SHORTS?|CAL[CÇ][AÃ]O|CORTA[ -]?VENTO|WINDBREAKER|REGATA|PLAYER|JOGADOR|TORCEDOR|FEMININ[AO]|KIDS?|INFANTIL|INFATIL|RET[RÔO]|TREINO|VIAGEM|GOLEIRO)\b/i;
const MEDIA_HOST_RE = /(^|\.)(googleusercontent\.com|usercontent\.google\.com|ggpht\.com)$/i;
const BRAND_RE = /\b(ADIDAS|NIKE|PUMA|EA7|UMBRO|KAPPA|JORDAN|CASTORE|NEW BALANCE|LE COQ(?: SPORTIF)?|MACRON|MIZUNO|JOMA|UNDER ARMOUR|REEBOK|KOBE)\b/i;
const SEASON_RE = /\b(\d{2}\s*\/\s*\d{2})\b/;
const MODEL_RE = /\b(?:CAMISA|REGATA)\s+(I{1,3}|IV|V)\b|\bCONJUNTO(?:\s+(?:INFANTIL|INFATIL))?\s+(I{1,3}|IV|V)\b|\bCONJUNTO\s+(I{1,3}|IV|V)\s+(?:INFANTIL|INFATIL)\b/i;
const PRICES = { torcedor:184.9, feminino:184.9, jogador:219.9, infantil:169.9 };
const PATCHES = {
  "premier-league": [{ code:"premier-league", label:"Premier League", price:15 }],
  "la-liga": [{ code:"laliga", label:"LaLiga", price:15 }],
  "serie-a": [{ code:"serie-a", label:"Serie A", price:15 }],
  bundesliga: [{ code:"bundesliga", label:"Bundesliga", price:15 }],
  "ligue-1": [{ code:"ligue-1", label:"Ligue 1", price:15 }],
  mls: [{ code:"mls", label:"MLS", price:15 }],
  "outros-times": [],
};

function parseArgs() {
  const out = { groupId:"", groupName:"", competition:"", league:"", team:"", url:"", output:"plan.json" };
  const args = process.argv.slice(2);
  for (let i=0;i<args.length;i+=1) {
    const a=args[i];
    if (a==="--group-id") out.groupId=args[++i];
    else if (a==="--group-name") out.groupName=args[++i];
    else if (a==="--competition") out.competition=args[++i];
    else if (a==="--league") out.league=args[++i];
    else if (a==="--team") out.team=args[++i];
    else if (a==="--url") out.url=args[++i];
    else if (a==="--output") out.output=args[++i];
    else throw new Error(`Opção desconhecida: ${a}`);
  }
  if (!out.groupId || !out.team || !/^https:\/\/photos\.google\.com\/share\//.test(out.url)) throw new Error("Argumentos obrigatórios ausentes.");
  return out;
}
function isMediaUrl(raw){try{const u=new URL(raw);return u.protocol==="https:"&&MEDIA_HOST_RE.test(u.hostname)}catch{return false}}
function mediaKey(raw){if(!isMediaUrl(raw))return null;const u=new URL(raw);const p=u.pathname.replace(/=w\d+(?:-h\d+)?[^/?#]*/i,"").replace(/=s\d+[^/?#]*/i,"");return `${u.hostname.toLowerCase()}${p}`}
function highQualityUrl(raw,size=4096){if(!isMediaUrl(raw))return raw;const u=new URL(raw);const p=u.pathname.replace(/=w\d+(?:-h\d+)?[^/?#]*/i,"").replace(/=s\d+[^/?#]*/i,"");u.pathname=`${p}=w${size}-h${size}-s-no-gm`;return u.toString()}
function looksLikeTitle(raw){const t=clean(raw);return t.length>=5&&t.length<=180&&TITLE_RE.test(t)}
function classifyType(title){const u=norm(title);if(/CORTA[ -]?VENTO|WINDBREAKER|JAQUETA|CASACO|AGASALHO/.test(u))return"corta-vento";if(/\bSHORTS?\b|\bCALCAO\b/.test(u))return"shorts";if(/\bTREINO\b/.test(u))return"treino";if(/\bVIAGEM\b/.test(u))return"viagem";if(/\bCONJUNTO\b/.test(u))return"conjunto";if(/\bKIT\b/.test(u))return"kit";if(/\bREGATA\b/.test(u))return"regata";if(/\bCAMISA\b/.test(u))return"camisa";return"outro"}
function audience(title){const u=norm(title);if(/FEMININ[AO]/.test(u))return"feminino";if(/KIDS?|INFANTIL|INFATIL/.test(u))return"infantil";return"adulto"}
function commercialType(title,type,aud){const u=norm(title);if(aud==="infantil"||type==="kit"||type==="conjunto")return"infantil";if(aud==="feminino")return"feminino";if(/\b(PLAYER|JOGADOR)\b/.test(u))return"jogador";return"torcedor"}
function shouldKeep(title,type,aud){const u=norm(title);if(/\bRETRO\b/.test(u))return false;if(type==="corta-vento"||type==="treino"||type==="viagem"||type==="shorts")return false;if(type==="camisa"||type==="regata")return true;if((type==="kit"||type==="conjunto")&&aud==="infantil")return true;return false}
function titleCase(value){return clean(value).toLowerCase().split(/\s+/).map(w=>w?`${w[0].toUpperCase()}${w.slice(1)}`:w).join(" ")}

async function collect(options){
  const { chromium } = await import("playwright");
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1200},locale:"pt-BR"});
  const page=await context.newPage();
  const network=new Map();
  page.on("request",req=>{const url=req.url();const k=mediaKey(url);if(k&&!network.has(k))network.set(k,{mediaKey:k,directUrl:url,highQualityUrl:highQualityUrl(url),source:"network"})});
  await page.goto(options.url,{waitUntil:"domcontentloaded",timeout:90000});
  await page.waitForTimeout(2500);
  for(const label of ["Aceitar tudo","Aceitar","I agree","Accept all","Entendi","Continuar"]){try{const b=page.getByRole("button",{name:label,exact:false}).first();if(await b.isVisible({timeout:150}))await b.click()}catch{}}
  const root=await page.evaluate(()=>{const candidates=[document.scrollingElement,...document.querySelectorAll("*")].filter(Boolean);let best=document.scrollingElement,score=-1;for(const el of candidates){const s=getComputedStyle(el),d=el.scrollHeight-el.clientHeight;if(d<300)continue;if(el!==document.scrollingElement&&!/(auto|scroll|overlay)/.test(s.overflowY))continue;const sc=d*Math.max(1,el.clientWidth);if(sc>score){best=el;score=sc}}if(!best.dataset.bigCollectorId)best.dataset.bigCollectorId=`big-${Math.random().toString(36).slice(2)}`;return best.dataset.bigCollectorId});
  const dom=new Map(), titles=new Map(); let prev="",idle=0;
  for(let round=1;round<=350;round+=1){
    const obs=await page.evaluate((id)=>{const r=document.querySelector(`[data-big-collector-id="${id}"]`)||document.scrollingElement;const rr=r===document.scrollingElement?{top:0,left:0}:r.getBoundingClientRect();const st=r.scrollTop||window.scrollY||0;const pos=(rect)=>({top:Math.round(rect.top-rr.top+st),left:Math.round(rect.left-rr.left),width:Math.round(rect.width),height:Math.round(rect.height)});const mediaRe=/(?:googleusercontent\.com|usercontent\.google\.com|ggpht\.com)/i,urlRe=/https:\/\/[^\s"'()<>]+/g;const urls=[],texts=[];for(const el of document.querySelectorAll("*")){const rect=el.getBoundingClientRect();if(rect.width<=0||rect.height<=0)continue;for(const a of el.attributes||[]){if(!mediaRe.test(a.value))continue;for(const m of a.value.match(urlRe)||[])urls.push({url:m.replace(/&amp;/g,"&"),...pos(rect)})}}for(const el of document.querySelectorAll('h1,h2,h3,h4,[role="heading"],div,span,p')){if(el.children.length>5)continue;const text=(el.innerText||el.textContent||"").replace(/\s+/g," ").trim();if(text.length<5||text.length>180)continue;const rect=el.getBoundingClientRect();if(rect.width<20||rect.height<10||rect.height>240)continue;texts.push({text,...pos(rect)})}return{scrollTop:st,scrollHeight:r.scrollHeight,clientHeight:r.clientHeight,urls,texts}},root);
    for(const item of obs.urls){const k=mediaKey(item.url);if(k&&!dom.has(k))dom.set(k,{...item,mediaKey:k,directUrl:item.url,highQualityUrl:highQualityUrl(item.url)})}
    for(const item of obs.texts){if(!looksLikeTitle(item.text))continue;const k=`${clean(item.text)}\0${Math.round(item.top/4)}`;if(!titles.has(k))titles.set(k,{...item,text:clean(item.text)})}
    const sig=`${obs.scrollTop}|${obs.scrollHeight}|${dom.size}|${network.size}|${titles.size}`;idle=sig===prev?idle+1:0;prev=sig;const atBottom=obs.scrollTop+obs.clientHeight>=obs.scrollHeight-16;if(atBottom&&idle>=6)break;await page.evaluate((id)=>{const r=document.querySelector(`[data-big-collector-id="${id}"]`)||document.scrollingElement;const step=Math.max(350,Math.floor(r.clientHeight*.72));r.scrollTop=Math.min(r.scrollHeight-r.clientHeight,r.scrollTop+step);r.dispatchEvent(new Event("scroll",{bubbles:true}))},root);await sleep(700);
  }
  const titleList=[...titles.values()].sort((a,b)=>a.top-b.top||a.left-b.left).filter((t,i,a)=>!(i&&a[i-1].text===t.text&&Math.abs(a[i-1].top-t.top)<=96));
  const firstTop=titleList[0]?.top??Infinity;
  const media=new Map(network);for(const [k,v] of dom){if(!media.has(k))media.set(k,v);else Object.assign(media.get(k),v)}
  const imgs=[...media.values()].filter(i=>Number.isFinite(i.top)&&i.top>=firstTop&&i.width>=120&&i.height>=120).sort((a,b)=>a.top-b.top||a.left-b.left);
  const groups=titleList.map((t,i)=>({index:i+1,title:t.text,top:t.top,images:[]}));const ungrouped=[];
  for(const image of imgs){let chosen=-1;for(let i=0;i<titleList.length;i+=1){if(titleList[i].top<=image.top+20)chosen=i;else break}if(chosen<0)ungrouped.push(image);else groups[chosen].images.push(image)}
  await browser.close();
  const nonempty=groups.filter(g=>g.images.length);
  if(!nonempty.length)throw new Error(`${options.team}: nenhum grupo de produto encontrado.`);
  return {groups:nonempty,ungrouped,stats:{titles:titleList.length,groups:nonempty.length,images:imgs.length,ungrouped:ungrouped.length}};
}

function buildPlan(options,collected){
  const parsed=[];
  for(const group of collected.groups){
    const t=group.title,type=classifyType(t),aud=audience(t);if(!shouldKeep(t,type,aud))continue;
    const brand=t.match(BRAND_RE)?.[1]?.toUpperCase()??null;
    const season=t.match(SEASON_RE)?.[1]?.replace(/\s+/g,"")??null;
    const mm=t.match(MODEL_RE);const model=(mm?.[1]||mm?.[2]||mm?.[3])?.toUpperCase()??null;
    const ctype=commercialType(t,type,aud);
    const baseKey=[norm(options.team),type,season||"",model||"",brand||"",aud].join("|");
    parsed.push({group,type,aud,brand,season,model,ctype,baseKey});
  }
  const byBase=new Map();for(const item of parsed){if(!byBase.has(item.baseKey))byBase.set(item.baseKey,[]);byBase.get(item.baseKey).push(item)}
  const products=[];
  for(const [baseKey,items] of byBase){
    const p=items[0];const productType=p.type==="regata"?"Regata":p.type==="camisa"?"Camisa":"Conjunto Infantil";
    const name=[options.team,"—",productType,p.model,p.season,p.brand].filter(Boolean).join(" ").replace(/\s+/g," ").trim();
    const counts=new Map();for(const i of items)counts.set(i.ctype,(counts.get(i.ctype)||0)+1);const seen=new Map();
    const variants=items.map((i)=>{const occ=(seen.get(i.ctype)||0)+1;seen.set(i.ctype,occ);const total=counts.get(i.ctype);const code=total>1?`${i.ctype}-${String(occ).padStart(2,"0")}`:i.ctype;return{code,name:total>1?`${titleCase(i.ctype)} ${String(occ).padStart(2,"0")}`:titleCase(i.ctype),commercialType:i.ctype,price:PRICES[i.ctype],stock:999,sourceTitle:i.group.title,images:i.group.images.map((im,j)=>({sourceKey:`google_photos:${im.mediaKey}`,url:im.highQualityUrl||im.directUrl,sortOrder:j,primary:j===0}))}});
    const ctype=variants[0].commercialType,price=variants[0].price;
    const sourceKey=`gphotos:${crypto.createHash("sha256").update(`${options.url}|${baseKey}`).digest("hex").slice(0,40)}`;
    products.push({sourceKey,sourceTitle:items[0].group.title,name,description:`${name}. Time: ${options.team}. Campeonato: ${options.competition}. Liga: ${options.league}. Versão ${titleCase(ctype)}. Disponível com as opções configuradas pela BIGofertas.`,category:{name:p.type==="conjunto"||p.type==="kit"?"Kids":"Camisas",slug:p.type==="conjunto"||p.type==="kit"?"infantil":"camisas"},competition:options.competition||null,league:options.league||null,team:options.team,season:p.season,brand:p.brand,audience:p.aud==="infantil"?"INFANTIL":p.aud==="feminino"?"FEMININO":"MASCULINO",commercialType:ctype,price,specifications:[p.brand?`Marca: ${p.brand}`:null,p.season?`Temporada: ${p.season}`:null,`Time: ${options.team}`,options.competition?`Campeonato: ${options.competition}`:null,options.league?`Liga: ${options.league}`:null,`Versão: ${titleCase(ctype)}`].filter(Boolean).join(" | "),personalizationEnabled:true,phraseEnabled:true,patches:PATCHES[options.groupId]??[],variants});
  }
  if(!products.length)throw new Error(`${options.team}: nenhum produto elegível após filtros.`);
  const variants=products.reduce((s,p)=>s+p.variants.length,0),images=products.reduce((s,p)=>s+p.variants.reduce((x,v)=>x+v.images.length,0),0);
  return{schemaVersion:1,batchKey:`temp-worker:${options.groupId}:${slug(options.team)}`,sourceAlbumUrl:options.url,pdfGroupId:options.groupId,pdfGroupName:options.groupName,sourceGroup:options.team,mode:"club",products,summary:{products:products.length,variants,images},collectorStats:collected.stats};
}

const options=parseArgs();
const collected=await collect(options);
const plan=buildPlan(options,collected);
fs.mkdirSync(path.dirname(path.resolve(options.output)),{recursive:true});
fs.writeFileSync(path.resolve(options.output),JSON.stringify(plan,null,2)+"\n","utf8");
console.log(`TEMP_CATALOG_PLAN_OK group=${options.groupId} team=${options.team} products=${plan.summary.products} variants=${plan.summary.variants} images=${plan.summary.images} ungrouped=${plan.collectorStats.ungrouped}`);
