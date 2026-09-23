const firebaseConfig = window.APP_CONFIG.firebase;

const FIREBASE_READY = firebaseConfig.apiKey !== "SUA_API_KEY";
let db = null;
let auth = null;
let currentUser = null;
if(FIREBASE_READY){
  firebase.initializeApp(firebaseConfig);
  db = firebase.database();
  auth = firebase.auth();
  auth.onAuthStateChanged(user=>{
    currentUser = user;
    updateAuthStatus();
    if(currentTab==='painel' || currentTab==='config'){ switchTab(currentTab); }
  });
}
function updateAuthStatus(){
  const el = document.getElementById('authStatus');
  if(!el) return;
  document.body.classList.toggle('staff-mode', !!currentUser);
  if(currentUser){
    el.innerHTML = `<span class="who">${escapeHtml(currentUser.email)}</span><button class="btn ghost tiny" id="btnLogout">Sair</button>`;
    const b = document.getElementById('btnLogout');
    if(b) b.addEventListener('click', ()=>{ auth.signOut(); switchTab('publico'); });
  } else {
    el.innerHTML = `<button class="btn ghost tiny public-team-entry" id="btnTeamLogin">Área da equipe</button>`;
    const b = document.getElementById('btnTeamLogin');
    if(b) b.addEventListener('click', ()=> switchTab('painel'));
  }
}
function renderLoginScreen(){
  detachLiveSeats();
  document.getElementById('content').innerHTML = `<div class="panel login-screen">
    <h2>Entrar</h2>
    <p class="note" style="margin-top:-6px;">Acesso restrito à equipe do Studio A.</p>
    <div class="field"><label>E-mail</label><input id="loginEmail" type="email" placeholder="seuemail@exemplo.com"/></div>
    <div class="field"><label>Senha</label><input id="loginSenha" type="password" placeholder="••••••••"/></div>
    <button class="btn gold" id="btnEntrar" style="margin-top:8px;">Entrar</button>
    <p class="note" id="loginErro" style="color:#f0a3b3;"></p>
  </div>`;
  const tryLogin = async ()=>{
    const email = document.getElementById('loginEmail').value.trim();
    const senha = document.getElementById('loginSenha').value;
    try{
      await auth.signInWithEmailAndPassword(email, senha);
    }catch(e){
      document.getElementById('loginErro').textContent = 'E-mail ou senha incorretos.';
    }
  };
  document.getElementById('btnEntrar').addEventListener('click', tryLogin);
  document.getElementById('loginSenha').addEventListener('keydown', e=>{ if(e.key==='Enter') tryLogin(); });
}

const emailjsConfig = window.APP_CONFIG.emailjs;

const EMAILJS_READY = emailjsConfig.publicKey !== "SUA_PUBLIC_KEY";
if(EMAILJS_READY && window.emailjs){ emailjs.init(emailjsConfig.publicKey); }

let CONFIG = null;
let SEATS_CACHE = {};
let currentTab = 'publico';
let selectionMode = false;
let selectedSeats = new Set();
let currentShowId = null;
let currentSessionId = null;
let liveSeatsRef = null;
let countdownTimer = null;
let reportCache = {};
let reportRefreshTimer = null;
function stopCountdown(){
  if(countdownTimer){ clearInterval(countdownTimer); countdownTimer = null; }
}
function formatCountdown(session){
  if(!session || !session.date) return null;
  const target = new Date(session.date + 'T' + (session.time || '00:00') + ':00');
  if(isNaN(target.getTime())) return null;
  const diff = target.getTime() - Date.now();
  if(diff <= 0) return 'Esta sessão já foi realizada';
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if(days) parts.push(days + (days===1?' dia':' dias'));
  if(hours || days) parts.push(hours + 'h');
  parts.push(minutes + 'min');
  return 'Faltam ' + parts.join(' ') + ' para esta sessão';
}
let liveSeatsHandler = null;

const DEFAULT_CONFIG = {
  rows: 10,
  seatsLeft: 9,
  seatsCenter: 8,
  seatsRight: 8,
  prices: {},
  globalUnavailable: {},
  shows: [
    { id: 'show1', name: 'Rei o Show', sessions: [ { id: 's1_1', date: '', time: '' } ] },
    { id: 'show2', name: 'Frozen', sessions: [ { id: 's2_1', date: '', time: '' } ] },
    { id: 'show3', name: 'Wicked', sessions: [ { id: 's3_1', date: '', time: '' } ] }
  ]
};

