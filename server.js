'use strict';
// Karibu Kwenu – serveur sans dépendance (Node 18+)
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=process.env.PORT||3000;
const DIR=process.env.DATA_DIR||path.join(__dirname,'data');
const PASS={admin:process.env.ADMIN_PASS,cuisine:process.env.CUISINE_PASS,livreur:process.env.LIVREUR_PASS};
const SECRET=process.env.SECRET||crypto.randomBytes(32).toString('hex');
const DEMO=process.env.DEMO_PAYMENTS!=='0'; // 1 par défaut : paiements simulés tant qu'Orange Money n'est pas branché
const ROLES=['admin','cuisine','livreur'];

fs.mkdirSync(DIR,{recursive:true});
const FILE=path.join(DIR,'data.json');
let db;
try{db=JSON.parse(fs.readFileSync(FILE,'utf8'))}
catch(e){db={cfg:JSON.parse(fs.readFileSync(path.join(__dirname,'config.default.json'),'utf8')),orders:[],seq:1000,pay:[]}}
const save=()=>{fs.writeFileSync(FILE+'.tmp',JSON.stringify(db));fs.renameSync(FILE+'.tmp',FILE)};

// --- authentification ---
const sign=s=>crypto.createHmac('sha256',SECRET).update(s).digest('base64url');
const eq=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const mk=r=>{const b=r+'.'+(Date.now()+12*36e5);return b+'.'+sign(b)};
const who=req=>{const t=(req.headers.authorization||'').replace('Bearer ','').split('.');
  if(t.length!==3)return null;const b=t[0]+'.'+t[1];
  return ROLES.includes(t[0])&&eq(t[2],sign(b))&&+t[1]>Date.now()?t[0]:null};
const tries={};
const limited=ip=>{const n=Date.now(),t=tries[ip]||(tries[ip]={c:0,r:n+6e5});if(n>t.r){t.c=0;t.r=n+6e5}return t.c>=8};

// --- commandes ---
const now=()=>new Date().toISOString();
const log=(o,m)=>o.h.push([now(),m]);
const view=(o,staff)=>{const v={id:o.id,ref:o.ref,total:o.total,sub:o.sub,fee:o.fee,st:o.st,paid:o.paid,h:o.h,dt:o.dt,sl:o.sl,op:o.op,items:o.items};
  if(staff)Object.assign(v,{nm:o.nm,ph:o.ph,ad:o.ad,rp:o.rp,liv:o.liv});return v};
const expire=()=>{let c=0;for(const o of db.orders)if(o.st==='En attente de paiement'&&Date.now()-o.t>30*6e4){o.st='Annulée';log(o,'Commande expirée sans paiement (RG10)');c=1}if(c)save()};
const slotOK=(c,d,sl)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(d))return false;
  const day=(new Date(d+'T12:00:00Z').getUTCDay()+6)%7;if(!c.hrs.d[day])return false;
  for(let t=c.hrs.o;t<c.hrs.c;t++)if(sl===t+'h – '+(t+1)+'h')return true;return false};
const S=(x,n)=>String(x==null?'':x).trim().slice(0,n);

