'use strict';
(() => {
  const C = globalThis.BlindPairsCore;
  const $ = id => document.getElementById(id);
  const KEY = 'blind-pairs.records.v1', DRAFT = 'blind-pairs.draft.v1';
  const names = {left:'左边更好',right:'右边更好',tie:'差不多',neither:'都不太行'};
  const fields = ['question','text-one','source-one','text-two','source-two'];
  let records = [], activeId = null, lastSaved = null, lockedStorage = false, storageWorks = true;
  let chosenDraft = {choice:'',reason:''}, noticeTimer;
  function message(text) { $('notice').textContent=text; $('notice').hidden=false; clearTimeout(noticeTimer); noticeTimer=setTimeout(()=>$('notice').hidden=true,8000); }
  function warning(text) { $('storage-warning').textContent=text; $('storage-warning').hidden=false; }
  function run(action) { try { action(); } catch(e) { message(e.message || '操作未完成，请检查输入。'); } }
  function save(next) {
    const json = C.exportCollection(next);
    if (lockedStorage) throw new Error('存档在其他窗口中更新，或原存档无法读取。请先导出当前记录，刷新后再操作。');
    if (storageWorks) {
      let stored;
      try { stored = localStorage.getItem(KEY); } catch (_) { storageWorks=false; warning('浏览器无法读取存档，本次改动不能自动保存。请导出 JSON 备份，关闭或刷新会丢失未保存内容。'); }
      if (storageWorks && stored !== lastSaved) { lockedStorage=true; warning('另一个窗口更新了记录。为避免覆盖，请先导出当前记录，然后刷新页面。'); throw new Error('已停止写入，原存档未被覆盖。'); }
      if (storageWorks) {
        try { localStorage.setItem(KEY,json); lastSaved=json; }
        catch (_) { storageWorks=false; warning('浏览器无法保存记录。本次内容仍在当前页面，请立即导出 JSON 备份，关闭或刷新会丢失未保存内容。'); }
      }
    }
    records = C.validateCollection(next);
    $('count').textContent=String(records.length);
  }
  function changeView(view) {
    ['compose','compare','history'].forEach(x=>$(x).hidden=x!==view);
    $('new-nav').classList.toggle('active',view==='compose');
    $('history-nav').classList.toggle('active',view==='history');
    window.scrollTo({top:0,behavior:'auto'});
  }
  function confirmAction(title,body,callback) {
    const d=$('confirm-dialog'); $('confirm-title').textContent=title; $('confirm-text').textContent=body;
    d.returnValue=''; d.addEventListener('close',()=>{if(d.returnValue==='ok') run(callback);},{once:true}); d.showModal();
  }
  function compose() { changeView('compose'); $('question').focus({preventScroll:true}); }
  function saveDraft() {
    const draft=Object.fromEntries(fields.map(id=>[id,$(id).value]));
    try { localStorage.setItem(DRAFT,JSON.stringify(draft)); $('draft-state').textContent='输入已暂存；还没有开始对照。'; }
    catch (_) { $('draft-state').textContent='当前浏览器不能暂存输入，请不要关闭页面。'; }
  }
  function loadDraft() {
    try {
      const d=JSON.parse(localStorage.getItem(DRAFT)||'null');
      if(d && typeof d==='object') fields.forEach(id=>{if(typeof d[id]==='string') $(id).value=d[id].slice(0,$(id).maxLength);});
    } catch (_) { /* A broken draft does not replace the validated record collection. */ }
  }
  function clearDraft() { fields.forEach(id=>$(id).value=''); try {localStorage.removeItem(DRAFT);}catch(_){} $('draft-state').textContent='未开始的输入会尽量保存在当前浏览器。'; }
  function openRecord(id,resetChoice=true) {
    const record=records.find(r=>r.id===id); if(!record) throw new Error('这条记录不存在。');
    activeId=id;
    if(resetChoice) chosenDraft={choice:'',reason:''};
    const done=record.status==='revealed', pair=done?C.reveal(record):C.visiblePair(record);
    $('pair-question').textContent=pair.question;
    $('left-text').textContent=pair.left.text; $('right-text').textContent=pair.right.text;
    $('left-source').hidden=!done; $('right-source').hidden=!done;
    $('left-source').textContent=done?(pair.left.source||'未填写来源'):'';
    $('right-source').textContent=done?(pair.right.source||'未填写来源'):'';
    $('stage').textContent=done?'03 / 已揭晓':'02 / 来源已隐藏';
    $('compare-heading').textContent=done?'原来是这一版。':'这一版，还是那一版？';
    $('decision-form').hidden=done; $('result-note').hidden=!done; $('revealed-banner').hidden=!done;
    if(done) {
      $('revealed-banner').textContent='你的选择：'+names[pair.choice]+'。来源已揭晓，本次选择已锁定。';
      $('saved-reason').textContent=pair.reason||'这次没有填写理由。';
    } else {
      document.querySelectorAll('input[name="choice"]').forEach(e=>e.checked=e.value===chosenDraft.choice);
      $('reason').value=chosenDraft.reason;
    }
    changeView('compare');
    $('compare-heading').setAttribute('tabindex','-1'); $('compare-heading').focus({preventScroll:true});
  }
  function dateText(date) { return new Date(date).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}); }
  function history() {
    const list=$('history-list'); list.replaceChildren();
    const finished=records.filter(r=>r.status==='revealed').length;
    $('history-summary').textContent=`${records.length} 组对照 · ${finished} 组已揭晓 · ${records.length-finished} 组进行中`;
    $('empty').hidden=records.length>0;
    $('export-json').disabled=records.length===0; $('export-md').disabled=records.length===0;
    for(const record of [...records].reverse()) {
      const row=document.createElement('article'); row.className='history-row';
      const content=document.createElement('div'), title=document.createElement('h2'), meta=document.createElement('p');
      title.textContent=record.question.length>100?record.question.slice(0,100)+'…':record.question;
      const badge=document.createElement('span'); badge.className='status'; badge.textContent=record.status==='revealed'?'已揭晓':'进行中';
      meta.append(badge,document.createTextNode(dateText(record.createdAt)+(record.decision?' · '+names[record.decision.choice]:'')));
      content.append(title,meta);
      const actions=document.createElement('div'); actions.className='row-actions';
      const open=document.createElement('button'); open.type='button'; open.className='secondary'; open.textContent=record.status==='revealed'?'查看':'继续比较'; open.addEventListener('click',()=>run(()=>openRecord(record.id)));
      const remove=document.createElement('button'); remove.type='button'; remove.className='danger'; remove.textContent='删除'; remove.setAttribute('aria-label','删除对照：'+record.question.slice(0,50));
      remove.addEventListener('click',()=>confirmAction('删除这条对照？','这条对照会从当前浏览器移除。已有导出文件不受影响。',()=>{save(records.filter(r=>r.id!==record.id));history();message('已删除这条对照。');}));
      actions.append(open,remove); row.append(content,actions); list.append(row);
    }
    changeView('history');
  }
  function download(text,extension) {
    const blob=new Blob([text],{type:extension==='json'?'application/json;charset=utf-8':'text/markdown;charset=utf-8'});
    const url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url; a.download='blind-pairs-'+new Date().toISOString().replace(/[:.]/g,'-')+'.'+extension;
    a.click(); setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  function init() {
    if(!C) throw new Error('核心文件未加载，请保留整个 dist 文件夹后重新打开。');
    try {
      lastSaved=localStorage.getItem(KEY);
      if(lastSaved) { try {records=C.importCollection(lastSaved);}catch(_){
        lockedStorage=true;warning('原存档无法读取，已停止自动写入以保留原始内容。请先导出原始存档，再从“我的记录”清空本工具数据后重新开始。');
        const backup=document.createElement('button'); backup.type='button'; backup.className='secondary'; backup.textContent='导出原始存档';
        backup.addEventListener('click',()=>download(lastSaved,'json')); $('storage-warning').append(document.createElement('br'),backup);
      } }
    } catch(_) {storageWorks=false;warning('当前浏览器不允许本地保存。本次可以使用，请在离开前导出 JSON 备份。');}
    $('count').textContent=String(records.length); loadDraft();
    fields.forEach(id=>$(id).addEventListener('input',saveDraft));
    ['new-nav','another','history-new','empty-new'].forEach(id=>$(id).addEventListener('click',compose));
    $('history-nav').addEventListener('click',history);
    $('sample').addEventListener('click',()=>{
      const fill=()=>{ $('question').value='演示：怎样解释“连续抛硬币，三枚组合先出现者获胜”的玩法？'; $('text-one').value='每人先选一个不同的三枚硬币组合，比如正反正和正正反。不断抛同一枚硬币，把每次结果接在后面。每抛一次，就看最后三次是谁的组合，先出现的那个人赢。'; $('source-one').value='演示写法一（自写）'; $('text-two').value='把结果看成一条一直变长的队列。双方各选一个长度为三的目标，每加进一次抛币结果，就检查最新的长度三窗口。只要窗口等于某人的目标，就结束这一局。窗口可以重叠。'; $('source-two').value='演示写法二（自写）'; saveDraft(); message('已填入自写演示材料，没有生成任何比较结果。'); };
      if(fields.some(id=>$(id).value.trim())) confirmAction('替换当前输入？','用演示材料替换尚未开始的输入。已有对照记录保留。',fill); else fill();
    });
    $('pair-form').addEventListener('submit',e=>{e.preventDefault();run(()=>{
      const record=C.createRecord({question:$('question').value,left:{text:$('text-one').value,source:$('source-one').value},right:{text:$('text-two').value,source:$('source-two').value}});
      save([...records,record]); clearDraft(); openRecord(record.id); message('左右顺序已随机，来源暂时隐藏。进行中的对照已加入“我的记录”。');
    });});
    document.querySelectorAll('input[name="choice"]').forEach(e=>e.addEventListener('change',()=>chosenDraft.choice=e.value));
    $('reason').addEventListener('input',()=>chosenDraft.reason=$('reason').value);
    $('decision-form').addEventListener('submit',e=>{e.preventDefault();run(()=>{
      const record=records.find(r=>r.id===activeId), choice=document.querySelector('input[name="choice"]:checked');
      if(!choice) throw new Error('请先选择左边、右边、差不多或都不太行。');
      const finished=C.finish(record,choice.value,$('reason').value); save(records.map(r=>r.id===activeId?finished:r));openRecord(activeId);
    });});
    $('reuse').addEventListener('click',()=>run(()=>{
      const r=records.find(r=>r.id===activeId); if(!r) return;
      const fill=()=>{ $('question').value=r.question;$('text-one').value=r.candidates[0].text;$('source-one').value=r.candidates[0].source;$('text-two').value=r.candidates[1].text;$('source-two').value=r.candidates[1].source;saveDraft();compose();message('已复制原内容。上一次的选择保持不变。');};
      if(fields.some(id=>$(id).value.trim())) confirmAction('替换未开始的输入？','把当前记录复制到新建页面，替换尚未开始的输入。',fill); else fill();
    }));
    $('export-json').addEventListener('click',()=>run(()=>download(C.exportCollection(records),'json')));
    $('export-md').addEventListener('click',()=>run(()=>download(C.toMarkdown(records),'md')));
    $('export-one').addEventListener('click',()=>run(()=>download(C.toMarkdown(records.filter(r=>r.id===activeId)),'md')));
    $('import').addEventListener('click',()=>$('import-file').click());
    $('import-file').addEventListener('change',async e=>{
      const file=e.target.files[0]; if(!file) return;
      try {
        if(file.size>16000000) throw new Error('备份超过 16 MB，请拆分后再导入。');
        const incoming=C.importCollection(await file.text()), merged=[...records]; let added=0;
        for(const r of incoming) { const old=merged.find(x=>x.id===r.id); if(old) { if(JSON.stringify(C.validateRecord(old))!==JSON.stringify(C.validateRecord(r))) throw new Error('备份与现有记录有同编号冲突，未导入。请在另一个独立页面保存后核对。'); } else {merged.push(r);added++;} }
        save(merged); history(); message(`导入完成：新增 ${added} 组，已有相同记录跳过。`);
      } catch(err) {message('导入未完成：'+err.message);} finally {e.target.value='';}
    });
    $('clear').addEventListener('click',()=>confirmAction('清空本工具的本机数据？','将删除当前浏览器内的所有对照和未开始输入。请先导出备份。其他网页的数据不会删除。',()=>{
      try {localStorage.removeItem(KEY);localStorage.removeItem(DRAFT);}catch(_){throw new Error('浏览器拒绝清空，操作未完成。');}
      records=[];lastSaved=null;lockedStorage=false;storageWorks=true;activeId=null;clearDraft();$('storage-warning').hidden=true;$('count').textContent='0';history();message('已清空本工具数据。');
    }));
    window.addEventListener('storage',e=>{if(e.key===KEY && e.newValue!==lastSaved){lockedStorage=true;warning('另一个窗口更新了记录。为避免覆盖，请先导出当前记录，然后刷新页面。');}});
  }
  try {init();}catch(e){warning(e.message||'初始化未完成，请重新打开整个项目。');}
})();