function uid(prefix){ return prefix + '_' + Math.random().toString(36).slice(2,8); }
function resizeImageToDataUrl(file, maxW, maxH){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onerror = ()=> reject(new Error('read failed'));
    reader.onload = ()=>{
      const img = new Image();
      img.onerror = ()=> reject(new Error('image failed'));
      img.onload = ()=>{
        let w = img.width, h = img.height;
        const ratio = Math.min(1, maxW / w, maxH / h);
        w = Math.round(w * ratio); h = Math.round(h * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 1800);
}
function rowLetter(i){ return String.fromCharCode(65+i); }
function escapeHtml(str){
  return (str||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------- Config ---------- */
async function loadConfig(){
  let readOk = false;
  try{
    const snap = await db.ref('config').once('value');
    CONFIG = snap.val();
    readOk = true;
  }catch(e){ CONFIG = null; }
  if(!CONFIG){
    CONFIG = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    // Só tenta criar a configuração quando há uma leitura válida ou usuário autenticado.
    if(readOk && currentUser) await saveConfig();
  }
  if(!CONFIG.shows) CONFIG.shows = [];
  if(!CONFIG.prices) CONFIG.prices = {};
  if(!CONFIG.globalUnavailable) CONFIG.globalUnavailable = {};
  loadRoomLayoutFromConfig();
  if(!currentShowId && CONFIG.shows.length) currentShowId = CONFIG.shows[0].id;
  syncCurrentSession();
}
async function saveConfig(){
  try{ await db.ref('config').set(CONFIG); }
  catch(e){ showToast('Erro ao salvar configuração'); }
}
async function migrateGlobalUnavailable(){
  // Migra indisponibilidades antigas, que eram salvas por sessão, para o estado global.
  if(CONFIG._globalUnavailableMigrated) return;
  const sessions = [];
  (CONFIG.shows||[]).forEach(show=>(show.sessions||[]).forEach(se=>sessions.push(se.id)));
  if(!sessions.length){ CONFIG._globalUnavailableMigrated = true; await db.ref('config/_globalUnavailableMigrated').set(true); return; }
  try{
    const snaps = await Promise.all(sessions.map(id=>db.ref('seats/'+id).once('value')));
    const unavailable = new Set();
    snaps.forEach(snap=>{ const seats=snap.val()||{}; Object.entries(seats).forEach(([id,d])=>{ if(d && d.status==='indisponivel') unavailable.add(id); }); });
    const updates = {'config/_globalUnavailableMigrated':true};
    unavailable.forEach(id=>{
      updates['config/globalUnavailable/'+id]=true;
      sessions.forEach(sessionId=>{ const d=(snaps[sessions.indexOf(sessionId)].val()||{})[id]; if(d && d.status==='indisponivel') updates['seats/'+sessionId+'/'+id]=null; });
      CONFIG.globalUnavailable[id]=true;
    });
    await db.ref().update(updates);
    CONFIG._globalUnavailableMigrated = true;
  }catch(e){ /* se falhar, o sistema continua funcionando e tenta na próxima carga */ }
}
function syncCurrentSession(){
  const show = CONFIG.shows.find(s=>s.id===currentShowId);
  if(show && show.sessions && show.sessions.length){
    if(!currentSessionId || !show.sessions.find(se=>se.id===currentSessionId)){
      currentSessionId = show.sessions[0].id;
    }
  } else {
    currentSessionId = null;
  }
}

/* ---------- Seats (realtime) ---------- */
function detachLiveSeats(){
  if(liveSeatsRef && liveSeatsHandler){ liveSeatsRef.off('value', liveSeatsHandler); }
  liveSeatsRef = null; liveSeatsHandler = null;
}
function attachLiveSeats(sessionId, onUpdate){
  detachLiveSeats();
  if(!sessionId) return;
  liveSeatsRef = db.ref('seats/'+sessionId);
  liveSeatsHandler = (snap)=>{
    const data = snap.val() || {};
    SEATS_CACHE[sessionId] = data;
    onUpdate(data);
  };
  liveSeatsRef.on('value', liveSeatsHandler);
}
async function setGlobalUnavailable(seatId, unavailable){
  CONFIG.globalUnavailable = CONFIG.globalUnavailable || {};
  if(unavailable) CONFIG.globalUnavailable[seatId] = true;
  else delete CONFIG.globalUnavailable[seatId];
  try{
    const ref = db.ref('config/globalUnavailable/'+seatId);
    if(unavailable) await ref.set(true); else await ref.remove();
  }catch(e){ throw e; }
}
function isGlobalUnavailable(seatId){
  return !!(CONFIG.globalUnavailable && CONFIG.globalUnavailable[seatId]);
}
let globalUnavailableRef = null;
function attachGlobalUnavailableListener(){
  if(globalUnavailableRef) return;
  globalUnavailableRef = db.ref('config/globalUnavailable');
  globalUnavailableRef.on('value', snap=>{
    if(!CONFIG) return;
    CONFIG.globalUnavailable = snap.val() || {};
    if(currentTab==='publico') renderPublico();
    else if(currentTab==='painel' && currentUser) renderPainel();
  });
}
function effectiveSeatStatus(seats, seatId){
  if(isGlobalUnavailable(seatId)) return 'indisponivel';
  return seats[seatId] ? seats[seatId].status : defaultStatusFor(seatId);
}
async function clearSeatAcrossSessions(seatId){
  const updates = {};
  (CONFIG.shows||[]).forEach(show=>(show.sessions||[]).forEach(se=>{ updates['seats/'+se.id+'/'+seatId] = null; }));
  if(Object.keys(updates).length) await db.ref().update(updates);
  Object.keys(SEATS_CACHE).forEach(sessionId=>{ if(SEATS_CACHE[sessionId]) delete SEATS_CACHE[sessionId][seatId]; });
}
async function saveSeat(sessionId, seatId, seatData){
  try{
    if(seatData && seatData.status === 'indisponivel'){
      await setGlobalUnavailable(seatId, true);
      await logHistory(sessionId, seatId, { status:'indisponivel', nome:'', at: Date.now(), by: currentUser?currentUser.email:'?' });
      return;
    }
    if(isGlobalUnavailable(seatId)) await setGlobalUnavailable(seatId, false);
    if(seatData === null){
      await db.ref('seats/'+sessionId+'/'+seatId).remove();
      if(SEATS_CACHE[sessionId]) delete SEATS_CACHE[sessionId][seatId];
      await logHistory(sessionId, seatId, { status:'livre', nome:'', at: Date.now(), by: currentUser?currentUser.email:'?' });
    } else {
      await db.ref('seats/'+sessionId+'/'+seatId).set(seatData);
      SEATS_CACHE[sessionId] = SEATS_CACHE[sessionId] || {};
      SEATS_CACHE[sessionId][seatId] = seatData;
      await logHistory(sessionId, seatId, { status:seatData.status, nome:seatData.nome||'', at: Date.now(), by: currentUser?currentUser.email:'?' });
    }
  }catch(e){ showToast('Erro ao salvar assento'); }
}
function logHistory(sessionId, seatId, entry){
  return db.ref('history/'+sessionId+'/'+seatId).push(entry).catch(()=>{});
}
function statusLabel(st){
  return st==='vendido' ? 'Vendido' : st==='convidado' ? 'Convidado' : st==='indisponivel' ? 'Indisponível' : st==='aluno' ? 'Aluno' : 'Liberado';
}

/* ---------- Layout da sala — laterais em escada ---------- */
// Layout padrão (usado na primeira vez, antes de qualquer edição em Configurações da sala).
// Corrigido: a última fileira (L) tem só 8 lugares no centro (e fica centralizada nessa fileira).
const DEFAULT_ROOM_LAYOUT = [
  {row:'A', left:2, center:15, right:2},
  {row:'B', left:3, center:15, right:3},
  {row:'C', left:5, center:15, right:4},
  {row:'D', left:6, center:15, right:5},
  {row:'E', left:7, center:15, right:8},
  {row:'F', left:7, center:15, right:8},
  {row:'G', left:7, center:15, right:8},
  {row:'H', left:7, center:15, right:8},
  {row:'I', left:7, center:15, right:8},
  {row:'J', left:6, center:15, right:8},
  {row:'K', left:6, center:15, right:8},
  {row:'L', left:4, center:8, right:8}
];
// ROOM_LAYOUT agora é editável (Configurações da sala) e fica salvo em CONFIG.roomLayout no Firebase.
// É um "let" porque pode ser trocado por um layout carregado da configuração ou editado em tempo de uso.
let ROOM_LAYOUT = JSON.parse(JSON.stringify(DEFAULT_ROOM_LAYOUT));
function loadRoomLayoutFromConfig(){
  if(CONFIG && Array.isArray(CONFIG.roomLayout) && CONFIG.roomLayout.length){
    ROOM_LAYOUT = CONFIG.roomLayout;
  } else {
    ROOM_LAYOUT = JSON.parse(JSON.stringify(DEFAULT_ROOM_LAYOUT));
    if(CONFIG) CONFIG.roomLayout = ROOM_LAYOUT;
  }
}
async function saveRoomLayout(){
  CONFIG.roomLayout = ROOM_LAYOUT;
  await saveConfig();
}
function totalPhysicalSeats(){
  return ROOM_LAYOUT.reduce((sum,x)=> sum + x.left + x.center + x.right, 0);
}
function totalUnavailableSeats(){
  if(!CONFIG || !CONFIG.globalUnavailable) return 0;
  // conta só as que realmente existem no layout atual
  let n = 0;
  ROOM_LAYOUT.forEach(layout=>{
    const width = layout.left + layout.center + layout.right;
    for(let col=1; col<=width; col++){ if(CONFIG.globalUnavailable[layout.row+col]) n++; }
  });
  return n;
}
// Numeração sequencial de cadeiras (1..N) que atravessa as fileiras (A, B, C... Z), sem reiniciar a
// numeração em cada fileira. Cadeiras marcadas como "Indisponível" (removida globalmente) OU como
// "Aluno" (reservada, não é vendida ao público) não contam nessa numeração — por isso o número total
// muda dinamicamente ao adicionar/remover cadeiras ou ao liberar/reservar uma cadeira de aluno.
// "seats" é opcional: se não for passado, usa os dados da sessão atualmente selecionada.
// Numeração sequencial normal (1..N), pulando indisponíveis e alunos. Cadeiras marcadas como
// "extra" (ver markSeatAsExtra) NÃO entram nesse cálculo — elas têm um número FIXO, guardado no
// banco desde o momento em que foram liberadas, e são somadas no final, sem nunca recalcular a
// posição delas. Isso garante que vender/desvender uma cadeira extra nunca embaralha a numeração
// das cadeiras normais nem a de outras cadeiras extras já numeradas.
function computeSeatNumberMap(seats){
  const data = seats || SEATS_CACHE[currentSessionId] || {};
  const map = {};
  let n = 0;
  const extraIds = [];
  ROOM_LAYOUT.forEach(layout=>{
    const width = layout.left + layout.center + layout.right;
    for(let col=1; col<=width; col++){
      const id = layout.row + col;
      if(data[id] && data[id].extra){ extraIds.push(id); continue; }
      const st = effectiveSeatStatus(data, id);
      if(st==='indisponivel' || st==='aluno') continue;
      n++;
      map[id] = n;
    }
  });
  let total = n;
  extraIds.forEach(id=>{
    const num = data[id].extraNumber;
    if(num!=null){
      map[id] = num;
      if(num > total) total = num;
    }
  });
  return { map, total };
}
// Libera uma cadeira de aluno como "extra" (vendível), atribuindo o próximo número disponível
// (sempre depois da última cadeira numerada até agora) e GUARDANDO esse número no banco — ele não
// é recalculado depois, então vender/mudar o status dessa cadeira nunca muda o número dela.
async function markSeatAsExtra(sessionId, seatId){
  const seats = SEATS_CACHE[sessionId] || {};
  const { total } = computeSeatNumberMap(seats); // nesse momento a cadeira ainda não é 'extra', então 'total' é o maior número já em uso
  const newNumber = total + 1;
  const current = seats[seatId] || {};
  const updated = Object.assign({}, current, { extra:true, extraNumber:newNumber, status: current.status || 'livre' });
  await db.ref('seats/'+sessionId+'/'+seatId).set(updated);
  SEATS_CACHE[sessionId] = SEATS_CACHE[sessionId] || {};
  SEATS_CACHE[sessionId][seatId] = updated;
  return newNumber;
}
// Desfaz a cadeira extra: volta a ser uma cadeira reservada para aluno (remove o registro por
// completo, igual a "Liberar assento"). O número que ela tinha simplesmente some — os números das
// outras cadeiras extras não mudam.
async function unmarkSeatAsExtra(sessionId, seatId){
  await db.ref('seats/'+sessionId+'/'+seatId).remove();
  if(SEATS_CACHE[sessionId]) delete SEATS_CACHE[sessionId][seatId];
}
function seatDisplayLabel(seatId, numberMap){
  const map = numberMap || computeSeatNumberMap().map;
  const n = map[seatId];
  return n!=null ? (seatRowLetter(seatId) + n) : seatId;
}
// Acha todos os assentos (vendido/convidado) desta sessão com o mesmo e-mail — usado pra mandar
// um único e-mail com todos os ingressos do mesmo comprador, em vez de um e-mail por assento.
function findEmailGroup(seats, email){
  const norm = (email||'').trim().toLowerCase();
  if(!norm) return [];
  return Object.entries(seats)
    .filter(([id,d]) => d && (d.status==='vendido'||d.status==='convidado') && (d.email||'').trim().toLowerCase()===norm)
    .sort((a,b)=> a[0].localeCompare(b[0]));
}
function roomRow(r){ return ROOM_LAYOUT[r] || {row:rowLetter(r), left:7, center:15, right:8}; }
function rowWidth(r){ const x=roomRow(r); return x.left+x.center+x.right; }
function blockOf(n, r){ const x=roomRow(r); if(n<=x.left) return 'left'; if(n<=x.left+x.center) return 'center'; return 'right'; }
function seatColumn(seatId){ const m=seatId.match(/\d+$/); return m ? parseInt(m[0],10) : 1; }
function seatRowLetter(seatId){ const m=seatId.match(/^[A-Z]+/); return m ? m[0] : ''; }
function rowIndexFromSeatId(seatId){ const letter=seatRowLetter(seatId); return ROOM_LAYOUT.findIndex(x=>x.row===letter); }
function defaultStatusFor(seatId){ const r=rowIndexFromSeatId(seatId); return blockOf(seatColumn(seatId), r) === 'right' ? 'aluno' : 'livre'; }
function seatIdFor(r,n){ return roomRow(r).row+n; }
function renderSeatMap(seats, readonly){
  const maxLeft = Math.max(...ROOM_LAYOUT.map(x=>x.left));
  const maxRight = Math.max(...ROOM_LAYOUT.map(x=>x.right));
  const maxCenter = Math.max(...ROOM_LAYOUT.map(x=>x.center));
  const numberMap = computeSeatNumberMap(seats).map;
  let html = '<div class="stage-wrap"><div class="stage"><span>Palco</span></div><div class="seatmap stair-seatmap">';
  ROOM_LAYOUT.forEach((layout,r)=>{
    html += `<div class="seat-row stair-row" data-row="${layout.row}"><div class="row-label">${layout.row}</div>`;
    const leftPad = maxLeft-layout.left;
    const rightPad = maxRight-layout.right;
    // Se essa fileira tem menos cadeiras no centro que o máximo (ex: última fileira com 8 em vez de 15),
    // preenche os dois lados com espaços invisíveis pra ficar centralizada em relação às outras fileiras.
    const centerGap = maxCenter - layout.center;
    const centerPadLeft = Math.floor(centerGap/2);
    const centerPadRight = Math.ceil(centerGap/2);
    for(let i=0;i<leftPad;i++) html += '<div class="seat stair-empty"></div>';
    for(let n=1;n<=layout.left;n++){
      const id=layout.row+n, st=effectiveSeatStatus(seats,id), cls=st==='livre'?'':st, num=numberMap[id], mark=st==='indisponivel'?'✕':(num!=null?String(num):''), who=seats[id]&&seats[id].nome?' — '+seats[id].nome:'', numTxt=num!=null?(' — Nº '+num):'', title=(st==='aluno'?id+' — reservado para alunos':id+' — '+statusLabel(st)+who)+numTxt;
      html += `<div class="seat ${cls} ${readonly?'readonly':''}" data-seat="${id}" title="${escapeHtml(title)}">${mark}</div>`;
    }
    html += '<div class="seat aisle-gap"></div>';
    for(let i=0;i<centerPadLeft;i++) html += '<div class="seat stair-empty"></div>';
    for(let n=layout.left+1;n<=layout.left+layout.center;n++){
      const id=layout.row+n, st=effectiveSeatStatus(seats,id), cls=st==='livre'?'':st, num=numberMap[id], mark=st==='indisponivel'?'✕':(num!=null?String(num):''), who=seats[id]&&seats[id].nome?' — '+seats[id].nome:'', numTxt=num!=null?(' — Nº '+num):'', title=(st==='aluno'?id+' — reservado para alunos':id+' — '+statusLabel(st)+who)+numTxt;
      html += `<div class="seat ${cls} ${readonly?'readonly':''}" data-seat="${id}" title="${escapeHtml(title)}">${mark}</div>`;
    }
    for(let i=0;i<centerPadRight;i++) html += '<div class="seat stair-empty"></div>';
    html += '<div class="seat aisle-gap"></div>';
    for(let n=layout.left+layout.center+1;n<=layout.left+layout.center+layout.right;n++){
      const id=layout.row+n, st=effectiveSeatStatus(seats,id), cls=st==='livre'?'':st, num=numberMap[id], mark=st==='indisponivel'?'✕':(num!=null?String(num):''), who=seats[id]&&seats[id].nome?' — '+seats[id].nome:'', numTxt=num!=null?(' — Nº '+num):'', title=(st==='aluno'?id+' — reservado para alunos':id+' — '+statusLabel(st)+who)+numTxt;
      html += `<div class="seat ${cls} ${readonly?'readonly':''}" data-seat="${id}" title="${escapeHtml(title)}">${mark}</div>`;
    }
    for(let i=0;i<rightPad;i++) html += '<div class="seat stair-empty"></div>';
    html += '</div>';
  });
  html += '</div></div>';
  html += `<div class="legend"><div class="item"><span class="swatch" style="background:var(--seat-free)"></span>Disponível</div><div class="item"><span class="swatch" style="background:var(--seat-sold)"></span>Vendido / Pago / Convidado</div><div class="item"><span class="swatch" style="background:var(--seat-indisponivel)"></span>Indisponível</div><div class="item"><span class="swatch aluno-sw"></span>Reservado — alunos</div></div>`;
  return html;
}

function computeSummary(seats){
  let livre=0, vendido=0, convidado=0, indisponivel=0, alunos=0;
  for(let r=0;r<ROOM_LAYOUT.length;r++){
    for(let n=1;n<=rowWidth(r);n++){
      const id = seatIdFor(r,n);
      const st = effectiveSeatStatus(seats, id);
      if(st==='vendido') vendido++;
      else if(st==='convidado') convidado++;
      else if(st==='indisponivel') indisponivel++;
      else if(st==='aluno') alunos++;
      else livre++;
    }
  }
  const sellable = livre + vendido + convidado;
  return {sellable, livre, indisponivel, vendido, convidado, alunos};
}

function moneyBRL(value){
  return Number(value||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
}
function sessionOccupancy(seats){
  const sum = computeSummary(seats||{});
  const totalRoom = sum.sellable;
  const pct = totalRoom ? ((sum.vendido + sum.convidado) / totalRoom) * 100 : 0;
  return {sum,totalRoom,pct};
}
function renderSessionOverview(seats, found){
  if(!found) return '';
  const occ = sessionOccupancy(seats);
  const countdown = formatCountdown(found.session) || '';
  return `<div class="session-overview">
    <div class="session-meta">
      <span class="session-kicker">Sessão selecionada</span>
      <span class="session-title">${escapeHtml(sessionLabel(found.session))}</span>
      <span id="countdownArea" class="countdown">${escapeHtml(countdown)}</span>
    </div>
    <div class="occupancy">
      <div class="occupancy-head"><span>Lotação da sessão</span><strong>${occ.pct.toFixed(1).replace('.',',')}% ocupada</strong></div>
      <div class="occupancy-track"><div class="occupancy-fill" style="width:${Math.min(100,occ.pct).toFixed(2)}%"></div></div>
      <div class="note">${occ.sum.vendido} vendidos + ${occ.sum.convidado} convidados de ${occ.totalRoom} lugares vendíveis</div>
    </div>
  </div>`;
}
async function getShowReport(show){
  const sessions = (show && show.sessions) || [];
  await Promise.all(sessions.map(async se=>{
    if(SEATS_CACHE[se.id] !== undefined) return;
    try{
      const snap = await db.ref('seats/'+se.id).once('value');
      SEATS_CACHE[se.id] = snap.val() || {};
    }catch(e){ SEATS_CACHE[se.id] = {}; }
  }));
  let sold=0, convidados=0, checked=0, revenue=0, totalPlaces=0;
  for(const se of sessions){
    const seats = SEATS_CACHE[se.id] || {};
    const sum = computeSummary(seats);
    // Alunos não fazem parte da lotação comercial.
    // Lugares indisponíveis também não são vendíveis.
    totalPlaces += sum.sellable - sum.indisponivel;
    Object.entries(seats).forEach(([id,d])=>{
      if(d && d.status==='vendido'){
        sold++;
        if(d.checkin) checked++;
        revenue += Number((CONFIG.prices && CONFIG.prices[id]) || 0);
      } else if(d && d.status==='convidado'){
        convidados++;
        if(d.checkin) checked++;
      }
    });
  }
  const totalIngressos = sold + convidados;
  const occupancy = totalPlaces ? totalIngressos/totalPlaces*100 : 0;
  const now = Date.now();
  const allEnded = sessions.length>0 && sessions.every(se=>{
    const d = new Date(se.date+'T'+(se.time||'00:00')+':00');
    return !isNaN(d.getTime()) && d.getTime() < now;
  });
  return {sessions:sessions.length,totalPlaces,sold,convidados,totalIngressos,checked,revenue,occupancy,missing:Math.max(0,totalIngressos-checked),allEnded};
}
async function renderShowReport(showId){
  const box = document.getElementById('showReportArea');
  if(!box) return;
  const show = CONFIG.shows.find(s=>s.id===showId);
  if(!show){ box.innerHTML=''; return; }
  const cache = reportCache[showId];
  if(cache && Date.now() - cache.at < 2500){
    renderShowReportHtml(box, show, cache.data);
    return;
  }
  box.innerHTML='<div class="report-card"><div class="empty">Calculando relatório do espetáculo…</div></div>';
  const r = await getShowReport(show);
  reportCache[showId] = {at:Date.now(), data:r};
  if(!document.getElementById('showReportArea') || currentShowId!==showId) return;
  renderShowReportHtml(box, show, r);
}
function renderShowReportHtml(box, show, r){
  const missingLabel = r.allEnded ? 'Não compareceram' : 'Ainda sem check-in';
  box.innerHTML = `<div class="report-card">
    <div class="report-head"><div><h3>Relatório — ${escapeHtml(show.name)}</h3><div class="report-sub">Consolidado de ${r.sessions} sessão(ões) · atualizado com as vendas salvas no Firebase</div></div></div>
    <div class="report-grid">
      <div class="report-stat"><span class="label">Lugares</span><span class="value">${r.totalPlaces}</span></div>
      <div class="report-stat"><span class="label">Vendidos</span><span class="value">${r.sold}</span></div>
      <div class="report-stat"><span class="label">Convidados</span><span class="value">${r.convidados}</span></div>
      <div class="report-stat"><span class="label">Ocupação</span><span class="value">${r.occupancy.toFixed(1).replace('.',',')}%</span></div>
      <div class="report-stat money"><span class="label">Faturamento</span><span class="value">${moneyBRL(r.revenue)}</span></div>
      <div class="report-stat"><span class="label">Check-ins</span><span class="value">${r.checked}</span></div>
      <div class="report-stat"><span class="label">${missingLabel}</span><span class="value">${r.missing}</span></div>
    </div>
    <div class="report-progress">
      <div class="occupancy-head"><span>Ocupação geral do espetáculo</span><strong>${r.totalIngressos} / ${r.totalPlaces} vendíveis</strong></div>
      <div class="occupancy-track"><div class="occupancy-fill" style="width:${Math.min(100,r.occupancy).toFixed(2)}%"></div></div>
    </div>
  </div>`;
}

let priceSelectedSeats = new Set();
function renderPriceMap(){
  let html = '<div class="seatmap price-map stair-seatmap">';
  const maxLeft=Math.max(...ROOM_LAYOUT.map(x=>x.left));
  const maxCenter=Math.max(...ROOM_LAYOUT.map(x=>x.center));
  const numberMap = computeSeatNumberMap().map;
  for(let r=0;r<ROOM_LAYOUT.length;r++){ const layout=roomRow(r); html += `<div class="seat-row stair-row"><div class="row-label">${layout.row}</div>`; for(let i=0;i<maxLeft-layout.left;i++) html+='<div class="seat stair-empty"></div>'; const centerGap=maxCenter-layout.center; const centerPadLeft=Math.floor(centerGap/2), centerPadRight=Math.ceil(centerGap/2); for(let n=1;n<=rowWidth(r);n++){
      const id = layout.row+n;
      const price = (CONFIG.prices && CONFIG.prices[id]!=null) ? CONFIG.prices[id] : null;
      const sel = priceSelectedSeats.has(id) ? 'selected' : '';
      const noPrice = price==null ? 'no-price' : '';
      const num = numberMap[id];
      html += `<div class="seat price-seat ${sel} ${noPrice}" data-price-seat="${id}" title="${id}${num!=null?(' — Nº '+num):''}">${price!=null ? Math.round(price) : ''}</div>`;
      if(n === layout.left){ html += '<div class="seat aisle-gap"></div>'; for(let i=0;i<centerPadLeft;i++) html+='<div class="seat stair-empty"></div>'; }
      if(n === layout.left + layout.center){ for(let i=0;i<centerPadRight;i++) html+='<div class="seat stair-empty"></div>'; html += '<div class="seat aisle-gap"></div>'; }
    }
    html += `</div>`;
  }
  html += '</div>';
  return html;
}
function attachPriceMapHandlers(){
  document.querySelectorAll('.price-seat').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.dataset.priceSeat;
      if(priceSelectedSeats.has(id)){ priceSelectedSeats.delete(id); el.classList.remove('selected'); }
      else { priceSelectedSeats.add(id); el.classList.add('selected'); }
      updatePriceSelCount();
    });
  });
}
function updatePriceSelCount(){
  const el = document.getElementById('priceSelCount');
  if(el) el.textContent = priceSelectedSeats.size + ' assento(s) selecionado(s)';
}

function formatDateBR(dateStr){
  if(!dateStr) return '';
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : dateStr;
}
function sessionLabel(session){
  const parts = [];
  if(session.date) parts.push(formatDateBR(session.date));
  if(session.time) parts.push(session.time);
  return parts.length ? parts.join(' · ') : 'Sessão sem data definida';
}

function fitSeatmap(container){
  const map = container.querySelector('.seatmap');
  if(!map) return;
  map.style.zoom = '1';
  const firstRow = map.querySelector('.seat-row');
  if(!firstRow) return;
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      const natural = firstRow.scrollWidth;
      const available = map.clientWidth;
      if(natural > available && available > 0){
        const ratio = Math.max(0.4, (available - 4) / natural);
        map.style.zoom = ratio;
      } else {
        map.style.zoom = '1';
      }
    });
  });
}
let resizeTimer = null;
window.addEventListener('resize', ()=>{
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(()=>{
    const mapArea = document.getElementById('mapArea');
    if(mapArea) fitSeatmap(mapArea);
  }, 150);
});

