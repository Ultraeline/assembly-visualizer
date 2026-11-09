const {test}=require('node:test'),assert=require('node:assert/strict');
const E=require('../engine'),R=require('../runtime');
const machine=(source,config={})=>new E.Machine(E.compile(source),config);
function run(m,limit=5000){while(m.status==='ready'&&limit-->0)m.step();assert.equal(m.status,'halted',m.error||'execution budget exhausted');return m;}
function invoke(m,name,args=[]){
  ['rdi','rsi','rdx','rcx','r8','r9'].forEach((k,i)=>m.regs[k]=BigInt(args[i]||0));
  m.push(m.program.instructions[0].address);m.frames.push({id:++m.frameId,name,entry:m.program.symbols[name],returnSlot:m.regs.rsp,returnAddress:m.program.instructions[0].address,base:null,stackEntry:m.regs.rsp});m.rip=m.program.symbols[name];m.step();assert.notEqual(m.status,'fault',m.error);
}
const memoryConfig={regions:[{address:'0x600000',size:8192}]};

test('process entry contains argc, argv, envp, auxv and aligned RSP without sentinel',()=>{
  const m=machine('_start:\npopq %rsi\nmovq %rsp,%rdx\nhlt',{runtime:'linux',argv:['demo','a b'],env:['X=1']});
  const sp=m.regs.rsp;assert.equal(sp%16n,0n);assert.equal(m.readMemory(sp,64),2n);assert.equal(m.frames[0].returnSlot,null);
  assert.equal(m.readString(m.readMemory(sp+8n,64)),'demo');assert.equal(m.readString(m.readMemory(sp+16n,64)),'a b');assert.equal(m.readMemory(sp+24n,64),0n);
  assert.equal(m.readString(m.readMemory(sp+32n,64)),'X=1');assert.equal(m.readMemory(sp+40n,64),0n);assert.equal(m.readMemory(sp+48n,64),6n);
  m.step();assert.equal(m.regs.rsi,2n);m.back();assert.equal(m.regs.rsp,sp);assert.throws(()=>machine('hlt',{runtime:'linux',argv:['bad\0arg']}),/NUL/);
});

test('libc startup calls init then main then fini, preserving main exit code and undo',()=>{
  const m=machine(`_start:
popq %rsi
movq %rsp,%rdx
movq $main,%rdi
movq $init,%rcx
movq $fini,%r8
call __libc_start_main
hlt
init:
movq $11,%rbx
ret
main:
addq $1,%rbx
movl $7,%eax
ret
fini:
addq $1,%rbx
movl $99,%eax
ret`,{runtime:'linux'});
  const initial=m.snapshot(),memory=[...m.memory];run(m);assert.equal(m.runtime.exitCode,7);assert.equal(m.regs.rbx,13n);
  while(m.history.length)m.back();assert.deepEqual(m.snapshot(),initial);assert.deepEqual([...m.memory],memory);
});

test('fread consumes partial items correctly, shares stdin with getchar and is reversible',()=>{
  const m=machine('main:\nhlt',{...memoryConfig,input:'ABCDE'});
  invoke(m,'fread',[0x600000,2,3,0x71000000]);assert.equal(m.regs.rax,2n);assert.equal(m.inputPos,5);assert.deepEqual(m.peek(0x600000n,6),[65,66,67,68,69,0]);
  m.back();assert.equal(m.inputPos,0);assert.deepEqual(m.peek(0x600000n,6),[0,0,0,0,0,0]);m.step();assert.equal(m.inputPos,5);
  invoke(m,'getchar');assert.equal(m.regs.rax,0xffffffffn);invoke(m,'fread',[0x600000,0,20,0x71000000]);assert.equal(m.regs.rax,0n);
});

test('virtual fopen/fread/fclose and stderr fwrite preserve bytes and handle failures',()=>{
  const m=machine('.data\npath: .asciz "in.txt"\nmode: .asciz "rb"\nbuf: .zero 12\n.text\nmain:\nhlt',{files:{'in.txt':{hex:'00 ff 41 42'}}});
  invoke(m,'fopen',[m.program.symbols.path,m.program.symbols.mode]);const handle=m.regs.rax;assert.notEqual(handle,0n);
  invoke(m,'fread',[m.program.symbols.buf,1,12,handle]);assert.equal(m.regs.rax,4n);assert.deepEqual(m.peek(m.program.symbols.buf,4),[0,255,65,66]);
  invoke(m,'fwrite',[m.program.symbols.buf+2n,1,2,0x71000200]);assert.equal(m.output,'AB');m.back();assert.equal(m.output,'');m.step();
  invoke(m,'fclose',[handle]);assert.equal(m.runtime.streams[handle.toString()],undefined);m.back();assert.equal(m.runtime.streams[handle.toString()].pos,4);m.step();
  const missing=machine('.data\np: .asciz "absent"\nr: .asciz "r"\n.text\nmain:\nhlt');invoke(missing,'fopen',[missing.program.symbols.p,missing.program.symbols.r]);assert.equal(missing.regs.rax,0n);
});

