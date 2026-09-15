'use strict';
// Package local sources only. This never uploads, deploys, or changes an account.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),app=path.join(root,'app');
const name=process.argv[2];
if(!name || !/^[a-z0-9][a-z0-9-]{2,70}$/.test(name))throw Error('Provide a unique lowercase candidate name, for example foundation-test-001.');
const target=path.join(root,'release',name);
if(fs.existsSync(target))throw Error('Candidate already exists. Use a new name; existing evidence is never overwritten.');
const allow=fs.readFileSync(path.join(app,'.claspignore'),'utf8').split(/\r?\n/).filter(line=>line.startsWith('!')).map(line=>line.slice(1));
if(new Set(allow).size!==allow.length || !allow.includes('appsscript.json'))throw Error('Invalid deployment inventory.');
const files=allow.map(file=>{
  if(!/^[A-Za-z][A-Za-z0-9]*\.(gs|html|json)$/.test(file))throw Error('Unsafe deployment filename.');
  const bytes=fs.readFileSync(path.join(app,file));
  return {file,bytes,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
});
const manifest=JSON.parse(files.find(file=>file.file==='appsscript.json').bytes);
if(manifest.webapp?.executeAs!=='USER_DEPLOYING' || manifest.webapp?.access!=='DOMAIN')throw Error('Candidate does not use the intended domain-restricted execution model.');
const publicFunctions=files.filter(file=>file.file.endsWith('.gs')).flatMap(file=>Array.from(file.bytes.toString('utf8').matchAll(/^function\s+([A-Za-z0-9_]+)\s*\(/gm),match=>match[1])).filter(name=>!name.endsWith('_')).sort();
if(JSON.stringify(publicFunctions)!==JSON.stringify(['api','doGet','onOpen']))throw Error('Unexpected public server entry point.');
fs.mkdirSync(path.join(target,'app'),{recursive:true});
for(const file of files)fs.writeFileSync(path.join(target,'app',file.file),file.bytes);
const editor=path.join(target,'editor-install');fs.mkdirSync(editor);
const server=files.filter(file=>file.file.endsWith('.gs')).sort((a,b)=>a.file==='Logic.gs'?-1:b.file==='Logic.gs'?1:a.file.localeCompare(b.file));
const bundle=server.map(file=>'// Source file: '+file.file+'\n'+file.bytes.toString('utf8')).join('\n\n');
fs.writeFileSync(path.join(editor,'Server.gs'),bundle);
for(const file of files.filter(file=>!file.file.endsWith('.gs')))fs.writeFileSync(path.join(editor,file.file),file.bytes);
const digest=crypto.createHash('sha256').update(JSON.stringify(files.map(({file,sha256})=>({file,sha256})))).digest('hex');
fs.writeFileSync(path.join(target,'PACKAGE.json'),JSON.stringify({
  name,createdAt:new Date().toISOString(),status:'isolated-google-test-only',version:require('../package.json').version,
  sourceDigest:digest,publicFunctions,files:files.map(({file,sha256,bytes})=>({file,sha256,bytes:bytes.length})),
  editorBundle:{file:'editor-install/Server.gs',sha256:crypto.createHash('sha256').update(bundle).digest('hex'),sourceFiles:server.map(file=>file.file)},
  exclusions:['deployment identifiers','credentials','source history','local reports','live account bindings','live records'],
  limitation:'Packaging is an inventory check, not a test result or production approval.'
},null,2)+'\n');
for(const doc of ['google-test-plan.md','test-installation.md']) {
  const source=path.join(root,'docs',doc);if(fs.existsSync(source))fs.copyFileSync(source,path.join(target,doc));
}
console.log(JSON.stringify({directory:target,files:files.length,sourceDigest:digest}));
