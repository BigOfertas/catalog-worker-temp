import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "process-album.mjs");
let source = fs.readFileSync(sourcePath, "utf8");

const needle = String.raw`for(const a of el.attributes||[]){if(!mediaRe.test(a.value))continue;for(const m of a.value.match(urlRe)||[])urls.push({url:m.replace(/&amp;/g,"&"),...pos(rect)})}`;
const replacement = String.raw`for(const a of el.attributes||[]){if(!mediaRe.test(a.value))continue;for(const m of a.value.match(urlRe)||[])urls.push({url:m.replace(/&amp;/g,"&"),...pos(rect)})}for(const pseudo of [null,"::before","::after"]){let bg="";try{bg=getComputedStyle(el,pseudo).backgroundImage||""}catch{bg=""}if(!mediaRe.test(bg))continue;for(const m of bg.match(urlRe)||[])urls.push({url:m.replace(/["')]+$/g,""),...pos(rect)})}`;

if (!source.includes(needle)) {
  throw new Error("process-album.mjs mudou: trecho de coleta esperado não foi encontrado.");
}
source = source.replace(needle, replacement);
source = source.replace(
  'if(!nonempty.length)throw new Error(`${options.team}: nenhum grupo de produto encontrado.`);',
  'if(!nonempty.length)throw new Error(`${options.team}: nenhum grupo de produto encontrado (titles=${titleList.length} images=${imgs.length} dom=${dom.size} network=${network.size}).`);',
);

const runtimeDir = path.resolve(".artifacts/runtime");
fs.mkdirSync(runtimeDir, { recursive: true });
const runtimePath = path.join(runtimeDir, "process-album-sparse-runtime.mjs");
fs.writeFileSync(runtimePath, source, "utf8");
await import(pathToFileURL(runtimePath).href);
