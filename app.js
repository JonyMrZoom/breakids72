// ======== сервер ========
var API = null;
var KEY = '';
try { API = localStorage.getItem('bk72_apiUrl'); KEY = localStorage.getItem('bk72_key') || ''; } catch (e) {}
var QUEUEABLE = { setAttendance:1, addPayment:1, updateChild:1, addLead:1, addChild:1, moveChild:1, deleteLead:1, convertLead:1 };   // что можно отложить до интернета
var netDown = false;        // последний запрос не дошёл: считаем, что связи нет, и больше не ждём таймаутов
var retryDelay = 8000;      // пауза между попытками восстановить связь (растёт до минуты)
var epoch = 0;              // растёт при любом локальном изменении: устаревший ответ сервера не затрёт экран

function mkErr(msg, flag){ var e = new Error(msg); if (flag) e[flag] = true; return e; }
/** Ошибка «связи нет / сервер временно не отвечает» — такое можно повторить позже, данные не теряем. */
function netErr(e){
  if (e && (e.net || e.transient)) return true;
  if (e && e.http) return false;
  var m = String(e && e.message || e);
  return !navigator.onLine || /Failed to fetch|NetworkError|aborted|The operation|Load failed|timed out/i.test(m);
}
function isOnline(){ return navigator.onLine && !netDown; }
function setDown(v){
  if (netDown === v) return;
  netDown = v;
  if ((branchScreen(screen)||screen==='more') && !loading) render();             // обновить значок «офлайн»
}
function api(action, params, timeout, force){
  if (!API) return Promise.reject(mkErr('Сервер не подключён — откройте Настройки'));
  if (!navigator.onLine) return Promise.reject(mkErr('Нет интернета (offline)', 'net'));          // без сети не ждём таймаут
  if (netDown && !force) return Promise.reject(mkErr('Нет связи с сервером', 'net'));              // связь только что пропала — не зависаем
  var ctl = window.AbortController ? new AbortController() : null, timer = null;
  if (ctl) timer = setTimeout(function(){ ctl.abort(); }, timeout || 25000);   // чтобы запрос не висел вечно
  return fetch(API, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, signal: ctl?ctl.signal:undefined, body:JSON.stringify({action:action, params:params||[], key:KEY}) })
    .then(function(r){
      setDown(false);                                       // сервер ответил — связь есть
      if (r.status===404) throw mkErr('По этому адресу ничего нет (404). В Apps Script: Развернуть → Управление развертываниями → возьмите АКТИВНОЕ развертывание и скопируйте «URL веб-приложения», он заканчивается на /exec.', 'http');
      if (r.status===401 || r.status===403) throw mkErr('Google не пускает (доступ). При публикации выберите «Запуск от имени: Я» и «Доступ: Все».', 'http');
      if (r.status>=500 || r.status===429) throw mkErr('Сервер Google временно не отвечает ('+r.status+')', 'transient');
      if (!r.ok) throw mkErr('Сервер ответил ' + r.status, 'http');
      return r.text().then(function(t){
        var d; try { d = JSON.parse(t); } catch (x) { throw mkErr('Сервер вернул не тот ответ — похоже на временный сбой Google', 'transient'); }
        if (d && d.ok) return d.result;
        var e = (d && d.error) || 'Ошибка сервера';
        if (d && d.needKey) { needKey = true; }
        if (/Неизвестное действие/i.test(e)) e = 'Таблица отвечает старым кодом. В Apps Script: Развернуть → Управление развертываниями → карандаш → Версия: Новая версия → Развернуть.';
        throw mkErr(e, 'http');
      });
    })
    .then(function(v){ clearTimeout(timer); return v; }, function(e){
      clearTimeout(timer);
      if (e && (e.http || e.transient)) throw e;
      setDown(true);                                        // запрос не дошёл или не вернулся
      throw mkErr((e && e.name==='AbortError') ? 'Сервер не ответил вовремя (timed out)' : String(e && e.message || e), 'net');
    });
}

