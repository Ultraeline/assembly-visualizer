(function(root){
  'use strict';
  const fail=s=>{throw new Error(s);},hex=n=>'0x'+n.toString(16),encoder=new TextEncoder(),decoder=new TextDecoder();
  const names=['__libc_start_main','ferror','fread','getpid','fclose','mmap','memset','srand','__gmon_start__','munmap','fopen','fwrite'];
  const decode64=s=>typeof Buffer!=='undefined'?Uint8Array.from(Buffer.from(s,'base64')):Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  function image(bytes,name='program'){
    bytes=new Uint8Array(bytes);if(bytes.length>4194304)fail('ELF 文件不能超过 4 MiB');
    let base64;if(typeof Buffer!=='undefined')base64=Buffer.from(bytes).toString('base64');
    else {let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));base64=btoa(s);}
    const value={name,base64};parseELF(value);return value;
  }
  function parseELF(value){
    if(!value||typeof value.base64!=='string'||value.base64.length>5592416||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64))fail('ELF 数据无效');
    const bytes=decode64(value.base64),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const bounds=(p,n)=>{if(!Number.isSafeInteger(p)||!Number.isSafeInteger(n)||p<0||n<0||p+n>bytes.length)fail('ELF 文件被截断或偏移越界');};
    const u16=p=>{bounds(p,2);return view.getUint16(p,true);},u32=p=>{bounds(p,4);return view.getUint32(p,true);},u64=p=>{bounds(p,8);return view.getBigUint64(p,true);};
    const number=n=>{if(n>BigInt(Number.MAX_SAFE_INTEGER))fail('ELF 文件偏移过大');return Number(n);};
    bounds(0,64);if(bytes[0]!==127||decoder.decode(bytes.slice(1,4))!=='ELF'||bytes[4]!==2||bytes[5]!==1||u16(18)!==62)fail('请选择小端 x86-64 ELF 可执行文件');
    if(u16(16)!==2)fail('当前 ELF 装载支持固定地址 ET_EXEC；暂不支持 PIE / 共享库 / 目标文件');
    const entry=u64(24),phoff=number(u64(32)),shoff=number(u64(40)),phsize=u16(54),phnum=u16(56),shsize=u16(58),shnum=u16(60),shstr=u16(62);
    if(phsize<56||!phnum||phnum>256||shnum>4096||(shnum&&shsize<64))fail('ELF 头表尺寸不受支持');
    bounds(phoff,phsize*phnum);bounds(shoff,shsize*shnum);
    const segments=[];let total=0,phdr=0n;
    for(let i=0;i<phnum;i++){
      const p=phoff+i*phsize;if(u32(p)!==1)continue;
      const offset=number(u64(p+8)),address=u64(p+16),fileSize=number(u64(p+32)),size=number(u64(p+40)),flags=u32(p+4);
      bounds(offset,fileSize);if(size<fileSize||size>1048576||(total+=size)>4194304)fail('ELF 段过大或尺寸无效');
      if(size)segments.push({address,size,bytes:bytes.slice(offset,offset+fileSize),writable:!!(flags&2),executable:!!(flags&1)});
      if(phoff>=offset&&phoff+phsize*phnum<=offset+fileSize)phdr=address+BigInt(phoff-offset);
    }
    if(!segments.length)fail('ELF 没有可装载段');
    const sections=[];
    for(let i=0;i<shnum;i++){const p=shoff+i*shsize;const s={nameOffset:u32(p),type:u32(p+4),address:u64(p+16),offset:number(u64(p+24)),size:number(u64(p+32)),link:u32(p+40),entsize:number(u64(p+56))};if(s.type!==8)bounds(s.offset,s.size);sections.push(s);}
    const str=(s,n)=>{if(!s||s.type!==3||n>=s.size)fail('ELF 字符串索引无效');let end=s.offset+n;while(end<s.offset+s.size&&bytes[end])end++;if(end===s.offset+s.size)fail('ELF 字符串缺少结束符');return decoder.decode(bytes.slice(s.offset+n,end));};
    if(shnum&&!sections[shstr])fail('ELF 节名表缺失');
    for(const s of sections)s.name=str(sections[shstr],s.nameOffset);
    const symbolTables=new Map(),symbols={},functionSymbols=new Map();
    for(const [index,s]of sections.entries())if([2,11].includes(s.type)){
      if(s.entsize!==24||s.size%24)fail('ELF 符号表尺寸无效');const table=[];
      for(let p=s.offset;p<s.offset+s.size;p+=24){const name=str(sections[s.link],u32(p)),address=u64(p+8),size=number(u64(p+16)),defined=u16(p+6)!==0,weak=(bytes[p+4]>>4)===2;
        table.push({name,address,size,defined,weak});if(name&&defined){symbols[name]=address;if((bytes[p+4]&15)===2&&segments.some(seg=>seg.executable&&address>=seg.address&&address<seg.address+BigInt(seg.size)))functionSymbols.set(name,address);}}
      symbolTables.set(index,table);
    }
    const relocations=[],dynamic={};
    for(const s of sections){
      if(s.type===4){if(s.entsize!==24||s.size%24)fail('ELF 重定位表尺寸无效');const syms=symbolTables.get(s.link);if(!syms)fail('ELF 重定位缺少符号表');
        for(let p=s.offset;p<s.offset+s.size;p+=24){const info=u64(p+8),symbol=syms[number(info>>32n)];if(!symbol)fail('ELF 重定位符号无效');relocations.push({address:u64(p),type:Number(info&0xffffffffn),symbol,addend:BigInt.asIntN(64,u64(p+16))});}}
      if(s.type===6){if(s.entsize!==16||s.size%16)fail('ELF 动态表尺寸无效');for(let p=s.offset;p<s.offset+s.size;p+=16){const tag=u64(p);if(!tag)break;dynamic[tag.toString()]=u64(p+8);}}
    }
    if(!shnum)fail('当前 ELF 装载需要节表以读取动态符号与重定位');
    return {entry,segments,symbols,functionSymbols,relocations,dynamic,phdr,phnum,phsize,name:String(value.name||'program')};
  }
  function loadImage(m){
    m.externalMap=new Map(m.program.externalMap);if(!m.config.image)return;
    const elf=m.elf=parseELF(m.config.image);
    for(const ins of m.program.instructions){const seg=elf.segments.find(s=>s.executable&&ins.address>=s.address&&ins.address+BigInt(ins.length)<=s.address+BigInt(s.bytes.length));
      if(!seg||ins.bytes.some((b,i)=>b!==seg.bytes[Number(ins.address-seg.address)+i]))fail('ELF 与反汇编机器码不匹配：'+hex(ins.address)+'，请选取同一个程序的文件');}
    m.program.symbols={...elf.symbols,...m.program.symbols};
    for(const s of elf.segments){m.addRegion(s.address,s.size,s.executable?'ELF 代码 / 常量':'ELF 数据 / BSS',s.writable);s.bytes.forEach((b,i)=>m.memory.set(s.address+BigInt(i),b));}
    const write=(address,value)=>{m.checkMemory(address,8);for(let i=0;i<8;i++)m.memory.set(address+BigInt(i),Number((value>>BigInt(i*8))&255n));};
    let index=0;
    for(const r of elf.relocations){const name=r.symbol.name;
      if(r.type===0)continue;
      if(r.type===5){const handles={stdin:0x71000000n,stdout:0x71000100n,stderr:0x71000200n};if(!(name in handles)||r.symbol.size!==8)fail('暂不支持 ELF COPY 数据符号：'+name);write(r.address,handles[name]);}
      else if(r.type===6||r.type===7){let target;
        if(r.symbol.defined)target=r.symbol.address;
        else if(r.symbol.weak&&name==='__gmon_start__')target=0n;
        else{target=0x72000000n+BigInt(index++*16);m.externalMap.set(target,name);}
        write(r.address,target+r.addend);
      }else if(r.type===8)write(r.address,r.addend);
      else fail('暂不支持 ELF 重定位类型 '+r.type+'（'+name+'）');
    }
  }
  function initialize(m){
    if(m.config.pid!==undefined&&(!Number.isInteger(Number(m.config.pid))||Number(m.config.pid)<1||Number(m.config.pid)>2147483647))fail('教学 PID 需要 1..2147483647 的整数');
    m.runtime={streams:{'1895825408':{kind:'stdin',pos:0},'1895825664':{kind:'stdout',pos:0},'1895825920':{kind:'stderr',pos:0}},nextHandle:0x71000300n,nextMapping:0x50000000n,startup:null,exitCode:null};
    m.processMode=m.config.runtime==='linux'||(m.config.runtime!=='function'&&!!m.elf&&m.rip===m.elf.entry);
    if(!m.processMode)return;
    const argv=m.config.argv||[m.elf?.name||'program'],env=m.config.env||[];
    if(!Array.isArray(argv)||!Array.isArray(env)||argv.length>64||env.length>64||[...argv,...env].some(x=>typeof x!=='string'||x.includes('\0')))fail('参数与环境需为字符串数组（各最多 64 项，不含 NUL）');
    let sp=m.regs.rsp;
    const put=(a,bytes)=>{m.checkMemory(a,bytes.length,true);bytes.forEach((b,i)=>m.memory.set(a+BigInt(i),b));};
    const word=(a,n)=>put(a,Array.from({length:8},(_,i)=>Number((n>>BigInt(i*8))&255n)));
    const string=s=>{const b=encoder.encode(s+'\0');sp-=BigInt(b.length);put(sp,b);return sp;};
    const args=argv.map(string),envs=env.map(string);sp-=16n;put(sp,Array.from({length:16},(_,i)=>i+1));const random=sp;
    const aux=[6n,4096n,9n,m.rip,11n,1000n,12n,1000n,13n,1000n,14n,1000n,23n,0n,25n,random];
    if(m.elf?.phdr)aux.push(3n,m.elf.phdr,4n,BigInt(m.elf.phsize),5n,BigInt(m.elf.phnum));
    const words=[BigInt(args.length),...args,0n,...envs,0n,...aux,0n,0n];sp=(sp-BigInt(words.length*8))&~15n;words.forEach((v,i)=>word(sp+BigInt(i*8),v));
    m.regs.rsp=sp;m.regs.rdx=0n;m.runtime.initialStack={argc:BigInt(args.length),argv:sp+8n,envp:sp+BigInt((args.length+2)*8)};
  }
  function snapshot(r){return {...r,streams:Object.fromEntries(Object.entries(r.streams).map(([k,v])=>[k,{...v}])),startup:r.startup?{...r.startup,queue:[...r.startup.queue]}:null};}
  function grow(m,address){
    const r=m.regions.find(x=>x.growLimit!==undefined&&address<x.start&&address>=x.growLimit);if(!r)return null;
    const start=address&~4095n;if(m.regions.some(x=>x!==r&&start<x.end&&r.start>x.start))return null;
    const expanded={...r,start};m.regions=m.regions.map(x=>x===r?expanded:x);
    for(const [a,v]of m.memory)if(a>=start&&a<r.start){if(m.changes&&!m.changes.has(a))m.changes.set(a,v);m.memory.delete(a);}
    if(m.event)m.event.mapping='栈映射向低地址扩展到 '+hex(start)+'（按页增长，最多额外 1 MiB）';return expanded;
  }
  function bounded(n,limit=1048576){if(n<0n||n>BigInt(limit))fail('教学函数单次处理长度超过 '+limit+' 字节');return Number(n);}
  function call(m,address,ret,name){
    if(!m.program.map.has(address)&&!m.externalMap.has(address))fail('运行环境需要的函数未载入：'+hex(address));
    m.push(ret);m.rip=address;m.frames.push({id:++m.frameId,name:name||m.nameAt(address),entry:address,returnSlot:m.regs.rsp,returnAddress:ret,base:null,stackEntry:m.regs.rsp});
  }
  const CONT=0x73000000n;
  function arrayFunctions(m,tag,sizeTag){const d=m.elf?.dynamic||{},out=[];if(d[tag]){const n=bounded(d[sizeTag]||0n,65536);if(n%8)fail('ELF 初始化数组未对齐');for(let i=0;i<n;i+=8){const v=m.readMemory(d[tag]+BigInt(i),64);if(v&&v!==0xffffffffffffffffn)out.push(v);}}return out;}
  function advanceStartup(m){
    const s=m.runtime.startup;
    if(!s)fail('无效的启动流程返回地址');
    if(s.phase==='init'){
      if(s.queue.length){m.writeReg('edi',s.argc);m.writeReg('rsi',s.argv);m.writeReg('rdx',s.envp);call(m,s.queue.shift(),CONT);m.event.summary='启动模型调用初始化函数；函数内继续逐条执行。';return;}
      s.phase='main';m.writeReg('edi',s.argc);m.writeReg('rsi',s.argv);m.writeReg('rdx',s.envp);call(m,s.main,CONT,'main');m.event.summary='初始化完成，按 System V 参数约定调用 main。';return;
    }
    if(s.phase==='main'){m.runtime.exitCode=Number(BigInt.asIntN(32,m.regs.rax));s.phase='fini';s.queue=arrayFunctions(m,'26','28').reverse();const fini=m.elf?.dynamic['13'];if(fini)s.queue.push(fini);if(!m.elf&&s.fini)s.queue.push(s.fini);}
    if(s.queue.length){call(m,s.queue.shift(),CONT);m.event.summary='main 已返回，执行程序清理函数。';return;}
    m.status='halted';m.event.summary='进程运行结束，退出码 '+m.runtime.exitCode+'。';
  }
  function model(m,name){
    const r=m.runtime,reg=n=>m.readReg(n),finish=(value=0n,bits=32)=>{m.writeReg(bits===64?'rax':'eax',value);m.returnFromCall(0n);m.event.summary='教学环境模拟 '+name+'，返回 '+hex(BigInt.asUintN(bits,value))+'。';};
    const stream=h=>{const s=r.streams[h.toString()];if(!s)fail('无效或已关闭的教学文件句柄：'+hex(h));return s;};
    if(name==='[libc startup continuation]'){advanceStartup(m);return true;}
    if(name==='__libc_start_main'){
      if(r.startup)fail('__libc_start_main 不能重复启动');
      const main=reg('rdi'),argc=reg('rsi'),argv=reg('rdx'),init=reg('rcx'),fini=reg('r8');bounded(argc,64);
      const queue=init?[init]:[...(m.elf?.dynamic['12']?[m.elf.dynamic['12']]:[]),...arrayFunctions(m,'25','27')];
      r.startup={main,argc,argv,envp:argv+(argc+1n)*8n,fini,phase:'init',queue};m.externalMap.set(CONT,'[libc startup continuation]');
      m.writeReg('rsp',m.regs.rsp&~15n);advanceStartup(m);return true;
    }
    if(name==='getpid'){finish(BigInt(m.config.pid||1337));return true;}
    if(name==='srand'){m.seed=BigInt.asUintN(32,reg('edi'));finish();return true;}
    if(name==='__gmon_start__'){finish();return true;}
    if(name==='memset'){
      const address=reg('rdi'),value=reg('esi')&255n,size=bounded(reg('rdx'));m.checkMemory(address,size,true);
      for(let i=0;i<size;i+=8){const n=Math.min(8,size-i);let v=0n;for(let j=0;j<n;j++)v|=value<<BigInt(j*8);m.writeMemory(address+BigInt(i),n*8,v,m.provenance.rdi);}
      finish(address,64);return true;
    }
    if(name==='fread'){
      const address=reg('rdi'),size=reg('rsi'),count=reg('rdx'),s=stream(reg('rcx'));const n=bounded(size*count,65536);
      if(!n){finish(0n,64);return true;}if(s.kind!=='stdin'&&s.kind!=='file')fail('该文件不是可读流');
      const data=s.kind==='stdin'?m.input:s.data,pos=s.kind==='stdin'?m.inputPos:s.pos,take=Math.min(n,data.length-pos);m.checkMemory(address,take,true);
      for(let i=0;i<take;i++)m.writeMemory(address+BigInt(i),8,BigInt(data[pos+i]),m.provenance.rdi);
      if(s.kind==='stdin')m.inputPos+=take;else s.pos+=take;s.eof=take<n;finish(BigInt(take)/size,64);return true;
    }
    if(name==='ferror'){stream(reg('rdi'));finish();return true;}
    if(name==='fclose'){const h=reg('rdi');stream(h);delete r.streams[h.toString()];finish();return true;}
    if(name==='fopen'){
      const path=m.readString(reg('rdi')),mode=m.readString(reg('rsi'));if(!['r','rb'].includes(mode))fail('fopen 教学模型仅支持 r / rb');
      const file=m.config.files&&Object.hasOwn(m.config.files,path)?m.config.files[path]:undefined;if(file===undefined){finish(0n,64);return true;}
      let data;if(typeof file==='string')data=encoder.encode(file);else if(file&&typeof file.hex==='string'&&/^(?:[\da-f]{2}\s*)*$/i.test(file.hex))data=Uint8Array.from(file.hex.match(/[\da-f]{2}/gi)||[],x=>parseInt(x,16));else fail('虚拟文件内容需为文本或 {hex:"41 42"}');
      bounded(BigInt(data.length),65536);const handle=r.nextHandle;r.nextHandle+=256n;r.streams[handle.toString()]={kind:'file',data,pos:0};finish(handle,64);return true;
    }
    if(name==='fwrite'){
      const address=reg('rdi'),size=reg('rsi'),count=reg('rdx'),s=stream(reg('rcx')),n=bounded(size*count,65536);if(!n){finish(0n,64);return true;}
      if(!['stdout','stderr'].includes(s.kind))fail('fwrite 模型仅支持 stdout / stderr');m.checkMemory(address,n);
      const bytes=Uint8Array.from({length:n},(_,i)=>Number(m.readMemory(address+BigInt(i),8)));m.output+=decoder.decode(bytes);if(m.output.length>65536)fail('输出超过 64 KiB');finish(count,64);return true;
    }
    if(name==='mmap'){
      const requested=reg('rdi'),length=reg('rsi'),prot=reg('edx'),flags=reg('ecx'),fd=reg('r8'),offset=reg('r9');
      if(!(flags&32n)||!(flags&2n)||(flags&~0x132n)||prot>7n||offset!==0n)fail('mmap 教学模型支持 MAP_PRIVATE | MAP_ANONYMOUS，可选 MAP_FIXED / MAP_GROWSDOWN；不支持其他标志或文件映射');
      if(!length||length>1048576n||(flags&16n&&requested%4096n)){finish(-1n,64);return true;}
      const size=Number((length+4095n)&~4095n);let address=flags&16n?requested:requested&&requested%4096n===0n?requested:r.nextMapping;
      const overlap=()=>m.regions.some(x=>address<x.end&&address+BigInt(size)>x.start);
      if(flags&16n){const end=address+BigInt(size);m.regions=m.regions.flatMap(x=>address>=x.end||end<=x.start?[x]:[...(x.start<address?[{...x,end:address}]:[]),...(x.end>end?[{...x,start:end}]:[])]);}
      if(!(flags&16n)){while(overlap())address+=0x100000n;r.nextMapping=address+BigInt(size);}
      m.addRegion(address,size,'mmap 匿名映射',!!(prot&2n));const region=m.regions.at(-1);region.readable=!!(prot&1n);region.mapping=true;
      if(flags&256n){region.name='mmap 向下增长栈';region.growLimit=address>1048576n?address-1048576n:0n;}
      // A fresh mapping starts at zero even when this address was previously unmapped.
      for(const [a,v]of m.memory)if(a>=address&&a<region.end){if(!m.changes.has(a))m.changes.set(a,v);m.memory.delete(a);}
      finish(address,64);m.event.summary+=' 新增区域 '+hex(address)+'，'+size+' 字节。';return true;
    }
    if(name==='munmap'){
      const address=reg('rdi'),length=reg('rsi');if(!length||address%4096n||length>1048576n){finish(-1n);return true;}const end=address+((length+4095n)&~4095n);
      if(m.regions.some(x=>!x.mapping&&address<x.end&&end>x.start))fail('munmap 教学模型仅允许释放 mmap 创建的区域');
      m.regions=m.regions.flatMap(x=>!x.mapping||address>=x.end||end<=x.start?[x]:[...(x.start<address?[{...x,end:address}]:[]),...(x.end>end?[{...x,start:end}]:[])]);
      finish();m.event.summary+=' 释放映射；回退可恢复区域及原字节。';return true;
    }
    if(name==='exit'){r.exitCode=Number(BigInt.asIntN(32,reg('edi')));m.status='halted';m.event.summary='exit 模型结束进程，退出码 '+r.exitCode+'。';return true;}
    return false;
  }
  const api={names,image,parseELF,loadImage,initialize,snapshot,model,grow};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.StackLensRuntime=api;
})(typeof globalThis!=='undefined'?globalThis:this);
