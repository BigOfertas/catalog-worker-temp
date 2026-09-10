import fs from "node:fs";
import path from "node:path";
const root=process.argv[2]||"artifacts";
const output=process.argv[3]||"merged-plan.json";
const files=[];
function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,ent.name);if(ent.isDirectory())walk(p);else if(ent.name==="plan.json")files.push(p)}}
walk(root);
if(!files.length)throw new Error("Nenhum plan.json encontrado.");
const plans=files.map(f=>JSON.parse(fs.readFileSync(f,"utf8")));
const products=plans.flatMap(p=>p.products||[]);
const sourceKeys=products.map(p=>p.sourceKey);
if(new Set(sourceKeys).size!==sourceKeys.length)throw new Error("sourceKey duplicada entre planos.");
const merged={schemaVersion:1,batchKey:`temp-worker-merged-${Date.now()}`,products,summary:{albums:plans.length,products:products.length,variants:products.reduce((s,p)=>s+(p.variants?.length||0),0),images:products.reduce((s,p)=>s+(p.variants||[]).reduce((x,v)=>x+(v.images?.length||0),0),0)},albums:plans.map(p=>({group:p.pdfGroupId,team:p.sourceGroup,...p.summary}))};
fs.writeFileSync(output,JSON.stringify(merged,null,2)+"\n");
console.log(`TEMP_MERGE_OK albums=${merged.summary.albums} products=${merged.summary.products} variants=${merged.summary.variants} images=${merged.summary.images}`);