test('mmap replaces MAP_FIXED bytes, grows downward, munmap and undo restore mappings',()=>{
  const m=machine('main:\nhlt',{regions:[{address:'0x4000000',size:16384,hex:'41 42 43'}]});
  invoke(m,'mmap',[0x4000000,16384,7,0x132,0,0]);assert.equal(m.regs.rax,0x4000000n);assert.equal(m.readMemory(0x4000000n,32),0n);
  m.back();assert.deepEqual(m.peek(0x4000000n,3),[65,66,67]);assert.equal(m.regionAt(0x4000000n).mapping,undefined);m.step();
  invoke(m,'memset',[0x3fffff8,65,8]);assert.equal(m.regionAt(0x3fff000n).start,0x3fff000n);assert.equal(m.readMemory(0x3fffff8n,64),0x4141414141414141n);
  m.back();assert.equal(m.regionAt(0x3fffff8n),undefined);m.step();
  invoke(m,'memset',[0x4000000,66,8]);invoke(m,'munmap',[0x4000000,16384]);assert.equal(m.regionAt(0x4000000n),undefined);assert.ok(m.regionAt(0x3fffff8n));
  m.back();assert.equal(m.readMemory(0x4000000n,64),0x4242424242424242n);m.step();invoke(m,'mmap',[0x4000000,16384,3,0x32,0,0]);assert.equal(m.readMemory(0x4000000n,64),0n);
});

test('anonymous memory protections and library fault rollback are enforced',()=>{
  const m=machine('main:\nhlt');invoke(m,'mmap',[0x4000000,4096,1,0x32,0,0]);assert.throws(()=>m.writeMemory(0x4000000n,8,1n),/只读/);
  m.regs.rdi=0x4000000n;m.regs.rsi=42n;m.regs.rdx=8n;m.push(m.program.instructions[0].address);m.rip=m.program.symbols.memset;const before=m.snapshot(),bytes=[...m.memory];m.step();assert.equal(m.status,'fault');assert.deepEqual(m.regs,before.regs);assert.deepEqual([...m.memory],bytes);m.back();assert.deepEqual(m.snapshot(),before);
  assert.throws(()=>machine('hlt',{pid:-1}),/PID/);
});

test('mmap keeps 64-bit pointers and partial munmap splits the mapped interval',()=>{
  const m=machine('main:\nhlt');invoke(m,'mmap',[0x100000000n,12288,3,0x32]);assert.equal(m.regs.rax,0x100000000n);
  invoke(m,'munmap',[0x100001000n,1]);assert.ok(m.regionAt(0x100000fffn));assert.equal(m.regionAt(0x100001000n),undefined);assert.ok(m.regionAt(0x100002000n));m.back();assert.ok(m.regionAt(0x100001000n));
});

test('library input writes report annotated buffer overflow and undo all bytes',()=>{
  const m=machine(`main:
subq $16,%rsp
# @buffer input, (%rsp), 4
leaq (%rsp),%rdi
movq $1,%rsi
movq $8,%rdx
movq $0x71000000,%rcx
call fread
addq $16,%rsp
ret`,{input:'ABCDEFGH'});
  while(m.rip!==m.program.symbols.fread)m.step();const before=m.snapshot(),bytes=[...m.memory];m.step();assert.equal(m.lastEvent.warnings.filter(w=>w.type==='overflow').length,4);m.back();assert.deepEqual(m.snapshot(),before);assert.deepEqual([...m.memory],bytes);
});

