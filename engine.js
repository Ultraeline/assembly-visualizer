(function (root) {
  'use strict';
  const Runtime=typeof module!=='undefined'&&module.exports?require('./runtime'):root.StackLensRuntime;
  const Decoder=typeof module!=='undefined'&&module.exports?require('./decoder'):root.StackLensDecoder;
  const Stack=typeof module!=='undefined'&&module.exports?require('./stack'):root.StackLensStack;
  const MASK = (1n << 64n) - 1n;
  const names = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi',...Array.from({length:8},(_,i)=>'r'+(i+8))];
  const regs = {};
  names.forEach((name, code) => {
    regs[name] = {name, code, bits:64, shift:0};
    const aliases = code < 8 ? [['eax','ecx','edx','ebx','esp','ebp','esi','edi'][code], ['ax','cx','dx','bx','sp','bp','si','di'][code], ['al','cl','dl','bl','spl','bpl','sil','dil'][code]] : [name+'d',name+'w',name+'b'];
    [32,16,8].forEach((bits,i)=>regs[aliases[i]]={name,code,bits,shift:0});
  });
  ['ah','ch','dh','bh'].forEach((r,i)=>regs[r]={name:names[i],code:i+4,bits:8,shift:8});
  const conditions = {o:0,no:1,b:2,c:2,nae:2,ae:3,nb:3,nc:3,e:4,z:4,ne:5,nz:5,be:6,na:6,a:7,nbe:7,s:8,ns:9,p:10,pe:10,np:11,po:11,l:12,nge:12,ge:13,nl:13,le:14,ng:14,g:15,nle:15};
  const externals = ['getchar','putchar','puts','printf','rand','exit',...Runtime.names];
  const hex = (v,d=0) => '0x'+BigInt.asUintN(64,BigInt(v)).toString(16).padStart(d,'0');
  const mask = bits => (1n << BigInt(bits))-1n;
  const uint = (v,b=64) => BigInt.asUintN(b,v);
  const signed = (v,b=64) => BigInt.asIntN(b,v);
  function fail(message) { throw new Error(message); }
  function split(text) {
    const result=[]; let start=0, depth=0, quote=false, escape=false;
    for(let i=0;i<text.length;i++) {
      const c=text[i]; if(escape){escape=false;continue;} if(c==='\\'&&quote){escape=true;continue;}
      if(c==='"') quote=!quote;
      if(!quote) {if(c==='(')depth++;if(c===')')depth--;if(c===','&&depth===0){result.push(text.slice(start,i).trim());start=i+1;}}
    }
    if(quote || depth!==0) fail('引号或括号不匹配');
    if(text.slice(start).trim())result.push(text.slice(start).trim());
    return result;
  }
  function expression(text,symbols={},unresolved=false) {
    text=String(text).trim();
    if(!text)return 0n;
    const parts=text.match(/[+-]?\s*(?:0x[\da-f]+|0b[01]+|\d+|[A-Za-z_.$][\w.$]*)/gi);
    if(!parts||parts.join('').replace(/\s/g,'')!==text.replace(/\s/g,''))fail('无法解析表达式：'+text);
    if(parts.slice(1).some(p=>!/^\s*[+-]/.test(p)))fail('表达式项之间需要 + 或 -：'+text);
    return parts.reduce((sum,p)=>{
      const negative=p.trim().startsWith('-');const t=p.trim().replace(/^[+-]\s*/,'');let n;
      if(/^\d/.test(t)) {if(/^0[0-7]+$/.test(t))n=BigInt('0o'+t.slice(1));else {if(/^0\d+$/.test(t))fail('无效的八进制常量：'+t);n=BigInt(t);}}
      else if(Object.hasOwn(symbols,t))n=symbols[t];else if(unresolved)n=0n;else fail('未定义符号：'+t);
      return sum+(negative?-n:n);
    },0n);
  }
  function operand(text,branch=false,disassembly=false,allow32Address=false) {
    text=text.trim(); let indirect=false;
    if(text.startsWith('*')) {indirect=true;text=text.slice(1).trim();}
    const annotated=text.match(/^([^\s]+)\s*<([^>]+)>$/);
    const symbol=annotated?.[2];if(annotated)text=annotated[1];
    if(text.startsWith('$'))return {kind:'imm',expr:text.slice(1),text};
    if(text.startsWith('%')&&!text.includes('(')) {
      const key=text.slice(1).toLowerCase();if(!regs[key])fail('不支持的寄存器：'+text);
      return {kind:'reg',reg:key,text,indirect};
    }
    if(branch&&!indirect&&!text.includes('(')) {
      if(disassembly&&/^[\da-f]+$/i.test(text))text='0x'+text;
      return {kind:'target',expr:text,symbol,text};
    }
    const m=text.match(/^(.*?)\(([^)]*)\)$/);
    if(m) {
      const a=m[2].split(',').map(x=>x.trim().replace(/^%/,''));const [base,index,scaleText]=a;
      if(a.length>3)fail('寻址格式错误：'+text);
      for(const r of [base,index])if(r&&r!=='rip'&&(!regs[r]||!(allow32Address?[32,64]:[64]).includes(regs[r].bits)))fail('不支持的地址寄存器：'+r);
      if(index==='rsp'||index==='esp'||index==='rip'||(base==='rip'&&index))fail('不支持的索引寄存器：'+text);
      if(base&&index&&regs[base].bits!==regs[index].bits)fail('基址与索引寄存器的地址宽度必须一致');
      const scale=scaleText?Number(scaleText):1;if(![1,2,4,8].includes(scale))fail('比例因子必须是 1、2、4 或 8');
      return {kind:'mem',expr:m[1]||'0',base,index,scale,text,indirect};
    }
    if(!text)fail('缺少操作数');
    return {kind:'mem',expr:text,base:'',index:'',scale:1,text,indirect};
  }
  const bases = ['movabs','mov','lea','xchg','push','pop','add','sub','and','or','xor','cmp','test','inc','dec','neg','not','imul','mul','div','idiv','shl','sal','shr','sar','call','ret','leave','nop','pause','hlt'];
  function parseInstruction(text,line,disassembly=false) {
    let body=text,match;const prefixTokens=[],prefixBytes=[];
    const prefixCodes={data16:0x66,addr32:0x67,cs:0x2e,ds:0x3e,es:0x26,ss:0x36,fs:0x64,gs:0x65,rex:0x40,'rex.w':0x48,rep:0xf3,repe:0xf3,repz:0xf3,repne:0xf2,repnz:0xf2};
    while((match=body.match(/^(data16|addr32|cs|ds|es|ss|fs|gs|rex(?:\.w)?|rep(?:ne|nz|e|z)?)\s+/i))) {
      prefixTokens.push(match[1].toLowerCase());prefixBytes.push(prefixCodes[match[1].toLowerCase()]);body=body.slice(match[0].length);
    }
    const m=body.match(/^(\S+)(?:\s+(.*))?$/);if(!m)fail('空指令');
    const repeatPrefix=prefixTokens.find(p=>p.startsWith('rep'));
    let mnemonic=m[1].toLowerCase(),op=mnemonic,bits=null,fromBits=null,condition=null;
    const ext=mnemonic.match(/^mov([zs])([bwl])([wlq])$/);
    if(ext) {op=ext[1]==='z'?'movzx':'movsx';fromBits={b:8,w:16,l:32}[ext[2]];bits={w:16,l:32,q:64}[ext[3]];if(fromBits>=bits)fail('扩展指令的目标必须更宽');}
    else if(mnemonic==='cltq'||mnemonic==='cqto'||mnemonic==='cltd'||mnemonic==='cwtl')op=mnemonic;
    else if(mnemonic==='jmp'||mnemonic==='jmpq')op='jmp';
    else if(mnemonic.startsWith('j')&&Object.hasOwn(conditions,mnemonic.slice(1))) {op='jcc';condition=mnemonic.slice(1);}
    else if(mnemonic.startsWith('set')&&Object.hasOwn(conditions,mnemonic.slice(3))) {op='setcc';bits=8;condition=mnemonic.slice(3);}
    else if(!bases.includes(op)) {
      const b=bases.find(x=>mnemonic.length===x.length+1&&mnemonic.startsWith(x)&&'bwlq'.includes(mnemonic.at(-1)));
      if(!b)fail(repeatPrefix?'暂不支持 '+prefixTokens.join(' ')+' '+mnemonic+' 的重复执行语义':'暂不支持指令：'+mnemonic);op=b;bits={b:8,w:16,l:32,q:64}[mnemonic.at(-1)];
    }
    if(op==='sal')op='shl';
    if(repeatPrefix) {
      if(!prefixTokens.every(p=>['rep','repe','repz'].includes(p))||!['ret','nop'].includes(op))fail('此 REP 前缀组合尚未实现；当前支持 REP/REPE/REPZ RET 和 REP NOP（PAUSE）');
    } else if(prefixTokens.length&&op!=='nop')fail('这些指令前缀目前仅支持用于 NOP');
    const args=split(m[2]||'').map(x=>{
      const segment=op==='nop'?x.match(/^%(cs|ds|es|ss|fs|gs):/i):null;
      if(segment){prefixBytes.push(prefixCodes[segment[1].toLowerCase()]);x=x.slice(segment[0].length);}
      const arg=operand(x,['call','jmp','jcc'].includes(op),disassembly,op==='nop');
      if(segment&&arg.kind!=='mem')fail('段前缀只能用于 NOP 的内存操作数');
      if(op==='nop'&&arg.kind==='mem'&&[arg.base,arg.index].some(r=>regs[r]?.bits===32)&&!prefixBytes.includes(0x67))prefixBytes.push(0x67);
      return arg;
    });
    if(['call','ret','leave'].includes(op)&&bits!==null&&bits!==64)fail('第一版仅支持 64 位 '+op);
    if(['hlt','pause'].includes(op)&&mnemonic!==op)fail('暂不支持带宽度后缀的 '+op);
    if(bits===null) {
      if(['push','pop','call','ret','leave','jmp','jcc'].includes(op))bits=64;
      else if(op==='nop')bits=args[0]?.kind==='reg'?regs[args[0].reg].bits:32;
      else {const r=[...args].reverse().find(x=>x.kind==='reg');bits=r?regs[r.reg].bits:64;
        if(!r && args.length && !['setcc'].includes(op))fail('无法确定操作数宽度，请添加 b/w/l/q 后缀');}
    }
    if(repeatPrefix&&op==='nop'&&(args.length||bits!==32))fail('REP NOP 仅支持无操作数的 PAUSE 写法');
    return {op,bits,fromBits,args,condition,mnemonic:[...prefixTokens,mnemonic].join(' '),prefixBytes,repeatPrefix,line,text};
  }
  function bytesLE(v,length) {v=uint(v,length*8);return Array.from({length},()=>{const b=Number(v&255n);v>>=8n;return b;});}
  function encode(ins,symbols,unresolved=false) {
    const {op,bits,args:a}=ins, val=x=>expression(x.expr,symbols,unresolved), prefix=bits===16?[0x66]:[];
    function count(n) {if(a.length!==n)fail(`${ins.mnemonic} 需要 ${n} 个操作数`);}
    function imm(x,width,signOnly=false) {
      const v=val(x),lo=-(1n<<BigInt(width-1)),hi=signOnly?(1n<<BigInt(width-1))-1n:mask(width);
      if(!unresolved&&(v<lo||v>hi))fail('立即数超出 '+width+' 位编码范围');return bytesLE(v,width/8);
    }
    function rm(opcodes,field,dest,w=bits,tail=[],fieldIsReg=true) {
      if(!dest||!['reg','mem'].includes(dest.kind))fail('目标需要寄存器或内存');
      const fieldReg=typeof field==='string'?regs[field]:null;const f=fieldReg?fieldReg.code:field;
      let rex=(w===64?8:0)|(fieldIsReg&&f>=8?4:0),body=[],force=false,high=fieldReg?.shift===8;
      if(fieldReg&&fieldReg.bits===8&&fieldReg.shift===0&&fieldReg.code>=4)force=true;
      if(dest.kind==='reg') {
        const r=regs[dest.reg];rex|=r.code>=8?1:0;high ||= r.shift===8;force ||= r.bits===8&&r.shift===0&&r.code>=4;
        body=[0xc0|((f&7)<<3)|(r.code&7)];
      } else {
        let disp=val(dest),mod=0,rmcode;
        if(dest.base==='rip') {
          // RIP-relative symbolic operands are relocated to the next instruction.
          if(/[A-Za-z_.$]/.test(dest.expr.replace(/0x[\da-f]+/gi,'')))disp-=ins.address+BigInt((ins.prefixBytes?.length||0)+(w===16?1:0)+(rex||force?1:0)+opcodes.length+5+tail.length);
          if(!unresolved&&(disp<-(1n<<31n)||disp>(1n<<31n)-1n))fail('RIP 相对位移超出 32 位');
          body=[((f&7)<<3)|5,...bytesLE(disp,4)];
        } else {
          const base=dest.base?regs[dest.base].code:null,index=dest.index?regs[dest.index].code:null;
          if(base!==null&&base>=8)rex|=1;if(index!==null&&index>=8)rex|=2;
          if(base!==null)mod=disp===0n&&(base&7)!==5?0:(disp>=-128n&&disp<=127n?1:2);
          if(!unresolved&&(disp<-(1n<<31n)||disp>(1n<<31n)-1n))fail('地址位移超出有符号 32 位');
          const sib=index!==null||base===null||(base&7)===4;
          rmcode=sib?4:base&7;body=[(mod<<6)|((f&7)<<3)|rmcode];
          if(sib)body.push(([1,2,4,8].indexOf(dest.scale)<<6)|((index===null?4:index&7)<<3)|(base===null?5:base&7));
          if(base===null||mod===2)body.push(...bytesLE(disp,4));else if(mod===1)body.push(...bytesLE(disp,1));
        }
      }
      if(high&&(rex||force))fail('AH/BH/CH/DH 不能与需要 REX 前缀的操作数组合');
      return [...(w===16?[0x66]:[]),...(rex||force?[0x40|rex]:[]),...opcodes,...body,...tail];
    }
    function widthCheck() {
      a.forEach((x,i)=>{if(x.kind==='reg') {
        let expected=bits;
        if(['movzx','movsx'].includes(op)&&i===0)expected=ins.fromBits;
        if(['shl','shr','sar'].includes(op)&&i===0&&a.length===2) {if(x.reg!=='cl')fail('移位计数寄存器必须为 %cl');return;}
        if(['call','jmp'].includes(op))expected=64;
        if(regs[x.reg].bits!==expected)fail('寄存器宽度与指令不一致：'+x.text);
      }});
    }
    widthCheck();
    if(op==='nop') {
      if(![16,32,64].includes(bits))fail('NOP 不支持 8 位操作数');
      if(a.length===0)return [...(ins.prefixBytes||[]),...prefix,...(bits===64?[0x48]:[]),0x90];
      count(1);if(a[0].indirect)fail('NOP 操作数不使用 * 前缀');
      // Intel SDM: 0F 1F /0 never reads its operand and affects no registers or flags.
      return [...(ins.prefixBytes||[]),...rm([0x0f,0x1f],0,a[0],bits,[],false)];
    }
    if(['hlt','pause','leave','cltq','cqto','cltd','cwtl'].includes(op)) {
      count(0);return {hlt:[0xf4],pause:[0xf3,0x90],leave:[0xc9],cltq:[0x48,0x98],cqto:[0x48,0x99],cltd:[0x99],cwtl:[0x98]}[op];
    }
    if(op==='ret') {if(a.length===0)return [...(ins.prefixBytes||[]),0xc3];count(1);if(a[0].kind!=='imm')fail('ret 的参数必须是立即数');const n=val(a[0]);if(n<0n||n>65535n)fail('ret 参数必须在 0..65535');return [...(ins.prefixBytes||[]),0xc2,...imm(a[0],16)];}
    if(op==='xchg') {
      count(2);if(a.some(x=>x.indirect))fail('xchg 操作数不使用 * 前缀');
      if(a[0].kind==='reg'&&a[0].reg===a[1].reg&&['ax','eax','rax'].includes(a[0].reg))return [...prefix,...(bits===64?[0x48]:[]),0x90];
      if(a[0].kind==='reg')return rm([bits===8?0x86:0x87],a[0].reg,a[1]);
      if(a[1].kind==='reg')return rm([bits===8?0x86:0x87],a[1].reg,a[0]);
      fail('xchg 需要两个寄存器，或一个寄存器和一个内存操作数');
    }
    if(['call','jmp','jcc'].includes(op)) {
      count(1);const x=a[0];
      if(x.kind==='target') {
        const length=op==='jcc'?6:5;const offset=val(x)-(ins.address+BigInt(length));
        if(!unresolved&&(offset<-(1n<<31n)||offset>(1n<<31n)-1n))fail('跳转距离超出 rel32');
        return [...(op==='call'?[0xe8]:op==='jmp'?[0xe9]:[0x0f,0x80+conditions[ins.condition]]),...bytesLE(offset,4)];
      }
      if(op==='jcc'||!x.indirect)fail('间接跳转需要 * 前缀');return rm([0xff],op==='call'?2:4,x,32,[],false);
    }
    if(['push','pop'].includes(op)) {
      count(1);if(![16,64].includes(bits))fail('64 位模式仅支持 16/64 位 push/pop');const x=a[0];
      if(x.kind==='reg'){const c=regs[x.reg].code;return [...prefix,...(c>=8?[0x41]:[]),(op==='push'?0x50:0x58)+(c&7)];}
      if(x.kind==='imm'&&op==='push') {const v=val(x);return v>=-128n&&v<=127n?[...prefix,0x6a,...imm(x,8,true)]:[...prefix,0x68,...imm(x,bits===16?16:32,true)];}
      return rm([op==='push'?0xff:0x8f],op==='push'?6:0,x,bits===16?16:32,[],false);
    }
    if(op==='setcc') {count(1);return rm([0x0f,0x90+conditions[ins.condition]],0,a[0],8,[],false);}
    if(['mov','movabs'].includes(op)) {
      count(2);const [s,d]=a;
      if(s.kind==='imm') {
        const v=val(s);
        if(d.kind==='reg'&&(bits!==64||op==='movabs'||v<-(1n<<31n)||v>(1n<<31n)-1n)) {
          const r=regs[d.reg],rex=(bits===64?8:0)|(r.code>=8?1:0),force=bits===8&&!r.shift&&r.code>=4;
          return [...prefix,...(rex||force?[0x40|rex]:[]),(bits===8?0xb0:0xb8)+(r.code&7),...imm(s,bits)];
        }
        return rm([bits===8?0xc6:0xc7],0,d,bits,imm(s,bits===64?32:bits,bits===64),false);
      }
      if(op==='movabs')fail('movabs 暂仅支持立即数到寄存器');
      if(s.kind==='reg')return rm([bits===8?0x88:0x89],s.reg,d);
      if(d.kind==='reg')return rm([bits===8?0x8a:0x8b],d.reg,s);
      fail('mov 不支持两个内存操作数');
    }
    if(['lea','movzx','movsx'].includes(op)) {
      count(2);if(a[1].kind!=='reg')fail('目标必须是寄存器');
      if(op==='lea'){if(a[0].kind!=='mem'||bits===8)fail('lea 需要内存地址和 16/32/64 位寄存器');return rm([0x8d],a[1].reg,a[0]);}
      const srcBits=ins.fromBits;
      if(op==='movzx'&&srcBits===32)fail('32 → 64 零扩展请使用 movl 写入 32 位寄存器');
      return rm(srcBits===32?[0x63]:[0x0f,(op==='movzx'?0xb6:0xbe)+(srcBits===16?1:0)],a[1].reg,a[0]);
    }
    const alu={add:0,or:1,and:4,sub:5,xor:6,cmp:7};
    if(Object.hasOwn(alu,op)||op==='test') {
      count(2);const [s,d]=a;const ext=alu[op];
      if(s.kind==='imm') {
        if(op==='test')return rm([bits===8?0xf6:0xf7],0,d,bits,imm(s,bits===64?32:bits,bits===64),false);
        const v=val(s),short=bits!==8&&v>=-128n&&v<=127n;
        return rm([bits===8?0x80:short?0x83:0x81],ext,d,bits,imm(s,short?8:bits===64?32:bits,short||bits===64),false);
      }
      if(s.kind==='reg')return rm([op==='test'?(bits===8?0x84:0x85):ext*8+(bits===8?0:1)],s.reg,d);
      if(d.kind==='reg'&&op!=='test')return rm([ext*8+(bits===8?2:3)],d.reg,s);
      fail('不支持此操作数组合');
    }
    if(['inc','dec','neg','not','mul','div','idiv'].includes(op)||(op==='imul'&&a.length===1)) {
      count(1);const ex={inc:0,dec:1,not:2,neg:3,mul:4,imul:5,div:6,idiv:7}[op];
      return rm([['inc','dec'].includes(op)?(bits===8?0xfe:0xff):(bits===8?0xf6:0xf7)],ex,a[0],bits,[],false);
    }
    if(op==='imul') {
      if(bits===8)fail('多操作数 imul 不支持 8 位');
      if(a.length===2&&a[0].kind==='imm')a.splice(1,0,{...a[1]});
      if(a.length===2) {if(a[1].kind!=='reg')fail('imul 目标必须是寄存器');return rm([0x0f,0xaf],a[1].reg,a[0]);}
      count(3);if(a[0].kind!=='imm'||a[2].kind!=='reg')fail('imul 格式为 $立即数, 源, 目标寄存器');
      const v=val(a[0]),short=v>=-128n&&v<=127n;return rm([short?0x6b:0x69],a[2].reg,a[1],bits,imm(a[0],short?8:bits===64?32:bits,true));
    }
    if(['shl','shr','sar'].includes(op)) {
      if(a.length===1)a.unshift({kind:'imm',expr:'1',text:'$1'});count(2);const c=a[0],ex={shl:4,shr:5,sar:7}[op];
      if(c.kind==='reg'&&c.reg==='cl')return rm([bits===8?0xd2:0xd3],ex,a[1],bits,[],false);
      if(c.kind!=='imm')fail('移位计数必须是立即数或 %cl');const v=val(c);
      return rm([v===1n?(bits===8?0xd0:0xd1):(bits===8?0xc0:0xc1)],ex,a[1],bits,v===1n?[]:imm(c,8),false);
    }
    fail('编码尚未实现：'+op);
  }
  function unquote(text) {
    if(!/^"(?:[^"\\]|\\.)*"$/.test(text))fail('字符串需要使用双引号');
    const bytes=[];const encoder=new TextEncoder();let plain='';
    const flush=()=>{bytes.push(...encoder.encode(plain));plain='';};
    for(let i=1;i<text.length-1;i++) {
      if(text[i]!=='\\'){plain+=text[i];continue;}flush();const c=text[++i];
      if(/[0-7]/.test(c)) {let oct=c;while(oct.length<3&&/[0-7]/.test(text[i+1]||'x'))oct+=text[++i];bytes.push(parseInt(oct,8)&255);}
      else if(c==='x') {let h='';while(/[\da-f]/i.test(text[i+1]||'z')&&h.length<2)h+=text[++i];if(!h)fail('无效的十六进制转义');bytes.push(parseInt(h,16));}
      else if(Object.hasOwn({n:10,r:13,t:9,'\\':92,'"':34,'0':0},c))bytes.push({n:10,r:13,t:9,'\\':92,'"':34,'0':0}[c]);else fail('不支持的转义：\\'+c);
    }flush();return bytes;
  }
  function compile(source,options={}) {
    const symbols={},instructions=[],data=[],annotations=[],warnings=[],declaredFunctions=new Set(),headerFunctions=new Set();
    let pc=expression(options.codeBase||'0x400000'),dp=expression(options.dataBase||'0x600000'),section='text',pending=[],mode=null;
    const startPc=pc,startData=dp;
    source.replace(/\r/g,'').split('\n').forEach((raw,index)=>{
      const line=index+1;
      try {
        const annotation=raw.match(/^\s*#\s*@buffer\s+(.+)$/);
        if(annotation) {const p=split(annotation[1]);if(p.length!==3)fail('标注格式：# @buffer 名称, 地址表达式, 字节数');pending.push({name:p[0],location:operand(p[1]),size:Number(expression(p[2])),line});return;}
        let text='',quoted=false,escape=false;
        for(const c of raw) {if(c==='#'&&!quoted)break;text+=c;if(escape){escape=false;continue;}if(c==='\\'&&quoted){escape=true;continue;}if(c==='"')quoted=!quoted;}
        text=text.trim();if(!text)return;
        if(/^Disassembly of section |^.+:\s+file format /.test(text))return;
        const header=text.match(/^([\da-f]+)\s+<([^>]+)>:$/i);
        if(header) {if(mode==='source')fail('请分别导入源代码和反汇编文本');mode='disassembly';pc=BigInt('0x'+header[1]);symbols[header[2]]=pc;if(!header[2].startsWith('.')&&!/[+-]0x[\da-f]+$/i.test(header[2]))headerFunctions.add(header[2]);return;}
        const row=text.match(/^([\da-f]+):\s*(?=[\da-f]{2}(?:\s|$))(.*)$/i);
        if(row) {
          if(mode==='source')fail('请分别导入源代码和反汇编文本');mode='disassembly';
          const address=BigInt('0x'+row[1]),parts=row[2].trim().split(/\s+/),bytes=[];
          while(parts.length&&/^[\da-f]{2}$/i.test(parts[0]))bytes.push(parseInt(parts.shift(),16));
          if(!parts.length) {const previous=instructions.at(-1);if(!previous||address!==previous.address+BigInt(previous.bytes.length))fail('机器码续行地址不连续');previous.bytes.push(...bytes);previous.length=previous.bytes.length;return;}
          if(!bytes.length)fail('请导入包含机器码字节的反汇编，以保留准确指令长度');
          const ins=parseInstruction(parts.join(' '),line,true);ins.address=address;ins.bytes=bytes;ins.length=bytes.length;ins.annotations=pending;pending=[];instructions.push(ins);pc=address+BigInt(ins.length);return;
        }
        if(mode==='disassembly')fail('无法识别反汇编行');mode='source';
        let label;
        while((label=text.match(/^([A-Za-z_.$][\w.$]*):\s*/))) {
          if(Object.hasOwn(symbols,label[1]))fail('重复标签：'+label[1]);symbols[label[1]]=section==='text'?pc:dp;text=text.slice(label[0].length);if(!text)return;
        }
        if(text.startsWith('.')) {
          const dm=text.match(/^(\S+)(?:\s+(.*))?$/),d=dm[1],arg=dm[2]||'';
          if(['.text','.data','.rodata','.bss'].includes(d)){section=d==='.text'?'text':'data';return;}
          if(d==='.section'){const s=arg.split(',')[0].trim();if(!['.text','.data','.rodata','.bss'].includes(s))fail('暂不支持节：'+s);section=s==='.text'?'text':'data';return;}
          if(d==='.type'){const fn=arg.match(/^([A-Za-z_.$][\w.$]*)\s*,\s*[@%]?function\s*$/i);if(fn)declaredFunctions.add(fn[1]);return;}
          if(['.global','.globl','.size','.file','.ident','.att_syntax','.code64'].includes(d)||d.startsWith('.cfi_'))return;
          if(section==='text')fail('暂不支持代码节指示：'+d);
          let bytes=null,values=null,width=0;
          if(['.ascii','.asciz','.string'].includes(d))bytes=split(arg).flatMap(s=>[...unquote(s),...(d==='.ascii'?[]:[0])]);
          else if(['.zero','.space'].includes(d)) {const n=Number(expression(arg));if(!Number.isSafeInteger(n)||n<0||n>65536)fail('数据空间限 0..65536 字节');bytes=Array(n).fill(0);}
          else if(['.byte','.word','.short','.long','.quad'].includes(d)) {width={'.byte':1,'.word':2,'.short':2,'.long':4,'.quad':8}[d];values=split(arg);bytes=Array(width*values.length).fill(0);}
          else if(['.align','.balign','.p2align'].includes(d)) {const n=Number(expression(arg));const align=d==='.p2align'?2**n:n;if(!Number.isInteger(align)||align<1||align>4096)fail('对齐范围无效');bytes=Array(Number((BigInt(align)-dp%BigInt(align))%BigInt(align))).fill(0);}
          else fail('暂不支持数据指示：'+d);
          data.push({address:dp,bytes,values,width,line});dp+=BigInt(bytes.length);if(dp-startData>1048576n)fail('数据节超过 1 MiB');return;
        }
        if(section!=='text')fail('请在 .text 节编写指令');
        const ins=parseInstruction(text,line);ins.address=pc;ins.annotations=pending;pending=[];
        ins.length=encode(ins,symbols,true).length;pc+=BigInt(ins.length);instructions.push(ins);
      }catch(e){throw new Error('第 '+line+' 行：'+e.message);}
    });
    if(!instructions.length)fail('没有可执行指令');if(instructions.length>20000)fail('第一版最多支持 20000 条指令');
    const externalMap=new Map();externals.forEach((name,i)=>{if(!Object.hasOwn(symbols,name)){symbols[name]=0x70000000n+BigInt(i*16);externalMap.set(symbols[name],name);}});
    for(const ins of instructions) {
      try {
        if(mode==='source'){ins.bytes=encode(ins,symbols);if(ins.bytes.length!==ins.length)fail('编码长度变化，请使用明确的常量立即数');}
        else {encode({...ins,address:ins.address,args:ins.args.map(a=>({...a}))},symbols,true);}
        for(const arg of ins.args)if(arg.kind==='target'&&arg.symbol) {
          const name=arg.symbol.replace(/@.*$/,'');if(externals.includes(name))externalMap.set(expression(arg.expr,symbols),name);
        }
        for(const b of ins.annotations)if(!Number.isSafeInteger(b.size)||b.size<=0||b.size>65536||b.location.kind!=='mem')fail('缓冲区标注需要有效内存地址与 1..65536 字节长度');
      }catch(e){throw new Error('第 '+ins.line+' 行：'+e.message);}
    }
    for(const item of data)if(item.values)item.bytes=item.values.flatMap(x=>bytesLE(expression(x,symbols),item.width));
    const map=new Map(),occupied=new Set();
    for(const ins of instructions){if(ins.length>15)fail('x86 指令长度不能超过 15 字节');for(let i=0;i<ins.length;i++){const key=(ins.address+BigInt(i)).toString();if(occupied.has(key))fail('指令地址重叠：'+hex(ins.address));occupied.add(key);}map.set(ins.address,ins);}
    if(mode==='disassembly')warnings.push('反汇编按所提供的指令文本执行，机器码用于保留地址、长度和显示；本版不校验文本与机器码是否一致。缺失的数据与外部代码需要另行配置。');
    const functionEntries=new Map(),addFunction=(name,address)=>{
      if(!map.has(address))return;
      const names=functionEntries.get(address)||[];if(!names.includes(name))functionEntries.set(address,[...names,name]);
    };
    for(const name of [...headerFunctions,...declaredFunctions,'main','_start'])if(Object.hasOwn(symbols,name))addFunction(name,symbols[name]);
    const labelsByAddress=new Map();for(const [name,address]of Object.entries(symbols)){if(!labelsByAddress.has(address))labelsByAddress.set(address,[]);labelsByAddress.get(address).push(name);}
    for(const ins of instructions)if(ins.op==='call'&&ins.args[0].kind==='target'){
      const address=expression(ins.args[0].expr,symbols);
      for(const name of labelsByAddress.get(address)||[])if(!/[+-]0x[\da-f]+$/i.test(name))addFunction(name,address);
    }
    return {source,mode:mode||'source',instructions,map,symbols,data,externalMap,functionEntries,warnings,codeBase:startPc,dataBase:startData};
  }
  class Machine {
    constructor(program,config={}) {
      this.program=program;this.config=config;this.regs=Object.fromEntries(names.map(n=>[n,0n]));this.flags={ZF:false,SF:false,CF:false,OF:false,PF:false,AF:false};
      this.memory=new Map();this.regions=[];this.history=[];this.frames=[];this.buffers=[];this.stackSpaces=Stack.initial();this.provenance={};this.output='';this.input=new TextEncoder().encode(config.input??'');
      if(config.inputMode==='hex') {const s=(config.input??'').replace(/\s/g,'');if(!/^(?:[\da-f]{2})*$/i.test(s))fail('十六进制输入需要完整字节，例如 41 42 00');this.input=Uint8Array.from(s.match(/../g)||[],x=>parseInt(x,16));}
      if(this.input.length>65536)fail('输入最多 65536 字节');
      this.inputPos=0;this.seed=uint(expression(config.seed||'1'),32);this.steps=0;this.status='ready';this.error='';this.lastEvent=null;this.frameId=0;
      const stackTop=expression(config.stackTop||'0x7fffffffe000'),stackSize=Number(config.stackSize||16384);
      if(!Number.isSafeInteger(stackSize)||stackSize<256||stackSize>1048576)fail('栈空间需要 256..1048576 字节');
      this.stackTop=stackTop;this.addRegion(stackTop-BigInt(stackSize)+256n,stackSize,'栈',true);
      Runtime.loadImage(this);
      this.functionEntries=new Map(program.functionEntries);
      for(const [name,address]of this.elf?.functionSymbols||[]){const aliases=this.functionEntries.get(address)||[];if(!aliases.includes(name))this.functionEntries.set(address,[...aliases,name]);}
      if(!this.elf){
        for(const ins of program.instructions) {this.addRegion(ins.address,ins.length,'代码',false);ins.bytes.forEach((b,i)=>this.memory.set(ins.address+BigInt(i),b));}
        for(const item of program.data){if(item.bytes.length)this.addRegion(item.address,item.bytes.length,'数据',true);item.bytes.forEach((b,i)=>this.memory.set(item.address+BigInt(i),b));}
      }
      for(const region of config.regions||[]) {const base=expression(region.address);this.addRegion(base,Number(region.size),region.name||'自定义',region.writable!==false);if(region.hex){const t=region.hex.replace(/\s/g,'');if(!/^(?:[\da-f]{2})*$/i.test(t)||t.length/2>Number(region.size))fail('初始内存十六进制无效或超出区域');(t.match(/../g)||[]).forEach((v,i)=>this.memory.set(base+BigInt(i),parseInt(v,16)));}}
      this.regs.rsp=stackTop;
      for(const [key,v] of Object.entries(config.registers||{})){if(!regs[key])fail('未知初始寄存器：'+key);this.writeReg(key,expression(String(v)));}
      this.rip=config.entry?expression(config.entry,program.symbols):this.elf?.entry??program.symbols._start??program.symbols.main??program.instructions[0].address;
      if(!program.map.has(this.rip))fail('入口地址没有指令：'+hex(this.rip));
      this.sentinel=0x7fffffffff00n;
      Runtime.initialize(this);this.harness=!this.processMode&&config.harness!==false;
      if(this.harness){this.checkMemory(this.regs.rsp,8,true);bytesLE(this.sentinel,8).forEach((b,i)=>this.memory.set(this.regs.rsp+BigInt(i),b));}
      this.frames.push({id:++this.frameId,name:this.nameAt(this.rip),entry:this.rip,returnSlot:this.harness?this.regs.rsp:null,returnAddress:this.harness?this.sentinel:null,base:null,stackEntry:this.regs.rsp});
    }
    addRegion(start,size,name,writable) {
      if(!Number.isSafeInteger(size)||size<1||size>1048576||start<0n||start+BigInt(size)>MASK)fail('无效的内存区域：'+name);
      const end=start+BigInt(size);if(this.regions.some(r=>start<r.end&&end>r.start))fail('内存区域重叠：'+name+' '+hex(start));
      this.regions.push({start,end,name,writable});
    }
    nameAt(address){return Object.entries(this.program.symbols).find(([name,value])=>value===address&&!name.startsWith('.'))?.[0]||hex(address);}
    functionNamesAt(address){
      const names=this.functionEntries.get(address);if(names?.length)return [...names];
      const external=this.externalMap.get(address);return external&&!external.startsWith('[')?[external]:[];
    }
    functionPointerAt(address){
      let value=0n;
      // Inspect a complete little-endian pointer without CPU reads or mapping growth.
      for(let i=7;i>=0;i--){const at=address+BigInt(i),region=this.regionAt(at);if(!region||region.readable===false)return null;value=(value<<8n)|BigInt(this.memory.get(at)??0);}
      const names=this.functionNamesAt(value);return names.length?{value,names}:null;
    }
    regionAt(address){return this.regions.find(r=>address>=r.start&&address<r.end);}
    checkMemory(address,size,write=false) {
      for(let i=0;i<size;i++){const a=address+BigInt(i),r=this.regionAt(a)||Runtime.grow(this,a);if(!r)fail('未映射的内存：'+hex(a)+'。请检查地址或配置内存区域。');if(write&&!r.writable)fail('写入只读代码区域：'+hex(a));if(!write&&r.readable===false)fail('读取不可读的映射：'+hex(a));}
    }
    peek(address,size=8) {return Array.from({length:size},(_,i)=>{const a=address+BigInt(i);return this.regionAt(a)?this.memory.get(a)??0:null;});}
    readReg(key,track=true) {const r=regs[key];if(!r)fail('未知寄存器：'+key);const v=(this.regs[r.name]>>BigInt(r.shift))&mask(r.bits);if(track&&this.event)this.event.reads.push({kind:'reg',name:key,value:v,bits:r.bits});return v;}
    writeReg(key,value,provenance=null) {
      const r=regs[key],old=this.regs[r.name],v=uint(value,r.bits);
      const next=r.bits>=32?v:(old&~(mask(r.bits)<<BigInt(r.shift)))|(v<<BigInt(r.shift));this.regs[r.name]=uint(next);
      delete this.provenance?.[r.name];if(provenance&&r.bits===64)this.provenance[r.name]=provenance;
      if(this.event)this.event.writes.push({kind:'reg',name:key,fullName:r.name,before:old,after:this.regs[r.name],bits:r.bits,value:v});
    }
    address(op,ins) {
      let d=expression(op.expr,this.program.symbols);
      if(op.base==='rip') {if(!/[A-Za-z_.$]/.test(op.expr.replace(/0x[\da-f]+/gi,'')))d+=ins.address+BigInt(ins.length);}
      else if(op.base)d+=this.readReg(op.base);
      if(op.index)d+=this.readReg(op.index)*BigInt(op.scale);return uint(d);
    }
    readMemory(address,bits) {this.checkMemory(address,bits/8);let v=0n;for(let i=bits/8-1;i>=0;i--)v=(v<<8n)|BigInt(this.memory.get(address+BigInt(i))??0);if(this.event)this.event.reads.push({kind:'mem',address,bits,value:v});return v;}
    writeMemory(address,bits,value,pointer=null) {
      const size=bits/8;this.checkMemory(address,size,true);const before=this.peek(address,size),after=bytesLE(value,size);
      for(let i=0;i<size;i++){const p=address+BigInt(i);if(this.changes&&!this.changes.has(p))this.changes.set(p,this.memory.get(p));this.memory.set(p,after[i]);}
      if(this.event) {
        this.event.writes.push({kind:'mem',address,bits,before,after,value:uint(value,bits)});
        const candidates=this.buffers.filter(b=>b.active&&(b.id===pointer||(address>=b.start&&address<b.end)));
        for(const b of candidates)if(address<b.start||address+BigInt(size)>b.end)this.event.warnings.push({type:'overflow',buffer:b.name,address,size,message:`越过缓冲区「${b.name}」边界，写入 ${hex(address)}（${size} 字节）。`});
        for(const f of this.frames)if(f.returnSlot!==null&&address<f.returnSlot+8n&&address+BigInt(size)>f.returnSlot)this.event.warnings.push({type:'return',address,size,message:'写入覆盖了已记录的返回地址槽。'});
        for(const f of this.frames)if(f.base!==null&&address<f.base+8n&&address+BigInt(size)>f.base)this.event.warnings.push({type:'frame',address,size,message:'写入覆盖了保存的帧指针位置（根据常见序言推断）。'});
      }
    }
    read(op,ins,bits=ins.bits) {if(op.kind==='imm'||op.kind==='target')return uint(expression(op.expr,this.program.symbols),bits);if(op.kind==='reg')return this.readReg(op.reg);return this.readMemory(this.address(op,ins),bits);}
    write(op,ins,value,pointer=null) {if(op.kind==='reg')this.writeReg(op.reg,value,pointer);else if(op.kind==='mem')this.writeMemory(this.address(op,ins),ins.bits,value,op.base?this.provenance[regs[op.base]?.name]:null);else fail('不能写入此操作数');}
    pointer(op){return op.kind==='reg'?this.provenance[regs[op.reg].name]:null;}
    push(value,bits=64) {const sp=uint(this.readReg('rsp')-BigInt(bits/8));this.writeReg('rsp',sp);this.writeMemory(sp,bits,value);}
    pop(bits=64) {const sp=this.readReg('rsp'),value=this.readMemory(sp,bits);this.writeReg('rsp',sp+BigInt(bits/8));return value;}
    szp(result,bits) {const v=uint(result,bits);this.flags.ZF=v===0n;this.flags.SF=!!(v&(1n<<BigInt(bits-1)));let p=Number(v&255n),n=0;while(p){n+=p&1;p>>=1;}this.flags.PF=n%2===0;}
    arithmetic(a,b,result,bits,sub=false) {a=uint(a,bits);b=uint(b,bits);const r=uint(result,bits),sign=1n<<BigInt(bits-1);this.szp(r,bits);this.flags.CF=sub?a<b:a+b>mask(bits);this.flags.OF=!!((sub?(a^b)&(a^r):~(a^b)&(a^r))&sign);this.flags.AF=!!((a^b^r)&16n);}
    logic(value,bits){this.szp(value,bits);this.flags.CF=false;this.flags.OF=false;this.flags.AF=null;}
    condition(c) {
      const f=this.flags;const need=keys=>{if(keys.some(k=>f[k]===null))fail('条件依赖未定义的标志位：'+keys.join('/'));};
      const n=conditions[c];need(n<2?['OF']:n<4?['CF']:n<6?['ZF']:n<8?['CF','ZF']:n<10?['SF']:n<12?['PF']:n<14?['SF','OF']:['ZF','SF','OF']);
      return [f.OF,!f.OF,f.CF,!f.CF,f.ZF,!f.ZF,f.CF||f.ZF,!f.CF&&!f.ZF,f.SF,!f.SF,f.PF,!f.PF,f.SF!==f.OF,f.SF===f.OF,f.ZF||f.SF!==f.OF,!f.ZF&&f.SF===f.OF][n];
    }
    snapshot(){return {regs:{...this.regs},flags:{...this.flags},rip:this.rip,frames:this.frames.map(x=>({...x})),buffers:this.buffers.map(x=>({...x})),stackSpaces:this.stackSpaces,provenance:{...this.provenance},output:this.output,inputPos:this.inputPos,seed:this.seed,steps:this.steps,status:this.status,error:this.error,lastEvent:this.lastEvent,frameId:this.frameId,regions:[...this.regions],runtime:Runtime.snapshot(this.runtime),externalMap:new Map(this.externalMap)};}
    restore(s){Object.assign(this,s);}
    back() {const h=this.history.pop();if(!h)return false;for(const [a,v]of h.changes){if(v===undefined)this.memory.delete(a);else this.memory.set(a,v);}this.restore(h.snapshot);return true;}
    readString(address){const out=[];for(let i=0;i<4096;i++){const c=Number(this.readMemory(address+BigInt(i),8));if(c===0)return new TextDecoder().decode(Uint8Array.from(out));out.push(c);}fail('字符串在 4096 字节内没有终止符');}
    model(name) {
      if(Runtime.model(this,name))return;
      if(!['getchar','rand','putchar','puts','printf','exit'].includes(name))fail('暂未实现外部函数模型：'+name);
      let result=0n;
      if(name==='getchar')result=this.inputPos<this.input.length?BigInt(this.input[this.inputPos++]):0xffffffffn;
      if(name==='rand'){this.seed=uint(this.seed*1103515245n+12345n,31);result=this.seed;}
      if(name==='putchar'){const b=this.readReg('edi')&255n;this.output+=String.fromCharCode(Number(b));result=b;}
      if(name==='puts'){this.output+=this.readString(this.readReg('rdi'))+'\n';result=1n;}
      if(name==='printf') {
        const format=this.readString(this.readReg('rdi'));let i=0;
        const text=format.replace(/%%|%[duxscp]/g,s=>{if(s==='%%')return '%';if(i>=5)fail('printf 模型最多支持 5 个寄存器参数');const n=this.readReg(['rsi','rdx','rcx','r8','r9'][i++]);return s==='%p'?(n===0n?'(nil)':hex(n)):s==='%s'?this.readString(n):s==='%c'?String.fromCharCode(Number(n&255n)):s==='%d'?signed(n,32).toString():s==='%u'?uint(n,32).toString():uint(n,32).toString(16);});
        if(format.replace(/%%|%[duxscp]/g,'').includes('%'))fail('printf 模型仅支持 %d %u %x %s %c %p %%');this.output+=text;result=BigInt(new TextEncoder().encode(text).length);
      }
      if(name==='exit'){this.status='halted';this.event.summary='exit 模型结束了程序';return;}
      this.writeReg('eax',result);this.returnFromCall(0n);this.event.summary=`模拟 ${name}，返回 ${hex(uint(result,32))}。这是教学函数模型。`;
      if(this.output.length>65536)fail('输出超过 64 KiB，请重置或缩小程序');
    }
    returnFromCall(extra) {
      const slot=this.regs.rsp,target=this.pop(),top=this.frames.at(-1);
      // PUSH target; RET is also an indirect jump, not necessarily a function return.
      const frame=top&&(top.returnSlot===null||slot>=top.returnSlot)?this.frames.pop():null;
      this.rip=target;this.writeReg('rsp',this.regs.rsp+extra);
      if(frame){for(const b of this.buffers)if(b.frameId===frame.id)b.active=false;
        if(frame.returnAddress!==null&&target!==frame.returnAddress)this.event.warnings.push({type:'control',message:`实际返回到 ${hex(target)}，与原返回地址 ${hex(frame.returnAddress)} 不同。`});}
      if(target===this.sentinel&&this.harness){this.status='halted';this.event.summary='返回教学入口，程序运行结束。';}
    }
    instructionAt(address=this.rip) {
      const original=this.program.map.get(address);
      const read=a=>{const r=this.regionAt(a);return r&&r.readable!==false?this.memory.get(a)??0:null;};
      if(original&&original.bytes.every((b,i)=>read(address+BigInt(i))===b))return original;
      const decoded=Decoder.decode(address,read);
      return {...parseInstruction(decoded.text,0,true),...decoded,annotations:[]};
    }
    dynamicInstructions() {
      const addresses=new Set();
      for(const ev of [...this.history.map(h=>h.snapshot.lastEvent),this.lastEvent])if(ev?.decoded)addresses.add(ev.address);
      const result=new Map();
      for(const address of addresses){try{const ins=this.instructionAt(address);if(ins.dynamic)result.set(address,ins);}catch{}}
      // Preview the current basic block so its instructions can receive breakpoints.
      let address=this.rip;
      for(let i=0;i<12;i++){
        if(this.externalMap.has(address)&&!this.program.map.has(address))break;
        try{const ins=this.instructionAt(address);if(!ins.dynamic)break;result.set(address,ins);address+=BigInt(ins.length);if(['ret','jmp','call','jcc','hlt'].includes(ins.op))break;}catch{break;}
      }
      return [...result.values()].sort((a,b)=>a.address<b.address?-1:1);
    }
    step() {
      if(this.status!=='ready')return false;
      const snapshot=this.snapshot();this.changes=new Map();let ins=this.program.map.get(this.rip);const external=this.externalMap.get(this.rip);
      this.event={step:this.steps+1,address:this.rip,instruction:ins?.text||external||'取指',reads:[],writes:[],warnings:[],summary:'',flagsBefore:{...this.flags}};
      try {
        if(external&&!ins)this.model(external);
        else {
          ins=this.instructionAt();this.event.instruction=ins.text;
          if(ins.dynamic)this.event.decoded=true;
          for(const b of ins.annotations) {const frame=this.frames.at(-1),id=`${frame?.id||0}:${b.line}`;
            if(!this.buffers.some(x=>x.id===id&&x.active)){const start=this.address(b.location,ins);this.buffers.push({id,name:b.name,start,end:start+BigInt(b.size),frameId:frame?.id,active:true});}}
          this.rip=ins.address+BigInt(ins.length);this.execute(ins);
        }
        this.steps++;this.event.flagsAfter={...this.flags};this.event.rspBefore=snapshot.regs.rsp;this.event.rspAfter=this.regs.rsp;
        this.stackSpaces=Stack.advance(this.stackSpaces,this,snapshot,ins);
        if(!this.event.summary)this.event.summary=describe(ins,this.event);
        this.lastEvent=this.event;
      }catch(e) {
        for(const [a,v]of this.changes){if(v===undefined)this.memory.delete(a);else this.memory.set(a,v);}this.restore(snapshot);
        this.status='fault';this.error=e.message;this.lastEvent={...this.event,reads:[],writes:[],warnings:[],summary:e.message,fault:true};this.changes=new Map();
      }
      this.history.push({snapshot,changes:this.changes});if(this.history.length>2000)this.history.shift();this.event=null;this.changes=null;return true;
    }
    execute(ins) {
      const {op,args:a,bits}=ins;const read=(x,b=bits)=>this.read(x,ins,b),write=(x,v,p=null)=>this.write(x,ins,v,p);
      if(['mov','movabs','movzx','movsx'].includes(op)) {
        let v=read(a[0],ins.fromBits||bits);if(op==='movsx')v=signed(v,ins.fromBits);write(a[1],v,this.pointer(a[0]));
        if(op==='mov'&&a[0].reg==='rsp'&&a[1].reg==='rbp'&&this.frames.length)this.frames.at(-1).base=this.regs.rbp;return;
      }
      if(op==='xchg') {
        // Opcode 90 is the NOP alias, even for EAX: it must not clear upper RAX.
        if(a[0].kind==='reg'&&a[0].reg===a[1].reg&&['ax','eax','rax'].includes(a[0].reg)&&ins.bytes.at(-1)===0x90) {this.event.summary='XCHG 自交换的 90 编码是 NOP 别名，不改变寄存器或标志位。';return;}
        const first=read(a[0]),second=read(a[1]),firstPointer=this.pointer(a[0]),secondPointer=this.pointer(a[1]);
        // Complete a memory write before changing a register that may form its address.
        if(a[0].kind==='mem'){write(a[0],second,secondPointer);write(a[1],first,firstPointer);}
        else {write(a[1],first,firstPointer);write(a[0],second,secondPointer);}
        this.event.summary='交换两个操作数的值，标志位保持不变。';return;
      }
      if(op==='lea'){const v=this.address(a[0],ins),buffer=[...this.buffers].reverse().find(b=>b.active&&v>=b.start&&v<b.end);write(a[1],v,buffer?.id||null);return;}
      if(op==='push'){this.push(read(a[0]),bits);return;}
      if(op==='pop'){const v=this.pop(bits);write(a[0],v);return;}
      if(op==='call') {
        const target=read(a[0],64),ret=this.rip;this.push(ret);this.rip=target;
        this.frames.push({id:++this.frameId,name:this.program.externalMap.get(target)||this.nameAt(target),entry:target,returnSlot:this.regs.rsp,returnAddress:ret,base:null,stackEntry:this.regs.rsp});return;
      }
      if(op==='ret'){this.returnFromCall(a.length?read(a[0],16):0n);if(ins.repeatPrefix)this.event.summary=(this.event.summary||'从栈顶取出返回地址，并跳转。')+' 这里的 REP 前缀不重复返回，也不读取 RCX 或 ZF。';return;}
      if(op==='leave'){this.writeReg('rsp',this.readReg('rbp'));this.writeReg('rbp',this.pop());return;}
      if(op==='jmp'){this.rip=read(a[0],64);return;}
      if(op==='jcc'){const taken=this.condition(ins.condition);if(taken)this.rip=read(a[0],64);this.event.summary=`条件 ${ins.mnemonic} ${taken?'成立，跳转到 '+hex(this.rip):'不成立，继续下一条指令'}。`;return;}
      if(op==='setcc'){write(a[0],this.condition(ins.condition)?1n:0n);return;}
      if(op==='pause'||(op==='nop'&&ins.repeatPrefix)){this.event.summary='PAUSE 是自旋等待提示；本教学模拟不模拟时间延迟，不改变寄存器、标志位或内存。';return;}
      if(op==='nop')return;
      if(op==='hlt'){this.status='halted';this.event.summary='遇到 hlt，教学模拟结束。';return;}
      if(op==='cltq'){this.writeReg('rax',signed(this.readReg('eax'),32));return;}
      if(op==='cwtl'){this.writeReg('eax',signed(this.readReg('ax'),16));return;}
      if(op==='cqto'||op==='cltd'){const b=op==='cqto'?64:32;this.writeReg(b===64?'rdx':'edx',signed(this.readReg(b===64?'rax':'eax'),b)<0n?mask(b):0n);return;}
      if(['add','sub','cmp','and','or','xor','test'].includes(op)) {
        const src=read(a[0]),dst=read(a[1]);let result;
        if(op==='add'){result=dst+src;this.arithmetic(dst,src,result,bits);}
        else if(op==='sub'||op==='cmp'){result=dst-src;this.arithmetic(dst,src,result,bits,true);}
        else {result=op==='or'?dst|src:op==='xor'?dst^src:dst&src;this.logic(result,bits);}
        if(!['cmp','test'].includes(op))write(a[1],result,['add','sub'].includes(op)&&a[0].kind==='imm'?this.pointer(a[1]):null);return;
      }
      if(['inc','dec','neg','not'].includes(op)) {
        const v=read(a[0]),cf=this.flags.CF;let result=op==='inc'?v+1n:op==='dec'?v-1n:op==='neg'?-v:~v;
        if(op==='neg')this.arithmetic(0n,v,result,bits,true);else if(op!=='not'){this.arithmetic(v,1n,result,bits,op==='dec');this.flags.CF=cf;}
        write(a[0],result,['inc','dec'].includes(op)?this.pointer(a[0]):null);return;
      }
      if(['shl','shr','sar'].includes(op)) {
        const count=Number(read(a[0],a[0].kind==='reg'?8:bits)&BigInt(bits===64?63:31));if(!count)return;
        const v=read(a[1]),n=BigInt(count),result=op==='shl'?v<<n:op==='shr'?v>>n:signed(v,bits)>>n;
        this.flags.CF=count>=bits?(op==='sar'?!!(v&(1n<<BigInt(bits-1))):null):op==='shl'?!!((v>>BigInt(bits-count))&1n):!!((v>>BigInt(count-1))&1n);
        this.szp(result,bits);this.flags.OF=count===1?(op==='shl'?this.flags.SF!==this.flags.CF:op==='shr'?!!(v&(1n<<BigInt(bits-1))):false):null;this.flags.AF=null;write(a[1],result);return;
      }
      if(op==='imul'&&a.length>1) {
        const x=signed(read(a[0]),bits),y=signed(read(a[1]),bits),r=x*y;write(a.at(-1),r);this.flags.CF=this.flags.OF=signed(uint(r,bits),bits)!==r;for(const f of ['ZF','SF','PF','AF'])this.flags[f]=null;return;
      }
      if(['imul','mul','div','idiv'].includes(op)) {
        const low={8:'al',16:'ax',32:'eax',64:'rax'}[bits],high={8:'ah',16:'dx',32:'edx',64:'rdx'}[bits];let x=read(a[0]);
        if(op==='div'||op==='idiv') {
          let dividend=(this.readReg(high)<<BigInt(bits))|this.readReg(low);if(op==='idiv'){dividend=signed(dividend,bits*2);x=signed(x,bits);}if(x===0n)fail('除零异常：div/idiv 的除数为 0');
          const q=dividend/x,r=dividend%x;if(op==='div'?(q<0n||q>mask(bits)):(q<-(1n<<BigInt(bits-1))||q>(1n<<BigInt(bits-1))-1n))fail('除法异常：商超出目标寄存器范围');
          this.writeReg(low,q);this.writeReg(high,r);for(const f of Object.keys(this.flags))this.flags[f]=null;return;
        }
        let y=this.readReg(low);if(op==='imul'){x=signed(x,bits);y=signed(y,bits);}const result=x*y;
        this.writeReg(low,result);this.writeReg(high,result>>BigInt(bits));this.flags.CF=this.flags.OF=op==='imul'?signed(uint(result,bits),bits)!==result:result>mask(bits);for(const f of ['ZF','SF','PF','AF'])this.flags[f]=null;return;
      }
      fail('执行尚未实现：'+op);
    }
  }
  function describe(ins,event) {
    if(!ins)return '';
    const d={mov:'复制数据；源位置的值保留',movabs:'复制立即数',movzx:'零扩展后写入目标',movsx:'符号扩展后写入目标',lea:'计算有效地址，不读取该地址的内容',push:'栈顶向低地址移动，再写入数据',pop:'读出栈顶数据，再增加栈指针；原字节保留',call:'压入下一条指令的地址，进入被调用函数',ret:'从栈顶取出返回地址，并跳转',leave:'恢复栈指针，再弹出保存的帧指针',cmp:'计算差值并更新标志位，不保存差值',test:'按位与并更新标志位，不保存结果',add:'相加并更新标志位',sub:'相减并更新标志位',xor:'按位异或',and:'按位与',or:'按位或',inc:'加 1，保留 CF',dec:'减 1，保留 CF',div:'无符号除法，商与余数分别写回',idiv:'有符号除法，商向零截断',imul:'有符号乘法',mul:'无符号乘法',cltq:'将 EAX 符号扩展到 RAX',cqto:'将 RAX 符号扩展到 RDX:RAX',nop:'不改变数据状态'};
    let result=(d[ins.op]||'执行 '+ins.mnemonic)+'。';
    if(event.writes.some(w=>w.kind==='reg'&&w.bits===32))result+=' 写入 32 位寄存器会清零对应 64 位寄存器的高 32 位。';return result;
  }
  const api={compile,Machine,hex,regs,names,expression,parseInstruction,encode,bytesLE,externals};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;root.StackLensEngine=api;
})(typeof globalThis!=='undefined'?globalThis:this);