function createOrder(b){
  const c=db.cfg;
  if(!b||!Array.isArray(b.items)||!b.items.length||b.items.length>30)return[400,'Panier invalide.'];
  const nm=S(b.nm,80),ph=S(b.ph,30),mm=S(b.mm,30),ad=S(b.ad,200),rp=S(b.rp,200),dt=S(b.dt,10),sl=S(b.sl,20);
  if(!nm||!ph||!ad||!mm)return[400,'Merci de renseigner nom, téléphone, adresse et numéro Mobile Money.'];
  if(!slotOK(c,dt,sl))return[400,'Date ou créneau indisponible.'];
  let sub=0;const items=[];
  for(const l of b.items){
    const m=c.menu.find(x=>x.id===l.id),q=l.q|0;
    if(!m||!m.av||q<1||q>20)return[400,'Un plat de votre panier n’est plus disponible.'];
    let ap=0,a='';
    if(l.a){const ac=c.acc.find(x=>x.n===l.a);if(!ac)return[400,'Un accompagnement n’est plus disponible.'];ap=ac.p;a=ac.n}
    sub+=(m.p+ap)*q;items.push({n:m.n,q,a:l.a==null?null:a,ap});
  }
  const o={id:'CMD-'+(++db.seq),ref:'PAY-'+crypto.randomBytes(3).toString('hex').toUpperCase(),t:Date.now(),items,sub,fee:c.fee,total:sub+c.fee,
    nm,ph,mm,ad,rp,dt,sl,op:S(b.op,30),st:'En attente de paiement',paid:false,liv:'',h:[]};
  log(o,'Commande créée, en attente de paiement');db.orders.push(o);save();return[200,view(o)];
}

// Paiement SIMULÉ (démonstration). À remplacer par le webhook Orange Money : même logique de vérification.
function payDemo(o,b){
  const L=m=>db.pay.push([now(),o.ref,m]);
  if(!eq(b.ref||'',o.ref))return[403,'Référence invalide.'];
  const amt=+b.amount;
  if(o.paid){L('Notification en double ignorée (RG05)');log(o,'Notification en double ignorée')}
  else if(o.st!=='En attente de paiement'){L('Commande non payable ('+o.st+')')}
  else if(b.result==='pend'){L('Transaction en attente – aucune préparation (RG03)');log(o,'Paiement en attente')}
  else if(b.result==='fail'){L('Paiement échoué (RG02)');log(o,'Paiement échoué, commande non confirmée')}
  else if(b.result==='ok'&&amt!==o.total){L('Montant incorrect : '+amt+' reçu, '+o.total+' attendu – non validée (RG09)');log(o,'Montant incorrect, commande non validée')}
  else if(b.result==='ok'){o.paid=true;o.st='Payée';L('Paiement confirmé, '+amt+' FCFA');log(o,'Paiement intégral confirmé')}
  save();return[200,view(o)];
}

const T={prepare:['Payée','En préparation',['cuisine','admin']],ready:['En préparation','Prête',['cuisine','admin']],
  start:['Prête','En livraison',['livreur','admin']],delivered:['En livraison','Livrée',['livreur','admin']]};
function patch(o,role,b){
  const a=b.action;
  if(T[a]){
    const[f,t,r]=T[a];
    if(!r.includes(role))return[403,'Action non autorisée pour ce profil.'];
    if(o.st!==f)return[409,'Le statut de cette commande a changé.'];
    if(a==='start'){const l=S(b.liv,30);if(!l)return[400,'Livreur requis.'];o.liv=l}
    o.st=t;log(o,a==='start'?'Prise en charge par '+o.liv:t);
  }else if(a==='cancel'&&role==='admin'&&o.st==='En attente de paiement'){o.st='Annulée';log(o,'Commande annulée')}
  else if(a==='refund'&&role==='admin'&&o.paid&&!['Annulée','Remboursée'].includes(o.st)){
    o.st='Annulée';log(o,'Annulée, remboursement validé par l’administrateur (plat retourné)');
    o.st='Remboursée';log(o,'Remboursement effectué');db.pay.push([now(),o.ref,'Remboursement '+o.total+' FCFA']);
  }else return[400,'Action impossible.'];
  save();return[200,view(o,true)];
}

