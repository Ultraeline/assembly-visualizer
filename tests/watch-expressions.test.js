const {test}=require('node:test'),assert=require('node:assert/strict');
const E=require('../engine'),W=require('../watch'),{RunController}=require('../execution');
const memory=(name,size=8)=>({name,kind:'memory',expression:name,size,format:'signed'});
function setup(code,defs=[memory('x'),memory('y')],data='x: .quad 3\ny: .quad 5\nspill: .quad 0'){
 const m=new E.Machine(E.compile('.data\n'+data+'\n.text\nmain:\n'+code+'\nhlt')),t=new W.Tracker(m,defs);
 const step=()=>{m.step();t.capture();assert.notEqual(m.status,'fault',m.error);};
 const view=(name,id)=>t.registerCopies(id).find(c=>c.register===name&&c.calculated);
 return {m,t,step,view,run:()=>{for(let n=0;m.status==='ready'&&n<200;n++)step();}};
}
const loads='movq x,%rax\nmovq y,%rbx\n';
test('AT&T ADD renders destination plus source in both participating watches and once on the register',()=>{
 const {m,t,run,view}=setup(loads+'addq %rax,%rbx');run();
 assert.equal(m.regs.rbx,8n);assert.equal(view('RBX').label,'y + x');assert.equal(view('RBX').value,'0x0000000000000008');
 assert.equal(t.registerCopies().filter(c=>c.register==='RBX').length,1);
 for(const item of t.items){assert.equal(view('RBX',item.def.id).label,'y + x');assert.equal(item.records.at(-1).step,3);}
 assert.match(view('RBX').inputs,/y = 0x0000000000000005/);assert.match(view('RBX').inputs,/x = 0x0000000000000003/);
});
test('nested subtraction and multiplication preserve operand order and parentheses',()=>{
 const {run,view}=setup(loads+'addq %rax,%rbx\nimulq $2,%rbx,%rcx\nsubq %rbx,%rax');run();
 assert.equal(view('RCX').label,'(y + x) × 2');assert.equal(view('RCX').value,'0x0000000000000010');
 assert.equal(view('RAX').label,'x − (y + x)');assert.equal(view('RAX').value,'0xfffffffffffffffb');
});
test('register-bound variables use their pre-operation identities, not their new values',()=>{
 const defs=[{name:'x',kind:'register',expression:'rax',format:'signed'},{name:'y',kind:'register',expression:'rbx',format:'signed'}];
 const {run,view,t}=setup('movq $3,%rax\nmovq $5,%rbx\naddq %rax,%rbx\nincq %rbx',defs);run();
 assert.equal(view('RBX').label,'y + x + 1');assert.equal(view('RBX').value,'0x0000000000000009');
 assert.equal(t.items[1].current.display,'9');assert.match(view('RBX').inputs,/y = 0x0000000000000005/);
});
test('MOV, spill/reload, PUSH/POP and XCHG carry the whole expression',()=>{
 const {run,view}=setup(loads+'addq %rax,%rbx\nmovq %rbx,spill\nmovq spill,%rcx\npushq %rcx\npopq %rdx\nxchgq %rdx,%rdi');run();
 for(const name of ['RBX','RCX','RDI'])assert.equal(view(name).label,'y + x');assert.equal(view('RDX'),undefined);
});
test('arithmetic writing watched memory keeps its expression on a later load',()=>{
 const {run,view,t}=setup('movq x,%rax\naddq %rax,y\nmovq y,%rbx');run();
 assert.equal(t.items[1].current.display,'8');assert.equal(view('RBX').label,'y + x');
});
test('32-bit wraparound, zero extension on a wider read, and subsequent 64-bit arithmetic stay explicit',()=>{
 const {run,view}=setup('movl x,%eax\nmovl y,%ebx\naddl %eax,%ebx\naddq $1,%rbx',[memory('x',4),memory('y',4)],'x: .long 1\ny: .long -1');run();
 assert.equal(view('RBX').label,'零扩展64(y + x) + 1');assert.equal(view('RBX').value,'0x0000000000000001');
});
test('extended and sliced operands retain their real bit semantics',()=>{
 const {run,view}=setup('movsbl x,%eax\nmovzbl y,%ebx\naddl %eax,%ebx\nmovb %bl,%cl',[memory('x',1),memory('y',1)],'x: .byte 255\ny: .byte 2');run();
 assert.equal(view('EBX').label,'零扩展32(y) + 符号扩展32(x)');
 assert.equal(view('CL').label,'低8位(零扩展32(y) + 符号扩展32(x))');assert.equal(view('CL').value,'0x01');
});
test('partial watched buffer operands retain byte slice names',()=>{
 const {run,view}=setup('movl x+4,%eax\naddl $2,%eax',[{...memory('x',8),name:'buf',format:'bytes'}]);run();
 assert.equal(view('EAX').label,'buf[4:8] + 2');
});
test('immediates and untracked operands use captured constants without inventing variables',()=>{
 const {run,view}=setup('movq x,%rax\nmovq $9,%rbx\nsubq %rax,%rbx\naddq $-1,%rbx',[memory('x')]);run();
 assert.equal(view('RBX').label,'9 − x + (-1)');assert.equal(view('RBX').value,'0x0000000000000005');
});
test('bit operations, negation, increment and decrement retain expressions',()=>{
 const {run,view}=setup('movq x,%rax\nincq %rax\ndecq %rax\nnegq %rax\nnotq %rax\nandq $15,%rax\norq $16,%rax\nxorq $1,%rax',[memory('x')]);run();
 assert.match(view('RAX').label,/x \+ 1 − 1/);assert.match(view('RAX').label,/& 15/);assert.equal(view('RAX').value,'0x0000000000000013');
});
test('later source updates preserve the original inputs and the computed value',()=>{
 const {run,view}=setup(loads+'addq %rax,%rbx\nmovq $99,x');run();
 assert.equal(view('RBX').label,'y + x');assert.equal(view('RBX').value,'0x0000000000000008');assert.equal(view('RBX').stale,true);
 assert.match(view('RBX').inputs,/x = 0x0000000000000003/);
});
test('overwrites, partial writes, zero idioms and unsupported operations clear affected expressions',()=>{
 for(const op of ['movq $8,%rbx','movb $8,%bl','xorq %rbx,%rbx','subq %rbx,%rbx','shlq $1,%rbx']){
  const {run,view}=setup(loads+'addq %rax,%rbx\n'+op);run();assert.equal(view('RBX'),undefined,op);
 }
});
test('rename updates all formula labels; remove/rebind purge dependent formulas including undo state',()=>{
 const {m,t,step,view}=setup(loads+'addq %rax,%rbx\nmovq %rbx,%rcx');for(let i=0;i<4;i++)step();
 const x=t.items[0];t.update(x.def.id,{...x.def,name:'输入'});assert.equal(view('RCX').label,'y + 输入');
 t.update(x.def.id,{...x.def,expression:'spill'});assert.equal(view('RCX'),undefined);m.back();t.rewind();assert.equal(view('RBX'),undefined);
 const other=setup(loads+'addq %rax,%rbx');other.run();other.t.remove(other.t.items[0].def.id);assert.equal(other.view('RBX'),undefined);
});
test('undo and fast run preserve expressions, their before/after values, and fault atomicity',()=>{
 const {m,t,step,view}=setup(loads+'addq %rax,%rbx\nsubq $1,%rbx\nmovq %rbx,0x1');
 const runner=new RunController(m,new Set([m.program.instructions[3].address.toString()]),()=>t.capture());let reason;do{reason=runner.advance();}while(!reason);
 assert.equal(reason,'breakpoint');assert.equal(view('RBX').label,'y + x');step();assert.equal(view('RBX').label,'y + x − 1');
 m.back();t.rewind();assert.equal(view('RBX').label,'y + x');step();m.step();t.capture();assert.equal(m.status,'fault');assert.deepEqual(m.lastEvent.calculations,[]);
 assert.equal(view('RBX').label,'y + x − 1');m.back();t.rewind();assert.equal(view('RBX').value,'0x0000000000000007');
});
test('long expression chains are bounded and retain real values and dependencies',()=>{
 const {m,t,run,view}=setup('movq x,%rax\n'+Array(80).fill('addq %rax,%rax').join('\n'),[memory('x')]);run();
 const c=t.items[0].copies.find(c=>c.at.name==='rax');assert.ok(c.formula.count<=63);assert.ok(c.formula.depth<=10);
 assert.match(view('RAX').label,/阶段值@/);assert.equal(view('RAX').value,E.hex(m.regs.rax,16));assert.ok(view('RAX').label.length<2000);
});
const pointerData='x: .quad target\ny: .quad 5\ntarget: .quad 42\n.quad 99\nspill: .quad 0';
test('a load through a watched pointer displays dereference and captures address, value and width',()=>{
 const {run,view,t}=setup('movq x,%rax\nmovq (%rax),%rbx',[memory('x')],pointerData);run();
 assert.equal(view('RBX').label,'*x');assert.equal(view('RBX').value,'0x000000000000002a');
 assert.match(view('RBX').inputs,/\[0x600010\] = 0x000000000000002a（64 位读取）/);
 assert.equal(t.items[0].records.at(-1).step,2);
});
test('pointer offsets, scaled indices and computed addresses retain the effective address expression',()=>{
 const {run,view}=setup('movq x,%rax\nmovq $1,%rcx\nmovq 8(%rax),%rbx\nmovq (%rax,%rcx,8),%rdx\naddq $8,%rax\nmovq (%rax),%rdi',[memory('x')],pointerData);run();
 assert.equal(view('RBX').label,'*(x + 8)');assert.equal(view('RDX').label,'*(x + 1 × 8)');assert.equal(view('RDI').label,'*(x + 8)');
 for(const name of ['RBX','RDX','RDI'])assert.equal(view(name).value,'0x0000000000000063');
});
test('dereferenced values participate in arithmetic whether loaded first or used as a memory operand',()=>{
 const {run,view}=setup('movq x,%rax\nmovq y,%rbx\naddq (%rax),%rbx\nmovq (%rax),%rcx\naddq %rcx,%rbx',[memory('x'),memory('y')],pointerData);run();
 assert.equal(view('RBX').label,'y + *x + *x');assert.equal(view('RBX').value,'0x0000000000000059');assert.equal(view('RCX').label,'*x');
});
test('overwriting the address register uses its old pointer and nested dereference stays distinguishable',()=>{
 const {run,view}=setup('movq x,%rax\nmovq (%rax),%rax\nmovq (%rax),%rbx',[memory('x')],'x: .quad pointer\npointer: .quad target\ntarget: .quad 42');run();
 assert.equal(view('RAX').label,'*x');assert.equal(view('RBX').label,'*(*x)');assert.equal(view('RBX').value,'0x000000000000002a');
});
test('sign-extending pointer loads carry dereference and their actual source width',()=>{
 const {run,view}=setup('movq x,%rax\nmovsbl (%rax),%ebx',[memory('x')],'x: .quad target\ntarget: .byte 255');run();
 assert.equal(view('EBX').label,'符号扩展32(*x)');assert.equal(view('EBX').value,'0xffffffff');assert.match(view('EBX').inputs,/8 位读取/);
});
test('storing through a pointer is not a dereference result; LEA and untracked pointers do not invent one',()=>{
 const {run,view}=setup('movq x,%rax\nmovq $8,(%rax)\nleaq 8(%rax),%rbx',[memory('x')],pointerData);run();
 assert.equal(view('RBX'),undefined);
 const unknown=setup('leaq target,%rax\nmovq (%rax),%rbx',[memory('y')],pointerData);unknown.run();assert.equal(unknown.view('RBX'),undefined);
});
test('a fresh indirect load replaces previous pointee derivations, while existing register snapshots keep old values',()=>{
 const {run,view}=setup('movq x,%rax\nmovq (%rax),%rbx\naddq $1,(%rax)\nmovq (%rax),%rcx',[memory('x')],pointerData);run();
 assert.equal(view('RBX').label,'*x');assert.equal(view('RBX').value,'0x000000000000002a');
 assert.equal(view('RCX').label,'*x');assert.equal(view('RCX').value,'0x000000000000002b');
});
test('faulting dereferences never claim a result and rewind restores pointer expression state',()=>{
 const {m,t,step,view}=setup('movq x,%rax\nmovq (%rax),%rbx\nmovq $1,%rax\nmovq (%rax),%rbx',[memory('x')],pointerData);
 step();step();step();m.step();t.capture();assert.equal(m.status,'fault');assert.equal(view('RBX').label,'*x');
 assert.equal(view('RBX').value,'0x000000000000002a');m.back();t.rewind();m.back();t.rewind();m.back();t.rewind();assert.equal(view('RBX'),undefined);
});
test('dereference preserves associated tracked index variables',()=>{
 const {run,view,t}=setup('movq x,%rax\nmovq y,%rcx\nmovq (%rax,%rcx,8),%rbx',[memory('x'),memory('y')],pointerData.replace('y: .quad 5','y: .quad 1'));run();
 assert.equal(view('RBX').label,'*(x + y × 8)');
 assert.ok(t.items.every(i=>view('RBX',i.def.id)));assert.equal(view('RBX').value,'0x0000000000000063');
});
