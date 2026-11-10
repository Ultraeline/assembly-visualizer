const {test}=require('node:test'),assert=require('node:assert/strict');
const E=require('../engine'),W=require('../watch'),{RunController}=require('../execution');
const mem=(name,size=8)=>({name,kind:'memory',expression:name,size,format:'hex'});
function setup(code,data='input: .quad 0x1000\ni: .quad 3\nspill: .quad 0',defs=[mem('input'),mem('i')]){
 const m=new E.Machine(E.compile('.data\n'+data+'\n.text\nmain:\n'+code+'\nhlt')),t=new W.Tracker(m,defs);
 const step=()=>{m.step();t.capture();assert.notEqual(m.status,'fault',m.error);};
 const view=(register,id)=>t.registerCopies(id).find(c=>c.register===register&&c.calculated);
 return {m,t,step,view,run:()=>{while(m.status==='ready')step();}};
}
const loads='movq input,%rax\nmovq i,%rcx\n';
test('LEA carries input+i into EDX and records the destination result under input',()=>{
 const {m,t,step,view}=setup(loads+'addq %rcx,%rax\nlea 0x18(%rax),%edx');
 for(let n=0;n<3;n++)step();const flags={...m.flags};step();
 assert.equal(view('EDX',t.items[0].def.id).label,'低32位(input + i + 0x18)');assert.equal(view('EDX').value,'0x0000101b');assert.equal(m.regs.rdx,0x101bn);
 assert.deepEqual(m.flags,flags);assert.equal(m.lastEvent.reads.some(r=>r.kind==='mem'),false);
 const action=t.latestOperation(t.items[0].def.id);assert.equal(action.summary,'EDX 写入 LEA 计算结果');assert.equal(action.afterExpression,view('EDX').label);assert.equal(action.after,'0x0000101b');
 assert.equal(t.items[0].current.display,'0x0000000000001000');assert.equal(view('RAX').label,'input + i');
});
test('LEA captures old base/index even when overwritten and supports scale and negative offsets',()=>{
 const {view,run}=setup(loads+'leaq -0x18(%rax,%rcx,4),%rax\nleaq 0x20(,%rcx,8),%rcx');run();
 assert.equal(view('RAX').label,'input + i × 4 − 0x18');assert.equal(view('RAX').value,'0x0000000000000ff4');
 assert.equal(view('RCX').label,'i × 8 + 0x20');assert.equal(view('RCX').value,'0x0000000000000038');
});
test('LEA with only a base retains its identity through later arithmetic, spill and pop',()=>{
 const {view,run}=setup('movq input,%rax\nleaq (%rax),%rbx\naddq $1,%rbx\nmovq %rbx,spill\nmovq spill,%rcx\npushq %rcx\npopq %rdx');run();
 for(const register of ['RBX','RCX','RDX'])assert.equal(view(register).label,'input + 1');
});
test('16/32/64-bit destinations preserve actual truncation, upper bits and wraparound',()=>{
 const a=setup('movq input,%rax\nmovq $0x123456789abcdef0,%rdx\nleaw 0x18(%rax),%dx','input: .quad 0xffff\ni: .quad 0');a.run();
 assert.equal(a.view('DX').label,'低16位(input + 0x18)');assert.equal(a.m.regs.rdx,0x123456789abc0017n);
 const b=setup('movq input,%rax\nmovq $-1,%rdx\nleal 0x18(%rax),%edx\nleaq 0x18(%rax),%rbx','input: .quad -8\ni: .quad 0');b.run();
 assert.equal(b.m.regs.rdx,16n);assert.equal(b.view('EDX').value,'0x00000010');assert.equal(b.view('RBX').value,'0x0000000000000010');
});
test('LEA never reads its computed address or mistakes a label address for variable contents',()=>{
 const {m,t,step,view}=setup('movq input,%rax\nleaq 0x18(%rax),%rbx\nleaq input(%rip),%rcx\nleaq input,%rdx','input: .quad 0x7ffffffff000\ni: .quad 0');
 for(let n=0;n<4;n++)step();assert.equal(m.regionAt(m.regs.rbx),undefined);assert.equal(view('RBX').label,'input + 0x18');assert.equal(view('RCX'),undefined);assert.equal(view('RDX'),undefined);
 assert.equal(t.items[0].records.at(-1).step,2);
});
test('a tracked index remains visible with an untracked base and unrelated destination binding',()=>{
 const {t,view,run}=setup(loads+'movq $9,%rax\nleaq 0x18(%rax,%rcx,4),%rbx',undefined,[mem('i'),{name:'dest',kind:'register',expression:'rbx',format:'hex'}]);run();
 assert.equal(view('RBX',t.items[0].def.id).label,'9 + i × 4 + 0x18');assert.equal(view('RBX').value,'0x000000000000002d');assert.equal(t.latestOperation(t.items[1].def.id),null);
});
test('subsequent arithmetic on an index-derived LEA result remains in that variable watch',()=>{
 const {t,view,run}=setup('movq i,%rcx\nmovq $9,%rax\nleaq 0x18(%rax,%rcx,4),%rbx\naddq $1,%rbx',undefined,[mem('i')]);run();
 assert.equal(view('RBX').label,'9 + i × 4 + 0x18 + 1');assert.equal(t.latestOperation(t.items[0].def.id).summary,'RBX 中加了 1');assert.equal(view('RBX').value,'0x000000000000002e');
});
test('fast run, rewind, faults and renaming preserve LEA snapshots',()=>{
 const {m,t,step,view}=setup(loads+'leaq 0x18(%rax,%rcx),%rbx\nmovq $99,input\nmovq %rbx,0x1');
 const runner=new RunController(m,new Set([m.program.instructions[3].address.toString()]),()=>t.capture());let reason;do{reason=runner.advance();}while(!reason);
 assert.equal(reason,'breakpoint');assert.equal(view('RBX').label,'input + i + 0x18');step();assert.equal(view('RBX').stale,true);
 m.step();t.capture();assert.equal(m.status,'fault');assert.deepEqual(m.lastEvent.calculations,[]);assert.equal(view('RBX').value,'0x000000000000101b');
 m.back();t.rewind();m.back();t.rewind();assert.equal(view('RBX').stale,false);
 t.update(t.items[0].def.id,{...t.items[0].def,name:'输入'});assert.equal(view('RBX').label,'输入 + i + 0x18');m.back();t.rewind();assert.equal(view('RBX'),undefined);assert.equal(t.latestOperation(t.items[0].def.id),null);
});
test('the phase4 character load remains a dereference when LEA adds 0x18',()=>{
 const {view,run,m}=setup('movl i,%eax\nmovslq %eax,%rdx\nmovq input,%rax\naddq %rdx,%rax\nmovzbl (%rax),%eax\nmovsbl %al,%eax\nlea 0x18(%rax),%edx','input: .quad target\ni: .long 1\ntarget: .byte 0x54,0x53',[mem('input'),mem('i',4)]);run();
 assert.equal(m.regs.rdx,0x6bn);assert.match(view('EDX').label,/\*\(input \+ 符号扩展64\(i\)\)/);assert.match(view('EDX').label,/\+ 0x18/);assert.doesNotMatch(view('EDX').label,/阶段值/);assert.match(view('EDX').inputs,/0x53（8 位读取）/);
});
test('LEA after a signed byte load preserves negative characters and 32-bit wraparound',()=>{
 for(const [byte,result] of [[255,23n],[128,0xffffff98n]]){
  const {m,view,run}=setup('movq input,%rax\nmovzbl (%rax),%eax\nmovsbl %al,%eax\nlea 0x18(%rax),%edx','input: .quad target\ntarget: .byte '+byte,[mem('input')]);run();
  assert.equal(m.regs.rdx,result);assert.match(view('EDX').label,/符号扩展32\(\*input\)/);assert.match(view('EDX').label,/\+ 0x18/);
 }
});