function putCfg(b){
  if(!b||!Array.isArray(b.menu)||!Array.isArray(b.acc)||typeof b.fee!=='number'||!b.hrs||!Array.isArray(b.hrs.d)||b.hrs.d.length!==7)return false;
  const img=/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
  const ok=b.menu.every(m=>Number.isInteger(m.id)&&typeof m.n==='string'&&typeof m.c==='string'&&m.p>=0&&(!m.img||img.test(m.img)))
    &&b.acc.every(a=>typeof a.n==='string'&&a.p>=0)&&b.fee>=0&&b.hrs.o>=0&&b.hrs.c<=24&&b.hrs.o<b.hrs.c;
  if(!ok)return false;
  db.cfg={menu:b.menu,acc:b.acc,fee:b.fee,hrs:{o:b.hrs.o|0,c:b.hrs.c|0,d:b.hrs.d.map(x=>x?1:0)}};save();return true;
}
const listFor=r=>db.orders.filter(o=>r==='admin'||(r==='cuisine'&&o.paid&&['Payée','En préparation','Prête'].includes(o.st))||(r==='livreur'&&['Prête','En livraison'].includes(o.st))).map(o=>view(o,true));

// --- serveur HTTP ---
http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x'),p=u.pathname;
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  const send=(c,o)=>{res.writeHead(c,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(c===200?o:{error:o}))};
  const out=r=>send(r[0],r[1]);
  const body=cb=>{let d='',n=0;req.on('data',c=>{n+=c.length;if(n>6e6)req.destroy();else d+=c});
    req.on('end',()=>{let j;try{j=JSON.parse(d||'{}')}catch(e){return send(400,'Requête invalide.')}cb(j)})};
  try{
    if(req.method==='GET'&&(p==='/'||p==='/index.html')){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});
      return res.end(fs.readFileSync(path.join(__dirname,'public','index.html')));
    }
    if(!p.startsWith('/api/'))return send(404,'Introuvable.');
    expire();const role=who(req);let m;
    if(req.method==='GET'&&p==='/api/config')return send(200,Object.assign({},db.cfg,{demo:DEMO}));
    if(req.method==='PUT'&&p==='/api/config'){if(role!=='admin')return send(401,'Connexion requise.');return body(b=>putCfg(b)?send(200,{ok:1}):send(400,'Réglages invalides.'))}
    if(req.method==='POST'&&p==='/api/login')return body(b=>{
      if(limited(ip))return send(429,'Trop de tentatives. Réessayez dans quelques minutes.');
      const r=String(b.role);
      if(!ROLES.includes(r)||!PASS[r]||!eq(b.password||'',PASS[r])){tries[ip].c++;return send(401,'Identifiants incorrects.')}
      send(200,{token:mk(r),role:r});
    });
    if(req.method==='POST'&&p==='/api/orders')return body(b=>out(createOrder(b)));
    if(req.method==='GET'&&p==='/api/orders'){if(!role)return send(401,'Connexion requise.');return send(200,listFor(role))}
    if(req.method==='GET'&&p==='/api/paylog'){if(role!=='admin')return send(401,'Connexion requise.');return send(200,db.pay.slice(-200))}
    if((m=p.match(/^\/api\/orders\/(CMD-\d+)(\/pay)?$/))){
      const o=db.orders.find(x=>x.id===m[1]);if(!o)return send(404,'Commande introuvable.');
      if(req.method==='GET'){return eq(u.searchParams.get('ref')||'',o.ref)?send(200,view(o)):send(403,'Référence invalide.')}
      if(req.method==='POST'&&m[2]){if(!DEMO)return send(403,'Le paiement Mobile Money n’est pas encore activé.');return body(b=>out(payDemo(o,b)))}
      if(req.method==='PATCH'&&!m[2]){if(!role)return send(401,'Connexion requise.');return body(b=>out(patch(o,role,b)))}
    }
    send(404,'Introuvable.');
  }catch(e){console.error(e);if(!res.headersSent)send(500,'Erreur du serveur.')}
}).listen(PORT,()=>{
  console.log('Karibu Kwenu sur le port '+PORT+(DEMO?' (paiements simulés)':''));
  const miss=ROLES.filter(r=>!PASS[r]);if(miss.length)console.warn('Mot de passe non défini pour : '+miss.join(', ')+' (connexion désactivée pour ces profils)');
});