// Small, authored ELF fixture: two PT_LOAD segments plus real symbol/rela/dynamic sections.
// No course executable or private binary is committed with the tests.
function fixture(){
  const p=E.compile(`.data
got: .quad 0
stdin_slot: .quad 0
counter: .quad 0
init_array: .quad init
fini_array: .quad fini
message: .asciz "ELF hello"
.text
_start:
popq %rsi
movq %rsp,%rdx
movq $main,%rdi
xorl %ecx,%ecx
call plt
hlt
plt:
jmp *0x600000
init:
addq $1,counter(%rip)
ret
main:
movq $message,%rdi
call puts
movq $9,%rax
ret
fini:
addq $1,counter(%rip)
ret`);
  const b=Buffer.alloc(0x4000),v=new DataView(b.buffer,b.byteOffset,b.length),w16=(a,n)=>v.setUint16(a,n,true),w32=(a,n)=>v.setUint32(a,n,true),w64=(a,n)=>v.setBigUint64(a,BigInt(n),true);
  b.set([127,69,76,70,2,1,1]);w16(16,2);w16(18,62);w32(20,1);w64(24,p.symbols._start);w64(32,64);w64(40,0x3000);w16(52,64);w16(54,56);w16(56,2);w16(58,64);w16(60,6);w16(62,1);
  const codeSize=Number(p.instructions.at(-1).address)+p.instructions.at(-1).length-0x400000;
  for(const [i,offset,address,size,memsz,flags]of [[0,0x1000,0x400000,codeSize,codeSize,5],[1,0x2000,0x600000,128,4096,6]]){const a=64+i*56;w32(a,1);w32(a+4,flags);w64(a+8,offset);w64(a+16,address);w64(a+32,size);w64(a+40,memsz);w64(a+48,4096);}
  for(const ins of p.instructions)b.set(ins.bytes,0x1000+Number(ins.address-0x400000n));for(const d of p.data)b.set(d.bytes,0x2000+Number(d.address-0x600000n));
  const strings='\0.shstrtab\0.dynstr\0.dynsym\0.rela.dyn\0.dynamic\0';b.write(strings,0x2800);b.write('\0__libc_start_main\0stdin\0',0x2900);
  const sections=[[0,0,0,0,0,0],[1,3,0x2800,strings.length,0,0],[11,3,0x2900,25,0,0],[19,11,0x2a00,72,2,24],[27,4,0x2b00,48,3,24],[37,6,0x2c00,80,2,16]];
  sections.forEach(([name,type,offset,size,link,entsize],i)=>{const a=0x3000+i*64;w32(a,name);w32(a+4,type);w64(a+24,offset);w64(a+32,size);w32(a+40,link);w64(a+56,entsize);});
  w32(0x2a18,1);b[0x2a1c]=18;w32(0x2a30,19);b[0x2a34]=17;w16(0x2a36,1);w64(0x2a38,p.symbols.stdin_slot);w64(0x2a40,8);
  w64(0x2b00,p.symbols.got);w64(0x2b08,(1n<<32n)|7n);w64(0x2b18,p.symbols.stdin_slot);w64(0x2b20,(2n<<32n)|5n);
  [[25,p.symbols.init_array],[27,8],[26,p.symbols.fini_array],[28,8],[0,0]].forEach(([tag,val],i)=>{w64(0x2c00+i*16,tag);w64(0x2c08+i*16,val);});
  return {program:p,bytes:b,image:R.image(b,'fixture')};
}

test('ELF loads constants/BSS, binds GOT/COPY, executes PLT, init/main/fini and exits',()=>{
  const f=fixture(),m=new E.Machine(f.program,{image:f.image});assert.equal(m.processMode,true);assert.equal(m.readMemory(0x600008n,64),0x71000000n);assert.equal(m.readMemory(0x600080n,64),0n);assert.equal(m.regionAt(0x400000n).writable,false);
  run(m);assert.equal(m.output,'ELF hello\n');assert.equal(m.runtime.exitCode,9);assert.equal(m.readMemory(f.program.symbols.counter,64),2n);assert.ok(m.history.some(h=>h.snapshot.rip===f.program.symbols.plt));
  m.back();assert.equal(m.status,'ready');m.step();assert.equal(m.status,'halted');assert.equal(m.runtime.exitCode,9);
});

test('ELF rejects truncated, mismatched, wrong-architecture, PIE and unsupported relocations',()=>{
  const f=fixture();assert.throws(()=>R.image(f.bytes.subarray(0,50)),/截断/);
  const pie=Buffer.from(f.bytes);pie.writeUInt16LE(3,16);assert.throws(()=>R.image(pie),/PIE/);
  const wrong=Buffer.from(f.bytes);wrong.writeUInt16LE(183,18);assert.throws(()=>R.image(wrong),/x86-64/);
  const mismatch=Buffer.from(f.bytes);mismatch[0x1000]^=1;assert.throws(()=>new E.Machine(f.program,{image:R.image(mismatch)}),/不匹配/);
  const relocation=Buffer.from(f.bytes);relocation.writeUInt32LE(999,0x2b08);assert.throws(()=>new E.Machine(f.program,{image:R.image(relocation)}),/重定位类型 999/);
  const serialized=JSON.parse(JSON.stringify(f.image));assert.equal(new E.Machine(f.program,{image:serialized}).rip,f.program.symbols._start);
});
