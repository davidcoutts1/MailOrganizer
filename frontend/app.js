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
const viewer     = document.getElementById('viewer');
const closeBtn   = document.getElementById('closeBtn');
const vSubj      = document.getElementById('vSubject');
const vMeta      = document.getElementById('vMeta');
const vBody      = document.getElementById('vBody');

/***** STATE *****/
let pageTokens =[null];
let current     = 0;
let cachedPages = {};
let bucketMeta  = {};
let firstSmart  = true;
let view        = 'timeline';

/* map email → colour-index (0-9) */
const acctColor = new Map();

/* unread IDs persisted across sessions */
const viewed = new Set(JSON.parse(localStorage.getItem('viewedIds')||'[]'));
function markViewed(id){
  if(viewed.has(id)) return;
  viewed.add(id);
  localStorage.setItem('viewedIds',JSON.stringify([...viewed]));
}

/***** BUCKET RULES *****/
const rules = [
  {name:'Promotions',color:'#c62828',test:e=>/%|sale|deal|discount|offer/i.test(e.subject)},
  {name:'Finance',   color:'#00695c',test:e=>/invoice|receipt|payment|bank|paypal/i.test(e.subject+e.from)},
  {name:'Social',    color:'#1565c0',test:e=>/facebook|twitter|instagram|linkedin/i.test(e.from)},
  {name:'Dining',    color:'#8e24aa',test:e=>/restaurant|pizza|cafe|grill|food/i.test(e.subject+e.from)},
  {name:'Updates',   color:'#ef6c00',test:e=>/update|digest|alert/i.test(e.subject)},
];

/*──────────────────  ACCOUNT BAR  ──────────────────*/
async function loadAccounts(){
  const r = await fetch('/api/accounts');
  if(!r.ok) return;
  const emails = await r.json();

  emails.forEach((e,i)=>acctColor.set(e,i%10));          // assign colour idx

  acctBar.innerHTML = emails.map(e=>`
    <span class="acct-chip" data-email="${e}">
      <span class="acc-dot acc${acctColor.get(e)}"></span>${e}
      <button>&times;</button>
    </span>`).join('');
}
acctBar.addEventListener('click',e=>{
  if(e.target.tagName!=='BUTTON') return;
  const email=e.target.closest('.acct-chip').dataset.email;
  fetch('/api/accounts/'+encodeURIComponent(email),{method:'DELETE'})
    .then(()=>location.reload());
});
addBtn.onclick=()=>window.open('/auth/google?popup=1','_blank','popup,width=520,height=650');

/*──────────────────  INIT  ─────────────────────────*/
document.addEventListener('DOMContentLoaded',()=>{
  loadPage(0);
  loadAccounts();
});

/*──────────────────  LOAD PAGE  ────────────────────*/
async function loadPage(idx){
  /* --------------------------------------------------
     t = Gmail next-page-token we stored for *primary*
     account (may be `"more"` – a placeholder meaning
     “there are still more pages, but no token needed”)
  -------------------------------------------------- */
  const t = pageTokens[idx];

  /* Build the request URL
     – always pass ?page=idx so the server knows which
       merged page we want
     – ONLY send &pageToken= when we have a *real*
       Gmail token (null and the literal string "more"
       are both skipped)                                      */
  const url =
    `/api/emails?page=${idx}` +
    (t && t !== "more" ? `&pageToken=${encodeURIComponent(t)}` : "");

  const r = await fetch(url);
  if (r.status === 401) {              // session expired → re-auth
    window.location = "/auth/google";
    return;
  }
  if (!r.ok) { alert("Server error"); return; }

  const { messages, nextPageToken } = await r.json();
  cachedPages[idx] = messages;

  renderTimeline(messages);
  if (view === 'smart') renderSmart();

  /* Store the marker for the *next* page –
     nextPageToken comes back as either:
       • a REAL Gmail token   → string
       • "more"               → other accts still have pages
       • null                 → nothing left anywhere       */
  if (nextPageToken !== null && pageTokens.length === idx + 1) {
    pageTokens.push(nextPageToken);
  }

  current = idx;
  updateNav();
}



/*──────────────────  TIMELINE  ─────────────────────*/
function renderTimeline(list){
  table.innerHTML =
    '<thead><tr><th>From</th><th>Subject</th><th style="text-align:right">Date</th></tr></thead>'+
    '<tbody>'+
      list.map(m=>{
        const cIdx = acctColor.get(m.acct) ?? 0;
        return `<tr data-id="${m.id}">
          <td><span class="acc-dot acc${cIdx}"></span>${m.from}</td>
          <td>${m.subject}${viewed.has(m.id)?'':' <span class="dot"></span>'}</td>
          <td style="text-align:right">${new Date(m.date).toLocaleString()}</td>
        </tr>`;
      }).join('')+
    '</tbody>';
}

