// index.js
/*─────────────────────────  imports / config  ─────────────────────────*/
import express           from "express";
import session           from "express-session";
import cors              from "cors";
import { google }        from "googleapis";
import dotenv            from "dotenv";
import path              from "path";
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
const gmailFor = t => {
  oauth2.setCredentials(t);
  return google.gmail({ version:"v1", auth:oauth2 });
};

/*─────────────────────────  OAuth endpoints  ─────────────────────────*/
app.get("/auth/google", (req,res) => {
  const state = req.query.popup ? "popup" : "";
  res.redirect(oauth2.generateAuthUrl({
    access_type: "offline",
    prompt     : "select_account",
    scope      : SCOPES,
    state
  }));
});

app.get("/auth/google/callback", async (req,res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send("Missing code");

  // exchange code for tokens
  const { tokens } = await oauth2.getToken(code);
  // get this account's email
  const gm = gmailFor(tokens);
  const { data: { emailAddress } } =
    await gm.users.getProfile({ userId:"me", fields:"emailAddress" });

  // init session arrays if needed
  if (!Array.isArray(req.session.tokens)) req.session.tokens = [];
  if (!Array.isArray(req.session.acctEmails)) req.session.acctEmails = [];

  // only add if not already present
  if (!req.session.acctEmails.includes(emailAddress)) {
    req.session.tokens.push(tokens);
    req.session.acctEmails.push(emailAddress);
  }

  // always clear message‐fetch cache
  delete req.session.mailCache;

  // redirect back
  const js = `if(window.opener){window.opener.location.reload();window.close();}else location='/inbox';`;
  if (state==="popup") return res.send(`<script>${js}</script>`);
  res.redirect("/inbox");
});

/*─────────────────────────  helpers  ─────────────────────────────────*/
/** Get the list of logged-in email addresses **/
async function getAcctEmails(sess) {
  if (Array.isArray(sess.acctEmails)) return sess.acctEmails;
  const out = [];
  for (const tk of sess.tokens) {
    const gm = gmailFor(tk);
    const { data: { emailAddress } } =
      await gm.users.getProfile({ userId: "me", fields: "emailAddress" });
    out.push(emailAddress);
  }
  sess.acctEmails = out;
  return out;
}

/** Initialize our in-session mail-cache **/
function initMailCache(sess){
  if (sess.mailCache) return;
  sess.mailCache = {
    acctEmails : [],    // filled once
    nextTokens : [],    // undefined = not fetched yet, null = exhausted
    pool       : []     // all fetched & deduped; newest→oldest
  };
}

