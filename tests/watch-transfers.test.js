const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('../engine'),W=require('../watch'),{RunController}=require('../execution');
const mem=(expression='value',size=4)=>({name:'count',kind:'memory',expression,size,format:'hex'});
const reg=(expression='eax')=>({name:'count',kind:'register',expression,format:'signed'});
function setup(body,defs=[mem()],data='value: .quad 42\nother: .quad 42'){
 const m=new E.Machine(E.compile('.data\n'+data+'\n.text\nmain:\n'+body+'\nhlt'));
 const t=new W.Tracker(m,defs),step=()=>{m.step();t.capture();assert.notEqual(m.status,'fault',m.error);};
 const copies=()=>t.registerCopies().filter(c=>!c.bound);
 return {m,t,step,copies};
}

test('memory to register to register follows storage identity, not equal values',()=>{
 const {t,step,copies}=setup('movl value,%eax\nmovl %eax,%edi\nmovl other,%ebx\nmovl $42,%ecx');
 step();assert.deepEqual(copies().map(c=>[c.register,c.label,c.value]),[['EAX','count','0x0000002a']]);
 step();step();step();assert.deepEqual(copies().map(c=>c.register),['EAX','EDI']);
 assert.deepEqual(t.items[0].records.map(r=>r.step),[1,2]);
});
test('overwrites clear copies while supported arithmetic now records an expression',()=>{
 const {step,copies}=setup('movl value,%eax\nmovl %eax,%ebx\nmovl $42,%eax\naddl $0,%ebx');
 step();step();step();assert.deepEqual(copies().map(c=>c.register),['EBX']);
 step();assert.equal(copies()[0].label,'count + 0');assert.equal(copies()[0].value,'0x0000002a');
});
test('memory changes leave a labeled old register copy with its actual value',()=>{
 const {t,step,copies}=setup('movl value,%eax\nmovl $99,value\nmovl %eax,%ebx');
 step();step();step();assert.equal(t.items[0].current.display,'0x00000063');
 assert.ok(copies().every(c=>c.stale&&c.value==='0x0000002a'));
 assert.equal(copies().length,2);
});
test('partial overwrite removes the overlapping association; disjoint aliases survive',()=>{
 const {step,copies}=setup('movb value,%al\nmovb $7,%ah\nmovb $2,%al',[mem('value',1)]);
 step();step();assert.equal(copies()[0].register,'AL');step();assert.deepEqual(copies(),[]);
 const full=setup('movq value,%rax\nmovb $42,%al',[mem('value',8)]);
 full.step();full.step();assert.deepEqual(full.copies(),[]);
});
test('32-bit writes clear the entire parent, and a wider copy preserves the true source width',()=>{
 const {step,copies}=setup('movl value,%eax\nmovq %rax,%rbx\nmovl $42,%ebx');
 step();step();assert.deepEqual(copies().map(c=>c.register),['EAX','EBX']);
 step();assert.deepEqual(copies().map(c=>c.register),['EAX']);
});
test('buffer slices and high-byte aliases retain byte offsets',()=>{
 const {step,copies}=setup('movl value+4,%edx\nmovb %dh,%al',[{...mem('value',16),name:'buf',format:'bytes'}],'value: .quad 0x1122334455667788\n.quad 0');
 step();assert.equal(copies()[0].label,'buf[4:8]');
 step();assert.deepEqual(copies().map(c=>[c.register,c.label,c.value]),[['EDX','buf[4:8]','0x11223344'],['AL','buf[5:6]','0x33']]);
});
test('zero/sign extension and CLTQ carry explicit extension labels',()=>{
 const {step,copies}=setup('movzbl value,%eax\nmovsbl value,%ebx\nmovl value,%ecx',[mem('value',1)],'value: .quad 255');
 step();step();assert.deepEqual(copies().map(c=>[c.register,c.extension,c.value]),[['EAX','zero','0x000000ff'],['EBX','sign','0xffffffff']]);
 const sign=setup('movl value,%eax\ncltq\nmovq %rax,%rdi',[mem()],'value: .quad 0xffffffff');
 sign.step();sign.step();sign.step();assert.ok(sign.copies().every(c=>c.extension==='sign'&&c.value==='0xffffffffffffffff'));
});
test('XCHG uses both pre-instruction sources, including memory-address registers',()=>{
 const {step,copies}=setup('movl value,%eax\nmovl $9,%ebx\nxchgl %eax,%ebx');
 step();step();step();assert.deepEqual(copies().map(c=>c.register),['EBX']);
 const p=setup('leaq value,%rax\nxchgq %rax,(%rax)',[mem('value',8)]);
 p.step();p.step();assert.equal(p.copies()[0].register,'RAX');assert.equal(p.copies()[0].value,'0x000000000000002a');
});
test('successive extensions retain the order of value transformations',()=>{
 const {step,copies}=setup('movzbl value,%eax\ncltq',[mem('value',1)],'value: .quad 255');
 step();step();assert.equal(copies()[0].extension,'zero,sign');assert.equal(copies()[0].value,'0x00000000000000ff');
});
test('PUSH/POP and spilled MOV values retain provenance; an overwritten spill loses it',()=>{
 const {step,copies}=setup('movq value,%rax\npushq %rax\nxorq %rax,%rax\npopq %rbx\nmovq %rbx,other\nxorq %rbx,%rbx\nmovq other,%rdi',[mem('value',8)]);
 for(let i=0;i<7;i++)step();assert.deepEqual(copies().map(c=>c.register),['RDI']);
 const p=setup('movq value,%rax\npushq %rax\nmovb $0,(%rsp)\npopq %rbx',[mem('value',8)]);
 for(let i=0;i<4;i++)p.step();assert.deepEqual(p.copies().map(c=>c.register),['RAX']);
});
test('LEA is an address calculation and does not claim to contain the watched value',()=>{
 const {step,copies}=setup('leaq value,%rax\nmovq %rax,%rbx');step();step();assert.deepEqual(copies(),[]);
});
test('register bindings seed transfers immediately and rename/remove/rebind update associations',()=>{
 const {t,step,copies}=setup('movl $42,%eax\nmovl %eax,%edi',[reg()]);step();step();
 const item=t.items[0];assert.equal(copies()[0].label,'count');
 t.update(item.def.id,{...item.def,name:'结果'});assert.equal(copies()[0].label,'结果');
 t.update(item.def.id,{...item.def,expression:'ebx'});assert.deepEqual(copies(),[]);
 t.remove(item.def.id);assert.deepEqual(t.registerCopies(),[]);
});
test('rewind restores associations and re-execution does not duplicate records',()=>{
 const {m,t,step,copies}=setup('movl value,%eax\nmovl %eax,%edi\nxorl %eax,%eax');
 step();step();step();assert.deepEqual(copies().map(c=>c.register),['EDI']);
 m.back();t.rewind();assert.deepEqual(copies().map(c=>c.register),['EAX','EDI']);
 m.back();t.rewind();assert.deepEqual(copies().map(c=>c.register),['EAX']);
 step();assert.equal(t.items[0].records.length,2);assert.equal(copies().length,2);
 m.back();t.rewind();m.back();t.rewind();assert.deepEqual(copies(),[]);
});
test('fault rollback preserves copies and never publishes partially executed transfers',()=>{
 const {m,t,step,copies}=setup('movl value,%eax\nmovl %eax,0x1');step();
 m.step();t.capture();assert.equal(m.status,'fault');assert.deepEqual(m.lastEvent.transfers,[]);
 assert.equal(copies()[0].register,'EAX');m.back();t.rewind();assert.equal(copies()[0].register,'EAX');
});
test('fast run captures copies at a breakpoint without changing machine execution',()=>{
 const {m,t}=setup('movl value,%eax\nmovl %eax,%edi\nxorl %eax,%eax');
 const runner=new RunController(m,new Set([m.program.instructions[2].address.toString()]),()=>t.capture());
 let reason;do{reason=runner.advance();}while(!reason);
 assert.equal(reason,'breakpoint');assert.deepEqual(t.registerCopies().map(c=>c.register),['EAX','EDI']);
 const snapshot=m.snapshot(),memory=[...m.memory];t.registerCopies();assert.deepEqual(m.snapshot(),snapshot);assert.deepEqual([...m.memory],memory);
});
test('follow expressions use their pre-instruction address and new trackers start without copies',()=>{
 const {m,t,step,copies}=setup('movq (%rsp),%rsp',[mem('(%rsp)',8)]);
 step();assert.equal(copies()[0].register,'RSP');assert.equal(copies()[0].stale,true);
 assert.deepEqual(new W.Tracker(m,t.definitions()).registerCopies(),[]);
});
test('replacing one stale copy with another records the actual register value change',()=>{
 const {t,step}=setup('movl value,%eax\nmovl $9,value\nmovl value,%ebx\nmovl $10,value\nmovl %ebx,%eax');
 for(let i=0;i<5;i++)step();
 const record=t.items[0].records.at(-1);assert.equal(record.step,5);
 assert.equal(record.copyBefore.find(c=>c.register==='EAX').value,'0x0000002a');
 assert.equal(record.copyAfter.find(c=>c.register==='EAX').value,'0x00000009');
});
test('remapping memory clears spilled provenance even when replacement bytes equal the old value',()=>{
 const {m,t,step,copies}=setup('movq value,%rbx\nmovq %rbx,other\nmovq $0x600000,%rdi\nmovq $4096,%rsi\nmovq $3,%rdx\nmovq $0x32,%rcx\nxorq %r8,%r8\nxorq %r9,%r9\ncall mmap\nmovq other,%r10',[mem('value',8)],'value: .quad 0\nother: .quad 0');
 while(m.status==='ready')step();
 assert.ok(!copies().some(c=>c.register==='R10'));assert.ok(copies().some(c=>c.register==='RBX'));
 assert.ok(t.items[0].copies.every(c=>c.at.kind==='reg'));
});
