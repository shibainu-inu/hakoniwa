// web/hako_room.js — 部屋（Room）の箱部屋と、その中の小さい HAKO（決定 75・76・78）。自分の部屋（join.html）と、ほかの HAKO の部屋（hako/<末尾 8>.html）で同じものを使う
// 決定 78: Position can suggest. Motion should not explain.
// 場所は少し意味を持ってよい（仕事中は机のそば、日記や本は本棚のそば、何もしないときは部屋の中央・椅子・敷物のあたり）。
// 動きは意味を持たせない: 全部の状態で同じ「ゆっくり上下・少し左右・ごく小さく伸び縮み・たまに向きが変わる・ときどき止まる」。
// 移動も滑らか（ease-in-out）。ピクセルの絵はそのまま、要素ぜんたいを滑らかに動かす（pixel visual + smooth motion）。
// 戸口から出入りはしない（意思を持って動いたように見えすぎる）。動きを減らす設定なら、ふわふわせず、移動はその場で切り替える
import { dotSvg, pubFromDid } from "./hako_dot.js";
const $=id=>document.getElementById(id);
const reduce=!!(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches);
const R={w:480,h:360,floor:[190,340],anchors:{center:[240,268]},pos:[240,268],wander:null,busy:null,hw:48,hh:48,px:3,raf:0,moving:false};
const rnd=(a,b)=>a+Math.random()*(b-a);
// いまの足元（移動中はアニメーションの途中の値）から、奥行きの大きさ・重なり・吹き出しの位置を決める
function place(){const el=$("room-hako"),say=$("room-say"),st=$("room-stage");if(!st)return;
 const W=st.clientWidth||1,H=st.clientHeight||1;
 const x=(el.offsetLeft||R.pos[0]/R.w*W)/W*R.w, y=(el.offsetTop||R.pos[1]/R.h*H)/H*R.h;
 const t=Math.max(0,Math.min(1,(y-R.floor[0])/(R.floor[1]-R.floor[0])));const sc=0.92+0.08*t;
 el.style.width=(R.hw/R.w*100*sc)+"%";el.style.zIndex=String(Math.round(y));
 const bw=say.offsetWidth||0,hx=x/R.w*W;
 const left=Math.max(6,Math.min(W-bw-6,hx-bw/2));say.style.left=left+"px";say.style.top=((y-R.hh*sc-10)/R.h*100)+"%";
 say.style.setProperty("--tail",Math.max(10,Math.min(bw-10,hx-left))+"px");}
function follow(){place();if(R.moving)R.raf=requestAnimationFrame(follow);}
// 移動: 距離に応じてゆっくり（1 秒あたり約 55）。着くまで吹き出しを付いてこさせる
function moveTo(a){const el=$("room-hako");if(!a)return;const [x0,y0]=R.pos;const d=Math.hypot(a[0]-x0,a[1]-y0);
 if(d<2){R.pos=a.slice();place();return;}
 if(!reduce&&Math.abs(a[0]-x0)>6)el.classList.toggle("left",a[0]<x0);
 const dur=reduce?0:Math.max(1.4,d/55);
 el.style.transition=reduce?"none":"left "+dur+"s ease-in-out, top "+dur+"s ease-in-out";
 R.pos=a.slice();el.style.left=(a[0]/R.w*100)+"%";el.style.top=(a[1]/R.h*100)+"%";
 if(reduce){place();return;}
 R.moving=true;cancelAnimationFrame(R.raf);follow();clearTimeout(R.stopT);R.stopT=setTimeout(()=>{R.moving=false;place();},dur*1000+60);}
