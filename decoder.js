(function(root){
  'use strict';
  // A bounded integer subset, not a general disassembler. Read every byte afresh.
  const registers=[['al','cl','dl','bl','spl','bpl','sil','dil'],['ax','cx','dx','bx','sp','bp','si','di'],['eax','ecx','edx','ebx','esp','ebp','esi','edi'],['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi']];
  const conditions=['o','no','b','ae','e','ne','be','a','s','ns','p','np','l','ge','le','g'];
  const hex=v=>v<0n?'-0x'+(-v).toString(16):'0x'+v.toString(16);
  const suffix={8:'b',16:'w',32:'l',64:'q'};
  function decode(address,readByte){
    address=BigInt(address);const bytes=[];let rex=0,hasRex=false,word=false;
    const fail=message=>{throw new Error('无法解码 '+hex(address)+'：'+message);};
    function byte(){
      if(bytes.length===15)fail('指令超过 15 字节');
      const at=address+BigInt(bytes.length),b=readByte(at);
      if(b===null||b===undefined)fail('指令字节未映射或不可读（'+hex(at)+'）');
      bytes.push(b);return b;
    }
    function integer(size,signed=false){let n=0n;for(let i=0;i<size;i++)n|=BigInt(byte())<<BigInt(i*8);return signed?BigInt.asIntN(size*8,n):n;}
    function reg(code,bits){
      if(code>=8)return '%r'+code+({8:'b',16:'w',32:'d',64:''}[bits]);
      if(bits===8&&!hasRex&&code>=4)return '%'+['ah','ch','dh','bh'][code-4];
      return '%'+registers[{8:0,16:1,32:2,64:3}[bits]][code];
    }
    function modrm(bits){
      const b=byte(),mod=b>>6,group=(b>>3)&7,rm=b&7,field=reg(group+((rex&4)?8:0),bits);
      if(mod===3)return {field,group,operand:reg(rm+((rex&1)?8:0),bits),memory:false};
      let base='',index='',scale=1,disp=0n;
      if(rm===4){
        const sib=byte(),rawBase=sib&7,rawIndex=(sib>>3)&7;scale=1<<(sib>>6);
        if(rawIndex!==4||(rex&2))index=reg(rawIndex+((rex&2)?8:0),64);
        if(mod===0&&rawBase===5)disp=integer(4,true);else base=reg(rawBase+((rex&1)?8:0),64);
      }else if(mod===0&&rm===5){base='%rip';disp=integer(4,true);}
      else base=reg(rm+((rex&1)?8:0),64);
      if(mod===1)disp=integer(1,true);if(mod===2)disp=integer(4,true);
      const operand=hex(disp)+(base||index?'('+base+(index?','+index+','+scale:'')+')':'');
      return {field,group,operand,memory:true};
    }
    let opcode=byte();
    if(opcode===0x66){word=true;opcode=byte();}
    if(opcode>=0x40&&opcode<=0x4f){rex=opcode&15;hasRex=true;opcode=byte();}
    const bits=rex&8?64:word?16:32,immSize=bits===16?2:4;
    let text;
    const binary=(name,width,src,dst)=>name+suffix[width]+' '+src+', '+dst;
    const immediate=(size,sign=false)=>'$'+hex(integer(size,sign));
    function relative(name,size){const displacement=integer(size,true);return name+' '+hex(BigInt.asUintN(64,address+BigInt(bytes.length)+displacement));}
    if(opcode===0xf3&&!word&&!hasRex){const next=byte();if(next===0xc3)text='rep ret';else if(next===0x90)text='pause';else fail('尚不支持这个 REP 编码');}
    else if(opcode>=0xb0&&opcode<=0xb7)text=binary('mov',8,immediate(1),reg((opcode&7)+((rex&1)?8:0),8));
    else if(opcode>=0xb8&&opcode<=0xbf)text=binary('mov',bits,immediate(bits/8),reg((opcode&7)+((rex&1)?8:0),bits));
    else if(opcode>=0x50&&opcode<=0x5f){const w=word?16:64;text=(opcode<0x58?'push':'pop')+suffix[w]+' '+reg((opcode&7)+((rex&1)?8:0),w);}
    else if(opcode===0x68||opcode===0x6a){const w=word?16:64;text='push'+suffix[w]+' '+immediate(opcode===0x6a?1:word?2:4,true);}
    else if([0x88,0x89,0x8a,0x8b,0x8d].includes(opcode)){
      const w=opcode===0x88||opcode===0x8a?8:bits,m=modrm(w);
      if(opcode===0x8d&&!m.memory)fail('LEA 需要内存寻址操作数');
      text=opcode===0x8d?binary('lea',w,m.operand,m.field):opcode&2?binary('mov',w,m.operand,m.field):binary('mov',w,m.field,m.operand);
    }
    else if(opcode===0xc6||opcode===0xc7){const w=opcode===0xc6?8:bits,m=modrm(w);if(m.group!==0)fail('尚不支持这个 MOV 编码');text=binary('mov',w,immediate(w===8?1:immSize,w===64),m.operand);}
    else if([0x80,0x81,0x83].includes(opcode)){
      const w=opcode===0x80?8:bits,m=modrm(w),name=['add','or',null,null,'and','sub','xor','cmp'][m.group];
      if(!name)fail('尚不支持带进位算术编码');text=binary(name,w,immediate(opcode===0x81?immSize:1,opcode===0x83||w===64),m.operand);
    }
    else if(opcode<=0x3d&&(opcode&7)<=5&&![2,3].includes(opcode>>3)){
      const name=['add','or',null,null,'and','sub','xor','cmp'][opcode>>3],form=opcode&7,w=form&1?bits:8;
      if(form>=4)text=binary(name,w,immediate(w===8?1:immSize,w===64),reg(0,w));
      else {const m=modrm(w);text=form&2?binary(name,w,m.operand,m.field):binary(name,w,m.field,m.operand);}
    }
    else if(opcode===0x84||opcode===0x85){const w=opcode&1?bits:8,m=modrm(w);text=binary('test',w,m.field,m.operand);}
    else if(opcode===0xff){
      // Near calls/jumps default to 64 bits; INC/DEC retain the normal width.
      const start=bytes.length,m=modrm(64),group=m.group;
      if(group===2||group===4){if(word)fail('尚不支持带 66 前缀的间接跳转');text=(group===2?'call':'jmp')+' *'+m.operand;}
      else if(group===6){if(word)fail('尚不支持此 PUSH 编码');text='pushq '+m.operand;}
      else fail('尚不支持 FF /'+group+' 编码（字节 '+start+'）');
    }
    else if(opcode===0xe8||opcode===0xe9||opcode===0xeb){if(word)fail('尚不支持此分支前缀');text=relative(opcode===0xe8?'call':'jmp',opcode===0xeb?1:4);}
    else if(opcode>=0x70&&opcode<=0x7f){if(word)fail('尚不支持此分支前缀');text=relative('j'+conditions[opcode&15],1);}
    else if(opcode===0x0f){
      const second=byte();
      if(second>=0x80&&second<=0x8f&&!word)text=relative('j'+conditions[second&15],4);
      else if(second===0x1f){const m=modrm(bits);if(m.group!==0)fail('无效的多字节 NOP');text='nop';}
      else fail('尚不支持 0f '+second.toString(16).padStart(2,'0')+' 编码');
    }
    else if(opcode===0x90&&!(rex&1))text='nop';
    else if(opcode===0xc3&&!word)text='ret';
    else if(opcode===0xc2&&!word)text='ret '+immediate(2);
    else if(opcode===0xc9&&!word)text='leave';
    else if(opcode===0xf4&&!word&&!hasRex)text='hlt';
    else fail('尚不支持机器码 '+bytes.map(x=>x.toString(16).padStart(2,'0')).join(' ')+'；请导入对应反汇编或使用已支持的整数指令');
    return {address,text,bytes,length:bytes.length,dynamic:true};
  }
  const api={decode};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.StackLensDecoder=api;
})(typeof globalThis!=='undefined'?globalThis:this);
