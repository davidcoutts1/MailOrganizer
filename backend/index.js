/*─────────────────────────  imports / config  ─────────────────────────*/
import express          from "express";
import session          from "express-session";
import cors             from "cors";
import { google }       from "googleapis";
import dotenv           from "dotenv";
import path             from "path";
import { fileURLToPath } from "url";

dotenv.config();
const {
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  BASE_URL,
  SESSION_SECRET
} = process.env;

/*─────────────────────────  app & middleware  ─────────────────────────*/
const app = express();
app.use(cors());
app.use(session({
  secret           : SESSION_SECRET,
  resave           : false,
  saveUninitialized: false
}));

/*─────────────────────────  Google OAuth  ─────────────────────────────*/
const oauth2 = new google.auth.OAuth2(
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  `${BASE_URL}/auth/google/callback`
);
const SCOPES   = ["https://www.googleapis.com/auth/gmail.readonly"];
const gmailFor = t => { oauth2.setCredentials(t); return google.gmail({version:"v1",auth:oauth2}); };

/*─────────────────────────  OAuth endpoints  ─────────────────────────*/
app.get("/auth/google",(req,res)=>{
  const state = req.query.popup ? "popup" : "";
  res.redirect(oauth2.generateAuthUrl({
    access_type : "offline",
    prompt      : "select_account",
    scope       : SCOPES,
    state
  }));
});

app.get("/auth/google/callback", async (req,res)=>{
  const {code,state}=req.query;
  if(!code) return res.status(400).send("Missing code");

  const {tokens}=await oauth2.getToken(code);
  req.session.tokens = Array.isArray(req.session.tokens)
    ? req.session.tokens.concat(tokens)
    : [tokens];

  /* clear helper caches so they rebuild next request */
  delete req.session.acctEmails;
  delete req.session.pageStacks;

  /* popup close / full redirect */
  const js=`if(window.opener){window.opener.location.reload();window.close();}else location='/inbox';`;
  if(state==="popup") return res.send(`<script>${js}</script>`);
  res.redirect("/inbox");
});

/*─────────────────────────  helpers (cached on session)  ─────────────*/
async function getAcctEmails(sess){
  if(Array.isArray(sess.acctEmails)) return sess.acctEmails;

  const out=[];
  for(const tk of sess.tokens){
    const gmail=gmailFor(tk);
    const {data:{emailAddress}} =
      await gmail.users.getProfile({userId:"me",fields:"emailAddress"});
    out.push(emailAddress);
  }
  sess.acctEmails = out;
  return out;
}

function ensurePageStacks(sess){
  if(Array.isArray(sess.pageStacks) &&
     sess.pageStacks.length === sess.tokens.length) return sess.pageStacks;

  /* initialise: for each account start stack with [null] (page-0) */
  sess.pageStacks = sess.tokens.map(()=>[ null ]);
  return sess.pageStacks;
}