// 場所の候補。無いものは近いもので代わりにする（厳密にしない）
function spot(names){for(const n of names){const a=R.anchors[n];if(a){const j=[a[0]+rnd(-10,10),a[1]+rnd(-4,4)];return j;}}return R.anchors.center;}
// ふわふわ: 4〜7 秒の 1 周に、上下 ±2px・左右 ±1〜2px・0.98〜1.02。1 周ごとに値を変え、ときどき数秒止まる。たまに向きが変わる
function breathe(){const body=$("room-hako").firstElementChild;if(!body||reduce)return;
 const dy=rnd(-2,2),dx=rnd(-2,2),sc=rnd(0.98,1.02),dur=rnd(4000,7000);
 const an=body.animate([{transform:"translate(0,0) scale(1)"},{transform:"translate("+dx.toFixed(2)+"px,"+dy.toFixed(2)+"px) scale("+sc.toFixed(3)+")"},{transform:"translate(0,0) scale(1)"}],{duration:dur,easing:"ease-in-out"});
 an.onfinish=()=>{if(Math.random()<0.15&&!R.moving)$("room-hako").classList.toggle("left");R.breathT=setTimeout(breathe,Math.random()<0.35?rnd(1500,4000):0);};}
// 何もしていないとき: 7〜14 秒の間でばらし、3 回に 1 回くらいは移らない。行き先は部屋の中央・椅子・敷物のあたり
function idle(){if(!R.busy&&!R.moving&&Math.random()>0.33){moveTo(spot([["center","chair","rug","plant","lamp"][Math.floor(Math.random()*5)],"center"]));}
 R.wander=setTimeout(idle,rnd(7000,14000));}
window.hakoRoom={
 async start(did,base){const img=$("room-img");img.src=base+".svg?"+Date.now();
  try{const r=await fetch(base+".json?"+Date.now());if(r.ok){const j=await r.json();R.w=j.w;R.h=j.h;R.floor=j.floor;R.anchors=j.anchors;R.front=j.front||[];}}catch(e){}
  let pub=null;try{pub=pubFromDid(did);}catch(e){}
  // 前の層（机・椅子）: 足元の y を z にする。HAKO（z = 足元の y）より手前なら HAKO の上に重なる
  document.querySelectorAll(".room-front").forEach(n=>n.remove());
  for(const f of (R.front||[])){const im=document.createElement("img");im.className="room-front";im.alt="";im.src=base+"-"+f.key+".svg";im.style.zIndex=String(Math.round(f.y));$("room-stage").insertBefore(im,$("room-say"));}
  const el=$("room-hako");el.innerHTML='<div class="hako-body">'+(pub?dotSvg(pub,R.px):"")+"</div>";const sv=el.querySelector("svg");
  if(sv){R.hw=Number(sv.getAttribute("width"))||48;R.hh=Number(sv.getAttribute("height"))||48;sv.removeAttribute("width");sv.removeAttribute("height");sv.style.width="100%";sv.style.height="auto";}
  // 最初から部屋の中にいる（戸口から入ってこない）
  const a0=R.anchors.center||[240,268];R.pos=a0.slice();el.style.transition="none";el.style.left=(a0[0]/R.w*100)+"%";el.style.top=(a0[1]/R.h*100)+"%";place();
  clearTimeout(R.breathT);breathe();
  if(!R.wander&&!reduce)R.wander=setTimeout(idle,rnd(7000,14000));},
 state(kind,stage){
  // 仕事中は机のそば、日記を待っているあいだは部屋の中央あたり、日記が届いてから預けるまでは本棚のそば（厳密にしない。無ければ近いもの）
  const WORKING=["accepting","accepted","locked","inf_offering","inf_offered","inf_locking","inf_locked","inf_done","delivering","delivered"];
  const WAITING=["offering","offered","locking","locked"],KEEPING=["claimed","keep_offering","keep_offered","keep_locking","keep_locked"];
  if(kind==="work"&&WORKING.includes(stage)){R.busy="work";moveTo(spot(["desk","center"]));return;}
  if(kind==="order"&&WAITING.includes(stage)){R.busy="order";moveTo(spot(["center"]));return;}
  if(kind==="order"&&KEEPING.includes(stage)){R.busy="order";moveTo(spot(["shelf","center"]));return;}
  if(R.busy===kind)R.busy=null;},
 place,
 panel(name){if(R.busy||R.moving)return;if(name==="books"||name==="memory")moveTo(spot(["shelf","center"]));}
};
// 言語を変えると吹き出しの幅が変わるので、端で止め直す（切り替えの仕方によらず、html の data-lang の変化を見る）
new MutationObserver(()=>requestAnimationFrame(place)).observe(document.documentElement,{attributes:true,attributeFilter:["data-lang"]});
window.addEventListener("resize",()=>place());
