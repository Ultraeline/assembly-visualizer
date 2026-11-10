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
  let formulaSerial=0;
  const FORMULA_NODES=63,FORMULA_DEPTH=10;
  function leaves(node){return node.kind==='variable'?[node]:node.kind==='summary'?node.refs:node.args.flatMap(leaves);}
  function formulaNode(kind,bits,value,args=[],extra={},step=0){
    step=step||Math.max(0,...args.map(a=>a.step||0));
    const ids=[...new Set(kind==='variable'?[extra.id]:args.flatMap(n=>n.ids))];
    const count=1+args.reduce((n,a)=>n+a.count,0),depth=1+Math.max(0,...args.map(a=>a.depth));
    // Ownership follows the value being changed; dependencies also include read-only inputs.
    const owners=kind==='variable'?[extra.id]:['deref','compose'].includes(kind)?ids:kind==='address'&&!args[0]?.owners.length?ids:args[0]?.owners||[];
    const common={key:++formulaSerial,bits,value:BigInt.asUintN(bits,value),ids,owners,step,calculated:['binary','unary','deref','address'].includes(kind)||args.some(a=>a.calculated)};
    if(count>FORMULA_NODES||depth>FORMULA_DEPTH){
      const refs=[...new Map(args.flatMap(leaves).map(n=>[n.id,n])).values()];
      return {...common,kind:'summary',args:[],refs,step,count:1,depth:1,calculated:true};
    }
    return {...common,kind,args,count,depth,...extra};
  }
  function leafFormula(item,c){
    const raw=c.raw.split(' ').slice(c.offset,c.offset+c.originSize).join(' '),value=raw.split(' ').reduceRight((v,b)=>(v<<8n)|BigInt(parseInt(b,16)),0n);
    return formulaNode('variable',c.originSize*8,value,[],{id:item.def.id,name:item.def.name,offset:c.offset,size:c.originSize,totalSize:item.def.size,raw,location:c.location});
  }
  function sliceFormula(node,offset,size){
    if(!offset&&size*8===node.bits)return node;
    // Reading original low bits cancels a preceding extension exactly.
    if(node.kind==='cast'&&(offset+size)*8<=node.args[0].bits)return sliceFormula(node.args[0],offset,size);
    const value=node.value>>BigInt(offset*8);
    if(node.kind==='variable')return formulaNode('variable',size*8,value,[],{id:node.id,name:node.name,offset:node.offset+offset,size,totalSize:node.totalSize,raw:node.raw.split(' ').slice(offset,offset+size).join(' '),location:node.location});
    return formulaNode('slice',size*8,value,[node],{offset});
  }
  function extendFormula(node,bits,mode){return formulaNode('cast',bits,mode==='sign'?BigInt.asIntN(node.bits,node.value):node.value,[node],{mode});}
  const operator={add:['+',4],sub:['−',4],imul:['×',5],and:['&',3],xor:['^',2],or:['|',1]};
  function formatFormula(node,items,parent=0){
    if(node.kind==='variable'){const name=items.find(i=>i.def.id===node.id)?.def.name||node.name||'已移除变量';return name+(node.offset===0&&node.size===node.totalSize?'':'['+node.offset+':'+(node.offset+node.size)+']');}
    if(node.kind==='constant'){if(node.radix===16)return E.hex(node.value);const value=BigInt.asIntN(node.bits,node.value).toString();return value.startsWith('-')&&parent?'('+value+')':value;}
    if(node.kind==='summary')return '阶段值@'+node.step;
    if(node.kind==='address')return formatFormula(node.args[0],items,parent);
    if(node.kind==='deref'){const child=node.args[0];return '*'+(child.kind==='variable'?formatFormula(child,items):'('+formatFormula(child,items)+')');}
    if(node.kind==='cast')return (node.mode==='sign'?'符号扩展':'零扩展')+node.bits+'('+formatFormula(node.args[0],items)+')';
    if(node.kind==='compose')return '拼接'+node.bits+'('+node.args.map((arg,i)=>'位['+node.offsets[i]*8+':'+(node.offsets[i]*8+arg.bits)+']='+ (arg.kind==='constant'?E.hex(arg.value,arg.bits/4):formatFormula(arg,items))).reverse().join('，')+')';
    if(node.kind==='slice')return (node.offset?'位['+node.offset*8+':'+(node.offset*8+node.bits)+']':'低'+node.bits+'位')+'('+formatFormula(node.args[0],items)+')';
    if(node.kind==='unary')return (node.op==='neg'?'−':'~')+'('+formatFormula(node.args[0],items)+')';
    const [symbol,precedence]=operator[node.op],text=formatFormula(node.args[0],items,precedence)+' '+symbol+' '+formatFormula(node.args[1],items,precedence+1);
    return precedence<parent?'('+text+')':text;
  }
  function formulaStale(node,items){return leaves(node).some(leaf=>{
    const current=items.find(i=>i.def.id===leaf.id)?.current;
    return !current?.available||current.location!==leaf.location||current.raw.split(' ').slice(leaf.offset,leaf.offset+leaf.size).join(' ')!==leaf.raw;
  });}
  function formulaInputs(node,items){
    const reads=n=>[...(n.kind==='deref'?['['+E.hex(n.address)+'] = '+E.hex(n.value,n.bits/4)+'（'+n.bits+' 位读取）']:[]),...(n.partialRead?['部分字节参与 '+n.bits+' 位读取，其余位采用执行时的值']:[]),...n.args.flatMap(reads)];
    return [...new Set([...leaves(node).map(leaf=>formatFormula(leaf,items)+' = '+E.hex(leaf.value,leaf.bits/4)),...reads(node)])].join('，');
  }
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
  function copyKey(c){return [locationKey(c.at),c.offset,c.originSize,c.raw,c.location,c.extension,c.formula?.key,c.zeroUpper].join('|');}
  function copyThrough(c,t){
    if(!overlap(c.at,t.from))return null;
    const start=c.at.start>t.from.start?c.at.start:t.from.start;
    const end=c.at.start+BigInt(c.at.size)<t.from.start+BigInt(t.from.size)?c.at.start+BigInt(c.at.size):t.from.start+BigInt(t.from.size);
    const size=Number(end-start),delta=Number(start-c.at.start),targetDelta=Number(start-t.from.start);
    // An extension represents a transformed whole value, not extra source bytes.
    if(c.extension&&!c.formula?.calculated&&(delta!==0||size!==c.at.size))return null;
    let extension=c.extension,atSize=size;
    if(t.extension&&size===t.from.size){extension=extension?extension+','+t.extension:t.extension;atSize=t.to.size;}
    let formula=c.formula?sliceFormula(c.formula,delta,size):null;
    if(formula&&t.extension&&size===t.from.size)formula=extendFormula(formula,t.to.size*8,t.extension);
    const zeroUpper=t.to.kind==='reg'&&t.to.start===0n&&targetDelta===0&&(t.to.size===4||(c.zeroUpper&&t.from.start===0n));
    return {...c,at:{...t.to,start:t.to.start+BigInt(targetDelta),size:atSize},offset:c.offset+delta,originSize:c.extension?c.originSize:size,extension,formula,zeroUpper};
  }
  function bindingCopy(item){
    const at=bindingLocation(item);if(!at)return null;
    const copy={at,offset:0,originSize:item.def.size,raw:item.current.raw,location:item.current.location,extension:''};
    copy.formula=leafFormula(item,copy);return copy;
  }
  // Rebuild a wider operand from named byte ranges plus the remaining observed bits.
  // A 4-byte watch must never silently stand for a whole 8-byte pointer.
  function partialOperandFormula(operand,bits,candidates,step){
    if(operand.at.size*8!==bits)return null;
    const bytes=Array(operand.at.size).fill(null);
    for(const c of candidates){
      if(!c.formula||!overlap(c.at,operand.at))continue;
      const copy=copyThrough(c,{from:operand.at,to:operand.at,extension:''});if(!copy)continue;
      const offset=Number(copy.at.start-operand.at.start),node=copy.formula;
      if(node.value!==BigInt.asUintN(node.bits,operand.value>>BigInt(offset*8)))continue;
      for(let i=0;i<copy.at.size;i++)if(!bytes[offset+i])bytes[offset+i]={node,offset:i};
    }
    if(!bytes.some(Boolean))return null;
    const args=[],offsets=[];
    for(let start=0;start<bytes.length;){
      const part=bytes[start];let end=start+1;
      while(end<bytes.length&&(part?bytes[end]?.node===part.node&&bytes[end].offset===part.offset+end-start:!bytes[end]))end++;
      offsets.push(start);args.push(part?sliceFormula(part.node,part.offset,end-start):formulaNode('constant',(end-start)*8,operand.value>>BigInt(start*8)));start=end;
    }
    if(args.length===2&&offsets[0]===0&&args[0].ids.length&&args[1].kind==='constant'&&args[1].value===0n)return {...extendFormula(args[0],bits,'zero'),partialRead:true};
    return formulaNode('compose',bits,operand.value,args,{offsets,partialRead:true},step);
  }
  function operandFormula(operand,bits,items,step=0){
    const constant=()=>formulaNode('constant',bits,operand.value);
    if(!operand.at)return constant();
    const dereference=dereferenceFormula(operand.at,operand.value,items,step);
    if(dereference)return dereference;
    const candidates=[...items.flatMap(i=>i.copies.filter(c=>c.formula?.calculated)),...items.map(bindingCopy).filter(Boolean),...items.flatMap(i=>i.copies)];
    for(const c of candidates){
      if(!c.formula||!overlap(c.at,operand.at))continue;
      const copy=copyThrough(c,{from:operand.at,to:operand.at,extension:''});if(!copy)continue;
      let node=copy.formula;
      if(locationKey(copy.at)!==locationKey(operand.at)){
        if(c.zeroUpper&&operand.at.kind==='reg'&&operand.at.start===0n&&operand.at.size===8&&copy.at.start===0n&&copy.at.size===4)node=extendFormula(node,64,'zero');
        else continue;
      }
      if(node.value===BigInt.asUintN(bits,operand.value))return node;
    }
    return partialOperandFormula(operand,bits,candidates,step)||constant();
  }
  function addressFormula(at,items,step=0,hexDisplacement=false){
    if(!at.pointer)return null;
    const p=at.pointer;let address=null;
    if(p.base)address=operandFormula(p.base,64,items,step);
    if(p.index){
      let index=operandFormula(p.index,64,items,step);
      if(p.scale!==1)index=formulaNode('binary',64,index.value*BigInt(p.scale),[index,formulaNode('constant',64,BigInt(p.scale))],{op:'imul'},step);
      address=address?formulaNode('binary',64,address.value+index.value,[address,index],{op:'add'},step):index;
    }
    if(!address?.ids.length)return null;
    if(p.displacement){const negative=p.displacement<0n,displacement=negative?-p.displacement:p.displacement;address=formulaNode('binary',64,at.start,[address,formulaNode('constant',64,displacement,[],{radix:hexDisplacement?16:10})],{op:negative?'sub':'add'},step);}
    return address;
  }
  function dereferenceFormula(at,value,items,step=0){
    if(at.kind!=='mem'||value===undefined)return null;
    const address=addressFormula(at,items,step);if(!address)return null;
    return formulaNode('deref',at.size*8,value,[address],{address:at.start},step);
  }
  function dereferencesFor(event,items){
    if(!items.length)return [];
    return (event?.transfers||[]).flatMap(t=>{
      let formula=dereferenceFormula(t.from,t.from.value,items,event.step);if(!formula)return [];
      if(t.extension)formula=extendFormula(formula,t.to.size*8,t.extension);
      return [{at:t.to,formula,offset:0,originSize:t.to.size,raw:'',location:'',extension:'',zeroUpper:t.to.kind==='reg'&&t.to.size===4}];
    });
  }
  function calculationsFor(event,items,step){
    if(!items.length)return [];
    return (event?.calculations||[]).flatMap(calc=>{
      if(calc.op==='lea'){
        const address=addressFormula(calc.address,items,step,true);if(!address)return [];
        let formula=formulaNode('address',64,calc.address.start,[address],{},step);
        if(calc.bits<64)formula=sliceFormula(formula,0,calc.bits/8);
        const before=operandFormula(calc.operands[0],calc.bits,items,step);
        const operation={op:'lea',at:calc.to,bits:calc.bits,before,source:null,after:formula,owners:formula.ids,ids:formula.ids};
        return [{at:calc.to,formula,operation,offset:0,originSize:calc.bits/8,raw:'',location:'',extension:'',zeroUpper:calc.bits===32}];
      }
      const args=calc.operands.map(operand=>operandFormula(operand,calc.bits,items,step));
      const formula=formulaNode(args.length===1?'unary':'binary',calc.bits,calc.result,args,{op:calc.op},step);
      const inPlace=calc.to.kind==='reg'&&calc.operands[0].at&&locationKey(calc.to)===locationKey(calc.operands[0].at);
      const operation=inPlace?{op:calc.op,at:calc.to,bits:calc.bits,before:args[0],source:args[1]||null,after:formula,owners:args[0].owners,ids:formula.ids}:null;
      return {at:calc.to,formula,operation,offset:0,originSize:calc.bits/8,raw:'',location:'',extension:'',zeroUpper:calc.to.kind==='reg'&&calc.to.size===4};
    }).filter(c=>c.formula.ids.length);
  }
  function advanceCopies(item,event,machine,calculations){
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
    const binding=bindingCopy(item),sources=[...before.filter(c=>c.formula?.calculated),...(binding?[binding]:[]),...before.filter(c=>!c.formula?.calculated)];
    for(const transfer of event?.transfers||[]){
      const added=new Set();
      for(const source of sources){
        const copy=copyThrough(source,transfer);if(!copy)continue;
        const key=locationKey(copy.at);
        // A fresh read of the watched storage takes precedence over an older copy there.
        if(added.has(key))continue;added.add(key);next.push(copy);
      }
    }
    for(const calculation of calculations.filter(c=>c.formula.ids.includes(item.def.id))){const {operation,...copy}=calculation;next=next.filter(c=>!overlap(c.at,copy.at));next.push(copy);}
    next=[...new Map(next.map(c=>[copyKey(c),c])).values()].slice(-COPY_LIMIT);
    return next.length===before.length&&next.every((c,i)=>copyKey(c)===copyKey(before[i]))?before:next;
  }
  function registerName(at){
    const r=Object.entries(E.regs).find(([,r])=>r.name===at.name&&BigInt(r.shift/8)===at.start&&r.bits/8===at.size);
    return r?r[0].toUpperCase():at.name.toUpperCase()+'['+Number(at.start)*8+':'+(Number(at.start)+at.size)*8+']';
  }
  function registerView(item,c,registers,items){
    const at=c.at,register=registerName(at);
    const calculated=!!c.formula?.calculated,label=calculated?formatFormula(c.formula,items):item.def.name+(c.offset===0&&c.originSize===item.def.size?'':'['+c.offset+':'+(c.offset+c.originSize)+']');
    const slice=raw=>raw.split(' ').slice(c.offset,c.offset+c.originSize).join(' ');
    const value=E.hex(BigInt.asUintN(at.size*8,registers[at.name]>>(at.start*8n)),at.size*2);
    return {id:item.def.id,fullName:at.name,register,label,value,extension:calculated?'':c.extension,calculated,bits:at.size*8,inputs:calculated?formulaInputs(c.formula,items):'',stale:calculated?formulaStale(c.formula,items):!item.current.available||item.current.location!==c.location||slice(item.current.raw)!==slice(c.raw),at};
  }
  function registerViews(item,registers,items){return item.copies.filter(c=>c.at.kind==='reg').map(c=>registerView(item,c,registers,items));}
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
      if(binding(def)!==binding(item.def)){this.forget(id);item.records=[];item.startStep=this.machine.steps;item.current=sample(this.machine,def);item.copies=[];item.copyHistory=[];}
      item.def=def;return item;
    }
    forget(id){
      const keep=c=>!c.formula?.ids.includes(id);
      for(const item of this.items){item.copies=item.copies.filter(keep);item.copyHistory=item.copyHistory.map(h=>({...h,copies:h.copies.filter(keep)}));for(const r of item.records)r.operations=(r.operations||[]).filter(op=>!op.ids.includes(id));}
    }
    remove(id){this.forget(id);this.items=this.items.filter(x=>x.def.id!==id);}
    definitions(){return this.items.map(x=>({...x.def}));}
    formatOperation(operation,format='hex'){
      const {op,bits,before,source,after}=operation,target=registerName(operation.at),label=source?formatFormula(source,this.items):'';
      const actions={add:'中加了 ',sub:'中减去了 ',imul:'中的值乘以 ',and:'中的值按位与 ',or:'中的值按位或 ',xor:'中的值按位异或 ',neg:'中的值取负',not:'中的值按位取反'};
      const display=node=>format==='signed'?BigInt.asIntN(bits,node.value).toString():format==='unsigned'?BigInt.asUintN(bits,node.value).toString():E.hex(node.value,bits/4);
      return {summary:op==='lea'?target+' 写入 LEA 计算结果':target+' '+actions[op]+label,target,bits,before:display(before),after:display(after),beforeExpression:formatFormula(before,this.items),afterExpression:formatFormula(after,this.items)};
    }
    latestOperation(id){
      const item=this.items.find(i=>i.def.id===id);if(!item)return null;
      const record=[...item.records].reverse().find(r=>r.operations?.length);
      return record?{step:record.step,...this.formatOperation(record.operations.at(-1),item.def.format)}:null;
    }
    registerCopies(id){
      const result=this.items.filter(item=>!id||item.def.id===id).flatMap(item=>{
        const copies=registerViews(item,this.machine.regs,this.items),at=bindingLocation(item);
        if(item.def.kind==='register'&&at&&!copies.some(c=>c.calculated&&locationKey(c.at)===locationKey(at))){
          const direct=registerView(item,{at,offset:0,originSize:item.def.size,raw:item.current.raw,location:item.current.location,extension:''},this.machine.regs,this.items);
          direct.bound=true;copies.unshift(direct);
        }
        const seen=new Set();
        return copies.filter(c=>{const key=c.register+'|'+c.label;if(seen.has(key))return false;seen.add(key);return true;});
      });
      const seen=new Set();
      return result.filter(c=>{if(!c.calculated)return true;const key=locationKey(c.at)+'|'+c.label;if(seen.has(key))return false;seen.add(key);return true;});
    }
    capture(){
      const m=this.machine;
      // Faulting instructions roll back atomically and do not create a new step.
      if(m.status==='fault')return;
      const calculations=[...calculationsFor(m.lastEvent,this.items,m.steps),...dereferencesFor(m.lastEvent,this.items)];
      // Resolve every operand and snapshot before changing any watch's current value.
      const updates=this.items.map(item=>({item,before:item.current,copyBefore:registerViews(item,m.history.at(-1)?.snapshot.regs||m.regs,this.items),next:sample(m,item.def),copies:advanceCopies(item,m.lastEvent,m,calculations)}));
      for(const {item,next,copies} of updates){
        if(copies!==item.copies){item.copies=copies;item.copyHistory.push({step:m.steps,copies});if(item.copyHistory.length>2001)item.copyHistory.shift();}
        item.current=next;
      }
      for(const {item,before,next,copyBefore} of updates){
        const copyAfter=registerViews(item,m.regs,this.items);
        const operations=calculations.flatMap(c=>c.operation?.owners.includes(item.def.id)?[c.operation]:[]);
        if(next.key!==before.key||viewKey(copyBefore)!==viewKey(copyAfter)||operations.length){
          item.records.push({step:m.steps,instruction:m.lastEvent?.instruction||'',address:m.lastEvent?.address===undefined?'':E.hex(m.lastEvent.address),before,after:next,copyBefore,copyAfter,operations});
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
