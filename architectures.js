(function(root){
  'use strict';
  const adapters=new Map();
  const registry={
    register(adapter){if(!adapter.id||adapters.has(adapter.id)||!adapter.engine?.compile||!adapter.engine?.Machine)throw new Error('Invalid or duplicate architecture adapter');adapters.set(adapter.id,Object.freeze(adapter));},
    list(){return [...adapters.values()];},
    get(id){const adapter=adapters.get(id);if(!adapter)throw new Error('Unsupported architecture: '+id);return adapter;}
  };
  registry.register({id:'x86-64-att',label:'x86-64 · AT&T',engine:root.StackLensEngine,wordBytes:8,endianness:'little',stackDirection:'down',stackPointer:'rsp',framePointer:'rbp',registerOrder:['rax','rbx','rcx','rdx','rsi','rdi','rsp','rbp','r8','r9','r10','r11','r12','r13','r14','r15']});
  root.StackLensArchitectures=registry;
})(globalThis);