// ======== офлайн: кеш данных и очередь отправки ========
var cacheTimer = null, cacheRef = null;
/** Запись кеша откладывается: на каждом тапе гонять весь JSON в localStorage — это и есть «подлагивание». */
function cacheSave(d){ cacheRef = d; if (!cacheTimer) cacheTimer = setTimeout(cacheNow, 700); }
function cacheNow(){
  if (cacheTimer){ clearTimeout(cacheTimer); cacheTimer = null; }
  if (!cacheRef) return;
  try{ localStorage.setItem('bk72_data', JSON.stringify({t:Date.now(), d:cacheRef})); }catch(e){}
}
window.addEventListener('pagehide', cacheNow);
document.addEventListener('visibilitychange', function(){ if (document.visibilityState==='hidden') cacheNow(); });
function cacheLoad(){ try{ var v=JSON.parse(localStorage.getItem('bk72_data')||'null'); return v&&v.d?v:null; }catch(e){ return null; } }
function queueGet(){ try{ var a=JSON.parse(localStorage.getItem('bk72_queue')||'[]'); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
function queueSet(a){ try{ localStorage.setItem('bk72_queue', JSON.stringify(a)); }catch(e){} }
/** В очередь; повторная отметка того же ребёнка в тот же день заменяет прежнюю (уходит только последнее решение). */
function queueAdd(action, params){
  var a=queueGet(), from=flushing?1:0;                      // первую запись при отправке не трогаем
  if (action==='setAttendance'){
    for (var i=a.length-1;i>=from;i--){
      var p=a[i].params;
      if (a[i].action===action && p[0]===params[0] && p[1]===params[1] && p[2]===params[2]){ a[i].params=params; queueSet(a); return; }
    }
  }
  a.push({action:action, params:params, t:Date.now()}); queueSet(a);
}
function queueCount(){ return queueGet().length; }
function failedGet(){ try{ var a=JSON.parse(localStorage.getItem('bk72_failed')||'[]'); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
function failedAdd(it, msg){
  if (!it) return;
  var a=failedGet(); a.push({action:it.action, params:it.params, t:it.t||Date.now(), msg:String(msg||'')});
  try{ localStorage.setItem('bk72_failed', JSON.stringify(a.slice(-30))); }catch(e){}
}

var flushing=false, flushTimer=null;
/** Назначить попытку восстановить связь / отправить накопленное. */
function kick(delay){
  if (flushTimer || !API) return;
  flushTimer=setTimeout(function(){ flushTimer=null; recover(); }, delay||0);
}
function recover(){
  if (!API) return Promise.resolve();
  if (queueCount()) return flush();
  if (netDown && navigator.onLine){                          // лёгкая проверка: появилась ли связь
    return api('getAppData',[true,(S&&S.sig)||''],10000,true).then(function(){ retryDelay=8000; return load(true); },
      function(e){ if (netErr(e)){ retryDelay=Math.min(retryDelay*2,60000); kick(retryDelay); } });
  }
  return Promise.resolve();
}
/** Отправляет отложенное строго по порядку; вызывается при появлении связи. */
function flush(){
  if (flushing || !API || !navigator.onLine) return Promise.resolve(0);
  if (!queueCount()) return Promise.resolve(0);
  flushing=true;
  var sent=0, retry=false;
  var step=function(){
    var list=queueGet();
    if (!list.length) return Promise.resolve();
    var it=list[0];
    return api(it.action, it.params, 20000, true).then(function(){
      sent++; retryDelay=8000;
      var rest=queueGet(); rest.shift(); queueSet(rest); return step();
    }, function(e){
      if (needKey){ toast(e.message); return; }              // не потеряем отметки: дождёмся ключа
      if (netErr(e)){                                        // связи нет или Google барахлит — оставляем в очереди
        if (e.transient){
          var r2=queueGet();
          if (r2[0]){
            r2[0].tries=(r2[0].tries||0)+1;
            if (r2[0].tries>=6){ failedAdd(r2.shift(), e.message); queueSet(r2); toast('Не удалось отправить: '+e.message); return step(); }
            queueSet(r2);
          }
        }
        retry=true; return;
      }
      var rest=queueGet(), bad=rest.shift(); queueSet(rest); failedAdd(bad, e.message);   // сервер отказал — не крутим вечно, но и не теряем бесследно
      toast('Не удалось отправить: '+e.message);
      return step();
    });
  };
  return step().then(function(){
    flushing=false;
    if (retry){ retryDelay=Math.min(retryDelay*2,60000); kick(retryDelay); }
    if (sent) toast('Отправлено в таблицу: '+sent);
    if (branchScreen(screen)||screen==='more') render();
    if (sent && !retry && !queueCount()) return load(true);
  }, function(){ flushing=false; });
}
/** Запросы, которые уже ушли на сервер, но ответа ещё нет. Если приложение закроют
 *  в эту секунду, отметка потерялась бы: держим их список на устройстве и разбираем при запуске. */
var sending = [];
function sendingSave(){ try{ if (sending.length) localStorage.setItem('bk72_sending', JSON.stringify(sending)); else localStorage.removeItem('bk72_sending'); }catch(e){} }
function sendingAdd(it){ sending.push(it); sendingSave(); }
function sendingDone(it){ var i=sending.indexOf(it); if (i>=0){ sending.splice(i,1); sendingSave(); } }
/** Разбор прерванных отправок при запуске: отметку просто повторяем (она идемпотентна — ставит значение,
 *  а не прибавляет), остальное не повторяем вслепую, чтобы не задвоить оплату, а показываем для проверки. */
function sendingRecover(){
  var left=[];
  try{ left=JSON.parse(localStorage.getItem('bk72_sending')||'[]'); }catch(e){}
  if (!left.length) return;
  try{ localStorage.removeItem('bk72_sending'); }catch(e){}
  var n=0, m=0;
  left.forEach(function(it){
    if (!it || !it.action) return;
    if (it.action==='setAttendance'){ queueAdd(it.action, it.params); n++; }
    else { failedAdd(it, 'Отправка прервалась — проверьте эту запись в таблице'); m++; }
  });
  if (n) kick(400);
  if (n) setTimeout(function(){ toast('Доотправляю '+n+' '+plural(n,'отметку','отметки','отметок')+' с прошлого раза'); }, 900);
  if (m) setTimeout(function(){ toast('Проверьте в таблице '+m+' '+plural(m,'запись','записи','записей')+' — отправка прерывалась'); }, 2600);
}
window.addEventListener('pagehide', sendingSave);

var sendChain = Promise.resolve();
/** Отправка изменения. Все записи идут строго по очереди: офлайн — в очередь, онлайн — сразу,
 *  а если очередь не пуста, новая запись встаёт за ней (иначе отметка «снять» может обогнать «поставить»). */
function send(action, params){
  if (!QUEUEABLE[action]) return api(action, params);
  // Берём запись на учёт сразу, ещё до того как она дойдёт до сервера: при частых тапах
  // несколько отметок ждут своей очереди, и если приложение закрыть — мы будем знать, что они не ушли.
  var it={action:action, params:params, t:Date.now()};
  sendingAdd(it);
  var enqueue=function(){ sendingDone(it); queueAdd(action, params); kick(netDown ? retryDelay : 0); render(); return { queued:true }; };
  var run=function(){
    if (!API){ sendingDone(it); return Promise.reject(mkErr('Сервер не подключён — откройте Настройки')); }
    if (queueCount() || !isOnline()) return enqueue();
    return api(action, params, action==='setAttendance' ? 12000 : 25000).then(function(r){ sendingDone(it); return r; }, function(e){
      if (netErr(e) && !needKey) return enqueue();
      sendingDone(it);
      throw e;
    });
  };
  var p = sendChain.then(run);
  sendChain = p.catch(function(){});
  return p;
}
window.addEventListener('online', function(){ netDown=false; if (queueCount()) flush(); else load(true); });
window.addEventListener('offline', function(){ if (branchScreen(screen)||screen==='more') render(); });

/** Применяет к свежим данным то, что ещё не ушло в таблицу, — чтобы отметки не «пропадали» после обновления. */
function applyQueue(d, only){
  if (!d || !d.branches) return d;
  queueGet().forEach(function(it){
    try{
      var p=it.params, b=d.branches[p[0]]; if (!b || !b.kids || (only && p[0]!==only)) return;
      var k=null;
      if (it.action!=='addChild') for (var i=0;i<b.kids.length;i++) if (b.kids[i].id===p[1]){ k=b.kids[i]; break; }
      if (it.action==='setAttendance' && k){
        var had=!!k.attendance[p[2]];
        if (p[3] && !had){ k.attendance[p[2]]=true; k.visits++; } else if (!p[3] && had){ delete k.attendance[p[2]]; k.visits--; }
        k.remainder=k.balance-k.visits*k.price;
      } else if (it.action==='addPayment' && k && d.config){
        var single=p[2]==='single';
        k.balance+= single ? d.config.singlePrice : (Math.max(1,Number(p[3])||1)*d.config.abonPrice);
        k.price= single ? d.config.singlePrice : d.config.abonPrice; k.payType= single?'РАЗОВОЕ':'АБОНЕМЕНТ';
        k.remainder=k.balance-k.visits*k.price;
      } else if (it.action==='updateChild' && k && p[2]){
        var f=p[2]; k.name=f.name||k.name; k.group=f.group||k.group; k.phone1=f.phone1; k.phone2=f.phone2; k.payType=f.payType||k.payType;
        k.price=Number(f.price)||k.price; k.balance=Number(f.balance)||0; k.remainder=k.balance-k.visits*k.price;
      } else if (it.action==='addChild' && d.config){
        var sg=p[5]==='single';
        b.kids.push({ id:'tmp-q'+it.t, name:p[1], group:p[2], phone1:p[3]||'', phone2:p[4]||'', payType: sg?'РАЗОВОЕ':'АБОНЕМЕНТ', balance:0,
          price: sg?d.config.singlePrice:d.config.abonPrice, remainder:0, visits:0, attendance:{}, missed:0, lastVisit:'', pendingNew:true });
      }
    }catch(e){}
  });
  return d;
}
/** Данные с сервера в нормальный вид: пустые поля, повторы и порядок дат — чтобы экран не падал от одной кривой строки. */
function normalize(d){
  if (!d || !d.branches) return d;
  Object.keys(d.branches).forEach(function(n){
    var b=d.branches[n]; if (!b || b.error) return;
    b.kids = Array.isArray(b.kids) ? b.kids : [];
    var seen={}, ds=[]; (Array.isArray(b.dates)?b.dates:[]).forEach(function(x){ if (x && x.iso && !seen[x.iso]){ seen[x.iso]=1; ds.push(x); } });
    ds.sort(function(x,y){ return x.iso<y.iso?-1:(x.iso>y.iso?1:0); }); b.dates=ds;
    b.kids.forEach(function(k){
      k.attendance = k.attendance || {};
      ['visits','balance','price','remainder','missed'].forEach(function(f){ k[f]=Number(k[f])||0; });
      k.name=String(k.name==null?'':k.name); k.group=String(k.group==null?'':k.group);
      k.phone1=k.phone1||''; k.phone2=k.phone2||''; k.payType=k.payType||'АБОНЕМЕНТ';
    });
  });
  return d;
}
/** Принять данные с сервера как текущие. */
function adopt(d){
  if (d && d.configured && (!d.branches || !d.config || !d.month)) throw mkErr('Сервер вернул неполные данные — попробуйте обновить', 'transient');
  normalize(d); applyQueue(d);
  epoch++; S=d; cacheSave(d);
  return d;
}
/** Подставить свежие данные одного филиала (ответ на запись), не теряя того, что ещё в очереди. */
function putBranch(name, b){
  var t={branches:{}, config:S.config}; t.branches[name]=b; normalize(t);
  S.branches[name]=t.branches[name]; applyQueue(S, name);
}
function begin(){ pending++; epoch++; }
function end(){ pending=Math.max(0,pending-1); }

// ======== состояние ========
var needKey = false;
var loadErr = '', gf = '';
var S = null, screen = 'main', bi = 0, sel = {}, q = '', loading = false, pending = 0, lastLoad = 0, sheetKey = null, lastSig = '', updateReady = false;
var session = null;      // {branch, iso} — подтверждено на стартовом экране
try { var _s=JSON.parse(localStorage.getItem('bk72_session')||'null'); if (_s && _s.day) session=_s; } catch (e) {}
/** Подтверждение держится до конца дня: приложение, закрытое и открытое снова, не спрашивает заново. */
function sessionSave(){ try{ if (session) localStorage.setItem('bk72_session', JSON.stringify(session)); else localStorage.removeItem('bk72_session'); }catch(e){} }
var pick = { bi: 0, iso: null }, startFresh = true;
try { bi = Number(localStorage.getItem('bk72_branch')) || 0; } catch (e) {}
var DOW = ['ВС','ПН','ВТ','СР','ЧТ','ПТ','СБ'];
var MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
var GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
var IC = {
  refresh:'<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  gear:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  back:'<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  check:'<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  x:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  down:'<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  sort:'<svg viewBox="0 0 24 24"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/></svg>',
  home:'<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/></svg>',
  cal:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  users:'<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.4 0 4 1.8 4 4.5"/></svg>',
  wallet:'<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/></svg>',
  more:'<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  chev:'<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  warn:'<svg viewBox="0 0 24 24"><path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>'
};

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function pad(n){ return String(n).padStart(2,'0'); }
/** Телефон в едином виде «+7 922 111-22-33» — по нему сразу звонят из карточки. */
function fmtPhone(s){
  var d=String(s==null?'':s).replace(/\D/g,'');
  if(!d) return '';
  if(d.charAt(0)==='7'||d.charAt(0)==='8') d=d.slice(1);   // это наш собственный «+7» в начале поля
  while(d.length>10 && (d.charAt(0)==='7'||d.charAt(0)==='8')) d=d.slice(1);   // номер вставили поверх «+7»
  d=d.slice(0,10);
  var o='+7';
  if(d.length) o+=' '+d.slice(0,3);
  if(d.length>3) o+=' '+d.slice(3,6);
  if(d.length>6) o+='-'+d.slice(6,8);
  if(d.length>8) o+='-'+d.slice(8,10);
  return o;
}
function phoneOut(id){ var e=$(id); return e && /\d/.test(e.value) ? fmtPhone(e.value) : ''; }
function isTel(t){ return t && t.tagName==='INPUT' && t.type==='tel'; }
document.addEventListener('input', function(e){ if(isTel(e.target)) e.target.value=fmtPhone(e.target.value); });
document.addEventListener('focus', function(e){ if(isTel(e.target) && !e.target.value) e.target.value='+7 '; }, true);
document.addEventListener('blur', function(e){ if(isTel(e.target) && e.target.value.replace(/\D/g,'').length<2) e.target.value=''; }, true);
function today(){ var d=new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
function lbl(iso){ return iso.slice(8,10)+'.'+iso.slice(5,7); }
function rub(n){ return (Number(n)||0).toLocaleString('ru-RU')+' ₽'; }
/** Понятная расшифровка остатка занятиями. */
function moneyNote(k){
  var p=Number(k.price)||0;
  if (!p) return 'Цена занятия не указана — остаток посчитать нельзя.';
  if (k.remainder>0){ var n=Math.floor(k.remainder/p); return 'Оплачено вперёд: ещё '+n+' '+plural(n,'занятие','занятия','занятий')+' ('+rub(k.remainder)+' при цене '+rub(p)+').'; }
  if (k.remainder<0){ var d=Math.ceil(-k.remainder/p); return 'Долг '+rub(-k.remainder)+' — это '+d+' '+plural(d,'занятие','занятия','занятий')+' сверх оплаты.'; }
  return 'Ровно по нулям: оплачено столько, сколько отходил.';
}
function money(n){ return n<0?'debt':(n>0?'ok':'zero'); }
function srub(n){ return (n>0?'+':'')+rub(n); }
function plural(n,a,b,c){ var m=n%10,h=n%100; return m===1&&h!==11?a:(m>=2&&m<=4&&(h<12||h>14)?b:c); }
function toast(t){ var o=document.querySelector('.toast'); if(o) o.remove(); var e=document.createElement('div'); e.className='toast'; e.setAttribute('role','status'); e.setAttribute('aria-live','polite'); e.textContent=t; document.body.appendChild(e); setTimeout(function(){e.remove();},2800); }
function branches(){ return S && S.config ? S.config.branches : []; }
function bname(){ return branches()[bi] || branches()[0]; }
function B(){ return S && S.branches ? S.branches[bname()] : null; }
function kid(id){ var b=B(); if(!b) return null; for (var i=0;i<b.kids.length;i++) if (b.kids[i].id===id) return b.kids[i]; return null; }
function groups(b){ var order=[], map={}; b.kids.forEach(function(k){ if(!map[k.group]){ map[k.group]=[]; order.push(k.group); } map[k.group].push(k); }); return {order:order, map:map}; }
function curIso(){
  var b=B(), n=bname();
  if (!b || !b.dates.length) return today();
  if (b.dates.some(function(d){ return d.iso===sel[n]; })) return sel[n];
  var t=today(), best=b.dates[0].iso;
  b.dates.forEach(function(d){ if (d.iso<=t) best=d.iso; });
  return sel[n]=best;
}

// ======== загрузка ========
function load(silent){
  if (!API){ S=null; render(); return Promise.resolve(); }
  if (loading) return Promise.resolve();
  if (silent && queueCount() && isOnline()) return flush();   // сначала отправим то, что накопилось офлайн
  if (silent && !isOnline()){ kick(0); return Promise.resolve(); }   // связи нет — не дёргаем сеть и не перерисовываем зря
  loading=true; var ep=epoch; if(!silent) render();
  return api('getAppData',[!!silent, (silent && S) ? (S.sig||'') : ''], silent ? 15000 : 25000).then(function(d){
    loading=false; lastLoad=Date.now();
    if (d && d.unchanged) return;                            // сервер: «данные те же» — ничего не качаем
    if (S && (ep!==epoch || pending)) return;                // пока шёл запрос, на экране что-то изменилось — старый ответ не затираем
    var sig=JSON.stringify(d);
    if (silent && sig===lastSig && S) return;               // ничего не изменилось — не перерисовываем
    adopt(d); lastSig=sig;
    if (bi>=branches().length) bi=0;
    if (route()) return;
    render(); refreshSheet();
  }).catch(function(e){
    loading=false;
    if (netErr(e) && S){ if (!silent) toast('Нет связи — работаю с сохранёнными данными'); render(); return; }   // офлайн — работаем на кеше
    if (needKey){ screen='settings'; render(); toast(e.message); return; }   // сервер просит ключ — сразу в настройки
    loadErr=e.message;
    if(!silent){ render(); }
    toast(e.message);
  });
}
/** Куда попадаем после получения данных: стартовый экран только в день тренировки. */
function route(){
  if (!S || !S.configured || screen==='settings' || screen==='leads') return false;
  if (session && session.day !== today()){ session = null; sessionSave(); }   // наступил новый день — спросим заново
  if (session && session.iso && branches().indexOf(session.branch)>=0){      // вернулись в тот же день — восстановим выбор
    bi = branches().indexOf(session.branch);
    if (!sel[session.branch]) sel[session.branch] = session.iso;
  }
  if (session) return false;
  if (screen==='start'){ fixPick(); render(); return true; }          // уже на стартовом экране: не сбрасываем выбор человека
  var tr = trainsToday();
  if (tr.length) { openStart(tr[0]); return true; }                  // сегодня тренировка — стартовый экран
  session = { branch: bname(), iso: null, day: today(), skipped: true }; sessionSave();
  return false;
}
setInterval(function(){
  var a=document.activeElement;
  if (API && (branchScreen(screen)||screen==='more') && !sheetKey && !pending && !loading && document.visibilityState==='visible' && !(a && a.tagName==='INPUT')) load(true);
}, 45000);
document.addEventListener('visibilitychange', function(){ if (document.visibilityState==='visible' && (branchScreen(screen)||screen==='more') && !pending && Date.now()-lastLoad>8000) load(true); });

// ======== главный экран ========
function themeColor(){
  var m=document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', screen==='start' ? '#F3F5FA' : (screen==='home' ? '#172033' : '#F3F5FA'));
}
var lastScreen=null;
function render(){
  var c=document.querySelector('.content'), y=(c && lastScreen===screen)?c.scrollTop:0;
  var ae=document.activeElement, kq=(ae && ae.id==='q')?[ae.selectionStart,ae.selectionEnd]:null;
  renderInner();
  var c2=document.querySelector('.content'); if (c2 && y) c2.scrollTop=y;
  if (kq){ var nq=$('q'); if (nq && document.activeElement!==nq){ nq.focus(); try{ nq.setSelectionRange(kq[0],kq[1]); }catch(e){} } }
  lastScreen=screen;
  decorate();
}
/** Общие штрихи после отрисовки: плашка «нет связи», иллюстрация пустого списка, доступность для клавиатуры. */
function decorate(){
  var app=$('app'); if (!app) return;
  var old=app.querySelector('.netbar'); if (old) old.remove();
  var c=app.querySelector('.content'), qn=queueCount();
  if (c && !app.querySelector('.home') && (!isOnline() || qn) && S && S.configured){
    var n=document.createElement('div'); n.className='netbar'; n.setAttribute('role','status');
    n.innerHTML=(isOnline()?'Отправляю накопленное…':'Нет связи. Отметки сохраняются на телефоне и уйдут сами.')+(qn?' <b>'+qn+' '+plural(qn,'запись ждёт','записи ждут','записей ждут')+'</b>':'');
    c.insertBefore(n,c.firstChild);
  }
  [].slice.call(app.querySelectorAll('.empty')).forEach(function(e){
    if (!e.querySelector('img') && !e.hasAttribute('data-noimg')) e.insertAdjacentHTML('afterbegin','<img class="eimg" src="assets/empty-state.svg" alt="">');
  });
  [].slice.call(document.querySelectorAll('.gseg')).forEach(function(e){ e.classList.toggle('fade', e.scrollWidth>e.clientWidth+2); });
  a11y();
}
/** Кликабельные блоки без кнопки получают роль и фокус, чтобы ими можно было пользоваться с клавиатуры. */
function a11y(){
  [].slice.call(document.querySelectorAll('[onclick]')).forEach(function(e){
    var t=e.tagName; if (t==='BUTTON'||t==='A'||t==='INPUT'||t==='SELECT'||t==='TEXTAREA') return;
    if (!e.hasAttribute('tabindex')){ e.setAttribute('tabindex','0'); e.setAttribute('role','button'); }
  });
}
document.addEventListener('keydown', function(ev){
  if (ev.key==='Escape' && $('bk')){ closeSheet(); return; }
  if (ev.key!=='Enter' && ev.key!==' ') return;
  var t=ev.target; if (t && t.getAttribute && t.getAttribute('role')==='button' && t.tagName!=='BUTTON'){ ev.preventDefault(); t.click(); }
});
function renderInner(){
  themeColor();
  if (screen==='settings') return renderSettings();
  if (screen==='start' && S && S.configured) return renderStart();
  if (screen==='start') screen='main';
  if (screen==='leads') return renderLeads();
  if (branchScreen(screen)||screen==='more'){
    if (!S || !S.configured){ if (screen!=='main') screen='main'; }
    else if (screen==='home') return renderHome();
    else if (screen==='kids') return renderKids();
    else if (screen==='pay') return renderPay();
    else if (screen==='more') return renderMore();
    else if (screen==='sched') return renderSched();
  }
  var c=document.querySelector('.content'), y=c?c.scrollTop:0, st=document.querySelector('.strip'), x=st?st.scrollLeft:null;
  var ae=document.activeElement, keepQ=(ae && ae.id==='q') ? [ae.selectionStart, ae.selectionEnd] : null;   // не терять поиск, пока человек печатает
  var tabs=tabsHtml();
  var h='<div class="top"><div class="row"><div class="logo"><img src="assets/crew-mark.svg" alt=""></div>'+
    '<div class="grow"><div class="title"><img class="wmimg" src="assets/crew-wordmark.svg" alt="CREW"></div><div class="sub">'+(S&&S.configured?esc(S.monthLabel):'не подключено')+'</div></div>'+
    '<button class="ib" onclick="openSettings()" aria-label="Настройки">'+IC.gear+'</button></div>'+
    tabs+'</div>';

  if (!S && loading) h+='<div class="center"><div class="spinner"></div></div>';
  else if (API && !S) h+='<div class="content"><div class="empty"><h3>Не удалось загрузить данные</h3>'+esc(loadErr||'Проверьте интернет и повторите.')+'<button class="btn p" style="max-width:260px;margin:18px auto 0" onclick="loadErr=\'\';load()">Повторить</button><button class="btn q" style="max-width:260px;margin:4px auto 0" onclick="openSettings()">Настройки</button></div></div>';
  else if (!S || !S.configured) h+='<div class="content"><div class="empty"><h3>Приложение не подключено</h3>Укажите адрес сервера в настройках — он выдаётся при публикации скрипта из таблицы.<button class="btn p" style="max-width:260px;margin:18px auto 0" onclick="openSettings()">Открыть настройки</button></div></div>';
  else {
    var b=B();
    h+='<div class="content">';
    if (b.error) h+='<div class="err">'+esc(b.error)+'</div>';
    else h+=(updateReady?'<div class="banner"><span>Вышла новая версия приложения.</span><button onclick="location.reload()">Обновить</button></div>':'')+
      (monthBehind()?('<div class="banner"><span>Начался новый месяц, а таблица ещё за <b>'+esc(S.monthLabel)+'</b>.</span><button onclick="newMonth()">Открыть новый месяц</button></div>'):'')+
      calWarn(bname())+
      strip(b)+summary(b)+'<input class="search" id="q" type="search" placeholder="Найти ребёнка" value="'+esc(q)+'" oninput="q=this.value;filter()">'+list(b);
    h+='</div>';
    // кнопки «+» здесь нет намеренно: плавающая кнопка перекрывала бы собой отметку одного из детей.
    // Добавить ребёнка можно на вкладке «Ученики».
  }
  if (S && S.configured) h+=navHtml('main');
  $('app').innerHTML=h;
  filter();
  c=document.querySelector('.content'); if(c) c.scrollTop=y;
  if (keepQ){ var nq=$('q'); if (nq){ nq.focus(); try{ nq.setSelectionRange(keepQ[0],keepQ[1]); }catch(e){} } }
  st=document.querySelector('.strip');
  if (st){ if (x!==null) st.scrollLeft=x; else { var s=st.querySelector('.sel'); if(s) st.scrollLeft=s.offsetLeft-st.clientWidth/2+s.clientWidth/2; } }
}
function tabsHtml(){
  if (!S || !S.configured) return '';
  var t=branches().map(function(n,i){
    return '<div class="tab'+(i===bi?' on':'')+'" onclick="setBranch('+i+')">'+esc(n)+'</div>';
  }).join('');
  return '<div class="tabs">'+t+'</div>';
}
/** Таблица отстала от реального месяца (на случай, если сервер сам этого не пометил). */
function monthBehind(){
  if (S.monthBehind) return true;
  if (!S.month) return false;
  var n=new Date();
  return (S.month.year*12+S.month.monthIdx) < (n.getFullYear()*12+n.getMonth());
}
/** Сравнивает даты тренировок в таблице с расписанием (днями недели). Дни с отметками — не ошибка, их сервер оставляет сознательно. */
function calendarProblem(d, name){
  try{
    var b=d.branches[name], days=d.days && d.days[name];
    if (!b || b.error || !days || !days.length || !d.month) return null;
    var y=d.month.year, m=d.month.monthIdx, n=new Date(y,m+1,0).getDate(), want={}, have={}, missing=[], extra=[];
    for (var i=1;i<=n;i++){ if (days.indexOf(DOW[new Date(y,m,i).getDay()])>=0) want[y+'-'+pad(m+1)+'-'+pad(i)]=1; }
    (b.dates||[]).forEach(function(x){ have[x.iso]=1; });
    Object.keys(want).sort().forEach(function(iso){ if (!have[iso]) missing.push(iso); });
    Object.keys(have).sort().forEach(function(iso){
      if (want[iso]) return;
      if ((b.kids||[]).some(function(k){ return k.attendance && k.attendance[iso]; })) return;
      extra.push(iso);
    });
    return (missing.length||extra.length) ? {missing:missing, extra:extra} : null;
  }catch(e){ return null; }
}
function calKey(name, p){ return 'bk72_calok_'+S.month.year+'-'+S.month.monthIdx+'_'+name+'_'+p.missing.join(',')+'|'+p.extra.join(','); }
function calWarn(name){
  if (!S || !S.configured) return '';
  var p=calendarProblem(S, name); if (!p) return '';
  try{ if (localStorage.getItem(calKey(name,p))) return ''; }catch(e){}
  var parts=[];
  if (p.missing.length) parts.push('нет дней: <b>'+p.missing.map(lbl).join(', ')+'</b>');
  if (p.extra.length) parts.push('лишние: <b>'+p.extra.map(lbl).join(', ')+'</b>');
  return '<div class="banner"><span>Даты в календаре не совпадают с расписанием ('+parts.join('; ')+').</span>'+
    '<button onclick="fixCalendar(\''+esc(name)+'\')">Исправить</button>'+
    '<button class="alt" onclick="calOk(\''+esc(name)+'\')">Так и надо</button></div>';
}
function calOk(name){
  var p=calendarProblem(S,name); if (!p) return;
  try{ localStorage.setItem(calKey(name,p),'1'); }catch(e){}
  if (screen==='start') renderStart(); else render();
}
/** Пересобрать календарь филиала по расписанию (дни с отметками сервер оставляет). */
function fixCalendar(name){
  var days=(S.days&&S.days[name])||[]; if (!days.length) return;
  begin(); toast('Исправляю календарь…');
  api('setBranchDays',[name,days],90000).then(function(d){
    adopt(d); lastSig=''; toast('Календарь приведён к расписанию'); render();
  }).catch(function(e){ toast('Не получилось: '+e.message); }).then(function(){ end(); });
}
function leads(){ return (S && S.leads) ? S.leads.filter(function(l){ return l.status!==DONE; }) : []; }   // зачисленные из списка пропадают
function activeLeads(){ return leads().filter(function(l){ return l.status!==DONE; }); }
var DONE='Занимается';
function setBranch(i){ bi=i; gf=''; if(!branchScreen(screen)||screen==='home') screen='main'; try{localStorage.setItem('bk72_branch',i);}catch(e){} var st=document.querySelector('.strip'); if(st) st.remove(); var c=document.querySelector('.content'); if(c) c.scrollTop=0; render(); }

function strip(b){
  if (!b.dates.length) return '<div class="err">В таблице нет дат тренировок (строка 2, начиная со столбца K).</div>';
  var s=curIso(), t=today();
  return '<div class="strip">'+b.dates.map(function(d){
    var n=b.kids.filter(function(k){ return k.attendance[d.iso]; }).length;
    return '<div class="chip'+(d.iso===s?' sel':'')+(d.iso===t?' today':'')+'" onclick="pickDate(\''+d.iso+'\')"><div class="dw">'+d.dow+'</div><div class="dd">'+d.label.slice(0,2)+'</div><div class="ct">'+(n||'–')+'</div></div>';
  }).join('')+'</div>';
}
function pickDate(iso){ sel[bname()]=iso; render(); }
function summary(b){
  var s=curIso(), d=new Date(s+'T12:00:00'), n=b.kids.filter(function(k){ return k.attendance[s]; }).length;
  var mark = s===today() ? '<span class="tag g">сегодня</span>' : (s>today() ? '<span class="tag f">ещё не прошла</span>' : '<span class="tag w">другой день</span>');
  var qn = queueCount();
  if (!isOnline() || qn) mark += '<span class="tag off">'+(isOnline()?'':'офлайн')+(qn?(isOnline()?'':' · ')+qn+' ждут':'')+'</span>';
  return '<div class="summary">'+
    '<button class="datebtn" onclick="openStart(bi)" aria-label="Сменить филиал или дату">'+DOW[d.getDay()].toLowerCase()+', '+d.getDate()+' '+GEN[d.getMonth()]+IC.down+'</button>'+
    mark+'<span class="came">пришли <b>'+n+'</b> из '+b.kids.length+'</span></div>'+
    (s<=today()&&b.kids.length?'<div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="'+b.kids.length+'" aria-valuenow="'+n+'"><i style="width:'+Math.round(n/b.kids.length*100)+'%"></i></div>':'');
}
var AWAY = 4;                       // столько пропущенных подряд = «давно не было»
var sortMode = 'sheet';          // по умолчанию порядок спокойный, никто не «прыгает»
var showSort = false;            // переключатель порядка открывается по кнопке и не занимает строку постоянно
function toggleSort(){ showSort=!showSort; render(); }
var SORTNAME = {sheet:'', visits:'по посещаемости', debt:'только долги'};
function setSort(m){ sortMode=m; showSort=false; render(); }   // режим не запоминается: после перезапуска — снова обычный порядок
function away(k){ return (k.missed||0) >= AWAY; }
function sortKids(a){
  if (sortMode!=='visits') return a;
  return a.slice().sort(function(x,y){ return (y.visits-x.visits) || x.name.localeCompare(y.name,'ru'); });
}
function kidCard(k, s){
  var on=!!k.attendance[s], future=s>today();
  if (k.pendingNew) return '<div class="card" data-n="'+esc(k.name.toLowerCase())+'"><div class="main"><div class="nm">'+esc(k.name)+'</div>'+
    '<div class="meta"><span class="pill miss">ждёт отправки в таблицу</span></div></div></div>';
  return '<div class="card" data-n="'+esc(k.name.toLowerCase())+'"><div class="main" onclick="openKid(\''+k.id+'\')"><div class="nm">'+esc(k.name)+'</div>'+
    '<div class="meta"><span class="pill v">'+k.visits+' зан.</span><span class="pill '+money(k.remainder)+'">'+srub(k.remainder)+'</span>'+
    (away(k)?'<span class="pill miss">'+k.missed+' '+plural(k.missed,'пропуск','пропуска','пропусков')+' подряд</span>':'')+'</div></div>'+
    '<button class="mark'+(on?' on':'')+(future&&!on?' future':'')+(on&&isArmed(k.id,s)?' armed':'')+'" data-k="'+esc(markKey(k.id,s))+'" onclick="toggle(\''+k.id+'\',\''+s+'\')" aria-label="'+(on?'Снять отметку (нажать дважды)':'Отметить')+'">'+(isArmed(k.id,s)?IC.x:IC.check)+'</button></div>';
}
/** Выбор группы: «Все группы» + по одной кнопке на группу. Показывается, только если групп больше одной. */
function gchips(kids){
  var g=groups({kids:kids}).order;
  if (gf && g.indexOf(gf)<0) gf='';
  if (g.length<2) return '';
  return '<div class="seg gseg" role="group" aria-label="Группа"><button class="'+(gf===''?'on':'')+'" onclick="setGF(\'\')">Все группы</button>'+
    g.map(function(n){ return '<button class="'+(gf===n?'on':'')+'" data-g="'+esc(n)+'" onclick="setGF(this.getAttribute(\'data-g\'))">'+esc(n)+'</button>'; }).join('')+'</div>';
}
function setGF(n){ gf=n; render(); }
function list(b){
  if (!b.kids.length) return '<div class="empty"><h3>Пока нет детей</h3>Добавьте первого на вкладке «Ученики».<button class="btn p" style="max-width:260px;margin:16px auto 0" onclick="go(\'kids\')">Открыть «Ученики»</button></div>';
  var s=curIso();
  var pool=gf?b.kids.filter(function(k){ return k.group===gf; }):b.kids;
  var act=pool.filter(function(k){ return !away(k); }), gone=pool.filter(away);
  var debts=pool.filter(function(k){ return k.remainder<0; });
  var h='<div class="filterrow">'+gchips(b.kids)+
      '<button class="sortbtn'+(sortMode!=='sheet'?' on':'')+(showSort?' open':'')+'" onclick="toggleSort()" aria-expanded="'+(showSort?'true':'false')+'" aria-label="Порядок списка">'+
      IC.sort+(SORTNAME[sortMode]?'<span>'+SORTNAME[sortMode]+'</span>':'')+'</button></div>'+
    (showSort?('<div class="sortbar"><button class="'+(sortMode==='sheet'?'on':'')+'" onclick="setSort(\'sheet\')">Свой порядок</button>'+
        '<button class="'+(sortMode==='visits'?'on':'')+'" onclick="setSort(\'visits\')">Посещаемость</button>'+
        '<button class="'+(sortMode==='debt'?'on':'')+'" onclick="setSort(\'debt\')">Долги'+(debts.length?' <b>'+debts.length+'</b>':'')+'</button></div>'):'');
  if (sortMode==='debt'){
    if (!debts.length) return h+'<div class="empty"><h3>Долгов нет</h3>У всех детей баланс в плюсе или в нуле.</div>';
    var dk=debts.slice().sort(function(x,y){ return x.remainder-y.remainder; });
    var total=dk.reduce(function(a,k){ return a+k.remainder; },0);
    return h+'<div class="grp"><div class="gh"><span>Должники</span><span>'+rub(-total)+'</span></div>'+
      dk.map(function(k){ return kidCard(k,s); }).join('')+'</div>';
  }
  var g=groups({kids:act});
  h+=g.order.map(function(name){
    var kk=sortKids(g.map[name]);
    var came=kk.filter(function(k){ return k.attendance[s]; }).length;
    return '<div class="grp"><div class="gh"><span>'+esc(name)+'</span><span>'+came+' / '+kk.length+'</span></div>'+
      kk.map(function(k){ return kidCard(k,s); }).join('')+'</div>';
  }).join('');
  if (gone.length){
    var gk=gone.slice().sort(function(x,y){ return (y.missed-x.missed) || x.name.localeCompare(y.name,'ru'); });
    h+='<div class="grp away"><div class="gh"><span>Давно не было</span><span>'+gone.length+'</span></div>'+
      '<div class="hint" style="padding:0 2px 8px">Пропустили '+AWAY+' тренировки подряд и больше — это примерно две недели.</div>'+
      gk.map(function(k){
        return '<div class="card" data-n="'+esc(k.name.toLowerCase())+'"><div class="main" onclick="openKid(\''+k.id+'\')"><div class="nm">'+esc(k.name)+'</div>'+
          '<div class="meta"><span class="pill miss">'+k.missed+' подряд</span>'+
          '<span class="pill v">'+(k.lastVisit?('был '+lbl(k.lastVisit)):'не был')+'</span>'+
          '<span class="pill '+money(k.remainder)+'">'+srub(k.remainder)+'</span>'+
          '<span class="pill grp">'+esc(k.group)+'</span></div></div>'+
          '<button class="mark'+(k.attendance[s]?' on':'')+(k.attendance[s]&&isArmed(k.id,s)?' armed':'')+'" data-k="'+esc(markKey(k.id,s))+'" onclick="toggle(\''+k.id+'\',\''+s+'\')" aria-label="'+(k.attendance[s]?'Снять отметку (нажать дважды)':'Отметить')+'">'+(isArmed(k.id,s)?IC.x:IC.check)+'</button></div>';
      }).join('')+'</div>';
  }
  return h;
}
function filter(){
  var v=q.trim().toLowerCase();
  document.querySelectorAll('.card[data-n]').forEach(function(e){ e.hidden = !!v && e.getAttribute('data-n').indexOf(v)<0; });
  document.querySelectorAll('.grp').forEach(function(g){ g.hidden = !!v && !g.querySelector('.card:not([hidden])'); });
}

function moveKid(id, dir){
  var branch=bname(), b0=B(), k=kid(id);
  if (!k) return;
  var same=b0.kids.filter(function(x){ return x.group===k.group; });
  var i=same.indexOf(k), j=i+(dir<0?-1:1);
  if (i>=0 && j>=0 && j<same.length){                    // меняем местами сразу на экране
    var a=b0.kids.indexOf(same[i]), b2=b0.kids.indexOf(same[j]);
    b0.kids[a]=same[j]; b0.kids[b2]=same[i];
    cacheSave(S); render(); openKid(id);
  }
  begin();
  send('moveChild',[branch,id,dir]).then(function(b){
    if (b && b.queued) return;
    if (b && b.kids){ putBranch(branch,b); cacheSave(S); render(); refreshSheet(); }
  }).catch(function(e){ toast('Порядок не сохранился: '+e.message); }).then(function(){ end(); });
}

// ======== новая навигация и экраны ========
function branchScreen(s){ return s==='main'||s==='home'||s==='kids'||s==='pay'||s==='sched'; }
function navHtml(active){
  var n=activeLeads().length;
  var it=[['home','Главная',IC.home],['main','Отметки',IC.cal],['kids','Ученики',IC.users],['pay','Оплаты',IC.wallet],['more','Ещё',IC.more]];
  return '<nav class="bar" aria-label="Основная навигация">'+it.map(function(x){
    return '<button class="'+(x[0]===active?'on':'')+'"'+(x[0]===active?' aria-current="page"':'')+' onclick="go(\''+x[0]+'\')">'+x[2]+'<span>'+x[1]+'</span>'+(x[0]==='more'&&n?'<b class="nb">'+n+'</b>':'')+'</button>';
  }).join('')+'</nav>';
}
function go(s){
  closeSheet(); if (screen!==s) q='';
  screen=s; render();
  if (s==='home'||s==='pay') loadPayLog();
}
function topbar(t, sub, br){
  return '<div class="top"><div class="row"><div class="logo"><img src="assets/crew-mark.svg" alt=""></div>'+
    '<div class="grow"><div class="title">'+t+'</div><div class="sub">'+sub+'</div></div>'+
    '<button class="ib" onclick="openSettings()" aria-label="Настройки">'+IC.gear+'</button></div>'+(br?tabsHtml():'')+'</div>';
}
function initials(n){ var w=String(n).trim().split(/\s+/); return ((w[0]||'?').charAt(0)+(w[1]?w[1].charAt(0):'')).toUpperCase(); }
var AVC=[['#E8EDFF','#4058D8'],['#E8EDF5','#334155'],['#E7F3F5','#176B78'],['#E9F5EF','#24764F'],['#EEE9FF','#6546A5'],['#E4F0FF','#245C9A']];
function avatar(n){ var c=AVC[(String(n).charCodeAt(0)+String(n).length)%AVC.length]; return '<div class="av" style="background:'+c[0]+';color:'+c[1]+'">'+esc(initials(n))+'</div>'; }

// --- журнал оплат (для «Оплаты» и плитки на главной) ---
var payLog=null, payLogAt=0, payLogLoading=false, paySeg='log', kf='all', hb=-1;
function curPayLog(){
  if (payLog) return payLog;
  try{ var v=JSON.parse(localStorage.getItem('bk72_paylog')||'null'); if (v && S && v.k===S.monthLabel && Array.isArray(v.l)){ payLog=v.l; payLogAt=v.t||0; return v.l; } }catch(e){}
  return null;
}
function loadPayLog(force){
  if (!API || !S || !isOnline() || payLogLoading) return;
  if (!force && curPayLog() && Date.now()-payLogAt < 120000) return;      // свежее — хватит и сохранённого
  payLogLoading=true;
  api('getPaymentLog',[300]).then(function(l){
    payLog=Array.isArray(l)?l:[]; payLogAt=Date.now();
    try{ localStorage.setItem('bk72_paylog', JSON.stringify({k:S.monthLabel, t:payLogAt, l:payLog})); }catch(e){}
  }).catch(function(){}).then(function(){ payLogLoading=false; if (screen==='home'||screen==='pay') render(); });
}
function monthPay(){
  var l=curPayLog(); if(!l||!S||!S.month) return null;
  var n=new Date(S.month.year,S.month.monthIdx+1,0).getDate(), by=[], total=0, i;
  for(i=0;i<=n;i++) by.push(0);
  l.forEach(function(r){
    var d=parseInt(String(r.date).slice(0,2),10), m=parseInt(String(r.date).slice(3,5),10), a=Number(r.amount)||0;
    if (m && m!==S.month.monthIdx+1) return;
    total+=a; if (d>=1 && d<=n) by[d]+=a;
  });
  return {total:total, by:by, days:n, list:l};
}

// --- Главная ---
function setHB(i){ hb=i; render(); }
function homeGo(s){ if (hb>=0){ bi=hb; try{localStorage.setItem('bk72_branch',bi);}catch(e){} } go(s); }
function homeStats(sel){
  var kids=0, grs={}, debt=0, debtN=0;
  branches().forEach(function(n,i){
    if (sel>=0 && sel!==i) return;
    var b=S.branches[n]; if(!b||b.error) return;
    b.kids.forEach(function(k){ kids++; grs[n+'|'+k.group]=1; if (k.remainder<0){ debt+=k.remainder; debtN++; } });
  });
  return {kids:kids, groups:Object.keys(grs).length, debt:debt, debtN:debtN};
}
function whenLbl(iso){
  var t=today(), d=new Date(iso+'T12:00:00'), n=new Date(); n.setDate(n.getDate()+1);
  var tm=n.getFullYear()+'-'+pad(n.getMonth()+1)+'-'+pad(n.getDate());
  if (iso===t) return 'Сегодня'; if (iso===tm) return 'Завтра';
  return DOW[d.getDay()].toLowerCase()+', '+d.getDate()+' '+GEN[d.getMonth()];
}
function upcoming(sel){
  var t=today(), out=[];
  branches().forEach(function(n,i){
    if (sel>=0 && sel!==i) return;
    var b=S.branches[n]; if(!b||b.error) return;
    (b.dates||[]).forEach(function(d){ if (d.iso>=t) out.push({bi:i,name:n,iso:d.iso,kids:b.kids.length}); });
  });
  out.sort(function(x,y){ return x.iso<y.iso?-1:(x.iso>y.iso?1:x.bi-y.bi); });
  return out.slice(0,5);
}
function goTrain(i, iso){ bi=i; try{localStorage.setItem('bk72_branch',i);}catch(e){} sel[bname()]=iso; q=''; screen='main'; render(); }
function alertsHtml(names){
  return (updateReady?'<div class="banner"><span>Вышла новая версия приложения.</span><button onclick="location.reload()">Обновить</button></div>':'')+
    (monthBehind()?('<div class="banner"><span>Начался новый месяц, а таблица ещё за <b>'+esc(S.monthLabel)+'</b>.</span><button onclick="newMonth()">Открыть новый месяц</button></div>'):'')+
    names.map(calWarn).join('');
}
function tile(ic, val, label, click, cls){
  return '<button class="tile'+(cls?' '+cls:'')+'" onclick="'+click+'">'+ic+'<b>'+val+'</b><span>'+label+'</span></button>';
}
function renderHome(){
  var st=homeStats(hb), mp=monthPay(), nl=activeLeads().length;
  var names = hb>=0 ? [branches()[hb]] : branches();
  var h='<div class="content home"><div class="hero"><div class="hrow"><img class="wmimg light" src="assets/crew-wordmark-light.svg" alt="CREW">'+
    '<button class="ib dk" onclick="openSettings()" aria-label="Настройки">'+IC.gear+'</button></div>'+
    '<div class="hi">'+esc(greet())+'</div><div class="hd">'+esc(humanDate(today()))+' · '+esc(S.monthLabel)+(isOnline()?'':' · офлайн')+'</div>'+
    '<div class="hsel">'+['Все филиалы'].concat(branches()).map(function(n,i){ return '<button class="'+(i-1===hb?'on':'')+'" onclick="setHB('+(i-1)+')">'+esc(n)+'</button>'; }).join('')+'</div></div>'+
    '<div class="tiles">'+
      tile(IC.users, st.kids, plural(st.kids,'ученик','ученика','учеников'), "homeGo('kids')")+
      tile(IC.cal, st.groups, plural(st.groups,'группа','группы','групп'), "homeGo('main')")+
      tile(IC.wallet, mp?rub(mp.total):'…', 'оплаты в этом месяце', "paySeg='log';homeGo('pay')")+
      tile(IC.warn, st.debtN, st.debtN?('должников · '+rub(-st.debt)):'долгов нет', "paySeg='debt';homeGo('pay')", st.debtN?'bad':'')+
    '</div>'+alertsHtml(names);
  if (nl) h+='<button class="row2" onclick="openLeads()"><div class="grow"><b>Записались на пробное</b><span>ждут зачисления в группу</span></div><i class="cnt2">'+nl+'</i>'+IC.chev+'</button>';
  var up=upcoming(hb);
  h+='<div class="home-layout"><section class="home-schedule"><div class="home-section-head"><div><div class="eyebrow">ПЛАН РАБОТЫ</div><h2>Ближайшие занятия</h2></div><button class="text-action" onclick="go(&quot;sched&quot;)">Все расписание '+IC.chev+'</button></div>';
  h+='<div class="up-list">'+(up.length ? up.map(function(u){
      return '<div class="up'+(u.iso===today()?' today':'')+'" onclick="goTrain('+u.bi+',\''+u.iso+'\')"><div class="up-date"><span>'+esc(whenLbl(u.iso))+'</span><i></i></div><div class="grow"><div class="uw">'+esc(u.name)+'</div><div class="us">'+u.kids+' '+plural(u.kids,'ребёнок','ребёнка','детей')+'</div></div><span class="chev">'+IC.chev+'</span></div>';
    }).join('') : '<div class="hint" style="padding:12px 2px">В этом месяце занятий больше нет.</div>')+'</div></section>';
  h+='<aside class="home-aside"><section class="aside-card"><div class="aside-title"><div><div class="eyebrow">СТРУКТУРА CREW</div><h2>Площадки</h2></div><span class="aside-count">'+branches().length+'</span></div>';
  h+=branches().map(function(n,i){
    var b=S.branches[n], kids=(b&&Array.isArray(b.kids))?b.kids:[], gs={};
    kids.forEach(function(k){ gs[k.group]=1; });
    return '<button class="branch-row'+(hb===i?' active':'')+'" onclick="setHB('+i+')"><span class="branch-dot"></span><span class="branch-copy"><b>'+esc(n)+'</b><small>'+Object.keys(gs).length+' '+plural(Object.keys(gs).length,'группа','группы','групп')+'</small></span><strong>'+kids.length+'</strong>'+IC.chev+'</button>';
  }).join('');
  h+='</section><section class="aside-card quick-card"><div class="eyebrow">БЫСТРЫЙ ДОСТУП</div><h2>Что делаем?</h2><button class="quick-action" onclick="homeGo(&quot;main&quot;)">'+IC.cal+'<span>Отметить посещаемость</span>'+IC.chev+'</button><button class="quick-action" onclick="homeGo(&quot;kids&quot;)">'+IC.users+'<span>Открыть учеников</span>'+IC.chev+'</button><button class="quick-action" onclick="paySeg=&quot;debt&quot;;homeGo(&quot;pay&quot;)">'+IC.wallet+'<span>Проверить задолженности</span>'+IC.chev+'</button></section></aside></div>';
  $('app').innerHTML=h+'</div>'+navHtml('home');
}

// --- Ученики ---
function setKF(f){ kf=f; render(); }
function renderKids(){
  var b=B(); if (!b || b.error){ $('app').innerHTML=topbar('Ученики',esc(bname()),true)+'<div class="content"><div class="err">'+esc(b&&b.error||'Нет данных')+'</div></div>'+navHtml('kids'); return; }
  var all=b.kids, act=all.filter(function(k){ return !away(k); }), debts=all.filter(function(k){ return k.remainder<0; });
  var gl=gchips(all);
  var inG=function(a){ return gf?a.filter(function(k){ return k.group===gf; }):a; };
  var list= inG(kf==='debt'?debts : (kf==='act'?act : all));
  var h=topbar('Ученики', esc(bname())+' · '+all.length, true)+'<div class="content">'+
    '<input class="search" id="q" type="search" placeholder="Поиск по имени" value="'+esc(q)+'" oninput="q=this.value;filter()">'+
    '<div class="seg">'+[['all','Все',all.length],['act','Активные',act.length],['debt','Долги',debts.length]].map(function(x){
      return '<button class="'+(kf===x[0]?'on':'')+(x[0]==='debt'&&x[2]?' red':'')+'" onclick="setKF(\''+x[0]+'\')">'+x[1]+' <b>'+x[2]+'</b></button>'; }).join('')+'</div>'+gl;
  if (!list.length) h+='<div class="empty"><h3>'+(kf==='debt'?'Долгов нет':'Никого нет')+'</h3>'+(kf==='debt'?'У всех баланс в плюсе или в нуле.':'Добавьте ребёнка кнопкой «+».')+'</div>';
  var g=groups({kids:list});
  h+=g.order.map(function(name){
    return '<div class="grp"><div class="gh"><span>'+esc(name)+'</span><span>'+g.map[name].length+'</span></div>'+
      g.map[name].map(function(k){
        if (k.pendingNew) return '<div class="card" data-n="'+esc(k.name.toLowerCase())+'">'+avatar(k.name)+'<div class="main"><div class="nm">'+esc(k.name)+'</div><div class="meta"><span class="pill miss">ждёт отправки в таблицу</span></div></div></div>';
        return '<div class="card" data-n="'+esc(k.name.toLowerCase())+'" onclick="openKid(\''+k.id+'\')">'+avatar(k.name)+
          '<div class="main"><div class="nm">'+esc(k.name)+'</div><div class="meta"><span class="pill grp0">'+k.visits+' зан.'+(k.payType==='РАЗОВОЕ'?' · разовое':'')+'</span>'+
          (k.remainder<0?'<span class="pill debt">Долг '+rub(-k.remainder)+'</span>':'')+
          (away(k)?'<span class="pill miss">'+k.missed+' '+plural(k.missed,'пропуск','пропуска','пропусков')+' подряд</span>':'')+'</div></div><span class="chev">'+IC.chev+'</span></div>';
      }).join('')+'</div>';
  }).join('');
  $('app').innerHTML=h+'</div><button class="fab" onclick="openAdd()" aria-label="Добавить ребёнка">'+IC.plus+'</button>'+navHtml('kids');
  filter();
}

// --- Оплаты ---
function setPS(s){ paySeg=s; render(); if (s==='log') loadPayLog(); }
function renderPay(){
  var b=B(), mp=monthPay(), debts=(b&&b.kids?b.kids:[]).filter(function(k){ return k.remainder<0; });
  var h=topbar('Оплаты', esc(S.monthLabel), paySeg!=='log')+'<div class="content">'+
    '<div class="seg">'+[['log','Оплаты',''],['abon','Абонементы',''],['debt','Долги',debts.length]].map(function(x){
      return '<button class="'+(paySeg===x[0]?'on':'')+(x[0]==='debt'&&x[2]?' red':'')+'" onclick="setPS(\''+x[0]+'\')">'+x[1]+(x[2]!==''?' <b>'+x[2]+'</b>':'')+'</button>'; }).join('')+'</div>';
  if (paySeg==='log'){
    if (!mp) h+='<div class="empty"><h3>'+(isOnline()?'Загружаю оплаты…':'Нет связи')+'</h3>'+(isOnline()?'':'История оплат появится, когда будет интернет.')+'</div>';
    else {
      var max=0, i; for(i=1;i<=mp.days;i++) if (mp.by[i]>max) max=mp.by[i];
      var ax=[1,8,15,22,mp.days].filter(function(v,j,a){ return a.indexOf(v)===j && v<=mp.days; });
      var single=mp.list.filter(function(r){ return /разов/i.test(String(r.type)); }).length, abon=mp.list.length-single;
      var avg=mp.list.length?Math.round(mp.total/mp.list.length):0;
      var days=0; for(i=1;i<=mp.days;i++) if (mp.by[i]) days++;
      h+='<div class="big">'+rub(mp.total)+'</div><div class="bigs">Поступления за '+esc(S.monthLabel.toLowerCase())+'</div>'+
        '<div class="pstats">'+mp.list.length+' '+plural(mp.list.length,'оплата','оплаты','оплат')+
        ' · в среднем <b>'+rub(avg)+'</b> · '+abon+' '+plural(abon,'абонемент','абонемента','абонементов')+
        (single?(', '+single+' '+plural(single,'разовое','разовых','разовых')):'')+
        ' · '+days+' '+plural(days,'день','дня','дней')+' с оплатами</div>'+
        '<div class="bars">'+(function(){ var s=''; for(var d=1;d<=mp.days;d++) s+='<i class="'+(mp.by[d]?'':'z')+'" style="height:'+(mp.by[d]&&max?Math.max(8,Math.round(mp.by[d]/max*100)):4)+'%" title="'+d+': '+rub(mp.by[d])+'"></i>'; return s; })()+'</div>'+
        '<div class="axis">'+ax.map(function(d){ return '<span>'+d+'</span>'; }).join('')+'</div>'+
        '<div class="sech"><b>Последние оплаты</b></div>';
      h+= mp.list.length ? mp.list.slice(0,40).map(function(r){
        return '<div class="card"><div class="main"><div class="nm">'+esc(r.name)+'</div><div class="hint" style="margin:2px 0 0">'+esc(String(r.date).slice(0,5))+' · '+esc(r.type)+'</div></div><div class="am2">'+rub(r.amount)+'</div></div>';
      }).join('') : '<div class="hint">Оплат через приложение в этом месяце не было.</div>';
    }
  } else if (paySeg==='abon'){
    var ab=(b&&b.kids?b.kids:[]).filter(function(k){ return k.payType!=='РАЗОВОЕ' && !k.pendingNew; });
    h+= ab.length ? ab.map(function(k){
      var left = k.price>0 ? Math.floor(k.remainder/k.price) : 0;
      var note = k.remainder<0 ? 'Долг '+rub(-k.remainder) : (left>0 ? 'Оплачено ещё '+left+' '+plural(left,'занятие','занятия','занятий') : 'Оплачено ровно по нулям');
      return '<div class="card" onclick="openKid(\''+k.id+'\')">'+avatar(k.name)+'<div class="main"><div class="nm">'+esc(k.name)+'</div><div class="hint" style="margin:2px 0 0">'+esc(note)+' · '+esc(k.group)+'</div></div>'+
        '<span class="pill '+money(k.remainder)+'">'+srub(k.remainder)+'</span></div>';
    }).join('') : '<div class="empty"><h3>Нет абонементов</h3>В этом филиале никто не платит абонементом.</div>';
  } else {
    if (!debts.length) h+='<div class="empty"><h3>Долгов нет</h3>У всех детей баланс в плюсе или в нуле.</div>';
    else {
      var dk=debts.slice().sort(function(x,y){ return x.remainder-y.remainder; }), tot=dk.reduce(function(a,k){ return a+k.remainder; },0);
      h+='<div class="big bad">'+rub(-tot)+'</div><div class="bigs">Задолженность · '+dk.length+' '+plural(dk.length,'должник','должника','должников')+'</div>'+
        dk.map(function(k){
          return '<div class="card">'+avatar(k.name)+'<div class="main" onclick="openKid(\''+k.id+'\')"><div class="nm">'+esc(k.name)+'</div><div class="hint" style="margin:2px 0 0">'+esc(k.group)+'</div></div>'+
            '<span class="pill debt">'+rub(-k.remainder)+'</span><button class="mini-btn" onclick="openPay(\''+k.id+'\')">Оплата</button></div>';
        }).join('');
    }
  }
  $('app').innerHTML=h+'</div>'+navHtml('pay');
}

// --- Расписание месяца ---
var MSH=['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
function monday(iso){ var d=new Date(iso+'T12:00:00'), w=(d.getDay()+6)%7; d.setDate(d.getDate()-w); return d; }
function renderSched(){
  var b=B(), t=today();
  var h=topbar('Расписание', esc(S.monthLabel)+' · '+esc(bname()), true)+'<div class="content">';
  if (!b || b.error || !b.dates.length){
    h+='<div class="empty"><h3>Нет дат тренировок</h3>'+(b&&b.error?esc(b.error):'Дни недели выбираются в настройках, календарь собирается по ним.')+'<button class="btn s" style="max-width:260px;margin:14px auto 0" onclick="openSettings()">Открыть настройки</button></div>';
  } else {
    h+=calWarn(bname());
    var weeks=[], map={};
    b.dates.forEach(function(d){ var m=monday(d.iso), k=m.getTime(); if(!map[k]){ map[k]={m:m,list:[]}; weeks.push(map[k]); } map[k].list.push(d); });
    weeks.forEach(function(w){
      var e=new Date(w.m.getTime()); e.setDate(e.getDate()+6);
      var lab=w.m.getDate()+(w.m.getMonth()===e.getMonth()?'':' '+MSH[w.m.getMonth()])+'–'+e.getDate()+' '+MSH[e.getMonth()];
      h+='<div class="grp"><div class="gh"><span>'+lab+'</span><span>'+w.list.length+' '+plural(w.list.length,'занятие','занятия','занятий')+'</span></div>'+
        w.list.map(function(d){
          var n=b.kids.filter(function(k){ return k.attendance[d.iso]; }).length, st=d.iso===t?['g','сегодня']:(d.iso>t?['f','впереди']:['w','прошло']);
          return '<div class="up'+(d.iso===t?' today':'')+'" onclick="goTrain('+bi+',\''+d.iso+'\')"><div class="dbadge"><small>'+d.dow+'</small><b>'+d.label.slice(0,2)+'</b></div>'+
            '<div class="grow"><div class="uw">'+esc(humanDate(d.iso))+' <span class="tag '+st[0]+'">'+st[1]+'</span></div><div class="us">'+esc(bname())+' · '+(d.iso>t?b.kids.length+' '+plural(b.kids.length,'ребёнок','ребёнка','детей'):'пришли '+n+' из '+b.kids.length)+'</div></div><span class="chev">'+IC.chev+'</span></div>';
        }).join('')+'</div>';
    });
    h+='<div class="hint" style="margin-top:6px">Тап по дню открывает отметки на эту дату. Дни недели меняются в настройках.</div>';
  }
  $('app').innerHTML=h+'</div>'+navHtml('more');
}

// --- Ещё ---
function moreRow(ic, t, s, click, badge){
  return '<button class="row2" onclick="'+click+'">'+ic+'<div class="grow"><b>'+t+'</b>'+(s?'<span>'+s+'</span>':'')+'</div>'+(badge?'<i class="cnt2">'+badge+'</i>':'')+IC.chev+'</button>';
}
function renderMore(){
  var n=activeLeads().length, qn=queueCount(), fl=failedGet().length;
  var h=topbar('Ещё', esc(S.ssName||''), false)+'<div class="content">'+
    moreRow(IC.users,'Записались','новички до зачисления в группу',"openLeads()", n||'')+
    moreRow(IC.wallet,'История оплат','все оплаты месяца и график',"paySeg='log';go('pay')")+
    moreRow(IC.cal,'Расписание месяца','все дни тренировок по неделям',"go('sched')")+
    moreRow(IC.gear,'Настройки','дни недели, новый месяц, форма записи, ключ',"openSettings()")+
    moreRow(IC.refresh,'Обновить данные', qn?('ждут отправки: '+qn):(isOnline()?'связь есть':'нет связи'),"toast('Обновляю…');load(true)")+
    moreRow(IC.gear,'Проверка таблицы','что скрипт видит в листах',"openDiag()")+
    (fl?moreRow(IC.warn,'Не ушло в таблицу','записи, которые таблица не приняла',"openSettings()",fl):'')+
    '<div class="hint" style="text-align:center;margin-top:18px">Таблица: '+esc(S.ssName||'')+' · '+esc(S.monthLabel)+'</div></div>'+navHtml('more');
  $('app').innerHTML=h;
}

// ======== записались (новички до зачисления) ========
function openLeads(){ closeSheet(); screen='leads'; q=''; render(); load(true); }
function renderLeads(){
  var act=activeLeads(), done=[];
  var h='<div class="top"><div class="row"><div class="logo"><img src="assets/crew-mark.svg" alt=""></div>'+
    '<div class="grow"><div class="title">Записались</div><div class="sub">новички до зачисления в группу</div></div>'+
    '<button class="ib" onclick="openSettings()" aria-label="Настройки">'+IC.gear+'</button></div></div><div class="content">';
  if (!act.length) h+='<div class="empty"><h3>Пока никого нет</h3>Нажмите «+», чтобы записать новичка на пробное занятие. Когда зачислите его в группу — он переедет из этого списка в группу.</div>';
  else {
    if (act.length){
      h+='<div class="grp"><div class="gh"><span>Ждут пробного</span><span>'+act.length+'</span></div>';
      h+=act.map(function(l){
        var when=l.trialLabel?('пробное '+esc(l.trialLabel)):'дата не выбрана';
        return '<div class="card"><div class="main" onclick="openLead(\''+l.id+'\')"><div class="nm">'+esc(l.name)+(l.age?(' <span style="color:var(--muted);font-weight:600">'+esc(l.age)+' лет</span>'):'')+'</div>'+
          '<div class="meta"><span class="pill v">'+esc(when)+'</span><span class="pill ok">'+esc(l.branch||'—')+'</span>'+
          (l.source?('<span class="pill grp">'+esc(l.source)+'</span>'):'')+'</div></div>'+
          '<button class="mark join" onclick="openJoin(\''+l.id+'\')" aria-label="Зачислить">'+IC.plus+'</button></div>';
      }).join('')+'</div>';
    }
    if (done.length){
      h+='<div class="grp"><div class="gh"><span>Зачислены</span><span>'+done.length+'</span></div>';
      h+=done.slice(0,20).map(function(l){
        return '<div class="card"><div class="main" onclick="openLead(\''+l.id+'\')"><div class="nm">'+esc(l.name)+'</div>'+
          '<div class="meta"><span class="pill ok">'+esc(l.group||'в группе')+'</span><span class="pill v">'+esc(l.branch||'')+'</span></div></div></div>';
      }).join('')+'</div>';
    }
  }
  $('app').innerHTML=h+'</div><button class="fab" onclick="openAddLead()" aria-label="Записать новичка">'+IC.plus+'</button>'+navHtml('more');
}
var lbranch=0, ltrial=null;
function openAddLead(){
  lbranch=bi; ltrial=null;
  sheet('<h2>Записать новичка</h2><div class="sub">попадёт во вкладку «Записались», не в таблицу</div><div style="height:12px"></div>'+
    '<div class="field"><label for="ln">Имя ребёнка</label><input id="ln" autocomplete="off"></div>'+
    '<div class="field"><label for="lp">Телефон родителя</label><input id="lp" type="tel" inputmode="tel" placeholder="+7 922 111-22-33"></div>'+
    '<div class="field"><label>Филиал</label><div class="tags" id="lbt">'+branches().map(function(n,i){
      return '<button type="button" class="tag'+(i===lbranch?' on':'')+'" onclick="pickLeadBranch('+i+')">'+esc(n)+'</button>';
    }).join('')+'</div></div>'+
    '<div class="field"><label>Когда придёт на пробное</label><div class="tags" id="ldt">'+leadDays()+'</div></div>'+
    '<div class="field"><label for="lc">Комментарий</label><input id="lc" placeholder="возраст, откуда узнали"></div>'+
    '<button class="btn p" id="lgo" onclick="doAddLead()">Записать</button><button class="btn q" onclick="closeSheet()">Отмена</button>', 'lead');
}
function leadDays(){
  var b=S.branches[branches()[lbranch]]||{}, t=today();
  var ds=(b.dates||[]).filter(function(d){ return d.iso>=t; }).slice(0,8);
  if(!ds.length) ds=(b.dates||[]).slice(-4);
  return ds.map(function(d){
    return '<button type="button" class="tag'+(d.iso===ltrial?' on':'')+'" onclick="pickTrial(\''+d.iso+'\')">'+d.dow+' '+d.label.slice(0,2)+'</button>';
  }).join('')||'<span class="hint">нет дат тренировок</span>';
}
function pickLeadBranch(i){ lbranch=i; ltrial=null; $('lbt').querySelectorAll('.tag').forEach(function(b,j){ b.classList.toggle('on', j===i); }); $('ldt').innerHTML=leadDays(); }
function pickTrial(iso){ ltrial = ltrial===iso ? null : iso; $('ldt').innerHTML=leadDays(); }
function doAddLead(){
  var name=$('ln').value.trim();
  if(!name){ toast('Укажите имя'); return; }
  $('lgo').disabled=true; begin();
  var br=branches()[lbranch], ph=phoneOut('lp'), note=$('lc').value.trim();
  send('addLead',[br, name, ph, ltrial, note])
    .then(function(ls){
      if (ls && ls.queued){
        var d=ltrial?new Date(ltrial+'T12:00:00'):null;
        S.leads=(S.leads||[]); S.leads.unshift({created:'—',branch:br,name:name,phone:ph,trial:ltrial||'',
          trialLabel:d?(pad(d.getDate())+'.'+pad(d.getMonth()+1)):'',status:'Записался',group:'',note:note,id:'tmp-'+Date.now(),offline:true});
        cacheSave(S); closeSheet(); screen='leads'; render(); toast('Запишется в таблицу, когда появится интернет'); return;
      }
      S.leads=ls; cacheSave(S); closeSheet(); screen='leads'; render(); toast(name+' — записан(а)');
    })
    .catch(function(e){ toast('Ошибка: '+e.message); var x=$('lgo'); if(x) x.disabled=false; }).then(function(){ end(); });
}
function lead(id){ var l=leads().filter(function(x){ return x.id===id; }); return l[0]||null; }
function openLead(id){
  var l=lead(id); if(!l) return;
  var ph=l.phone?('<div class="two" style="margin-bottom:12px"><a class="btn s" href="tel:'+esc(l.phone.replace(/[^\d+]/g,''))+'">Позвонить</a>'+
    '<a class="btn g" href="https://wa.me/'+esc(l.phone.replace(/\D/g,''))+'" target="_blank" rel="noopener">WhatsApp</a></div>'):'';
  var facts=[];
  if (l.age) facts.push(esc(l.age)+' лет');
  if (l.parent) facts.push('родитель: '+esc(l.parent));
  if (l.source) facts.push('источник: '+esc(l.source));
  if (l.created) facts.push('заявка '+esc(l.created));
  sheet('<h2>'+esc(l.name)+'</h2><div class="sub">'+esc(l.branch)+' · '+esc(l.status)+(l.trialLabel?' · пробное '+esc(l.trialLabel):'')+'</div><div style="height:12px"></div>'+
    (facts.length?'<div class="hint" style="margin-bottom:8px">'+facts.join(' · ')+'</div>':'')+
    (l.note?'<div class="hint" style="margin-bottom:12px">'+esc(l.note)+'</div>':'')+
    (l.phone?'<div class="field"><label>Телефон</label><div style="font-size:17px;font-weight:650">'+esc(l.phone)+'</div></div>':'')+ph+
    (l.status!==DONE?'<button class="btn p" onclick="openJoin(\''+id+'\')">Зачислить в группу</button>':'<div class="hint">Уже занимается в группе «'+esc(l.group)+'».</div>')+
    '<button class="btn q" onclick="delLead(\''+id+'\')">Удалить запись</button>'+
    '<button class="btn q" onclick="closeSheet()">Закрыть</button>', 'lead:'+id);
}
function isTmp(id){ return String(id).indexOf('tmp-')===0; }
/** Запись, созданная офлайн и ещё не ушедшая в таблицу: убираем её из очереди. */
function dropQueuedLead(l){
  var a=queueGet(), i=-1;
  for (var j=0;j<a.length;j++) if (a[j].action==='addLead' && a[j].params[0]===l.branch && a[j].params[1]===l.name){ i=j; break; }
  if (i>=0){ a.splice(i,1); queueSet(a); }
}
function delLead(id){
  if(!confirm('Удалить запись?')) return;
  var l0=lead(id);
  if (isTmp(id)){
    if (l0) dropQueuedLead(l0);
    S.leads=(S.leads||[]).filter(function(x){ return x.id!==id; });
    cacheSave(S); closeSheet(); render(); toast('Удалено'); return;
  }
  begin();
  send('deleteLead',[id]).then(function(ls){
    if (ls && ls.queued) S.leads=(S.leads||[]).filter(function(x){ return x.id!==id; });
    else S.leads=ls;
    cacheSave(S); closeSheet(); render(); toast('Удалено');
  }).catch(function(e){ toast('Ошибка: '+e.message); }).then(function(){ end(); });
}
var jtype='abon';
function openJoin(id){
  var l=lead(id); if(!l) return;
  jtype='abon';
  var i=branches().indexOf(l.branch); if(i>=0) bi=i;
  var g=groups(B()).order;
  sheet('<h2>Зачислить</h2><div class="sub">'+esc(l.name)+' · '+esc(l.branch)+'</div><div style="height:12px"></div>'+
    '<div class="field"><label>Группа</label><div class="tags" id="jgt">'+
      g.map(function(x,k){ return '<button type="button" class="tag'+(k===0?' on':'')+'" data-g="'+esc(x)+'" onclick="pickGroup(\'jg\',this)">'+esc(x)+'</button>'; }).join('')+
      '<button type="button" class="tag new'+(g.length?'':' on')+'" data-g="__new" onclick="pickGroup(\'jg\',this)">+ новая</button>'+
    '</div><input id="jgn" placeholder="Название новой группы"'+(g.length?' hidden':'')+'></div>'+
    '<div class="field"><label>Как платит</label><div class="pick" id="jp"><button class="on" data-t="abon" onclick="setJ(\'abon\')">Абонемент</button><button data-t="single" onclick="setJ(\'single\')">Разово</button></div></div>'+
    '<div class="hint" style="margin-bottom:12px">Ребёнок появится в таблице филиала, телефон перенесётся. Запись получит статус «Занимается».</div>'+
    '<button class="btn p" id="jgo" onclick="doJoin(\''+id+'\')">Зачислить</button><button class="btn q" onclick="openLead(\''+id+'\')">Назад</button>', 'join:'+id);
}
function setJ(t){ jtype=t; document.querySelectorAll('#jp button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-t')===t); }); }
function doJoin(id){
  var g=groupVal('jg');
  if(!g){ toast('Выберите группу'); return; }
  var l=lead(id); if(!l) return;
  $('jgo').disabled=true; begin();
  var branch=l.branch, type=jtype;
  /** Ребёнок сразу переезжает в группу на экране, а запись пропадает из «Записались». */
  var applyLocal=function(){
    S.leads=(S.leads||[]).filter(function(x){ return x.id!==id; });
    var b=S.branches[branch];
    if (b && b.kids) b.kids.push({ id:'tmp-'+Date.now(), name:l.name, group:g, phone1:l.phone||'', phone2:'',
      payType: type==='single'?'РАЗОВОЕ':'АБОНЕМЕНТ', balance:0, price: type==='single'?S.config.singlePrice:S.config.abonPrice,
      remainder:0, visits:0, attendance:{}, missed:0, lastVisit:'', pendingNew:true });
    cacheSave(S); closeSheet(); render(); toast('Зачислен(а) в «'+g+'»');
  };
  if (isTmp(id)){                                        // запись ещё не в таблице — сразу добавим как ребёнка
    dropQueuedLead(l);
    queueAdd('addChild',[branch,l.name,g,l.phone||'','',type]);
    applyLocal(); end(); flush(); return;
  }
  send('convertLead',[id,g,type]).then(function(r){
    if (r && r.queued){ applyLocal(); return; }
    putBranch(r.branch,r.data); S.leads=r.leads; cacheSave(S);
    closeSheet(); render(); toast('Зачислен(а) в «'+g+'»');
  }).catch(function(e){ toast('Ошибка: '+e.message); var x=$('jgo'); if(x) x.disabled=false; }).then(function(){ end(); });
}

// ======== стартовый экран: адрес и дата тренировки ========
/** Индексы филиалов, у которых тренировка сегодня. */
function trainsToday(){
  var t=today(), out=[];
  branches().forEach(function(n,i){
    var b=S.branches[n];
    if (b && !b.error && (b.dates||[]).some(function(d){ return d.iso===t; })) out.push(i);
  });
  return out;
}
/** Выбор на стартовом экране должен оставаться допустимым после обновления данных. */
function fixPick(){
  if (pick.bi>=branches().length) pick.bi=0;
  var b=S.branches[branches()[pick.bi]], ok=b && b.dates && b.dates.some(function(d){ return d.iso===pick.iso; });
  if (!ok) pick.iso=suggestIso(pick.bi);
}
function openStart(pref){
  closeSheet();
  var tr = trainsToday(), def = (typeof pref==='number') ? pref : (tr.length ? tr[0] : bi);
  pick.bi = Math.min(Math.max(def,0), Math.max(branches().length-1,0));
  pick.iso = suggestIso(pick.bi);
  startFresh = true; screen = 'start'; render();
}
function suggestIso(idx){
  var b = S.branches[branches()[idx]];
  if (!b || !b.dates || !b.dates.length) return null;
  var t = today(), past = b.dates.filter(function(d){ return d.iso<=t; });
  if (past.length) return past[past.length-1].iso;          // сегодня или последняя прошедшая
  return b.dates[0].iso;
}
/** Приветствие по времени суток. */
function greet(){
  var h=new Date().getHours();
  if (h<5) return 'Доброй ночи!';
  if (h<12) return 'Доброе утро!';
  if (h<17) return 'Добрый день!';
  return 'Добрый вечер!';
}
function humanDate(iso){
  if (!iso) return '';
  var d = new Date(iso+'T12:00:00');
  return DOW[d.getDay()].toLowerCase()+', '+d.getDate()+' '+GEN[d.getMonth()];
}
function renderStart(){
  var list = branches().map(function(n,i){
    var b = S.branches[n] || {};
    var note = b.error ? 'лист не читается' : ((b.kids||[]).length+' '+plural((b.kids||[]).length,'ребёнок','ребёнка','детей')+' · '+(b.dates||[]).length+' тренировок в месяце');
    return '<button class="'+(i===pick.bi?'on':'')+'" onclick="pickBranch('+i+')"><div class="grow"><div class="t">'+esc(n)+'</div><div class="s">'+esc(note)+'</div></div><span class="rad"></span></button>';
  }).join('');

  var b = S.branches[branches()[pick.bi]] || {}, t = today();
  var dates = (b.dates||[]).map(function(d){
    var later = d.iso>t;
    var note = d.iso===t ? 'сегодня' : (later ? 'позже' : 'прошло');
    return '<div class="dbtn'+(d.iso===pick.iso?' on':'')+(later?' dis':'')+'"'+(later?'':' onclick="pickDay(\''+d.iso+'\')"')+'><div class="dw">'+d.dow+'</div><div class="dd">'+d.label.slice(0,2)+'</div><div class="nt">'+note+'</div></div>';
  }).join('') || '<div class="hint">В таблице нет столбцов с датами на '+esc(S.monthLabel)+'.<br>Откройте таблицу → меню «БРЕЙКИДС72» → «Обновить календарь по расписанию».'+
    '<button class="btn s" style="margin-top:10px" onclick="openDiag()">Проверить таблицу</button></div>';
  var warn = calWarn(branches()[pick.bi]);

  var all = b.dates||[], past = all.filter(function(d){ return d.iso<=t; });
  var notYet = all.length>0 && past.length===0;             // все тренировки месяца ещё впереди
  var ready = !!pick.iso && !b.error && !notYet, isToday = pick.iso===t;
  var kk=b.kids||[], grs={}, debts=0, came=0;
  kk.forEach(function(k){ grs[k.group]=1; if(k.remainder<0) debts++; if(pick.iso && k.attendance[pick.iso]) came++; });
  var mini = kk.length ? ('<div class="mini a4">'+
      '<div><b>'+kk.length+'</b><span>'+plural(kk.length,'ребёнок','ребёнка','детей')+'</span></div>'+
      '<div><b>'+Object.keys(grs).length+'</b><span>'+plural(Object.keys(grs).length,'группа','группы','групп')+'</span></div>'+
      '<div><b'+(debts?' class="bad"':'')+'>'+debts+'</b><span>'+plural(debts,'долг','долга','долгов')+'</span></div>'+
      (came?('<div><b class="good">'+came+'</b><span>уже отмечены</span></div>'):'')+
    '</div>') : '';
  var anim = startFresh ? ' anim' : '';
  startFresh = false;                                   // анимация играет один раз, при открытии
  $('app').innerHTML =
    '<div class="start'+anim+'">'+
      '<div class="hello"><img class="logo" src="assets/crew-mark.svg" alt="">'+
        '<div class="who"><div class="hi">'+esc(greet())+'</div><div class="dt">'+esc(humanDate(today()))+'</div></div></div>'+
      '<h1>Тренировка</h1>'+
      '<p class="lead">Подтвердите адрес и дату — отметки запишутся именно в этот день.</p>'+
      '<div class="step a1"><i>1</i>Адрес</div><div class="pickbig a2">'+list+'</div>'+
      '<div class="step a3"><i>2</i>Дата тренировки · '+esc(S.monthLabel)+'</div><div class="dates" id="dates">'+dates+'</div>'+warn+
      mini+
      '<div class="startfoot">'+
        (ready ? '<div class="confirm">Отмечаем <b>'+esc(humanDate(pick.iso))+'</b>'+(isToday?' <span class="tag">сегодня</span>':'')+'<br>'+esc(branches()[pick.bi])+'</div>'
               : '<div class="confirm">'+(b.error?esc(b.error):(notYet?('Тренировки '+esc(S.monthLabel)+' ещё впереди. Ближайшая — <b>'+esc(humanDate(all[0].iso))+'</b>. Отметки ставятся в день занятия.'):'Выберите дату тренировки'))+'</div>')+
        (notYet ? '<button class="btn p" onclick="skipStart()">Открыть список детей</button>'
                : '<button class="btn p" onclick="startGo()"'+(ready?'':' disabled')+'>Начать отметку</button>')+
        '<div class="startlinks">'+(notYet?'':'<button onclick="skipStart()">Пропустить</button>')+'<button onclick="openSettings()">Настройки</button></div>'+
      '</div>'+
    '</div>';
  var d = $('dates'), on = d && d.querySelector('.on');
  if (on) d.scrollLeft = on.offsetLeft - d.clientWidth/2 + on.clientWidth/2;
}
function pickBranch(i){ pick.bi=i; pick.iso=suggestIso(i); render(); }
function pickDay(iso){ pick.iso=iso; render(); }
function startGo(){
  if (!pick.iso) return;
  bi = pick.bi; try{ localStorage.setItem('bk72_branch', bi); }catch(e){}
  sel[bname()] = pick.iso;
  session = { branch: bname(), iso: pick.iso, day: today() }; sessionSave();
  screen = 'main'; q=''; render();
}
/** «Пропустить» — просто посмотреть список, добавить ребёнка, принять оплату. */
function skipStart(){
  bi = pick.bi; try{ localStorage.setItem('bk72_branch', bi); }catch(e){}
  if (pick.iso) sel[bname()] = pick.iso;
  session = { branch: bname(), iso: pick.iso, day: today(), skipped: true }; sessionSave();
  screen = 'main'; q=''; render();
}

// ======== отметка ========
/** Поставить отметку — один тап. Снять — два тапа подряд: так отметку не снять случайно. */
var armed = null, armTimer = null, lastAdd = {}, busyKid = {};   // busyKid: сколько запросов по ребёнку ещё в пути
var ARM_MS = 1800;      // сколько ждём второй тап
var GUARD_MS = 500;     // сразу после постановки отметки лишние тапы игнорируются (дрожащий палец, двойной тап по привычке)
function markKey(id, iso){ return id+'|'+iso; }
function isArmed(id, iso){ return !!armed && armed.key===markKey(id,iso) && Date.now()<armed.until; }
function setArmed(key){
  clearTimeout(armTimer);
  [].slice.call(document.querySelectorAll('.armed')).forEach(function(e){ e.classList.remove('armed'); });
  if (!key){ armed=null; return; }
  armed={ key:key, until:Date.now()+ARM_MS };
  [].slice.call(document.querySelectorAll('[data-k]')).forEach(function(e){ if (e.getAttribute('data-k')===key) e.classList.add('armed'); });
  armTimer=setTimeout(function(){ if (armed && armed.key===key){ setArmed(null); if (branchScreen(screen)) render(); } }, ARM_MS);
  try{ if (navigator.vibrate) navigator.vibrate(15); }catch(e){}
}
function toggle(id, iso){
  var k=kid(id); if(!k) return;
  var key=markKey(id,iso), now=Date.now();
  if (k.attendance[iso]){                                   // снятие отметки
    if (lastAdd[key] && now-lastAdd[key]<GUARD_MS) return;
    if (!isArmed(id,iso)){ setArmed(key); render(); toast('Ещё раз — чтобы снять'); return; }
    setArmed(null);
  } else {
    if (iso>today()){ toast('Тренировка ещё не прошла — отметим в этот день'); return; }
    lastAdd[key]=now;
  }
  var val=!k.attendance[iso], branch=bname();
  if (val) k.attendance[iso]=true; else delete k.attendance[iso];
  k.visits+=val?1:-1; k.remainder=k.balance-k.visits*k.price;
  begin(); busyKid[id]=(busyKid[id]||0)+1;
  render(); refreshSheet();
  send('setAttendance',[branch,id,iso,val]).then(function(r){
    if (r && r.queued){ cacheSave(S); return; }
    var kk=kid(id);
    // пока по этому ребёнку летят другие запросы, цифры сервера устарели — их применит последний ответ
    if (kk && r && r.visits!==undefined && busyKid[id]<=1){
      var changed = kk.visits!==r.visits || kk.remainder!==r.remainder || kk.balance!==r.balance || kk.price!==r.price;
      kk.visits=r.visits; kk.remainder=r.remainder; kk.balance=r.balance; kk.price=r.price;
      if (changed){ render(); refreshSheet(); }
    }
    cacheSave(S);
  }).catch(function(e){
    var kk=kid(id); if(kk){ if(val) delete kk.attendance[iso]; else kk.attendance[iso]=true; kk.visits+=val?-1:1; kk.remainder=kk.balance-kk.visits*kk.price; }
    cacheSave(S); render(); refreshSheet(); toast('Не сохранилось: '+e.message);
  }).then(function(){ busyKid[id]=Math.max(0,(busyKid[id]||1)-1); end(); });
}

// ======== нижний лист ========
function sheet(html, key){
  var b=$('bk');
  if (b){ var s=b.querySelector('.sheet'), y=s.scrollTop; s.innerHTML='<div class="handle"></div>'+html; if (key && sheetKey && key===sheetKey) s.scrollTop=y; }
  else { b=document.createElement('div'); b.className='back'; b.id='bk'; b.onclick=function(e){ if(e.target===b) closeSheet(); };
    b.innerHTML='<div class="sheet"><div class="handle"></div>'+html+'</div>'; document.body.appendChild(b);
    var sh=b.querySelector('.sheet'); sh.setAttribute('role','dialog'); sh.setAttribute('aria-modal','true'); swipeSheet(sh); }
  sheetKey=key||'x'; a11y();
}
function closeSheet(){ var b=$('bk'); if(b) b.remove(); sheetKey=null; }
/** Свайп вниз по карточке — закрыть (как в обычных приложениях). */
function swipeSheet(el){
  var y0=null, dy=0, moving=false;
  el.addEventListener('touchstart', function(e){
    if (e.touches.length!==1) return;
    var t=e.target;
    if (t.closest && t.closest('input,textarea,select,.strip,.dates,.tags,.cal')) { y0=null; return; }
    var y=e.touches[0].clientY, r=el.getBoundingClientRect();
    y0 = (el.scrollTop<=0 || y-r.top<70) ? y : null;      // сверху карточки свайп работает всегда
    dy=0; moving=false;
  }, {passive:true});
  el.addEventListener('touchmove', function(e){
    if (y0===null) return;
    dy = e.touches[0].clientY - y0;
    if (dy>0){ moving=true; el.style.transition='none'; el.style.transform='translateY('+Math.min(dy,400)+'px)'; }
  }, {passive:true});
  el.addEventListener('touchend', function(){
    if (y0===null) return;
    el.style.transition='transform .18s ease';
    if (moving && dy>90){ el.style.transform='translateY(100%)'; setTimeout(closeSheet,150); }
    else el.style.transform='';
    y0=null;
  });
}
function refreshSheet(){ if (sheetKey && sheetKey.indexOf('kid:')===0){ var id=sheetKey.slice(4); if (kid(id)) openKid(id); else closeSheet(); } }

// ======== карточка ребёнка ========
var kidLog={};                       // id -> {t, html}: история оплат ребёнка, чтобы не дёргать таблицу на каждый тап
function kidLogHtml(l){
  return l.length ? l.map(function(r){ return '<div class="line"><div class="dt">'+esc(r.date)+'</div><div class="grow">'+esc(r.type)+'</div><div class="am">'+rub(r.amount)+'</div></div>'; }).join('')
                  : '<div class="hint">Оплат через приложение в этом месяце не было.</div>';
}
function openKid(id){
  var k=kid(id); if(!k) return;
  var cached = kidLog[id] && (Date.now()-kidLog[id].t < 180000) ? kidLog[id].html : null;
  var phones=[k.phone1,k.phone2].filter(Boolean).map(function(p){
    var d=p.replace(/\D/g,''); if(d.length===11&&d[0]==='8') d='7'+d.slice(1); if(d.length===10) d='7'+d;
    return '<div class="line"><div class="grow">'+esc(p)+'</div><a class="mini" href="tel:+'+d+'">Позвонить</a><a class="mini wa" href="https://wa.me/'+d+'" target="_blank" rel="noopener">WhatsApp</a></div>';
  }).join('') || '<div class="hint">Телефоны не указаны — добавьте в «Изменить».</div>';
  sheet('<h2>'+esc(k.name)+'</h2><div class="sub">'+esc(k.group)+' · '+esc(bname())+' · '+esc(k.payType)+'</div>'+
    '<div class="stats"><div class="stat"><b>'+k.visits+'</b><span>занятий</span></div>'+
    '<div class="stat"><b style="color:'+(k.remainder<0?'var(--bad)':'var(--good)')+'">'+k.remainder.toLocaleString('ru-RU')+'</b><span>остаток ₽</span></div>'+
    '<div class="stat"><b>'+k.balance.toLocaleString('ru-RU')+'</b><span>внесено ₽</span></div></div>'+
    '<div class="hint" style="margin:-2px 0 10px">'+esc(moneyNote(k))+'</div>'+
    '<div class="sec">Посещения · '+esc(S.monthLabel)+'</div>'+cal(k)+
    '<div class="sec">Родители</div>'+phones+
    '<button class="btn p" onclick="openPay(\''+id+'\')">Внести оплату</button>'+
    '<div class="two"><button class="btn s" onclick="openEdit(\''+id+'\')">Изменить</button><button class="btn s" onclick="share(\''+id+'\')">Отчёт родителю</button></div>'+
    '<div class="sec">Место в списке</div>'+
    '<div class="moverow"><button onclick="moveKid(\''+id+'\',-1)">↑ Выше</button><button onclick="moveKid(\''+id+'\',1)">↓ Ниже</button></div>'+
    '<div class="hint">Порядок меняется и в таблице. Работает внутри группы'+(sortMode==='visits'?'; сейчас включена сортировка по посещаемости — переключите на «свой порядок», чтобы увидеть результат':'')+'.</div>'+
    '<div class="sec">Оплаты</div><div id="kp">'+(cached||'<div class="hint">Загрузка…</div>')+'</div>'+
    '<button class="btn q" onclick="closeSheet()">Закрыть</button>', 'kid:'+id);
  if (cached) return;                                   // уже загружали недавно — не дёргаем таблицу снова
  if (!isOnline()){ var ek=$('kp'); if(ek) ek.innerHTML='<div class="hint">История оплат появится, когда будет интернет.</div>'; return; }
  api('getPaymentLog',[20,id]).then(function(l){
    kidLog[id]={t:Date.now(), html:kidLogHtml(Array.isArray(l)?l:[])};
    var e=$('kp'); if(e && sheetKey==='kid:'+id) e.innerHTML=kidLog[id].html;
  }).catch(function(){ var e=$('kp'); if(e && sheetKey==='kid:'+id) e.innerHTML='<div class="hint">Не удалось загрузить.</div>'; });
}
function cal(k){
  var b=B(), m=S.month.monthIdx, y=S.month.year, tr={}, t=today();
  b.dates.forEach(function(d){ tr[d.iso]=1; });
  var h='<div class="cal">'+['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'].map(function(x){return '<div class="h">'+x+'</div>';}).join('');
  var start=(new Date(y,m,1).getDay()+6)%7, days=new Date(y,m+1,0).getDate(), att=[], miss=[];
  for (var i=0;i<start;i++) h+='<div></div>';
  for (var d=1; d<=days; d++){
    var iso=y+'-'+pad(m+1)+'-'+pad(d), c='d';
    if (tr[iso]){ c+=' tr'; if(k.attendance[iso]){ c+=' att'+(isArmed(k.id,iso)?' armed':''); att.push(lbl(iso)); } else if(iso<t){ c+=' miss'; miss.push(lbl(iso)); } }
    if (iso===t) c+=' today';
    if (tr[iso] && iso>t) c+=' later';
    h+='<div class="'+c+'"'+(tr[iso] && (iso<=t || k.attendance[iso])?' data-k="'+esc(markKey(k.id,iso))+'" onclick="toggle(\''+k.id+'\',\''+iso+'\')"':'')+'>'+d+'</div>';
  }
  return h+'</div><div class="legend"><span><i style="background:var(--accent)"></i>был</span><span><i style="background:var(--bad-soft);border:1px solid var(--bad)"></i>пропустил</span><span><i style="border:1.5px solid var(--border);background:#fff"></i>впереди</span></div>'+
    '<div class="visited">'+(att.length?'Был: <b>'+att.join(', ')+'</b>':'В этом месяце ещё не был')+(miss.length?'<br>Пропустил: '+miss.join(', '):'')+'</div>'+
    '<div class="hint">Нажмите на прошедший день тренировки, чтобы поставить отметку. Чтобы снять — нажмите дважды. Будущие дни отмечать нельзя — только по факту.</div>';
}
function share(id){
  var k=kid(id), b=B(), t=today();
  var att=b.dates.filter(function(d){ return k.attendance[d.iso]; }).map(function(d){ return d.label; });
  var miss=b.dates.filter(function(d){ return !k.attendance[d.iso] && d.iso<t; }).map(function(d){ return d.label; });
  var txt=[k.name+' — CREW, '+bname(), S.monthLabel+': '+att.length+' '+plural(att.length,'занятие','занятия','занятий')+(att.length?' ('+att.join(', ')+')':'')]
    .concat(miss.length?['Пропущено: '+miss.join(', ')]:[]).concat([k.remainder<0?'К оплате: '+rub(-k.remainder):'Остаток на балансе: '+rub(k.remainder)]).join('\n');
  if (navigator.share) navigator.share({text:txt}).catch(function(){});
  else if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function(){ toast('Отчёт скопирован'); });
  else prompt('Скопируйте текст', txt);
}

// ======== оплата ========
var ptype='abon';
function openPay(id){
  var k=kid(id); ptype=k.payType==='РАЗОВОЕ'?'single':'abon';
  sheet('<h2>Оплата</h2><div class="sub">'+esc(k.name)+' · сейчас '+(k.remainder<0?'долг '+rub(-k.remainder):'остаток '+rub(k.remainder))+'</div><div style="height:12px"></div>'+
    '<div class="pick" id="pp"><button data-t="abon" onclick="setP(\'abon\')">Абонемент</button><button data-t="single" onclick="setP(\'single\')">Разовое · '+rub(S.config.singlePrice)+'</button></div>'+
    '<div class="field" id="pcw"><label for="pc">Сколько занятий</label><input id="pc" type="number" inputmode="numeric" min="1" value="'+(B().dates.length||8)+'" oninput="psum()"></div>'+
    '<button class="btn g" id="pg" onclick="doPay(\''+id+'\')"></button><button class="btn q" onclick="openKid(\''+id+'\')">Назад</button>', 'pay');
  setP(ptype);
}
function setP(t){ ptype=t; document.querySelectorAll('#pp button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-t')===t); }); $('pcw').hidden=t!=='abon'; psum(); }
function psum(){ var n=Math.max(1,Number($('pc').value)||1), s=ptype==='abon'?n*S.config.abonPrice:S.config.singlePrice;
  $('pg').textContent='Записать · '+rub(s)+(ptype==='abon'?' ('+n+' × '+rub(S.config.abonPrice)+')':''); }