/*─────────────────────────  LIST API  (/api/emails)  ──────────────────*/
app.get("/api/emails", async (req,res)=>{
  const tokens=req.session.tokens;
  if(!Array.isArray(tokens) || !tokens.length) return res.sendStatus(401);

  const acctEmails = await getAcctEmails(req.session);
  const stacks     = ensurePageStacks(req.session);

  const pageIdx = Number(req.query.page || 0);          // front-end page index

  /* ───── ensure every account's stack has pageIdx prepared ───── */
  for(let i=0;i<tokens.length;i++){
    const gm     = gmailFor(tokens[i]);
    let token    = stacks[i][pageIdx];          // may exist
    let cursor   = stacks[i][pageIdx-1];        // token of previous page

    while(token === undefined){                 // walk forward until filled
      const {data} = await gm.users.messages.list({
        userId:"me",
        labelIds:["INBOX"],
        maxResults:50,
        pageToken : cursor ?? undefined,
        fields    :"nextPageToken"
      });
      token  = data.nextPageToken ?? null;
      stacks[i].push(token);                    // push into stack
      cursor = token;                           // for next iteration
    }
  }

  /* ───── collect IDs for this merged page ───── */
  let merged=[];
  for(let i=0;i<tokens.length;i++){
    const gm = gmailFor(tokens[i]);
    const {data:list} = await gm.users.messages.list({
      userId:"me",
      labelIds:["INBOX"],
      maxResults:50,
      pageToken : stacks[i][pageIdx] ?? undefined,
      fields    :"messages(id),nextPageToken"
    });

    /* remember NEXT token for this account */
    const nextTok = list.nextPageToken ?? null;
    if(stacks[i].length <= pageIdx+1){
      stacks[i].push(nextTok);
    } else if(stacks[i][pageIdx+1] === undefined){
      stacks[i][pageIdx+1] = nextTok;
    }

    const msgs = list.messages ?? [];
    merged.push(...msgs.map(m=>({...m,_tk:tokens[i],acct:acctEmails[i]})));
  }

  /* ───── fetch minimal headers for the collected IDs ───── */
  const metas = await Promise.all(merged.map(async m=>{
    const gm = gmailFor(m._tk);
    const {data} = await gm.users.messages.get({
      userId:"me",
      id:m.id,
      format:"metadata",
      metadataHeaders:["Subject","From","Date"],
      fields:"id,payload/headers"
    });
    const h = Object.fromEntries(data.payload.headers.map(v=>[v.name,v.value]));
    return {id:data.id,from:h.From,subject:h.Subject,date:h.Date,acct:m.acct};
  }));

  /* dedupe + sort newest first */
  const seen=new Set();
  const unique = metas.filter(msg=> seen.has(msg.id) ? false : seen.add(msg.id));
  unique.sort((a,b)=> new Date(b.date) - new Date(a.date));

  /* any account still has a non-null next token? */
  const more = stacks.some(s => (s[pageIdx+1] ?? null) !== null);

  res.json({
    messages     : unique.slice(0,50),
    nextPageToken: more ? "more" : null
  });
});

/*─────────────────────────  SINGLE MESSAGE  ───────────────────────────*/
app.get("/api/emails/:id", async (req,res)=>{
  if(!Array.isArray(req.session.tokens)) return res.sendStatus(401);

  for(const tk of req.session.tokens){
    try{
      const gm=gmailFor(tk);
      const {data}=await gm.users.messages.get({
        userId:"me", id:req.params.id, format:"full"
      });
      const hdr = Object.fromEntries(data.payload.headers.map(h=>[h.name,h.value]));
      const find=(p,mt)=> p.mimeType===mt ? p :
            (p.parts||[]).reduce((f,c)=>f||find(c,mt),null);
      const html = find(data.payload,"text/html");
      const text = find(data.payload,"text/plain") || data.payload;
      const body = Buffer.from((html||text).body.data||"","base64").toString("utf8");

      return res.json({
        id:data.id, from:hdr.From, subject:hdr.Subject, date:hdr.Date,
        body, isHtml:!!html
      });
    }catch{/* ignore and try next token */}
  }
  res.sendStatus(404);
});

/*─────────────────────────  account helper APIs  ─────────────────────*/
app.get("/api/accounts", async (req,res)=>{
  if(!Array.isArray(req.session.tokens)) return res.json([]);
  res.json(await getAcctEmails(req.session));
});
app.delete("/api/accounts/:email",(req,res)=>{
  if(!Array.isArray(req.session.tokens)) return res.sendStatus(204);
  const idx = (req.session.acctEmails||[]).indexOf(req.params.email);
  if(idx>-1){
    req.session.tokens    .splice(idx,1);
    req.session.acctEmails.splice(idx,1);
    req.session.pageStacks.splice(idx,1);
  }
  res.sendStatus(204);
});

/*─────────────────────────  static frontend  ─────────────────────────*/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname,"..","frontend")));
app.get("/inbox",(_req,res)=>
  res.sendFile(path.join(__dirname,"..","frontend","index.html"))
);

/*─────────────────────────  start  ───────────────────────────────────*/
app.listen(3000,()=>console.log("📨  http://localhost:3000"));
