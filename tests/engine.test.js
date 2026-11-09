const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('../engine');
const examples=require('../examples');
const machine=(s,c={})=>new E.Machine(E.compile(s),c);
function run(m,limit=3000){while(m.status==='ready'&&limit-->0)m.step();assert.notEqual(limit,-1,'execution budget exhausted');return m;}
function clean(m){assert.equal(m.status,'halted',m.error);}
test('real instruction encoding and RIP-relative relocation',()=>{
 const p=E.compile('.data\nn: .quad 42\n.text\nmain:\npushq %rbp\nmovq %rsp,%rbp\nsubq $0x20,%rsp\nmovq %rdi,-0x18(%rbp)\nleaq n(%rip),%rax\nleave\nret');
 assert.deepEqual(p.instructions.slice(0,4).map(i=>i.bytes),[[0x55],[0x48,0x89,0xe5],[0x48,0x83,0xec,0x20],[0x48,0x89,0x7d,0xe8]]);
 const m=run(new E.Machine(p));clean(m);assert.equal(m.regs.rax,0x600000n);
});
test('all normal examples finish with expected values',()=>{
 for(const [id,result] of [['call',12n],['recursive',10n],['disassembly',42n],['rip',42n]]) {
  const sample=examples.find(e=>e.id===id),m=run(machine(sample.code));clean(m);assert.equal(m.regs.rax,result,id);
  if(id==='rip')assert.equal(m.output,'Hello, StackLens!\n');
 }
});
test('alias writes preserve partial bits, clear upper bits, sign extend',()=>{
 const m=machine(examples.find(e=>e.id==='registers').code);
 m.step();m.step();assert.equal(m.regs.rax,0x11223344556677aan);
 m.step();assert.equal(m.regs.rax,0x112233445566bbccn);
 m.step();assert.equal(m.regs.rax,0xdeadbeefn);
 m.step();m.step();assert.equal(m.regs.rax,0xffffffffdeadbeefn);
 run(m);clean(m);assert.equal(m.regs.rcx,0xefn);assert.equal(m.regs.rdx,0xffffffffdeadbeefn);
});
test('stack allocation and pop preserve bytes',()=>{
 const m=machine('main:\nmovq $42,%rax\npushq %rax\npopq %rbx\nret');const top=m.regs.rsp;
 m.step();m.step();m.step();assert.equal(m.regs.rsp,top);assert.equal(m.readMemory(top-8n,64),42n);
});
test('call stores actual next instruction address and ret uses memory',()=>{
 const p=E.compile('main:\ncall f\nret\nf:\nmovq $5,%rax\nret'),m=new E.Machine(p),sp=m.regs.rsp;
 m.step();assert.equal(m.regs.rsp,sp-8n);assert.equal(m.readMemory(sp-8n,64),0x400005n);assert.equal(m.rip,p.symbols.f);
 run(m);clean(m);assert.equal(m.regs.rax,5n);
});
test('overflow detection follows pointer beyond buffer and corrupted return',()=>{
 const s=examples.find(e=>e.id==='overflow');
 const safe=run(machine(s.code,{input:'1234567890123456'}));clean(safe);assert.equal(safe.regs.rax,1n);
 const m=machine(s.code,{input:s.input});let alerts=[];
 for(let i=0;i<1000&&m.status==='ready';i++){m.step();alerts.push(...(m.lastEvent?.warnings||[]));}
 assert.equal(m.status,'fault');assert.equal(m.rip,0x3837363534333231n);assert.ok(alerts.some(a=>a.type==='overflow'));assert.ok(alerts.some(a=>a.type==='return'));assert.ok(alerts.some(a=>a.type==='control'));
 const fault=m.snapshot();m.back();assert.equal(m.status,'ready');m.step();assert.equal(m.rip,fault.rip);assert.equal(m.status,'fault');
});
test('rewind restores memory, registers, flags, input, frames, buffers, and RNG',()=>{
 const m=machine(examples.find(e=>e.id==='overflow').code,{input:'abc'}),initial=m.snapshot(),memory=[...m.memory];
 run(m);clean(m);while(m.history.length)m.back();assert.deepEqual(m.snapshot(),initial);assert.deepEqual([...m.memory],memory);
 const r=machine('main:\ncall rand\nret');r.step();r.step();const first=r.regs.rax;r.back();r.step();assert.equal(r.regs.rax,first);
});
test('memory faults are atomic and can be rewound',()=>{
 const m=machine('main:\npushq $1\nmovq $123,0x10\nret');m.step();const regs={...m.regs},memory=[...m.memory];m.step();assert.equal(m.status,'fault');assert.deepEqual(m.regs,regs);assert.deepEqual([...m.memory],memory);m.back();assert.equal(m.status,'ready');
});
test('signed and unsigned conditions, flags and inc carry',()=>{
 const m=run(machine('main:\nmovb $255,%al\naddb $1,%al\nincb %al\nsetc %bl\nmovb $127,%al\naddb $1,%al\nseto %cl\nsetl %dl\nret'));
 clean(m);assert.equal(m.readReg('bl'),1n);assert.equal(m.readReg('cl'),1n);assert.equal(m.readReg('dl'),0n);
});
test('signed division uses double width dividend and truncates toward zero',()=>{
 const m=run(machine('main:\nmovq $-17,%rax\ncqto\nmovq $5,%rcx\nidivq %rcx\nret'));clean(m);assert.equal(E.expression('-3')&((1n<<64n)-1n),m.regs.rax);assert.equal(m.regs.rdx,BigInt.asUintN(64,-2n));
 const z=run(machine('main:\nxorq %rdx,%rdx\nmovq $4,%rax\nxorq %rcx,%rcx\ndivq %rcx\nret'));assert.equal(z.status,'fault');assert.equal(z.regs.rax,4n);
});
test('multiplication and shifts',()=>{
 const m=run(machine('main:\nmovq $5,%rax\nimulq $16,%rax,%rax\nshrq $2,%rax\nmovb $1,%cl\nshlq %cl,%rax\nret'));clean(m);assert.equal(m.regs.rax,40n);
});
test('SIB addressing, extended registers, data directives, high byte registers',()=>{
 const m=run(machine('.data\nx: .quad 11,22,33\n.text\nmain:\nleaq x(%rip),%r12\nmovq $2,%r13\nmovq (%r12,%r13,8),%r8\nmovb $0x12,%ah\nmovb %ah,%bl\nret'));clean(m);assert.equal(m.regs.r8,33n);assert.equal(m.readReg('bl'),18n);
});
test('invalid instructions and ambiguous widths fail explicitly',()=>{
 for(const s of ['magic %rax','mov $1,(%rax)','movq %eax,%rbx','movq $0x123456789,(%rsp)','movb %ah,%r8b','.text\n.byte 0x90','movq %rax,%rsp\ncall missing'])assert.throws(()=>E.compile(s),undefined,s);
});
test('custom memory and initial registers support fixed addresses',()=>{
 const m=run(machine('main:\nmovq $0x400ac7,0x3fffa8\nmovl $0x3fff80,%edi\nret',{regions:[{address:'0x3ff000',size:4096}],registers:{rbx:'0x1234'}}));clean(m);assert.equal(m.readMemory(0x3fffa8n,64),0x400ac7n);assert.equal(m.regs.rdi,0x3fff80n);assert.equal(m.regs.rbx,0x1234n);
});
test('32 bit mul/div preserve zero extension of EDX:EAX',()=>{
 const m=run(machine('main:\nmovl $0xffffffff,%eax\nmovl $2,%ecx\nmull %ecx\ndivl %ecx\nret'));clean(m);assert.equal(m.regs.rax,0xffffffffn);assert.equal(m.regs.rdx,0n);
});
test('printf percent literals and arguments are reversible',()=>{
 const m=run(machine('.data\nf: .asciz "n=%d %%"\n.text\nmain:\nleaq f(%rip),%rdi\nmovl $-3,%esi\ncall printf\nret'));clean(m);assert.equal(m.output,'n=-3 %');m.back();m.back();assert.equal(m.output,'');
});
test('invalid operand sizes and malformed constants are rejected',()=>{
 for(const s of ['retw','callw main','leavew','hltq','movq $08,%rax','movq $1foo,%rax'])assert.throws(()=>E.compile('main:\n'+s));
});
test('sized NOPs encode valid instructions and do not read unmapped operands',()=>{
 const p=E.compile('main:\nnop\nnopw\nnopl (%rax)\nnopw (%rax,%rax,1)\nnopl %eax\nnopq %rax\nret');
 assert.deepEqual(p.instructions.slice(0,6).map(i=>i.bytes),[[0x90],[0x66,0x90],[0x0f,0x1f,0],[0x66,0x0f,0x1f,4,0],[0x0f,0x1f,0xc0],[0x48,0x0f,0x1f,0xc0]]);
 const m=new E.Machine(p,{registers:{rax:'0xffffffffffffffff'}}),initial=m.snapshot(),memory=[...m.memory];
 for(let i=0;i<6;i++){m.step();assert.equal(m.status,'ready');assert.deepEqual(m.regs,initial.regs);assert.deepEqual(m.flags,initial.flags);assert.deepEqual(m.lastEvent.reads,[]);assert.deepEqual(m.lastEvent.writes,[]);assert.equal(m.rip,p.instructions[i+1].address);}
 assert.deepEqual([...m.memory],memory);while(m.history.length)m.back();assert.deepEqual(m.snapshot(),initial);
});
test('NOP prefixes and segment notation keep source lengths and labels correct',()=>{
 const p=E.compile('main:\ndata16 cs nopw 0(%rax,%rax,1)\nnopw %cs:0(%rax,%rax,1)\nnopl (%eax)\nrex.W nop\ncall f\nret\nf:\nret');
 assert.deepEqual(p.instructions.slice(0,4).map(i=>i.bytes),[[0x66,0x2e,0x66,0x0f,0x1f,4,0],[0x2e,0x66,0x0f,0x1f,4,0],[0x67,0x0f,0x1f,0],[0x48,0x90]]);
 assert.equal(p.instructions[4].address,0x400013n);assert.equal(p.symbols.f,0x400019n);clean(run(new E.Machine(p)));
});
test('objdump multi-byte NOPs retain original bytes, continuation lines, and RIP',()=>{
 const p=E.compile(`0000000000400100 <main>:
  400100: 0f 1f 44 00 00          nopl 0x0(%rax,%rax,1)
  400105: 66 2e 0f 1f 84 00 00    nopw %cs:0x0(%rax,%rax,1)
  40010c: 00 00 00
  40010f: 66 66 2e 0f 1f 84 00    data16 cs nopw 0x0(%rax,%rax,1)
  400116: 00 00 00 00
  40011a: c3                      ret`);
 assert.deepEqual(p.instructions.map(i=>i.length),[5,10,11,1]);
 const m=new E.Machine(p);for(const target of [0x400105n,0x40010fn,0x40011an]){m.step();assert.equal(m.status,'ready');assert.equal(m.rip,target);assert.deepEqual(m.lastEvent.reads,[]);assert.deepEqual(m.lastEvent.writes,[]);}clean(run(m));
});
test('RIP-relative NOP relocation includes extra prefix bytes',()=>{
 const p=E.compile('main:\ndata16 nopw next(%rip)\nnext:\nret');assert.deepEqual(p.instructions[0].bytes,[0x66,0x66,0x0f,0x1f,5,0,0,0,0]);clean(run(new E.Machine(p)));
});
test('invalid NOP forms fail and NOP prefix support does not widen other instructions',()=>{
 for(const s of ['nopb','nopl $1','nopw %eax','nopl %eax,%eax','nopl *(%rax)','lock nopl (%rax)','rex.B nop','data16 movl %eax,%ebx','nopl (%rax,%eax,1)','movq (%eax),%rbx'])assert.throws(()=>E.compile('main:\n'+s),undefined,s);
});
test('REP RET aliases encode and return once independently of RCX and ZF',()=>{
 for(const spelling of ['rep ret','repe retq','repz ret'])for(const rcx of ['0','3'])for(const zf of [false,true]) {
  const p=E.compile('main:\n'+spelling);assert.deepEqual(p.instructions[0].bytes,[0xf3,0xc3]);
  const m=new E.Machine(p,{registers:{rcx}});m.flags.ZF=zf;const initial=m.snapshot(),memory=[...m.memory];
  m.step();clean(m);assert.equal(m.steps,1);assert.equal(m.regs.rsp,initial.regs.rsp+8n);assert.equal(m.regs.rcx,BigInt(rcx));assert.deepEqual(m.flags,initial.flags);assert.deepEqual([...m.memory],memory);
  m.back();assert.deepEqual(m.snapshot(),initial);
 }
});
test('prefixed RET keeps source labels, disassembly length and optional stack adjustment',()=>{
 const p=E.compile('main:\ncall f\nret\nf:\nrepz ret $16\nnext:\nnop');assert.equal(p.symbols.next,p.symbols.f+4n);assert.deepEqual(p.instructions[2].bytes,[0xf3,0xc2,16,0]);
 const m=new E.Machine(E.compile('000000000040090a <main>:\n  40090a: f3 c3 repz ret\n  40090c: 90 nop'));assert.equal(m.program.instructions[0].length,2);m.step();clean(m);
 const adjusted=machine('main:\nrepz ret $16'),sp=adjusted.regs.rsp;adjusted.step();clean(adjusted);assert.equal(adjusted.regs.rsp,sp+24n);
});
test('REP NOP and PAUSE preserve data state and do not consume RCX',()=>{
 const p=E.compile('main:\nrep nop\nrepz nop\npause\nret');assert.deepEqual(p.instructions.slice(0,3).map(x=>x.bytes),[[0xf3,0x90],[0xf3,0x90],[0xf3,0x90]]);
 const m=new E.Machine(p,{registers:{rcx:'9',rax:'0x1122334455667788'}}),initial=m.snapshot();
 for(let i=0;i<3;i++){m.step();assert.deepEqual(m.regs,initial.regs);assert.deepEqual(m.flags,initial.flags);assert.deepEqual(m.lastEvent.reads,[]);assert.deepEqual(m.lastEvent.writes,[]);}clean(run(m));
});
test('unsupported repeat instructions and prefix combinations are not silently ignored',()=>{
 for(const s of ['rep movsb','repe cmpsb','repne scasb','repz addq %rax,%rbx','repnz ret','repz nopl (%rax)','rep nopw','rep data16 ret','data16 ret','pause %rax','lock xchgq %rax,%rbx'])assert.throws(()=>E.compile('main:\n'+s),undefined,s);
});
test('XCHG swaps register values and overlapping byte aliases without changing flags',()=>{
 const m=machine('main:\nxchgq %rax,%rbx\nxchgb %ah,%al\nret',{registers:{rax:'0x1122',rbx:'0xaabb'}});const flags={...m.flags};
 m.step();assert.equal(m.regs.rax,0xaabbn);assert.equal(m.regs.rbx,0x1122n);m.step();assert.equal(m.regs.rax,0xbbaan);assert.deepEqual(m.flags,flags);clean(run(m));
});
test('XCHG memory uses original address and all writes roll back on a fault',()=>{
 for(const op of ['xchgq %rax,(%rax)','xchgq (%rax),%rax']) {
  const m=machine('main:\n'+op+'\nret',{registers:{rax:'0x600000'},regions:[{address:'0x600000',size:8,hex:'2a00000000000000'}]});const initial=m.snapshot();
  m.step();assert.equal(m.regs.rax,42n);assert.equal(m.readMemory(0x600000n,64),0x600000n);m.back();assert.deepEqual(m.snapshot(),initial);assert.equal(m.readMemory(0x600000n,64),42n);
 }
 const m=machine('main:\nxchgq %rax,(%rax)',{registers:{rax:'0x1234'}});const initial=m.snapshot();m.step();assert.equal(m.status,'fault');assert.deepEqual(m.regs,initial.regs);m.back();assert.deepEqual(m.snapshot(),initial);
});
test('XCHG NOP aliases preserve upper RAX, while ModRM EAX exchange zero extends',()=>{
 const p=E.compile('main:\nxchg %ax,%ax\nxchg %eax,%eax\nxchg %rax,%rax\nret');assert.deepEqual(p.instructions.slice(0,3).map(i=>i.bytes),[[0x66,0x90],[0x90],[0x48,0x90]]);
 const m=new E.Machine(p,{registers:{rax:'0x1122334455667788'}});for(let i=0;i<3;i++){m.step();assert.equal(m.regs.rax,0x1122334455667788n);}
 const d=machine('0000000000400000 <main>:\n 400000: 87 c0 xchg %eax,%eax\n 400002: c3 ret',{registers:{rax:'0x1122334455667788'}});d.step();assert.equal(d.regs.rax,0x55667788n);
 for(const bad of ['xchgq (%rax),(%rbx)','xchgq $1,%rax','xchgq %eax,%rax'])assert.throws(()=>E.compile(bad));
});