function doPay(id){
  var n=ptype==='abon'?Math.max(1,Number($('pc').value)||1):1, branch=bname();
  var amount = ptype==='abon' ? n*S.config.abonPrice : S.config.singlePrice;
  var k=kid(id);                                        // засчитываем сразу
  if(k){ k.balance+=amount; k.price=ptype==='single'?S.config.singlePrice:S.config.abonPrice;
         k.payType=ptype==='single'?'РАЗОВОЕ':'АБОНЕМЕНТ'; k.remainder=k.balance-k.visits*k.price; }
  cacheSave(S); render(); openKid(id); toast('Оплата записана · '+rub(amount));
  begin();
  send('addPayment',[branch,id,ptype,n]).then(function(r){
    if (r && r.queued) return;                          // уйдёт при появлении связи
    var kk=kid(id);
    if(kk && r && r.balance!==undefined){ kk.balance=r.balance; kk.price=r.price; kk.remainder=r.remainder; kk.visits=r.visits; }
    cacheSave(S); render(); refreshSheet(); delete kidLog[id]; loadPayLog(true);
  }).catch(function(e){ toast('Не записалось в таблицу: '+e.message); }).then(function(){ end(); });
}

// ======== добавить / изменить ========
/** Группы тегами над полем — один тап, без выпадающих списков. */
function groupField(pre, cur){
  var g=groups(B()).order, has=g.indexOf(cur)>=0, sel=has?cur:(g.length?g[0]:'__new');
  var tags=g.map(function(x){
    return '<button type="button" class="tag'+(x===sel?' on':'')+'" data-g="'+esc(x)+'" onclick="pickGroup(\''+pre+'\',this)">'+esc(x)+'</button>';
  }).join('')+'<button type="button" class="tag new'+(sel==='__new'?' on':'')+'" data-g="__new" onclick="pickGroup(\''+pre+'\',this)">+ новая</button>';
  return '<div class="tags" id="'+pre+'t">'+tags+'</div><input id="'+pre+'n" placeholder="Название новой группы"'+(sel==='__new'?'':' hidden')+'>';
}
function pickGroup(pre, el){
  var w=$(pre+'t');
  w.querySelectorAll('.tag').forEach(function(b){ b.classList.toggle('on', b===el); });
  var isNew=el.getAttribute('data-g')==='__new', inp=$(pre+'n');
  inp.hidden=!isNew; if(isNew) inp.focus();
}
function groupVal(pre){
  var on=$(pre+'t').querySelector('.tag.on'); if(!on) return '';
  var v=on.getAttribute('data-g');
  return v==='__new' ? $(pre+'n').value.trim() : v;
}
var atype='abon';
function openAdd(){
  atype='abon';
  sheet('<h2>Новый ребёнок</h2><div class="sub">'+esc(bname())+'</div><div style="height:12px"></div>'+
    '<div class="field"><label for="an">Имя и фамилия</label><input id="an" autocomplete="off"></div>'+
    '<div class="field"><label for="ag">Группа</label>'+groupField('ag', groups(B()).order[0])+'</div>'+
    '<div class="field"><label for="a1">Телефон родителя</label><input id="a1" type="tel" inputmode="tel" placeholder="+7 922 111-22-33"></div>'+
    '<div class="field"><label for="a2">Второй телефон</label><input id="a2" type="tel" inputmode="tel" placeholder="необязательно"></div>'+
    '<div class="field"><label>Как платит</label><div class="pick" id="ap"><button class="on" data-t="abon" onclick="setA(\'abon\')">Абонемент</button><button data-t="single" onclick="setA(\'single\')">Разово</button></div></div>'+
    '<button class="btn p" id="ago" onclick="doAdd()">Добавить</button><button class="btn q" onclick="closeSheet()">Отмена</button>', 'add');
}
function setA(t){ atype=t; document.querySelectorAll('#ap button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-t')===t); }); }
function doAdd(){
  var name=$('an').value.trim(), g=groupVal('ag'), branch=bname();
  if(!name||!g){ toast('Укажите имя и группу'); return; }
  var p1=phoneOut('a1'), p2=phoneOut('a2'), single=atype==='single';
  var b0=B();
  b0.kids.push({ id:'tmp-'+Date.now(), name:name, group:g, phone1:p1, phone2:p2,
    payType: single?'РАЗОВОЕ':'АБОНЕМЕНТ', balance:0, price: single?S.config.singlePrice:S.config.abonPrice,
    remainder:0, visits:0, attendance:{}, missed:0, lastVisit:'', pendingNew:true });
  cacheSave(S); closeSheet(); render(); toast(name+' — добавлен(а)');
  begin();
  send('addChild',[branch,name,g,p1,p2,atype]).then(function(b){
    if (b && b.queued) return;
    if (b && b.kids){ putBranch(branch,b); cacheSave(S); render(); }
  }).catch(function(e){ toast('Не сохранилось в таблице: '+e.message); }).then(function(){ end(); });
}
function openEdit(id){
  var k=kid(id);
  sheet('<h2>Изменить</h2><div class="sub">'+esc(k.name)+'</div><div style="height:12px"></div>'+
    '<div class="field"><label for="en">Имя и фамилия</label><input id="en" value="'+esc(k.name)+'"></div>'+
    '<div class="field"><label for="eg">Группа</label>'+groupField('eg', k.group)+'</div>'+
    '<div class="field"><label for="e1">Телефон родителя</label><input id="e1" type="tel" value="'+esc(k.phone1)+'"></div>'+
    '<div class="field"><label for="e2">Второй телефон</label><input id="e2" type="tel" value="'+esc(k.phone2)+'"></div>'+
    '<div class="field"><label>Как платит</label><div class="pick" id="et"><button class="'+(k.payType!=='РАЗОВОЕ'?'on':'')+'" data-t="abon" onclick="setE(\'abon\')">Абонемент</button><button class="'+(k.payType==='РАЗОВОЕ'?'on':'')+'" data-t="single" onclick="setE(\'single\')">Разово</button></div></div>'+
    '<div class="two"><div class="field"><label for="ep">Цена занятия, ₽</label><input id="ep" type="number" inputmode="numeric" value="'+k.price+'"></div>'+
    '<div class="field"><label for="eb">Баланс, ₽</label><input id="eb" type="number" inputmode="numeric" value="'+k.balance+'"></div></div>'+
    '<div class="hint" style="margin:-4px 0 12px">Остаток = баланс − занятия × цена.</div>'+
    '<button class="btn p" id="ego" onclick="doEdit(\''+id+'\')">Сохранить</button><button class="btn q" onclick="openKid(\''+id+'\')">Назад</button>', 'edit');
  etype = k.payType==='РАЗОВОЕ' ? 'single' : 'abon';
}
var etype='abon';
function setE(t){
  etype=t;
  document.querySelectorAll('#et button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-t')===t); });
  $('ep').value = t==='single' ? S.config.singlePrice : S.config.abonPrice;
}
function doEdit(id){
  var f={name:$('en').value.trim(), group:groupVal('eg'), phone1:phoneOut('e1'), phone2:phoneOut('e2'), payType:(etype==='single'?'РАЗОВОЕ':'АБОНЕМЕНТ'), price:$('ep').value, balance:$('eb').value}, branch=bname();
  if(!f.name||!f.group){ toast('Имя и группа обязательны'); return; }
  var k=kid(id);                                        // применяем сразу, не ждём сервер
  if(k){ k.name=f.name; k.group=f.group; k.phone1=f.phone1; k.phone2=f.phone2; k.payType=f.payType;
         k.price=Number(f.price)||k.price; k.balance=Number(f.balance)||0; k.remainder=k.balance-k.visits*k.price; }
  cacheSave(S); render(); openKid(id); toast('Сохранено');
  begin();
  send('updateChild',[branch,id,f]).then(function(b){
    if (b && b.queued) return;                          // уйдёт, когда появится интернет
    if (b && b.kids){ putBranch(branch,b); cacheSave(S); render(); refreshSheet(); }
  }).catch(function(e){ toast('Не сохранилось в таблице: '+e.message); }).then(function(){ end(); });
}