/*─────────────────────────  LIST API  ─────────────────────────────────*/
app.get("/api/emails", async (req, res) => {
  const tokens = req.session.tokens;
  if (!Array.isArray(tokens) || tokens.length === 0) return res.sendStatus(401);

  initMailCache(req.session);
  const cache = req.session.mailCache;

  // first-time setup: account emails + seed nextTokens
  if (cache.acctEmails.length === 0) {
    cache.acctEmails = await getAcctEmails(req.session);
    cache.nextTokens = tokens.map(() => undefined);
  }

  const pageIdx   = Number(req.query.page || 0);
  const needCount = (pageIdx + 1) * 50;  // 50, 100, 150, ...

  // fetch batches of 50 per account until we have enough or everyone’s done
  while (cache.pool.length < needCount &&
         cache.nextTokens.some(tok => tok !== null))
  {
    for (let i = 0; i < tokens.length; i++) {
      const gm  = gmailFor(tokens[i]);
      const tok = cache.nextTokens[i];
      if (tok === null) continue;  // no more pages for this account

      // pull up to 50 message IDs
      const { data: list } = await gm.users.messages.list({
        userId     : "me",
        labelIds   : ["INBOX"],
        maxResults : 50,
        pageToken  : tok || undefined,
        fields     : "messages(id),nextPageToken"
      });
      cache.nextTokens[i] = list.nextPageToken ?? null;

      // fetch each message’s headers with per-message error handling
      const rawMetas = await Promise.all(
        (list.messages||[]).map(m =>
          gm.users.messages.get({
            userId          : "me",
            id              : m.id,
            format          : "metadata",
            metadataHeaders : ["Subject","From","Date"],
            fields          : "id,payload/headers"
          })
          .then(({ data }) => {
            const h = Object.fromEntries(
              data.payload.headers.map(v=>[v.name,v.value])
            );
            return {
              id     : data.id,
              from   : h.From,
              subject: h.Subject,
              date   : h.Date,
              acct   : cache.acctEmails[i]
            };
          })
          .catch(_err => null)
        )
      );

      // filter, dedupe & add new
      const metas = rawMetas.filter(x => x);
      const seen  = new Set(cache.pool.map(x=>x.id));
      for (const m of metas) {
        if (!seen.has(m.id)) {
          cache.pool.push(m);
          seen.add(m.id);
        }
      }
    }

    // sort newest→oldest
    cache.pool.sort((a,b) => new Date(b.date) - new Date(a.date));
  }

  // slice out the requested page
  const start = pageIdx * 50;
  const page  = cache.pool.slice(start, start + 50);

  // figure out if there’s more
  const more = cache.pool.length > (pageIdx+1)*50 ||
               cache.nextTokens.some(tok => tok !== null);

  res.json({
    messages     : page,
    nextPageToken: more ? "more" : null
  });
});

/*─────────────────────────  SINGLE MESSAGE  ───────────────────────────*/
app.get("/api/emails/:id", async (req, res) => {
  if (!Array.isArray(req.session.tokens)) return res.sendStatus(401);

  for (const tk of req.session.tokens) {
    try {
      const gm   = gmailFor(tk);
      const { data } = await gm.users.messages.get({
        userId: "me", id: req.params.id, format: "full"
      });
      const hdr = Object.fromEntries(
        data.payload.headers.map(h=>[h.name,h.value])
      );
      const find = (p,mt) =>
        p.mimeType===mt ? p :
        (p.parts||[]).reduce((f,c)=>f||find(c,mt),null);
      const html = find(data.payload,"text/html");
      const text = find(data.payload,"text/plain") || data.payload;
      const body = Buffer.from((html||text).body.data||"","base64").toString("utf8");

      return res.json({
        id     : data.id,
        from   : hdr.From,
        subject: hdr.Subject,
        date   : hdr.Date,
        body,
        isHtml : !!html
      });
    } catch {/* try next */}
  }
  res.sendStatus(404);
});

/*─────────────────────────  account helper APIs  ─────────────────────*/
app.get("/api/accounts", async (req,res)=>{
  if (!Array.isArray(req.session.tokens)) return res.json([]);
  res.json(await getAcctEmails(req.session));
});
app.delete("/api/accounts/:email",(req,res)=>{
  const idx = (req.session.acctEmails||[]).indexOf(req.params.email);
  if (idx > -1) {
    req.session.tokens    .splice(idx,1);
    req.session.acctEmails.splice(idx,1);
    if (req.session.mailCache) {
      req.session.mailCache.acctEmails.splice(idx,1);
      req.session.mailCache.nextTokens.splice(idx,1);
      req.session.mailCache.pool =
        req.session.mailCache.pool.filter(m => m.acct !== req.params.email);
    }
  }
  res.sendStatus(204);
});

/*─────────────────────────  static frontend  ─────────────────────────*/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname,"..","frontend")));

// landing page
app.get("/", (_req,res) =>
  res.sendFile(path.join(__dirname,"..","frontend","index.html"))
);

// inbox page
app.get("/inbox", (_req,res) =>
  res.sendFile(path.join(__dirname,"..","frontend","app.html"))
);

/*─────────────────────────  start  ───────────────────────────────────*/
app.listen(3000, () => console.log("📨  http://localhost:3000"));
