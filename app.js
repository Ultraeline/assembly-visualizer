(function(){
  'use strict';
  const architecture=StackLensArchitectures.get('x86-64-att'),E=architecture.engine,examples=StackLensExamples,$=id=>document.getElementById(id);
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const W=StackLensWatch;
  const defaultConfig={codeBase:'0x400000',dataBase:'0x600000',stackTop:'0x7fffffffe000',stackSize:16384,entry:'',harness:true,seed:'1',registers:{},regions:[],runtime:'auto',pid:1337,env:[],files:{},watches:[]};
  let config={...defaultConfig},machine=null,program=null,activeExample='call',timer=null,running=false,dirty=false,selectedRegister='rax',memoryAnchor=0n,breakpoints=new Set(),view='execution';
  const registerOrder=architecture.registerOrder;
  let drafts={},runner=null,instructionSignature='',tracker=null,selectedWatch='',editingWatch='';
  function notice(message,kind=''){const el=$('notice');el.textContent=message;el.className='notice '+kind;el.hidden=!message;}
  function currentConfig(){return {...config,input:$('input-data').value,inputMode:$('input-mode').value};}
  function saveDraft(){
    try{const project={version:1,source:$('source-editor').value,config:currentConfig(),example:activeExample,breakpoints:[...breakpoints]};localStorage.setItem('stacklens.draft.v1',JSON.stringify(project));$('draft-warning').hidden=true;}catch{$('draft-warning').hidden=false;}
  }
  function updateInputCount(){const text=$('input-data').value;const n=$('input-mode').value==='hex'?Math.floor(text.replace(/\s/g,'').length/2):new TextEncoder().encode(text).length;$('input-count').textContent=n+' 字节';}
  function markDirty(){stop(false);dirty=true;notice('代码或输入已修改。点击「载入程序」从新的初始状态开始。');updateInputCount();updateControls();saveDraft();}
  function changeView(next){view=next;for(const key of ['execution','editor']){$(key+'-pane').hidden=key!==next;$('tab-'+key).classList.toggle('active',key===next);$('tab-'+key).setAttribute('aria-selected',String(key===next));}if(next==='execution')highlightCode();}
  function load(options={}){
    stop(false);
    try {
      const next=E.compile($('source-editor').value,config),nextMachine=new E.Machine(next,currentConfig());
      const nextTracker=new W.Tracker(nextMachine,config.watches);
      program=next;machine=nextMachine;tracker=nextTracker;config.watches=tracker.definitions();runner=new StackLensExecution.RunController(machine,breakpoints,()=>tracker.capture());instructionSignature='';dirty=false;memoryAnchor=machine.regs.rsp;selectedRegister='rax';
      buildInstructions();changeView('execution');notice(machine.elf?'已核对 ELF 与反汇编的机器码字节，载入常量、全局数据与库函数连接。转入新的内存地址时，将尝试解码已支持的整数指令。':program.warnings.join(' '),program.warnings.length&&!machine.elf?'warn':'');render();saveDraft();return true;
    }catch(e){dirty=true;notice(e.message,'error');updateControls();changeView('editor');return false;}
  }
  function chooseExample(id){
    const sample=examples.find(x=>x.id===id);if(!sample)return;
    if(activeExample)drafts[activeExample]={source:$('source-editor').value,input:$('input-data').value,inputMode:$('input-mode').value,watches:config.watches};
    activeExample=id;const saved=drafts[id];$('source-editor').value=saved?.source||sample.code;$('input-data').value=saved?.input??sample.input;$('input-mode').value=saved?.inputMode||'text';
    config={...defaultConfig,registers:{},regions:[],watches:saved?.watches||[]};breakpoints.clear();$('follow-stack').checked=true;updateTitle();updateInputCount();load();
  }
  function updateTitle(){const sample=examples.find(x=>x.id===activeExample);$('program-title').textContent=sample?.title||'我的汇编实验';$('program-description').textContent=sample?.description||'编辑汇编或导入反汇编，设置初始状态，观察每一次变化。';document.querySelectorAll('.example-button').forEach(b=>b.classList.toggle('active',b.dataset.id===activeExample));}
  function updateControls(){
    $('status').className='status '+(dirty?'dirty':running?'running':machine?.status||'ready');
    $('status').textContent=dirty?'待载入':running?'运行中':machine?.status==='fault'?'已停止':machine?.status==='halted'?'已结束':'就绪';
    $('step-count').textContent=String(machine?.steps||0).padStart(3,'0');$('step-button').disabled=dirty||!machine||machine.status!=='ready'||running;
    $('back-button').disabled=dirty||!machine?.history.length||running;$('run-button').disabled=!running&&(dirty||!machine||machine.status!=='ready');
    $('run-button').innerHTML=running?'<svg><use href="#i-pause"/></svg><span>暂停</span>':'<svg><use href="#i-play"/></svg><span>'+(runner?.warningAcknowledged?'继续运行':'运行')+'</span>';
    $('load-button').textContent=dirty?'载入修改':'载入程序';
    for(const button of document.querySelectorAll('[data-watch-edit],[data-watch-remove],#add-watch'))button.disabled=running||dirty||!machine;
  }
  function buildInstructions(){
    $('source-kind').textContent=program.mode==='disassembly'?'反汇编文本':'AT&T 源代码';$('instruction-total').textContent=program.instructions.length+' instructions';
    const dynamic=machine.dynamicInstructions(),overrides=new Map(dynamic.map(i=>[i.address,i]));
    const labels=new Map();for(const [name,address]of Object.entries(program.symbols))if(!E.externals.includes(name)){if(!labels.has(address))labels.set(address,[]);labels.get(address).push(name);}
    const extra=dynamic.filter(i=>!program.map.has(i.address));
    $('instruction-list').innerHTML=[...extra,...program.instructions.map(i=>overrides.get(i.address)||i)].map((i,index)=>{
      const args=i.text.slice(i.mnemonic.length).trim();const bytes=i.bytes.map(v=>v.toString(16).padStart(2,'0')).join(' ');
      return (i.dynamic&&index===0?'<div class="label-row">内存中的指令 · 按当前字节解码</div>':'')+(labels.has(i.address)?`<div class="label-row">${esc(labels.get(i.address).join(' / '))}:</div>`:'')+`<div class="instruction-row" data-address="${i.address}" title="${i.dynamic?'内存解码':'第 '+i.line+' 行'} · ${esc(bytes)}"><button class="breakpoint" aria-label="在 ${E.hex(i.address)} 设置断点" aria-pressed="false" data-breakpoint="${i.address}"></button><span class="address">${E.hex(i.address).slice(2)}</span><span class="assembly"><span class="mnemonic">${esc(i.mnemonic)}</span>${esc(args)}</span><span class="byte-length">${i.length} B</span></div>`;
    }).join('');
  }
  function highlightCode(){
    if(!machine||!program)return;
    const signature=machine.dynamicInstructions().map(i=>i.address+':'+i.bytes.join(',')).join(';');
    if(signature!==instructionSignature){const scroll=$('instruction-list').scrollTop;buildInstructions();instructionSignature=signature;$('instruction-list').scrollTop=scroll;}
    const rows=$('instruction-list').querySelectorAll('.instruction-row');let current=null;
    rows.forEach(row=>{const address=BigInt(row.dataset.address),isCurrent=machine.status==='ready'&&address===machine.rip;row.classList.toggle('current',isCurrent);row.classList.toggle('executed',address===machine.lastEvent?.address);const button=row.querySelector('button');const set=breakpoints.has(row.dataset.address);button.textContent=set?'●':'';button.setAttribute('aria-pressed',String(set));if(isCurrent)current=row;});
    if(current&&view==='execution'){const parent=$('instruction-list'),r=current.getBoundingClientRect(),p=parent.getBoundingClientRect();if(r.top<p.top+12)parent.scrollTop-=p.top-r.top+40;else if(r.bottom>p.bottom-12)parent.scrollTop+=r.bottom-p.bottom+40;}
  }
  function registerDetails(){
    if(!machine)return;const aliases=Object.entries(E.regs).filter(([,v])=>v.name===selectedRegister&&v.bits<64);
    $('register-detail-title').textContent=selectedRegister.toUpperCase()+' 的部分寄存器';
    $('register-detail').innerHTML=aliases.map(([name,r])=>`<span>${name.toUpperCase()} <b>${E.hex(machine.readReg(name,false),r.bits/4)}</b></span>`).join('');
  }
  function renderRegisters(){
    const writes=new Set((machine.lastEvent?.writes||[]).filter(w=>w.kind==='reg').map(w=>w.fullName));
    $('register-grid').innerHTML=registerOrder.map(name=>`<button class="register ${writes.has(name)?'changed':''} ${name===selectedRegister?'selected':''} ${['rsp','rbp'].includes(name)?'pointer':''}" data-register="${name}" aria-label="查看 ${name.toUpperCase()} 的部分寄存器"><span class="register-name">${name.toUpperCase()}</span><span class="register-value">${E.hex(machine.regs[name],16).slice(2)}</span></button>`).join('');
    $('flags').innerHTML=Object.entries(machine.flags).map(([name,value])=>`<span class="flag ${value?'on':''}">${name} <b>${value===null?'—':value?1:0}</b></span>`).join('');
    $('rip-value').textContent=E.hex(machine.rip,16);registerDetails();
  }
  function renderExplanation(){
    const ev=machine.lastEvent;if(!ev){$('last-op').textContent='READY';$('explanation').innerHTML='<div class="empty-explanation"><span class="empty-arrow">↳</span><div><strong>让代码动起来</strong><p>点击「单步」，观察本次读取、写入与栈顶变化。</p></div></div>';return;}
    $('last-op').textContent=ev.instruction.split(' ')[0].toUpperCase();let html=`<p class="step-summary">${esc(ev.summary)}</p>`;
    const seenReads=new Set(),reads=ev.reads.filter(r=>{const k=[r.kind,r.name,r.address,r.bits].join(':');if(seenReads.has(k))return false;seenReads.add(k);return true;});
    for(const r of reads.slice(0,5))html+=`<div class="flow-item"><span class="flow-label">读取</span><b>${r.kind==='reg'?r.name.toUpperCase():E.hex(r.address)}</b><span class="flow-arrow">→</span><span>${E.hex(r.value)} · ${r.bits} bit</span></div>`;
    for(const w of ev.writes.slice(0,8))html+=`<div class="flow-item"><span class="flow-label">写入</span><b>${w.kind==='reg'?w.name.toUpperCase():E.hex(w.address)}</b><span>${w.kind==='reg'?E.hex(w.before):w.before.map(x=>x.toString(16).padStart(2,'0')).join(' ')}</span><span class="flow-arrow">→</span><b>${w.kind==='reg'?E.hex(w.after):w.after.map(x=>x.toString(16).padStart(2,'0')).join(' ')}</b></div>`;
    if(ev.rspBefore!==undefined&&ev.rspBefore!==ev.rspAfter){const delta=ev.rspAfter-ev.rspBefore;html+=`<div class="flow-item"><span class="flow-label">栈顶</span><b>RSP ${delta>0n?'+':''}${delta}</b><span>字节 · ${delta<0n?'向低地址移动':'向高地址移动'}</span></div>`;}
    if(ev.mapping)html+=`<p class="step-summary">${esc(ev.mapping)}</p>`;
    if(ev.writes.length>8)html+=`<p class="step-summary">本步共 ${ev.writes.length} 次写入，列出前 8 次；内存视图可查看结果。</p>`;
    html+=ev.warnings.slice(0,10).map(w=>`<div class="step-warning">${esc(w.message)}</div>`).join('');$('explanation').innerHTML=html;
  }
  function renderMemory(){
    if(!machine)return;
    if($('follow-stack').checked)memoryAnchor=machine.regs.rsp;
    const center=memoryAnchor&~7n,top=center+32n,changed=new Set(),alerts=new Set();
    for(const w of machine.lastEvent?.writes||[])if(w.kind==='mem')for(let i=0;i<w.bits/8;i++)changed.add((w.address+BigInt(i)).toString());
    const events=[...machine.history.map(h=>h.snapshot.lastEvent),machine.lastEvent];
    for(const ev of events)for(const w of ev?.warnings||[])if(w.address!==undefined)for(let i=0;i<(w.size||1);i++)alerts.add((w.address+BigInt(i)).toString());
    let html='';
    for(let row=0;row<13;row++){
      const addr=top-BigInt(row*8);if(addr<0n)continue;
      const isRsp=machine.regs.rsp>=addr&&machine.regs.rsp<addr+8n,isRbp=machine.regs.rbp>=addr&&machine.regs.rbp<addr+8n,bytes=machine.peek(addr,8);
      let meaning='',sub='',value=0n;
      for(let i=7;i>=0;i--)value=(value<<8n)|BigInt(bytes[i]||0);
      const frameReturn=machine.frames.find(f=>f.returnSlot!==null&&f.returnSlot>=addr&&f.returnSlot<addr+8n),frameBase=machine.frames.find(f=>f.base!==null&&f.base>=addr&&f.base<addr+8n);
      const buffer=machine.buffers.find(b=>b.active&&addr<b.end&&addr+8n>b.start);
      const owner=[...machine.frames].reverse().find(f=>{const index=machine.frames.indexOf(f),lower=index===machine.frames.length-1?machine.regs.rsp:machine.frames[index+1].stackEntry+8n;return addr>=lower&&addr<f.stackEntry;});
      if(frameReturn){meaning='返回地址 · '+frameReturn.name;sub=frameReturn.returnAddress===machine.sentinel?'教学入口':E.hex(value);}
      else if(frameBase){meaning='保存的 RBP（推断）';sub=E.hex(value);}
      else if(buffer){meaning=buffer.name+' · '+Number(buffer.end-buffer.start)+' B';sub=bytes.map(v=>v>=32&&v<=126?String.fromCharCode(v):'·').join('');}
      else if(bytes.every(x=>x!==null)){sub=E.hex(value);if(owner)meaning=owner.name+' · 栈帧';}
      const initial=machine.runtime.initialStack;
      if(initial&&addr===initial.argv-8n)meaning='进程入口 · argc';
      else if(initial&&addr>=initial.argv&&addr<initial.argv+initial.argc*8n)meaning='进程入口 · argv['+((addr-initial.argv)/8n)+']';
      const cells=bytes.map((v,i)=>{const a=addr+BigInt(i),key=a.toString();let cls='memory-byte';
        if(v===null)cls+=' unmapped';
        if(machine.buffers.some(b=>b.active&&a>=b.start&&a<b.end))cls+=' buffer-byte';
        if(machine.frames.some(f=>f.returnSlot!==null&&a>=f.returnSlot&&a<f.returnSlot+8n))cls+=' return-byte';
        if(machine.frames.some(f=>f.base!==null&&a>=f.base&&a<f.base+8n))cls+=' saved-byte';
        if(changed.has(key))cls+=' changed';if(alerts.has(key))cls+=' alert-byte';
        return `<span class="${cls}" title="${E.hex(a)}${v===null?' · 未映射':' · '+v}">${v===null?'—':v.toString(16).padStart(2,'0')}</span>`;
      }).join('');
      const ptr=(isRsp?'<span class="pointer-label">RSP'+(machine.regs.rsp===addr?'':'+'+(machine.regs.rsp-addr))+'</span>':'')+(isRbp?'<span class="pointer-label rbp">RBP'+(machine.regs.rbp===addr?'':'+'+(machine.regs.rbp-addr))+'</span>':'');
      html+=`<tr class="${isRsp?'at-rsp':''} ${isRbp?'at-rbp':''} ${owner?'frame-owned':''}"><td class="memory-address">${addr.toString(16)}${ptr}</td><td><div class="memory-bytes">${cells}</div></td><td class="memory-meaning" title="${esc(meaning+' '+sub)}">${meaning?`<span class="memory-label">${esc(meaning)}</span>`:''}${esc(sub)}</td></tr>`;
    }
    $('memory-body').innerHTML=html;if(document.activeElement!==$('memory-address'))$('memory-address').value=E.hex(memoryAnchor);
    $('frames').innerHTML=machine.frames.length?machine.frames.map((f,i)=>`<button class="frame ${i===machine.frames.length-1?'active':''}" data-frame="${f.stackEntry}" title="查看 ${esc(f.name)} 的入口栈地址"><small>${String(i).padStart(2,'0')}</small>${esc(f.name)}</button>`).join(''):'<span class="frames-empty">已返回所有跟踪的调用</span>';
  }
  function render(){if(!machine){updateControls();return;}highlightCode();renderRegisters();renderExplanation();renderMemory();renderWatches();$('console-output').textContent=machine.output||'等待 puts / printf / putchar 输出…';
    $('runtime-status').textContent=(machine.processMode?'Linux 进程教学环境':'函数教学环境')+(config.image?' · '+config.image.name:' · 未装载 ELF')+(machine.runtime.exitCode!==null?' · 退出码 '+machine.runtime.exitCode:'');
    $('remove-elf').hidden=!config.image;$('memory-regions').textContent=machine.regions.filter(r=>r.name!=='代码').map(r=>`${r.name}  ${E.hex(r.start)} — ${E.hex(r.end-1n)}  ${r.writable?'可写':'只读'}`).join('\n');updateControls();}
  function step(){if(running||dirty||!machine||machine.status!=='ready')return;notice('');machine.step();tracker.capture();render();checkStop();}
  function checkStop(){if(machine.status==='fault'){stop(false);notice(machine.error+' 可以回退查看上一步。','error');return true;}if(machine.status==='halted'){stop(false);notice('程序已结束。'+(machine.runtime.exitCode!==null?'退出码 '+machine.runtime.exitCode+'。':'')+'可以回退重看，也可以重置后再次运行。');return true;}return false;}
  function stop(show=true){if(timer)clearTimeout(timer);timer=null;const wasRunning=running;running=false;if(wasRunning)render();else updateControls();if(show&&wasRunning)notice('已暂停，可以单步或回退。');}
  function start(){
    if(running){stop();return;}if(!machine||dirty||machine.status!=='ready')return;runner.begin();running=true;notice('');updateControls();
    function tick(){
      if(!running)return;
      const until=performance.now()+12;
      for(let i=0;i<1000;i++){
        const reason=runner.advance();
        if(reason==='breakpoint'){stop(false);notice('到达断点 '+E.hex(machine.rip)+'，该指令尚未执行。');return;}
        if(checkStop())return;
        if(reason==='warning'){stop(false);notice('检测到越界或控制数据覆盖，已暂停。点击「继续运行」将保留告警并运行到断点、结束或异常；本次执行不再因覆盖告警反复暂停。可用「单步」观察，回退或重置后重新启用告警暂停。','warn');return;}
        if(performance.now()>=until)break;
      }
      // Yield to input so Pause remains responsive; refresh the views only at a stop.
      timer=setTimeout(tick,0);
    }tick();
  }
  function openSettings(){stop();const form=$('settings-form');for(const key of ['codeBase','dataBase','stackTop','stackSize','entry','seed','runtime','pid'])form.elements[key].value=config[key]??defaultConfig[key];form.elements.harness.checked=config.harness!==false;for(const key of ['registers','regions','env','files'])form.elements[key].value=JSON.stringify(config[key]||defaultConfig[key],null,2);form.elements.argv.value=JSON.stringify(config.argv||[config.image?.name||'program']);$('settings-error').textContent='';$('settings-dialog').showModal();}
  function renderWatches(){
    if(!tracker)return;
    $('watch-count').textContent=tracker.items.length+' / '+W.MAX_WATCHES;
    $('watch-empty').hidden=tracker.items.length>0;
    if(!tracker.items.some(x=>x.def.id===selectedWatch))selectedWatch=tracker.items[0]?.def.id||'';
    $('watch-list').innerHTML=tracker.items.map(item=>{
      const d=item.def,c=item.current,last=item.records.at(-1),changed=last?.step===machine.steps;
      return `<article class="watch-card ${changed?'changed':''} ${d.id===selectedWatch?'selected':''}"><div class="watch-heading"><button class="watch-name" data-watch-select="${d.id}" aria-pressed="${d.id===selectedWatch}">${esc(d.name)}</button><div><button class="button mini" data-watch-edit="${d.id}" aria-label="编辑变量 ${esc(d.name)}">编辑</button><button class="button mini" data-watch-remove="${d.id}" aria-label="移除变量 ${esc(d.name)}">移除</button></div></div><div class="watch-value ${c.available?'':'unavailable'}" title="${esc(c.error||'小端字节：'+c.raw)}">${esc(c.display)}</div><div class="watch-meta"><code>${esc(d.kind==='register'?c.location:d.expression+' → '+c.location)}</code><span>${d.kind==='memory'?(d.mode==='fixed'?'固定地址 · ':'跟随表达式 · '):''}${d.size} B · ${esc(W.formats[d.format])}</span>${c.error?`<span class="error-text">${esc(c.error)}</span>`:''}<span>${last?'最近变化：第 '+last.step+' 步':'从第 '+item.startStep+' 步开始观察'}${changed?' · 本步变化':''}</span></div></article>`;
    }).join('');
    const item=tracker.items.find(x=>x.def.id===selectedWatch);
    $('watch-history').hidden=!item;
    if(!item)return;
    $('watch-history-title').textContent=item.def.name+' · 变化记录';
    $('watch-history-count').textContent='保留最近 '+W.LIMIT+' 次 · 当前 '+item.records.length+' 次';
    $('watch-history-body').innerHTML=item.records.length?[...item.records].reverse().map(r=>`<div class="watch-record"><div><b>第 ${r.step} 步</b><code>${esc(r.address)} · ${esc(r.instruction)}</code></div><div class="watch-delta"><span title="${esc(r.before.location+' · '+(r.before.error||r.before.raw))}">${esc(r.before.display)}</span><span aria-label="变为">→</span><strong title="${esc(r.after.location+' · '+(r.after.error||r.after.raw))}">${esc(r.after.display)}</strong></div>${r.before.location!==r.after.location?`<div class="watch-address-change">地址 ${esc(r.before.location)} → ${esc(r.after.location)}</div>`:''}</div>`).join(''):'<p class="watch-hint">还没有变化。单步或运行后，在这里查看指令与前后值。</p>';
  }
  function watchFields(){
    const f=$('watch-form'),memory=f.elements.kind.value==='memory';
    $('watch-size-label').hidden=!memory;$('watch-mode-label').hidden=!memory;
    for(const option of f.elements.format.options)option.disabled=!memory&&['bytes','text'].includes(option.value);
    if(!memory&&['bytes','text'].includes(f.elements.format.value))f.elements.format.value='signed';
    f.elements.expression.placeholder=memory?'-8(%rbp)、0x600000 或标签':'rax、eax、al…';
    $('watch-location-hint').textContent=memory?'跟随表达式会随 RBP / RSP 改变位置。固定地址适合观察当前栈帧，需先运行到地址有效处；修改位置或地址方式会重新绑定。':'自动使用寄存器自身宽度：RAX 8 字节，EAX 4 字节，AL 1 字节。';
  }
  function openWatch(id=''){
    if(running||dirty||!machine)return;
    editingWatch=id;const d=tracker.items.find(x=>x.def.id===id)?.def,f=$('watch-form');f.reset();
    $('watch-dialog-title').textContent=d?'编辑变量':'添加变量';
    for(const key of ['name','kind','expression','format','size','mode'])if(d?.[key]!==undefined)f.elements[key].value=d[key];
    $('watch-error').textContent='';watchFields();$('watch-dialog').showModal();
  }
  function saveWatches(){config.watches=tracker.definitions();renderWatches();updateControls();saveDraft();}
  $('add-watch').addEventListener('click',()=>openWatch());
  $('watch-cancel').addEventListener('click',()=>$('watch-dialog').close());
  $('watch-form').elements.kind.addEventListener('change',watchFields);
  $('watch-form').addEventListener('submit',e=>{
    e.preventDefault();const f=e.currentTarget;
    try{
      const value={};for(const key of ['name','kind','expression','format','size','mode'])value[key]=f.elements[key].value;
      const old=tracker.items.find(x=>x.def.id===editingWatch)?.def;
      if(old?.mode==='fixed'&&value.mode==='fixed'&&old.expression===value.expression.trim()&&old.kind===value.kind)value.address=old.address;
      const item=editingWatch?tracker.update(editingWatch,value):tracker.add(value);selectedWatch=item.def.id;saveWatches();$('watch-dialog').close();
    }catch(err){$('watch-error').textContent=err.message;}
  });
  $('watch-list').addEventListener('click',e=>{
    const select=e.target.closest('[data-watch-select]'),edit=e.target.closest('[data-watch-edit]'),remove=e.target.closest('[data-watch-remove]');
    if(select){selectedWatch=select.dataset.watchSelect;renderWatches();updateControls();}
    if(edit)openWatch(edit.dataset.watchEdit);
    if(remove&&!running&&!dirty){tracker.remove(remove.dataset.watchRemove);saveWatches();}
  });
  function validateProject(value){if(!value||value.version!==1||typeof value.source!=='string'||value.source.length>1000000)throw new Error('不是有效的“可视化汇编运行”v1 实验文件');if(value.config&&typeof value.config!=='object')throw new Error('实验设置格式错误');}
  $('examples').innerHTML=examples.map(e=>`<button class="example-button" data-id="${e.id}"><small>${e.tag}</small><strong>${e.title}</strong></button>`).join('');
  $('examples').addEventListener('click',e=>{const b=e.target.closest('[data-id]');if(b)chooseExample(b.dataset.id);});
  $('load-button').addEventListener('click',()=>load());$('reset-button').addEventListener('click',()=>load());$('step-button').addEventListener('click',step);$('run-button').addEventListener('click',start);
  $('back-button').addEventListener('click',()=>{stop(false);if(machine?.back()){runner.resetWarnings();tracker.rewind();notice('');render();}});
  $('tab-editor').addEventListener('click',()=>{stop(false);changeView('editor');});$('tab-execution').addEventListener('click',()=>changeView('execution'));
  $('source-editor').addEventListener('input',markDirty);$('input-data').addEventListener('input',markDirty);$('input-mode').addEventListener('change',markDirty);
  $('source-editor').addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();const t=e.target,start=t.selectionStart,end=t.selectionEnd;t.setRangeText('    ',start,end,'end');markDirty();}});
  $('instruction-list').addEventListener('click',e=>{const b=e.target.closest('[data-breakpoint]');if(!b)return;const key=b.dataset.breakpoint;if(breakpoints.has(key))breakpoints.delete(key);else breakpoints.add(key);const set=breakpoints.has(key);b.textContent=set?'●':'';b.setAttribute('aria-pressed',String(set));saveDraft();});
  $('register-grid').addEventListener('click',e=>{const b=e.target.closest('[data-register]');if(b){selectedRegister=b.dataset.register;renderRegisters();}});
  $('frames').addEventListener('click',e=>{const b=e.target.closest('[data-frame]');if(b){$('follow-stack').checked=false;memoryAnchor=BigInt(b.dataset.frame);renderMemory();}});
  $('follow-stack').addEventListener('change',renderMemory);
  function memoryGo(){try{const a=E.expression($('memory-address').value,program?.symbols||{});if(a<0n||a>(1n<<64n)-1n)throw new Error('内存地址须为 64 位无符号数');$('follow-stack').checked=false;memoryAnchor=a;renderMemory();}catch(e){notice(e.message,'error');}}
  $('memory-go').addEventListener('click',memoryGo);$('memory-address').addEventListener('keydown',e=>{if(e.key==='Enter')memoryGo();});
  $('memory-up').addEventListener('click',()=>{$('follow-stack').checked=false;memoryAnchor+=64n;renderMemory();});$('memory-down').addEventListener('click',()=>{$('follow-stack').checked=false;memoryAnchor=memoryAnchor>=64n?memoryAnchor-64n:0n;renderMemory();});
  $('settings-button').addEventListener('click',openSettings);$('settings-cancel').addEventListener('click',()=>$('settings-dialog').close());
  $('settings-form').addEventListener('submit',e=>{
    e.preventDefault();const f=e.currentTarget;
    try{const next={...config};for(const k of ['codeBase','dataBase','stackTop','entry','seed','runtime'])next[k]=f.elements[k].value.trim();next.stackSize=Number(f.elements.stackSize.value);next.pid=Number(f.elements.pid.value);next.harness=f.elements.harness.checked;for(const k of ['registers','regions','argv','env','files'])next[k]=JSON.parse(f.elements[k].value);
      if(!next.registers||Array.isArray(next.registers)||typeof next.registers!=='object'||!Array.isArray(next.regions))throw new Error('寄存器需为 JSON 对象，内存区域需为 JSON 数组');
      const preview=E.compile($('source-editor').value,next);new E.Machine(preview,{...next,input:$('input-data').value,inputMode:$('input-mode').value});config=next;$('settings-dialog').close();load();
    }catch(err){$('settings-error').textContent=err.message;}
  });
  for(const id of ['help-button','about-button'])$(id).addEventListener('click',()=>{stop(false);$('help-dialog').showModal();});$('help-close').addEventListener('click',()=>$('help-dialog').close());
  $('export-button').addEventListener('click',()=>{const project={version:1,source:$('source-editor').value,config:currentConfig(),example:activeExample,breakpoints:[...breakpoints]};const url=URL.createObjectURL(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='可视化汇编运行-实验.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notice('已导出实验文件：包括代码、输入、初始状态、断点和变量绑定（不含变化记录）。重新导入后从起点运行。');});
  $('import-button').addEventListener('click',()=>$('file-input').click());
  $('file-input').addEventListener('change',async e=>{
    const file=e.target.files[0];if(!file)return;stop(false);
    try{if(file.size>8000000)throw new Error('实验文件不能超过 8 MB');const text=await file.text();
      if(file.name.toLowerCase().endsWith('.json')){const data=JSON.parse(text);validateProject(data);config={...defaultConfig,...data.config};$('source-editor').value=data.source;$('input-data').value=data.config?.input||'';$('input-mode').value=data.config?.inputMode||'text';breakpoints=new Set((data.breakpoints||[]).map(String));activeExample=examples.some(x=>x.id===data.example)?data.example:null;}
      else{if(text.length>1000000)throw new Error('汇编文本不能超过 1 MB');$('source-editor').value=text;activeExample=null;breakpoints.clear();}
      updateTitle();updateInputCount();load();
    }catch(err){notice('导入失败：'+err.message,'error');}e.target.value='';
  });
  $('load-elf').addEventListener('click',()=>$('elf-input').click());
  $('elf-input').addEventListener('change',async e=>{
    const file=e.target.files[0];if(!file)return;stop(false);const previous=config;
    try{if(file.size>4194304)throw new Error('ELF 文件不能超过 4 MiB');const image=StackLensRuntime.image(new Uint8Array(await file.arrayBuffer()),file.name);const next={...config,image,runtime:'auto',entry:''};new E.Machine(E.compile($('source-editor').value,next),{...next,input:$('input-data').value,inputMode:$('input-mode').value});config=next;load();}
    catch(err){config=previous;notice('ELF 装载失败：'+err.message,'error');}e.target.value='';
  });
  $('remove-elf').addEventListener('click',()=>{config={...config};delete config.image;markDirty();$('remove-elf').hidden=true;$('runtime-status').textContent='ELF 已移除，请重新载入';});
  document.addEventListener('keydown',e=>{
    if(document.querySelector('dialog[open]'))return;
    if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();load();return;}
    if(['TEXTAREA','INPUT','SELECT'].includes(e.target.tagName))return;
    if(e.key==='F10'){e.preventDefault();step();}else if(e.key==='F8'){e.preventDefault();$('back-button').click();}else if(e.key==='F9'){e.preventDefault();start();}
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop(false);});
  let saved=null;try{saved=JSON.parse(localStorage.getItem('stacklens.draft.v1'));validateProject(saved);}catch{saved=null;}
  if(saved){config={...defaultConfig,...saved.config};activeExample=saved.example;$('source-editor').value=saved.source;$('input-data').value=saved.config?.input||'';$('input-mode').value=saved.config?.inputMode||'text';breakpoints=new Set(saved.breakpoints||[]);}
  else{$('source-editor').value=examples[0].code;$('input-data').value=examples[0].input;}
  updateTitle();updateInputCount();load();
  if(location.protocol==='file:')$('offline-state').textContent='本地文件模式 · 无需联网';
  else if('serviceWorker'in navigator&&/^https?:$/.test(location.protocol))navigator.serviceWorker.register('./sw.js').then(()=>navigator.serviceWorker.ready).then(()=>{$('offline-state').textContent='离线缓存已就绪';}).catch(()=>{$('offline-state').textContent='缓存未启用 · 可使用本地文件包';});
})();