/** Что скрипт видит в таблице — если данные выглядят странно. */
function openDiag(){
  sheet('<h2>Проверка таблицы</h2><div class="sub">Что скрипт нашёл в листах филиалов</div>'+
    '<div id="dg" style="margin-top:12px" class="hint">Читаю таблицу…</div>'+
    '<button class="btn q" onclick="closeSheet()">Закрыть</button>', 'diag');
  api('diagnose').then(function(d){
    var h='<div class="hint">Месяц: <b>'+esc(d.month)+'</b><br>Вкладки: '+esc(d.sheets.join(', '))+'</div>';
    d.branches.forEach(function(b){
      h+='<div class="panel" style="margin-top:10px"><h3>'+esc(b.name)+'</h3>';
      if (b.error) h+='<p style="color:var(--bad)">'+esc(b.error)+'</p>';
      else h+='<p>Дни по расписанию: <b>'+esc(b.days||'—')+'</b><br>Строк с детьми: '+b.rows+
        '<br>Дат в календаре: <b>'+b.dates.length+'</b>'+(b.dates.length?' — '+esc(b.dates.join(', ')):'')+'</p>'+
        '<p><b>Заголовки строки 2:</b><br>'+esc(b.headers.join(' · '))+'</p>'+
        '<p><b>Куда пишет скрипт:</b><br>'+esc(b.fields.join(' · '))+'</p>';
      h+='</div>';
    });
    var e=$('dg'); if(e){ e.className=''; e.innerHTML=h; }
  }).catch(function(e){ var x=$('dg'); if(x) x.textContent='Не удалось прочитать: '+e.message+' (возможно, в таблице старый скрипт)'; });
}

