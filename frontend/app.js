; (function ready(fn){
  if (document.readyState !== 'loading') fn();
  else document.addEventListener('DOMContentLoaded', fn);
})(function(){

  /***** ELEMENT REFS *****/
  const table      = document.getElementById('timelineTable');
  const smartBox   = document.getElementById('smartContainer');
  const prevBtn    = document.getElementById('prevBtn');
  const nextBtn    = document.getElementById('nextBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const addBtn     = document.getElementById('addBtn');
  const acctBar    = document.getElementById('acctBar');
  const tabTime    = document.getElementById('tabTimeline');
  const tabSmart   = document.getElementById('tabSmart');
  const customizeBtn = document.getElementById('customizeBucketsBtn');

  const bucketModalEl          = document.getElementById('bucketModal');
  const bucketOptionsContainer = document.getElementById('bucketOptionsContainer');
  const saveBucketsBtn         = document.getElementById('saveBucketsBtn');

  const viewer   = document.getElementById('viewer');
  const closeBtn = document.getElementById('closeBtn');
  const vSubj    = document.getElementById('vSubject');
  const vMeta    = document.getElementById('vMeta');
  const vBody    = document.getElementById('vBody');

  /***** STATE *****/
  let pageTokens  = [null];
  let current     = 0;
  let cachedPages = {};
  let firstSmart  = true;
  let view        = 'timeline';

  const acctColor = new Map();
  const viewed    = new Set(JSON.parse(localStorage.getItem('viewedIds')||'[]'));
  function markViewed(id){
    if(viewed.has(id)) return;
    viewed.add(id);
    localStorage.setItem('viewedIds', JSON.stringify([...viewed]));
  }

  /***** BUCKET RULES & SELECTION *****/
  const bucketOptions = [
    { name:'Promotions', color:'#c62828', test:e=>/%|sale|deal|discount|offer/i.test(e.subject) },
    { name:'Finance',    color:'#00695c', test:e=>/invoice|receipt|payment|bank|paypal/i.test(e.subject+e.from) },
    { name:'Social',     color:'#1565c0', test:e=>/facebook|twitter|instagram|linkedin/i.test(e.from) },
    { name:'Dining',     color:'#8e24aa', test:e=>/restaurant|pizza|cafe|grill|food/i.test(e.subject+e.from) },
    { name:'Updates',    color:'#ef6c00', test:e=>/update|digest|alert/i.test(e.subject) },
    // …add more here…
  ];
  let selectedBuckets = JSON.parse(localStorage.getItem('selectedBuckets')||'null');
  if(!Array.isArray(selectedBuckets)){
    selectedBuckets = bucketOptions.slice(0,4).map(b=>b.name);
  }

  /***** ACCOUNT BAR *****/
  async function loadAccounts(){
    const res = await fetch('/api/accounts');
    if(!res.ok) return;
    const emails = await res.json();
    emails.forEach((e,i)=>acctColor.set(e,i%10));
    acctBar.innerHTML = emails.map(e=>
      `<span class="acct-chip" data-email="${e}">
         <span class="acc-dot acc${acctColor.get(e)}"></span>${e}
         <button>&times;</button>
       </span>`
    ).join('');
  }
  acctBar.addEventListener('click', e=>{
    if(e.target.tagName!=='BUTTON') return;
    const email = e.target.closest('.acct-chip').dataset.email;
    fetch('/api/accounts/'+encodeURIComponent(email),{ method:'DELETE' })
      .then(()=>location.reload());
  });
  addBtn.onclick = ()=> window.open('/auth/google?popup=1','_blank','popup,width=520,height=650');

  /***** INITIALIZE *****/
  loadAccounts();
  loadPage(0);
  customizeBtn.onclick = showBucketModal;

  /***** FETCH & PAGINATION *****/
  async function loadPage(idx){
    const res = await fetch(`/api/emails?page=${idx}`);
    if(res.status===401){ window.location='/auth/google'; return; }
    if(!res.ok){ alert('Server error'); return; }

    const { messages, nextPageToken } = await res.json();
    cachedPages[idx] = messages;

    renderTimeline(messages);
    if(view==='smart') renderSmart();

    if(pageTokens.length===idx+1) pageTokens.push(nextPageToken);
    current = idx; updateNav();
  }

  /***** TIMELINE RENDER (with unread-dots) *****/
  /***** TIMELINE VIEW *****/
function renderTimeline(list) {
  table.innerHTML = `
    <thead>
      <tr>
        <th>From</th>
        <th>Subject</th>
        <th style="text-align:right">Date</th>
      </tr>
    </thead>
    <tbody>
      ${list.map(m => {
        const cIdx = acctColor.get(m.acct) ?? 0;
        // colored account dot
        const accDot   = `<span class="acc-dot acc${cIdx}"></span>`;
        // unread-dot if we haven't marked it viewed yet
        const unreadDot = viewed.has(m.id) ? '' : '<span class="dot"></span>';
        return `
          <tr data-id="${m.id}">
            <td>${accDot}${m.from}</td>
            <td>${m.subject}${unreadDot}</td>
            <td style="text-align:right">${new Date(m.date).toLocaleString()}</td>
          </tr>
        `;
      }).join('')}
    </tbody>
  `;
}


/***** SMART INBOX VIEW *****/
function renderSmart() {
  const msgs = cachedPages[current]||[];
  const buckets = {};

  // only initialize the buckets the user has selected
  bucketOptions.forEach(b => {
    if (selectedBuckets.includes(b.name)) {
      buckets[b.name] = { color: b.color, items: [] };
    }
  });

  // split messages into those buckets
  msgs.forEach(m => {
    for (const b of bucketOptions) {
      if (!selectedBuckets.includes(b.name)) continue;
      if (b.test(m)) {
        buckets[b.name].items.push(m);
        break;
      }
    }
  });

  // build each bucket’s HTML
  smartBox.innerHTML = Object.entries(buckets).map(([name, b]) => {
    const unreadCount = b.items.filter(i => !viewed.has(i.id)).length;
    const bucketDot   = (unreadCount > 0 && !firstSmart)
      ? `<span class="dot bucket-dot" data-name="${name}"></span>` : '';
    const header = `
      <div class="bucket-header" style="background:${b.color}">
        <span>${name}</span>
        <span><span class="badge">${b.items.length}</span>${bucketDot}</span>
      </div>
    `;
    const body = `
      <div class="bucket-body">
        ${ b.items.map(it => {
          const cIdx = acctColor.get(it.acct) ?? 0;
          const accDot    = `<span class="acc-dot acc${cIdx}"></span>`;
          const unreadDot = viewed.has(it.id) ? '' : '<span class="dot"></span>';
          return `
            <div class="item" data-id="${it.id}">
              <span class="item-from">${accDot}${it.from}</span>
              <span class="item-subject">${it.subject}${unreadDot}</span>
              <span class="item-date">${new Date(it.date).toLocaleDateString()}</span>
            </div>
          `;
        }).join('') }
      </div>
    `;
    return `<div class="bucket" data-name="${name}">${header}${body}</div>`;
  }).join('');

  firstSmart = false;
}


  /***** BUCKET CLICK HANDLING *****/
  smartBox.addEventListener('click', e=>{
    if(e.target.classList.contains('bucket-dot')){
      const n = e.target.dataset.name;
      cachedPages[current]
        .filter(m=>bucketOptions.find(b=>b.name===n && b.test(m)))
        .forEach(m=>markViewed(m.id));
      renderSmart();
      return;
    }
    const hdr = e.target.closest('.bucket-header');
    if(hdr){
      hdr.parentElement.classList.toggle('open');
      return;
    }
    const it = e.target.closest('[data-id]');
    if(it) openMsg(it.dataset.id);
  });

  /***** MESSAGE VIEWER *****/
  function openMsg(id){
    fetch(`/api/emails/${id}`)
      .then(r=>r.ok?r.json():Promise.reject())
      .then(m=>{
        markViewed(m.id);
        view==='smart'?renderSmart():renderTimeline(cachedPages[current]);
        vSubj.textContent = m.subject;
        vMeta.textContent  = `${m.from} — ${new Date(m.date).toLocaleString()}`;
        vBody.innerHTML   = '';
        if(m.isHtml){
          const iframe = document.createElement('iframe');
          iframe.style.border='none';
          iframe.style.width='100%';
          iframe.srcdoc = DOMPurify.sanitize(m.body,{ADD_ATTR:['target']});
          vBody.appendChild(iframe);
        } else {
          vBody.textContent = m.body;
        }
        viewer.style.display = 'flex';
      })
      .catch(()=>alert('Failed to load message'));
  }
  table.addEventListener('click', e=>{
    const row = e.target.closest('[data-id]');
    if(row) openMsg(row.dataset.id);
  });
  viewer.addEventListener('click', e=>{
    if(e.target===viewer) viewer.style.display='none';
  });
  closeBtn.onclick = ()=> viewer.style.display='none';

  /***** NAVIGATION *****/
  function updateNav(){
    prevBtn.disabled = current===0;
    nextBtn.disabled = !pageTokens[current+1];
  }
  prevBtn.onclick    = ()=> current>0 && loadPage(current-1);
  nextBtn.onclick    = ()=> pageTokens[current+1] && loadPage(current+1);
  refreshBtn.onclick = ()=>{
    pageTokens=[null];
    cachedPages={};
    loadPage(0);
    loadAccounts();
  };

  /***** VIEW SWITCHING *****/
  function setView(v){
    view=v;
    tabTime .classList.toggle('active', v==='timeline');
    tabSmart.classList.toggle('active', v==='smart');
    customizeBtn.style.display = v==='smart' ? 'inline-block' : 'none';
    table.style.display   = v==='timeline' ? '' : 'none';
    smartBox.style.display= v==='smart'    ? '' : 'none';
    if(v==='smart') renderSmart();
  }
  tabTime.onclick  = ()=> setView('timeline');
  tabSmart.onclick = ()=> setView('smart');

  /***** CUSTOMIZE BUCKETS MODAL *****/
  const bucketModal = new bootstrap.Modal(bucketModalEl);
  function showBucketModal(){
    bucketOptionsContainer.innerHTML = '';
    bucketOptions.forEach(opt=>{
      const id = `bucket-${opt.name}`;
      const chk = selectedBuckets.includes(opt.name) ? 'checked':'' ;
      bucketOptionsContainer.insertAdjacentHTML('beforeend',`
        <div class="col-6">
          <div class="form-check">
            <input class="form-check-input" type="checkbox"
                   id="${id}" value="${opt.name}" ${chk}>
            <label class="form-check-label" for="${id}">
              ${opt.name}
            </label>
          </div>
        </div>`);
    });
    updateModalState();
    bucketOptionsContainer.querySelectorAll('input').forEach(cb=>{
      cb.onchange = updateModalState;
    });
    saveBucketsBtn.onclick = ()=>{
      selectedBuckets = Array.from(
        bucketOptionsContainer.querySelectorAll('input:checked')
      ).map(i=>i.value);
      localStorage.setItem('selectedBuckets', JSON.stringify(selectedBuckets));
      bucketModal.hide();
      renderSmart();
    };
    bucketModal.show();
  }
  function updateModalState(){
    const c = bucketOptionsContainer.querySelectorAll('input:checked').length;
    bucketOptionsContainer.querySelectorAll('input:not(:checked)')
      .forEach(cb=>cb.disabled = (c>=8));
    saveBucketsBtn.disabled = (c===0);
  }

}); // end ready()
