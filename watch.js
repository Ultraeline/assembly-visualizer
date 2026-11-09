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
      const item={def,current:sample(this.machine,def),records:[],startStep:this.machine.steps};
      this.items.push(item);return item;
    }
    update(id,value){
      const item=this.items.find(x=>x.def.id===id);if(!item)throw new Error('变量已移除');
      const def=this.prepare({...value,id});
      const binding=d=>JSON.stringify({...d,name:''});
      if(binding(def)!==binding(item.def)){item.records=[];item.startStep=this.machine.steps;item.current=sample(this.machine,def);}
      item.def=def;return item;
    }
    remove(id){this.items=this.items.filter(x=>x.def.id!==id);}
    definitions(){return this.items.map(x=>({...x.def}));}
    capture(){
      const m=this.machine;
      // Faulting instructions roll back atomically and do not create a new step.
      if(m.status==='fault')return;
      for(const item of this.items){
        const next=sample(m,item.def);
        if(next.key!==item.current.key){
          item.records.push({step:m.steps,instruction:m.lastEvent?.instruction||'',address:m.lastEvent?.address===undefined?'':E.hex(m.lastEvent.address),before:item.current,after:next});
          if(item.records.length>LIMIT)item.records.shift();
        }
        item.current=next;
      }
    }
    rewind(){
      for(const item of this.items){item.records=item.records.filter(r=>r.step<=this.machine.steps);item.startStep=Math.min(item.startStep,this.machine.steps);item.current=sample(this.machine,item.def);}
    }
  }
  const api={Tracker,normalize,sample,resolve,formats,LIMIT,MAX_WATCHES};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;root.StackLensWatch=api;
})(typeof globalThis!=='undefined'?globalThis:this);