// ======== настройки ========
var backTo='main';
function openSettings(){ closeSheet(); if (screen!=='settings') backTo=(branchScreen(screen)||screen==='more'||screen==='leads')?screen:'main'; screen='settings'; render(); }
function closeSettings(){ screen = (session || !S || !S.configured) ? (backTo||'main') : 'start'; render(); load(true); }
function renderSettings(){
  var conf=S&&S.configured, now=new Date(), m=conf?S.month.monthIdx:now.getMonth(), y=conf?S.month.year:now.getFullYear();
  var h='<div class="top"><div class="row"><button class="ib" onclick="closeSettings()" aria-label="Назад">'+IC.back+'</button><div class="title">Настройки</div></div></div><div class="content">';
  h+='<div class="panel"><h3>1. Сервер <span class="st '+(API?'ok':'no')+'">'+(API?'указан':'не указан')+'</span></h3><p>Адрес из Apps Script (Deploy → Web app), заканчивается на /exec.</p>'+
    '<div class="field"><input id="sa" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="'+esc(API||'')+'"></div>'+
    '<div class="field"><label for="sk">Ключ доступа '+(needKey?'<b style="color:var(--bad)">— нужен!</b>':'')+'</label><input id="sk" placeholder="из таблицы, лист «Настройки»" value="'+esc(KEY||'')+'"><div class="hint">'+(needKey
      ? 'Откройте таблицу → лист «Настройки» → строка «Ключ доступа», скопируйте значение сюда и нажмите «Сохранить». Вводится один раз.'
      : 'Ключ защищает список детей и телефоны: без него по ссылке сервера отдаётся только форма записи. Он в таблице, лист «Настройки», строка «Ключ доступа».')+'</div></div>'+
    '<button class="btn s" onclick="saveApi()">Сохранить</button>'+
    '<button class="btn q" onclick="testApi()">Проверить связь</button>'+
    '<div class="hint" id="apitest"></div></div>';
  h+='<div class="panel"><h3>2. Таблица <span class="st '+(conf?'ok':'no')+'">'+(conf?'на связи':'нет связи')+'</span></h3>'+
    (conf?'<p>Скрипт живёт внутри таблицы <b>'+esc(S.ssName)+'</b>. Текущий месяц: '+esc(S.monthLabel)+'. Цены меняются на листе «Настройки» в самой таблице, расписание — прямо здесь, ниже.</p><a class="btn s" href="'+esc(S.ssUrl)+'" target="_blank" rel="noopener">Открыть таблицу</a>'
          :'<p>Сервер не отвечает или код в таблице не обновлён. Проверьте адрес сервера выше.</p>')+
    '</div>';
  var fl=failedGet();
  if (fl.length){
    var AN={setAttendance:'Отметка',addPayment:'Оплата',updateChild:'Правка ребёнка',addLead:'Новая запись',addChild:'Новый ребёнок',moveChild:'Порядок в списке',deleteLead:'Удаление записи',convertLead:'Зачисление'};
    h+='<div class="panel"><h3>Не ушло в таблицу <span class="st no">'+fl.length+'</span></h3><p>Эти изменения таблица не приняла. Проверьте их в таблице вручную.</p>'+
      fl.slice().reverse().map(function(f){ var d=new Date(f.t||Date.now());
        return '<div class="hint" style="margin-bottom:6px"><b>'+esc(AN[f.action]||f.action)+'</b> · '+pad(d.getDate())+'.'+pad(d.getMonth()+1)+' '+pad(d.getHours())+':'+pad(d.getMinutes())+'<br>'+esc((f.params||[]).filter(function(x){return typeof x!=='object';}).join(' · '))+'<br><span style="color:var(--bad)">'+esc(f.msg)+'</span></div>'; }).join('')+
      '<button class="btn q" onclick="clearFailed()">Очистить список</button></div>';
  }
  if (conf){
    h+='<div class="panel"><h3>Расписание</h3><p>Отмеченные дни недели — это и есть календарь месяца. Лишние дни из таблицы убираются автоматически (дни с отметками остаются).</p>'+
      branches().map(function(n){
        var have=(S.days&&S.days[n])||[], b=S.branches[n]||{};
        var odd=(b.dates||[]).filter(function(d){ return have.indexOf(d.dow)<0; });
        return '<div class="field"><label>'+esc(n)+'</label><div class="tags days" data-b="'+esc(n)+'">'+
          DOW.map(function(d){ return '<button type="button" class="tag'+(have.indexOf(d)>=0?' on':'')+'" onclick="toggleDay(this)">'+d+'</button>'; }).join('')+
          '</div>'+(odd.length?('<div class="hint" style="margin-top:6px">В календаре есть дни вне расписания с отметками: '+esc(odd.map(function(d){return d.dow+' '+d.label;}).join(', '))+'. <a href="#" onclick="dropOdd(\''+esc(n)+'\');return false;" style="color:var(--accent);font-weight:650">Убрать их</a></div>'):'')+'</div>';
      }).join('')+'</div>';
    h+='<div class="panel"><h3>Месяц <span class="st '+(S.autoMonth?'ok':'no')+'">'+(S.autoMonth?'сам 1-го числа':'вручную')+'</span></h3>'+
      '<p>'+(S.autoMonth
        ? 'Новый месяц открывается автоматически в ночь на 1-е: текущий уходит в архивную вкладку и прячется, календарь собирается по расписанию, балансы '+(S.config.carry?'получают остаток прошлого месяца':'обнуляются — остаток сгорает')+'.'
        : 'Автосмена пока не включена. Откройте таблицу → меню «БРЕЙКИДС72» → «Пересчитать посещения и остатки»: скрипт включит её сам, один раз попросив разрешение.')+'</p>'+
      '<button class="btn s" id="snm" onclick="newMonth()">Открыть новый месяц сейчас</button>'+
      '<button class="btn q" onclick="zeroAll()">Обнулить балансы у всех</button></div>';
    h+='<div class="panel"><h3>Форма записи <span class="st ok">для рекламы</span></h3>'+
      '<p>Ссылку можно публиковать где угодно — в описании профиля, в объявлениях, в чатах. Заявка попадёт во вкладку «Записались», в таблицу филиала ребёнок пойдёт только после вашего «Зачислить».</p>'+
      '<div class="field"><input id="formurl" readonly value="'+esc(API||'')+'"></div>'+
      '<div class="two"><button class="btn s" onclick="copyForm()">Скопировать</button><button class="btn s" onclick="shareForm()">Поделиться</button></div>'+
      '<a class="btn q" href="'+esc(API||'#')+'" target="_blank" rel="noopener">Открыть форму</a>'+
      '<div class="hint">Чтобы видеть, откуда пришли: добавьте к ссылке <b>?src=vk</b>, <b>?src=instagram</b>, <b>?src=листовка</b> — источник сохранится в заявке.</div></div>';
    h+='<div class="panel"><h3>История оплат</h3><p>Все оплаты, внесённые через приложение (лист «Платежи»).</p><button class="btn s" onclick="openLog()">Показать</button></div>';
    h+='<div class="panel"><h3>Проверка таблицы</h3><p>Показывает, какие столбцы и даты скрипт нашёл в листах филиалов. Пригодится, если данные в приложении выглядят не так, как в таблице.</p>'+
      '<button class="btn s" onclick="openDiag()">Проверить</button><button class="btn q" onclick="load(true);toast(\'Обновляю…\')">Обновить данные</button></div>';
  }
  $('app').innerHTML=h+'</div>';
}
function clearFailed(){ try{ localStorage.removeItem('bk72_failed'); }catch(e){} renderSettings(); }
function copyForm(){
  var u=API||'';
  if(!u){ toast('Сначала укажите адрес сервера'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(function(){ toast('Ссылка скопирована'); }).catch(function(){ toast('Скопируйте вручную из поля'); });
  else { var e=$('formurl'); if(e){ e.select(); try{ document.execCommand('copy'); toast('Ссылка скопирована'); }catch(x){ toast('Скопируйте вручную из поля'); } } }
}
function shareForm(){
  var u=API||'';
  if(!u){ toast('Сначала укажите адрес сервера'); return; }
  if (navigator.share) navigator.share({title:'Запись на тренировку — CREW', text:'Записаться на пробное занятие', url:u}).catch(function(){});
  else copyForm();
}
function testApi(){
  var e=$('apitest'); if(e) e.textContent='Проверяю…';
  var url=($('sa').value||'').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)){
    if(e) e.innerHTML='<b style="color:var(--bad)">Адрес выглядит неправильно.</b> Нужен вид https://script.google.com/macros/s/…/exec — из «Управление развертываниями», поле «URL веб-приложения».';
    return;
  }
  var tctl=window.AbortController?new AbortController():null; if(tctl) setTimeout(function(){ tctl.abort(); },15000);
  fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},signal:tctl?tctl.signal:undefined,body:JSON.stringify({action:'getAppData',params:[true]})})
    .then(function(r){ return r.text().then(function(t){ return {s:r.status,t:t}; }); })
    .then(function(x){
      if (x.s===404){ e.innerHTML='<b style="color:var(--bad)">404 — развертывания по этому адресу нет.</b> Скорее всего оно архивировано или скопирован адрес тестового запуска (/dev). Возьмите активное развертывание и адрес на /exec.'; return; }
      if (x.s===401||x.s===403){ e.innerHTML='<b style="color:var(--bad)">Нет доступа.</b> В настройках развертывания поставьте «Запуск от имени: Я» и «Доступ: Все».'; return; }
      var d=null; try{ d=JSON.parse(x.t); }catch(err){}
      if (d && d.ok){ e.innerHTML='<b style="color:var(--good)">Связь есть.</b> Таблица «'+esc(d.result.ssName)+'», месяц '+esc(d.result.monthLabel)+'. Нажмите «Сохранить».'; }
      else if (d && d.error){ e.innerHTML='<b style="color:var(--bad)">Скрипт ответил ошибкой:</b> '+esc(d.error); }
      else { e.innerHTML='<b style="color:var(--bad)">Ответ не похож на наш скрипт.</b> Возможно, адрес от другого проекта.'; }
    })
    .catch(function(err){ if(e) e.innerHTML='<b style="color:var(--bad)">Не достучался:</b> '+esc(err.message)+'. Проверьте интернет и адрес.'; });
}
function saveApi(){
  try{ KEY=($('sk')?$('sk').value.trim():KEY); localStorage.setItem('bk72_key', KEY); }catch(e){}
  needKey=false;
  var u=$('sa').value.trim().replace(/\/$/,'');
  if(!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(u)){ toast('Нужна ссылка вида https://script.google.com/macros/s/…/exec'); return; }
  API=u; try{localStorage.setItem('bk72_apiUrl',u);}catch(e){}
  toast('Проверяем…');
  api('getAppData',[],25000,true).then(function(d){ adopt(d); lastSig=''; lastLoad=Date.now(); sel={}; renderSettings(); toast('Готово: '+d.ssName); flush(); })
    .catch(function(e){ renderSettings(); toast('Сервер не отвечает: '+e.message); });
}
var monthBusy=false;
function delay(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
/** Свежие данные с несколькими попытками: связь после долгой операции часто «моргает». */
function getFresh(tries){
  return api('getAppData',[],60000,true).catch(function(e){
    if (tries>1 && netErr(e)) return delay(2500).then(function(){ return getFresh(tries-1); });
    throw e;
  });
}
function newMonth(){
  if (monthBusy) return;
  if (!S || !S.configured) return;
  if(!confirm('Создать таблицу на следующий месяц и переключить приложение на неё?')) return;
  var was=S.monthLabel, createErr=null;
  monthBusy=true; begin();
  var btn=$('snm');                                           // кнопки может не быть: запуск и из баннера на главном экране
  if (btn){ btn.disabled=true; btn.textContent='Готовим новый месяц, это до минуты…'; }
  document.querySelectorAll('.banner button').forEach(function(x){ x.disabled=true; });
  toast('Готовим новый месяц, это может занять минуту…');
  var release=function(){
    monthBusy=false; end();
    var x=$('snm'); if(x){ x.disabled=false; x.textContent='Открыть новый месяц сейчас'; }
    document.querySelectorAll('.banner button').forEach(function(y){ y.disabled=false; });
  };
  api('createNextMonthCopy', [], 180000, true)                 // операция долгая — ждём дольше обычного
    .then(function(r){ toast('Готово: '+((r && r.newName)||'новый месяц')); })
    .catch(function(e){ createErr=e; })                        // связь могла оборваться, пока скрипт работал — проверим сами
    .then(function(){ return getFresh(4).catch(function(e){ throw createErr||e; }); })
    .then(function(d){
      if (d.monthLabel===was && createErr) throw createErr;    // месяц так и не сменился
      lastSig=''; adopt(d); sel={}; session=null; q='';
      var bad=branches().filter(function(n){ return calendarProblem(d,n); });
      release();
      openStart();
      if (bad.length) toast('Проверьте даты: календарь не совпал с расписанием ('+bad.join(', ')+')');
    })
    .catch(function(e){ release(); toast('Не получилось: '+e.message); });
}
var dayTimers={};
/** Дни недели можно тыкать подряд: на сервер уходит один запрос с итоговым набором (раньше каждый тап = отдельный запрос, ответы путались). */
function toggleDay(el){
  var box=el.parentNode, branch=box.getAttribute('data-b');
  el.classList.toggle('on');
  var days=[].slice.call(box.querySelectorAll('.tag.on')).map(function(b){ return b.textContent; });
  if(!days.length){ el.classList.add('on'); toast('Хотя бы один день нужен'); return; }
  if (dayTimers[branch]) clearTimeout(dayTimers[branch]); else begin();   // автообновление не мешает, пока человек выбирает
  dayTimers[branch]=setTimeout(function(){
    delete dayTimers[branch];
    var cur=[].slice.call(document.querySelectorAll('.tags.days')).filter(function(x){ return x.getAttribute('data-b')===branch; })[0];
    var ds=cur ? [].slice.call(cur.querySelectorAll('.tag.on')).map(function(b){ return b.textContent; }) : days;
    if (cur) cur.style.opacity='.5';
    api('setBranchDays',[branch,ds],60000).then(function(d){
      adopt(d); lastSig=''; toast(branch+': '+ds.join(', ')); render();
    }).catch(function(e){ toast('Ошибка: '+e.message); render(); }).then(function(){ end(); });
  }, 700);
}
function dropOdd(branch){
  if(!confirm('Удалить дни вне расписания вместе с отметками в них? Эти посещения будут потеряны.')) return;
  var days=(S.days&&S.days[branch])||[]; begin();
  api('setBranchDays',[branch,days,true],60000).then(function(d){ adopt(d); lastSig=''; toast('Календарь приведён к расписанию'); render(); })
    .catch(function(e){ toast('Ошибка: '+e.message); }).then(function(){ end(); });
}
function zeroAll(){
  if(!confirm('Обнулить баланс у всех детей в обоих филиалах? Отметки и данные останутся.')) return;
  begin();
  api('zeroBalances',[],60000).then(function(r){ toast(r&&r.zeroed?('Обнулено: '+r.zeroed):'Балансы уже нулевые'); return api('getAppData'); })
    .then(function(d){ adopt(d); lastSig=''; render(); })
    .catch(function(e){ toast('Ошибка: '+e.message); }).then(function(){ end(); });
}
function openLog(){
  sheet('<h2>История оплат</h2><div class="sub">'+esc(S.monthLabel)+'</div><div id="lg" style="margin-top:10px"><div class="hint">Загрузка…</div></div><button class="btn q" onclick="closeSheet()">Закрыть</button>','log');
  api('getPaymentLog',[200]).then(function(l){ var e=$('lg'); if(!e) return;
    var sum=l.reduce(function(s,r){ return s+r.amount; },0);
    e.innerHTML=l.length?'<div class="hint">Всего: <b style="color:var(--text)">'+rub(sum)+'</b> · '+l.length+' '+plural(l.length,'оплата','оплаты','оплат')+'</div>'+
      l.map(function(r){ return '<div class="line"><div class="dt">'+esc(r.date.slice(0,5))+'</div><div class="grow">'+esc(r.name)+' · '+esc(r.type)+'</div><div class="am">'+rub(r.amount)+'</div></div>'; }).join(''):'<div class="hint">Оплат пока нет.</div>';
  }).catch(function(e){ toast('Ошибка: '+e.message); });
}

if ('serviceWorker' in navigator){
  window.addEventListener('load', function(){ navigator.serviceWorker.register('sw.js').catch(function(){}); });
  navigator.serviceWorker.addEventListener('message', function(ev){
    if (ev.data && ev.data.type==='update'){ updateReady=true; if (branchScreen(screen)||screen==='more') render(); }   // новая версия скачана — предложим обновиться, не перезагружая посреди работы
  });
}
sendingRecover();
var cached = cacheLoad();
if (cached && API){ S = cached.d; normalize(S); lastSig = ''; if (bi>=branches().length) bi=0; route(); }   // мгновенный старт из кеша
render();
load(!!cached);                                                // не ждём отправки очереди: экран уже на кеше
document.addEventListener('visibilitychange', function(){ if (document.visibilityState==='visible') recover(); });