function showSessionSelector(){
  const show = CONFIG.shows.find(s=>s.id===currentShowId);
  let html = '<div class="row" style="margin-bottom:4px;">';
  html += `<div class="field"><label>Espetáculo</label><select id="selShow">`;
  CONFIG.shows.forEach(s=>{
    html += `<option value="${s.id}" ${s.id===currentShowId?'selected':''}>${escapeHtml(s.name)}</option>`;
  });
  html += `</select></div>`;
  html += `<div class="field"><label>Sessão</label><select id="selSession">`;
  if(show && show.sessions && show.sessions.length){
    show.sessions.forEach(se=>{
      html += `<option value="${se.id}" ${se.id===currentSessionId?'selected':''}>${escapeHtml(sessionLabel(se))}</option>`;
    });
  } else {
    html += `<option value="">Nenhuma sessão cadastrada</option>`;
  }
  html += `</select></div></div>`;
  return html;
}

/* ---------- Painel de Controle ---------- */
async function renderPainel(){
  if(!currentUser){ renderLoginScreen(); return; }
  const content = document.getElementById('content');
  content.innerHTML = `<div class="panel">
    <h2>Painel de Controle — venda por atendente</h2>
    ${showSessionSelector()}
    <div class="row" style="margin-top:8px;">
      <button class="btn ghost tiny" id="btnImprimirLote" type="button">🖨️ Imprimir ingressos vendidos/convidados desta sessão</button>
      <button class="btn ghost tiny" id="btnEnviarLote" type="button">📧 Enviar e-mails pendentes desta sessão</button>
      <button class="btn ghost tiny" id="btnListaEspera" type="button">📋 Lista de espera</button>
      <button class="btn ${selectionMode?'gold':'ghost'} tiny" id="btnToggleSelection" type="button">☑️ ${selectionMode ? 'Sair da seleção múltipla' : 'Selecionar vários assentos'}</button>
    </div>
    <div id="sendLoteProgress"></div>
    <div id="selectionToolbar"></div>
    <div id="sessionOverviewArea"></div>
    <div class="search-box" style="margin-top:14px;">
      <input id="buscaComprador" placeholder="Buscar por nome do comprador nesta sessão…" />
      <button class="btn ghost tiny" id="btnBuscar">Buscar</button>
    </div>
    <div id="foundResults"></div>
    <div id="mapArea"><div class="empty">Carregando…</div></div>
    <div id="summaryArea"></div>
    <div id="showReportArea"></div>
  </div>`;

  document.getElementById('selShow').addEventListener('change', e=>{
    currentShowId = e.target.value; syncCurrentSession(); selectedSeats.clear(); renderPainel();
  });
  document.getElementById('selSession').addEventListener('change', e=>{
    currentSessionId = e.target.value || null; selectedSeats.clear(); renderPainel();
  });
  document.getElementById('btnImprimirLote').addEventListener('click', ()=>{
    if(!currentSessionId){ showToast('Selecione uma sessão primeiro'); return; }
    printAllTickets(currentSessionId);
  });
  document.getElementById('btnEnviarLote').addEventListener('click', ()=>{
    if(!currentSessionId){ showToast('Selecione uma sessão primeiro'); return; }
    sendPendingEmailsForSession(currentSessionId);
  });
  document.getElementById('btnListaEspera').addEventListener('click', ()=>{
    if(!currentSessionId){ showToast('Selecione uma sessão primeiro'); return; }
    openWaitlistModal(currentSessionId);
  });
  document.getElementById('btnToggleSelection').addEventListener('click', ()=>{
    selectionMode = !selectionMode;
    if(!selectionMode) selectedSeats.clear();
    renderPainel();
  });
  document.getElementById('btnBuscar').addEventListener('click', doSearch);
  document.getElementById('buscaComprador').addEventListener('keydown', e=>{ if(e.key==='Enter') doSearch(); });
  renderSelectionToolbar();

  if(!currentSessionId){
    detachLiveSeats();
    document.getElementById('mapArea').innerHTML = '<div class="empty">Cadastre uma sessão em "Configurações" para começar a vender.</div>';
    return;
  }

  attachLiveSeats(currentSessionId, (seats)=>{
    if(currentTab!=='painel') return;
    const mapArea = document.getElementById('mapArea');
    if(!mapArea) return;
    const foundNow = findShowAndSession(currentSessionId);
    const overview = document.getElementById('sessionOverviewArea');
    if(overview) overview.innerHTML = renderSessionOverview(seats, foundNow);
    mapArea.innerHTML = renderSeatMap(seats, false);
    fitSeatmap(mapArea);
    const sum = computeSummary(seats);
    document.getElementById('summaryArea').innerHTML = `<div class="summary">
      <div class="stat"><b>${sum.livre}</b><span>Livres</span></div>
      <div class="stat"><b>${sum.vendido}</b><span>Vendidos</span></div>
      <div class="stat"><b>${sum.convidado}</b><span>Convidados · sem faturamento</span></div>
      <div class="stat"><b>${sum.indisponivel}</b><span>Indisponíveis</span></div>
      <div class="stat"><b>${sum.alunos}</b><span>Alunos · sem ingresso</span></div>
    </div>`;
    if(!reportCache[currentShowId]) renderShowReport(currentShowId);
    else {
      clearTimeout(reportRefreshTimer);
      reportRefreshTimer = setTimeout(()=>{ reportCache[currentShowId]=null; renderShowReport(currentShowId); }, 450);
    }
    document.querySelectorAll('#mapArea .seat[data-seat]').forEach(el=>{
      const id = el.dataset.seat;
      if(selectionMode && selectedSeats.has(id)) el.classList.add('selected');
      el.addEventListener('click', ()=>{
        if(selectionMode){
          if(selectedSeats.has(id)){ selectedSeats.delete(id); el.classList.remove('selected'); }
          else { selectedSeats.add(id); el.classList.add('selected'); }
          renderSelectionToolbar();
        } else {
          openSeatModal(id);
        }
      });
    });
  });
}

function renderSelectionToolbar(){
  const box = document.getElementById('selectionToolbar');
  if(!box) return;
  if(!selectionMode){ box.innerHTML = ''; return; }
  box.innerHTML = `<div class="sel-toolbar">
    <span>${selectedSeats.size} assento(s) selecionado(s)</span>
    <button class="btn gold tiny" id="btnBulkStatus" type="button" ${selectedSeats.size?'':'disabled'}>Alterar status</button>
    <button class="btn ghost tiny" id="btnBulkImprimir" type="button" ${selectedSeats.size?'':'disabled'}>🖨️ Imprimir selecionados (vendidos/convidados)</button>
    <button class="btn ghost tiny" id="btnBulkLimpar" type="button">Limpar seleção</button>
  </div>`;
  const btnStatus = document.getElementById('btnBulkStatus');
  if(btnStatus) btnStatus.addEventListener('click', openBulkStatusModal);
  const btnImprimir = document.getElementById('btnBulkImprimir');
  if(btnImprimir) btnImprimir.addEventListener('click', ()=>{
    printSelectedTickets(currentSessionId, Array.from(selectedSeats));
  });
  const btnLimpar = document.getElementById('btnBulkLimpar');
  if(btnLimpar) btnLimpar.addEventListener('click', ()=>{
    selectedSeats.clear();
    renderPainel();
  });
}

