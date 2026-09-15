'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
module.exports = function harness() {
  const state = {writes:0, failAt:0, failAfter:false, tables:{}, locked:false};
  class Range {
    constructor(sheet,r,c,n,m) { Object.assign(this,{sheet,r,c,n,m}); }
    getValues() { return Array.from({length:this.n},(_,i)=>Array.from({length:this.m},(_,j)=>this.sheet.rows[this.r-1+i]?.[this.c-1+j] ?? '')); }
    setValues(values) {
      state.writes++;
      const fail = state.failAt === state.writes;
      if (fail && !state.failAfter) throw Error('injected before write');
      values.forEach((row,i)=>row.forEach((value,j)=>{ this.sheet.rows[this.r-1+i] ||= []; this.sheet.rows[this.r-1+i][this.c-1+j] = typeof value === 'string' && /^'[=+\-@]/.test(value) ? value.slice(1) : value; }));
      if (fail && state.failAfter) throw Error('injected lost acknowledgment');
      return this;
    }
  }
  class Sheet {
    constructor(headers) { this.rows = [headers.slice()]; }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return this.rows[0].length; }
    getDataRange() { return this.getRange(1,1,this.getLastRow(),this.getLastColumn()); }
    getRange(r,c,n,m) { return new Range(this,r,c,n,m); }
  }
  const props = {SPREADSHEET_ID:'fake'};
  const book = {getSheetByName:n=>state.tables[n] || null};
  const context = vm.createContext({console, Date, JSON, Math, Object, Array, String, Number, Boolean, isFinite,
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(algorithm,value)=>Array.from(crypto.createHash(algorithm).update(value).digest())},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k],setProperty:(k,v)=>{props[k]=v;}})},
    SpreadsheetApp:{openById:()=>book},
    LockService:{getScriptLock:()=>({waitLock:()=>{if(state.locked)throw Error('nested lock');state.locked=true;},releaseLock:()=>{state.locked=false;}})}
  });
  function load(names) { names.forEach(name=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..','app',name+'.gs'),'utf8'),context,{filename:name+'.gs'})); }
  load(['Sheets','Operations','Outbox','Backup']);
  function table(name,headers) { state.tables[name] = new Sheet(headers); }
  Object.entries(context.OPERATION_SCHEMA_).forEach(([name,headers])=>table(name,headers));
  table('NotificationOutbox',context.OUTBOX_HEADERS_); table('Items',['id','value']); table('Events',['id','itemId','value']);
  return {c:context,state,table,load,rows:name=>context.readTable_(name),plain:value=>JSON.parse(JSON.stringify(value))};
};
