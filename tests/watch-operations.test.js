const {test}=require('node:test'),assert=require('node:assert/strict');
const E=require('../engine'),W=require('../watch'),{RunController}=require('../execution');
const mem=(name,size=8,format='signed')=>({name,kind:'memory',expression:name,size,format});
const loads='movq x,%rax\nmovq y,%rbx\n';
function setup(code,defs=[mem('x'),mem('y')],data='x: .quad 3\ny: .quad 5'){
 const m=new E.Machine(E.compile('.data\n'+data+'\n.text\nmain:\n'+code+'\nhlt')),t=new W.Tracker(m,defs);
 const step=()=>{m.step();t.capture();assert.notEqual(m.status,'fault',m.error);};
 const action=name=>t.latestOperation(t.items.find(i=>i.def.name===name).def.id);
 const run=()=>{while(m.status==='ready')step();};
 return {m,t,step,action,run};
}
test('ADD is explained under the destination variable only, with actual before/after values',()=>{
 const {t,action,run}=setup(loads+'addq %rax,%rbx');run();
 assert.equal(action('x'),null);assert.deepEqual(action('y'),{step:3,summary:'RBX 中加了 x',target:'RBX',bits:64,before:'5',after:'8',beforeExpression:'y',afterExpression:'y + x'});
 assert.equal(t.items[0].records.at(-1).operations.length,0);
 assert.equal(t.items[1].records.at(-1).operations.length,1);assert.equal(t.items[1].current.display,'5');
});
test('ownership stays with y through subsequent arithmetic, copying and exchange',()=>{
 const {action,run}=setup(loads+'addq %rax,%rbx\nmovq %rbx,%rcx\nxchgq %rcx,%rdx\naddq %rax,%rdx');run();
 assert.equal(action('x'),null);assert.equal(action('y').summary,'RDX 中加了 x');
 assert.equal(action('y').before,'8');assert.equal(action('y').after,'11');assert.equal(action('y').afterExpression,'y + x + x');
});
test('register bindings and aliases route the operation to the watched destination',()=>{
 const defs=[{name:'x',kind:'register',expression:'eax',format:'signed'},{name:'y',kind:'register',expression:'ebx',format:'signed'}];
 const {action,run}=setup('movl $3,%eax\nmovl $5,%ebx\naddl %eax,%ebx',defs);run();
 assert.equal(action('x'),null);assert.equal(action('y').summary,'EBX 中加了 x');assert.equal(action('y').bits,32);assert.equal(action('y').after,'8');
});
test('subtraction, unary operations and same-value additions remain explicit',()=>{
 const {action,step}=setup(loads+'subq %rax,%rbx\naddq $0,%rbx\nnegq %rbx');step();step();step();
 assert.equal(action('y').summary,'RBX 中减去了 x');assert.equal(action('y').after,'2');
 step();assert.equal(action('y').summary,'RBX 中加了 0');assert.equal(action('y').before,action('y').after);
 step();assert.equal(action('y').summary,'RBX 中的值取负');assert.equal(action('y').after,'-2');
});
test('source-only dependencies and three-operand output do not claim an in-place change',()=>{
 const a=setup('movq x,%rax\nmovq $5,%rbx\naddq %rax,%rbx',[mem('x')]);a.run();assert.equal(a.action('x'),null);
 const b=setup(loads+'imulq $2,%rbx,%rcx');b.run();assert.equal(b.action('y'),null);
});
test('dereferenced sources are described as *x in y without modifying x',()=>{
 const {action,run}=setup(loads+'addq (%rax),%rbx',[mem('x'),mem('y')],'x: .quad target\ny: .quad 5\ntarget: .quad 42');run();
 assert.equal(action('x'),null);assert.equal(action('y').summary,'RBX 中加了 *x');assert.equal(action('y').after,'47');
});
test('bit-width wraparound and selected number formats match actual register values',()=>{
 const {action,run}=setup('movl x,%eax\nmovl y,%ebx\naddl %eax,%ebx',[mem('x',4,'hex'),mem('y',4,'hex')],'x: .long 1\ny: .long -1');run();
 assert.equal(action('y').before,'0xffffffff');assert.equal(action('y').after,'0x00000000');
});
test('fast run retains operation summaries, undo removes future actions and faults add none',()=>{
 const {m,t,action,step}=setup(loads+'addq %rax,%rbx\nsubq $1,%rbx\nmovq %rbx,0x1');
 const runner=new RunController(m,new Set([m.program.instructions[3].address.toString()]),()=>t.capture());let reason;do{reason=runner.advance();}while(!reason);
 assert.equal(reason,'breakpoint');assert.equal(action('y').step,3);step();assert.equal(action('y').after,'7');
 m.back();t.rewind();assert.equal(action('y').after,'8');step();m.step();t.capture();assert.equal(m.status,'fault');assert.equal(action('y').step,4);
 m.back();t.rewind();m.back();t.rewind();m.back();t.rewind();assert.equal(action('y'),null);
});
test('rename updates summaries and rebinding clears dependent summaries including undo states',()=>{
 const {m,t,action,run}=setup(loads+'addq %rax,%rbx');run();const x=t.items[0];
 t.update(x.def.id,{...x.def,name:'输入'});assert.equal(action('y').summary,'RBX 中加了 输入');
 t.update(x.def.id,{...x.def,expression:'y'});assert.equal(action('y'),null);m.back();t.rewind();assert.equal(action('y'),null);
});
test('folding long expressions retains the original destination owner',()=>{
 const {action,run}=setup(loads+Array(20).fill('addq %rax,%rbx').join('\n'));run();
 assert.equal(action('x'),null);assert.equal(action('y').summary,'RBX 中加了 x');assert.equal(action('y').after,'65');
});