function openBulkStatusModal(){
  if(!selectedSeats.size) return;
  const ids = Array.from(selectedSeats).sort();
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal">
    <h3>Alterar ${ids.length} assentos</h3>
    <div class="sub">Assentos: ${ids.join(', ')}</div>
    <div class="status-choices" style="margin-top:14px;">
      <label><input type="radio" name="bulkSt" value="livre" checked><span>Livre</span></label>
      <label><input type="radio" name="bulkSt" value="vendido"><span>Vendido</span></label>
      <label><input type="radio" name="bulkSt" value="indisponivel"><span>Indisponível</span></label>
      <label><input type="radio" name="bulkSt" value="aluno"><span>Aluno</span></label>
      <label><input type="radio" name="bulkSt" value="convidado"><span>Convidado</span></label>
    </div>
    <div id="bulkBuyerFields" style="display:none;">
      <p class="note" style="margin-top:-2px;">Os mesmos dados serão aplicados a todos os ingressos selecionados.</p>
      <div class="field"><label>Nome do comprador</label><input id="bsNome" placeholder="Ex: Maria Silva"/></div>
      <div class="field"><label>Telefone</label><input id="bsTel" placeholder="(00) 00000-0000"/></div>
      <div class="field"><label>E-mail</label><input id="bsEmail" type="email" placeholder="nome@exemplo.com"/></div>
      <div class="field"><label>Observação</label><textarea id="bsObs" rows="2" placeholder="Opcional"></textarea></div>
    </div>
    <p class="note" id="bulkStatusNote">Livre afeta somente a sessão selecionada. Indisponível é global e será aplicado a todos os espetáculos e sessões.</p>
    <div class="modal-actions" style="justify-content:flex-end;">
      <button class="btn ghost" id="bsCancelar">Cancelar</button>
      <button class="btn gold" id="bsSalvar">Aplicar</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const buyerFields = overlay.querySelector('#bulkBuyerFields');
  const note = overlay.querySelector('#bulkStatusNote');
  overlay.querySelectorAll('input[name="bulkSt"]').forEach(r=>r.addEventListener('change', ()=>{
    buyerFields.style.display = r.checked && (r.value==='vendido' || r.value==='convidado') ? 'block' : 'none';
    const st = overlay.querySelector('input[name="bulkSt"]:checked').value;
    note.textContent = st==='indisponivel'
      ? 'Indisponível é global: essas cadeiras ficarão indisponíveis em todos os espetáculos e sessões (e saem da numeração).'
      : st==='aluno'
        ? 'Aluno vale para esta sessão, não gera ingresso nem check-in, e sai da numeração das cadeiras.'
        : st==='convidado'
          ? 'Convidado ocupa a cadeira e pode receber ingresso/check-in igual ao Vendido, mas não entra no faturamento.'
          : 'Este status será aplicado à sessão selecionada.';
  }));
  overlay.querySelector('#bsCancelar').addEventListener('click', ()=>overlay.remove());
  overlay.addEventListener('click', e=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#bsSalvar').addEventListener('click', async ()=>{
    const status = overlay.querySelector('input[name="bulkSt"]:checked').value;
    const nome = overlay.querySelector('#bsNome')?.value.trim() || '';
    const telefone = overlay.querySelector('#bsTel')?.value.trim() || '';
    const email = overlay.querySelector('#bsEmail')?.value.trim() || '';
    const obs = overlay.querySelector('#bsObs')?.value.trim() || '';
    const btn = overlay.querySelector('#bsSalvar');
    btn.disabled = true;
    const now = Date.now();
    const by = currentUser ? currentUser.email : '?';
    // Grava assento por assento (em vez de um único update() multi-caminho na raiz do banco), para
    // não depender de uma regra de segurança específica pra escrita combinada — e, se algo falhar,
    // mostra o erro real do Firebase em vez de uma mensagem genérica.
    try{
      await Promise.all(ids.map(async (id)=>{
        if(status === 'indisponivel'){
          await setGlobalUnavailable(id, true);
          await logHistory(currentSessionId, id, { status:'indisponivel', nome:'', at: now, by });
          return;
        }
        if(isGlobalUnavailable(id)){
          await setGlobalUnavailable(id, false);
        }
        const existing = (SEATS_CACHE[currentSessionId] && SEATS_CACHE[currentSessionId][id]) || {};
        const extraFields = existing.extra ? { extra:true, extraNumber:existing.extraNumber } : {};
        let data = null;
        if(status==='vendido' || status==='convidado') data = Object.assign({status,nome,telefone,email,obs}, extraFields);
        else if(status==='aluno') data = Object.assign({status:'aluno',nome:'',telefone:'',email:'',obs:''}, extraFields);
        else if(existing.extra || status!==defaultStatusFor(id)) data = Object.assign({status:'livre',nome:'',telefone:'',email:'',obs:''}, extraFields);
        if(data===null){
          await db.ref('seats/'+currentSessionId+'/'+id).remove();
          if(SEATS_CACHE[currentSessionId]) delete SEATS_CACHE[currentSessionId][id];
        } else {
          await db.ref('seats/'+currentSessionId+'/'+id).set(data);
          SEATS_CACHE[currentSessionId] = SEATS_CACHE[currentSessionId] || {};
          SEATS_CACHE[currentSessionId][id] = data;
        }
        await logHistory(currentSessionId, id, { status, nome: (status==='vendido'||status==='convidado')?nome:'', at: now, by });
      }));
      reportCache = {};
      overlay.remove();
      selectedSeats.clear();
      showToast(ids.length + ' assento(s) atualizados');
      renderPainel();
    }catch(e){
      console.error('Erro ao aplicar status em lote:', e);
      btn.disabled = false;
      const msg = e && e.message ? e.message : String(e);
      showToast('Erro ao atualizar os assentos: ' + msg);
    }
  });
}

async function openWaitlistModal(sessionId){
  const found = findShowAndSession(sessionId);
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal" style="max-width:420px;">
    <h3>Lista de espera</h3>
    <div class="sub">${found ? escapeHtml(found.show.name)+' — '+escapeHtml(sessionLabel(found.session)) : ''}</div>
    <p class="note" style="margin-top:-8px;">Cada aluno tem direito a 4 ingressos. Se pedir mais, anote aqui quantos a mais ela quer, caso sobre.</p>
    <div class="field"><label>Nome</label><input id="weNome" placeholder="Nome do aluno/responsável"/></div>
    <div class="field"><label>Telefone</label><input id="weTel" placeholder="(00) 00000-0000"/></div>
    <div class="field"><label>Quantos ingressos a mais quer</label><input id="weQtd" type="number" min="1" value="1"/></div>
    <div class="field"><label>Observação</label><input id="weObs" placeholder="Opcional"/></div>
    <button class="btn gold" id="btnAddWaitlist" style="width:100%; margin-bottom:16px;">+ Adicionar à lista</button>
    <div id="waitlistItems"><div class="empty">Carregando…</div></div>
    <div class="modal-actions" style="justify-content:flex-end;">
      <button class="btn ghost" id="btnFecharWaitlist">Fechar</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#btnFecharWaitlist').addEventListener('click', ()=> overlay.remove());
  overlay.addEventListener('click', e=>{ if(e.target===overlay) overlay.remove(); });

  const itemsBox = overlay.querySelector('#waitlistItems');
  async function refreshWaitlist(){
    itemsBox.innerHTML = '<div class="empty">Carregando…</div>';
    try{
      const snap = await db.ref('waitlist/'+sessionId).once('value');
      const val = snap.val() || {};
      const entries = Object.entries(val).sort((a,b)=> (a[1].at||0) - (b[1].at||0));
      if(!entries.length){
        itemsBox.innerHTML = '<div class="empty">Ninguém na lista de espera ainda.</div>';
        return;
      }
      itemsBox.innerHTML = '<div class="found-list">' + entries.map(([key, e])=>
        `<div class="found-item"><span><b>${escapeHtml(e.nome)}</b>${e.telefone?(' · '+escapeHtml(e.telefone)):''} — quer +${e.quantidade} ${e.obs?('· '+escapeHtml(e.obs)):''}</span><button class="btn danger tiny" data-remove-wait="${key}">Remover</button></div>`
      ).join('') + '</div>';
      itemsBox.querySelectorAll('[data-remove-wait]').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          btn.disabled = true;
          try{
            await db.ref('waitlist/'+sessionId+'/'+btn.dataset.removeWait).remove();
            refreshWaitlist();
          }catch(e){
            console.error('Erro ao remover da lista de espera:', e);
            btn.disabled = false;
            showToast('Erro ao remover: ' + (e && e.message ? e.message : e));
          }
        });
      });
    }catch(e){
      console.error('Erro ao carregar a lista de espera:', e);
      const msg = e && e.message ? e.message : String(e);
      itemsBox.innerHTML = `<div class="empty">Erro ao carregar a lista de espera: ${escapeHtml(msg)}${msg.toLowerCase().includes('permission')?'<br/><br/>Isso costuma acontecer quando as regras de segurança do Firebase Realtime Database não liberam leitura/escrita no nó "waitlist" (talvez ele tenha sido criado depois das regras). Confira as regras no console do Firebase e garanta que o nó "waitlist" tenha as mesmas permissões de "seats"/"history" (leitura e escrita para usuários autenticados).':''}</div>`;
    }
  }
  refreshWaitlist();

  overlay.querySelector('#btnAddWaitlist').addEventListener('click', async ()=>{
    const nome = overlay.querySelector('#weNome').value.trim();
    const telefone = overlay.querySelector('#weTel').value.trim();
    const quantidade = Math.max(1, parseInt(overlay.querySelector('#weQtd').value)||1);
    const obs = overlay.querySelector('#weObs').value.trim();
    if(!nome){ showToast('Preencha o nome'); return; }
    const btnAdd = overlay.querySelector('#btnAddWaitlist');
    btnAdd.disabled = true;
    try{
      await db.ref('waitlist/'+sessionId).push({ nome, telefone, quantidade, obs, at: Date.now(), by: currentUser?currentUser.email:'?' });
      overlay.querySelector('#weNome').value = '';
      overlay.querySelector('#weTel').value = '';
      overlay.querySelector('#weQtd').value = '1';
      overlay.querySelector('#weObs').value = '';
      refreshWaitlist();
      showToast('Adicionado à lista de espera');
    }catch(e){
      console.error('Erro ao adicionar na lista de espera:', e);
      showToast('Erro ao adicionar: ' + (e && e.message ? e.message : e));
    }finally{
      btnAdd.disabled = false;
    }
  });
}

async function doSearch(){
  const term = document.getElementById('buscaComprador').value.trim().toLowerCase();
  const seats = SEATS_CACHE[currentSessionId] || {};
  const box = document.getElementById('foundResults');
  if(!term){ box.innerHTML=''; return; }
  const results = Object.entries(seats).filter(([id,d]) => d.nome && d.nome.toLowerCase().includes(term));
  if(!results.length){ box.innerHTML = '<div class="empty">Nenhum comprador encontrado nesta sessão.</div>'; return; }
  const numberMap = computeSeatNumberMap(seats).map;
  box.innerHTML = '<div class="found-list">' + results.map(([id,d])=>
    `<div class="found-item"><span>Assento <b>${escapeHtml(seatDisplayLabel(id, numberMap))}</b> — ${escapeHtml(d.nome)} ${d.telefone?('· '+escapeHtml(d.telefone)):''}</span><span class="badge ${d.status}">${statusLabel(d.status)}</span></div>`
  ).join('') + '</div>';
}

