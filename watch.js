(function(root){
  'use strict';
  const E=typeof module!=='undefined'&&module.exports?require('./engine'):root.StackLensEngine;
  const LIMIT=200,MAX_WATCHES=32,MAX_ADDRESS=(1n<<64n)-1n;
  const formats={signed:'有符号整数',unsigned:'无符号整数',hex:'十六进制',bytes:'字节',text:'UTF-8 文本'};
  function memoryOperand(text){
    const ins=E.parseInstruction('leaq '+text+', %rax',0),op=ins.args[0];
    if(ins.args.length!==2||op.kind!=='mem'||op.indirect)throw new Error('请输入内存地址或 AT&T 寻址表达式，例如 -8(%rbp)');
    if(op.base==='rip')throw new Error('变量监视请用标签或绝对地址代替 RIP 相对寻址');
    E.expression(op.expr,{},true);
    return op;
  }
  function normalize(value){
    if(!value||typeof value!=='object')throw new Error('变量设置格式错误');
    const name=String(value.name||'').trim(),expression=String(value.expression||'').trim();
    if(!name||name.length>64)throw new Error('变量名需要 1–64 个字符');
    if(!expression||expression.length>160||/[\r\n;]/.test(expression))throw new Error('位置表达式需要 1–160 个字符，且只能有一行');
    if(!['register','memory'].includes(value.kind)||!Object.hasOwn(formats,value.format))throw new Error('请选择有效的变量位置和显示类型');
    const def={id:String(value.id||''),name,kind:value.kind,expression,format:value.format};
    if(def.kind==='register'){
      def.expression=expression.replace(/^%/,'').toLowerCase();
      if(!Object.hasOwn(E.regs,def.expression))throw new Error('未知寄存器：'+expression);
      if(!['signed','unsigned','hex'].includes(def.format))throw new Error('寄存器支持整数或十六进制显示');
      def.size=E.regs[def.expression].bits/8;
    }else{
      memoryOperand(expression);
      def.size=Number(value.size);
      if(!Number.isInteger(def.size)||def.size<1||def.size>64||(!['bytes','text'].includes(def.format)&&![1,2,4,8].includes(def.size)))throw new Error('整数宽度为 1、2、4、8 字节；字节或文本长度为 1–64');
      def.mode=value.mode||'follow';
      if(!['follow','fixed'].includes(def.mode))throw new Error('无效的地址跟踪方式');
      if(def.mode==='fixed'&&value.address!==undefined){
        let address;try{address=BigInt(value.address);}catch{throw new Error('固定地址格式错误');}
        if(address<0n||address>MAX_ADDRESS)throw new Error('固定地址超出 64 位范围');
        def.address=E.hex(address);
      }
    }
    return def;
  }
  function resolve(machine,def){
    if(def.mode==='fixed'&&def.address!==undefined)return BigInt(def.address);
    const op=memoryOperand(def.expression);
    let address=E.expression(op.expr,machine.program.symbols);
    if(op.base)address+=machine.readReg(op.base,false);
    if(op.index)address+=machine.readReg(op.index,false)*BigInt(op.scale);
    return BigInt.asUintN(64,address);
  }
  function sample(machine,def){
    let location=def.kind==='register'?'%'+def.expression:def.expression,address=null;
    try{
      let bytes,value;
      if(def.kind==='register'){
        value=machine.readReg(def.expression,false);bytes=E.bytesLE(value,def.size);
      }else{
        address=resolve(machine,def);location=E.hex(address);
        if(address+BigInt(def.size)-1n>MAX_ADDRESS)throw new Error('读取范围超出 64 位地址空间');
        bytes=[];
        for(let i=0;i<def.size;i++){
          const at=address+BigInt(i),region=machine.regionAt(at);
          if(!region)throw new Error('未映射：'+E.hex(at));
          if(region.readable===false)throw new Error('不可读：'+E.hex(at));
          bytes.push(machine.memory.get(at)??0);
        }
        value=bytes.reduceRight((n,b)=>(n<<8n)|BigInt(b),0n);
      }
      const raw=bytes.map(b=>b.toString(16).padStart(2,'0')).join(' ');
      let display;
      if(def.format==='bytes')display=raw;
      else if(def.format==='text'){const zero=bytes.indexOf(0);display=JSON.stringify(new TextDecoder().decode(Uint8Array.from(zero<0?bytes:bytes.slice(0,zero))));}
      else if(def.format==='hex')display=E.hex(value,def.size*2);
      else display=(def.format==='signed'?BigInt.asIntN(def.size*8,value):value).toString();
      return {available:true,location,address:address===null?null:E.hex(address),display,raw,key:location+':'+raw};
    }catch(error){return {available:false,location,address:address===null?null:E.hex(address),display:'暂不可读',error:error.message,raw:'',key:location+':'+error.message};}
  }
  // Storage identity, never value equality, establishes a data-flow relationship.
  const COPY_LIMIT=256;
  function overlap(a,b){return a.kind===b.kind&&a.name===b.name&&a.start<b.start+BigInt(b.size)&&b.start<a.start+BigInt(a.size);}
  function locationKey(at){return [at.kind,at.name||'',at.start,at.size].join(':');}
  function bindingLocation(item){
    if(!item.current.available)return null;
    if(item.def.kind==='memory')return {kind:'mem',start:BigInt(item.current.address),size:item.def.size};
    const r=E.regs[item.def.expression];return {kind:'reg',name:r.name,start:BigInt(r.shift/8),size:r.bits/8};
  }
  function writtenLocation(w){
    if(w.kind==='mem')return {kind:'mem',start:w.address,size:w.bits/8};
    const r=E.regs[w.name];return {kind:'reg',name:r.name,start:BigInt(r.shift/8),size:r.bits===32?8:r.bits/8};
  }
  function copyKey(c){return [locationKey(c.at),c.offset,c.originSize,c.raw,c.location,c.extension].join('|');}
  function copyThrough(c,t){
    if(!overlap(c.at,t.from))return null;
    const start=c.at.start>t.from.start?c.at.start:t.from.start;
    const end=c.at.start+BigInt(c.at.size)<t.from.start+BigInt(t.from.size)?c.at.start+BigInt(c.at.size):t.from.start+BigInt(t.from.size);
    const size=Number(end-start),delta=Number(start-c.at.start),targetDelta=Number(start-t.from.start);
    // An extension represents a transformed whole value, not extra source bytes.
    if(c.extension&&(delta!==0||size!==c.at.size))return null;
    let extension=c.extension,atSize=size;
    if(t.extension&&size===t.from.size){extension=extension?extension+','+t.extension:t.extension;atSize=t.to.size;}
    return {...c,at:{...t.to,start:t.to.start+BigInt(targetDelta),size:atSize},offset:c.offset+delta,originSize:c.extension?c.originSize:size,extension};
  }
  function advanceCopies(item,event,machine){
    const writes=(event?.writes||[]).map(writtenLocation),before=item.copies;
    const history=machine.history.at(-1);
    const invalidMemory=at=>{
      if(at.kind!=='mem'||!history)return false;
      for(let i=0;i<at.size;i++){
        const address=at.start+BigInt(i),region=machine.regionAt(address);
        if(history.changes.has(address)||!region||region.readable===false||!history.snapshot.regions.includes(region))return true;
      }
      return false;
    };
    let next=before.filter(c=>!writes.some(w=>overlap(c.at,w))&&!invalidMemory(c.at));
    const at=bindingLocation(item),sources=at?[{at,offset:0,originSize:item.def.size,raw:item.current.raw,location:item.current.location,extension:''},...before]:before;
    for(const transfer of event?.transfers||[]){
      const added=new Set();
      for(const source of sources){
        const copy=copyThrough(source,transfer);if(!copy)continue;
        const key=locationKey(copy.at);
        // A fresh read of the watched storage takes precedence over an older copy there.
        if(added.has(key))continue;added.add(key);next.push(copy);
      }
    }
    next=[...new Map(next.map(c=>[copyKey(c),c])).values()].slice(-COPY_LIMIT);
    return next.length===before.length&&next.every((c,i)=>copyKey(c)===copyKey(before[i]))?before:next;
  }
  function registerView(item,c,registers){
    const at=c.at,r=Object.entries(E.regs).find(([,r])=>r.name===at.name&&BigInt(r.shift/8)===at.start&&r.bits/8===at.size);
    const register=r?r[0].toUpperCase():at.name.toUpperCase()+'['+Number(at.start)*8+':'+(Number(at.start)+at.size)*8+']';
    const label=item.def.name+(c.offset===0&&c.originSize===item.def.size?'':'['+c.offset+':'+(c.offset+c.originSize)+']');
    const slice=raw=>raw.split(' ').slice(c.offset,c.offset+c.originSize).join(' ');
    const value=E.hex(BigInt.asUintN(at.size*8,registers[at.name]>>(at.start*8n)),at.size*2);
    return {id:item.def.id,fullName:at.name,register,label,value,extension:c.extension,stale:!item.current.available||item.current.location!==c.location||slice(item.current.raw)!==slice(c.raw),at};
  }
  function registerViews(item,registers){return item.copies.filter(c=>c.at.kind==='reg').map(c=>registerView(item,c,registers));}
  const viewKey=views=>views.map(v=>[v.register,v.label,v.value,v.extension,v.stale].join(':')).sort().join('|');
  class Tracker{
    constructor(machine,definitions=[]){
      if(!Array.isArray(definitions)||definitions.length>MAX_WATCHES)throw new Error('最多添加 '+MAX_WATCHES+' 个变量监视');
      this.machine=machine;this.items=[];this.serial=0;
      for(const def of definitions)this.add(def);
    }
    prepare(value){
      const def=normalize(value);
      if(def.kind==='memory'&&def.mode==='fixed'&&def.address===undefined){
        const current=sample(this.machine,def);
        if(!current.available)throw new Error('先运行到变量地址有效的位置，再固定地址。'+current.error);
        def.address=current.address;
      }
      return def;
    }
    add(value){
      if(this.items.length>=MAX_WATCHES)throw new Error('最多添加 '+MAX_WATCHES+' 个变量监视');
      const def=this.prepare(value);
      if(!/^[a-zA-Z0-9_-]{1,80}$/.test(def.id)||this.items.some(item=>item.def.id===def.id)){
        do{def.id='watch-'+(++this.serial);}while(this.items.some(item=>item.def.id===def.id));
      }
      const item={def,current:sample(this.machine,def),records:[],startStep:this.machine.steps,copies:[],copyHistory:[]};
      this.items.push(item);return item;
    }
    update(id,value){
      const item=this.items.find(x=>x.def.id===id);if(!item)throw new Error('变量已移除');
      const def=this.prepare({...value,id});
      const binding=d=>JSON.stringify({...d,name:''});
      if(binding(def)!==binding(item.def)){item.records=[];item.startStep=this.machine.steps;item.current=sample(this.machine,def);item.copies=[];item.copyHistory=[];}
      item.def=def;return item;
    }
    remove(id){this.items=this.items.filter(x=>x.def.id!==id);}
    definitions(){return this.items.map(x=>({...x.def}));}
    registerCopies(id){
      return this.items.filter(item=>!id||item.def.id===id).flatMap(item=>{
        const copies=registerViews(item,this.machine.regs),at=bindingLocation(item);
        if(item.def.kind==='register'&&at){
          const direct=registerView(item,{at,offset:0,originSize:item.def.size,raw:item.current.raw,location:item.current.location,extension:''},this.machine.regs);
          direct.bound=true;copies.unshift(direct);
        }
        const seen=new Set();
        return copies.filter(c=>{const key=c.register+'|'+c.label;if(seen.has(key))return false;seen.add(key);return true;});
      });
    }
    capture(){
      const m=this.machine;
      // Faulting instructions roll back atomically and do not create a new step.
      if(m.status==='fault')return;
      for(const item of this.items){
        const before=item.current,copyBefore=registerViews(item,m.history.at(-1)?.snapshot.regs||m.regs),next=sample(m,item.def),copies=advanceCopies(item,m.lastEvent,m);
        if(copies!==item.copies){item.copies=copies;item.copyHistory.push({step:m.steps,copies});if(item.copyHistory.length>2001)item.copyHistory.shift();}
        item.current=next;const copyAfter=registerViews(item,m.regs);
        if(next.key!==before.key||viewKey(copyBefore)!==viewKey(copyAfter)){
          item.records.push({step:m.steps,instruction:m.lastEvent?.instruction||'',address:m.lastEvent?.address===undefined?'':E.hex(m.lastEvent.address),before,after:next,copyBefore,copyAfter});
          if(item.records.length>LIMIT)item.records.shift();
        }
      }
    }
    rewind(){
      for(const item of this.items){item.records=item.records.filter(r=>r.step<=this.machine.steps);item.startStep=Math.min(item.startStep,this.machine.steps);item.current=sample(this.machine,item.def);item.copyHistory=item.copyHistory.filter(r=>r.step<=this.machine.steps);item.copies=item.copyHistory.at(-1)?.copies||[];}
    }
  }
  const api={Tracker,normalize,sample,resolve,formats,LIMIT,MAX_WATCHES};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;root.StackLensWatch=api;
})(typeof globalThis!=='undefined'?globalThis:this);