/*──────────────────  SMART INBOX  ──────────────────*/
function renderSmart(){
  const msgs=cachedPages[current]||[];
  const buckets={};const domCount={};
  const add=(n,c,m)=>{ if(!buckets[n]) buckets[n]={color:c,items:[]}; buckets[n].items.push(m); };

  msgs.forEach(m=>{
    for(const r of rules){ if(r.test(m)){ add(r.name,r.color,m); return; } }
    const dom=(m.from.split('@')[1]||'').toLowerCase();
    domCount[dom]=(domCount[dom]||0)+1;
    add(domCount[dom]>=3?dom:'Other', domCount[dom]>=3?'#546e7a':'#455a64', m);
  });

  for(const [name,b] of Object.entries(buckets)){
    const meta=bucketMeta[name]??{
      opened:false,lastOpened:firstSmart?Date.now():0,
      ids:new Set(),color:b.color
    };

    const newIds      = new Set(b.items.map(it=>it.id));
    const unreadCount = b.items.filter(it=>!viewed.has(it.id)).length;
    const bucketDot   = unreadCount>0 && !firstSmart
      ? `<span class="dot bucket-dot" data-name="${name}"></span>` : '';

    b.html=`<div class="bucket${meta.opened?' open':''}" data-name="${name}">
      <div class="bucket-header" style="background:${b.color}">
        <span>${name}</span>
        <span><span class="badge">${b.items.length}</span>${bucketDot}</span>
      </div>
      <div class="bucket-body">
        ${b.items.map(it=>{
          const cIdx = acctColor.get(it.acct) ?? 0;
          return `<div class="item" data-id="${it.id}">
            <span class="item-from"><span class="acc-dot acc${cIdx}"></span>${it.from}</span>
            <span class="item-subject">
              ${it.subject}${viewed.has(it.id)?'':' <span class="dot"></span>'}
            </span>
            <span class="item-date">${new Date(it.date).toLocaleDateString()}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;

    meta.ids=newIds;
    bucketMeta[name]=meta;
  }
  smartBox.innerHTML=Object.values(buckets).map(b=>b.html).join('');
  firstSmart=false;
}

/* bucket interactions */
smartBox.addEventListener('click',e=>{
  if(e.target.classList.contains('bucket-dot')){
    const name=e.target.dataset.name;
    (bucketMeta[name]?.ids||new Set()).forEach(id=>markViewed(id));
    renderSmart();
    if(view==='timeline') renderTimeline(cachedPages[current]);
    return;
  }
  const hdr=e.target.closest('.bucket-header'); if(!hdr) return;
  const name=hdr.parentElement.dataset.name;
  const meta=bucketMeta[name];
  meta.opened=!meta.opened;
  if(meta.opened) meta.lastOpened=Date.now();
  hdr.parentElement.classList.toggle('open',meta.opened);
  renderSmart();
});

/*──────────────────  MESSAGE VIEWER  ───────────────*/
function openMsg(id){
  fetch('/api/emails/'+id)
    .then(r=>r.ok?r.json():Promise.reject())
    .then(m=>{
      markViewed(m.id);
      if(view==='smart') renderSmart();
      else               renderTimeline(cachedPages[current]);

      vSubj.textContent=m.subject;
      vMeta.textContent=`${m.from} — ${new Date(m.date).toLocaleString()}`;
      vBody.innerHTML='';
      if(m.isHtml){
        const frame=document.createElement('iframe');
        frame.style.border='none';frame.style.width='100%';
        frame.onload=()=>frame.contentDocument.head.insertAdjacentHTML(
          'beforeend',
          '<style>html,body{margin:0;padding:12px;font-family:system-ui;background:#fff;}img{max-width:100%;height:auto;display:block;}</style>'
        );
        frame.srcdoc=DOMPurify.sanitize(m.body,{ADD_ATTR:['target']});
        vBody.appendChild(frame);
        requestAnimationFrame(()=>frame.style.height=
          (document.querySelector('.modal').clientHeight-vBody.offsetTop-20)+'px');
      }else{
        vBody.textContent=m.body; vBody.style.whiteSpace='pre-wrap';
      }
      viewer.style.display='flex';
    })
    .catch(()=>alert('Failed to load message'));
}
table.addEventListener('click',e=>{
  const row=e.target.closest('[data-id]'); if(row) openMsg(row.dataset.id);
});
smartBox.addEventListener('click',e=>{
  if(e.target.closest('.bucket-header')) return;
  const it=e.target.closest('[data-id]'); if(it) openMsg(it.dataset.id);
});

/*──────────────────  NAVIGATION  ───────────────────*/
function updateNav(){
  prevBtn.disabled=current===0;
  nextBtn.disabled=pageTokens[current+1]===undefined;
}
prevBtn.onclick   =()=> current>0 && loadPage(current-1);
nextBtn.onclick   =()=> pageTokens[current+1]!==undefined && loadPage(current+1);
refreshBtn.onclick=()=>{
  pageTokens=[null]; cachedPages={};
  loadPage(0); loadAccounts();
};

/*──────────────────  VIEW / MODAL  ────────────────*/
function setView(v){
  view=v;
  tabTime.classList.toggle('active',v==='timeline');
  tabSmart.classList.toggle('active',v==='smart');
  table.style.display   = v==='timeline' ? '' : 'none';
  smartBox.style.display= v==='smart'    ? '' : 'none';
  if(v==='smart') renderSmart();
}
tabTime.onclick=()=>setView('timeline');
tabSmart.onclick=()=>setView('smart');

closeBtn.onclick =()=>viewer.style.display='none';
viewer.addEventListener('click',e=>{
  if(e.target===viewer) viewer.style.display='none';
});