async function openSeatModal(seatId){
  const seats = SEATS_CACHE[currentSessionId] || {};
  const localData = seats[seatId] || { status: defaultStatusFor(seatId), nome:'', telefone:'', email:'', obs:'' };
  const data = Object.assign({}, localData, {status: effectiveSeatStatus(seats, seatId)});
  const show = CONFIG.shows.find(s=>s.id===currentShowId) || {sessions:[]};
  const session = show.sessions.find(se=>se.id===currentSessionId) || {};
  const price = (CONFIG.prices && CONFIG.prices[seatId]!=null) ? CONFIG.prices[seatId] : null;
  const displayLabel = seatDisplayLabel(seatId);
  const group = data.email ? findEmailGroup(seats, data.email) : [];
  const groupAlreadySent = group.length>0 && group.every(([,d])=>d.emailSent);
  const emailBtnLabel = groupAlreadySent
    ? (group.length>1 ? `🔁 Reenviar e-mail (${group.length} ingressos)` : '🔁 Reenviar e-mail')
    : (group.length>1 ? `✉️ Enviar e-mail (${group.length} ingressos deste comprador)` : '✉️ Enviar por e-mail');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal">
    <h3>Assento ${escapeHtml(displayLabel)}</h3>
    <p class="note" style="margin:-8px 0 6px;">Código interno: ${escapeHtml(seatId)}</p>
    <div class="sub">${escapeHtml(show.name||'')} — ${escapeHtml(sessionLabel(session))}</div>
    <div class="price-tag">${price!=null ? '💰 Valor deste assento: R$ '+price.toFixed(2).replace('.',',') : '⚠️ Preço não definido para o assento '+seatId+' (defina em Configurações)'}</div>
    ${defaultStatusFor(seatId)==='aluno' ? (
      data.extra
        ? `<div class="note" style="background:#f7f3f5;border:1px solid #ece4e8;border-radius:9px;padding:8px 10px;margin-bottom:10px;">🎫 Cadeira extra — número fixo <b>Nº ${data.extraNumber}</b>. Vender ou mudar o status dela não muda esse número.<br/><button class="btn ghost tiny" id="btnUnmarkExtra" type="button" style="margin-top:6px;">↩️ Desfazer cadeira extra (volta a ser reservada pra aluno)</button></div>`
        : `<div class="note" style="background:#f7f3f5;border:1px solid #ece4e8;border-radius:9px;padding:8px 10px;margin-bottom:10px;">Esta cadeira é reservada para alunos por padrão.<br/><button class="btn gold tiny" id="btnMarkExtra" type="button" style="margin-top:6px;">🎫 Vender como cadeira extra</button></div>`
    ) : ''}
    <div class="status-choices">
      <label><input type="radio" name="st" value="livre" ${data.status==='livre'?'checked':''}><span>Livre</span></label>
      <label><input type="radio" name="st" value="vendido" ${data.status==='vendido'?'checked':''}><span>Vendido</span></label>
      <label><input type="radio" name="st" value="convidado" ${data.status==='convidado'?'checked':''}><span>Convidado</span></label>
      <label><input type="radio" name="st" value="indisponivel" ${data.status==='indisponivel'?'checked':''}><span>Indisponível</span></label>
      <label><input type="radio" name="st" value="aluno" ${data.status==='aluno'?'checked':''}><span>Aluno</span></label>
    </div>
    <div class="field"><label>Nome do comprador</label><input id="fNome" value="${escapeHtml(data.nome)}" placeholder="Ex: Maria Silva"/></div>
    <div class="field"><label>Telefone</label><input id="fTel" value="${escapeHtml(data.telefone)}" placeholder="(00) 00000-0000"/></div>
    <div class="field"><label>E-mail (para enviar o ingresso)</label><input id="fEmail" type="email" value="${escapeHtml(data.email||'')}" placeholder="nome@exemplo.com"/></div>
    <div class="field"><label>Observação</label><textarea id="fObs" rows="2" placeholder="Combinado, forma de pagamento, etc.">${escapeHtml(data.obs)}</textarea></div>
    <button class="btn ghost tiny" id="btnHistorico" type="button" style="margin-bottom:12px;">📜 Ver histórico deste assento</button>
    <div id="historicoBox" style="display:none; margin-bottom:12px;"></div>
    ${(data.status==='vendido'||data.status==='convidado') ? `<div class="ticket-actions">
      <button class="btn ghost tiny" id="btnImprimir" type="button">🖨️ Imprimir ingresso</button>
      <button class="btn ghost tiny" id="btnEnviarEmail" type="button" ${data.email?'':'disabled title="Preencha e salve o e-mail primeiro"'}>${emailBtnLabel}</button>
    </div>
    ${group.length>1 ? `<p class="note" style="margin-top:-6px;">Este comprador também tem os assentos ${escapeHtml(group.filter(([id])=>id!==seatId).map(([id])=>seatDisplayLabel(id)).join(', '))} nesta sessão — o botão acima manda tudo junto, num único e-mail.</p>` : ''}
    ${groupAlreadySent ? `<p class="note" style="margin-top:-6px;">✅ E-mail já foi enviado para este comprador nesta sessão.</p>` : ''}
    <div class="checkin-box ${data.checkin?'in':''}">
      ${data.checkin ? `✅ Entrada confirmada às ${new Date(data.checkinAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}` : '⏳ Ainda não deu entrada na sala'}
      <button class="btn ghost tiny" id="btnToggleCheckin" type="button">${data.checkin ? 'Desfazer entrada' : 'Marcar entrada manualmente'}</button>
    </div>` : ''}
    <div class="modal-actions">
      <button class="btn danger tiny" id="btnLimpar">Liberar assento</button>
      <div style="display:flex; gap:8px;">
        <button class="btn ghost" id="btnCancelar">Cancelar</button>
        <button class="btn gold" id="btnSalvar">Salvar</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#btnCancelar').addEventListener('click', ()=> overlay.remove());
  overlay.addEventListener('click', e=>{ if(e.target===overlay) overlay.remove(); });
  const btnMarkExtra = overlay.querySelector('#btnMarkExtra');
  if(btnMarkExtra){
    btnMarkExtra.addEventListener('click', async ()=>{
      btnMarkExtra.disabled = true;
      try{
        const num = await markSeatAsExtra(currentSessionId, seatId);
        showToast('Cadeira liberada como extra — Nº ' + num);
        overlay.remove();
        openSeatModal(seatId);
      }catch(e){
        console.error(e);
        showToast('Erro ao liberar cadeira extra: ' + (e && e.message ? e.message : e));
        btnMarkExtra.disabled = false;
      }
    });
  }
  const btnUnmarkExtra = overlay.querySelector('#btnUnmarkExtra');
  if(btnUnmarkExtra){
    btnUnmarkExtra.addEventListener('click', async ()=>{
      if(!confirm('Desfazer esta cadeira extra? Ela volta a ser reservada para aluno e o número Nº '+data.extraNumber+' deixa de existir.')) return;
      btnUnmarkExtra.disabled = true;
      try{
        await unmarkSeatAsExtra(currentSessionId, seatId);
        showToast('Cadeira voltou a ser reservada para aluno');
        overlay.remove();
        openSeatModal(seatId);
      }catch(e){
        console.error(e);
        showToast('Erro ao desfazer: ' + (e && e.message ? e.message : e));
        btnUnmarkExtra.disabled = false;
      }
    });
  }
  overlay.querySelector('#btnLimpar').addEventListener('click', async ()=>{
    await saveSeat(currentSessionId, seatId, null);
    overlay.remove();
    showToast('Assento liberado');
  });
  overlay.querySelector('#btnSalvar').addEventListener('click', async ()=>{
    const status = overlay.querySelector('input[name="st"]:checked').value;
    const nome = overlay.querySelector('#fNome').value.trim();
    const telefone = overlay.querySelector('#fTel').value.trim();
    const email = overlay.querySelector('#fEmail').value.trim();
    const obs = overlay.querySelector('#fObs').value.trim();
    // Se esta é uma cadeira "extra", o número fixo dela (extra/extraNumber) tem que sobreviver ao
    // salvar — senão, vender ou mudar o status dela apagaria a marcação e embaralharia a numeração.
    const extraFields = data.extra ? { extra:true, extraNumber:data.extraNumber } : {};
    if(!data.extra && status === defaultStatusFor(seatId)){
      await saveSeat(currentSessionId, seatId, null);
    } else {
      await saveSeat(currentSessionId, seatId, Object.assign({ status, nome, telefone, email, obs }, extraFields));
    }
    overlay.remove();
    showToast('Assento atualizado');
  });
  const btnImprimir = overlay.querySelector('#btnImprimir');
  if(btnImprimir){
    btnImprimir.addEventListener('click', ()=>{
      printTicket({ seatId, show, session, nome: data.nome, status: data.status });
    });
  }
  const btnEnviar = overlay.querySelector('#btnEnviarEmail');
  if(btnEnviar){
    btnEnviar.addEventListener('click', async ()=>{
      btnEnviar.disabled = true;
      const ok = await sendTicketEmail({ seatId, show, session, nome: data.nome, email: data.email, status: data.status });
      if(ok) overlay.remove(); else btnEnviar.disabled = false;
    });
  }
  const btnCheckin = overlay.querySelector('#btnToggleCheckin');
  if(btnCheckin){
    btnCheckin.addEventListener('click', async ()=>{
      const updated = Object.assign({}, data, data.checkin ? {checkin:false, checkinAt:null} : {checkin:true, checkinAt:Date.now()});
      await saveSeat(currentSessionId, seatId, updated);
      overlay.remove();
      showToast(updated.checkin ? 'Entrada marcada' : 'Entrada desfeita');
    });
  }
  overlay.querySelector('#btnHistorico').addEventListener('click', async ()=>{
    const box = overlay.querySelector('#historicoBox');
    if(box.style.display === 'none'){
      box.style.display = 'block';
      box.innerHTML = '<div class="empty">Carregando…</div>';
      try{
        const snap = await db.ref('history/'+currentSessionId+'/'+seatId).limitToLast(20).once('value');
        const val = snap.val() || {};
        const entries = Object.values(val).sort((a,b)=> b.at - a.at);
        if(!entries.length){
          box.innerHTML = '<div class="empty">Sem histórico ainda para este assento.</div>';
        } else {
          box.innerHTML = '<div class="found-list">' + entries.map(e=>{
            const when = new Date(e.at).toLocaleString('pt-BR');
            return `<div class="found-item"><span>${when} — ${escapeHtml(e.by||'?')}${e.nome?(' · '+escapeHtml(e.nome)):''}</span><span class="badge ${e.status}">${statusLabel(e.status)}</span></div>`;
          }).join('') + '</div>';
        }
      }catch(err){
        box.innerHTML = '<div class="empty">Erro ao carregar histórico.</div>';
      }
    } else {
      box.style.display = 'none';
    }
  });
}

/* ---------- Ingresso (imprimir / e-mail) ---------- */
function ticketCode(sessionId, seatId){
  return sessionId+'-'+seatId;
}
function findShowAndSession(sessionId){
  for(const show of CONFIG.shows){
    const session = (show.sessions||[]).find(se=>se.id===sessionId);
    if(session) return {show, session};
  }
  return null;
}
const BLANK_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
// QR Code gerado 100% no navegador (biblioteca qrcode-generator — síncrona, sem dependências, sem
// precisar de internet no dia do evento). Usado no ingresso impresso/na tela e na base do PDF.
function qrGifDataUrl(text){
  try{
    const qr = qrcode(0, 'M'); // 0 = detecta o tamanho automaticamente; M = correção de erro média
    qr.addData(text);
    qr.make();
    return qr.createDataURL(8, 4); // tamanho de cada módulo em px, margem em módulos
  }catch(e){
    console.error('Erro ao gerar QR Code:', e);
    return BLANK_PIXEL_PNG;
  }
}
// Versão em PNG do QR (o jsPDF lida melhor com PNG do que com o GIF que a lib gera por padrão) —
// usada só na hora de colar o QR de verdade dentro do PDF.
function qrPngDataUrl(text){
  return new Promise(resolve=>{
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 200;
      canvas.height = img.naturalHeight || 200;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(BLANK_PIXEL_PNG);
    img.src = qrGifDataUrl(text);
  });
}
function buildTicketHtml({seatId, show, session, nome, status}){
  const code = ticketCode(session.id, seatId);
  const displayLabel = seatDisplayLabel(seatId);
  const qr = qrGifDataUrl('STUDIOA|'+code);
  const lname = (show.name||'').toLowerCase();
  const theme = lname.includes('frozen') ? 'theme-frozen' : lname.includes('wicked') ? 'theme-wicked' : (lname.includes('show') || lname.includes('rei')) ? 'theme-showman' : '';
  const heroBg = show.backgroundImage ? `style="--ticket-bg:url('${show.backgroundImage.replace(/'/g,"\\'")}')"` : '';
  const heroClass = show.backgroundImage ? 'ticket-hero has-bg' : 'ticket-hero';
  const dateText = session.date ? new Date(session.date+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'}) : 'Data a confirmar';
  const timeText = session.time || '--:--';
  return `
    <div class="ticket ${theme}">
      <div class="${heroClass}" ${heroBg}>
        <div class="ticket-brandline">
          <img class="ticket-logo" src="${document.querySelector('.brand img').src}" alt="Studio A"/>
          <span class="ticket-brandname">Studio A · Bilheteria</span>
        </div>
        <p class="ticket-show">${escapeHtml(show.name||'Espetáculo')}</p>
      </div>
      <div class="ticket-body">
        <table class="ticket-info-grid"><tbody>
          <tr>
            <td class="ticket-info"><small>Data</small><strong>${dateText}</strong></td>
            <td class="ticket-info"><small>Horário</small><strong>${escapeHtml(timeText)}</strong></td>
          </tr>
          <tr>
            <td class="ticket-info" colspan="2"><small>Sessão</small><strong>${escapeHtml(sessionLabel(session))}</strong></td>
          </tr>
        </tbody></table>
        <div class="ticket-seat-box"><small>Assento</small><strong>${escapeHtml(displayLabel)}</strong></div>
        <p class="ticket-person">Ingresso de <b>${escapeHtml(nome||'Visitante')}</b></p>
        <table class="ticket-bottom"><tbody><tr>
          <td class="ticket-qr-cell"><div class="ticket-qr-frame"><img class="ticket-qr" src="${qr}" alt="QR Code do ingresso"/></div></td>
          <td>
            <p class="ticket-code">${escapeHtml(code.toUpperCase())}</p>
            <span class="ticket-status">${status==='convidado' ? 'CORTESIA' : 'PAGO'}</span>
            <p class="ticket-rules">Apresente este QR Code na entrada. O ingresso é válido para uma única entrada e para a sessão indicada. Chegue com antecedência e mantenha o código legível.</p>
          </td>
        </tr></tbody></table>
      </div>
      <div class="ticket-footer"></div>
    </div>`;
}
function waitForImages(container, timeout){
  const imgs = Array.from(container.querySelectorAll('img'));
  if(!imgs.length) return Promise.resolve();
  const loaders = imgs.map(img=>{
    // decode() é mais confiável que 'load': só resolve quando o navegador já decodificou os pixels
    // e está pronto pra desenhar a imagem — 'load' às vezes dispara um instante antes disso.
    if(typeof img.decode === 'function'){
      return img.decode().catch(()=>{
        // se decode() falhar (ex: imagem quebrada), cai pro método antigo como reforço
        if(img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise(resolve=>{
          img.addEventListener('load', resolve, {once:true});
          img.addEventListener('error', resolve, {once:true});
        });
      });
    }
    if(img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise(resolve=>{
      img.addEventListener('load', resolve, {once:true});
      img.addEventListener('error', resolve, {once:true});
    });
  });
  return Promise.race([Promise.all(loaders), new Promise(r=>setTimeout(r, timeout || 2500))]);
}
// Espera dois quadros de animação — dá tempo do navegador terminar de desenhar (layout + paint)
// antes de tirar a "foto" com html2canvas. Sem isso, a captura às vezes pega o ingresso pela metade.
function waitTwoFrames(){
  return new Promise(resolve=>{
    requestAnimationFrame(()=>requestAnimationFrame(resolve));
  });
}
async function printTicket(info){
  const holder = document.getElementById('printArea');
  holder.innerHTML = buildTicketHtml(info);
  await waitForImages(holder);
  window.print();
}
// Envia (em sequência, com uma pequena pausa entre cada um) um e-mail por COMPRADOR — não por assento —
// pra quem ainda não recebeu o ingresso desta sessão. Assentos do mesmo comprador (mesmo e-mail) vão
// juntos no mesmo envio (ver sendTicketEmail/findEmailGroup), o que já reduz bastante a quantidade de
// e-mails; isso também poupa a cota mensal do plano gratuito do EmailJS (200 envios/mês).
async function sendPendingEmailsForSession(sessionId){
  const found = findShowAndSession(sessionId);
  if(!found){ showToast('Sessão não encontrada'); return; }
  const { show, session } = found;
  const seats = SEATS_CACHE[sessionId] || {};
  const pending = Object.entries(seats).filter(([id,d]) =>
    d && (d.status==='vendido' || d.status==='convidado') && d.email && d.email.trim() && !d.emailSent
  );
  if(!pending.length){ showToast('Nenhum e-mail pendente nesta sessão — todo mundo com e-mail salvo já recebeu.'); return; }

  // Agrupa por e-mail (normalizado) só pra saber quantos ENVIOS vão ser feitos (não quantos assentos).
  const byEmail = {};
  pending.forEach(([id,d])=>{
    const key = d.email.trim().toLowerCase();
    (byEmail[key] = byEmail[key] || []).push([id,d]);
  });
  const emails = Object.keys(byEmail);

  if(!confirm(`Isso vai mandar ${emails.length} e-mail(s) (cobrindo ${pending.length} assento(s) pendente(s)) — um e-mail por comprador, agrupando os assentos dele. Continuar?`)) return;

  const btn = document.getElementById('btnEnviarLote');
  const progressBox = document.getElementById('sendLoteProgress');
  if(btn) btn.disabled = true;
  let ok = 0, fail = 0;
  for(let i=0; i<emails.length; i++){
    const email = emails[i];
    const [firstId, firstData] = byEmail[email][0];
    if(progressBox) progressBox.innerHTML = `<p class="note">Enviando ${i+1} de ${emails.length}…</p>`;
    const sent = await sendTicketEmail({
      seatId: firstId, show, session, nome: firstData.nome, email: firstData.email, status: firstData.status
    });
    if(sent) ok++; else fail++;
    // pequena pausa entre envios, gentil com o rate-limit do EmailJS
    await new Promise(r=>setTimeout(r, 400));
  }
  if(btn) btn.disabled = false;
  if(progressBox) progressBox.innerHTML = '';
  showToast(`Envio em lote concluído: ${ok} enviado(s)${fail?`, ${fail} com erro`:''}.`);
  renderPainel();
}
async function printAllTickets(sessionId){
  const seats = SEATS_CACHE[sessionId] || {};
  const entries = Object.entries(seats).filter(([id,d]) => d.status==='vendido' || d.status==='convidado');
  if(!entries.length){ showToast('Nenhum ingresso vendido ou convidado nesta sessão ainda'); return; }
  entries.sort((a,b)=> a[0].localeCompare(b[0]));
  const found = findShowAndSession(sessionId);
  if(!found){ showToast('Sessão não encontrada'); return; }
  const holder = document.getElementById('printArea');
  holder.innerHTML = entries.map(([seatId, data]) =>
    buildTicketHtml({ seatId, show: found.show, session: found.session, nome: data.nome, status: data.status })
  ).join('');
  await waitForImages(holder, 4000);
  window.print();
}
async function printSelectedTickets(sessionId, ids){
  const seats = SEATS_CACHE[sessionId] || {};
  const entries = ids.map(id=>[id, seats[id]]).filter(([id,d]) => d && (d.status==='vendido' || d.status==='convidado'));
  const skipped = ids.length - entries.length;
  if(!entries.length){ showToast('Nenhum dos assentos selecionados está marcado como vendido ou convidado'); return; }
  entries.sort((a,b)=> a[0].localeCompare(b[0]));
  const found = findShowAndSession(sessionId);
  if(!found){ showToast('Sessão não encontrada'); return; }
  const holder = document.getElementById('printArea');
  holder.innerHTML = entries.map(([seatId, data]) =>
    buildTicketHtml({ seatId, show: found.show, session: found.session, nome: data.nome, status: data.status })
  ).join('');
  await waitForImages(holder, 4000);
  window.print();
  if(skipped>0) showToast(skipped + ' assento(s) ignorado(s) por não estarem vendidos');
}
/* ---------- Ingresso "estilo do site" dentro do corpo do e-mail (sem anexo, sem custo) ---------- */
// E-mails não suportam bem CSS moderno (flexbox, variáveis CSS, imagens em base64 etc.), então aqui a
// gente recria o visual do ingresso com tabelas e estilo "inline", usando só a imagem do QR Code
// hospedada (api.qrserver.com) — nada de anexo, nada de plano pago do EmailJS.
function ticketThemeColors(showName){
  const lname = (showName||'').toLowerCase();
  if(lname.includes('frozen')) return {accent:'#477ea6', soft:'#87b6d8', deep:'#183b59'};
  if(lname.includes('wicked')) return {accent:'#3b8a5b', soft:'#84bd79', deep:'#173f29'};
  if(lname.includes('show') || lname.includes('rei')) return {accent:'#9d3137', soft:'#d6a85e', deep:'#4f171c'};
  return {accent:'#e4136f', soft:'#f26fa8', deep:'#6d0936'};
}
function buildTicketEmailHtml({seatId, show, session, nome, status}){
  const code = ticketCode(session.id, seatId);
  const displayLabel = seatDisplayLabel(seatId);
  const qr = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent('STUDIOA|'+code);
  const {accent, soft, deep} = ticketThemeColors(show.name);
  const dateText = session.date ? new Date(session.date+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'}) : 'Data a confirmar';
  const timeText = session.time || '--:--';
  const statusTag = status==='convidado' ? 'CORTESIA' : 'PAGO';
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background-color:#17141a;border-radius:14px;border:1px solid #2c2530;">
  <tr><td style="background-color:${deep};background-image:linear-gradient(135deg,${deep},${accent});padding:20px 22px 16px;border-radius:14px 14px 0 0;">
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:#ffffff;text-transform:uppercase;opacity:.85;">Studio A &middot; Bilheteria</div>
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;font-weight:bold;color:#ffffff;margin-top:6px;">${escapeHtml(show.name||'Espetáculo')}</div>
  </td></tr>
  <tr><td style="padding:20px 22px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:.6px;color:#a79aa5;text-transform:uppercase;padding-bottom:4px;" width="50%">Data</td>
        <td style="font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:.6px;color:#a79aa5;text-transform:uppercase;padding-bottom:4px;" width="50%">Sess&atilde;o</td>
      </tr>
      <tr>
        <td style="font-family:Georgia,'Times New Roman',serif;font-size:15px;font-weight:bold;color:#f5eef1;padding-bottom:16px;">${dateText} &middot; ${escapeHtml(timeText)}</td>
        <td style="font-family:Georgia,'Times New Roman',serif;font-size:15px;font-weight:bold;color:#f5eef1;padding-bottom:16px;">${escapeHtml(sessionLabel(session))}</td>
      </tr>
    </table>
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:.6px;color:#a79aa5;text-transform:uppercase;">Assento</div>
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:bold;color:${accent};margin:2px 0 14px;">${escapeHtml(displayLabel)}</div>
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#f5eef1;margin-bottom:18px;">Ingresso de <b>${escapeHtml(nome||'Visitante')}</b></div>
    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr>
        <td style="width:118px;vertical-align:top;">
          <img src="${qr}" width="108" height="108" alt="QR Code do ingresso" style="display:block;border-radius:8px;border:2px solid ${accent};"/>
        </td>
        <td style="vertical-align:top;padding-left:16px;">
          <div style="font-family:'Courier New',Courier,monospace;font-size:12px;letter-spacing:.5px;color:#f5eef1;margin-bottom:8px;">${escapeHtml(code.toUpperCase())}</div>
          <span style="display:inline-block;background-color:${accent};color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;letter-spacing:.5px;padding:4px 11px;border-radius:20px;">${statusTag}</span>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#a79aa5;margin-top:10px;line-height:1.5;">Apresente este e-mail ou o QR Code acima na entrada. V&aacute;lido para uma &uacute;nica entrada, na sess&atilde;o indicada.</div>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="height:6px;background-color:${accent};background-image:linear-gradient(90deg,${deep},${accent},${soft});border-radius:0 0 14px 14px;"></td></tr>
</table>`;
}
/* ---------- Ingresso em PDF (gerado no navegador, sem servidor) ----------
   Usa o MESMO HTML/CSS do ingresso que seria impresso (fundo do espetáculo, cores do tema, layout)
   e "fotografa" ele com html2canvas, depois cola essa imagem dentro de um PDF — ou seja, o PDF fica
   com a cara exata do ingresso impresso. O QR (já gerado localmente por padrão) é colado por cima,
   direto no PDF, no lugar exato — sem depender do html2canvas pra essa parte. */
const EMAILJS_PDF_ATTACHMENT_ENABLED = false; // mude pra true se fizer upgrade do plano no EmailJS e configurar o Attachment
async function buildTicketPdfDataUrl(info){
  const { seatId, show, session, status } = info;
  const code = ticketCode(session.id, seatId);
  const qrDataUrl = await qrPngDataUrl('STUDIOA|'+code);

  const holder = document.getElementById('pdfSnapshotArea');
  holder.innerHTML = buildTicketHtml(info);
  const ticketEl = holder.querySelector('.ticket');
  const qrImg = holder.querySelector('.ticket-qr');
  await waitForImages(holder, 4000);
  await waitTwoFrames();

  // O html2canvas às vezes falha em reproduzir fielmente imagens pequenas (como o QR) — em vez de
  // arriscar, escondemos só o QR da "foto" (o espaço dele continua reservado no layout) e colamos o
  // QR de verdade depois, direto no PDF, na posição exata — o mesmo jeito confiável de antes.
  let qrRectRel = null;
  if(qrImg){
    const ticketRect = ticketEl.getBoundingClientRect();
    const qrRect = qrImg.getBoundingClientRect();
    qrRectRel = {
      x: qrRect.left - ticketRect.left,
      y: qrRect.top - ticketRect.top,
      w: qrRect.width,
      h: qrRect.height,
      ticketW: ticketRect.width
    };
    qrImg.style.visibility = 'hidden';
  }

  let canvas;
  try{
    canvas = await html2canvas(ticketEl, { backgroundColor:'#ffffff', scale:3, useCORS:true, logging:false, imageTimeout:8000 });
  } finally {
    holder.innerHTML = '';
  }

  const imgData = canvas.toDataURL('image/png');
  const { jsPDF } = window.jspdf;
  const pageW = 90; // mm — mantém a mesma proporção do ingresso na tela (largura x altura)
  const pageH = pageW * (canvas.height / canvas.width);
  const doc = new jsPDF({ orientation: pageH >= pageW ? 'portrait' : 'landscape', unit:'mm', format:[pageW, pageH] });
  doc.addImage(imgData, 'PNG', 0, 0, pageW, pageH);

  if(qrRectRel){
    const scaleMm = pageW / qrRectRel.ticketW;
    doc.addImage(qrDataUrl, 'PNG', qrRectRel.x*scaleMm, qrRectRel.y*scaleMm, qrRectRel.w*scaleMm, qrRectRel.h*scaleMm);
  }
  return doc.output('datauristring');
}
async function sendTicketEmail(info){
  if(!EMAILJS_READY){
    showToast('Configure o EmailJS primeiro (veja instruções no arquivo)');
    return false;
  }
  if(!info.email){ showToast('Este comprador não tem e-mail salvo'); return false; }
  const sid = info.session.id;
  const seats = SEATS_CACHE[sid] || {};
  const group = findEmailGroup(seats, info.email);
  // Se por algum motivo o assento atual não aparecer no grupo (ex: ainda não foi salvo), manda ele sozinho.
  const list = group.length ? group : [[info.seatId, seats[info.seatId] || {status: info.status, nome: info.nome, email: info.email, telefone:'', obs:''}]];
  try{
    const ticketBlocks = list.map(([id,d]) => buildTicketEmailHtml({
      seatId: id, show: info.show, session: info.session, nome: d.nome || info.nome, status: d.status
    }));
    const seatLabels = list.map(([id]) => seatDisplayLabel(id));
    const allConvidado = list.every(([,d])=>d.status==='convidado');
    const params = {
      to_email: info.email,
      to_name: info.nome || '',
      show_name: info.show.name || '',
      session_label: sessionLabel(info.session),
      seat_id: seatLabels.join(', '),
      ticket_code: list.length===1 ? ticketCode(sid, list[0][0]) : `${list.length} ingressos`,
      status_label: allConvidado ? 'Cortesia' : 'Pago',
      ticket_html: ticketBlocks.join('<div style="height:14px;line-height:14px;font-size:1px;">&nbsp;</div>')
    };
    if(EMAILJS_PDF_ATTACHMENT_ENABLED){
      showToast('Gerando o PDF do ingresso…');
      params.pdf_ticket = await buildTicketPdfDataUrl(info);
      params.pdf_filename = 'ingresso-' + ticketCode(sid, info.seatId).toLowerCase() + '.pdf';
    }
    await emailjs.send(emailjsConfig.serviceId, emailjsConfig.templateId, params);
    // Marca cada assento enviado, pra não reenviar por engano depois.
    const now = Date.now();
    await Promise.all(list.map(([id,d]) => {
      const updated = Object.assign({}, d, {emailSent:true, emailSentAt:now});
      SEATS_CACHE[sid] = SEATS_CACHE[sid] || {};
      SEATS_CACHE[sid][id] = updated;
      return db.ref('seats/'+sid+'/'+id).set(updated);
    }));
    showToast(list.length>1
      ? `E-mail com ${list.length} ingressos enviado para ${info.email}`
      : `E-mail com o ingresso enviado para ${info.email}`);
    return true;
  }catch(e){
    console.error(e);
    const msg = e && (e.text || e.message) ? (e.text || e.message) : 'confira a configuração do EmailJS';
    showToast('Erro ao enviar e-mail: ' + msg);
    return false;
  }
}

/* ---------- Site Público ---------- */
async function renderPublico(){
  // O site público NUNCA depende do Firebase Auth. Login só é exigido no painel/check-in/configurações.
  stopCountdown();
  const content = document.getElementById('content');
  content.innerHTML = `<div class="panel">
    <h2>Consulta de Disponibilidade</h2>
    <p class="note" style="margin:-6px 0 14px;">Escolha o espetáculo e a sessão para ver os lugares livres. Para reservar, entre em contato com a organização.</p>
    ${showSessionSelector()}
    <div id="sessionOverviewArea"></div>
    <div id="mapArea"><div class="empty">Carregando…</div></div>
    <div id="summaryArea"></div>
  </div>`;
  document.getElementById('selShow').addEventListener('change', e=>{
    currentShowId = e.target.value; syncCurrentSession(); renderPublico();
  });
  document.getElementById('selSession').addEventListener('change', e=>{
    currentSessionId = e.target.value || null; renderPublico();
  });
  if(!currentSessionId){
    detachLiveSeats();
    document.getElementById('mapArea').innerHTML = '<div class="empty">Nenhuma sessão disponível no momento.</div>';
    return;
  }
  const foundNow = findShowAndSession(currentSessionId);
  const updateCountdown = ()=>{
    const el = document.getElementById('countdownArea');
    if(!el) return;
    el.textContent = foundNow ? (formatCountdown(foundNow.session) || '') : '';
  };
  countdownTimer = setInterval(updateCountdown, 60000);
  attachLiveSeats(currentSessionId, (seats)=>{
    if(currentTab!=='publico') return;
    const mapArea = document.getElementById('mapArea');
    if(!mapArea) return;
    const overview = document.getElementById('sessionOverviewArea');
    if(overview) overview.innerHTML = renderSessionOverview(seats, foundNow);
    mapArea.innerHTML = renderSeatMap(seats, true);
    fitSeatmap(mapArea);
    const sum = computeSummary(seats);
    document.getElementById('summaryArea').innerHTML = `<div class="summary">
      <div class="stat"><b>${sum.livre}</b><span>Livres</span></div>
      <div class="stat"><b>${sum.sellable}</b><span>Total à venda</span></div>
    </div>`;
  });
}

/* ---------- Configurações ---------- */
function renderConfig(){
  if(!currentUser){ renderLoginScreen(); return; }
  detachLiveSeats();
  const content = document.getElementById('content');
  let html = `<div class="panel">
    <h2>Instalar como app</h2>
    <p class="note" style="margin-top:-6px;">No Android/Chrome, aparece o botão "⬇️ Instalar app" no topo. No iPhone (Safari), não tem esse botão automático — é manual: toque no ícone de Compartilhar (□↑) e depois em "Adicionar à Tela de Início".</p>
  </div>

  <div class="panel">
    <h2>Configurações da sala</h2>
    <p class="note" style="margin-top:-8px;">O palco fica de frente para o público. Da esquerda para a direita: <b>Esquerda</b> · <b>Centro</b> · <b>Direita (reservado para alunos por padrão — dá pra liberar assento por assento no Painel)</b>.</p>
    <p class="note" style="margin-top:-4px;">Edite os números de cada fileira abaixo para adicionar ou remover cadeiras — a numeração das cadeiras (usada nos ingressos e e-mails) é recalculada automaticamente, sequencial de A a Z, sem reiniciar em cada fileira. Cadeiras marcadas como "Indisponível" ou como "Aluno" saem dessa numeração (o total cai) até serem liberadas de novo.</p>
    <div class="room-layout-editor" style="margin-top:12px;overflow:auto;">
      <table class="data-table" id="roomLayoutTable"><thead><tr><th>Fileira</th><th>Esquerda</th><th>Centro</th><th>Direita / Alunos</th><th>Total</th><th></th></tr></thead>
      <tbody>${ROOM_LAYOUT.map((x,r)=>`<tr data-row-idx="${r}">
        <td><strong>${x.row}</strong></td>
        <td><input type="number" min="0" class="rl-input rl-left" value="${x.left}" style="width:64px;"/></td>
        <td><input type="number" min="0" class="rl-input rl-center" value="${x.center}" style="width:64px;"/></td>
        <td><input type="number" min="0" class="rl-input rl-right" value="${x.right}" style="width:64px;"/></td>
        <td class="rl-total">${x.left+x.center+x.right}</td>
        <td><button class="btn danger tiny" data-remove-row="${r}" type="button">Remover</button></td>
      </tr>`).join('')}</tbody></table>
    </div>
    <div class="row" style="margin-top:12px;">
      <button class="btn ghost tiny" id="btnAddRoomRow" type="button">+ Fileira</button>
      <span class="note" id="roomLayoutTotal" style="margin:0;"></span>
    </div>
    <p class="note" style="margin-top:10px;">Atenção: remover uma fileira inteira pode deixar "órfãs" vendas antigas feitas nela (a cadeira some do mapa, mas o histórico permanece salvo). Reduzir a quantidade de cadeiras de uma fileira que já tem vendas também pode remover cadeiras já vendidas do mapa — confira o Painel depois de editar.</p>
  </div>

  <div class="panel">
    <h2>Preço por assento</h2>
    <p class="note" style="margin-top:-6px;">Clique nos assentos pra selecionar (pode marcar vários de uma vez) e defina o preço deles juntos. O número dentro do assento é o preço já definido (arredondado).</p>
    <div id="priceMapArea">${renderPriceMap()}</div>
    <p class="note" id="priceSelCount">0 assento(s) selecionado(s)</p>
    <div class="row" style="margin-top:8px;">
      <div class="field"><label>Preço para os selecionados (R$)</label><input id="bulkPriceInput" type="number" min="0" step="0.01" placeholder="0,00"/></div>
      <button class="btn gold" id="btnApplyPrice" style="align-self:flex-end;">Aplicar aos selecionados</button>
      <button class="btn ghost" id="btnClearPriceSel" style="align-self:flex-end;">Limpar seleção</button>
    </div>
  </div>

  <div class="panel">
    <h2>Espetáculos e sessões</h2>
    <div id="showsList"></div>
    <button class="btn ghost" id="btnAddShow">+ Adicionar espetáculo</button>
  </div>`;
  content.innerHTML = html;
  attachPriceMapHandlers();
  updatePriceSelCount();
  attachRoomLayoutHandlers();

  document.getElementById('btnApplyPrice').addEventListener('click', async ()=>{
    const v = parseFloat(document.getElementById('bulkPriceInput').value.replace(',','.'));
    if(isNaN(v)){ showToast('Digite um preço válido'); return; }
    if(!priceSelectedSeats.size){ showToast('Selecione pelo menos um assento'); return; }
    CONFIG.prices = CONFIG.prices || {};
    priceSelectedSeats.forEach(id=>{ CONFIG.prices[id] = v; });
    await saveConfig();
    priceSelectedSeats.clear();
    showToast('Preço aplicado');
    renderConfig();
  });
  document.getElementById('btnClearPriceSel').addEventListener('click', ()=>{
    priceSelectedSeats.clear();
    renderConfig();
  });

  const list = document.getElementById('showsList');
  CONFIG.shows.forEach(show=>{
    const card = document.createElement('div');
    card.className = 'show-card';
    card.innerHTML = `<div class="show-head">
        <input value="${escapeHtml(show.name)}" class="showNameInput"/>
        <button class="btn danger tiny" data-remove-show="${show.id}">Remover</button>
      </div>
      <div class="bg-upload-row">
        ${show.backgroundImage ? `<img class="bg-preview" src="${show.backgroundImage}" alt=""/>` : `<div class="bg-preview empty-bg">sem imagem</div>`}
        <div class="bg-upload-actions">
          <label class="btn ghost tiny bg-upload-label">📷 ${show.backgroundImage ? 'Trocar imagem do ingresso' : 'Upar imagem do ingresso'}<input type="file" accept="image/*" class="bgFileInput" style="display:none;"/></label>
          ${show.backgroundImage ? `<button class="btn danger tiny" data-remove-bg="1" type="button">Remover imagem</button>` : ''}
        </div>
      </div>
      <div class="sessionsWrap"></div>
      <button class="btn ghost tiny" data-add-session="${show.id}">+ Adicionar sessão</button>`;
    list.appendChild(card);

    const wrap = card.querySelector('.sessionsWrap');
    (show.sessions||[]).forEach(se=>{
      const row = document.createElement('div');
      row.className = 'session-row';
      row.innerHTML = `<input type="date" value="${se.date||''}" data-field="date" />
        <input type="time" value="${se.time||''}" data-field="time" />
        <button class="btn danger tiny" data-remove-session="${se.id}">Remover</button>`;
      const [dateInput, timeInput] = row.querySelectorAll('input');
      dateInput.addEventListener('change', async ()=>{ se.date = dateInput.value; await saveConfig(); });
      timeInput.addEventListener('change', async ()=>{ se.time = timeInput.value; await saveConfig(); });
      row.querySelector('[data-remove-session]').addEventListener('click', async ()=>{
        show.sessions = show.sessions.filter(x=>x.id!==se.id);
        await saveConfig(); renderConfig();
      });
      wrap.appendChild(row);
    });

    card.querySelector('.showNameInput').addEventListener('change', async (e)=>{
      show.name = e.target.value; await saveConfig();
    });
    card.querySelector('[data-remove-show]').addEventListener('click', async ()=>{
      CONFIG.shows = CONFIG.shows.filter(s=>s.id!==show.id);
      await saveConfig(); renderConfig();
    });
    card.querySelector('[data-add-session]').addEventListener('click', async ()=>{
      show.sessions = show.sessions || [];
      show.sessions.push({ id: uid('s'), date:'', time:'' });
      await saveConfig(); renderConfig();
    });
    const bgInput = card.querySelector('.bgFileInput');
    bgInput.addEventListener('change', async (e)=>{
      const file = e.target.files[0];
      if(!file) return;
      try{
        const dataUrl = await resizeImageToDataUrl(file, 900, 500);
        show.backgroundImage = dataUrl;
        await saveConfig();
        renderConfig();
      }catch(err){
        showToast('Não consegui processar essa imagem');
      }
    });
    const removeBgBtn = card.querySelector('[data-remove-bg]');
    if(removeBgBtn){
      removeBgBtn.addEventListener('click', async ()=>{
        delete show.backgroundImage;
        await saveConfig();
        renderConfig();
      });
    }
  });

  document.getElementById('btnAddShow').addEventListener('click', async ()=>{
    CONFIG.shows.push({ id: uid('show'), name: 'Novo espetáculo', sessions: [{id: uid('s'), date:'', time:''}] });
    await saveConfig(); renderConfig();
  });
}

function updateRoomLayoutTotalDisplay(){
  const el = document.getElementById('roomLayoutTotal');
  if(!el) return;
  const total = totalPhysicalSeats();
  const unavailable = totalUnavailableSeats();
  // Numeração ativa: usa {} pra cair no status padrão de cada cadeira (ou seja, considera as cadeiras
  // da direita como "Aluno" por padrão) — é uma estimativa, já que o status real de "Aluno" pode
  // variar sessão a sessão (uma cadeira de aluno pode ser liberada pra venda numa sessão específica).
  const activeNumbering = computeSeatNumberMap({}).total;
  el.textContent = `Cadeiras cadastradas: ${total} · Indisponíveis agora: ${unavailable} · Numeração ativa (fora alunos e indisponíveis): ${activeNumbering} cadeiras`;
}
let roomLayoutSaveTimer = null;
function scheduleRoomLayoutSave(){
  clearTimeout(roomLayoutSaveTimer);
  roomLayoutSaveTimer = setTimeout(async ()=>{
    try{ await saveRoomLayout(); }
    catch(e){ console.error(e); showToast('Erro ao salvar o layout da sala: ' + (e && e.message ? e.message : e)); }
  }, 500);
}
function attachRoomLayoutHandlers(){
  const table = document.getElementById('roomLayoutTable');
  if(!table) return;
  updateRoomLayoutTotalDisplay();
  table.querySelectorAll('tr[data-row-idx]').forEach(tr=>{
    const r = parseInt(tr.dataset.rowIdx, 10);
    const updateRowTotal = ()=>{
      const layout = ROOM_LAYOUT[r];
      tr.querySelector('.rl-total').textContent = layout.left + layout.center + layout.right;
      updateRoomLayoutTotalDisplay();
    };
    tr.querySelector('.rl-left').addEventListener('change', e=>{
      ROOM_LAYOUT[r].left = Math.max(0, parseInt(e.target.value,10) || 0);
      updateRowTotal(); scheduleRoomLayoutSave();
    });
    tr.querySelector('.rl-center').addEventListener('change', e=>{
      ROOM_LAYOUT[r].center = Math.max(0, parseInt(e.target.value,10) || 0);
      updateRowTotal(); scheduleRoomLayoutSave();
    });
    tr.querySelector('.rl-right').addEventListener('change', e=>{
      ROOM_LAYOUT[r].right = Math.max(0, parseInt(e.target.value,10) || 0);
      updateRowTotal(); scheduleRoomLayoutSave();
    });
    const removeBtn = tr.querySelector('[data-remove-row]');
    if(removeBtn){
      removeBtn.addEventListener('click', async ()=>{
        if(ROOM_LAYOUT.length<=1){ showToast('Precisa ter pelo menos uma fileira'); return; }
        if(!confirm('Remover a fileira '+ROOM_LAYOUT[r].row+'? Cadeiras já vendidas nela somem do mapa (o histórico continua salvo).')) return;
        ROOM_LAYOUT.splice(r,1);
        await saveRoomLayout();
        renderConfig();
      });
    }
  });
  const btnAdd = document.getElementById('btnAddRoomRow');
  if(btnAdd){
    btnAdd.addEventListener('click', async ()=>{
      if(ROOM_LAYOUT.length>=26){ showToast('Máximo de 26 fileiras (A a Z)'); return; }
      const last = ROOM_LAYOUT[ROOM_LAYOUT.length-1] || {left:7, center:15, right:8};
      ROOM_LAYOUT.push({ row: rowLetter(ROOM_LAYOUT.length), left:last.left, center:last.center, right:last.right });
      await saveRoomLayout();
      renderConfig();
    });
  }
}

/* ---------- Ingressos em PDF (busca por nome, gera o PDF na hora, sem guardar nada) ---------- */
// Carrega (uma vez, sob demanda) os assentos de sessões que ainda não foram abertas nesta visita —
// as que já têm listener ao vivo (a sessão selecionada no Painel) não são recarregadas.
async function loadAllSeatsForSearch(){
  const sessionIds = [];
  (CONFIG.shows||[]).forEach(show=> (show.sessions||[]).forEach(se=> sessionIds.push(se.id)));
  const toLoad = sessionIds.filter(id => !SEATS_CACHE[id]);
  if(!toLoad.length) return;
  await Promise.all(toLoad.map(async id=>{
    try{
      const snap = await db.ref('seats/'+id).once('value');
      SEATS_CACHE[id] = snap.val() || {};
    }catch(e){
      console.error('Erro ao carregar assentos da sessão '+id, e);
    }
  }));
}
async function renderPdfLookup(){
  if(!currentUser){ renderLoginScreen(); return; }
  const content = document.getElementById('content');
  content.innerHTML = `<div class="panel">
    <h2>Ingressos em PDF</h2>
    <p class="note" style="margin-top:-8px;">Busque pelo nome do comprador em todos os espetáculos e sessões, baixe o PDF exato do ingresso (o mesmo que sai na impressão) e envie por onde preferir — e-mail do corporativo, WhatsApp, etc. Não precisa imprimir nada.</p>
    <div class="search-box" style="margin-top:14px;">
      <input id="buscaPdf" placeholder="Nome do comprador…"/>
      <button class="btn ghost tiny" id="btnBuscarPdf">Buscar</button>
    </div>
    <p class="note" id="pdfSearchStatus"></p>
    <div id="pdfResults"></div>
  </div>`;
  const input = document.getElementById('buscaPdf');
  document.getElementById('btnBuscarPdf').addEventListener('click', doPdfSearch);
  input.addEventListener('keydown', e=>{ if(e.key==='Enter') doPdfSearch(); });
  input.focus();
}
async function doPdfSearch(){
  const term = document.getElementById('buscaPdf').value.trim().toLowerCase();
  const box = document.getElementById('pdfResults');
  const status = document.getElementById('pdfSearchStatus');
  if(!term){ box.innerHTML=''; status.textContent=''; return; }
  status.textContent = 'Carregando dados de todas as sessões…';
  box.innerHTML = '';
  await loadAllSeatsForSearch();
  status.textContent = '';
  const results = [];
  (CONFIG.shows||[]).forEach(show=>{
    (show.sessions||[]).forEach(session=>{
      const seats = SEATS_CACHE[session.id] || {};
      Object.entries(seats).forEach(([id,d])=>{
        if(d && (d.status==='vendido'||d.status==='convidado') && d.nome && d.nome.toLowerCase().includes(term)){
          results.push({show, session, seatId:id, data:d});
        }
      });
    });
  });
  if(!results.length){ box.innerHTML = '<div class="empty">Nenhum ingresso encontrado com esse nome.</div>'; return; }
  results.sort((a,b)=> (a.session.date||'').localeCompare(b.session.date||'') || a.seatId.localeCompare(b.seatId));
  box.innerHTML = '<div class="found-list">' + results.map((r,i)=>{
    const numberMap = computeSeatNumberMap(SEATS_CACHE[r.session.id]||{}).map;
    const label = seatDisplayLabel(r.seatId, numberMap);
    const contact = [r.data.telefone, r.data.email].filter(Boolean).map(escapeHtml).join(' · ');
    return `<div class="found-item"><span>Assento <b>${escapeHtml(label)}</b> — ${escapeHtml(r.data.nome)}${contact?(' — '+contact):''}<br/><small>${escapeHtml(r.show.name)} — ${escapeHtml(sessionLabel(r.session))}</small> <span class="badge ${r.data.status}">${statusLabel(r.data.status)}</span></span><button class="btn ghost tiny" data-pdf-idx="${i}">⬇️ Baixar PDF</button></div>`;
  }).join('') + '</div>';
  box.querySelectorAll('[data-pdf-idx]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const r = results[parseInt(btn.dataset.pdfIdx,10)];
      const originalLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Gerando…';
      try{
        const dataUrl = await buildTicketPdfDataUrl({seatId:r.seatId, show:r.show, session:r.session, nome:r.data.nome, status:r.data.status});
        const code = ticketCode(r.session.id, r.seatId);
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = 'ingresso-' + code.toLowerCase() + '.pdf';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }catch(e){
        console.error(e);
        showToast('Erro ao gerar o PDF');
      }finally{
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });
  });
}

/* ---------- Check-in (leitura de QR) ---------- */
let scanStream = null;
let scanLoopId = null;
let lastScanCode = null;
let lastScanAt = 0;

function stopScanner(){
  if(scanLoopId){ cancelAnimationFrame(scanLoopId); scanLoopId = null; }
  if(scanStream){ scanStream.getTracks().forEach(t=>t.stop()); scanStream = null; }
}

async function renderCheckin(){
  if(!currentUser){ renderLoginScreen(); return; }
  detachLiveSeats();
  const content = document.getElementById('content');
  content.innerHTML = `<div class="panel">
    <h2>Check-in — leitura de ingresso</h2>
    <p class="note" style="margin-top:-6px;">Aponte a câmera para o QR code do ingresso (impresso ou na tela do celular da pessoa).</p>
    <button class="btn gold" id="btnStartScan">📷 Ligar câmera</button>
    <button class="btn ghost" id="btnStopScan" style="display:none;">Parar câmera</button>
    <div class="scan-wrap" id="scanWrap" style="display:none;">
      <video id="scanVideo" playsinline muted></video>
      <canvas id="scanCanvas" style="display:none;"></canvas>
    </div>
    <div id="scanResult"></div>
    <div class="field" style="margin-top:16px;"><label>Ou digite o código manualmente</label>
      <div class="row">
        <input id="manualCode" placeholder="Ex: S1_1-A12" style="flex:1;"/>
        <button class="btn ghost tiny" id="btnManualCheck">Verificar</button>
      </div>
    </div>
    <div id="checkinLog"></div>
  </div>`;

  const btnStart = document.getElementById('btnStartScan');
  const btnStop = document.getElementById('btnStopScan');
  const wrap = document.getElementById('scanWrap');
  const video = document.getElementById('scanVideo');
  const canvas = document.getElementById('scanCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  btnStart.addEventListener('click', async ()=>{
    try{
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = scanStream;
      await video.play();
      wrap.style.display = 'block';
      btnStart.style.display = 'none';
      btnStop.style.display = 'inline-block';
      scanLoop(video, canvas, ctx);
    }catch(e){
      showToast('Não consegui acessar a câmera — verifique a permissão do navegador');
    }
  });
  btnStop.addEventListener('click', ()=>{
    stopScanner();
    wrap.style.display = 'none';
    btnStart.style.display = 'inline-block';
    btnStop.style.display = 'none';
  });
  document.getElementById('btnManualCheck').addEventListener('click', ()=>{
    const raw = document.getElementById('manualCode').value.trim();
    if(!raw) return;
    handleScannedText('STUDIOA|'+raw.replace(/^STUDIOA\|/i,''));
  });
}

function scanLoop(video, canvas, ctx){
  if(video.readyState === video.HAVE_ENOUGH_DATA){
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    if(code && code.data){
      const now = Date.now();
      if(code.data !== lastScanCode || now - lastScanAt > 4000){
        lastScanCode = code.data;
        lastScanAt = now;
        handleScannedText(code.data);
      }
    }
  }
  scanLoopId = requestAnimationFrame(()=> scanLoop(video, canvas, ctx));
}

async function handleScannedText(text){
  const resultBox = document.getElementById('scanResult');
  if(!resultBox) return;
  if(!text.startsWith('STUDIOA|')){
    resultBox.innerHTML = `<div class="scan-banner invalid">❌ Este QR code não é um ingresso do Studio A</div>`;
    return;
  }
  const code = text.replace('STUDIOA|','');
  const idx = code.lastIndexOf('-');
  if(idx<0){
    resultBox.innerHTML = `<div class="scan-banner invalid">❌ Código inválido</div>`;
    return;
  }
  // Os códigos podem ser digitados manualmente com maiúsculas/minúsculas.
  // Os IDs internos das sessões são mantidos como foram salvos no Firebase.
  const rawSessionId = code.slice(0, idx).trim();
  const sessionId = rawSessionId.toLowerCase();
  const seatId = code.slice(idx+1).trim().toUpperCase();
  const found = findShowAndSession(sessionId);
  if(!found){
    resultBox.innerHTML = `<div class="scan-banner invalid">❌ Sessão não encontrada — pode ser de outro evento</div>`;
    return;
  }
  let seat;
  try{
    const snap = await db.ref('seats/'+sessionId+'/'+seatId).once('value');
    seat = snap.val();
  }catch(e){ seat = null; }

  if(!seat || (seat.status!=='vendido' && seat.status!=='convidado')){
    const msg = seat && seat.status==='aluno'
      ? `🎓 Assento ${seatId} é reservado para aluno e não possui ingresso/check-in.`
      : `❌ Assento ${seatId} não consta como vendido ou convidado`;
    resultBox.innerHTML = `<div class="scan-banner invalid">${msg}</div>`;
    addCheckinLog(seatId, found, null, 'invalido');
    return;
  }
  if(seat.checkin){
    const hora = new Date(seat.checkinAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    resultBox.innerHTML = `<div class="scan-banner warn">⚠️ Já tinha dado entrada às ${hora} — ${escapeHtml(seat.nome||'')} — Assento ${seatId}</div>`;
    addCheckinLog(seatId, found, seat, 'repetido');
    return;
  }
  const updated = Object.assign({}, seat, { checkin:true, checkinAt: Date.now() });
  await db.ref('seats/'+sessionId+'/'+seatId).set(updated);
  resultBox.innerHTML = `<div class="scan-banner ok">✅ Entrada confirmada — ${escapeHtml(seat.nome||'')} — Assento ${seatId} — ${escapeHtml(found.show.name)}</div>`;
  addCheckinLog(seatId, found, updated, 'ok');
}

const checkinLogEntries = [];
function addCheckinLog(seatId, found, seat, kind){
  const log = document.getElementById('checkinLog');
  if(!log) return;
  checkinLogEntries.unshift({ time: new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}), seatId, showName: found.show.name, nome: seat ? seat.nome : '', kind });
  log.innerHTML = '<div class="found-list">' + checkinLogEntries.slice(0,15).map(e=>
    `<div class="found-item"><span>${e.time} — Assento <b>${e.seatId}</b> — ${escapeHtml(e.nome||'—')} (${escapeHtml(e.showName)})</span><span class="badge ${e.kind==='ok'?'vendido':'indisponivel'}">${e.kind==='ok'?'entrou':e.kind==='repetido'?'repetido':'inválido'}</span></div>`
  ).join('') + '</div>';
}


function switchTab(tab){
  if(currentTab==='checkin' && tab!=='checkin'){ stopScanner(); }
  if(currentTab==='publico' && tab!=='publico'){ stopCountdown(); }
  if(currentTab==='painel' && tab!=='painel'){ selectionMode = false; selectedSeats.clear(); }
  currentTab = tab;
  document.querySelectorAll('nav.tabs button').forEach(b=> b.classList.toggle('active', b.dataset.tab===tab));
  if(tab==='painel') renderPainel();
  else if(tab==='publico') renderPublico();
  else if(tab==='checkin') renderCheckin();
  else if(tab==='pdfs') renderPdfLookup();
  else renderConfig();
}

document.querySelectorAll('nav.tabs button').forEach(b=>{
  b.addEventListener('click', ()=> switchTab(b.dataset.tab));
});

function renderSetupScreen(){
  document.getElementById('content').innerHTML = `<div class="panel setup-screen">
    <h2>Configure o Firebase para publicar no GitHub</h2>
    <p class="note">Este site usa o Firebase Realtime Database para que todos os atendentes vejam as vendas em tempo real. Antes de usar, siga os passos:</p>
    <ol>
      <li>Acesse <code>console.firebase.google.com</code> e crie um projeto gratuito.</li>
      <li>No menu, vá em <b>Build → Realtime Database</b> e clique em "Criar banco de dados" (modo teste).</li>
      <li>Vá em <b>⚙️ Configurações do projeto → Seus apps → Web (ícone &lt;/&gt;)</b> e registre um app.</li>
      <li>Copie o objeto <code>firebaseConfig</code> gerado.</li>
      <li>No arquivo <code>assets/js/config.js</code>, substitua o objeto <code>firebase</code> pelos valores do seu projeto.</li>
      <li>Salve, publique no GitHub Pages e recarregue esta página.</li>
    </ol>
    <p class="note">Depois de configurado, todas as reservas e vendas ficam salvas e sincronizadas automaticamente entre todos os aparelhos.</p>
  </div>`;
}

/* ---------- PWA (instalar como app) ---------- */
(function setupPWA(){
  const logoSrc = document.querySelector('.brand img').src;

  const manifest = {
    name: "Studio A — Bilheteria",
    short_name: "Studio A",
    start_url: ".",
    scope: ".",
    display: "standalone",
    background_color: "#0c0a0d",
    theme_color: "#0c0a0d",
    icons: [
      { src: logoSrc, sizes: "192x192", type: "image/png" },
      { src: logoSrc, sizes: "512x512", type: "image/png" }
    ]
  };
  const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
  const manifestLink = document.createElement('link');
  manifestLink.rel = 'manifest';
  manifestLink.href = URL.createObjectURL(manifestBlob);
  document.head.appendChild(manifestLink);

  const appleIcon = document.createElement('link');
  appleIcon.rel = 'apple-touch-icon';
  appleIcon.href = logoSrc;
  document.head.appendChild(appleIcon);

  const themeColorMeta = document.createElement('meta');
  themeColorMeta.name = 'theme-color';
  themeColorMeta.content = '#0c0a0d';
  document.head.appendChild(themeColorMeta);

  if('serviceWorker' in navigator){
    const swCode = "self.addEventListener('install', e=>self.skipWaiting());"
      + "self.addEventListener('activate', e=>self.clients.claim());"
      + "self.addEventListener('fetch', e=>{});";
    const swBlob = new Blob([swCode], { type: 'application/javascript' });
    navigator.serviceWorker.register(URL.createObjectURL(swBlob), { scope: './' }).catch(()=>{});
  }

  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e)=>{
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = document.getElementById('btnInstallPWA');
    if(btn) btn.style.display = 'inline-block';
  });
  const installBtn = document.getElementById('btnInstallPWA');
  if(installBtn){
    installBtn.addEventListener('click', async ()=>{
      if(!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      installBtn.style.display = 'none';
    });
  }
  window.addEventListener('appinstalled', ()=>{
    const btn = document.getElementById('btnInstallPWA');
    if(btn) btn.style.display = 'none';
  });
})();

(async function init(){
  document.getElementById('content').innerHTML = '<div class="panel"><div class="empty">Carregando bilheteria…</div></div>';
  if(!FIREBASE_READY){
    renderSetupScreen();
    return;
  }
  await loadConfig();
  await migrateGlobalUnavailable();
  switchTab('publico');
  attachGlobalUnavailableListener();
})();
